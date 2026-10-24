# AERO continuation guide

Read `AGENTS.md`, `README.md`, and `docs/HANDOFF.md` before editing. This repository is the AERO drone-return app, independent of the sports arbitrage project that originally contained the checkout.

Keep the interactive demo working without provider credentials. Distinguish simulation, configured integrations, and successfully verified live integrations in both code and UI.

## Live drone work (`/fly`)

Start with [`docs/DRONE_ARCHITECTURE.md`](docs/DRONE_ARCHITECTURE.md). It covers how the website, the 4G link and the drone fit together, why the drone polls instead of being pushed to, the delivery status flow, recommended hardware, the bring-up plan and the roadmap. Protocol details are in `docs/DRONE_API.md`, and the latest status and verification are in the "Live drone control" and "Delivery jobs" sections of `docs/HANDOFF.md`.

- Never let the simulated return tracking drive real hardware. Real commands come only from `/fly` (`lib/drone-server.ts`) and are executed by `drone-agent/aero_agent.py`.
- Preserve both safety layers (server `preflight`, agent checks and failsafes) and the human "package loaded" confirmation in `lib/drone-jobs.ts`.
- Test without hardware using `scripts/fake-drone.ts` or `aero_agent.py --sim`. Run `scripts/drone-smoke.ts` and `python3 drone-agent/test_agent.py`.
- Use plain `<a href>` for internal links. vinext's `next/link` client navigation throws in this app.
