# Live drone link

Design rationale, delivery flow, hardware and roadmap: [`DRONE_ARCHITECTURE.md`](DRONE_ARCHITECTURE.md).

AERO can now drive a real drone. The website never talks to the flight controller directly. A small agent on the drone's onboard computer does, and it polls the website over 4G:

```
Fly page (/fly) ──HTTPS──▶ /api/drones/*          website users: owner + invited pilots
                               │ D1: drones, drone_commands
drone-agent/aero_agent.py ─HTTPS over 4G─▶ /api/drone/sync    once per second
        │ MAVLink (serial or UDP)
ArduPilot flight controller
```

The return-tracking simulation (`lib/simulation.ts`) is unchanged and separate. Real drones only move through `/fly`.

## Website API (session cookie, same-origin)

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/drones` | any | Drones you own or pilot, plus whether SMS sending is configured |
| POST | `/api/drones` `{name}` | any | Link a new drone. Returns the token **once** |
| POST | `/api/drones/join` `{code}` | any | Become a pilot with a 6-character pilot code |
| GET | `/api/drones/:id` | owner, pilot | Telemetry, trail, limits, last 12 commands |
| PATCH | `/api/drones/:id` `{name?, phone?, geofenceM?, maxAltM?, home?}` | owner | Limits and settings. `home: "current"` uses the drone's GPS position |
| DELETE | `/api/drones/:id` | owner, pilot | Owner deletes the drone; a pilot leaves |
| POST | `/api/drones/:id/commands` | owner, pilot | `{type:"FLY_ROUTE", params, pilotReady:true}` or `{type:"HOLD"\|"LAND"\|"RTL"\|"PING"}` |
| POST | `/api/drones/:id/jobs` | owner, pilot | Deliveries: `{op:"create", pickup, dropoff, altM, speedMs?, returnHome?, returnId?, pilotReady:true}`, `{op:"loaded"|"cancel", jobId}`, `{op:"resume", jobId, pilotReady:true}` |
| GET | `/api/drones?view=jobs` | any | Lightweight live-delivery feed for the tracking page |
| POST | `/api/drones/:id/sms` | owner, pilot | Build (and with Twilio, send) a signed text command |
| POST | `/api/drones/:id/share` `{revoke?}` | owner | New pilot code, or revoke it and remove all pilots |
| POST | `/api/drones/:id/token` | owner | Rotate the device token. The old one stops working immediately |

`FLY_ROUTE.params`: `{waypoints: [[lng,lat], …1–10], altM: 5–120, speedMs: 1–15 (default 6), land: true}`. The drone flies from where it is through every waypoint, then lands or hovers. `release: true` (used by the delivery drop-off leg) opens the gripper after landing.

## Device API

`POST /api/drone/sync` with `Authorization: Bearer aero_<droneId>.<secret>`.

```json
{ "telemetry": { "lat": 37.8719, "lng": -122.2585, "altM": 30, "headingDeg": 41, "groundSpeedMs": 6,
                 "batteryPct": 88, "gpsFix": 3, "satellites": 14, "armed": true, "mode": "GUIDED",
                 "state": "en_route", "flightAllowed": true, "link": "4g", "signalDbm": -81,
                 "activeCommandId": "…", "waypointIndex": 0, "message": "Flying 1 waypoint(s) at 30 m.", "simulated": false, "payload": "loaded" },
  "acks": [{ "commandId": "…", "status": "accepted|done|failed", "message": "…" }] }
```

The reply carries the next command (delivered once) and the drone's current limits:

```json
{ "command": { "id": "…", "type": "FLY_ROUTE", "params": { … }, "expiresAt": 1792842300000 } | null,
  "config": { "home": [-122.2585, 37.8719], "geofenceM": 500, "maxAltM": 40, "minBatteryPct": 30 },
  "serverTime": 1792842270000 }
```

`state` is one of `idle, arming, taking_off, en_route, holding, landing, returning, landed, error`. The first telemetry with a 3D fix becomes home if none is set. The server stores only `sha256(secret)`.

## Safety model

Every motion command is checked twice: once on the server (`preflight` in `lib/drone-protocol.ts`) and again on the drone.

| Check | Server | Drone agent |
|---|---|---|
| Agent started with `--allow-flight` | ✔ | ✔ |
| Drone online (telemetry < 10 s old), 3D GPS fix | ✔ | ✔ GPS |
| Battery ≥ 30 % to start | ✔ | ✔ |
| Every waypoint inside the geofence around home, altitude ≤ limit (≤ 120 m) | ✔ | ✔ |
| Route ≤ 5 km | ✔ | |
| A pilot with a remote controller confirmed as watching | ✔ | |
| Flight commands expire after 30 s, safety commands after 120 s | ✔ | |
| HOLD / LAND / RTL replace any waiting flight and are delivered first | ✔ | ✔ |
| Battery < 20 % in flight → RTL | | ✔ |
| Left geofence (+30 m) → RTL | | ✔ |
| No website contact for 15 s → hold; 45 s → RTL | | ✔ |
| RC switched to a manual mode (STABILIZE, ALT_HOLD, POSHOLD …) → agent lets go | | ✔ |

The agent's failsafes only act on flights the agent itself started. They never override a pilot flying manually. Keep the flight controller's own failsafes (`FS_GCS_ENABLE`, `BATT_FS_*`, `FENCE_*`) configured too.

## SMS backup

If mobile data drops but the SIM still has signal, the drone accepts texts through the 4G modem's AT port (`--modem /dev/ttyUSB2`):

```
AERO HOLD 12345678
AERO LAND 12345678
AERO RTL 12345678
AERO STATUS 12345678
AERO GOTO 37.872000 -122.258500 30 12345678
```

The 8-digit code is `HMAC-SHA256(key = sha256(secret) as hex, msg = "<droneId>|<COMMAND ARGS>|<floor(unix/300)>")`. Take the first 8 hex digits as an integer, mod 10⁸. The drone accepts the current window ±1 (about 5–15 minutes) and each code only once. The Fly page shows the exact text to send. With `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` set, it sends the text itself. `GOTO` still obeys the drone's cached geofence and altitude limits.

## Testing without hardware

- `node_modules/.bin/tsx scripts/fake-drone.ts --server http://127.0.0.1:5173 --token aero_…` simulates a drone with the same protocol.
- `python3 drone-agent/aero_agent.py --server … --token … --sim --allow-flight` runs the real agent against its built-in physics model.
- `node_modules/.bin/tsx scripts/drone-smoke.ts` checks the API (ownership, tokens, priorities, pilots, SMS) against a running local app.
- `python3 drone-agent/test_agent.py` covers flights, refusals, link loss, low battery, manual takeover and SMS signing (standard library only).
- ArduPilot SITL: `sim_vehicle.py -v ArduCopter --out udp:127.0.0.1:14550`, then `--connect udp:127.0.0.1:14550`.

## Legal and operational notes

A website button is not a substitute for a pilot. In the US, flying under Part 107 requires visual line of sight unless you hold a waiver, and the ceiling is 400 ft (120 m). Check airspace (B4UFLY / LAANC) before every flight and keep a pilot on the RC transmitter. Never put the drone token in source control.
