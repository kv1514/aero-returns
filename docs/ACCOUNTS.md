# Google and Amazon sign-in with Supabase

AERO uses Supabase Auth for optional social accounts. Existing demo returns remain in Cloudflare D1, scoped to a verified Supabase user ID after sign-in (`supabase:<uuid>`). The original Site or guest history is not silently copied into a new account. No database migration or service-role key is required for this architecture.

The current hosted Site remains owner-private. App sign-in does not bypass Sites sharing. Allowing other people through the hosting gate requires a separate, explicit sharing change or deployment to another host.

## Runtime configuration

Set these through Sites runtime settings and redeploy. Do not commit values.

- `SUPABASE_URL`: HTTPS project URL.
- `SUPABASE_PUBLISHABLE_KEY`: publishable key, never a service-role/secret key.
- `SUPABASE_GOOGLE_ENABLED=true`: only after Google provider setup succeeds.
- `SUPABASE_AMAZON_ENABLED=true`: only after the custom provider is configured and tested.
- `SUPABASE_COOKIE_SECURE`: omit on hosted HTTPS; set `false` only for local HTTP.

Supabase Site URL: `https://aero-returns-kv15.kveldanda10.chatgpt.site`.
Allowed redirect URL: `https://aero-returns-kv15.kveldanda10.chatgpt.site/api/account/callback`.
For local testing, separately allow `http://127.0.0.1:5173/api/account/callback`.

The app uses the pinned `@supabase/ssr` SDK, PKCE, HttpOnly/SameSite cookies and server-side `getUser()` verification. Auth responses are no-store. POST sign-in and DELETE sign-out require the same origin; callbacks return only to the fixed AERO root. Failed identity verification never falls back to another owner's history. User metadata is display-only. Signing out clears the browser's Supabase session; it does not sign out of Google, Amazon, or the Sites hosting gate.

## Google

1. Create a web OAuth client in a separate suitable Google Cloud project. The free Maps Demo Project is not a general OAuth project, and the Maps API key is not a client secret.
2. Configure the consent screen for basic identity only. Use the exact Supabase callback displayed in its Google provider settings as the OAuth authorized redirect URI.
3. Enter the Google client ID/secret into Supabase Auth → Providers → Google. Do not request Gmail, Drive, or other Google data scopes.
4. Configure the AERO callback allowlist above, then enable the runtime flag and test sign-in, cancellation, refresh, logout, and separate-account history isolation.

Docs: https://supabase.com/docs/guides/auth/social-sign-in/auth-google

## Amazon

Use Supabase's supported custom OAuth2 provider `custom:amazon`, not a fake built-in `amazon` provider. Amazon's `/user/profile` response uses `user_id`, while Supabase expects `sub`. The included Edge Function adapts that response without minting tokens or using a privileged Supabase key.

1. Register a Login with Amazon security profile. Add the exact callback URL displayed by Supabase's custom-provider form as an allowed return URL.
2. Deploy `supabase/functions/amazon-userinfo/index.ts` with `verify_jwt=false`. It accepts only GET with an Amazon Bearer token, calls only the fixed Amazon profile endpoint, never logs tokens, and returns `sub` and `name` with no-store headers.
3. Add a custom OAuth2 provider:
   - Identifier: `custom:amazon`
   - Authorization URL: `https://www.amazon.com/ap/oa`
   - Token URL: `https://api.amazon.com/auth/o2/token`
   - UserInfo URL: the deployed `amazon-userinfo` Edge Function URL
   - Scope: `profile`
   - Client ID and secret: from the Amazon security profile
   - PKCE: enabled
   - Email optional: enabled
4. The adapter deliberately omits email: Amazon does not return an `email_verified` claim, so we do not assert verification or silently link a Google account by email. Amazon sign-in is its own identity. Test the full flow before enabling the runtime flag.

The existing direct Amazon profile-linking flow is separate and still uses `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, and `AMAZON_REDIRECT_URI`. Neither flow imports purchases, authorizes retailer returns, or approves refunds.

Docs: https://supabase.com/docs/guides/auth/custom-oauth-providers
Amazon profile: https://developer.amazon.com/docs/login-with-amazon/customer-profile.html

## Setup status

Supabase is provisioned and connected to the deployed app. Organization: AERO (`ngorkhrgbaadljsezvou`, Free plan). Project: AERO (`hkmeykcgwnaatkzgukth`, `us-west-1`, healthy). The app's runtime URL and publishable key are configured; privileged keys are not used. The Site URL and exact hosted callback above are saved in Supabase.

The `amazon-userinfo` Edge Function is deployed (version 1). Live checks confirm missing/invalid tokens return 401, unsupported methods return 405, and responses have `Cache-Control: no-store`. Successful Amazon authentication is still unverified.

Google sign-in is enabled and verified on the hosted app. Google Cloud project `aero-sign-in` (AERO Sign In) contains the web client `AERO Web — Supabase`; the client secret is stored only in Supabase provider configuration. Google received the owner's approved policy agreement. The sole redirect URI is `https://hkmeykcgwnaatkzgukth.supabase.co/auth/v1/callback`. The live flow requested only `email profile` (name, profile picture, email). No Google billing account was attached.

Google's publishing status remains **Testing** with the owner's Google account registered as a test user. The app remains owner-private at the Sites layer. Do not claim public release or extend access without an explicit request. Google's consent screen currently displays the Supabase project hostname; custom brand verification is not complete.

Hosted browser verification on October 23, 2026 (Pacific): first Google consent/login returned `auth=success`; the account panel displayed the verified name/email; reload preserved the session; sign-out restored the original demo history; signing in again returned to the same separate Google-owned return history. Live tests with a second Google account, cancellation after consent, and expiration/replay scenarios remain outstanding; existing offline policy/ownership checks are documented in HANDOFF.

`SUPABASE_GOOGLE_ENABLED=true` is deployed. `SUPABASE_AMAZON_ENABLED=false` remains intentional: the owner deferred Amazon Developer registration. The deployed adapter is ready for that future setup, but there is no Amazon client/security profile or successful Amazon login. Do not reuse SideSpace projects or the Maps Demo Project for this setup.
