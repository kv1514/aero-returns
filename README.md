# AERO — Returns, without the trip

A map-first drone returns app for the Cal Hacks 13.0 demo. Returns run on a deterministic **simulation** by default, and an owner-registered **PX4 or ArduPilot drone** can fly a real return through the signed drone link ([`docs/DRONE_LINK.md`](docs/DRONE_LINK.md)). It never creates a carrier return, charges a payment method, or approves a retailer refund. No physical flight has happened yet.

**Live app:** https://aero-returns.kv15.workers.dev (public Cloudflare Worker) · **Fleet console:** `/fleet` · **Merchant desk:** `/merchant` · **Judge room:** `/demo`

Source: [kv1514/aero-returns](https://github.com/kv1514/aero-returns). GitHub Actions runs the typecheck, TypeScript tests, bridge tests, Actor tests, and a build on changes. Pushes do not deploy; see [`docs/DEPLOY.md`](docs/DEPLOY.md).

Continuing with Claude? Start with [`CLAUDE.md`](CLAUDE.md), [`AGENTS.md`](AGENTS.md) and [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Install it on your phone

AERO is an installable home-screen app: it opens full screen with its own icon and a white AERO splash screen.

- **iPhone (Safari):** open https://aero-returns.kv15.workers.dev, tap **Share** (on iOS 26, tap **•••** first), then **Add to Home Screen** (scroll the share sheet if it isn't listed). Keep the name AERO, leave **Open as Web App** on if iOS shows it, and tap **Add**.
- **Android (Chrome):** open the same URL, tap **⋮**, then **Add to Home screen** or **Install app**, and confirm. Chrome draws the splash from the manifest. Long-press the icon for shortcuts to the merchant desk, Fleet console and judge room.

There is no service worker and no offline mode: tracking and telemetry always come from the network. On iPhone the home-screen app can keep its own cookies, separate from Safari, so returns you booked as a guest in Safari may not show there; book from the installed app.

The pieces: `public/manifest.webmanifest`, the icons in `public/` and `public/icons/`, 13 portrait iPhone splash images in `public/splash/`, the Apple tags and `viewport-fit=cover` in `app/layout.tsx`, and the safe-area insets in `app/pwa.css`. Regenerate the PNGs with `npm run pwa:assets` (`scripts/generate-pwa-assets.mjs`; keep its splash list in step with `SPLASH` in `app/layout.tsx`). `tests/pwa.test.ts` checks the manifest, every icon and splash size, the head tags, and that no service worker ships.

## Request a drone

1. **Home screen.** Nothing is booked when you open AERO. It reopens your newest active return, or shows the home sheet: your pickup, **Request a drone**, the nearest free simulated drone and its ETA, a sample return code, Amazon import, nearby drop-offs and your recent returns.
2. **Booking** has three steps: *Your package* (pickup, return QR or label, weight and size; optional Claude return check), *Choose a ride* (AERO Standard up to 2.5 kg and 45 cm per side, AERO Priority up to 5 kg and 60 cm, each with its nearest free drone and ETA, or the reason the package can't fly it) and *Review & request*.
3. **Matching.** After **Request**, "Finding your nearest drone…" stays up until the server has booked the return (at least 1.8 s), then the matched drone shows for 2.5 s and tracking opens.

The simulated fleet is five drones with illustrative bases around Berkeley (`SIM_FLEET` in `lib/simulation.ts`; not real pads or vehicles). `nearestDrones` sorts them by straight-line distance from the pickup and quotes the ETA tracking will use (10 s pre-flight plus the inbound route at 12 m/s Standard or 15 m/s Priority). The server picks the drone, never the browser: `assignDrone` takes the nearest one not busy on another of this owner's active simulated returns, or the nearest overall when all are busy. The record keeps its drone, and the flight starts from that drone's base. Returns booked before the fleet existed fly from the old dispatch point.

## Try the built-in demo account

Open **Your account → Try demo account**. Alex Demo opens immediately without a Google/Amazon account or password. A new demo account starts empty: request a drone, then use **Demo controls** to practice the pickup-to-receipt journey. Confirm package loading before departure.

Alex is a simulated profile with separate, browser-specific practice history. **Exit demo account** restores the previous account. Re-entering resumes Alex's history while the browser's 30-day demo cookie remains available. It never signs everyone into a shared Supabase user.

## Run locally

Node 22.13+ is required. Node 24 is recommended.

```sh
npm ci
npm run db:generate   # only when changing db/schema.ts; the migrations are committed
npm run build
# Fresh local database: apply every migration once, in order (0000–0004).
for f in drizzle/000*.sql; do node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file "$f"; done
npm run dev
```

On an existing local database, apply only the files it does not have yet; rerunning one fails on tables that already exist. `0002_drone_link.sql` adds the drone tables, `0003_sms_hardening.sql` the SMS columns the drone link reads (`drones.phone_verified`, `drone_commands.send_count`), and `0004_integration_kind_index.sql` an index for the hourly provider usage cap. Local development prints its URL, normally `http://127.0.0.1:5173`. Production runs on Cloudflare Workers + D1, and `npm run deploy` applies new migrations itself. No API keys are needed for the core demo.

## What works

- A full-screen MapLibre map using OpenFreeMap vector tiles (OpenStreetMap data), with attribution and no map token. An animated schematic route keeps the demo usable if map initialization fails; geographic tiles need a network connection. Markers have accessible names, and live flights are never labelled as a simulation.
- A deterministic, elapsed-time flight model with geographic distance, heading, continuous marker interpolation, altitude, speed, battery, ETA, and traveled/remaining route lines.
- Pause, resume, 1×/5×/10× speed, next milestone, interruption/recovery, and reset controls. A normal demo takes about 3–5 minutes plus the user's pickup confirmation.
- Booking with three Berkeley pickup choices, one-shot geolocation within the demo area, package details, QR image decoding, Standard/Priority capacity checks, nearest-drone matching and automatic compatible-hub ranking.
- QR images are decoded on the device. `public/sample-return-qr.png` contains a structured AERO demo return. Opaque real retailer codes never imply retailer authorization. Label selection is an explicitly unverified local attachment; files are not uploaded.
- The drone waits indefinitely at pickup. **No control can skip explicit package loading confirmation.** A simulated hub handoff creates a downloadable receipt; it does not promise a refund.
- A **person hold** (below) keeps a return Claude flagged on the ground until someone approves or declines it on `/merchant`.
- Session-protected `/track/[id]`, server persistence, history, multi-tab polling/BroadcastChannel sync, atomic version checks, and a saved event journal. Unsupported HTTP methods get a JSON 405 with an `Allow` header (`lib/http.ts`).
- Accessibility settings: text scale, Atkinson Hyperlegible, light/dark/system, higher contrast, reduced decorative motion, keyboard focus, dialog focus trapping, and browser read-aloud. These are features, not a claim of completed WCAG conformance auditing.

## Sponsor integrations

### Anthropic

`ANTHROPIC_API_KEY` (a Worker secret) turns on three Claude features through the official `@anthropic-ai/sdk` (`lib/claude.ts`, `lib/return-agent.ts`). Each sends data only after the user's click, and AERO never stores the photos.

- **Claude return check** in booking (`POST /api/return-agent`): a tool-use loop where Claude calls AERO's own drone-limit rules (`check_drone_eligibility`) and, when Apify is configured, a product-spec lookup, then answers in a fixed schema (verdict, condition, checks, questions, merchant disposition). `gateDecision` keeps the verdict consistent with the limits and sends confidence under 0.85, a mismatch, or damaged/unclear condition to a person. A booking attaches the check only from the owner's own stored event, never from browser input.
- **Assistant photo review** (`POST /api/return-review`): 1–3 resized photos and the product description, structured outputs, low-confidence results routed to human review.
- **Pickup-photo detection** (`POST /api/pickup-review`, see Visual pickup reference).

Requests use structured outputs, explicit effort and a server-side refusal fallback. The default model is `claude-opus-5-5`; override it with `ANTHROPIC_MODEL`. Without the key, each feature shows a setup state (the booking check names `ANTHROPIC_API_KEY`) and manual booking keeps working. The sample-review button is labelled and does not call an AI provider.

**Person hold.** A return whose check says `needs_person`, or `not_drone_eligible` (Claude's measurements can rule out a package the entered ones allow), stays on the ground, simulated or live, until someone approves or declines it on the merchant desk (`heldForPerson` in `lib/simulation.ts`). The server stamps the hold when it attaches the check (`bookedReview`), so not-eligible checks stored before this rule never hold a return that already flew. Approving lets it fly; declining cancels the pickup; resetting a declined return puts it back on hold. Fleet cannot dispatch a held return. In the demo the reviewer is the same signed-in owner; a retailer would use its own staff account.

### Apify

`actors/product-specs/` contains a custom stdlib Python Actor. It retrieves public product pages from a small retailer allowlist, extracts explicitly published JSON-LD measurements, normalizes supported units, and returns `null` for unknown fields. No mocked product specs are returned from the live endpoint. Blocked pages and missing data lead to manual entry.

Deploy the folder as an Actor in your Apify account, build it, and set `APIFY_ACTOR_ID` to its ID or `username~actor-name`. `POST /api/product-lookup` invokes it live using the [synchronous dataset endpoint](https://docs.apify.com/api/v2/actor-run-sync-get-dataset-items-post), with a 60-second Actor timeout and a $0.10 run cap. Source facts may describe an unpackaged item: the UI asks the user to review packed dimensions and weight. Apify is not configured on the Worker.

### Deliberate scope

Return records use D1; optional social sign-in uses Supabase Auth. Convex is not used. It uses browser speech, not Cartesia or ElevenLabs. Nessie, Fetch/ASI:One and x402 are **not implemented**. Physical flight goes only through the drone link and Fleet console described below, never from the simulator. Merely referencing a sponsor in the research page is not a working integration. The broader household-drone plan remains a roadmap.

## Environment variables

Set local secrets in ignored `.dev.vars` (example below). Set hosted values as Worker secrets (`npx wrangler secret put NAME --config dist/server/wrangler.json`; full list in [`docs/DEPLOY.md`](docs/DEPLOY.md)). Never put credentials in source, public files, or `NEXT_PUBLIC_*` variables.

```dotenv
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-5-5
APIFY_TOKEN=
APIFY_ACTOR_ID=
```

Only the D1 binding `DB` is required (`.openai/hosting.json` for local builds, `deploy/cloudflare.json` for the Worker). Missing sponsor credentials return explicit setup errors and leave manual booking available. The public Worker is open to anyone with the link, and every record is scoped to its owner: the demo account, a server-verified Supabase account, or a random HttpOnly guest cookie. Tracking IDs alone do not authorize access.

## Architecture

- `lib/simulation.ts`: pure flight model, simulated fleet and nearest-drone matching, route calculations, state transitions, person hold, hub eligibility, pricing estimates, event generation.
- `lib/request-flow.ts`: what the app opens on, the matching timings, and the booking schema the API accepts.
- `lib/server.ts`: validated booking/control HTTP operations, drone assignment, owner scoping, version compare-and-set persistence.
- `db/schema.ts` and `drizzle/0000`–`0004`: D1 records, drone link and integration audit schema.
- `components/aero-app.tsx`, `components/booking.tsx`: the consumer journey (home screen, booking, matching, tracking).
- `components/flight-map.tsx`, `components/maplibre-flight-map.tsx`: Google/MapLibre display with frame-based motion; camera/zoom/follow controls.
- `components/return-check.tsx`, `components/return-assistant.tsx`, `lib/integration-server.ts`: Claude and Apify features, setup states, bounded usage, audit results.
- `lib/merchant.ts`, `components/merchant-console.tsx`: the merchant desk and its needs-a-person queue.
- `lib/drone-protocol.ts`, `lib/drone-mission.ts`, `lib/drone-server.ts`, `lib/fleet-view.ts`, `components/fleet-console.tsx`, `bridge/`: the drone link.
- `app/layout.tsx`, `app/pwa.css`, `public/manifest.webmanifest`: the home-screen app.
- `data/hackathon-tracks.json`, `components/demo-room.tsx`: researched prize cards and the judge room.

Internal links are plain `<a href>`, never `next/link`: with vinext 1.0.0-beta.5 a `<Link>` click throws and the page does not navigate (`tests/plain-links.test.ts`).

The simulator does not assume a permanent server loop. The server stores its clock anchor, elapsed virtual time, rate, payload, drone, selected hub, and loading state. Any request can derive current telemetry and persist newly crossed milestones. A client interpolates that same deterministic record and polls every two seconds. Multiple tabs agree after reconnection. Polling is not a claim of Supabase/Convex realtime use.

## Booking recovery

Unfinished package details and the current booking step are recoverable in the same tab for 12 hours after the last edit. Closing a dialog or reloading for Maps setup does not lose them. A completed booking clears its draft; Start over resets it, and Amazon/assistant imports begin a fresh draft. Images and account tokens are never included. Review consent is always unchecked after recovery. Session-storage restrictions leave in-memory editing available.

## Verification

```sh
npm run typecheck
npm test                              # TypeScript tests
python3 -I bridge/test_bridge.py      # bridge tests
python3 tests/test_product_actor.py   # Actor tests
# With a local server running (each script takes the base URL first):
node_modules/.bin/tsx scripts/smoke.ts http://127.0.0.1:5173
node_modules/.bin/tsx scripts/location-account-smoke.ts http://127.0.0.1:5173
node_modules/.bin/tsx scripts/demo-account-smoke.ts http://127.0.0.1:5173
```

Tests cover distance, route interpolation, nearest-drone matching, compatibility, explicit pickup gating, the person hold, live pickup at the pin (pin zone, hover gate, dispatch matching the preview), the home-screen app files, complete handoff, pause/resume/speed changes, persistence, interruption, cancellation, review uncertainty, URL allowlisting, and Actor extraction. The HTTP smoke test creates a demo return and checks session isolation, the full journey, and persistence. Tests never call Anthropic or Apify. Lint the files you change with `node_modules/.bin/eslint <files>`; `npm run lint` still reports three older errors.

## Live drone (PX4 / ArduPilot)

`/fleet` is the operator console. Register a drone, run the Python bridge on its companion computer ([`bridge/README.md`](bridge/README.md)) over 4G data or SMS, set the home point, geofence, pickup pad and drop pad on the map, complete the pre-flight checklist, and dispatch one of your returns. The drone flies home → pickup → drop pad → home one acknowledged step at a time. The pickup is the operator's pickup pad, which stays required, unless the drone has a pin zone: an opt-in radius of 0–100 m around the surveyed pickup pad (0, the default, means always the pad). A customer's booked map pin inside that zone and at least 15 m inside the geofence becomes the pickup (`pickupFor` in `lib/drone-mission.ts`). The drone then hovers over the pin until the operator taps **Landing area clear · land**, or sends it to the pickup pad instead. Fleet shows which pickup a return will use before dispatch, and dispatch is refused (409) if that changed in the meantime. Run the bridge with Fleet's own home, geofence radius and altitude limits; Fleet's bridge command lines fill them in. Pin zones and the hover gate have been checked only on a local dev server so far; the deployed Worker predates them and always uses the pickup pad until the next deploy ([`docs/HANDOFF.md`](docs/HANDOFF.md)).

The customer confirms loading, and the operator launches every takeoff and clears every landing at a pin. Commands are HMAC-signed, expire, and are checked against the geofence and a 120 m cap on both the server and the bridge. A held return cannot be dispatched. Abort is always available, and the autopilot's own failsafes stay in charge if the link drops.

Test with the bridge's `--vehicle fake` or PX4/ArduPilot SITL before flying. Outdoor flights must follow local rules (Part 107 or TRUST in the US, LAANC in controlled airspace, visual line of sight). A completed flight is not retailer acceptance or a refund.

## Cal Hacks submission

The research snapshot is dated October 23, 2026. Read `/demo` and `data/hackathon-tracks.json` for all 58 researched prize cards. Confirm unresolved prize conflicts and entry rules directly with organizers. Deadline listed on [Devpost](https://cal-hacks-13-0.devpost.com/): October 25 at 9 a.m. Pacific. No interviews, Figma work, Notability history, sponsor API calls, or physical flights should be claimed unless the team actually completes and records them.

## Google Maps, location, and nearby drop-offs

Google Maps is not configured on the Worker, so the app uses MapLibre and OpenFreeMap. Open the **Maps** tile to paste a website-restricted Google Maps browser API key; it is kept in this tab's session storage and applied on reload. The optional Map ID defaults to Google's `DEMO_MAP_ID`. For all visitors, set `GOOGLE_MAPS_BROWSER_KEY` and `GOOGLE_MAPS_MAP_ID` as Worker secrets and redeploy. A browser key is intentionally delivered to the client; never put a general-purpose server credential in this field.

The earlier ChatGPT Sites prototype used a [free Maps Demo Key](https://developers.google.com/maps/documentation/javascript/demo-key) with no billing account. Google caps its daily usage and pauses requests at the limit without charges; it is only for testing and evaluation, and its custom referrer restrictions sit behind an upgrade prompt. Do not upgrade or attach billing automatically.

For a standard paid project, enable **Maps JavaScript API**, **Geocoding API v4**, and **Places API (New)**. Restrict its browser key to the required APIs and website referrers `https://aero-returns.kv15.workers.dev/*` and optionally `http://127.0.0.1:5173/*`. Set quotas and billing alerts; budget alerts alone do not cap spending. No Google key is bundled in source. Setup: [Google key guidance](https://developers.google.com/maps/api-security-best-practices). Address and reverse lookup use the v4 HTTP API because the legacy JavaScript Geocoder is unavailable with the demo key.

With a key, tracking uses Google Maps and advanced markers. Without a key, or after a loading/authorization failure, the MapLibre map remains available. Booking supports one-time browser geolocation, accuracy feedback, Google address search, and selecting a pickup pin. Location permission is requested only after a button click. Coordinates are sent to Google only when Google features are used. A booking draft, including the pickup, is kept in this tab's session storage for recovery; the confirmed pickup is saved on the server only with a booking; there is no background location watch or tracking of other people. Bookings remain inside the Berkeley demo area, and no low-accuracy device fix is accepted without manual refinement.

**Nearby drop-offs** searches the current pickup, the user's opt-in device location, or an entered address/city. Categories are UPS drop-offs, other shipping drop-offs, and warehouses. Google's [Text Search (New)](https://developers.google.com/maps/documentation/javascript/place-search) returns up to 20 candidates, filtered to the selected 5/10/25 km radius and sorted by straight-line distance. A listing is not evidence of QR acceptance, public access, or drone participation. Warehouses are explicitly marked as potentially private. Search locations and results are memory-only, never stored as participating hubs. No seeded listings are substituted for a failed API call.

Google Maps rendering, address lookup, UPS and warehouse search were verified on the Sites prototype with the demo key, not on the Worker. Passing tests or finding a listing does not establish retailer participation.

## Amazon account connection

**Amazon** opens a profile-linking and return-import flow. Standard [Login with Amazon profile scopes](https://developer.amazon.com/docs/login-with-amazon/customer-profile.html) do not authorize access to personal purchases or return creation. AERO does not scrape authenticated Amazon pages or collect Amazon passwords. Users start/approve the return on Amazon's Your Orders page, then import its reference and QR/label method into booking. The QR upload reads locally; opaque retailer codes still require manual review.

To enable real profile linking, register a Login with Amazon Security Profile and set these Worker secrets:

- `AMAZON_CLIENT_ID`
- `AMAZON_CLIENT_SECRET` (server-only)
- `AMAZON_REDIRECT_URI=https://aero-returns.kv15.workers.dev/api/amazon/callback` (it must be on the same origin as the app)

Add that exact callback to the Amazon app's allowed return URLs. Local testing needs its own registered callback, `http://127.0.0.1:5173/api/amazon/callback`, and matching local configuration. Use Amazon's [authorization code grant instructions](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html).

OAuth uses PKCE S256, a one-time ten-minute state tied to the AERO owner and an HttpOnly SameSite cookie, strict request origins, and server-side token exchange. The linked name, email, and Amazon account identifier are stored privately; access and refresh tokens are discarded after profile retrieval. Disconnect removes AERO's profile association and outstanding link attempts. It does not revoke consent at Amazon. Missing credentials disable linking clearly while manual return import stays usable. Amazon sign-in remains unverified without registered app credentials.

## 3D, Street View, and social accounts

The **3D & Street View** tile opens a 3D explorer with pickup, current drone position, and hub (or live drop pad) camera targets, plus an optional orbit. With a Google key it uses Google's photorealistic 3D tiles; without one, or if they fail, it uses free OpenFreeMap Liberty tiles with OpenStreetMap 3D buildings. Google Earth and Street View open at the selected coordinates in separate tabs. Street View uses Google's key-free Maps URLs, so no paid panorama API is enabled. Imagery is recorded and is not live drone footage.

**Your account** has Supabase-backed Google and Amazon sign-in. Supabase is not configured on the Worker, so those buttons stay disabled there and no live social login is claimed; the demo account and guest sessions work. See [`docs/ACCOUNTS.md`](docs/ACCOUNTS.md) for callbacks, the Amazon userinfo adapter, and ownership/security behavior.

## Visual pickup reference

Choose the **Pickup photo** tile on the trip sheet, or the **Pickup photo** tab in the 3D & Street View explorer. Upload a fresh photo, mark your package, add placement notes, and confirm the reference. The photo stays in page memory until refresh, sign-out, or a return switch. An illustrated example and reference-overlay preview work without AI credentials. Street View remains separate from the uploaded image.

Optional **Send photo to Claude** calls `/api/pickup-review`. It sends the resized photo and notes only after that click, returns an approximate package frame for human review, and stores only usage evidence. See [Anthropic vision documentation](https://platform.claude.com/docs/en/build-with-claude/vision). This is preparation for a future camera integration; no drone recognizes, collects, or flies toward a parcel from this reference. Explicit loading confirmation remains mandatory.
