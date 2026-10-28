# AERO handoff for Claude

Started October 23, 2026; last updated October 24, 2026 (Pacific). Sections are in date order, so the newest changes are at the end.

## Start here

Live demo: https://aero-returns.kv15.workers.dev, a public Cloudflare Worker with its own D1 database (`docs/DEPLOY.md`). The earlier ChatGPT Sites prototype (`aero-returns-kv15.kveldanda10.chatgpt.site`) was owner-private; its Google Maps demo key and Supabase settings were never copied to the Worker.

The goal is a polished, interactive 3–5 minute Cal Hacks returns demo with useful sponsor integrations. The core demo runs without API credentials. Read `AGENTS.md` for the behavior contracts and the root README for install, local D1 migrations, commands, provider setup and how to install AERO on a phone. `CLAUDE.md` points here automatically.

On the Worker (checked October 24 through `/api/integrations`, `/api/fleet`, `/api/account` and `/api/evidence`): `ANTHROPIC_API_KEY` and `DRONE_LINK_SECRET` are set, and the evidence counts include completed Claude return and photo checks. Google Maps, Apify, Twilio SMS, Amazon and Supabase are not configured. No physical flight has happened; completed drone-link missions came from smoke scripts and simulated vehicles.

## Implemented (October 23)

- Full-screen tracking, deterministic moving drone, ETA/heading/altitude/battery, follow camera, flight controls, booking, explicit package load, completed receipt, history, owner-scoped persistence.
- QR image decoding on-device, structured demo QR, unverified retailer QR/manual label flow, capacity and simulated compatible-hub selection.
- Optional Claude photo review and Apify product-spec Actor, with missing-credential and uncertainty states.
- Google Maps settings accept a restricted browser key in tab session storage, and a hosted browser key is supported. Google tracking, address search, reverse geocoding, pickup pin, one-shot geolocation with accuracy feedback, MapLibre fallback.
- Nearby UPS/drop-offs/warehouses search with radius and distance sorting, Google map, details and directions. These listings are not connected to simulated drone dispatch.
- Login with Amazon profile OAuth, PKCE/state, private profile persistence, disconnect, and an Amazon Orders → return QR/label → AERO booking flow. No automatic purchase import, actual return creation, or refunds.
- `/demo` includes the presentation runbook and 58 researched Cal Hacks prize cards. Research is a dated snapshot; recheck official sponsor rules before submission.

## Latest polish (October 23, Sites prototype)

Same-tab booking recovery preserves package details, pickup, return reference and wizard step through closing/reloading. Draft parsing rejects corrupt, expired and out-of-area data. Confirmation consent is not restored. Blank pickup labels are rejected client and server side. Return references appear in review and receipts. GitHub Actions checks pushes and pull requests.

On the Sites prototype, Google map rendering, Geocoding v4 address lookup (2180 Milvia St, Berkeley), UPS search (20 listings), and warehouse discovery (one listing within 5 km) were verified with the Maps demo key. None of that is configured on the Worker.

## Next work that needs credentials

1. **Google Maps** is not configured on the Worker (`/api/maps-config` returns no key), so the app uses MapLibre and OpenFreeMap. To enable it, set `GOOGLE_MAPS_BROWSER_KEY` (and optionally `GOOGLE_MAPS_MAP_ID`) as Worker secrets. The Sites prototype used Google's free Maps Demo Key with no billing; keep any key free of billing unless the owner decides otherwise, and never commit it. Still unchecked: reverse geocoding with device permission, permission denied, inaccurate location and zero results.
2. **Sign-in.** Supabase is not configured on the Worker (`/api/account` reports `configured:false`), so the Google and Amazon sign-in buttons stay disabled; guests and the demo account work. Google sign-in through Supabase was verified only on the Sites prototype, and `docs/ACCOUNTS.md` describes that setup. To enable it on the Worker, set the `SUPABASE_*` secrets and add the workers.dev callback to Supabase. Amazon Developer registration is deferred at the owner's request. Neither flow imports purchases or creates retailer returns.
3. **Apify** is not configured. The Python Actor must be deployed in the team's own Apify account, then `APIFY_TOKEN` and `APIFY_ACTOR_ID` set.
4. Run the end-to-end demo with a human presenter, including the home-screen install on a real iPhone and Android phone. Keep location and retailer-acceptance language honest. Do not expand into real drone controls merely to make a demo look live.

## Verification at handoff (October 23, Sites prototype)

Typecheck and production build passed. All 25 TypeScript tests passed, including four Geocoding v4 tests. Local HTTP smoke checks passed for the complete booking journey, session isolation, Maps configuration, Amazon missing-setup state, cross-origin rejection, and invalid callback rejection. Amazon authorization remains unverified.

## Code map

- `lib/simulation.ts`: flight model, simulated fleet (`SIM_FLEET`, `nearestDrones`, `assignDrone`), person hold (`heldForPerson`, `bookedReview`), hub ranking.
- `lib/request-flow.ts`: what the app opens on, matching timings, the booking schema. `lib/server.ts`: owner-scoped persistence, drone assignment and booking controls.
- `components/aero-app.tsx`, `components/booking.tsx`: consumer UI (home screen, booking, matching, tracking).
- `components/flight-map.tsx`, `components/maplibre-flight-map.tsx`, `components/google-mini-map.tsx`, `components/drone.tsx`: map providers, markers and interpolation.
- `lib/google-maps.ts`, `lib/location.ts`, `components/map-config.tsx`, `components/pickup-location.tsx`, `components/nearby-places.tsx`: Maps and location workflows.
- `lib/amazon-oauth.ts`, `lib/amazon-server.ts`, `app/api/amazon/`, `components/amazon-connection.tsx`: account linking and manual return import.
- `db/schema.ts` and `drizzle/0000_uneven_violations.sql`, `0001_many_chimera.sql`, `0002_drone_link.sql`, `0003_sms_hardening.sql`, `0004_integration_kind_index.sql`: schema and migrations. Apply each migration once, in order, to a fresh local DB (README); do not blindly reapply existing ones. `npm run deploy` applies new ones remotely.
- `lib/integration-server.ts`, `lib/claude.ts`, `lib/return-agent.ts`, `actors/product-specs/`: optional live sponsor integrations.
- `lib/merchant.ts`, `components/merchant-console.tsx`: merchant desk. `lib/evidence.ts`: aggregate counts.
- `lib/drone-protocol.ts`, `lib/drone-mission.ts`, `lib/drone-server.ts`, `lib/fleet-view.ts`, `components/fleet-console.tsx`, `bridge/`: drone link.
- `lib/http.ts`: shared 405/401 answers for every API route.
- `app/layout.tsx`, `app/pwa.css`, `public/manifest.webmanifest`, `public/icons/`, `public/splash/`, `scripts/generate-pwa-assets.mjs`: home-screen app.
- `data/hackathon-tracks.json`, `components/demo-room.tsx`: research and the judge room.

The original checkout is `/Users/kv15/Documents/ChatGPT/arbitradge/sites/aero`; it is its own Git repository. Build output, local database, uploaded local files, provider credentials, and dependencies are intentionally excluded from source control.

## Earth and social account update (October 23, Sites prototype)

Everything in this section was configured and verified on the owner-private Sites prototype, not on the Worker.

- Added Google photorealistic 3D explorer, target camera controls, orbit, Google Earth and key-free Street View links (including nearby listings).
- Added pinned Supabase Auth SDK, server-side PKCE flow, verified identity ownership, no-store account routes, and account UI. The AERO Supabase project (`hkmeykcgwnaatkzgukth`, Free plan, its own organization) was connected to the Sites prototype with Google enabled; Amazon remains deferred. See `docs/ACCOUNTS.md`. Return persistence remains D1.
- Validation then: typecheck, production build, all 29 TypeScript tests, and both HTTP smoke scripts. Account HTTP checks cover missing configuration, unknown providers, cross-origin rejection, and a forged callback redirecting only to the fixed app root.
- Browser verification then: photorealistic 3D loaded; target selection and orbit worked; Street View opened at the selected demo hub; Google login, session persistence after reload, sign-out, and repeat login worked. Google stayed in Testing mode with the owner as test user. Live second-account, cancellation and expiration/replay checks remain outstanding.

## Visual pickup guide (October 23)

The **Pickup photo** tile on the trip sheet and the Pickup photo tab in the 3D explorer open a dedicated view. Users can upload/drop JPG, PNG, or WebP files (8 MB cap), mark the package with a frame, adjust its position/size using keyboard/range controls, add notes, and explicitly confirm a reference. An original illustrated example supports an offline demo. The reference overlay animation is labelled a preview, not a camera match. Loading confirmation is still required separately.

Photos are resized/re-encoded locally to remove source metadata and kept only in React memory, scoped to the active return. Closing the dialog preserves them; refresh, sign-out, or changing returns clears them. Neither photos nor location notes are added to D1 or browser storage.

`POST /api/pickup-review` optionally sends one photo plus notes to Claude after the user chooses "Send photo to Claude." It proposes a validated image-coordinate box, never geographic coordinates or flight instructions. Multiple/no parcels force manual selection; all results need human confirmation. Only an API usage event is stored. Files: `components/pickup-guide.tsx`, `lib/pickup-guide.ts`, `app/api/pickup-review/route.ts`, `public/sample-pickup.svg`. Real upload was not automated in browser checks; no physical pickup was triggered.

## Built-in demo account (October 23)

Your account → Try demo account opens **Alex Demo**, an explicitly simulated browser-specific profile. No provider login is required. Since October 24 a new demo account starts empty; nothing is booked until Request. Exit demo account restores the prior identity; re-entering retains Alex's practice history. The mode is visible in the header, and no shared Supabase user or static password is used. Implementation: `lib/demo-account.ts`, `/api/account/demo`, `lib/server.ts`, account API/panel, header indicator, `scripts/demo-account-smoke.ts`.

## Cloudflare, live drone link and ride-style UI (October 24, 2026, Claude)

- **Hosting.** Public Cloudflare Worker `aero-returns` with its own D1 database: https://aero-returns.kv15.workers.dev. `npm run deploy` builds, migrates and deploys (`docs/DEPLOY.md`). Hosted secrets from the Sites prototype (Google Maps demo key, Supabase) were not copied; those features fall back cleanly until they are set as Worker secrets.
- **Security fix.** `lib/session.ts` no longer trusts `oai-authenticated-user-id` unless `AERO_TRUST_SITES_IDENTITY=true`. On a public URL that header let anyone read another owner's returns.
- **Maps.** CARTO raster tiles now require a key and rendered "API KEY REQUIRED"; MapLibre uses OpenFreeMap's keyless Positron vector style.
- **Drone link.** `docs/DRONE_LINK.md`: signed SMS-sized text protocol (`lib/drone-protocol.ts`, Python mirror in `bridge/`), HTTPS polling for 4G data and Twilio SMS for SMS-only SIMs, owner-scoped `/fleet` console, D1 tables in `drizzle/0002_drone_link.sql`, pure mission rules in `lib/drone-mission.ts`, storage/transports in `lib/drone-server.ts`. Live returns reuse the customer UI through `snapshot()`.
- **UI.** Full-bleed map, floating controls, one trip sheet (left on desktop, bottom sheet on mobile) in `app/ride.css` + `components/aero-app.tsx`. Modals are centered again (Tailwind's reset had zeroed `<dialog>` margins).
- **Verification.** Typecheck, production build, 41 TypeScript tests, and `scripts/drone-link-smoke.ts` against the deployed Worker (register → arm → dispatch → full mission through acks → forged telemetry rejected). No physical drone has flown; the hardware teammate should run the bridge against PX4/ArduPilot SITL first.

## Hardening pass (October 24, 2026, later)

- Two multi-agent reviews (drone link/UI and a per-feature bug hunt with live API probing) confirmed ~100 issues; all are fixed except the optional items noted in commit history. Highlights: SMS only to numbers verified by a signed inbound text, unique SMS numbers, send-once with capped resends and per-minute limits; customer cancel decided by phase (LAND during takeoff/landing, RTL en route, nothing once landed) and superseding queued commands; ABORT/LAND/RTL queued directly; mission step + command committed atomically; freshness gates use only fresh telemetry; idle-drone D1 writes throttled; dispatch requires a landed/idle state. `drizzle/0003_sms_hardening.sql` and `0004_integration_kind_index.sql` come from this pass.
- Bridge: 60 tests; RTL-from-ground gated like takeoff, pilot takeover respected by the link-loss failsafe, undelivered acks persisted, modem network time for SMS-only Pis, ArduPilot lost-takeoff-ack handling, takeoff refused if DO_SET_HOME fails, PX4 takeoff reference fixed, IRA-only modem charset.
- Claude photo checks use the official SDK (`lib/claude.ts`): structured outputs, effort, refusal fallback, default `claude-opus-5-5`.
- Key-free 3D neighborhood view (OpenFreeMap Liberty 3D buildings) when no Google key is configured.
- Verification: typecheck, 48 TS tests, 60 bridge tests, Actor tests; `smoke`, `location-account-smoke`, `demo-account-smoke`, `drone-link-smoke`, `bridge-e2e` and targeted safety checks pass against a local production build and against the Worker. The smoke scripts take the base URL as their first argument.

## Track focus: Visa, Anthropic, Microsoft, hardware (October 24, 2026, evening)

Four tracks, one return: a person books from home (Visa), Claude checks it (Anthropic), the merchant receives it (Microsoft "built for the real world"), and the drone link flies it (hardware). `/demo` is the judge room: each track's criteria, a 60-second path, live counts from `/api/evidence` and honest gaps.

- **Claude return check** (`lib/return-agent.ts`, `lib/return-agent-shared.ts`, `POST /api/return-agent`, `components/return-check.tsx` in booking). A manual tool-use loop: Claude calls `check_drone_eligibility` (the same `recommend()` the booking uses) and, when Apify is configured, `lookup_product_specs`, then answers in a fixed JSON schema. `gateDecision` makes the verdict agree with the drone limits and sends confidence under 0.85, a mismatch, or damaged/unclear condition to a person. A booking attaches the check only from the owner's own stored `agent` event (`lib/server.ts`), never from browser input.
- **Person hold.** A `needs_person` return stays on the ground, simulated or live, until someone approves or declines it on `/merchant` (`heldForPerson` in `lib/simulation.ts`, PATCH actions `approve`/`decline`, and a Fleet dispatch blocker in `lib/drone-mission.ts`). Declining cancels the pickup; resetting a declined return puts it back on hold. In the demo the reviewer is the same signed-in owner; a retailer would use its own staff account. Extended to `not_drone_eligible` below.
- **Merchant desk** (`/merchant`, `lib/merchant.ts`, `GET /api/merchant`). Stages, Claude grade and suggested disposition per return, a needs-a-person queue with approve/decline, and labelled demo estimates (store trips avoided, time saved). Simulated and drone-link rows are labelled separately; a drone-link row may still be a simulator.
- **Evidence** (`lib/evidence.ts`, `GET /api/evidence`): aggregate counts only, across all accounts, including team testing and smoke runs. The counts can't tell SITL or the bridge's simulated vehicle from real hardware.
- **Verification:** typecheck, 109 TS tests (including `tests/person-hold.test.ts`), 60 bridge tests; `smoke`, `location-account-smoke`, `demo-account-smoke` and `drone-link-smoke` passed against the Worker. `ANTHROPIC_API_KEY` has since been set as a Worker secret.

## Request a drone, home-screen app, pickup at the pin (October 24, 2026, night)

- **Request-a-drone home screen** (`components/aero-app.tsx`, `lib/request-flow.ts`). Opening AERO books nothing: it reopens the newest active return (or the one a tracking link names), otherwise the home sheet with the pickup, **Request a drone**, the nearest free drone and its ETA, a sample return code, Amazon import, nearby drop-offs and recent returns. The first-entry sample return is gone, and a new demo account starts empty.
- **Nearest-drone matching.** Five simulated drones with illustrative Berkeley bases (`SIM_FLEET`). Booking's *Choose a ride* step quotes each tier's nearest free drone (`rideOptions` in `components/booking.tsx`). After Request, "Finding your nearest drone…" shows for at least 1.8 s and until the server answers, then the matched drone for 2.5 s. The server assigns the drone (`assignDrone`: nearest not busy on this owner's other active simulated returns); the record keeps it, and the flight starts from its base. Pre-fleet records fly from `DISPATCH`.
- **Person hold extended.** A `not_drone_eligible` check now holds too, but only when `bookedReview` stamped it (`hold: true`) at booking, so returns booked before this rule keep the state they reached. The customer sees "A person is checking your return" with the reason, also in read-aloud. The merchant desk shows Claude's questions, read from the owner's own stored agent events when the record has none (`withQuestions` in `lib/merchant.ts`). Fleet lists held returns apart from dispatchable ones (`dispatchChoices` in `lib/fleet-view.ts`).
- **Live pickup at the customer's pin** (`pickupFor`, `PIN_MARGIN_M` in `lib/drone-mission.ts`). A live mission lands at the booked map pin when it is at least 15 m inside the geofence, otherwise at the operator's pickup pad, which stays required. `LiveFlight.pickupSource` records which; the Fleet map shows the pin before dispatch, and the checklist asks the operator to confirm that every spot inside the geofence is a safe landing spot. Superseded before it reached the Worker: the afternoon section below replaces this with opt-in pin zones and a hover gate.
- **Home-screen app.** Manifest, 192/512/maskable icons, apple-touch-icon, 13 portrait iPhone splash screens, `viewport-fit=cover` with safe-area insets (`app/pwa.css`), white `theme-color` (AERO's dark theme is opt-in), no service worker. Install steps for iPhone and Android are in the README. `npm run pwa:assets` regenerates the PNGs. Covered by `tests/pwa.test.ts` (three of its tests need Node 22.15+ and skip on older Node).
- **Plain links.** `next/link` is gone: with vinext 1.0.0-beta.5 a `<Link>` click throws and the page does not navigate. Internal links are `<a href>`; `tests/plain-links.test.ts` guards it.
- **APIs.** Every route answers unsupported methods with a JSON 405 and `Allow` (OPTIONS 204), an invalid demo cookie gets an explained 401 and is cleared (`lib/http.ts`), and validation errors read as one plain message.
- **Fleet and maps.** Fleet's "Last known" telemetry age keeps counting while the console is offline (`serverNow`). MapLibre markers have accessible names; live flights never say "simulation".
- **Docs.** Sites-era statements corrected for the public Worker, DEPLOY lists every Claude feature the key enables, local setup applies all five migrations, and CI runs the bridge tests. CI does not lint: `eslint .` still reports three errors (`components/accessibility.tsx`, `components/amazon-connection.tsx`, `components/google-mini-map.tsx`).
- **Verification:** typecheck, 156 TS tests, 60 bridge tests, 8 Actor tests. After `npm run deploy`, `/manifest.webmanifest` should answer 200; then add AERO to a real iPhone and Android home screen.
- **Still open:** the judge room's "Booking · Claude return check" chip opens `/`, not the booking dialog. No physical flight has happened.

## Pin zones, hover gate and audit fixes (October 24, 2026, afternoon)

**Not deployed; checked on a local dev server only.** Read-only checks of the Worker that afternoon found no `maxPinRadius` in `/api/fleet` limits and a Fleet bundle that says "home → pickup pad → drop pad → home": production still flies every pickup to the pad, and the night section's pin rule never reached it. `npm run deploy` needs no new migration; afterwards `/api/fleet` should list `maxPinRadius`.

- **Pin redesign** (replaces "a pin 15 m inside the geofence becomes the pickup"). Pins are opt-in per drone: `pinRadius`, 0–100 m around the surveyed pickup pad, default 0 = off, set in Fleet's "Land at customer pins within … m of the pickup pad" field (saving disarms the drone). A pin is used only inside that zone and at least 15 m inside the geofence (`pickupFor` also says why it fell back to the pad). At a pin the drone hovers (`HOVER_PICKUP`); the operator lands it with **Landing area clear · land**, allowed only while `atPin` puts it airborne within 10 m, or sends it to the pad with **Use the pickup pad instead**. The customer sees "Your drone is overhead" (`HOVER_COPY`). Dispatch carries the previewed pickup and gets a 409 when it changed (`pickupMismatch`). Fleet's bridge lines, the simulator one included, carry the drone's `--fence-center`, `--fence-radius`, `--max-alt` and `--cruise-alt`, and the bridge's fence must equal Fleet's. No bridge change. Tests: `tests/live-pickup.test.ts`; `scripts/bridge-e2e.ts` now flies a pad pass and a pin pass through the hover gate.
- **Review fixes on the pin flow.** A customer cancel en route or at the pin sends ABORT, which the bridge flies home in the air but never runs as a takeoff from the ground, so a drone that just touched down at the customer's spot stays there. Fleet tells apart a drone over the pin, landed at it (**It landed at the pin · continue**), on the ground or airborne elsewhere, and without a fresh report. Dispatch from the ground more than 20 m from home asks "Is the area around the drone clear of people?" first.
- **Drone-link fixes DL-1–DL-8.** The return record stays delivered after the unload (`unloadedAt`, `handedOff`); ground changes that matter to dispatch are stored at once (`groundChange`); an ended flight keeps the drone's last report, or its first ground report after an in-air end (`finalTelemetry`, `settledFinal`); Fleet's Add button fits at 375 px; a key rotation retires commands queued under the old key and asks first; the simulator line carries the drone's limits; the map attribution clears the Home/Pickup/Drop bar.
- **Customer fixes C1–C11 (no C9).** Dark mode and Higher contrast fixed for muted text, the wizard's Start over and step numbers and the pickup guide; dialog text at least 12–13 px and 4.5:1; toasts below the header and telemetry row, so phones keep "Simulated" visible; a Simulated/Demo chip on phones; phone targets at least 32 px; live history rows read "Drop pad · Live flight"; a person's approval or decline shows on package details and the receipt; wizard steps open at the top; plainer wording. Tests: `tests/customer-copy.test.ts`, `tests/customer-overlays.test.ts`.
- **Docs and judge room.** `docs/ACCOUNTS.md` no longer treats Sites identities as Worker owners; README, AGENTS, `docs/DRONE_LINK.md`, `docs/DEPLOY.md` and `bridge/README.md` describe pin zones, the hover gate and the matching bridge fence. The judge room's "Booking · Claude return check" chip now links to `/?new=1`, which opens booking (in code; not rechecked in a browser).
- **Verification (local):** typecheck, 181/181 TypeScript tests, 60 bridge tests, eslint on changed files; `drone-link-smoke` passed and `bridge-e2e` exited 0 (pad and pin passes) against the local dev server; browser checks at 375 px and desktop of Fleet's hover states and area-clear prompt and of the customer toasts and contrast. The Worker got only read-only GETs.
- **Closed by the lead after the review round:** the tracking page ignores faults and a pilot end after the handoff (`handedOff` in `components/aero-app.tsx`), says "Your drone is overhead" only while a fresh report puts it in the air, shows "—" and "No report" for flights with no telemetry, and the cancel race is gone (ABORT instead of RTL/HOLD).
- **Still open:** Not exercised: the pin flow on a real autopilot (SITL or hardware) and over SMS, Fleet in emulated dark mode (rendered light in one check), the toast fallback without CSS `anchor()`, real iOS safe areas, toasts inside dialogs. The old `.ux~.toast` selectors in `app/ride.css` match nothing. No physical flight has happened.
