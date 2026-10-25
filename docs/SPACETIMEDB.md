# SpacetimeDB live sync

SpacetimeDB is an optional real-time layer. Cloudflare D1 stays the source of truth and Supabase stays the sign-in. When the Worker has the three settings below, it copies a small, privacy-filtered set of rows into a SpacetimeDB database after D1 writes, and browsers subscribe to those rows. Without the settings, nothing is sent to SpacetimeDB, no SpacetimeDB code loads in the browser, Fleet shows no live-sync card, and every screen polls as before. The one difference is a background `GET /api/live-sync` per page load, which answers `{"enabled":false}`.

Screens may show "Live via SpacetimeDB" only while their client is actually connected and subscribed.

**Status.** The Worker side is in place: `lib/spacetime-sync.ts` (pure, tested in `tests/spacetime-sync.test.ts`), `lib/spacetime-server.ts` and `app/api/live-sync/route.ts`. The module is in `spacetime/`. As of this writing nothing has been published to Maincloud and the deployed Worker has none of these settings, so no live integration has been verified there. It has been checked end to end only against a local SpacetimeDB 2.13 server (`scripts/stdb-local.sh`) with the local dev server: demo accounts, the viewer grant, owner-only views, simulated and live (fake-vehicle bridge) flights, and the app with SpacetimeDB stopped.

## What is synced

| Table | Visibility | Rows | Written on |
| --- | --- | --- | --- |
| `account_session` | private, seen through the `my_account` view | opaque account key, kind (`demo`, `account`, `guest`), total and active return counts | demo and signed-in accounts on `GET /api/account`; any account on the viewer grant, each booking, each saved milestone of a simulated return, and the end of a live flight. A guest gets a row only once it has booked, because anyone can mint a guest cookie. |
| `fleet_drone` | private, seen through `my_fleet` | a real drone's id, position, altitude, heading, speed, battery, satellites, state, mission phase and fault, armed/stale/on-mission flags, link transport (`https`/`sms`) | a drone link report (HTTPS or SMS) that the Worker stored: every report on a mission, at most every 5 s for an idle drone on the ground; each Fleet `PATCH`; removed on Fleet `DELETE` |
| `return_status` | private, seen through `my_returns` | return id, mode (`simulated`/`live`), flight state, progress, ETA seconds, drone label (`AERO-217` or `Live drone`) | simulated: booking, `GET` and `PATCH /api/returns/:id`; live: with its drone's reports and Fleet actions |
| `sim_flight` | private, read only by `fleet_stats` | opaque flight key, demo fleet drone id (`aero-217`), state, done flag | with the simulated `return_status` writes |
| `viewer_grant` | private | browser identity, owner key, grant time | `POST /api/live-sync` |
| `fleet_stats` | **public view, the only public data** | counts of demo, signed-in and guest accounts, simulated flights in progress, live drones online | computed by the module |

The private views return only the rows of the owner that the viewer's identity was granted.

**Why no flight row is public.** An earlier version published one `sim_flight` row per flight. A review showed that its drone id (the nearest of five bases that ship in the client code), booking time and state-change times, refreshed on every poll, were enough to narrow a customer's own pickup pin down to a few tens of metres, because the simulated timeline is a fixed function of distance. A shared view now publishes only the count. That count moves when a flight is booked and when it ends or goes idle. The customer's own wait before confirming the package is loaded sits between those two times, so they do not give a distance.

## What is never synced

The following never leave the Worker:
- addresses, pickup coordinates, instructions or return references
- names, emails or phone numbers
- photos or Claude check details
- drone names, configured home and pad coordinates, geofence or keys
- the owner string itself

A real drone's **reported position** does leave the Worker, into the private `fleet_drone` table that only its owner's `my_fleet` view returns. A parked drone reports where it sits, which is usually its home or a pad. The Fleet card shows no coordinates.

Owners appear only as `HMAC-SHA256(DRONE_LINK_SECRET, 'aero-stdb-owner:' + owner)`, cut to 32 hex characters. Flight rows use a separate key derived from the return id. The payloads are built field by field, and `tests/spacetime-sync.test.ts` checks two things: that the payloads contain none of these fields, and that in the module every write reducer checks the sender, no table is public, and the owner views filter by the caller's grant.

## How a browser sees its own rows

1. The browser asks `GET /api/live-sync` for `{enabled, uri, database}`. The answer never includes a token.
2. The browser connects with its own SpacetimeDB identity and sends `{identity, token, account}` to `POST /api/live-sync`. `account` is the account key this identity was last granted, kept in `localStorage` next to the token. That route only accepts requests from the same origin and limits the body size.
3. The Worker checks the pair with `GET {uri}/v1/identity/{identity}/verify`. A 204 means the token is that identity's.
4. If `account` is another account's key, the browser's account changed since the last grant (sign-in, sign-out or a demo switch, each of which reloads the app). The Worker then calls `revoke_viewer` and answers 409, and the browser forgets that token and connects as a new identity. So a copied token never follows the browser's next account, and sign-out revokes the old grant on the reload that follows it.
5. Otherwise the Worker calls `grant_viewer` for the session's owner and answers `{granted: true, account}`. Grants expire after two hours. Open tabs renew them every 30 minutes and on every reconnect. The token is not stored, logged or echoed.

## Writes from the Worker

- **Reducers.** Only the Worker can write. Every write reducer rejects a sender other than `WORKER_IDENTITY`.
- **Request format.** Each write is `POST {uri}/v1/database/{db}/call/{reducer}?confirmed=false` with the Worker's Bearer token and a camelCase JSON object as the body.
- **Timing.** Each call is scheduled with `waitUntil`. No request waits for it, each has a 1.5 s timeout, and failures are dropped.
- **Grant route.** Only `POST /api/live-sync` waits for its calls: the verify check, `grant_viewer` and `upsert_account`.

**Simulated flights do not tick on the server.** A row changes only when a request for that return reaches the Worker, which happens while its customer has it open. So "in progress" means watched by someone in the last five minutes.

**Polling.** While live, the customer app refetches a return as soon as its `my_returns` row changes state. A simulated return then polls every 8 s instead of every 2 s. A live flight keeps the 2 s poll, because "Drone signal lost" comes from the server's read of the drone's last report, and a silent drone changes no row.

**The module's sweep** runs every 10 s:
- It deletes a finished `sim_flight` row after 120 s, and an unfinished one that no screen has updated for 5 minutes.
- It marks a drone stale when it misses its transport's report window: 20 s for HTTPS and 130 s for SMS (the Worker's 10 s and 120 s, plus one sweep).
- It drops viewer grants after two hours.
- It drops `account_session`, `fleet_drone` and `return_status` rows after a day without an update. The account counts are therefore accounts seen in the last day. A drone removed while SpacetimeDB was unreachable also goes then.

## Setup

**Prerequisites.** You need the `spacetime` CLI 2.13 and a database name that matches `^[a-z0-9]+(-[a-z0-9]+)*$`. Names are global on Maincloud.

**1. Mint the Worker's own identity.** Do not use the CLI login token: that identity owns the database and can delete it.

```sh
curl -sS -X POST https://maincloud.spacetimedb.com/v1/identity   # {"identity":"<hex>","token":"<jwt>"}
```

**2. Publish the module** with that identity as its only writer:

```sh
WORKER_IDENTITY=<hex> spacetime publish <db> --server maincloud -p spacetime
spacetime generate --lang typescript --out-dir lib/stdb/module_bindings --module-path spacetime
```

**3. Give the Worker its settings.** Put all three in as secrets, so `npm run deploy` keeps them. `DRONE_LINK_SECRET` must already be set, which the deploy script does.

```sh
npm run build
npx wrangler secret put SPACETIMEDB_DATABASE --config dist/server/wrangler.json
npx wrangler secret put SPACETIMEDB_TOKEN --config dist/server/wrangler.json      # the token from step 1
npx wrangler secret put SPACETIMEDB_URI --config dist/server/wrangler.json        # optional; default https://maincloud.spacetimedb.com
```

**Rotating the Worker token.** A locally minted token had no expiry and cannot be revoked; Maincloud's token claims were not checked. To rotate, mint a new identity, run `WORKER_IDENTITY=<new> spacetime publish <db> --server maincloud --env-only -p spacetime`, and replace `SPACETIMEDB_TOKEN`.

**Local development.** `STDB_LOCAL_DIR=<scratch dir> scripts/stdb-local.sh` starts an in-memory SpacetimeDB on 127.0.0.1:3010 with its own CLI config, mints a local Worker identity and publishes `spacetime/` as `aero-fleet-local`. It never talks to Maincloud.
1. In `.dev.vars`, set `SPACETIMEDB_URI=http://127.0.0.1:3010`, `SPACETIMEDB_DATABASE=aero-fleet-local`, `SPACETIMEDB_TOKEN` (the `token` in `$STDB_LOCAL_DIR/worker.json`) and a 32+ character `DRONE_LINK_SECRET`.
2. After changing the module, run the script again and regenerate the bindings with `spacetime generate --lang typescript --out-dir lib/stdb/module_bindings --module-path spacetime`.
3. `scripts/stdb-local.sh stop` stops it. The app then shows "Unavailable" in Fleet and polls as before. Open pages reconnect on their own when it is back.

Plain `http` is accepted only for localhost.

## Known limits

- `POST /api/live-sync` has no rate limit of its own. A script holding a self-minted SpacetimeDB identity and any guest cookie can make the Worker run one verify call and one `grant_viewer` write per request. It adds no account rows, and its grants lapse after two hours, but each write uses SpacetimeDB energy. A Cloudflare rate-limiting rule on that path would cap it. If energy runs out, writes fail and screens fall back to polling.
- The SDK chunk (about 120 KB) is bundled into the Worker upload, because the client component's dynamic import is also built for SSR. It is only loaded in a browser effect and never runs on the Worker.
- An old identity's grant stays until it lapses (at most two hours) if the browser never loads the app again after sign-out. The same happens if another tab of the same browser renews the old identity in the instant between the rotation and the new grant.
