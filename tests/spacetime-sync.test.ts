import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startLive, type Drone } from '../lib/drone-mission';
import { createReturn, DEMO_PACKAGE, type Point, type ReturnRecord } from '../lib/simulation';
import { accountArgs, accountKind, activeReturns, callReducer, DEFAULT_URI, droneArgs, droneChanged, flightKey, grantArgs, grantFlow, grantReply, listed, ownerKey, parseGrant, publicSync, returnArgs, simFlightArgs, syncConfig, verifyIdentity, type SyncConfig } from '../lib/spacetime-sync';

const secret = 'x'.repeat(40), t0 = Date.UTC(2026, 9, 25, 17, 0);
const on = { SPACETIMEDB_DATABASE: 'aero-fleet-test', SPACETIMEDB_TOKEN: 'worker.jwt.token-value', DRONE_LINK_SECRET: secret };
const cfg: SyncConfig = { uri: 'http://127.0.0.1:3000', database: 'aero-fleet-test', token: 'worker.jwt.token-value', secret };
const viewer = 'c2'.repeat(32);

test('sync is on only with a database, the Worker token and a 32+ character secret; the URI defaults to Maincloud', () => {
  assert.deepEqual(syncConfig(on), { uri: DEFAULT_URI, database: 'aero-fleet-test', token: on.SPACETIMEDB_TOKEN, secret });
  for (const off of ['SPACETIMEDB_DATABASE', 'SPACETIMEDB_TOKEN', 'DRONE_LINK_SECRET'] as const) assert.equal(syncConfig({ ...on, [off]: undefined }), null, `${off} missing`);
  assert.equal(syncConfig({}), null, 'nothing set: the app polls exactly as before');
  assert.equal(syncConfig({ ...on, DRONE_LINK_SECRET: 'short' }), null);
  for (const name of ['Aero', 'aero_fleet', 'aero--fleet', '-aero', 'aero/../x']) assert.equal(syncConfig({ ...on, SPACETIMEDB_DATABASE: name }), null, name);
  assert.equal(syncConfig({ ...on, SPACETIMEDB_URI: 'https://stdb.example.com/' })?.uri, 'https://stdb.example.com', 'trailing slash stripped');
  assert.equal(syncConfig({ ...on, SPACETIMEDB_URI: 'http://127.0.0.1:3000' })?.uri, 'http://127.0.0.1:3000');
  for (const uri of ['http://stdb.example.com', 'ftp://127.0.0.1', 'not a url', 'https://u:p@stdb.example.com', 'https://stdb.example.com/?x=1']) assert.equal(syncConfig({ ...on, SPACETIMEDB_URI: uri }), null, uri);
});

test('the browser learns where to connect, never the token or the secret', () => {
  const shown = JSON.stringify(publicSync(syncConfig(on)));
  assert.deepEqual(JSON.parse(shown), { enabled: true, uri: DEFAULT_URI, database: 'aero-fleet-test' });
  assert.ok(!shown.includes(on.SPACETIMEDB_TOKEN) && !shown.includes(secret));
  assert.deepEqual(publicSync(null), { enabled: false, uri: null, database: null });
});

test('owner and flight keys are deterministic 32-hex HMACs of the secret with separate domains', async () => {
  const owner = 'supabase:11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
  const expected = createHmac('sha256', secret).update(`aero-stdb-owner:${owner}`).digest('hex').slice(0, 32);
  assert.equal(await ownerKey(secret, owner), expected);
  assert.equal(await ownerKey(secret, owner), await ownerKey(secret, owner));
  assert.match(await flightKey(secret, id), /^[0-9a-f]{32}$/);
  assert.notEqual(await ownerKey(secret, id), await flightKey(secret, id), 'domain separation');
  assert.notEqual(await ownerKey(secret, owner), await ownerKey('y'.repeat(40), owner), 'another secret, another key');
  assert.notEqual(await ownerKey(secret, 'guest:a'), await ownerKey(secret, 'guest:b'));
});

test('owners map to account kinds; a guest is listed only once it has booked', () => {
  assert.equal(accountKind('demo:abc'), 'demo');
  assert.equal(accountKind('supabase:abc'), 'account'); assert.equal(accountKind('user:abc'), 'account');
  assert.equal(accountKind('guest:abc'), 'guest'); assert.equal(accountKind('other:abc'), null);
  assert.deepEqual([listed('demo', 0), listed('account', 0), listed('guest', 0), listed('guest', 1)], [true, true, false, true], 'a cookie alone never adds a row');
  assert.match(readFileSync('app/api/account/route.ts', 'utf8'), /publishAccount\(demo\?\.owner\);[\s\S]*publishAccount\(account\?\.owner\);/, 'GET /api/account publishes demo and signed-in accounts only, never a guest cookie');
  assert.deepEqual(accountArgs('k', 'guest', 3.6, -1), { accountKey: 'k', kind: 'guest', returnsTotal: 4, returnsActive: 0 });
});

// Every private detail a record or drone can carry; none may appear in any payload.
const home: Point = [-122.2595, 37.8719], pickupPad: Point = [-122.2590, 37.8722], dropPad: Point = [-122.2585, 37.8716], pin: Point = [-122.2766, 37.8741];
const pkg = { ...DEMO_PACKAGE, address: '1820 Delaware Street, Berkeley', pickup: pin, instructions: 'Gate code 4417, leave by the blue door', returnReference: 'AMZ-REF-998877' };
const drone: Drone = { id: 'tst001', owner: 'demo:44444444-4444-4444-8444-444444444444', name: 'Secret Hangar X500', transport: 'https', phone: '+15105550123', phoneVerified: true, keyVersion: 3, config: { home, pickupPad, dropPad, radius: 300, maxAlt: 90, cruiseAlt: 75, pinRadius: 0 }, armedUntil: t0 + 60_000, activeReturn: null, lastSeq: 9, lastSeen: t0, telemetry: { ts: t0, receivedAt: t0, lat: 37.86411, lon: -122.26377, alt: 41.5, battery: 77, heading: 90, speed: 6.2, fix: 3, sats: 14, state: 'ENROUTE', mode: 'GUIDED' }, createdAt: t0 };
const FORBIDDEN = [pkg.address, pkg.instructions, pkg.returnReference, 'Delaware', drone.name, drone.phone!, drone.owner, 'alex@example.com', 'Alex Demo', ...[home, pickupPad, dropPad, pin].flat().map(String), 'droneName', 'address', 'pickup', 'phone', 'email', 'config', 'home', 'Pad', 'reference'];
const clean = (label: string, payload: unknown) => { const json = JSON.stringify(payload); for (const word of FORBIDDEN) assert.ok(!json.includes(word), `${label} leaks ${word}: ${json}`); };
const keys = (payload: object | null) => Object.keys(payload ?? {}).sort();

test('payloads carry only the contract fields: no address, pickup, reference, name, phone, email, owner or drone config', async () => {
  const owner = await ownerKey(secret, drone.owner), sim = createReturn(pkg, '55555555-5555-4555-8555-555555555555', t0);
  const live = { ...startLive(createReturn(pkg, '66666666-6666-4666-8666-666666666666', t0), drone, t0) };
  const flying = { ...drone, activeReturn: live.id }, withTelemetry: ReturnRecord = { ...live, live: { ...live.live!, telemetry: drone.telemetry } };
  const d = droneArgs(owner, flying, live, t0 + 1000)!, s = returnArgs(owner, sim, t0 + 30_000), l = returnArgs(owner, withTelemetry, t0 + 1000), f = simFlightArgs(await flightKey(secret, sim.id), sim, t0 + 30_000)!;
  assert.deepEqual(keys(d), ['alt', 'armed', 'battery', 'droneId', 'fault', 'heading', 'lat', 'lng', 'onMission', 'ownerKey', 'phase', 'sats', 'speed', 'stale', 'state', 'transport']);
  assert.deepEqual(keys(s), ['droneLabel', 'etaSeconds', 'mode', 'ownerKey', 'progress', 'returnId', 'state']);
  assert.deepEqual(keys(f), ['done', 'droneId', 'flightKey', 'state']);
  for (const [label, payload] of [['upsert_drone', d], ['upsert_return simulated', s], ['upsert_return live', l], ['upsert_sim_flight', f], ['upsert_account', accountArgs(owner, 'demo', 2, 1)], ['grant_viewer', grantArgs(viewer, owner)]] as const) clean(label, payload);
  assert.deepEqual({ lat: d.lat, lng: d.lng, phase: d.phase, armed: d.armed, onMission: d.onMission, stale: d.stale }, { lat: 37.86411, lng: -122.26377, phase: 'TAKEOFF_OUT', armed: true, onMission: true, stale: false });
  assert.deepEqual({ mode: l.mode, droneLabel: l.droneLabel }, { mode: 'live', droneLabel: 'Live drone' }, 'a live return never names its drone');
  assert.equal(s.mode, 'simulated'); assert.equal(s.droneLabel, sim.drone!.id.toUpperCase()); assert.match(s.droneLabel, /^AERO-\d{3}$/);
  assert.ok(!JSON.stringify(f).includes(sim.id), 'the public flight never carries the return id');
});

test('shapers stay valid for SpacetimeDB and skip what they cannot publish honestly', async () => {
  const owner = await ownerKey(secret, drone.owner), sim = createReturn(pkg, '77777777-7777-4777-8777-777777777777', t0);
  assert.equal(droneArgs(owner, { ...drone, telemetry: null }, null, t0), null, 'no report yet, nothing to show');
  const odd = droneArgs(owner, { ...drone, telemetry: { ...drone.telemetry!, alt: NaN, sats: -3, state: 'X'.repeat(80) } }, null, t0 + 60_000)!;
  assert.deepEqual({ alt: odd.alt, sats: odd.sats, len: odd.state.length, stale: odd.stale, phase: odd.phase, onMission: odd.onMission }, { alt: 0, sats: 0, len: 32, stale: true, phase: '', onMission: false });
  assert.equal(droneArgs(owner, drone, startLive(sim, drone, t0), t0)!.phase, '', 'a mission the drone is not flying is not its phase');
  assert.deepEqual([droneArgs(owner, drone, null, t0)!.transport, droneArgs(owner, { ...drone, transport: 'sms', lastSeen: t0 - 60_000 }, null, t0)], ['https', { ...droneArgs(owner, drone, null, t0)!, transport: 'sms' }], 'transport sets the sweep window; an SMS drone is fresh for 120 s');
  const fast = returnArgs(owner, { ...sim, rate: 4 }, t0), normal = returnArgs(owner, sim, t0);
  assert.ok(normal.etaSeconds > 0 && Math.abs(fast.etaSeconds - normal.etaSeconds / 4) <= 1, 'ETA in real seconds at the playback rate');
  assert.ok(normal.progress >= 0 && normal.progress <= 1);
  const flight = await flightKey(secret, sim.id);
  assert.equal(simFlightArgs(flight, startLive(sim, drone, t0), t0), null, 'a live flight is not a simulated one');
  assert.equal(simFlightArgs(flight, { ...sim, drone: { ...sim.drone!, id: 'made-up' } }, t0), null, 'only the demo fleet appears publicly');
  assert.equal(simFlightArgs(flight, { ...sim, drone: undefined }, t0), null);
  assert.equal(simFlightArgs(flight, sim, t0)!.done, false);
  assert.deepEqual(simFlightArgs(flight, { ...sim, cancelled: true }, t0), { flightKey: flight, droneId: sim.drone!.id, state: 'CANCELLED', done: true });
  assert.equal(simFlightArgs(flight, { ...sim, loaded: true }, t0 + 3600_000)!.state, 'COMPLETED');
  assert.equal(activeReturns([sim, { ...sim, cancelled: true }, { ...sim, loaded: true, anchor: t0 - 3600_000 }, { id: 'broken' } as ReturnRecord], t0), 1);
});

test('the viewer grant takes only a well-formed identity and token, and sends the identity in SpacetimeDB form', () => {
  assert.deepEqual(parseGrant(JSON.stringify({ identity: viewer, token: 'abc.def.ghi-jkl_mno' })), { identity: viewer, token: 'abc.def.ghi-jkl_mno', account: null });
  assert.equal(parseGrant(JSON.stringify({ identity: viewer, token: 'abc.def.ghi-jkl_mno', account: 'a'.repeat(32) }))?.account, 'a'.repeat(32));
  for (const account of ['A'.repeat(32), 'a'.repeat(31), '../x', 7]) assert.equal(parseGrant(JSON.stringify({ identity: viewer, token: 'abc.def.ghi-jkl_mno', account }))?.account, null, String(account));
  assert.equal(parseGrant(JSON.stringify({ identity: `0x${viewer.toUpperCase()}`, token: 'abc.def.ghi-jkl_mno' }))?.identity, viewer);
  for (const bad of [{ identity: viewer.slice(2), token: 'abc.def.ghi-jkl_mno' }, { identity: viewer }, { identity: viewer, token: 'abc.def\r\nX-Evil: 1' }, { identity: viewer, token: 'short' }, null]) assert.equal(parseGrant(JSON.stringify(bad)), null);
  assert.equal(parseGrant('not json'), null);
  assert.deepEqual(grantArgs(viewer, 'k'), { viewer: { __identity__: `0x${viewer}` }, ownerKey: 'k' });
});

type Call = { url: string; init: RequestInit };
const fake = (answer: (call: Call) => Promise<Response>) => { const calls: Call[] = []; return { calls, fetch: (url: string, init: RequestInit) => { calls.push({ url, init }); return answer({ url, init }); } }; };

test('callReducer posts named arguments with the Worker token and never throws', async () => {
  const ok = fake(async () => new Response(null, { status: 200 }));
  assert.equal(await callReducer(cfg, 'upsert_drone', { droneId: 'd1', lat: 1 }, ok.fetch), true);
  const [{ url, init }] = ok.calls, headers = new Headers(init.headers);
  assert.equal(url, 'http://127.0.0.1:3000/v1/database/aero-fleet-test/call/upsert_drone?confirmed=false');
  assert.equal(init.method, 'POST'); assert.equal(headers.get('authorization'), `Bearer ${cfg.token}`); assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(init.body)), { droneId: 'd1', lat: 1 });
  assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted, 'every call carries its own timeout');
  assert.equal(await callReducer(cfg, 'upsert_drone', {}, fake(async () => new Response('forbidden', { status: 530 })).fetch), false, 'SenderError');
  assert.equal(await callReducer(cfg, 'upsert_drone', {}, fake(async () => { throw new TypeError('network down'); }).fetch), false);
  const hang = fake(({ init }) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
  const started = Date.now();
  assert.equal(await callReducer(cfg, 'upsert_drone', {}, hang.fetch, 20), false, 'a hung server times out');
  assert.ok(Date.now() - started < 1000);
});

test('verifyIdentity maps 204 to ok, 400 and 401 to refused, anything else to unavailable', async () => {
  for (const [status, expected] of [[204, 'ok'], [400, 'refused'], [401, 'refused'], [500, 'unavailable'], [404, 'unavailable']] as const) {
    const f = fake(async () => new Response(null, { status }));
    assert.equal(await verifyIdentity(cfg, viewer, 'abc.def.ghi-jkl_mno', f.fetch), expected, String(status));
    assert.equal(f.calls[0].url, `http://127.0.0.1:3000/v1/identity/${viewer}/verify`);
    assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), 'Bearer abc.def.ghi-jkl_mno', 'the browser token, not the Worker token');
  }
  assert.equal(await verifyIdentity(cfg, viewer, 'abc.def.ghi-jkl_mno', fake(async () => { throw new Error('timeout'); }).fetch), 'unavailable');
  const never = fake(async () => new Response(null, { status: 204 }));
  assert.equal(await verifyIdentity(cfg, '../admin', 'abc.def.ghi-jkl_mno', never.fetch), 'refused');
  assert.equal(never.calls.length, 0, 'a malformed identity never reaches the URL');
});

test('publish hooks are fire-and-forget, do nothing while sync is off, and the sync code never logs', () => {
  for (const file of ['lib/drone-server.ts', 'lib/server.ts', 'app/api/account/route.ts']) {
    const source = readFileSync(file, 'utf8');
    assert.ok(/\b(publishDrone|publishReport|publishReturn|publishAccount|removeDrone)\(/.test(source), `${file} has its hook`);
    assert.doesNotMatch(source, /await\s+(publishDrone|publishReport|publishReturn|publishAccount|removeDrone)\b/, `${file} awaits a publish`);
  }
  assert.equal(readFileSync('lib/drone-server.ts', 'utf8').match(/publishReport\(db, drone, fresh\);/g)?.length, 2, 'HTTPS and SMS reports publish only what changed');
  const server = readFileSync('lib/spacetime-server.ts', 'utf8');
  assert.match(server, /function later\(work: \(cfg: SyncConfig\) => Promise<unknown>\) \{\n  const cfg = liveSync\(\); if \(!cfg\) return;\n  try \{ waitUntil\(work\(cfg\)\.catch\(\(\) => \{\}\)\); \} catch/, 'off: no work, no waitUntil; on: nothing it does can throw into the request');
  for (const file of ['lib/spacetime-sync.ts', 'lib/spacetime-server.ts', 'app/api/live-sync/route.ts']) assert.doesNotMatch(readFileSync(file, 'utf8'), /console\./, file);
});

test('an idle drone publishes only when its stored report moved; a drone on a mission, or one whose mission just ended, every time', () => {
  const idle = { lastSeen: t0, activeReturn: null };
  assert.equal(droneChanged(idle, idle), false, 'a report the Worker did not store (GROUND_WRITE_MS) sends nothing');
  assert.equal(droneChanged(idle, { ...idle, lastSeen: t0 + 5000 }), true);
  assert.equal(droneChanged({ ...idle, activeReturn: 'r1' }, { ...idle, activeReturn: 'r1' }), true);
  assert.equal(droneChanged({ ...idle, activeReturn: 'r1' }, idle), true, 'the final state of a flight that just ended');
});

test('the grant verifies the token first, revokes an identity that belonged to another account, and answers without the token', async () => {
  const token = 'abc.def.ghi-jkl_mno', key = 'a'.repeat(32), other = 'b'.repeat(32);
  const server = (verify: number, call = 200) => fake(async ({ url }) => new Response(null, { status: url.includes('/verify') ? verify : call }));
  const reducers = (f: ReturnType<typeof fake>) => f.calls.filter(c => c.url.includes('/call/')).map(c => [c.url.match(/call\/(\w+)/)![1], JSON.parse(String(c.init.body))]);
  let accounts = 0; const account = async () => { accounts++; };
  const ok = server(204), granted = await grantFlow(cfg, key, viewer, token, null, account, ok.fetch);
  assert.deepEqual(granted, { status: 'granted', account: key });
  assert.deepEqual(reducers(ok), [['grant_viewer', { viewer: { __identity__: `0x${viewer}` }, ownerKey: key }]]); assert.equal(accounts, 1);
  assert.deepEqual(await grantFlow(cfg, key, viewer, token, key, account, server(204).fetch), { status: 'granted', account: key }, 'same account again: renewed');
  const moved = server(204), rotated = await grantFlow(cfg, key, viewer, token, other, account, moved.fetch);
  assert.deepEqual(rotated, { status: 'rotate' });
  assert.deepEqual(reducers(moved), [['revoke_viewer', { viewer: { __identity__: `0x${viewer}` } }]], 'revoked, never re-granted to the new account'); assert.equal(accounts, 2);
  const refused = server(401); assert.deepEqual(await grantFlow(cfg, key, viewer, token, other, account, refused.fetch), { status: 'refused' });
  assert.deepEqual(reducers(refused), [], 'an unverified identity cannot grant or revoke anything');
  assert.deepEqual(await grantFlow(cfg, key, viewer, token, null, account, server(204, 530).fetch), { status: 'unavailable' }, 'the module refused the write');
  assert.deepEqual(await grantFlow(cfg, key, viewer, token, null, async () => { throw new Error('D1 down'); }, server(204).fetch), { status: 'granted', account: key }, 'the account row is best effort');
  const replies = (['granted', 'rotate', 'refused', 'unavailable'] as const).map(status => grantReply(status === 'granted' ? { status, account: key } : { status }));
  assert.deepEqual(replies.map(r => r.status), [200, 409, 403, 502]);
  assert.deepEqual(replies[0].body, { granted: true, account: key });
  assert.equal(replies[1].body.rotate, true);
  for (const r of replies) assert.ok(!JSON.stringify(r.body).includes(token) && !JSON.stringify(r.body).includes(cfg.token));
});

test('the module: only the Worker writes, no table is public, and the owner views filter by the viewer grant', () => {
  const source = readFileSync('spacetime/src/index.ts', 'utf8');
  const tables = [...source.matchAll(/= table\(\{ name: '(\w+)'([^}]*)\}/g)];
  assert.deepEqual(tables.map(m => m[1]).sort(), ['account_session', 'fleet_drone', 'return_status', 'sim_flight', 'sweep_schedule', 'viewer_grant']);
  for (const [, name, opts] of tables) assert.doesNotMatch(opts, /public/, `${name} must stay private`);
  const reducers = [...source.matchAll(/export const (\w+) = spacetimedb\.reducer\(([\s\S]*?)\n\}\);/g)];
  assert.deepEqual(reducers.map(m => m[1]).sort(), ['grantViewer', 'removeDrone', 'revokeViewer', 'sweep', 'upsertAccount', 'upsertDrone', 'upsertReturn', 'upsertSimFlight']);
  for (const [, name, body] of reducers) {
    if (name === 'sweep') { assert.match(body, /^\{ onSchedule: sweepSchedule \}/, 'sweep is scheduled, so no client can call it'); continue; }
    assert.match(body, /\(ctx, [^)]*\) => \{\n  onlyWorker\(ctx\);/, `${name} checks the sender first`);
  }
  assert.match(source, /if \(ctx\.sender\.toHexString\(\) !== ctx\.env\.WORKER_IDENTITY\.toLowerCase\(\)\) throw new SenderError\('forbidden'\);/);
  const views = [...source.matchAll(/export const \w+ = spacetimedb\.(view|anonymousView)\(\{ name: '(\w+)', public: true \}([\s\S]*?)\n(?:\}\);|\}\]\);)/g)];
  assert.deepEqual(views.map(m => `${m[1]}:${m[2]}`), ['view:my_account', 'view:my_fleet', 'view:my_returns', 'anonymousView:fleet_stats']);
  for (const [, kind, name, body] of views) {
    if (kind === 'anonymousView') { assert.doesNotMatch(body, /ownerKey|accountKey|droneId|flightKey|lat|lng/, `${name} returns counts only`); continue; }
    assert.match(body, /const g = ctx\.db\.viewerGrant\.viewer\.find\(ctx\.sender\)/, `${name} starts from the caller's grant`);
    assert.match(body, /g \?|g &&/, `${name} returns nothing without a grant`);
    assert.match(body, /g\.ownerKey/, `${name} reads only the granted owner's rows`);
  }
});
