# AERO handoff for Claude

Prepared October 23, 2026 (Pacific).

## Start here

Live demo: https://aero-returns-kv15.kveldanda10.chatgpt.site (owner-private).

The goal is a polished, interactive 3–5 minute Cal Hacks returns demo, with useful sponsor integrations. The core demo runs without API credentials. Read the root README for install, local D1 migrations, commands, and exact provider setup. `CLAUDE.md` points here automatically.

## Implemented

- Full-screen tracking, deterministic moving drone, ETA/heading/altitude/battery, follow camera, flight controls, booking, explicit package load, completed receipt, history, owner-scoped persistence.
- QR image decoding on-device, structured demo QR, unverified retailer QR/manual label flow, capacity and simulated compatible-hub selection.
- Optional Claude photo review and Apify product-spec Actor, with missing-credential and uncertainty states. No live sponsor call is claimed.
- Google Maps settings accept a restricted browser key in tab session storage. Hosted browser key configuration is also supported. Google tracking, address search, reverse geocoding, pickup pin, one-shot geolocation with accuracy feedback, MapLibre fallback.
- Nearby UPS/drop-offs/warehouses search with radius and distance sorting, Google map, details and directions. These listings are not connected to simulated drone dispatch.
- Login with Amazon profile OAuth, PKCE/state, private profile persistence, disconnect, and an Amazon Orders → return QR/label → AERO booking flow. No automatic purchase import, actual return creation, or refunds.
- `/demo` includes the presentation runbook and 58 researched Cal Hacks prize cards. Research is a dated snapshot; recheck official sponsor rules before submission.

## Latest polish

Same-tab booking recovery now preserves package details, pickup, return reference and wizard step through closing/reloading. Draft parsing rejects corrupt, expired and out-of-area data. Confirmation consent is not restored. Blank pickup labels are rejected client and server side. Return references appear in review and receipts. `/demo` now includes Google/Amazon readiness and direct GitHub/handoff links. GitHub Actions checks future pushes and pull requests.

Hosted HTTPS browser QA is working. Google map rendering, Geocoding v4 address lookup (2180 Milvia St, Berkeley), UPS search (20 listings), and warehouse discovery (one listing within 5 km) were verified on the hosted prototype. The local browser URL was previously blocked; do not work around that policy. Mobile layout and a demo recording remain outstanding.

## Next work that needs credentials

1. Google’s free Maps Demo Key is now configured in Sites runtime secrets, with no billing enabled. It is limited to testing/evaluation, with daily quotas. Google’s Keys & Credentials screen requires an upgrade to edit restrictions; no upgrade was performed. Keep it free. The legacy JS Geocoder failed with this key, so address/reverse lookup now uses Geocoding API v4. Address lookup was verified after publication. Remaining manual checks: reverse geocoding with device permission, permission denied, inaccurate location, zero results, and mobile layout. Never commit the key.
2. Register Login with Amazon. Set `AMAZON_CLIENT_ID`, server-only `AMAZON_CLIENT_SECRET`, and the exact registered `AMAZON_REDIRECT_URI`. Test success, cancellation, expired/reused state, disconnect, and separate-owner isolation. No Amazon credentials were provided; the live authorization exchange remains unverified.
3. Add Anthropic and Apify credentials if pursuing those sponsor tracks; record real successful evidence. The Python Actor must be deployed in the team's own Apify account.
4. Run the end-to-end demo with a human presenter. Confirm location and retailer acceptance language remains honest. Do not expand into real drone controls merely to make a demo look live.

## Verification at handoff

Typecheck and production build pass. All 25 TypeScript tests pass, including four Geocoding v4 tests for coordinate order, encoding, empty results, quota errors, and malformed data. Local HTTP smoke checks pass for the complete booking journey, session isolation, Maps configuration, Amazon missing-setup state, cross-origin rejection, and invalid callback rejection. Browser interaction verified Amazon import opening a prefilled booking and nearby discovery leading to Maps configuration without a key. Real Google Maps rendering, address lookup, UPS and warehouse search are verified on the hosted prototype; Amazon authorization remains unverified.

## Code map

- `lib/simulation.ts`, `lib/server.ts`: flight model, owner-scoped persistence and booking controls.
- `components/aero-app.tsx`, `components/booking.tsx`: consumer UI.
- `components/flight-map.tsx`, `components/maplibre-flight-map.tsx`, `components/google-mini-map.tsx`: map providers and interpolation.
- `lib/google-maps.ts`, `lib/location.ts`, `components/map-config.tsx`, `components/pickup-location.tsx`, `components/nearby-places.tsx`: Maps and location workflows.
- `lib/amazon-oauth.ts`, `lib/amazon-server.ts`, `app/api/amazon/`, `components/amazon-connection.tsx`: account linking and manual return import.
- `db/schema.ts`, `drizzle/0000_uneven_violations.sql`, `drizzle/0001_many_chimera.sql`: schema and migrations. Apply each migration once to a fresh local DB; do not blindly reapply existing migrations.
- `lib/integration-server.ts`, `actors/product-specs/`: optional live sponsor integrations.
- `data/hackathon-tracks.json`, `components/demo-room.tsx`: research and presentation.

The original checkout is `/Users/kv15/Documents/ChatGPT/arbitradge/sites/aero`; it is its own Git repository. Build output, local database, uploaded local files, provider credentials, and dependencies are intentionally excluded from source control.
