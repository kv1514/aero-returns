# Deploying AERO to Cloudflare

Production is the Worker `aero-returns` with the D1 database `aero-returns` (IDs in `deploy/cloudflare.json`).

- App: https://aero-returns.kv15.workers.dev
- Fleet console: https://aero-returns.kv15.workers.dev/fleet

## Deploy

```sh
npm ci
npx wrangler login        # once per machine
npm run deploy
```

`npm run deploy` (`scripts/deploy-cloudflare.mjs`) builds with Vinext, points the generated `dist/server/wrangler.json` at the real D1 database, applies new `drizzle/*.sql` migrations with `wrangler d1 migrations apply`, deploys, and creates the `DRONE_LINK_SECRET` Worker secret the first time. That secret is random and never printed; per-drone keys are derived from it. Rotating it invalidates every drone key.

## Optional runtime secrets

Set with `npx wrangler secret put NAME --config dist/server/wrangler.json` after a build. A missing value leaves that feature off with a clear setup message.

| Secret | Enables |
| --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | SMS drone link; set the Twilio number's incoming-message webhook to `/api/drone/sms` |
| `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_MAPS_MAP_ID` | Google Maps, address search, nearby drop-offs, Earth view (otherwise OpenFreeMap tiles) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude photo review |
| `APIFY_TOKEN`, `APIFY_ACTOR_ID` | Product-spec lookup |
| `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_REDIRECT_URI` | Login with Amazon profile linking; `AMAZON_REDIRECT_URI` must be `https://aero-returns.kv15.workers.dev/api/amazon/callback` |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_GOOGLE_ENABLED` | Google sign-in; add the workers.dev callback to Supabase's redirect allowlist first |

`AERO_TRUST_SITES_IDENTITY=true` is only for the ChatGPT Sites proxy. Never set it on the public Worker: any client could forge the `oai-authenticated-user-*` headers.
