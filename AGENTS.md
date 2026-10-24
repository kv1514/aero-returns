# Working on AERO

This is a standalone React/Vinext and Cloudflare D1 demo. Read `README.md` for local setup and `docs/HANDOFF.md` for current status. Do not modify the unrelated parent arbitrage engine when working in the original nested checkout.

## Behavior contracts

- Returns are simulated by default: participating hubs, price estimates and handoffs are demo configurations. No payments, refunds, or retailer return authorizations are implemented.
- A real PX4/ArduPilot drone can fly a return only through the drone link (`docs/DRONE_LINK.md`): owner-registered drone, signed commands, operator checklist arming, geofence and 120 m cap, operator-launched takeoffs, always-available abort. Never let the simulator silently switch to real flight, never let a customer action launch a drone, and never weaken these gates to make a demo smoother.
- Preserve explicit package-loading confirmation. Advancing the simulation cannot bypass it.
- Real Google Places listings are discovery results, not verified participating drone facilities or proof of QR acceptance. Keep them separate from simulated hub routing.
- Location is opt-in and one-shot. Never add background tracking by default. Keep real booking pickup inside the demo service boundary.
- The legacy Login with Amazon connection links a profile only; Supabase custom Amazon sign-in authenticates an AERO account. Standard profile scopes do not supply purchase history or create returns. Do not scrape signed-in accounts or collect Amazon passwords. Keep tokens out of persistence and logs.
- Scope every stored return and linked account to its owner. For Supabase accounts, authorize only using server-verified `getUser()` IDs, never user metadata or an unverified cookie. Keep the private Sites gate intact. Preserve origin checks, OAuth state/PKCE, and atomic version checks.
- Keep API secrets in ignored `.dev.vars` or hosted runtime variables. A standard Google browser key must be website/API restricted; it is intentionally public to browsers. The owner-approved no-billing Maps Demo Key is an exception for this private prototype: Google limits its APIs and quota, and currently gates custom key settings behind an upgrade. Never attach billing or upgrade it automatically.
- Do not claim sponsor qualification or live integration verification without actual evidence. `/demo` and `data/hackathon-tracks.json` document the researched tracks and their limits.

## Validation and publishing

Use Node 24 (minimum 22.13), `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. For Actor edits also run `python3 tests/test_product_actor.py`. With the local database migrated and dev server running, run `node_modules/.bin/tsx scripts/smoke.ts` and `node_modules/.bin/tsx scripts/location-account-smoke.ts`. These tests do not call paid providers.

The public deployment is the Cloudflare Worker `aero-returns` (https://aero-returns.kv15.workers.dev) with D1 database `aero-returns`; deploy with `npm run deploy` after `wrangler login` (see `docs/DEPLOY.md`). GitHub pushes alone do not deploy. The original ChatGPT Sites prototype is owner-private; preserve `.openai/hosting.json`, and set `AERO_TRUST_SITES_IDENTITY=true` only behind the Sites proxy, because elsewhere any client can forge the `oai-authenticated-user-*` headers. Report local build completion separately from hosted deployment.

For drone link changes also run `npm test`, `python3 -I bridge/test_bridge.py`, and `node_modules/.bin/tsx scripts/drone-link-smoke.ts <baseUrl>` plus `node_modules/.bin/tsx scripts/bridge-e2e.ts <baseUrl>` (real bridge, simulated vehicle) against a running app; local runs need `DRONE_LINK_SECRET` in `.dev.vars`.
