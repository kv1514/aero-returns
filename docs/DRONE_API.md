# Future indoor-drone boundary — proposal, not implemented

The AERO web demo only runs a geographic simulation. These endpoints describe the hardware teammate's proposed contract from the project brief; they are not deployed handlers and are not connected to the live tracking UI.

Use named landing pads with local coordinates in meters (Home at 0,0; Store at 6,0) for indoor hardware. Do not interpret those coordinates as latitude/longitude. Configure a measured payload/dimension limit after a lift test; the demo's capacities are not hardware specifications.

- `POST /drone/telemetry`: `droneId`, `batteryPct`, `x`, `y`, `altitudeM`, `headingDeg`, `state`, `jobId`, `path` (x/y points), `timestamp`.
- `GET /drone/commands?droneId=…`: the next pending `commandId`, `type`, `padId`, `jobId`.
- `POST /drone/commands/ack`: `commandId`, `status` (`accepted`, `done`, `failed`).

Proposed hardware states: idle, taking_off, en_route, landing, picking_up, dropping, returning, charging, error. Proposed commands: GO_TO_PAD, PICKUP, DROP, RETURN_HOME, LAND, ABORT.

Before implementing: define per-drone authentication and replay protection, monotonic telemetry sequence numbers, command idempotency and expiration, unit/range validation, a stale-feed alarm, an operator abort path, and a hardware interlock for loading. A browser button or photo review is not proof of safe physical loading. Commands must be explicitly armed in a dedicated adapter; the existing simulator must never silently switch to real flight control.

A future `fake_drone.py` should exercise this exact protocol once the authenticated command service exists. It is intentionally not presented as implemented in this return-focused demo.
