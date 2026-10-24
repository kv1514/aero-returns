# Working on AERO

This is a standalone React/Vinext and Cloudflare D1 demo. Read `README.md` for local setup and `docs/HANDOFF.md` for current status. Do not modify the unrelated parent arbitrage engine when working in the original nested checkout.

## Behavior contracts

- Flights, participating hubs, price estimates, and handoffs are simulated. No real aircraft commands, payments, refunds, or retailer return authorizations are implemented.
- Preserve explicit package-loading confirmation. Advancing the simulation cannot bypass it.
- Real Google Places listings are discovery results, not verified participating drone facilities or proof of QR acceptance. Keep them separate from simulated hub routing.
- Location is opt-in and one-shot. Never add background tracking by default. Keep real booking pickup inside the demo service boundary.
- Login with Amazon links a profile only. Standard profile scopes do not supply purchase history or create returns. Do not scrape signed-in accounts or collect Amazon passwords. Keep tokens out of persistence and logs.
- Scope every stored return and linked account to its owner. Preserve origin checks, OAuth state/PKCE, and atomic version checks.
- Keep API secrets in ignored `.dev.vars` or hosted runtime variables. A Google browser key must be website/API restricted; it is intentionally public to browsers.
- Do not claim sponsor qualification or live integration verification without actual evidence. `/demo` and `data/hackathon-tracks.json` document the researched tracks and their limits.

## Validation and publishing

Use Node 24 (minimum 22.13), `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. For Actor edits also run `python3 tests/test_product_actor.py`. With the local database migrated and dev server running, run `node_modules/.bin/tsx scripts/smoke.ts` and `node_modules/.bin/tsx scripts/location-account-smoke.ts`. These tests do not call paid providers.

The hosted Site is owner-private. Preserve its audience and `.openai/hosting.json` project ID. GitHub pushes alone do not deploy the Site. Use the Sites publication workflow when available; otherwise report local build completion separately from hosted deployment.
