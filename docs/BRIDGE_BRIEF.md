# Brief for the drone-side Claude

Paste this whole file into the Claude session that is setting up the drone computer. It comes from the Claude session that built the AERO website and the drone link (Oct 24, 2026).

## What already exists. Don't rebuild it.

- **Website:** https://aero-returns.kv15.workers.dev (Cloudflare Worker). The drone page is `/fleet`.
- **Code:** https://github.com/kv1514/aero-returns (public, branch `main`).
- **Drone side:** `bridge/aero_bridge.py`.
  - It is the complete drone backend. It runs on the companion computer, flies PX4 or ArduPilot over MAVLink, and talks to the website.
  - Read `bridge/README.md` first, then `docs/DRONE_LINK.md` (message format, safety model, mission phases).
  - Use it as is. Writing a separate drone backend means re-creating its signing, replay protection and local safety checks.
- **How it talks to the website:**
  - Every second, the bridge POSTs one telemetry line plus any pending acks to `/api/drone/link`. The response carries the pending commands, which expire after 30 s.
  - Every line is signed with HMAC using the drone's own key.
  - `bridge/aero_protocol.py` mirrors `lib/drone-protocol.ts`. `tests/fixtures/drone-link-vectors.json` pins both, so never change one without the other.
- **Dependencies:** standard library only for `--vehicle fake` and `--transport https`. `--vehicle mavlink` needs pymavlink, and SMS needs pyserial (`bridge/requirements.txt`).
- **Commits:** the bridge on GitHub `main` matches what the website expects. The website code on GitHub is behind the deployed version, which has newer uncommitted work.

## Steps

1. **Credentials.**
   - The website owner registers the drone in Fleet on **their own AERO account**, because a drone can only fly returns booked on the account that owns it.
   - Fleet shows a drone ID and a 64-hex key once. The owner sends them to you privately.
   - Put them in the environment as `AERO_DRONE_ID` and `AERO_DRONE_KEY`. Never commit them, print them or paste them anywhere.
2. **Python.** The bridge targets Python 3.10+. On a Jetson that means JetPack 6; older JetPack releases (for example on a Jetson Nano) ship Python 3.6, which is too old. Then:
   ```sh
   python3 -m venv ~/aero-venv && ~/aero-venv/bin/pip install -r bridge/requirements.txt
   ```
3. **Link test, no drone.** `--fake-home` must equal the home point set in Fleet:
   ```sh
   python3 bridge/aero_bridge.py --vehicle fake --transport https --server https://aero-returns.kv15.workers.dev --fake-home <lat>,<lon>
   ```
   Fleet should show fresh telemetry within a few seconds. The owner can then arm the drone in Fleet and dispatch a return, and the fake drone flies the whole mission.
4. **Real flight controller, propellers off (dry run).**
   ```sh
   ~/aero-venv/bin/python bridge/aero_bridge.py --vehicle mavlink --connect /dev/ttyACM0 --transport https --server https://aero-returns.kv15.workers.dev --fence-center <lat>,<lon> --fence-radius <m> --max-alt <m> --cruise-alt <m>
   ```
   - Without `--live`, it reads telemetry and refuses every movement command with `DRY_RUN`.
   - USB to the flight controller is simplest. For header-pin UART on a Jetson the port is usually `/dev/ttyTHS*`, and the serial console on it must be turned off.
   - `--fence-center`, `--fence-radius` and `--max-alt` must equal Fleet's home, geofence radius and max altitude. Set the autopilot's own fence to match too.
5. **SITL next, then `--live`.** Test in SITL with the same flags before any real flight; the README has PX4 and ArduPilot commands. A real flight needs an RC pilot with override authority and the autopilot failsafes on, and it follows the pre-flight checklist in `bridge/README.md`.

## Rules

- Don't weaken or bypass the bridge's local checks (fence, altitude, battery, GPS, expiry and replay), and keep the autopilot failsafes on.
- No customer action ever launches the drone. Every takeoff comes from the operator in Fleet.
- Don't push to `main`. If you change anything, use a branch and tell the website owner. Don't edit the website or server code; describe what you need instead.
- Don't run `scripts/drone-link-smoke.ts` or `scripts/bridge-e2e.ts` against the live website. They register test drones and add test events to its evidence counts, so run them only against a local dev server (`npm run dev`, which needs `DRONE_LINK_SECRET` in `.dev.vars`).

## Coming in tonight's deploy (no bridge changes needed)

- **Pin zone.** Each drone gets an optional pin zone, 0–100 m around its pickup pad (off by default). When a customer's pin is inside it and at least 15 m inside the geofence, the drone flies to the pin instead of the pad. The bridge's `--fence-center`, `--fence-radius` and `--max-alt` must equal Fleet's, or the bridge rejects the pin GOTO with `FENCE` (the operator can then send it to the pad).
- **Hover gate.** The drone then hovers over the pin; the server sends nothing until the operator taps **"Landing area clear · land"** (or switches to the pickup pad).
  - The bridge already handles this: after GOTO is DONE it holds position.
  - The website was tested locally with this exact bridge and its fake vehicle.
- **Simulator command.** Fleet's "test first with the built-in simulator" command will include the drone's altitude and fence flags.
- **Key rotation.** Rotating the key in Fleet now asks for confirmation, and the bridge stops being served commands until it has the new key. Update `AERO_DRONE_KEY` after a rotation.

## Report back

Send the website owner a short note, which they will pass to the website Claude:

- Hardware: computer model, OS or JetPack version, `python3 --version`.
- Flight stack: flight controller, PX4 or ArduPilot and its version, and the connection (USB or UART port).
- Network link: Wi-Fi, 4G data or SMS.
- The commit you are on (`git rev-parse --short HEAD`).
- The first 20 lines of the bridge log from step 3 or 4. Remove the drone ID if you like; the key is never printed.
- Anything that failed, with the exact error.
