import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendTrail, commandRequestSchema, formatToken, nextCommand, parseToken, preflight, sameHex, sha256Hex, smsCode, smsText, syncSchema, type Telemetry } from '../lib/drone-protocol';
import type { Point } from '../lib/simulation';

const now = 1_800_000_000_000, home: Point = [-122.2585, 37.8719];
const telemetry = (over: Partial<Telemetry> = {}): Telemetry => ({ lat: home[1], lng: home[0], altM: 0, headingDeg: 0, groundSpeedMs: 0, batteryPct: 90, gpsFix: 3, satellites: 12, armed: false, mode: 'GUIDED', state: 'landed', flightAllowed: true, link: '4g', simulated: false, payload: 'unknown', ...over });
const drone = (over = {}) => ({ home, geofenceM: 500, maxAltM: 40, lastSeen: now - 1000, telemetry: telemetry(), ...over });
const north = (m: number): Point => [home[0], home[1] + m / 111_195];
const route = (over = {}) => ({ waypoints: [north(200)], altM: 30, speedMs: 6, land: true, release: false, ...over });

test('preflight accepts a short flight inside the safety zone', () => {
  assert.equal(preflight(drone(), route(), now), null);
  assert.equal(preflight(drone(), route({ waypoints: [north(100), north(300)] }), now), null);
});
test('preflight refuses offline, observe-only, poor GPS, low battery and error states', () => {
  assert.match(preflight(drone({ lastSeen: now - 60_000 }), route(), now)!, /offline/);
  assert.match(preflight(drone({ telemetry: null }), route(), now)!, /offline/);
  assert.match(preflight(drone({ telemetry: telemetry({ flightAllowed: false }) }), route(), now)!, /observe-only/);
  assert.match(preflight(drone({ telemetry: telemetry({ gpsFix: 2 }) }), route(), now)!, /GPS/);
  assert.match(preflight(drone({ telemetry: telemetry({ batteryPct: 22 }) }), route(), now)!, /Battery/);
  assert.match(preflight(drone({ telemetry: telemetry({ state: 'error' }) }), route(), now)!, /error/);
  assert.match(preflight(drone({ home: null }), route(), now)!, /home/);
});
test('preflight enforces altitude, geofence and route length limits', () => {
  assert.match(preflight(drone(), route({ altM: 60 }), now)!, /altitude/i);
  assert.match(preflight(drone(), route({ waypoints: [north(800)] }), now)!, /Point B is outside the 500 m/);
  assert.match(preflight(drone(), route({ waypoints: [north(900), north(100)] }), now)!, /Point A is outside/);
  assert.match(preflight(drone({ telemetry: telemetry({ lat: north(900)[1] }) }), route(), now)!, /drone is outside/);
  const zigzag = Array.from({ length: 10 }, (_, i) => north(i % 2 ? 490 : -490));
  assert.match(preflight(drone({ geofenceM: 500 }), route({ waypoints: zigzag }), now)!, /km/);
});
test('flight commands require a pilot to be watching', () => {
  assert.equal(commandRequestSchema.safeParse({ type: 'FLY_ROUTE', params: route() }).success, false);
  assert.equal(commandRequestSchema.safeParse({ type: 'FLY_ROUTE', params: route(), pilotReady: true }).success, true);
  assert.equal(commandRequestSchema.safeParse({ type: 'LAND' }).success, true);
  assert.equal(commandRequestSchema.safeParse({ type: 'FLY_ROUTE', params: route({ altM: 500 }), pilotReady: true }).success, false);
});
test('safety commands always run before a waiting flight; expired commands never run', () => {
  const c = (id: string, type: string, createdAt: number, status = 'queued', expiresAt = now + 10_000) => ({ id, type, createdAt, status, expiresAt });
  assert.equal(nextCommand([c('fly', 'FLY_ROUTE', now), c('land', 'LAND', now - 5000)], now)?.id, 'land');
  assert.equal(nextCommand([c('old', 'FLY_ROUTE', now - 5), c('new', 'FLY_ROUTE', now)], now)?.id, 'new');
  assert.equal(nextCommand([c('gone', 'HOLD', now - 1, 'queued', now - 1)], now), null);
  assert.equal(nextCommand([c('done', 'HOLD', now, 'sent')], now), null);
});
test('telemetry is validated and trails skip jitter', () => {
  assert.equal(syncSchema.safeParse({ telemetry: telemetry() }).success, true);
  assert.equal(syncSchema.safeParse({ telemetry: telemetry({ lat: 95 }) }).success, false);
  assert.equal(syncSchema.safeParse({ telemetry: { ...telemetry(), batteryPct: 140 } }).success, false);
  const trail = appendTrail(appendTrail([], home), [home[0] + 1e-6, home[1]]);
  assert.equal(trail.length, 1);
  assert.equal(appendTrail(trail, north(10)).length, 2);
});
test('device tokens parse strictly and compare by hash', async () => {
  const id = '6f1c2a54-9a0e-4c1e-9a55-0d6a4a4e8b10', secret = 'a'.repeat(64);
  assert.deepEqual(parseToken(`Bearer ${formatToken(id, secret)}`), { droneId: id, secret });
  assert.equal(parseToken(`Bearer aero_${id}.short`), null);
  assert.equal(parseToken(null), null);
  const hash = await sha256Hex(secret);
  assert.equal(hash.length, 64); assert.ok(sameHex(hash, await sha256Hex(secret))); assert.ok(!sameHex(hash, await sha256Hex('b'.repeat(64))));
});
test('SMS codes bind drone, command and time window', async () => {
  const key = await sha256Hex('c'.repeat(64)), id = '6f1c2a54-9a0e-4c1e-9a55-0d6a4a4e8b10';
  const code = await smsCode(key, id, 'LAND', 6_000_000);
  assert.match(code, /^\d{8}$/);
  assert.equal(code, await smsCode(key, id, 'LAND', 6_000_000));
  assert.notEqual(code, await smsCode(key, id, 'RTL', 6_000_000));
  assert.notEqual(code, await smsCode(key, id, 'LAND', 6_000_001));
  assert.notEqual(code, await smsCode(key, 'other', 'LAND', 6_000_000));
  assert.match(await smsText(key, id, 'GOTO', ['37.872000', '-122.258500', '30'], now), /^AERO GOTO 37\.872000 -122\.258500 30 \d{8}$/);
});
// Shared vector with drone-agent/test_agent.py so both sides compute identical codes.
test('SMS code matches the drone agent test vector', async () => {
  assert.equal(await smsCode(await sha256Hex('c'.repeat(64)), '6f1c2a54-9a0e-4c1e-9a55-0d6a4a4e8b10', 'LAND', 6_000_000), '60398080');
});
