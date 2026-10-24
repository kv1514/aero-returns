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

## Live drone control (October 24, 2026)

Branch `feature/live-drone-control` adds real drone control on a new **/fly** page, separate from the simulated return tracking.

- **Website.** `/fly` (`components/drone-control.tsx`, `components/drone-map.tsx`). Link a drone and copy its one-time token. Watch live telemetry on a vector map (safety-zone circle, trail, planned route), pick A/B on the map or use "Fly my latest return", then Hold / Land / Return home. Pilot codes let other accounts fly; the Text backup tab builds or sends signed SMS commands. The header now links to `/fly`.
- **Server.** `lib/drone-protocol.ts` holds the pure schemas, `preflight`, priorities, token and SMS signing. `lib/drone-server.ts` handles D1 and routes under `app/api/drones/**` and `app/api/drone/sync`. Migration: `drizzle/0002_live_drones.sql`. Optional env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
- **Drone.** `drone-agent/aero_agent.py` covers ArduPilot over MAVLink via pymavlink, a built-in `--sim` vehicle, the 4G modem SMS reader, failsafes and a systemd unit. `scripts/fake-drone.ts` is a Node simulated drone with the same protocol.
- **Tracking page polish.** Keyless OpenFreeMap vector basemap; the CARTO raster tiles were watermarking "API key required" at street zoom. Three labeled simulated fleet drones (`lib/fleet.ts`) loop continuously on both Google and MapLibre maps. Phone layout: overlays restacked above the sheet, notifications/3D buttons hidden, fit padding increased.

Verification on Windows: typecheck, build, 43 TypeScript tests (9 new), `scripts/drone-smoke.ts` (ownership, tokens, rotation, priorities, pilots, SMS), and a browser end-to-end flight with `scripts/fake-drone.ts`: create link → connect → pick B → takeoff → cruise → land → "done". Not yet run: `drone-agent/test_agent.py` (no local Python; it is wired into GitHub Actions), ArduPilot SITL, and real hardware.

Windows note: deep checkout paths break npm and local D1. Map the folder to a drive letter (`subst R: <path>`), set `AERO_LOCAL_STATE` to a short folder (see `vite.config.ts`), and pass the same folder to `wrangler d1 execute --persist-to`.

## Delivery jobs and status updates (October 24, 2026)

Real-drone deliveries with package status updates, on top of the live link.

- **Flow** (`lib/drone-jobs.ts`): Dispatched → On the way to pickup → Arrived at pickup → *person confirms loading* → Package picked up → Package in flight → Package delivered (landed, gripper released) → Drone returning home → Delivery complete. A failed leg becomes "Delivery needs attention" with Resume or Cancel.
- **Server**: `POST /api/drones/:id/jobs` with `op: create | loaded | cancel | resume`. Legs are queued as commands tagged with `job_id`/`leg`. `/api/drone/sync` advances jobs from the drone's acks and queues the next leg in the same response. The `drone_events` status feed records job milestones, safety commands sent, and anything new the drone reports. `GET /api/drones?view=jobs` is a lightweight feed for the tracking page. Migration: `drizzle/0003_delivery_jobs.sql`.
- **Drone**: `FLY_ROUTE` gains `release: true` on the drop-off leg. After touchdown the agent sends `MAV_CMD_DO_GRIPPER` (release) and acks "Landed. Package released.", or fails the leg if the gripper refuses. Telemetry adds `payload: loaded | empty | unknown`.
- **UI**: on `/fly`, the Fly tab has **Delivery** (pick P and D, or "Use my latest return") and **Free flight** modes. A live delivery card shows a 6-step tracker, an in-card "Package is loaded" confirmation, Cancel and Resume. The status-update feed and toasts show every change. The tracking page shows a "LIVE DRONE" banner that links to `/fly`.
- **Fixed**: vinext `next/link` client navigation throws here ("RSC prefetch setup error"), so internal links are plain `<a>` again; the earlier `/fly` links didn't navigate.

Verification: typecheck, build, 49 TypeScript tests (6 new job tests), all four HTTP smoke suites (the drone smoke now covers a full delivery, resume and cancel over the device protocol), 15 Python agent tests (2 new: pickup→drop-off release, jammed gripper; run in CI), and a browser end-to-end delivery with `scripts/fake-drone.ts`. Not yet: ArduPilot SITL with `GRIPPER_ENABLE`, real hardware.

## Running it on another computer

GitHub stores the code; it doesn't host the website. To see it elsewhere, either run it locally or deploy it.

```sh
git clone https://github.com/kv1514/aero-returns.git && cd aero-returns
git checkout feature/live-drone-control
npm ci
npm run build
# Apply each migration once (0000 → 0003) to a fresh local database:
for f in drizzle/000*.sql; do node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file "$f"; done
npm run dev        # http://127.0.0.1:5173 (or: npm start for the production build)
node_modules/.bin/tsx scripts/fake-drone.ts --server http://127.0.0.1:5173 --token <token from /fly>
```

On Windows with a deep folder path, see the Windows note in the live drone section above. The hosted Site (`aero-returns-kv15…chatgpt.site`) only changes when the owner republishes it after merging.
