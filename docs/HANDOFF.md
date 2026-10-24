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
2. Google sign-in is now live and browser-verified through Supabase in the new AERO organization; see `docs/ACCOUNTS.md`. Amazon Developer registration is deferred at the owner’s request. The existing separate Amazon profile connection can optionally use `AMAZON_CLIENT_ID`, server-only `AMAZON_CLIENT_SECRET`, and the registered `AMAZON_REDIRECT_URI`. Neither flow imports purchases or creates retailer returns. Test success, cancellation, expired/reused state, sign-out/disconnect, and separate-owner isolation before claiming live authentication.
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

## Earth and social account update

- Added Google photorealistic 3D explorer, target camera controls, orbit, Google Earth and key-free Street View links (including nearby listings).
- Added pinned Supabase Auth SDK, server-side PKCE flow, verified identity ownership, no-store account routes, and account UI. The AERO Supabase project is provisioned and connected; Google is enabled and verified, while Amazon remains deferred. See `docs/ACCOUNTS.md`. Return persistence remains D1.
- A separate Free-plan AERO organization and healthy project (`hkmeykcgwnaatkzgukth`) are configured. Hosted redirect URLs and the Amazon userinfo adapter are deployed. Google project `aero-sign-in` and its web client are configured; the secret stays in Supabase. Google is enabled in hosted runtime revision 3. Amazon remains disabled and its registration is deferred by the owner.
- Current validation: typecheck, production build, all 29 TypeScript tests, and both HTTP smoke scripts pass. Account HTTP checks cover missing configuration, unknown providers, cross-origin rejection, and a forged callback redirecting only to the fixed app root.
- Hosted browser verification: photorealistic 3D loads; target selection and orbit work; Street View opens a panorama at the selected demo hub; Google Earth resolves the selected coordinates. Google login, session persistence after reload, sign-out, and repeat login to the same Google-owned history now pass on the hosted app. The original demo history remains separate. Amazon is disabled with a setup explanation. Google remains in Testing mode with the owner registered as a test user; Sites remains owner-private. Screenshot evidence: `outputs/aero-google-signed-in.jpg`. Live second-account, cancellation, expiration/replay checks remain outstanding. Screenshot evidence is local in ignored `outputs/aero-earth.jpg`.

## Visual pickup guide

The tracking card and Earth explorer now open a dedicated Pickup photo view. Users can upload/drop JPG, PNG, or WebP files (8 MB cap), mark the package with a frame, adjust its position/size using keyboard/range controls, add notes, and explicitly confirm a reference. An original illustrated example supports an offline demo. The reference overlay animation is labeled a preview, not a camera match. Loading confirmation is still required separately.

Photos are resized/re-encoded locally to remove source metadata and kept only in React memory, scoped to the active return. Closing the dialog preserves them; refresh, sign-out, or changing returns clears them. Neither photos nor location notes are added to D1 or browser storage. Street View opens at the pickup coordinates in Google Maps; user photos are never published to Google imagery.

`POST /api/pickup-review` optionally sends one photo plus notes to the existing Anthropic integration after the user chooses “Send photo to Claude.” It proposes a validated image-coordinate box, never geographic coordinates or flight instructions. Multiple/no parcels force manual selection; all results need human confirmation. Only an API usage event is stored. Missing provider setup leaves manual marking available; live AI detection remains unverified until a configured provider call succeeds.

Files: `components/pickup-guide.tsx`, `lib/pickup-guide.ts`, `app/api/pickup-review/route.ts`, `public/sample-pickup.svg`. The three new unit tests cover ambiguous detections, untrusted bounds/text, and boundary-safe manual framing (32 tests total).

Pickup-guide verification: typecheck, production build, all 32 unit tests, existing booking/location-account HTTP smoke scripts, and pickup-review missing-provider/no-store/CSRF checks pass. Hosted browser checks verified the illustrated scene, click-to-mark, frame sliders, explicit confirmation, reopening without losing the reference, edit invalidation, and the labeled overlay animation. Automated real-file selection was blocked by the Chrome ChatGPT extension's disabled “Allow access to file URLs” permission; no permission was changed. Real upload and live Anthropic detection must still be verified. No physical pickup was triggered.

## Built-in demo account

Your account → Try demo account opens **Alex Demo**, an explicitly simulated browser-specific profile. No provider login is required. The app's normal first-run initialization creates a sample return. Exit demo account restores the prior Google/Sites/guest identity; re-entering retains Alex's practice history. The mode is visible in the header, and no shared Supabase user or static password is used.

Implementation: `lib/demo-account.ts`, `/api/account/demo`, `lib/server.ts`, account API/panel, and header indicator. Local verification: 34 TypeScript tests, 4 Actor tests, typecheck, existing booking/location HTTP smoke scripts, and the new `scripts/demo-account-smoke.ts` isolation/full-journey checks pass. No real drone, payment, or retailer action takes place.

## Cloudflare, live drone link and ride-style UI (October 24, 2026, Claude)

- **Hosting.** Public Cloudflare Worker `aero-returns` with its own D1 database: https://aero-returns.kv15.workers.dev. `npm run deploy` builds, migrates and deploys (`docs/DEPLOY.md`). Hosted secrets from the Sites prototype (Google Maps demo key, Supabase) were not copied; those features fall back cleanly until they are set as Worker secrets.
- **Security fix.** `lib/session.ts` no longer trusts `oai-authenticated-user-id` unless `AERO_TRUST_SITES_IDENTITY=true`. On a public URL that header let anyone read another owner's returns.
- **Maps.** CARTO raster tiles now require a key and rendered "API KEY REQUIRED"; MapLibre uses OpenFreeMap's keyless Positron vector style.
- **Drone link.** `docs/DRONE_LINK.md`: signed SMS-sized text protocol (`lib/drone-protocol.ts`, Python mirror in `bridge/`), HTTPS polling for 4G data and Twilio SMS for SMS-only SIMs, owner-scoped `/fleet` console, D1 tables in `drizzle/0002_drone_link.sql`, pure mission rules in `lib/drone-mission.ts`, storage/transports in `lib/drone-server.ts`. Live returns reuse the customer UI through `snapshot()`.
- **UI.** Full-bleed map, floating controls, one trip sheet (left on desktop, bottom sheet on mobile) in `app/ride.css` + `components/aero-app.tsx`. All dialogs and features are unchanged. Modals are centered again (Tailwind's reset had zeroed `<dialog>` margins).
- **Verification.** Typecheck, production build, 41 TypeScript tests, and `scripts/drone-link-smoke.ts` against the deployed Worker (register → arm → dispatch → full mission through acks → forged telemetry rejected). No physical drone has flown; the hardware teammate should run the bridge against PX4/ArduPilot SITL first.

## Hardening pass (October 24, 2026, later)

- Two multi-agent reviews (drone link/UI and a per-feature bug hunt with live API probing) confirmed ~100 issues; all are fixed except the optional items noted in commit history. Highlights: SMS only to numbers verified by a signed inbound text, unique SMS numbers, send-once with capped resends and per-minute limits; customer cancel decided by phase (LAND during takeoff/landing, RTL en route, nothing once landed) and superseding queued commands; ABORT/LAND/RTL queued directly; mission step + command committed atomically; freshness gates use only fresh telemetry; idle-drone D1 writes throttled; dispatch requires a landed/idle state.
- Bridge: 60 tests; RTL-from-ground gated like takeoff, pilot takeover respected by the link-loss failsafe, undelivered acks persisted, modem network time for SMS-only Pis, ArduPilot lost-takeoff-ack handling, takeoff refused if DO_SET_HOME fails, PX4 takeoff reference fixed, IRA-only modem charset.
- Claude photo checks use the official SDK (`lib/claude.ts`): structured outputs, effort, refusal fallback, default `claude-opus-5-5`. They stay disabled until `ANTHROPIC_API_KEY` is set as a Worker secret.
- Key-free 3D neighborhood view (OpenFreeMap Liberty 3D buildings) when no Google key is configured.
- Verification: typecheck, 48 TS tests, 60 bridge tests, Actor tests; `smoke`, `location-account-smoke`, `demo-account-smoke`, `drone-link-smoke`, `bridge-e2e` and targeted safety checks pass against a local production build and against https://aero-returns.kv15.workers.dev. The smoke scripts now take the base URL as their first argument (they used to default to whatever ran on port 5173).

## Track focus: Visa, Anthropic, Microsoft, hardware (October 24, 2026, evening)

Four tracks, one return: a person books from home (Visa), Claude checks it (Anthropic), the merchant receives it (Microsoft "built for the real world"), and the drone link flies it (hardware). `/demo` is the judge room: each track's criteria, a 60-second path, live counts from `/api/evidence` and honest gaps.

- **Claude return check** (`lib/return-agent.ts`, `lib/return-agent-shared.ts`, `POST /api/return-agent`, `components/return-check.tsx` in booking). A manual tool-use loop: Claude calls `check_drone_eligibility` (the same `recommend()` the booking uses) and, when Apify is configured, `lookup_product_specs`, then answers in a fixed JSON schema. `gateDecision` makes the verdict agree with the drone limits and sends confidence under 0.85, a mismatch, or damaged/unclear condition to a person. A booking attaches the check only from the owner's own stored `agent` event (`lib/server.ts`), never from browser input.
- **Person hold.** A `needs_person` return stays on the ground, simulated or live, until someone approves or declines it on `/merchant` (`heldForPerson` in `lib/simulation.ts`, PATCH actions `approve`/`decline`, and a Fleet dispatch blocker in `lib/drone-mission.ts`). Declining cancels the pickup; resetting a declined return puts it back on hold. In the demo the reviewer is the same signed-in owner; a retailer would use its own staff account.
- **Merchant desk** (`/merchant`, `lib/merchant.ts`, `GET /api/merchant`). Stages, Claude grade and suggested disposition per return, a needs-a-person queue with approve/decline, and labelled demo estimates (store trips avoided, time saved). Simulated and drone-link rows are labelled separately; a drone-link row may still be a simulator.
- **Evidence** (`lib/evidence.ts`, `GET /api/evidence`): aggregate counts only, across all accounts, including team testing and smoke runs. No physical flight has happened yet; the counts can't tell SITL or the bridge's simulated vehicle from real hardware.
- **Fixed in this pass:** the customer header's Fleet button used the class `fleet`, which also styles the Fleet page root (`min-height:100dvh`), so the header sat mid-screen at tablet widths. It is now `ux-fleet-entry`.
- **Verification:** typecheck, 109 TS tests (including `tests/person-hold.test.ts`), 60 bridge tests; `smoke`, `location-account-smoke`, `demo-account-smoke` and `drone-link-smoke` pass against https://aero-returns.kv15.workers.dev. The hold was clicked through on a local build with a test-only review (held → approved on `/merchant` → drone en route).
- **Still open:** live Claude calls need `ANTHROPIC_API_KEY` as a Worker secret (`wrangler secret put ANTHROPIC_API_KEY --config dist/server/wrangler.json`). Judge-room source links point at `github.com/kv1514/aero-returns/blob/main/...` and work once this tree is pushed.

