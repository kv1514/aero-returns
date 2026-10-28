# How AirCart connects to a real drone, and why it is built this way

A companion to [`DRONE_LINK.md`](DRONE_LINK.md), which is the source of truth for the protocol, mission phases and safety rules. This page explains the reasoning: why the drone polls the app, what to buy, the order to bring hardware up in, and what to build next. For bridge setup see [`../bridge/README.md`](../bridge/README.md); for hosting see [`DEPLOY.md`](DEPLOY.md); for the optional real-time layer see [`SPACETIMEDB.md`](SPACETIMEDB.md).

## 1. The big picture

```
 Customer app / Fleet console (browser)
            │ HTTPS (session cookie)                    optional: SpacetimeDB live rows (docs/SPACETIMEDB.md)
            ▼
 Cloudflare Worker + D1  ◀──── HTTPS poll, 1/s, signed lines (4G data) ────  bridge/aero_bridge.py ──MAVLink──▶ PX4 / ArduPilot
   /api/fleet/*  /api/drone/link                                              (Pi + 4G modem on the drone)
   /api/drone/sms ◀──────────── Twilio SMS (4G SIM without data) ──────────────┘
```

**The drone always dials out.** On 4G the drone sits behind carrier-grade NAT, so nothing on the internet can open a connection to it. The bridge therefore posts its signed telemetry and acks every second and receives any pending signed commands in the reply. If data is unavailable, the same signed lines travel as SMS through Twilio. This works on any SIM, with no VPN, port forwarding or static IP.

## 2. Why polling is the right transport today

| Option | Command latency | Works behind 4G NAT | Verdict |
|---|---|---|---|
| **HTTPS poll + SMS fallback (built)** | about 1 s (SMS: seconds to minutes) | ✅ | **Best fit now.** Stateless Worker, retries are free, one signed format for both transports |
| WebSocket via a Durable Object per drone | 100–300 ms | ✅ (drone dials out) | Upgrade path for faster HOLD/ABORT; keep polling as a fallback |
| MQTT broker | about 100 ms | ✅ | Worth it for large fleets; adds a broker and certificates |
| MAVLink over a VPN (Tailscale/ZeroTier) to Mission Planner/QGC | about 100 ms | ✅ via relay | Great for engineering and tuning, not for a customer app |
| Direct inbound connection | — | ❌ | Blocked by carrier NAT |

A mission is a sequence of high-level commands (TAKEOFF, GOTO pad, LAND, wait for a person, …). The autopilot flies each one itself, so a second of command latency is harmless. Nobody joysticks the drone through a browser. The real-time need is the customer's and operator's view, which SpacetimeDB can stream without changing the drone link.

## 3. Status updates the customer sees

The mission phases and their customer-facing titles are in the "Mission" table of [`DRONE_LINK.md`](DRONE_LINK.md). In short: home → pickup pad (land, the customer confirms loading, the **operator** launches) → drop pad (land, the operator confirms unload) → home. Every phase change comes from the drone's own signed acks, so the tracking screen only shows what the drone actually reported.

## 4. Safety layers (defense in depth)

1. **Operator gates.** Owner-registered drones, a pre-flight checklist that arms a drone for 30 minutes, operator-launched takeoffs, an abort that is always available.
2. **Server checks at dispatch.** Fresh telemetry, a 3D fix with at least 6 satellites, battery at least 40 %, on the ground, inside the geofence (at most 2000 m), pads set, altitude capped at 120 m.
3. **Bridge checks every command again.** Signature, sequence (no replays), expiry, local fence, altitude, battery and GPS. It refuses all motion without `--live`.
4. **The autopilot's own failsafes.** The bridge sends GCS heartbeats, so the datalink-loss failsafe triggers if the bridge dies (PX4 `NAV_DLL_ACT=2`, ArduPilot `FS_GCS_ENABLE=1`), alongside fence and battery failsafes.
5. **A human pilot** with RC override and line of sight. US: Part 107 or TRUST, LAANC in controlled airspace, ≤ 400 ft, no flight over people.

## 5. Recommended hardware

| Part | Recommendation | Why |
|---|---|---|
| Airframe | 450–550 mm quad (e.g. Holybro X500 V2) | Carries 0.5–1 kg; well documented for PX4 and ArduPilot |
| Flight controller | Pixhawk 6C / Cube Orange, PX4 or ArduPilot Copter | Both are supported by the bridge |
| GPS | M9N/M10 + compass | Dispatch needs a 3D fix with ≥ 6 satellites |
| Companion computer | Raspberry Pi 4/5 (Zero 2 W to save weight) | Runs the bridge; TELEM2 → UART (`bridge/README.md` has the wiring) |
| 4G | Quectel EC25 / SIM7600 modem + SIM with data **and** SMS | HTTPS link, plus the SMS fallback |
| Power | Separate 5 V 3 A BEC for the Pi and modem | Modem current spikes brown out a Pi on shared power |
| RC | ELRS or any ArduPilot/PX4-compatible radio | The pilot in command must be able to override |
| Payload (later) | Servo gripper or EPM, then a winch | Today a person loads and unloads at the pads |

## 6. Bring-up order

1. **No drone:** `bridge/aero_bridge.py --vehicle fake` against the app. Arm in Fleet, dispatch a return, watch every phase.
2. **SITL:** PX4 Gazebo or ArduPilot `sim_vehicle.py` with `--live` (`bridge/README.md`), so the real MAVLink path is exercised.
3. **Hardware, props off, without `--live`:** a dry run. Check that position, battery, GPS and mode on Fleet match the ground station.
4. **First flights:** small fence (50–100 m), low cruise altitude, pilot on the mode switch. Test HOLD, LAND and ABORT before a full mission.
5. **Real 4G:** no Wi-Fi. Confirm about 1 s telemetry, then pull the modem and confirm the link alarm on Fleet and the autopilot's datalink failsafe.
6. **SMS:** register and verify the drone's number, turn data off on the SIM, and fly a short mission over SMS.

## 7. Roadmap (in priority order)

1. A WebSocket transport (Durable Object per drone) for sub-second HOLD/ABORT, with polling kept as a fallback.
2. A payload sensor or gripper state in telemetry, so loading and unloading are checked against the drone and not only a person's tap.
3. Customer texts on "arrived at pickup" and "delivered" (Twilio is already configured for the drone link).
4. Precision landing on the pads (ArUco/IR-LOCK; ArduPilot `PLND_*`, PX4 `LTEST`/precland).
5. Proof-of-delivery photos at both pads, stored in R2.
6. Automatic dispatch: the nearest armed, charged drone for each return.

## 8. Where things live

| What | Where |
|---|---|
| Protocol, signing, mission phases, safety | `docs/DRONE_LINK.md`, `lib/drone-protocol.ts`, `lib/drone-mission.ts` |
| Worker routes | `lib/drone-server.ts`, `app/api/drone/link`, `app/api/drone/sms`, `app/api/fleet/**` |
| Fleet console | `app/fleet/page.tsx`, `components/fleet-console.tsx`, `components/fleet-map.tsx` |
| Bridge (drone side) + tests | `bridge/aero_bridge.py`, `bridge/aero_protocol.py`, `bridge/test_bridge.py` |
| Shared test vectors | `tests/fixtures/drone-link-vectors.json` |
| End-to-end checks | `scripts/drone-link-smoke.ts`, `scripts/bridge-e2e.ts` |
| Deploy | `docs/DEPLOY.md`, `npm run deploy` |
