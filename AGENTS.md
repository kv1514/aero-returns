# Working on AERO

This is a standalone React/Vinext and Cloudflare D1 demo. Read `README.md` for local setup and `docs/HANDOFF.md` for current status. Do not modify the unrelated parent arbitrage engine when working in the original nested checkout.

## Behavior contracts

- On the return-tracking page, flights, participating hubs, price estimates, and handoffs are simulated. No payments, refunds, or retailer return authorizations are implemented.
- Real aircraft commands exist only on `/fly`, through `lib/drone-server.ts` and `drone-agent/`. Never route the return simulation to a real drone implicitly. Keep both safety layers: server `preflight` (online, `--allow-flight`, GPS, battery, geofence, altitude, route length, pilot confirmation) and the agent's own checks and failsafes (battery/geofence RTL, link-loss hold→RTL, manual RC takeover wins). Safety commands (HOLD/LAND/RTL) must always supersede flights. Store only `sha256` of drone secrets; keep SMS codes HMAC-signed, time-windowed and single-use. See `docs/DRONE_API.md`.
- The ambient fleet on the tracking map (`lib/fleet.ts`) is decoration and must stay labeled as simulated.
- Preserve explicit package-loading confirmation. Advancing the simulation cannot bypass it.
- Real Google Places listings are discovery results, not verified participating drone facilities or proof of QR acceptance. Keep them separate from simulated hub routing.
- Location is opt-in and one-shot. Never add background tracking by default. Keep real booking pickup inside the demo service boundary.
- The legacy Login with Amazon connection links a profile only; Supabase custom Amazon sign-in authenticates an AERO account. Standard profile scopes do not supply purchase history or create returns. Do not scrape signed-in accounts or collect Amazon passwords. Keep tokens out of persistence and logs.
- Scope every stored return and linked account to its owner. For Supabase accounts, authorize only using server-verified `getUser()` IDs, never user metadata or an unverified cookie. Keep the private Sites gate intact. Preserve origin checks, OAuth state/PKCE, and atomic version checks.
- Keep API secrets in ignored `.dev.vars` or hosted runtime variables. A standard Google browser key must be website/API restricted; it is intentionally public to browsers. The owner-approved no-billing Maps Demo Key is an exception for this private prototype: Google limits its APIs and quota, and currently gates custom key settings behind an upgrade. Never attach billing or upgrade it automatically.
- Do not claim sponsor qualification or live integration verification without actual evidence. `/demo` and `data/hackathon-tracks.json` document the researched tracks and their limits.

## Validation and publishing

Use Node 24 (minimum 22.13), `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. For Actor edits also run `python3 tests/test_product_actor.py`; for agent edits run `python3 drone-agent/test_agent.py`. With the local database migrated and dev server running, run `node_modules/.bin/tsx scripts/smoke.ts`, `node_modules/.bin/tsx scripts/location-account-smoke.ts` and `node_modules/.bin/tsx scripts/drone-smoke.ts`. These tests do not call paid providers.

The hosted Site is owner-private. Preserve its audience and `.openai/hosting.json` project ID. GitHub pushes alone do not deploy the Site. Use the Sites publication workflow when available; otherwise report local build completion separately from hosted deployment.
