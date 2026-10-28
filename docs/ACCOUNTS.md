# Google, Amazon and email sign-in with Supabase

AERO uses Supabase Auth for optional accounts: Google, Amazon (custom provider) and email + password. Existing demo returns remain in Cloudflare D1, scoped to a verified Supabase user ID after sign-in (`supabase:<uuid>`). The original guest history is not silently copied into a new account. No database migration or service-role key is required for this architecture.

The public deployment is the Cloudflare Worker `aero-returns` (https://aero-returns.kv15.workers.dev). It has no access gate: anyone with the link can use it, so owner scoping is the protection. Every return, drone and linked account belongs to one owner (a random HttpOnly guest cookie, the demo account, or a server-verified Supabase user), and signing in never reveals another owner's history. The earlier ChatGPT Sites prototype keeps its own owner-private hosting gate.

## Runtime configuration

Set these as Worker secrets (`npx wrangler secret put NAME --config dist/server/wrangler.json`; full list in [`DEPLOY.md`](DEPLOY.md)), and locally in the ignored `.dev.vars`. Do not commit values. None of them is set on the Worker yet (`/api/account` reports `configured:false`), so its sign-in buttons stay disabled.

- `SUPABASE_URL`: HTTPS project URL.
- `SUPABASE_PUBLISHABLE_KEY`: publishable key, never a service-role/secret key.
- `SUPABASE_GOOGLE_ENABLED=true`: only after Google provider setup succeeds.
- `SUPABASE_AMAZON_ENABLED=true`: only after the custom provider is configured and tested.
- `SUPABASE_EMAIL_ENABLED=true`: only after the Email provider is set up in Supabase ([Email and password](#email-and-password)).
- `SUPABASE_COOKIE_SECURE`: omit on hosted HTTPS; set `false` only for local HTTP.

Supabase Site URL: `https://aero-returns.kv15.workers.dev` (the earlier ChatGPT Sites prototype used `https://aero-returns-kv15.kveldanda10.chatgpt.site`).
Allowed redirect URL: `https://aero-returns.kv15.workers.dev/api/account/callback`. Add it in Supabase before enabling Google or email sign-in on the Worker (email confirmation links return there too).
For local testing, separately allow `http://127.0.0.1:5173/api/account/callback`.

The app uses the pinned `@supabase/ssr` SDK, PKCE, HttpOnly/SameSite cookies and server-side `getUser()` verification. Auth responses are no-store. POST sign-in and DELETE sign-out require the same origin; callbacks return only to the fixed AERO root. Failed identity verification never falls back to another owner's history. User metadata is display-only. Signing out clears the browser's Supabase session; it does not sign out of Google or Amazon.

## Email and password

**Your account** shows an email form with a **Create account** / **Sign in** switch when `SUPABASE_EMAIL_ENABLED=true` (and `SUPABASE_URL` plus `SUPABASE_PUBLISHABLE_KEY` are set). Judges and teammates can make their own accounts this way without a Google or Amazon login. The account itself (email and hashed password) is stored by Supabase Auth; AERO keeps no copy of either. Once signed in, the server-verified Supabase user ID owns the person's returns in D1 (`supabase:<uuid>`), exactly like a Google account. No Supabase tables, migration or service-role key are involved, and nothing imports purchases or authorizes refunds.

- `POST /api/account/password` with `{mode:'signup'|'signin', email, password}`. Same-origin only, body under 1000 bytes (reading stops at the cap, even without a Content-Length), `Cache-Control: private, no-store`, and the body is never logged or echoed. The email is trimmed and lowercased (at most 254 characters). A new password must be 8–72 characters; sign-in accepts any password up to 72 characters, so accounts made in the Supabase dashboard or another client under Supabase's own minimum (6) can still sign in. 72 bytes is Supabase's limit in both modes. The rules live in `lib/account-policy.ts` (`parsePasswordRequest`, `passwordAuthError`) and are tested in `tests/account-password.test.ts`.
- Sign-up calls Supabase `signUp` with `emailRedirectTo` set to `/api/account/callback`; sign-in calls `signInWithPassword`. A new session is verified with `getUser()` before AERO treats it as signed in, then the browser goes to `/?auth=success`, the same landing as the Google callback: booking drafts are cleared, other tabs reload, and the sign-in is confirmed. An active demo profile is switched off at the same time (its practice history is kept).
- Errors are plain. Sign-in never says whether an email has an account: an unknown email and a wrong password both read "Email or password is incorrect.". A sign-up refused for an email that already exists reads "Could not create that account. Try signing in instead.". With "Confirm email" **off** that does show that the address already has an account, because a new address is signed in straight away; Supabase cannot avoid this in that mode. With it **on**, Supabase answers a new and an existing address the same way ("Check your email…"). Rate limits read "Too many attempts. Wait a minute and try again." (429 with `Retry-After`), and a weak password gets Supabase's reason in plain words. Supabase outages read "temporarily unavailable"; setup problems (CAPTCHA turned on, the built-in mailer refusing a non-team address, a wrong URL or publishable key) read "still needs administrator setup", never "wrong password" or "account exists".
- If the new session fails Supabase's check, AERO answers "Sign-in did not complete" and removes the session cookies it had just written. A sign-up that needed no confirmation link puts the PKCE verifier cookies back as they were, so none is left behind.
- The panel shows the signed-in email and the account's five newest returns (date, retailer, reference when present, status), taken from the `GET /api/returns` list the app already loads for that owner. Each opens the return like the history list does.

Supabase settings it needs (Authentication → Sign In / Providers → Email):

1. **Email provider on**, with email + password sign-in allowed. Keep "Allow new users to sign up" on, or sign-up answers that new accounts are turned off.
2. Pick one confirmation mode:
   - **"Confirm email" off**: sign-up signs the person in immediately. Simplest for a judged demo; anyone can create an account with any address, so treat accounts as unverified, and sign-up shows whether an address already has an account (see above).
   - **"Confirm email" on**: sign-up replies "Check your email to confirm your account, then sign in." The link returns through `/api/account/callback` (the allowed redirect URL above) and completes the PKCE exchange only in the browser that signed up; opening it elsewhere lands on "Sign-in did not complete", after which the person can sign in normally. Supabase's built-in mailer sends only a few emails per hour and only to project team members' addresses, so set up custom SMTP (Authentication → Emails → SMTP) before inviting judges, and check the email rate limit (Authentication → Rate Limits).
3. Optionally raise the minimum password length or character rules (Authentication → Policies / password strength). AERO's own minimum for new passwords is 8; Supabase's stricter rule, if any, comes back as a plain message.
4. **Rate limits are shared.** AERO calls Supabase from the Worker, so Supabase most likely sees the Worker's outgoing address rather than each visitor's (not yet measured live), and its per-IP sign-up and sign-in limit (Authentication → Rate Limits) becomes one budget for everyone using AERO. Check and raise it before a judged session, or a burst of attempts (or one script) leaves everyone with "Too many attempts". AERO has no throttle of its own yet: adding one needs a Cloudflare Rate Limiting binding or a D1 table, which is a deploy change. Passing the visitor's address to Supabase would need a secret key, which AERO never uses.

Then set `SUPABASE_EMAIL_ENABLED=true` as a Worker secret alongside the URL and publishable key, and test: create an account, sign out, sign in, a wrong password, a second account's separate history, and (with confirmation on) the email link. Locally, `.dev.vars` can point at a Supabase project or a local Auth server; set `SUPABASE_COOKIE_SECURE=false` for plain HTTP and allow the local `/api/account/callback` URL in Supabase.

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

Email + password sign-in is built and covered by offline tests only: it is not enabled on the Worker or, as far as recorded, in the AERO Supabase project's Email provider settings, and no live email sign-up has been verified.

Supabase is provisioned. Organization: AERO (`ngorkhrgbaadljsezvou`, Free plan). Project: AERO (`hkmeykcgwnaatkzgukth`, `us-west-1`, healthy). Its URL and publishable key were configured on the ChatGPT Sites prototype only; the Worker has neither, and privileged keys are not used anywhere. The Sites prototype's Site URL and callback were saved in Supabase. Whether the workers.dev Site URL and callback above are saved there is not recorded; check before enabling sign-in on the Worker.

The `amazon-userinfo` Edge Function is deployed (version 1). Live checks confirm missing/invalid tokens return 401, unsupported methods return 405, and responses have `Cache-Control: no-store`. Successful Amazon authentication is still unverified.

Google sign-in was enabled and verified on the Sites prototype, not on the Worker. Google Cloud project `aero-sign-in` (AERO Sign In) contains the web client `AERO Web — Supabase`; the client secret is stored only in Supabase provider configuration. Google received the owner's approved policy agreement. The sole redirect URI is `https://hkmeykcgwnaatkzgukth.supabase.co/auth/v1/callback`. The live flow requested only `email profile` (name, profile picture, email). No Google billing account was attached.

Google's publishing status remains **Testing** with the owner's Google account registered as a test user, so only that account can sign in with Google even after the Worker gets the Supabase secrets. Do not claim a public Google sign-in or add test users without an explicit request. Google's consent screen currently displays the Supabase project hostname; custom brand verification is not complete.

Browser verification on the Sites prototype on October 23, 2026 (Pacific): first Google consent/login returned `auth=success`; the account panel displayed the verified name/email; reload preserved the session; sign-out restored the original demo history; signing in again returned to the same separate Google-owned return history. Live tests with a second Google account, cancellation after consent, and expiration/replay scenarios remain outstanding; existing offline policy/ownership checks are documented in HANDOFF.

`SUPABASE_GOOGLE_ENABLED=true` was set on the Sites prototype only. `SUPABASE_AMAZON_ENABLED=false` remains intentional: the owner deferred Amazon Developer registration. The deployed adapter is ready for that future setup, but there is no Amazon client/security profile or successful Amazon login. Do not reuse SideSpace projects or the Maps Demo Project for this setup.

## Built-in demo profile

`POST /api/account/demo` enters Alex Demo without OAuth. A random UUID capability is stored in a 30-day HttpOnly/SameSite=Lax cookie (`Secure` over HTTPS), plus an explicit active-mode cookie. Server ownership is `demo:<capability>` and is isolated from Supabase users, guest identities, other browsers and, on the Sites prototype, Sites users. A missing/invalid capability in active mode fails closed. The capability never appears in the account JSON.

`DELETE /api/account/demo` (or account sign-out in demo mode) clears active mode only. The original guest (or Google) session is preserved, and the inactive demo cookie allows practice history to resume. Both mutations require the exact request Origin. Mode switches clear booking drafts and broadcast a reload to other tabs; photo references are memory-only and cleared by reload. No shared email/password, Supabase user, purchase access, or retailer authorization is created. The public Worker has no access gate, so this owner scoping is what keeps practice history private.

`tests/demo-account.test.ts` checks identity namespaces, invalid sessions, and cookie attributes. `scripts/demo-account-smoke.ts` checks origin rejection, demo/original and browser-to-browser read/write isolation, loading confirmation, completion persistence, exit/resume, and invalid-session recovery against a running local app. Demo mode is explicitly displayed in the header and account panel.
