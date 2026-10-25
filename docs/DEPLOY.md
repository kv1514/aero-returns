# Deploying AERO to Cloudflare

Production is the public Worker `aero-returns` with the D1 database `aero-returns` (IDs in `deploy/cloudflare.json`). Anyone with the link can use it; every record is scoped to its owner.

- App: https://aero-returns.kv15.workers.dev
- Fleet console: https://aero-returns.kv15.workers.dev/fleet

## Deploy

```sh
npm ci
npx wrangler login        # once per machine
npm run deploy
```

`npm run deploy` (`scripts/deploy-cloudflare.mjs`) builds with Vinext, points the generated `dist/server/wrangler.json` at the real D1 database, applies new `drizzle/*.sql` migrations (0000–0004 so far) with `wrangler d1 migrations apply`, deploys, and creates the `DRONE_LINK_SECRET` Worker secret the first time. That secret is random and never printed; per-drone keys are derived from it. Rotating it invalidates every drone key. GitHub pushes do not deploy.

The home-screen app ships with the build: `public/manifest.webmanifest`, `public/apple-touch-icon.png`, `public/icons/` and `public/splash/` are served as static files. After a deploy, `/manifest.webmanifest` and `/apple-touch-icon.png` should answer 200. There is no service worker, so installed home-screen apps load a new deploy like any browser tab.

Pin zones (`docs/DRONE_LINK.md`) need no migration: `pinRadius` lives in each drone's config JSON, and drones registered before it read as 0, pins off. After a deploy that includes them, `GET /api/fleet` lists `maxPinRadius` in `limits`. On the afternoon of October 24 the Worker did not, so it still ran the version without pin pickups.

## Optional runtime secrets

Set with `npx wrangler secret put NAME --config dist/server/wrangler.json` after a build. A missing value turns off only that feature; the app says so and keeps the rest working.

| Secret | Enables | Without it |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | SMS drone link; set the Twilio number's incoming-message webhook to `/api/drone/sms` | Fleet shows "SMS off"; the HTTPS (4G data) link still works |
| `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_MAPS_MAP_ID` | Google Maps, address search, nearby drop-offs, Google 3D tiles | MapLibre with OpenFreeMap tiles and the key-free 3D view; the Maps tile accepts a per-tab key |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude return check in booking (`/api/return-agent`), Assistant photo review (`/api/return-review`) and pickup-photo detection (`/api/pickup-review`); the model defaults to `claude-opus-5-5` | Each shows a setup state (the booking check names `ANTHROPIC_API_KEY`); booking with the entered details, AERO's drone limits and manual pickup marking still work |
| `APIFY_TOKEN`, `APIFY_ACTOR_ID` | Product-spec lookup, also used by the Claude return check | Claude relies on the entered measurements |
| `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_REDIRECT_URI` | Login with Amazon profile linking; `AMAZON_REDIRECT_URI` must be `https://aero-returns.kv15.workers.dev/api/amazon/callback` | Linking is disabled with an explanation; manual Amazon return import still works |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_GOOGLE_ENABLED` | Google sign-in; add the workers.dev callback to Supabase's redirect allowlist first | Sign-in buttons stay disabled; guests and the demo account work |
| `SUPABASE_EMAIL_ENABLED` (with `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`) | Email + password sign-up and sign-in; turn on Supabase's Email provider first and choose "Confirm email" off, or on with custom SMTP ([`ACCOUNTS.md`](ACCOUNTS.md#email-and-password)) | No email form; guests, the demo account and any configured Google sign-in work |

On October 24 the Worker reported `ANTHROPIC_API_KEY` and `DRONE_LINK_SECRET` as set, and Twilio, Google Maps, Apify, Amazon and Supabase as not set (`/api/integrations`, `/api/fleet`, `/api/account`). The Google Maps demo key and Supabase settings of the earlier ChatGPT Sites prototype were never copied to the Worker.

`AERO_TRUST_SITES_IDENTITY=true` is only for the ChatGPT Sites proxy. Never set it on the public Worker: any client could forge the `oai-authenticated-user-*` headers.
