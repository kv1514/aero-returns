# The drone: AERO bridge on the AirCart Jetson

What runs on the real drone so that a return dispatched from the app flies.
The drone is the AirCart quadcopter: an **ArduCopter 4.6.3** flight
controller (MicoAir743v2) with a **Jetson Orin Nano** companion computer and
a **SIM7600G-H 4G dongle**. Nothing here changes the app or the bridge: the
stock [`bridge/aero_bridge.py`](../bridge/aero_bridge.py) runs on the Jetson
as a systemd service, talks to the app over the dongle, and flies the FC
through the Jetson's existing MAVROS link.

```
AERO app (Cloudflare) ◀── HTTPS, 1 Hz poll over 4G (IPv6 / NAT64) ──▶ aero-bridge.service
                                                                         │ drone/run_bridge.py → bridge/aero_bridge.py
                                                                         │ MAVLink as GCS (sysid 255)
                                                                         ▼
                                                   MAVROS router  tcp:127.0.0.1:5770  (aircart-ros2.service)
                                                                         │ USB serial /dev/aircart_fc
                                                                         ▼
                                                                ArduCopter 4.6.3 (MicoAir743v2)
```

A dispatched return is flown exactly as [docs/DRONE_LINK.md](../docs/DRONE_LINK.md)
describes: `TAKEOFF <cruise alt>` (arm in GUIDED, climb straight up), then
`GOTO <pad> <cruise alt>` (fly straight there in GUIDED), then `LAND`, and
the same again for the drop pad and home. With Fleet's cruise altitude set
to **10 m** that is "go up 10 m and fly straight to the coordinate". Every
takeoff is still launched by the operator in Fleet, and the RC pilot keeps
override authority.

## Files

| File | Purpose |
| --- | --- |
| `run_bridge.py` | Service entry point. Reads `/etc/aero/bridge.env`, picks the FC connection (MAVROS bridge port, else the USB device), optionally pins the app link to the 4G dongle, then calls `aero_bridge.main()` |
| `bridge.env.example` | Every setting, with the drone's values. Installed as `/etc/aero/bridge.env` |
| `aero-bridge.service` | systemd unit template (`install.sh` fills in the user and checkout path) |
| `install.sh` | `sudo bash drone/install.sh` — installs the unit and the env file. Idempotent |
| `lte_routing.sh` | one-time root setup: dongle reachable only by bound sockets, hidden from ModemManager, named `lte0` (see *The 4G link*) |
| `check.sh` | Health check: config, service, MAVROS port, FC device, NTP, app reachable through the dongle, last log lines |
| `stub_server.py` | A stand-in for the app's `/api/drone/link` (real signed protocol) plus a tiny control API, for tests and for driving the drone from a laptop without the app |
| `sitl_test.py` | End-to-end proof on ArduCopter SITL: TAKEOFF → GOTO → LAND through the real bridge, the real protocol and a MAVROS router, like on the drone |
| `test_drone.py` | Unit tests for `run_bridge.py` and `stub_server.py` (stdlib, no hardware) |

## Setting up the Jetson

Already true on the AirCart Jetson: Ubuntu 24.04, system `python3` 3.12 with
`pymavlink` 2.4.49, the ROS 2 Jazzy + MAVROS stack from the Aircart10 repo
(`~/dev/Aircart10_drone/jetson`, service `aircart-ros2`), the dongle as
NetworkManager connection `lte-dongle`, NTP on. From a fresh shell:

```sh
cd ~/dev/aero-returns                 # this checkout
python3 -I bridge/test_bridge.py      # the bridge's own tests (60, ~4 s)
python3 -I drone/test_drone.py        # this directory's tests (20, ~3 s)
sudo bash drone/install.sh            # unit + /etc/aero/bridge.env (from the example)
```

Then register the drone in Fleet (<https://aero-returns.kv15.workers.dev/fleet>):
transport **HTTPS**, home = the launch pad, pickup and drop pads, radius
(300 m matches the FC's fence), max altitude 60 m, **cruise altitude 10 m**.
Fleet shows the drone id and the 64-character key. Put them in the env file
and restart:

```sh
sudoedit /etc/aero/bridge.env         # paste AERO_DRONE_ID and AERO_DRONE_KEY from Fleet; the rest can stay
sudo systemctl restart aero-bridge
bash drone/check.sh                   # everything green?
journalctl -u aero-bridge -f          # "connected to ARDUPILOT autopilot (system 1, component 1)" + state lines
```

Fleet should show fresh telemetry within a few seconds. The installed
`bridge.env` is **live** (`AERO_LIVE=1`): the drone arms and flies when the
app dispatches to it, which the app only does for a drone a person armed in
Fleet's checklist, with a 3D fix, 6+ satellites and 40 %+ battery, so on an
indoor bench nothing can fly (`REJECTED NO_GPS`). For bench sessions with a
GPS fix set `AERO_LIVE=` (dry run: every movement command is
`REJECTED DRY_RUN`) and restart.

### Bench test without the app

`stub_server.py` speaks the app's protocol, so the whole chain can be
exercised on the bench (or from a laptop on the same LAN) with no account:

```sh
export AERO_DRONE_ID=aircart01 AERO_DRONE_KEY=8f1e6a2c0d4b7e9f3a5c1b2d4e6f8a0c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a
python3 drone/stub_server.py serve --port 8480 &
AERO_SERVER=http://127.0.0.1:8480 AERO_FENCE_CENTER=auto AERO_FENCE_RADIUS=500 \
  AERO_STATE_FILE=/tmp/aero-bench.json python3 drone/run_bridge.py &
python3 drone/stub_server.py send PING          # -> seq 1
python3 drone/stub_server.py wait 1             # {"status": "DONE"}
python3 drone/stub_server.py send TAKEOFF 10    # -> REJECTED NO_GPS indoors (DRY_RUN with a fix)
python3 drone/stub_server.py state              # last telemetry, acks, pending
```

Measured on the bench (2026-10-24, FC on USB power, no GPS indoors): the
bridge latches the FC through MAVROS's router within 1 s — system 1,
component 1, not MAVROS's own component 191 — reports `fix 1, 0 sats,
IDLE, STABILIZE, 99 %` once a second, answers PING with DONE in 2 s and
refuses TAKEOFF with `NO_GPS`. The refusal *is* the bench test; never arm
on the bench.

## The 4G link

- The dongle is the NetworkManager connection **`lte-dongle`**. After
  `sudo bash drone/lte_routing.sh` (one-time, root) its interface is always
  `lte0`; before that it is a MAC-derived `enx…` that changes every modem
  boot. `AERO_BIND=nm:lte-dongle` resolves the device at start either way.
- **The dongle is for the bridge only.** Most Wi-Fi networks have no IPv6, so
  the dongle used to be the Jetson's only IPv6 default route and every
  dual-stack host (Claude Code, Firefox, apt, …) silently went out over 4G:
  56 MB in one afternoon on 24 Oct, on a plan sized for ~1 KB/s of command
  traffic, after which the carrier stopped passing packets. The Tegra kernel
  has no IPv6 policy routing (`CONFIG_IPV6_MULTIPLE_TABLES` unset), so
  `lte_routing.sh` gives `lte-dongle` an `unreachable ::/0` route with a lower
  metric than its own default and no IPv4 default at all. Unbound sockets hit
  the unreachable route and fall back to IPv4 over Wi-Fi; sockets bound to
  the dongle (`SO_BINDTODEVICE` in `run_bridge.py`, `curl --interface lte0`,
  `ssh -o BindInterface=lte0`) do a strict per-interface lookup, skip it and
  use the real gateway. `check.sh` prints `LEAK` if an unbound lookup still
  picks the dongle and counts the connections going through it.
- The same script hides the modem from ModemManager. Otherwise, after a modem
  reboot ModemManager claims it, NetworkManager drops the RNDIS interface as
  "removed", and `lte-dongle` does not come back without a replug.
- Through the dongle **only IPv6 passes**: the carrier gives a public IPv6
  prefix and the modem's IPv4 NAT passes nothing (measured: every IPv4
  connection times out). IPv4-only hosts are reached through the carrier's
  **DNS64/NAT64** (well-known prefix `64:ff9b::/96`, verified). The app is on
  Cloudflare and dual-stack: `curl -6 --interface lte0 https://aero-returns.kv15.workers.dev/`
  answers in ~0.5 s. `run_bridge.py` tries IPv6 first and synthesises the
  NAT64 address itself when a host has no AAAA record.
- Data budget: the bridge polls once a second and `urllib` opens a new TLS
  connection per poll, so count on roughly 15-20 MB per flight hour
  (estimate, not measured) on top of the ~1 KB/s of payload. Check the SIM's
  remaining data before a demo; the symptom of an exhausted plan is a modem
  that registers and gets addresses but answers nothing (`check.sh`: "app not
  reachable").
- The SIM is behind carrier NAT. Nothing connects *to* the drone; the bridge
  polls the app once a second (the protocol's design).
- Link-loss behaviour is the bridge's: after `AERO_LINK_TIMEOUT` (20 s) with
  no successful exchange while airborne it HOLDs, after twice that it RTLs.
  A 4G hiccup longer than 20 s therefore pauses the flight; the operator
  retries the step from Fleet when the link is back.
- Clock: HTTPS commands expire 30 s after issue, so the Jetson must stay
  NTP-synced (`timedatectl`; `check.sh` reports it).

## Through MAVROS, not around it

`aircart-ros2` (MAVROS) owns the FC's USB port and re-serves the MAVLink
stream on `tcp:127.0.0.1:5770`; two readers on one serial port each lose
half the bytes, so the bridge **must** attach there while that service runs
(`AERO_CONNECT=auto` does; it falls back to `/dev/aircart_fc` only when the
port is not listening, and refuses a device another process already holds).
Through the router the bridge is a normal GCS: MAVLink system 255, GCS
heartbeats at 1 Hz, so with `FS_GCS_ENABLE=1` the FC's GCS failsafe trips
if the bridge dies, which is what the bridge's safety model expects. MAVROS
itself is system 1 / component 191 on purpose and does not feed that
failsafe.

Two interactions, both measured:

- The bridge asks for its streams with `REQUEST_DATA_STREAM ALL 4 Hz` once at
  connect. That resets the channel's rates and MAVROS's `imu/data` drops
  from 30 Hz to ~8 Hz until something re-requests. The Jetson's
  `stream_rates` keeper now re-requests every 30 s
  (`resend_period_s` in the Aircart10 `stream_rates.yaml`), so the rates
  recover on their own; its rates are higher than the bridge's for every
  message both ask for, so the bridge is unaffected.
- A MAVROS crash (USB glitch) is respawned in ~3 s; the bridge's pymavlink
  TCP link reconnects by itself (`autoreconnect`), and with `FS_GCS_TIMEOUT=5`
  the FC would see at most a brief GCS gap.

## Flight-controller parameters (set by the pilot, not by code)

Read from the FC on 2026-10-24. The bridge's recommended values are in
[bridge/README.md](../bridge/README.md#recommended-autopilot-parameters);
these are the ones that differ or matter for the demo. Apply them in
Mission Planner / QGC and write them down; nothing in this directory changes
FC parameters.

| Parameter | Now | For the demo | Why |
| --- | --- | --- | --- |
| `FS_GCS_ENABLE` | 0 | **1** | RTL if the bridge (GCS 255) dies; the bridge's safety model assumes it. `SYSID_MYGCS` is already 255, `FS_GCS_TIMEOUT` 5 s |
| `FS_THR_ENABLE` | 0 | **1** if an RC receiver is bound | RC-loss → RTL |
| `FENCE_ENABLE` | 0 (radius 300, alt 100, action RTL) | **1**, `FENCE_ALT_MAX` ≤ `AERO_MAX_ALT` (60) | The FC enforces the same fence the app and bridge check |
| `BATT_FS_LOW_ACT` / `BATT_FS_CRT_ACT` | 0 / 0 | **2 (RTL) / 1 (land)** | Battery failsafes are off today; `BATT_LOW_VOLT` 18.6 V and `BATT_CRT_VOLT` 18.0 V are set for the 6S pack |
| `WPNAV_SPEED` | 1000 (10 m/s) | **300** (3 m/s) for a first demo | GUIDED `GOTO` flies at this speed; the bridge sets no speed |
| `BATT_MONITOR` / `BATT_CAPACITY` | 4 / 3300 mAh | keep | Gives the battery % the app's 40 % dispatch rule needs (`-1` would block every dispatch) |
| `DISARM_DELAY` | 10 s | keep | LAND is DONE only once the FC disarms |
| `RTL_ALT` | 1500 (15 m) | keep (clear obstacles) | Failsafe/abort return altitude |
| `ARMING_CHECK` | 4406 | keep | The pilot's choice; GPS/EKF position is mandatory for GUIDED regardless |

## SITL proof

```sh
python3 drone/sitl_test.py            # bridge -> MAVROS (/sitl) -> ArduCopter SITL; ~3-4 min
python3 drone/sitl_test.py --direct   # bridge -> SITL, no ROS (e.g. on a laptop)
```

Starts SITL at the test home, a second MAVROS in the `/sitl` namespace
(its GCS bridge on :5771, like `aircart-ros2`'s :5770), the stub app, and
the bridge with `AERO_LIVE=1`; then sends `TAKEOFF 10`, `GOTO` a pad ~70 m
away at 10 m, `LAND`, and checks every ack and the reported position
(within 3 m / 1.5 m). It never touches the real FC or the `aircart-ros2`
service, and refuses to start if :5760/:5771 are busy. The ArduPilot SITL
build it needs is at `~/dev/ardupilot` on the Jetson.

## Before a live flight

In addition to the bridge's own pre-flight checklist in
[bridge/README.md](../bridge/README.md#pre-flight-checklist):

1. `bash drone/check.sh` is green: service active, MAVROS port listening,
   NTP synced, dongle reaches the app.
2. Fleet shows fresh telemetry: 3D fix, ≥ 6 satellites, battery ≥ 40 %,
   state `IDLE`, mode as the pilot left it.
3. `/etc/aero/bridge.env`: `AERO_FENCE_CENTER=auto` (the fence is centred on
   the launch pad when the service starts; restart it after moving the drone
   somewhere else) and `AERO_LIVE=1`; `journalctl -u aero-bridge -f` must show
   `geofence centre from GPS` and not `DRY RUN`.
4. FC parameters above applied; props on; RC transmitter on; pilot ready to
   switch modes (the bridge then logs `MODE_CHANGED` and stops commanding).
5. Fleet: complete the arming checklist (30-minute window), dispatch the
   return, launch each takeoff from Fleet.

What the drone does on its own if things go wrong: link lost 20 s → HOLD,
40 s → RTL (bridge); bridge dead → GCS failsafe RTL (FC, once
`FS_GCS_ENABLE=1`); RC mode switch → the pilot has it, the bridge stands
down. Operator HOLD / LAND / RTL / ABORT from Fleet are never refused for
fence, battery or GPS reasons.
