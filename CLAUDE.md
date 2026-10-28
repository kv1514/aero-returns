# AERO continuation guide

Read `AGENTS.md`, `README.md`, and `docs/HANDOFF.md` before editing. This repository is the AERO drone-return simulation, independent of the sports arbitrage project that originally contained the checkout.

Keep the interactive demo working without provider credentials. Distinguish simulation, configured integrations, and successfully verified live integrations in both code and UI.

Use plain `<a href>` for internal links, never `next/link`: with vinext 1.0.0-beta.5 a `<Link>` click throws and the page does not navigate (found by TigerC12, reproduced on the deployed Worker Oct 24; `tests/plain-links.test.ts` guards it).

For real-drone work read `docs/DRONE_LINK.md` (protocol, mission, safety), then `docs/DRONE_ARCHITECTURE.md` (why the drone polls over 4G, recommended hardware, bring-up order and roadmap).

On Windows with a deep checkout path, local D1 cannot open its SQLite files: set `AERO_LOCAL_STATE` to a short folder (`vite.config.ts`) and pass the same folder to `wrangler d1 execute --persist-to`.
