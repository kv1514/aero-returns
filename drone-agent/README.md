# AERO drone agent

Runs on the drone and links it to the AERO website over 4G. Protocol and safety model: [`../docs/DRONE_API.md`](../docs/DRONE_API.md).

## Hardware

- A flight controller running **ArduPilot Copter** (Pixhawk, Cube, Matek …) with GPS
- An onboard computer: Raspberry Pi 4/5 or Zero 2 W
- A **4G modem with a data SIM**: USB dongle or HAT (Quectel EC25 / SIM7600 …). Its AT port receives texts for the SMS backup
- An RC transmitter, always held by a pilot who can see the drone

Wire a flight-controller TELEM port to the Pi's UART (`/dev/serial0`). Set `SERIALx_PROTOCOL = 2` and `SERIALx_BAUD = 921` on that port. A USB cable (`/dev/ttyACM0`) also works.

## Install

```bash
sudo mkdir -p /opt/aero && sudo cp aero_agent.py requirements.txt /opt/aero/
sudo pip3 install -r /opt/aero/requirements.txt
```

## Link the drone

1. Open **/fly** on the website, then choose **Create drone link** and copy the token (it is shown once).
2. First run, observe-only (telemetry only; nothing moves):
   ```bash
   python3 /opt/aero/aero_agent.py --server https://YOUR-SITE --token aero_… --connect /dev/serial0 --baud 921600 --modem /dev/ttyUSB2
   ```
3. When the map shows the drone in the right place with a good GPS fix, add `--allow-flight` to accept flights.
4. Run it at boot: put `AERO_SERVER=…` and `AERO_DRONE_TOKEN=…` in `/etc/aero-agent.env` (chmod 600), then install `aero-agent.service`.

## Before every flight

- Check airspace and local rules. In the US: Part 107, visual line of sight, ≤ 120 m.
- Set the safety zone and max altitude on the Fly page's **Settings** tab. Home is where the drone first got a GPS fix; use **Set home here** to move it.
- Keep a pilot on the RC transmitter. Switching to STABILIZE / ALT_HOLD / POSHOLD always takes control back from the agent.
- Configure ArduPilot's own failsafes: `FENCE_ENABLE`, `BATT_FS_LOW_ACT`, `FS_THR_ENABLE`.

## No hardware yet?

```bash
python3 aero_agent.py --server http://127.0.0.1:5173 --token aero_… --sim --allow-flight --sim-home 37.8719,-122.2585
```

Or ArduPilot SITL: `sim_vehicle.py -v ArduCopter --out udp:127.0.0.1:14550`, then `--connect udp:127.0.0.1:14550`.

Tests (standard library only): `python3 test_agent.py`
