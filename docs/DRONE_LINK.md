# AERO drone link v1

AERO can fly a return with a real PX4 or ArduPilot drone outdoors. The web app never talks MAVLink. A **bridge** runs on the drone's companion computer (or a laptop wired to the flight controller), exchanges short signed text lines with the app, and translates them into MAVLink.

```
Customer app ──HTTPS──▶ Cloudflare Worker + D1 ◀──HTTPS poll (4G data)──▶ bridge ──MAVLink──▶ PX4 / ArduPilot
                                   ▲                                       ▲
                                   └────Twilio SMS (4G SMS-only SIM)───────┘
```

Simulated returns keep working with no drone. A return only becomes a live flight when its owner registers a drone in **Fleet** (`/fleet`), arms it with the pre-flight checklist, and dispatches that return.

## Safety model

The app is not a flight controller. The pilot in command keeps an RC transmitter with override authority, and the autopilot's own failsafes stay enabled.

- **Operator gates.** A drone accepts live missions only for 30 minutes after its owner completes the checklist (RC pilot ready, area clear and authorized, pads checked on the map, failsafes configured). Every takeoff is launched by the operator. The customer's loading confirmation never launches the drone by itself.
- **Server checks at dispatch:** fresh telemetry, 3D GPS fix with at least 6 satellites, battery ≥ 40%, drone on the ground, inside its geofence, pads set, no other mission.
- **Geofence:** home point plus a radius of at most 2000 m. The maximum altitude is capped at 120 m (400 ft). Every GOTO target is checked against the fence on the server *and* again on the bridge.
- **Link:** commands expire (30 s over HTTPS, 300 s over SMS). The bridge rejects expired commands, replayed sequence numbers and bad signatures. When telemetry goes stale during a mission, the app shows a link alarm and stops issuing movement commands. The bridge sends GCS heartbeats, so the autopilot's GCS/datalink-loss failsafe triggers if the bridge dies. Configure it to RTL: PX4 `NAV_DLL_ACT=2`, ArduPilot `FS_GCS_ENABLE=1`.
- **Abort** is never refused for fence, battery or GPS reasons (it is still rejected when expired, replayed or badly signed, and in a bridge dry run). Operator HOLD pauses the mission; LAND, RTL or ABORT end it.
- **Home point.** Arming resets home on both PX4 and ArduPilot, so a drone re-armed at the drop pad would RTL to the drop pad. The mission therefore flies back with `GOTO` to the stored home pad and lands, and the bridge sends `DO_SET_HOME` back to `--fence-center` whenever it arms more than 10 m away, so autopilot failsafe RTLs also go home. If the autopilot does not accept it, the bridge disarms and fails the takeoff with `FAILED HOME_NOT_SET` instead of flying. `--fence-center` must be the real home pad.
- Outdoor flights must follow local rules: in the US, Part 107 or the recreational exception (TRUST), LAANC authorization in controlled airspace, visual line of sight, and no flight over people.

## Message format

Each message is one ASCII line: space-separated tokens, then ` ~` and a signature. The signature is the first 16 hex characters of `HMAC-SHA256(key, body)`, where `body` is everything before ` ~` and `key` is the drone's 32-byte key in lowercase hex. Keys come from the Worker secret `DRONE_LINK_SECRET` (`HMAC-SHA256(secret, "aero-drone-key:<droneId>:<version>")`). D1 stores no key. Fleet shows the key when a drone is registered, and rotating it invalidates the old key.

Numbers are plain decimals with at most 3 integer digits: lat/lon with 6 decimals, meters with 1. Timestamps are Unix seconds.

### Server → drone

```
AC1 <droneId> <cmdSeq> <expiresUnix> <TYPE> [args] ~<sig>
```

| TYPE | args | bridge behavior |
| --- | --- | --- |
| `PING` | — | ack DONE immediately |
| `TAKEOFF` | `altM` | arm and climb to `altM` above home; DONE once within 1.5 m of target altitude |
| `GOTO` | `lat lon altM` | fly to the point at `altM` (airborne only); DONE within 3 m horizontally and 1.5 m vertically |
| `HOLD` | — | hover at the current position (PX4 Hold, ArduPilot BRAKE/LOITER); DONE once holding |
| `LAND` | — | land at the current position; DONE once landed and disarmed |
| `RTL` | — | return to launch and land; if landed away from home, first climb to the configured cruise altitude, which is a takeoff and gets the takeoff checks (battery floor, fence, 3D fix); DONE once landed |
| `ABORT` | — | RTL (LAND if RTL is unavailable); never rejected for fence or battery reasons |

Argument ranges are part of the format: GOTO latitude ±90, longitude ±180, and every altitude 0–120 m. A line outside them fails parsing and is ignored like a bad signature.

`cmdSeq` increases per drone. The bridge must persist the highest executed `cmdSeq` and reject anything lower or equal (`REPLAY`), expired (`EXPIRED`), outside its local fence (`FENCE`), above its altitude cap (`ALTITUDE`), below its battery floor (`LOW_BATT`, except HOLD, LAND, ABORT and an airborne RTL, so a pilot can always stop or bring back a flying drone; an RTL that must climb from a landed position away from home is a takeoff and is checked like one), or without a 3D fix (`NO_GPS`). The reference bridge also uses `NOT_AIRBORNE`, `ABORT_ACTIVE`, `NO_VEHICLE`, `DRY_RUN`, `ARM_DENIED`, `TAKEOFF_DENIED`, `HOME_NOT_SET`, `MODE_CHANGED`, `TIMEOUT`, `SUPERSEDED`, `LINK_LOST` and `BRIDGE_RESTART`.

### Drone → server

```
AT1 <droneId> <seq> <tsUnix> <lat> <lon> <relAltM> <batteryPct> <headingDeg> <groundSpeedMs> <gpsFix> <sats> <STATE> <mode> ~<sig>
AK1 <droneId> <seq> <tsUnix> <cmdSeq> <ACCEPTED|DONE|REJECTED|FAILED> [REASON] ~<sig>
```

- `seq` strictly increases across every message the drone sends. Using `max(previous + 1, unix milliseconds)` survives restarts.
- `batteryPct` is `-1` when unknown. `gpsFix` uses MAVLink `GPS_FIX_TYPE` 0–8 (3 = 3D). `headingDeg` is 0–359. `mode` is the autopilot's flight mode name without spaces.
- `STATE` is one of `IDLE ARMED TAKEOFF ENROUTE HOLD LANDING LANDED RTL ERROR`.
- The server ignores telemetry whose `seq` is not newer than the last accepted message. Only fresh telemetry keeps a drone "connected": over HTTPS its timestamp must be within 10 s of the server clock (anything more than 10 minutes off is ignored entirely); over SMS, where bridges may lack a synced clock, freshness is judged by when the text arrives. Acks are checked against the same 10-minute window but not against `seq`, and are applied forward-only (pending → accepted → done/rejected/failed), so a replayed ack has no effect. Bridges re-sign each ack retry with a fresh `seq` and timestamp, and keep undelivered acks across restarts.
- `REASON` is `[A-Z0-9_]{1,24}`.

Test vectors produced by the TypeScript implementation are in `tests/fixtures/drone-link-vectors.json`. Both implementations must reproduce them exactly.

## Transports

**HTTPS (4G with data).** The bridge `POST`s `text/plain` to `/api/drone/link` once per second: one telemetry line plus any acks (at most 20 lines, 4 KB). The request must contain at least one valid signed line. The response body holds every pending, unexpired command for that drone (one `AC1` line each, in `cmdSeq` order), or is empty. A command repeats until the bridge acks it ACCEPTED (or rejects it), so the bridge must treat a repeat as a no-op and re-send its last ack.

**SMS (4G SIM without data).** Configure a Twilio number with the Worker secrets `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and point its *A message comes in* webhook at `https://<worker>/api/drone/sms`. The drone texts its lines to the Twilio number, and they must come from the phone number registered in Fleet. The app texts a number only after a correctly signed text has arrived from it, so registering a number never sends anything by itself. Phone numbers are unique across drones. Each new command is texted once; an unacknowledged command is re-sent only when the drone texts in, at most three times, and each drone is capped at ten outbound texts per minute. An SMS-only bridge has no NTP: when its clock is unsynced it uses the modem's network time (NITZ, `AT+CTZU=1` / `AT+CCLK?`) to judge expiry. Over SMS the bridge can only detect that its own modem cannot send or has lost network registration; it cannot tell that the Worker or Twilio is down, so its link-loss HOLD/RTL does not fire then, and the RC pilot and the autopilot's own failsafes are the protection. Send telemetry every 15 seconds while airborne and every 60 seconds on the ground.

## Mission

A live return flies home → pickup pad → drop pad → home. The phases, with the command each one sends:

| Phase | Command | Customer sees | Next |
| --- | --- | --- | --- |
| `TAKEOFF_OUT` | TAKEOFF cruise | Getting ready for takeoff | ack DONE |
| `TO_PICKUP` | GOTO pickup | Your drone is on the way | ack DONE |
| `LAND_PICKUP` | LAND | Your drone has arrived | ack DONE |
| `AWAITING_LOAD` | — | Ready when you are | customer confirms loading |
| `READY_TO_LAUNCH` | — | Package securely loaded | operator launches |
| `TAKEOFF_LOADED` | TAKEOFF cruise | Package securely loaded | ack DONE |
| `TO_DROP` | GOTO drop | Your return is taking flight | ack DONE |
| `LAND_DROP` | LAND | Your return has landed | ack DONE |
| `AWAITING_UNLOAD` | — | Completing the handoff | operator confirms unload |
| `TAKEOFF_HOME` | TAKEOFF cruise | Your return has landed. | ack DONE |
| `RETURNING` | GOTO home pad | Your return has landed. | ack DONE |
| `LAND_HOME` | LAND | Your return has landed. | ack DONE → `COMPLETE` |

A REJECTED/FAILED ack, an expired command, or an operator HOLD while airborne pauses the mission with a fault; the operator can retry the step (in a waiting phase, retry just clears the fault) or abort. HOLD while the drone waits on the ground is sent without pausing anything. An operator ABORT, LAND or RTL is queued directly, so it reaches the drone even if the mission record is busy, and it ends the mission; the customer sees the flight as ended by the pilot.

A customer can cancel before loading. What is sent depends on the phase, not on telemetry: during the first takeoff or the landing at pickup the drone lands where it is; en route to pickup it returns home (RTL); once landed at pickup nothing is sent, and the operator brings it back when the area is clear. That RTL is a takeoff: the bridge refuses it below its battery floor, outside its fence or without a 3D fix, and the drone must then be recovered by hand. The new command supersedes anything still queued, such as a pending TAKEOFF.

## Bridge

See `bridge/README.md`. Test against PX4 or ArduPilot SITL before flying hardware. The bridge refuses to send MAVLink commands unless it is started with `--live`.
