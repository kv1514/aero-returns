/** HTTP checks for the live drone API against a running local app: node_modules/.bin/tsx scripts/drone-smoke.ts */
import assert from 'node:assert/strict';
import type { DroneView, Telemetry } from '../lib/drone-protocol';
const base = process.env.AERO_TEST_URL || 'http://127.0.0.1:5173';
type Reply = { status: number; data: { drone: DroneView; drones: DroneView[]; token: string; command: { id: string; type: string } | null; config: { home: [number, number] | null }; text: string; sent: boolean; error?: string } };
function client() {
  let cookie = '';
  return async (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });
    if (!cookie && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { status: response.status, data: await response.json() as Reply['data'] };
  };
}
const owner = client(), stranger = client(), friend = client();
const home: [number, number] = [-122.2585, 37.8719];
const north = (m: number): [number, number] => [home[0], home[1] + m / 111195];
const telemetry = (over: Partial<Telemetry> = {}): Telemetry => ({ lat: home[1], lng: home[0], altM: 0, headingDeg: 0, groundSpeedMs: 0, batteryPct: 95, gpsFix: 3, satellites: 12, armed: false, mode: 'GUIDED', state: 'landed', flightAllowed: true, link: '4g', simulated: true, ...over });

await owner('/api/drones'); await stranger('/api/drones'); await friend('/api/drones');
const created = await owner('/api/drones', 'POST', { name: 'Smoke Quad' });
assert.equal(created.status, 201, JSON.stringify(created.data));
const { token, drone } = created.data, path = `/api/drones/${drone.id}`;
assert.match(token, /^aero_[a-f0-9-]{36}\.[a-f0-9]{64}$/);
const sync = (acks: unknown[] = [], over: Partial<Telemetry> = {}, auth = token) => fetch(`${base}/api/drone/sync`, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ telemetry: telemetry(over), acks }) }).then(async r => ({ status: r.status, data: await r.json() as Reply['data'] }));

assert.equal((await sync([], {}, token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'))).status, 401, 'wrong secret is rejected');
assert.equal((await stranger(path)).status, 404, 'other accounts cannot see the drone');
assert.equal((await owner(path, 'PATCH', { name: 'x' }, { Origin: 'https://evil.example' })).status, 403, 'cross-origin writes are rejected');
assert.equal((await owner(`${path}/commands`, 'POST', { type: 'FLY_ROUTE', params: { waypoints: [north(100)], altM: 30 }, pilotReady: true })).status, 409, 'offline drone cannot fly');

let s = await sync();
assert.equal(s.status, 200); assert.deepEqual(s.data.config.home, home, 'first GPS fix becomes home'); assert.equal(s.data.command, null);
let view = (await owner(path)).data.drone;
assert.equal(view.online, true); assert.equal(view.telemetry?.batteryPct, 95);

assert.equal((await owner(`${path}/commands`, 'POST', { type: 'FLY_ROUTE', params: { waypoints: [north(100)], altM: 30 } })).status, 400, 'pilot confirmation required');
const far = await owner(`${path}/commands`, 'POST', { type: 'FLY_ROUTE', params: { waypoints: [north(900)], altM: 30 }, pilotReady: true });
assert.equal(far.status, 409); assert.match(far.data.error!, /outside/);
const fly = await owner(`${path}/commands`, 'POST', { type: 'FLY_ROUTE', params: { waypoints: [north(50), north(150)], altM: 30, speedMs: 6, land: true }, pilotReady: true });
assert.equal(fly.status, 201, JSON.stringify(fly.data));
const land = await owner(`${path}/commands`, 'POST', { type: 'LAND' });
assert.equal(land.status, 201);
s = await sync();
assert.equal(s.data.command?.type, 'LAND', 'safety commands replace a waiting flight');
const landId = s.data.command!.id;
assert.equal((await sync()).data.command, null, 'a command is delivered once');
await sync([{ commandId: landId, status: 'done', message: 'Landed.' }]);
view = (await owner(path)).data.drone;
assert.equal(view.commands.find(c => c.id === landId)?.status, 'done');
assert.equal(view.commands.find(c => c.type === 'FLY_ROUTE' && c.status === 'superseded')?.type, 'FLY_ROUTE');

const fly2 = await owner(`${path}/commands`, 'POST', { type: 'FLY_ROUTE', params: { waypoints: [north(120)], altM: 25 }, pilotReady: true });
s = await sync([], { batteryPct: 95 });
assert.equal(s.data.command?.id, (fly2.data as unknown as { commandId: string }).commandId);
assert.equal((await owner(`${path}/commands`, 'POST', { type: 'FLY_ROUTE', params: { waypoints: [north(120)], altM: 25 }, pilotReady: true })).status, 201);
await sync([], { batteryPct: 20 });
const low = await owner(`${path}/commands`, 'POST', { type: 'FLY_ROUTE', params: { waypoints: [north(120)], altM: 25 }, pilotReady: true });
assert.equal(low.status, 409); assert.match(low.data.error!, /Battery/);

const shared = await owner(`${path}/share`, 'POST', {});
const code = shared.data.drone.pilotCode!;
assert.match(code, /^[A-Z2-9]{6}$/);
assert.equal((await friend('/api/drones/join', 'POST', { code: 'ZZZZZZ' })).status, 404);
const joined = await friend('/api/drones/join', 'POST', { code: code.toLowerCase() });
assert.equal(joined.status, 200); assert.equal(joined.data.drone.role, 'pilot'); assert.equal(joined.data.drone.pilotCode, null, 'pilots never see the share code');
assert.equal((await friend(`${path}/commands`, 'POST', { type: 'HOLD' })).status, 201, 'pilots can send commands');
assert.equal((await friend(path, 'PATCH', { geofenceM: 3000 })).status, 403, 'pilots cannot change limits');
await owner(`${path}/share`, 'POST', { revoke: true });
assert.equal((await friend(path)).status, 404, 'revoking removes pilots');

const sms = await owner(`${path}/sms`, 'POST', { command: 'LAND' });
assert.equal(sms.status, 200); assert.match(sms.data.text, /^AERO LAND \d{8}$/); assert.equal(sms.data.sent, false);
assert.equal((await owner(path, 'PATCH', { phone: '555' })).status, 400);
assert.equal((await owner(path, 'PATCH', { phone: '+14155550123', geofenceM: 800, maxAltM: 60 })).data.drone.geofenceM, 800);

const rotated = await owner(`${path}/token`, 'POST', {});
assert.equal((await sync()).status, 401, 'old token stops working after rotation');
assert.equal((await sync([], {}, rotated.data.token)).status, 200);
assert.equal((await owner(path, 'DELETE')).status, 200);
assert.equal((await owner(path)).status, 404);
console.log('Drone API smoke checks passed.');
