# AERO bridge

The bridge connects one drone to the AERO web app. It runs on the drone's companion computer (a Raspberry Pi with a 4G modem, for example) or on a laptop wired to the flight controller. It exchanges short signed text lines with the app ([docs/DRONE_LINK.md](../docs/DRONE_LINK.md)), checks every command against its own local limits, and flies a PX4 or ArduPilot multicopter over MAVLink. It also has a built-in fake vehicle, so you can demo the whole app loop with no drone and no simulator.

This is a hackathon prototype, not a certified flight system. The pilot in command keeps an RC transmitter with override authority, and the autopilot's own failsafes stay enabled. Test in SITL before you fly hardware.

| File | Purpose |
| --- | --- |
| `aero_bridge.py` | The bridge: command-line interface, transports, vehicle backends and safety checks |
| `aero_protocol.py` | Standard-library mirror of `lib/drone-protocol.ts` (formatting, strict parsing, HMAC) |
| `test_bridge.py` | Unit and end-to-end tests (standard library only) |

## Requirements

- Python 3.10 or later.
- For `--vehicle mavlink` or `--transport sms`: `pip install -r bridge/requirements.txt` (pymavlink and pyserial). On Raspberry Pi OS, install them in a virtualenv: `python3 -m venv ~/aero-venv && ~/aero-venv/bin/pip install -r bridge/requirements.txt`.
- The fake vehicle and the HTTPS transport use only the standard library.

Credentials come from the environment. Fleet shows both values when you register the drone:

```sh
export AERO_DRONE_ID=abc123
export AERO_DRONE_KEY=<64 hex characters>   # the bridge never prints it
```

## Quick start: fake vehicle against a deployed app

```sh
python3 bridge/aero_bridge.py --transport https --server https://<your-aero-app> --vehicle fake --fake-home 37.871900,-122.258500 \
  --fence-center 37.871900,-122.258500 --fence-radius 300 --max-alt 60 --cruise-alt 30
```

Copy this line from Fleet's **Connect the bridge** card ("Test first with the built-in simulator"): it fills in the drone's own home, geofence radius, maximum altitude and cruise altitude. `--fake-home` and `--fence-center` must be the home pad you entered in Fleet; the server checks that the drone is inside its geofence. Without the limits the fake vehicle's fence is 2000 m and its altitude cap 60 m, so a drone set to cruise above 60 m would get `REJECTED ALTITUDE`. The fake drone cruises at 10 m/s, climbs at 2 m/s, descends at 1.5 m/s, drains its battery while flying, and lands with an automatic disarm. The fake vehicle always flies, so `--live` is not needed. Arm the drone in Fleet, dispatch a return, and watch the bridge log, which prints one line per event. The fake drone flies to the pickup pad, or to the customer's map pin when the drone has a pin zone in Fleet and the pin is inside it. At a pin it hovers until you tap **Landing area clear · land** in Fleet. Press Ctrl-C to stop.

## Simulators (SITL)

SITL is a simulator, so passing `--live` is safe here. Start SITL at your Fleet home, or move the Fleet home to the SITL location, so the geofence checks pass. The fence values below are examples: use the drone's own `--fence-radius`, `--max-alt` and `--cruise-alt`, which Fleet's **Connect the bridge** card prints in its PX4 / ArduPilot line.

**PX4** (Gazebo). PX4 sends its API link to UDP port 14540:

```sh
PX4_HOME_LAT=37.8719 PX4_HOME_LON=-122.2585 PX4_HOME_ALT=10 make px4_sitl gz_x500
python3 bridge/aero_bridge.py --vehicle mavlink --connect udpin:0.0.0.0:14540 --live \
  --fence-center 37.8719,-122.2585 --fence-radius 500 --transport https --server https://<your-aero-app>
```

**ArduPilot Copter**. MAVProxy forwards to UDP port 14550:

```sh
sim_vehicle.py -v ArduCopter --console --map --custom-location=37.8719,-122.2585,10,0
python3 bridge/aero_bridge.py --vehicle mavlink --connect udpin:0.0.0.0:14550 --live \
  --fence-center 37.8719,-122.2585 --fence-radius 500 --transport https --server https://<your-aero-app>
```

The bridge detects PX4 or ArduPilot from the autopilot's heartbeat, requests the telemetry streams it needs, and sends a GCS heartbeat at 1 Hz. Without `--live` it is a dry run: it reads telemetry, sends heartbeats and stream requests, and answers every movement command with `REJECTED DRY_RUN`. Use a dry run for bench tests with the propellers off.

## Raspberry Pi wiring

Connect the flight controller's TELEM2 port to the Pi UART: FC TX to Pi RXD (GPIO15, pin 10), FC RX to Pi TXD (GPIO14, pin 8), and GND to GND (pin 6). Leave the 5 V wire unconnected. Both sides use 3.3 V logic. Enable the UART with `raspi-config` (Interface Options → Serial Port: login shell **no**, serial hardware **yes**).

- ArduPilot: `SERIAL2_PROTOCOL=2`, `SERIAL2_BAUD=921`.
- PX4: `MAV_1_CONFIG=TELEM 2`, `MAV_1_MODE=Onboard`, `SER_TEL2_BAUD=921600`.

```sh
python3 bridge/aero_bridge.py --vehicle mavlink --connect serial:///dev/serial0 --baud 921600 --live ...
```

A USB cable also works: `--connect /dev/ttyACM0`.

## 4G links

**4G with data (recommended).** Any modem that gives the Pi internet access works, such as a USB dongle or a Quectel or SIMCom HAT managed by ModemManager. Use `--transport https --server https://<app>`. The bridge POSTs one telemetry line and any pending acks to `/api/drone/link` every second. The response carries the pending commands, which expire after 30 s. Check the link with `curl -I https://<app>` and keep the clock synced with NTP (`timedatectl`). When the clock is not NTP-synced and differs from the server's `Date` header by more than 5 s, the bridge uses the server's time for timestamps and expiry checks and logs the offset. It never overrides an NTP-synced clock; it only reports the difference.

**SMS only (SIM without data).** Use the modem's AT command port, usually `/dev/ttyUSB2` on Quectel EC25 and SIMCom SIM7600, and stop ModemManager so it releases the port (`sudo systemctl stop ModemManager`). Remove the SIM PIN. Register the SIM's phone number in Fleet. Pass the app's Twilio number as `--sms-to`:

```sh
python3 bridge/aero_bridge.py --vehicle mavlink ... --transport sms --modem /dev/ttyUSB2 --sms-to +15551234567
```

The bridge sets text mode (`AT+CMGF=1`) and the `IRA` character set. In the GSM character set, the `~` before the signature and the `_` in tokens such as `LOW_BATT` become other characters, so the server would reject every line. A modem that refuses IRA is therefore reported as an SMS link error (and retried) rather than used. The bridge sends acks immediately and telemetry every 15 s airborne or every 60 s on the ground. It polls `AT+CMGL="REC UNREAD"` every 5 s and deletes each message after reading it. It ignores SMS from other numbers and lines with bad signatures, and it strips the prefix that Twilio trial accounts add. SMS commands expire after 300 s, and over SMS the link-loss timeout is at least 45 s.

**Time over SMS.** Without mobile data there is no NTP, and a Raspberry Pi has no battery-backed clock. After a power cycle, `fake-hwclock` restores the time saved at shutdown, which can be hours behind. With a clock that is behind, the bridge cannot recognize expired commands, and the server ignores its messages. So the bridge turns on network time updates (`AT+CTZU=1`) and reads the modem clock (`AT+CCLK?`) at start-up and every 10 minutes. When the system clock is not NTP-synced (the kernel's `adjtimex` status) and differs from the network time by more than 5 s, the bridge uses the network time for message timestamps and EXPIRED checks, and logs the offset. Network time comes from the mobile operator (NITZ), and not every network sends it. Until the modem has it, the bridge ignores the modem's default clock (1980, 2004 and so on), uses the system clock and logs a warning every 10 minutes. In that case give the Pi a correct clock another way, such as an RTC module or GPS time through `gpsd` and `chrony`, and check `date -u` before flying.

**Link loss over SMS.** Over SMS the bridge only sees its own side of the link. Its link-loss HOLD and RTL fire after `--link-timeout` (at least 45 s) when the modem cannot send, or when it has lost its network registration (`AT+CREG?` and `AT+CEREG?`, checked every 5 s). The bridge cannot tell that the AERO server or Twilio is down, because the modem keeps sending successfully and silence from the server is normal between commands. The drone then finishes its current step and hovers. Detecting a server outage would need the server to answer every telemetry SMS, which costs SMS. Over SMS, the protection against a server outage is the RC pilot, and the autopilot's own failsafes (battery, geofence).

## What the bridge enforces locally

These checks run even if the server misbehaves. A command that fails one is acked `REJECTED <REASON>`:

| Reason | When |
| --- | --- |
| `EXPIRED`, `REPLAY` | The command is past its expiry, or its `cmdSeq` is not above the highest executed one (persisted in `--state-file`, default `~/.aero-bridge-<droneId>.json`) |
| `FENCE` | The GOTO target, or the takeoff position (TAKEOFF, or an RTL that must climb from a remote pad), is outside `--fence-center`/`--fence-radius` (max 2000 m; required for mavlink) |
| `ALTITUDE` | The target is below 2 m or above `--max-alt` (default 60 m, hard cap 120 m) |
| `LOW_BATT` | The battery is below `--battery-floor` (default 30%) for TAKEOFF, GOTO, or an RTL that must climb from a remote pad. HOLD, LAND, ABORT and an airborne RTL are exempt |
| `NO_GPS` | No 3D fix for TAKEOFF or GOTO, or for an RTL that must climb from a remote pad |
| `DRY_RUN` | A mavlink vehicle without `--live` |
| `BAD_ARGS`, `NOT_AIRBORNE`, `NO_VEHICLE`, `ABORT_ACTIVE` | Bad coordinates, GOTO on the ground, no autopilot heartbeat, or TAKEOFF, GOTO or a climbing RTL while an ABORT is running |

Lines with bad signatures or another drone's id are ignored silently. When the server repeats a command the bridge has already answered, the bridge re-sends its last ack and does nothing else. Only one movement command runs at a time. A new one supersedes it, and the old command is acked `FAILED SUPERSEDED`. HOLD, LAND, RTL and ABORT always preempt. An RTL on the ground more than 5 m from home is a takeoff: the bridge arms, climbs to `--cruise-alt`, then returns. It therefore gets the takeoff checks above, and a drone left at a pad with a low battery or outside the fence must be recovered by hand. ABORT means RTL, with LAND as a fallback, and it never takes off from the ground.

Commands are acked `ACCEPTED` once they have started, then `DONE` or `FAILED`:

| Command | DONE when |
| --- | --- |
| TAKEOFF | Within 1.5 m of the target altitude |
| GOTO | Within 3 m horizontally and 1.5 m vertically |
| HOLD | Holding |
| LAND, RTL, ABORT | Landed and disarmed |

Failure reasons include `MODE_CHANGED` (the RC pilot or an autopilot failsafe switched modes; the bridge stops commanding), `TIMEOUT`, `DISARMED`, `ARM_DENIED`, `TAKEOFF_DENIED`, `HOME_NOT_SET` (see Home position) and `BRIDGE_RESTART`.

Other behavior:

- **Server link loss.** If the server is unreachable for `--link-timeout` seconds (default 20) while airborne, the bridge holds position. After another `--link-timeout` it returns to launch. Over SMS, "unreachable" only means that the modem cannot send or is off the network (see Link loss over SMS above). The bridge acts only while the vehicle is in the flight mode of its own last command, which includes hovering after a step is DONE. Once the RC pilot or an autopilot failsafe selects another mode, or the vehicle disarms, the bridge leaves that flight alone until its next command, even if the pilot later switches through one of the bridge's modes. It also does not intervene during LAND, RTL or ABORT.
- **Hovering over a customer's pin.** After the GOTO to a pin is DONE, the vehicle holds there at cruise altitude in that GOTO's mode (`GUIDED` on ArduPilot, `AUTO.LOITER` on PX4) and the bridge waits: the server sends LAND only when the operator taps **Landing area clear · land**, or a GOTO to the pickup pad if the operator diverts. Meanwhile the link-loss HOLD and RTL above still apply, an RC mode change hands the flight to the pilot, and a battery below `--battery-floor` is only logged, so the autopilot's battery failsafe is what brings it down. None of these sends an ack; Fleet reads the drone's reported position instead. If the drone is on the ground at the pin, the operator's confirmation sends a LAND, which on the ground at most disarms it.
- **Home position.** PX4 and ArduPilot move home to wherever the drone arms. When the drone re-arms at a pickup or drop pad, the bridge sets home back to the home pad with `DO_SET_HOME`, so RTL, including the autopilot's own failsafe RTL, flies home rather than staying at the customer's pad. If the autopilot refuses `DO_SET_HOME` or never acknowledges it, or the home altitude is unknown, the bridge disarms and fails the takeoff with `FAILED HOME_NOT_SET`. On PX4, the takeoff altitude is computed from the home that PX4 sets at arming, the same reference as the relative altitude that decides DONE.
- **Takeoff command.** The bridge does not blindly repeat `NAV_TAKEOFF`, because a repeat that reaches a climbing ArduCopter is refused. When the ack is lost or a repeat is refused, the bridge looks at the vehicle: armed and climbing in the takeoff mode counts as the takeoff in progress. It sends the command once more only when fresh telemetry shows the vehicle still on the ground.
- **Restarts.** Acks the server has not received yet are kept in `--state-file` and re-sent after a restart, signed again with a fresh `seq` and timestamp. A command that was running when the bridge stopped is acked `FAILED BRIDGE_RESTART`.
- **Ctrl-C** stops the bridge without landing. The GCS heartbeats stop, so the autopilot's GCS failsafe acts if the drone is armed.

## Recommended autopilot parameters

Set the autopilot's geofence to match `--fence-radius` and `--max-alt`. Make the return altitude clear obstacles while staying below `--max-alt`. Make sure the autopilot disarms automatically after landing; DONE for LAND and RTL depends on it.

| | PX4 | ArduPilot Copter |
| --- | --- | --- |
| GCS/datalink loss → RTL | `NAV_DLL_ACT=2`, `COM_DL_LOSS_T=10` | `FS_GCS_ENABLE=1`, `SYSID_MYGCS=255` (the bridge's `--source-system`) |
| RC loss → RTL | `NAV_RCL_ACT=2` | `FS_THR_ENABLE=1` |
| Geofence | `GF_ACTION=3`, `GF_MAX_HOR_DIST=<radius>`, `GF_MAX_VER_DIST=<max alt>` | `FENCE_ENABLE=1`, `FENCE_TYPE=3`, `FENCE_RADIUS=<radius>`, `FENCE_ALT_MAX=<max alt>`, `FENCE_ACTION=1` |
| Return altitude | `RTL_RETURN_ALT` (default 60 m) | `RTL_ALT` (in cm, default 1500) |
| Battery | `COM_LOW_BAT_ACT=3` | `BATT_FS_LOW_ACT=2`, `BATT_FS_CRT_ACT=1` |
| Disarm after landing | `COM_DISARM_LAND=2` | Automatic in LAND and RTL |

## Pre-flight checklist

1. Fly the same mission in SITL with the same bridge flags.
2. Make sure the Fleet home, `--fence-center` and the physical home pad agree, and that `--fence-radius` and `--max-alt` are exactly Fleet's geofence radius and maximum altitude (Fleet's bridge command lines fill them in), with the autopilot's fence set to match. Pins are off unless you set a pin zone in Fleet ("Land at customer pins within … m of the pickup pad", 0–100 m). With a zone, survey the whole circle around the pickup pad: a customer's pin inside it, and at least 15 m inside the geofence, becomes the pickup. The drone then hovers over the pin at cruise altitude and lands only when you tap **Landing area clear · land**. Fleet shows which pickup a return will use before you dispatch it. If Fleet has no pin-zone field, the app predates pins and every pickup uses the pickup pad.
3. With the propellers off, check the failsafes: stop the bridge while armed and confirm that the GCS failsafe triggers.
4. Confirm the RC transmitter is on and the pilot is ready. Test that switching flight modes on the RC takes control; the bridge then logs `MODE_CHANGED` and stops commanding.
5. Check the GPS has a 3D fix and at least 6 satellites, the battery is at or above 40% (the server's dispatch minimum), and the compass is calibrated.
6. Check the bridge log shows `LIVE`, the right drone id and a working link, and that the app shows fresh telemetry.
7. Check the clock. Over HTTPS keep it NTP-synced (`timedatectl`), because commands expire after 30 s. Over SMS check that the bridge log reports the modem's network time, or that `date -u` is right.
8. Confirm the area is clear and authorized (in the US, Part 107 or TRUST, and LAANC in controlled airspace), that you keep visual line of sight, and that you will not fly over people. Complete the Fleet checklist.

## Tests

```sh
python3 -I bridge/test_bridge.py          # or: cd bridge && python3 -m unittest -v test_bridge
```

The tests use only the standard library and run in well under 2 s. They check that the Python code reproduces every line in `tests/fixtures/drone-link-vectors.json`, that the parsers are strict, the validator's rejection rules, the SMS and HTTPS transports (including the modem's character set, network time and registration), restarts and the link-loss failsafe, and a TAKEOFF → GOTO → LAND flight of the fake vehicle on a simulated clock. A message-level fake autopilot exercises the MAVLink backend's command and ack flow: lost or refused takeoff commands, a refused `DO_SET_HOME`, the PX4 home reset at arming, and an RC pilot taking over. Real MAVLink encoding and flight behavior still need pymavlink and SITL.
