# AERO — Returns, without the trip

A map-first, end-to-end **simulated** drone returns app for the Cal Hacks 13.0 demo. The app lives separately from the parent arbitrage engine. It never sends physical flight commands, creates a carrier return, charges a payment method, or approves a retailer refund.

## Run locally

Node 22.13+ is required. Node 24 is recommended.

```sh
npm ci
npm run db:generate   # only when changing db/schema.ts; initial migration is committed
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_uneven_violations.sql
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
- `components/flight-map.tsx`: MapLibre display with frame-based motion; camera/zoom/follow controls.
- `components/booking.tsx`, `components/aero-app.tsx`: complete consumer journey.
- `components/return-assistant.tsx`: live product enrichment/photo review, transparent sample output, setup states.
- `lib/integration-server.ts`: server-only provider calls, bounded usage, validation, live audit results.
- `data/hackathon-tracks.json`, `components/demo-room.tsx`: all current researched prize cards and a demo runbook.

The simulator does not assume a permanent server loop. The server stores its clock anchor, elapsed virtual time, rate, payload, selected facility, and loading state. Any request can derive current telemetry and persist newly crossed milestones. A client interpolates that same deterministic record and polls every two seconds. Multiple tabs agree after reconnection. Polling is not a claim of Supabase/Convex realtime use.

## Verification

```sh
npm run typecheck
npm test
python3 tests/test_product_actor.py
# With local server running:
node_modules/.bin/tsx scripts/smoke.ts
```

Tests cover distance, route interpolation, compatibility, explicit pickup gating, complete handoff, pause/resume/speed changes, persistence, interruption, cancellation, review uncertainty, URL allowlisting, and Actor extraction. The HTTP smoke test creates a demo return and checks session isolation, the full journey, and persistence. Tests never call Anthropic or Apify. Live credentialed verification remains separate.

## Real hardware later

A real service needs an authenticated telemetry adapter, reliable command/ack protocol, a physical pickup interlock, flight authorization, airspace and site permissions, fleet dispatch, verified carrier/retailer acceptance, operational safety, privacy review, and real payments. Geodesic demo routes are not proof that a flight is legal or safe. The user's proposed indoor pad protocol is documented as a future boundary in `docs/DRONE_API.md`; no endpoint here accepts hardware commands.

## Cal Hacks submission

The research snapshot is dated October 23, 2026. Read `/demo` and `data/hackathon-tracks.json` for all 58 current Hive cards. Confirm unresolved prize conflicts and entry rules directly with organizers. Deadline listed on [Devpost](https://cal-hacks-13-0.devpost.com/): October 25 at 9 a.m. Pacific. No interviews, Figma work, Notability history, sponsor API calls, or physical flights should be claimed unless the team actually completes and records them.
