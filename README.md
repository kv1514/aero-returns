# AERO — Returns, without the trip

A map-first, end-to-end **simulated** drone returns app for the Cal Hacks 13.0 demo. The app lives separately from the parent arbitrage engine. It never sends physical flight commands, creates a carrier return, charges a payment method, or approves a retailer refund.

Source: [kv1514/aero-returns](https://github.com/kv1514/aero-returns) (private). GitHub Actions runs typechecks, unit tests, Actor tests, and a build on changes.

Continuing with Claude? Start with [`CLAUDE.md`](CLAUDE.md) and [`docs/HANDOFF.md`](docs/HANDOFF.md) for current status, setup, verification, and next steps.

## Run locally

Node 22.13+ is required. Node 24 is recommended.

```sh
npm ci
npm run db:generate   # only when changing db/schema.ts; initial migration is committed
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_uneven_violations.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_many_chimera.sql
npm run dev
```

Local development prints its URL, normally `http://127.0.0.1:5173`. Hosted Sites provisions a separate D1 database and applies migrations during publication. No API keys are needed for the core demo. The `/demo` route contains the presentation script, actual integration status, checklist, and all 58 researched prize cards.

## What works

- A full-screen MapLibre map using CARTO Positron raster tiles and OpenStreetMap data, with attribution. No map token is required. An animated schematic route keeps the demo usable if map initialization fails; geographic tiles require a network connection.
- A deterministic, elapsed-time flight model with geographic distance, heading, continuous marker interpolation, altitude, speed, battery, ETA, and traveled/remaining route lines.
- Pause, resume, 1×/5×/10× speed, next milestone, interruption/recovery, and reset controls. A normal demo takes about 3–5 minutes plus the user's pickup confirmation.
- Booking with three Berkeley pickup choices, geolocation within the demo area, package details, QR image decoding, standard/priority capacity checks, and automatic compatible-facility ranking.
- Image-based QR decoding occurs on the device. The included `public/sample-return-qr.png` contains a structured AERO demo return. Opaque real retailer codes never imply retailer authorization. Label selection is an explicitly unverified local attachment; files are not uploaded.
- The drone waits indefinitely at pickup. **No control can skip explicit package loading confirmation.** A simulated facility handoff creates a downloadable receipt; it does not promise a refund.
- Session-protected `/track/[id]`, server persistence, history, multi-tab polling/BroadcastChannel sync, atomic version checks, and a saved event journal.
- Accessibility settings: text scale, Atkinson Hyperlegible, light/dark/system, higher contrast, reduced decorative motion, keyboard focus, dialog focus trapping, and browser read-aloud. These are features, not a claim of completed WCAG conformance auditing.

## Sponsor integrations

### Anthropic

`POST /api/return-review` calls the official Claude Messages API with 1–3 resized photos and the product description. It validates the response, routes low-confidence or inconsistent evidence to human review, and saves the advisory result. AERO does not store the photos. A user explicitly starts the transmission, and the UI describes the third-party processing.

The default model is `claude-sonnet-5-5`, verified in the current [official model catalog](https://platform.claude.com/docs/en/models/overview). Override with `ANTHROPIC_MODEL` if sponsor access differs. A configured key is not labeled verified until a successful live result has been recorded. The sample-review button is clearly labeled and does not call an AI provider or qualify as sponsor usage.

### Apify

`actors/product-specs/` contains a custom stdlib Python Actor. It retrieves public product pages from a small retailer allowlist, extracts explicitly published JSON-LD measurements, normalizes supported units, and returns `null` for unknown fields. No mocked product specs are returned from the live endpoint. Blocked pages and missing data lead to manual entry.

Deploy the folder as an Actor in your Apify account, build it, and set `APIFY_ACTOR_ID` to its ID or `username~actor-name`. `POST /api/product-lookup` invokes it live using the [synchronous dataset endpoint](https://docs.apify.com/api/v2/actor-run-sync-get-dataset-items-post), with a 60-second Actor timeout and a $0.10 run cap. Source facts may describe an unpackaged item: the UI asks the user to review packed dimensions and weight.

### Deliberate scope

This build uses D1, not Convex or Supabase. It uses browser speech, not Cartesia or ElevenLabs. Nessie, Fetch/ASI:One, x402, and physical drone controls are **not implemented**. Merely referencing a sponsor in the research page is not a working integration. The current submission strategy prioritizes useful return workflows instead of unrelated tools. The broader household-drone plan remains a roadmap.

## Environment variables

Set local secrets in ignored `.dev.vars` (example below); set hosted values through Sites runtime environment variables. Redeploy after updating hosted variables. Never put credentials in source, public files, or `NEXT_PUBLIC_*` variables.

```dotenv
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-5-5
APIFY_TOKEN=
APIFY_ACTOR_ID=
```

Only the core DB binding is required; `.openai/hosting.json` declares it. Missing sponsor credentials return explicit setup errors and leave manual booking available. The hosted Site remains owner-private. Signed-in identity scopes hosted records; a random HttpOnly session cookie scopes anonymous local demos. Tracking IDs alone do not authorize access.

## Architecture

- `lib/simulation.ts`: pure flight model, route calculations, state transitions, facility eligibility, pricing estimates, event generation.
- `lib/server.ts`: validated booking/control HTTP operations, owner scoping, version compare-and-set persistence.
- `db/schema.ts` and `drizzle/`: D1 records and integration audit schema.
- `components/flight-map.tsx` and `components/maplibre-flight-map.tsx`: Google/MapLibre display with frame-based motion; camera/zoom/follow controls.
- `components/booking.tsx`, `components/aero-app.tsx`: complete consumer journey.
- `components/return-assistant.tsx`: live product enrichment/photo review, transparent sample output, setup states.
- `lib/integration-server.ts`: server-only provider calls, bounded usage, validation, live audit results.
- `data/hackathon-tracks.json`, `components/demo-room.tsx`: all current researched prize cards and a demo runbook.

The simulator does not assume a permanent server loop. The server stores its clock anchor, elapsed virtual time, rate, payload, selected facility, and loading state. Any request can derive current telemetry and persist newly crossed milestones. A client interpolates that same deterministic record and polls every two seconds. Multiple tabs agree after reconnection. Polling is not a claim of Supabase/Convex realtime use.

## Booking recovery

Unfinished package details and the current booking step are recoverable in the same tab for 12 hours after the last edit. Closing a dialog or reloading for Maps setup does not lose them. A completed booking clears its draft; Start over resets it, and Amazon/assistant imports begin a fresh draft. Images and account tokens are never included. Review consent is always unchecked after recovery. Session-storage restrictions leave in-memory editing available.

## Verification

```sh
npm run typecheck
npm test
python3 tests/test_product_actor.py
# With local server running:
node_modules/.bin/tsx scripts/smoke.ts
node_modules/.bin/tsx scripts/location-account-smoke.ts
```

Tests cover distance, route interpolation, compatibility, explicit pickup gating, complete handoff, pause/resume/speed changes, persistence, interruption, cancellation, review uncertainty, URL allowlisting, and Actor extraction. The HTTP smoke test creates a demo return and checks session isolation, the full journey, and persistence. Tests never call Anthropic or Apify. Live credentialed verification remains separate.

## Real hardware later

A real service needs an authenticated telemetry adapter, reliable command/ack protocol, a physical pickup interlock, flight authorization, airspace and site permissions, fleet dispatch, verified carrier/retailer acceptance, operational safety, privacy review, and real payments. Geodesic demo routes are not proof that a flight is legal or safe. The user's proposed indoor pad protocol is documented as a future boundary in `docs/DRONE_API.md`; no endpoint here accepts hardware commands.

## Cal Hacks submission

The research snapshot is dated October 23, 2026. Read `/demo` and `data/hackathon-tracks.json` for all 58 current Hive cards. Confirm unresolved prize conflicts and entry rules directly with organizers. Deadline listed on [Devpost](https://cal-hacks-13-0.devpost.com/): October 25 at 9 a.m. Pacific. No interviews, Figma work, Notability history, sponsor API calls, or physical flights should be claimed unless the team actually completes and records them.

## Google Maps, location, and nearby drop-offs

Open **Maps** below the tracking actions. Paste a website-restricted Google Maps browser API key; it is kept in this tab's session storage and applied on reload. The optional Map ID defaults to Google's `DEMO_MAP_ID`. For a shared hosted configuration, set `GOOGLE_MAPS_BROWSER_KEY` and `GOOGLE_MAPS_MAP_ID` through Sites runtime variables and redeploy. A browser key is intentionally delivered to the client; never put a general-purpose server credential in this field.

The hosted prototype uses a [free Maps Demo Key](https://developers.google.com/maps/documentation/javascript/demo-key), configured in Sites runtime secrets, with no billing account enabled. Google caps daily usage and pauses requests at the limit without charges. This key is solely for testing and evaluation, not a real operational service. Google's demo console currently redirects Keys & Credentials to an upgrade prompt, so custom referrer restrictions were not configured. Do not upgrade or attach billing automatically.

For a standard paid project, enable **Maps JavaScript API**, **Geocoding API v4**, and **Places API (New)**. Restrict its browser key to the required APIs and website referrers `https://aero-returns-kv15.kveldanda10.chatgpt.site/*` and optionally `http://127.0.0.1:5173/*`. Set quotas and billing alerts; budget alerts alone do not cap spending. No Google key is bundled in source. Setup: [Google key guidance](https://developers.google.com/maps/api-security-best-practices). Address and reverse lookup use the v4 HTTP API because the legacy JavaScript Geocoder is unavailable with the demo key.

With a key, tracking uses Google Maps and advanced markers. Without a key, or after a loading/authorization failure, the existing MapLibre demo remains available. Booking supports one-time browser geolocation, accuracy feedback, Google address search, and selecting a pickup pin. Location permission is requested only after a button click. Coordinates are sent to Google only when Google features are used. A booking draft, including the pickup, is kept in this tab’s session storage for recovery; the confirmed pickup is saved on the server only with a booking; there is no background location watch or tracking of other people. Bookings remain inside the Berkeley demo area, and no low-accuracy device fix is accepted without manual refinement.

**Nearby drop-offs** searches the current pickup, the user's opt-in device location, or an entered address/city. Categories are UPS drop-offs, other shipping drop-offs, and warehouses. Google's [Text Search (New)](https://developers.google.com/maps/documentation/javascript/place-search) returns up to 20 candidates, filtered to the selected 5/10/25 km radius and sorted by straight-line distance. A listing is not evidence of QR acceptance, public access, or drone participation. Warehouses are explicitly marked as potentially private. Places are displayed on Google Maps with hours/details and directions links; search locations and results are memory-only, never stored as participating hubs. No seeded listings are substituted for a failed API call.

## Amazon account connection

**Amazon** opens a profile-linking and return-import flow. Standard [Login with Amazon profile scopes](https://developer.amazon.com/docs/login-with-amazon/customer-profile.html) do not authorize access to personal purchases or return creation. AERO does not scrape authenticated Amazon pages or collect Amazon passwords. Users start/approve the return on Amazon's Your Orders page, then import its reference and QR/label method into booking. The existing QR upload reads locally; opaque retailer codes still require manual review.

To enable real profile linking, register a Login with Amazon Security Profile and configure:

- `AMAZON_CLIENT_ID`
- `AMAZON_CLIENT_SECRET` (server-only)
- `AMAZON_REDIRECT_URI=https://aero-returns-kv15.kveldanda10.chatgpt.site/api/amazon/callback`

Add that exact callback to the Amazon app's allowed return URLs. Local testing needs its own registered callback, `http://127.0.0.1:5173/api/amazon/callback`, and matching local configuration. Use Amazon's [authorization code grant instructions](https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html).

OAuth uses PKCE S256, a one-time ten-minute state tied to the AERO owner and an HttpOnly SameSite cookie, strict request origins, and server-side token exchange. The linked name, email, and Amazon account identifier are stored privately; access and refresh tokens are discarded after profile retrieval. Disconnect removes AERO's profile association and outstanding link attempts. It does not revoke consent at Amazon. Missing credentials disable linking clearly while manual return import stays usable.

Google Maps rendering, address lookup, UPS and warehouse search have been verified on the hosted prototype with the free demo key. Amazon sign-in remains unverified without registered app credentials. Passing tests or finding a listing does not establish retailer participation.
