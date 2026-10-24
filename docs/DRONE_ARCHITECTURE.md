# How AERO connects to a real drone, and the best way to do it

This is the design reference for AERO's live drone work: what is built, why it is built this way, what hardware to buy, and the step-by-step plan to fly a real package. It is written so anyone (or any new Claude session) can pick it up cold. The protocol details are in [`DRONE_API.md`](DRONE_API.md); setting up the drone itself is in [`../drone-agent/README.md`](../drone-agent/README.md).

---

## 1. The big picture

```
 Customer / operator (phone or laptop)                      Drone
 ┌───────────────────────────────┐                         ┌──────────────────────────────────────────┐
 │ /fly          live map, A→B,  │                         │ Raspberry Pi (companion computer)        │
 │               deliveries      │                         │  drone-agent/aero_agent.py               │
 │ / (tracking)  live-drone      │                         │   • polls website every 1 s over 4G      │
 │               banner          │                         │   • runs commands safely                 │
 └──────────────┬────────────────┘                         │   • reads SMS from the modem             │
                │ HTTPS (session cookie)                   │        │ MAVLink (UART/USB)              │
                ▼                                          │        ▼                                 │
 ┌─────────────────────────────────────────┐   HTTPS 4G   │ ArduPilot flight controller (Pixhawk…)   │
 │ Cloudflare Worker (this repo)           │◀─────────────┤   GPS · motors · failsafes · gripper     │
 │  /api/drones/*     owner & pilots       │  POST /api/   │                                          │
 │  /api/drone/sync   the drone            │  drone/sync   │ 4G modem + SIM  ◀── SMS backup ──  phone  │
 │  D1: drones, drone_commands,            │               └──────────────────────────────────────────┘
 │      drone_jobs, drone_events           │
 └─────────────────────────────────────────┘
```

**The key idea:** the drone always dials out to the website. Over 4G the drone sits behind carrier-grade NAT, so nothing on the internet can connect to it directly. The website can never "push" to the drone. Instead, the drone asks every second: "here is my telemetry and my acks; anything for me?" The answer carries the next command. This works on any SIM, with no VPN, port forwarding or static IP.

## 2. Why this design (and the alternatives)

| Option | Latency | Works over 4G NAT | Effort | Verdict |
|---|---|---|---|---|
| **HTTPS poll, 1 Hz (built)** | ≤ 1–2 s | ✅ | Low; plain `fetch`, works on Cloudflare | **Best for now.** Simple, robust, cheap, stateless server |
| WebSocket via Durable Object | ~100–300 ms | ✅ (drone dials out) | Medium; one DO per drone holds the socket | **Upgrade path** when sub-second control matters |
| MQTT broker (HiveMQ, EMQX, AWS IoT) | ~100 ms | ✅ | Medium–high; separate broker, certs | Good for **fleets** of many drones |
| MAVLink over a VPN (Tailscale/ZeroTier) to a ground station | ~100 ms | ✅ via relay | Medium | Great for **engineering/debugging** with Mission Planner/QGC, not for a customer website |
| DJI SDK | varies | needs the DJI app as a bridge | High; closed ecosystem | Not compatible with this stack |
| Direct inbound connection to the drone | — | ❌ blocked by CGNAT | — | Doesn't work on mobile networks |

Why polling is the right call today:
- A delivery is made of **high-level commands**: "fly to the pickup and land", "fly to the drop-off and release", "go home". The autopilot flies the path itself, so 1 s of command latency doesn't matter. Nobody is "joysticking" the drone through the website (and nobody should).
- Every request is independent. A dropped 4G packet just means the next poll retries. Acks are re-sent until they are delivered.
- It runs on the existing Cloudflare Worker + D1 with no new infrastructure.

**When to upgrade:** switch to a WebSocket (Cloudflare Durable Object per drone) when you need faster safety commands (Hold/Land in < 300 ms) or video. The JSON messages stay the same, so `lib/drone-protocol.ts` and the agent's command handling don't change. Only the transport does.

## 3. What happens during a delivery

Defined in [`lib/drone-jobs.ts`](../lib/drone-jobs.ts) and unit-tested in `tests/drone-jobs.test.ts`.

```
 Dispatched ─▶ On the way to pickup ─▶ Arrived at pickup ──(person confirms "package loaded")──▶ Package picked up
      ─▶ Package in flight ─▶ Package delivered (landed + gripper released) ─▶ Drone returning home ─▶ Delivery complete
 Any leg can end in "Delivery needs attention" (link lost, manual takeover, refused command) → Resume or Cancel.
```

- The server splits a job into **legs**: pickup (land, wait), drop-off (land, release the gripper), return (RTL). It queues one leg at a time.
- A job only moves forward on the **drone's own acks** (`accepted`, `done`, `failed`) and on a **person confirming the package is loaded**. Nothing can skip that confirmation.
- Every change becomes a **status update** (`drone_events`): toasts and a feed on `/fly`, a live banner on the tracking page (`/api/drones?view=jobs`), and alerts when the drone reports something new (failsafes, home set, manual takeover).
- Safety commands (Hold/Land/Return home) always win. They fail the current leg, and the job then shows *needs attention* with a **Resume** button.

## 4. Safety layers (defense in depth)

1. **Website preflight** (`preflight()` in `lib/drone-protocol.ts`): online, started with `--allow-flight`, 3D GPS, battery ≥ 30 %, every stop inside the geofence, altitude ≤ limit, route ≤ 5 km, and a "pilot with RC is watching" confirmation.
2. **Drone agent** re-checks every command, then enforces RTL on low battery or a geofence breach, holds after 15 s without the website and returns home after 45 s. Switching the RC to a manual mode always takes control away from the agent.
3. **ArduPilot's own failsafes**: `FENCE_ENABLE`, `BATT_FS_*`, `FS_THR_ENABLE`, `FS_GCS_ENABLE`. Configure them; they work even if the Pi crashes.
4. **A human pilot** with an RC transmitter and line of sight. US: FAA Part 107, ≤ 400 ft, check airspace (B4UFLY/LAANC).

## 5. Recommended hardware (≈ $600–900 on top of a frame)

| Part | Recommendation | Why |
|---|---|---|
| Frame + motors | 450–550 mm quad (e.g. Holybro X500 V2 kit) | Lifts 0.5–1 kg payloads; well documented with ArduPilot |
| Flight controller | Pixhawk 6C / Cube Orange running **ArduPilot Copter 4.5+** | Mature GUIDED mode, gripper support, fences |
| GPS | M10 or M9N GPS + compass | A 3D fix is required to fly |
| Companion computer | Raspberry Pi 4/5 (or Zero 2 W to save weight) | Runs `aero_agent.py`; UART to the flight controller |
| 4G | Quectel EC25 / SIM7600 USB modem or HAT + data SIM (with SMS) | Internet link plus the SMS backup on its AT port |
| Payload release | Servo gripper or EPM (`GRIPPER_ENABLE=1`); winch later | `MAV_CMD_DO_GRIPPER` releases at the drop-off |
| RC | Any ArduPilot-compatible TX/RX (ELRS recommended) | Mandatory manual override |
| Power | Separate 5 V 3 A BEC for the Pi + modem | Modems draw current spikes; brownouts reboot the Pi |

## 6. Bring-up plan, step by step

1. **Desk, no props:** `python3 aero_agent.py --server … --token … --sim --allow-flight`, then fly deliveries on `/fly`. (Also `scripts/fake-drone.ts`.)
2. **ArduPilot SITL** on a laptop: `sim_vehicle.py -v ArduCopter --out udp:127.0.0.1:14550`, then `--connect udp:127.0.0.1:14550`. This exercises the real MAVLink path: GUIDED, takeoff, goto, LAND, RTL and the gripper (`GRIPPER_ENABLE=1` in SITL).
3. **Real hardware, props off:** wire the Pi to the flight controller, connect without `--allow-flight`, and check that the position, battery and GPS fix on the map are right.
4. **Gripper on the bench:** run a delivery in SITL-like conditions with props off and check the servo opens on "delivered".
5. **Field, tethered or low and slow:** geofence 50–100 m, max altitude 15 m, speed 3 m/s, pilot on the RC switch. Try Hold, Land and Return home first, then a short A→B, then a full delivery.
6. **Real 4G:** take Wi-Fi away, confirm about 1 s telemetry on 4G, then test link loss (pull the modem) and confirm hold → RTL.
7. **SMS backup:** set the drone's SIM number on the Text backup tab, send `AERO HOLD <code>`, and confirm the drone obeys while mobile data is off.

## 7. Roadmap (in priority order)

1. **WebSocket transport** via a Durable Object per drone, for sub-second Hold/Land (keep polling as a fallback).
2. **Payload sensing:** a load-cell or limit switch so the drone reports `payload: loaded/empty` itself. Then loading confirmation can be checked against the sensor, not only a person's tap.
3. **Customer notifications:** SMS or email the customer on "Arrived at pickup" and "Delivered" (Twilio is already wired for drone texts).
4. **Precision landing:** an ArUco or IR-LOCK pad at the pickup and the hub, so the drone lands within about 10 cm (ArduPilot `PLND_*`).
5. **Camera snapshot at pickup and drop-off** as proof of delivery, uploaded to R2.
6. **Fleet dispatch:** pick the nearest charged drone for each return automatically, and link jobs to returns end to end.
7. **Real carrier hand-off:** partner drop-off points (UPS Access Point, USPS) and printed-label verification.

## 8. Where things live

| What | File |
|---|---|
| Protocol, schemas, preflight, SMS signing | `lib/drone-protocol.ts` |
| Delivery job state machine | `lib/drone-jobs.ts` |
| Website + device API (D1) | `lib/drone-server.ts`, `app/api/drones/**`, `app/api/drone/sync` |
| Fly page UI and map | `components/drone-control.tsx`, `components/drone-map.tsx` |
| Tracking-page live banner | `components/aero-app.tsx` (`liveJob`) |
| Drone agent (Pi) + tests | `drone-agent/aero_agent.py`, `drone-agent/test_agent.py` |
| Simulated drone (Node) | `scripts/fake-drone.ts` |
| API smoke test | `scripts/drone-smoke.ts` |
| DB migrations | `drizzle/0002_live_drones.sql`, `drizzle/0003_delivery_jobs.sql` |
