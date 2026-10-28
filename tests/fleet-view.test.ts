import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ago, awayOnGround, bridgeCommand, dispatchChoices, pickupPreview, serverNow } from '../lib/fleet-view';
import { droneGoneError, enterPhase, fleetInputError, pickupFor, startLive, type Drone } from '../lib/drone-mission';
import { control, createReturn, DEMO_PACKAGE, distance, HOLD_MESSAGE, type Point, type ReturnRecord } from '../lib/simulation';
import type { ReturnReview } from '../lib/return-agent-shared';

const t0 = Date.UTC(2026, 9, 24, 17, 0), min = 60_000;
const home: Point = [-122.2595, 37.8719], pad: Point = [-122.2590, 37.8722], drop: Point = [-122.2585, 37.8716];
const drone: Drone = { id: 'tst001', owner: 'guest:x', name: 'Test X500', transport: 'https', phone: null, phoneVerified: false, keyVersion: 1, config: { home, pickupPad: pad, dropPad: drop, radius: 300, maxAlt: 90, cruiseAlt: 75 }, armedUntil: t0 + min, activeReturn: null, lastSeq: 0, lastSeen: t0, telemetry: null, createdAt: t0 };
const flag: ReturnReview = { verdict: 'needs_person', condition: 'unknown', disposition: 'inspect', confidence: .6, explanation: 'Blurry photo.', model: 'claude-opus-5-5', eventId: '22222222-2222-4222-8222-222222222222', at: t0 };
const book = (id: string, review?: ReturnReview): ReturnRecord => ({ ...createReturn({ ...DEMO_PACKAGE }, id, t0), ...(review ? { review } : {}) });

test('ages read in seconds, then whole minutes, hours and days', () => {
  assert.equal(ago(0, t0), 'never'); assert.equal(ago(t0, t0 + 500), 'just now'); assert.equal(ago(t0, t0 + 45_000), '45s ago');
  assert.equal(ago(t0, t0 + 59.9 * min), '59 min ago', 'never rounds up to "60 min"');
  assert.equal(ago(t0, t0 + 320 * min), '5 h ago'); assert.equal(ago(t0, t0 + 50 * 60 * min), '2 d ago');
});

test('a last-known telemetry age keeps counting while the console is offline', () => {
  // The last answer came at server time t0 + 1 s, when the drone was seen at t0; the device received it at its own time 5000.
  const serverAt = t0 + 1000, receivedAt = 5000;
  assert.equal(ago(t0, serverNow(serverAt, receivedAt, 5000)), 'just now', 'no time passed since that answer');
  assert.equal(ago(t0, serverNow(serverAt, receivedAt, 5000 + 44_000)), '45s ago');
  assert.equal(ago(t0, serverNow(serverAt, receivedAt, 5000 + 10 * min)), '10 min ago', 'not frozen at the last poll');
  assert.equal(serverNow(serverAt, receivedAt, 1000), serverAt, 'a tick from before that answer never moves the clock back');
});

test('Fleet lists held returns as blocked, separately from the ones it can dispatch', () => {
  const ready = book('r1'), held = book('h1', flag), approved = book('a1', { ...flag, approvedAt: t0 + min });
  const loaded = control(control(book('l1'), 'advance', t0 + 1000), 'load', t0 + 2000), cancelled = control(book('c1'), 'cancel', t0 + 1000);
  const flying = enterPhase(startLive(book('f1'), drone, t0), 'TO_PICKUP', t0 + min, 1);
  const choices = dispatchChoices([ready, held, approved, loaded, cancelled, flying], t0 + 3000);
  assert.deepEqual(choices.ready.map(r => r.id), ['r1', 'a1']);
  assert.deepEqual(choices.held.map(r => r.id), ['h1']);
  assert.match(HOLD_MESSAGE, /merchant desk/, 'the server still refuses a held return with the same message');
});

test('the dry-run bridge command carries the drone’s fence and altitude limits, like the MAVLink one', () => {
  const lines = bridgeCommand(drone, 'https://aero.example', 'k'.repeat(64)).split('\n');
  const fake = lines.slice(lines.findIndex(l => l.includes('--vehicle fake'))).slice(0, 2).join(' '), mavlink = lines.slice(lines.findIndex(l => l.includes('--vehicle mavlink'))).slice(0, 2).join(' ');
  for (const line of [fake, mavlink]) for (const flag of ['--fence-radius 300', '--max-alt 90', '--cruise-alt 75']) assert.ok(line.includes(flag), `${flag} in ${line}`);
  assert.match(fake, /--fake-home 37\.871900,-122\.259500 .*--fence-center 37\.871900,-122\.259500 /); assert.match(mavlink, /--fence-center 37\.871900,-122\.259500 .* --live$/);
  assert.match(lines.join('\n'), /export AERO_DRONE_KEY=k{64}/);
});

test('rejected Fleet input reads as plain words, never as validator paths', () => {
  const point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
  const schema = z.object({ name: z.string().trim().min(1).max(40), home: point, dropPad: point.nullable(), radius: z.number() });
  const issues = (input: unknown) => { const r = schema.safeParse(input); assert.ok(!r.success); return r.error.issues; };
  // JSON turns the NaN from "abc" into null.
  assert.equal(fleetInputError(issues({ name: 'X500', home: [-122.2595, null], dropPad: null, radius: 300 })), 'Home latitude must be a number between -90 and 90.');
  assert.equal(fleetInputError(issues({ name: 'X500', home: [-200, 200], dropPad: null, radius: 300 })), 'Home longitude must be a number between -180 and 180. Home latitude must be a number between -90 and 90.');
  assert.equal(fleetInputError(issues({ name: ' ', home: [-122, 37], dropPad: [1], radius: null })), 'Give the drone a name of 1–40 characters. Drop pad needs a latitude and a longitude. Geofence radius must be a number in metres.');
  assert.equal(fleetInputError([{ path: ['action'], message: 'Invalid discriminator value' }]), 'Fleet did not understand that request. Reload the page and try again.');
  assert.doesNotMatch(fleetInputError(issues({ name: '', home: null, dropPad: null, radius: 1 })), /home\.|Expected|received/);
});

test('an action on a live return whose drone is gone explains why nothing changed', () => {
  const live = startLive(book('g1'), drone, t0);
  assert.equal(droneGoneError(enterPhase(live, 'COMPLETE', t0 + min, null).live!), 'This live flight has ended.');
  assert.equal(droneGoneError(enterPhase(live, 'ABORTED', t0 + min, null).live!), 'This live flight has ended.');
  assert.match(droneGoneError(live.live!), /no longer in the fleet, so nothing changed/);
});

test('the dispatch preview says where the drone goes and why', () => {
  const near: Point = [pad[0] + 0.0002, pad[1]], c = { ...drone.config, pinRadius: 60 };
  assert.equal(pickupPreview(pickupFor(c, near)), 'Flies to the customer’s pin, 18 m from the pickup pad, and hovers there. You land it from here once the area is clear.');
  assert.equal(pickupPreview(pickupFor(drone.config, near)), 'Uses the pickup pad. Pins are off for this drone.');
  assert.equal(pickupPreview(pickupFor(c, DEMO_PACKAGE.pickup)), 'Uses the pickup pad. Pin is 1.5 km from the pickup pad (zone 60 m).');
  assert.equal(pickupPreview(pickupFor({ ...c, pickupPad: null }, near)), 'Set a pickup pad first. It is the fallback for pins.');
});
test('a takeoff from the ground away from home is flagged so Fleet asks about people first', () => {
  const ground = { ts: t0, receivedAt: t0, lat: home[1], lon: home[0], alt: 0, battery: 90, heading: 0, speed: 0, fix: 3, sats: 12, state: 'LANDED', mode: 'GUIDED' };
  assert.equal(awayOnGround(home, ground), null, 'at home');
  assert.equal(awayOnGround(home, { ...ground, lat: drop[1], lon: drop[0] }), distance(home, drop), 'landed at the drop pad, about 94 m away');
  assert.equal(awayOnGround(home, { ...ground, lat: drop[1], lon: drop[0], alt: 25, state: 'HOLD' }), null, 'airborne: nothing takes off');
  assert.equal(awayOnGround(home, null), Infinity, 'no position: ask');
});
test('a pad set N m ahead of the nose lands N m away in the heading direction', async () => {
  const { pointAhead, compass } = await import('../lib/fleet-view');
  const { distance, bearing } = await import('../lib/simulation');
  const t = { lat: 37.5042, lon: -121.9644, heading: 87 };
  for (const m of [2, 5, 10]) {
    const p = pointAhead(t, m);
    assert.ok(Math.abs(distance([t.lon, t.lat], p) - m) < 0.05, `${m} m`);
    assert.ok(Math.abs(bearing([t.lon, t.lat], p) - 87) < 0.5);
  }
  assert.deepEqual([0, 44, 90, 180, 271, 359, -90].map(compass), ['N', 'NE', 'E', 'S', 'W', 'N', 'W']);
});
test('nudging a pad moves it 1 m in the chosen compass direction', async () => {
  const { pointOffset } = await import('../lib/fleet-view');
  const { distance, bearing } = await import('../lib/simulation');
  const p: Point = [-122.2595, 37.8719];
  for (const [n, e, dir] of [[1, 0, 0], [0, 1, 90], [-1, 0, 180], [0, -1, 270]] as const) {
    const q = pointOffset(p, n, e);
    assert.ok(Math.abs(distance(p, q) - 1) < 0.01);
    assert.ok(Math.abs(((bearing(p, q) - dir + 540) % 360) - 180) < 0.5);
  }
});
test('cruise altitude can go down to the bridge’s 2 m minimum, never below and never above the max', async () => {
  const { configProblem, LIMITS } = await import('../lib/drone-mission');
  const c = { home: [-122.2595, 37.8719] as Point, pickupPad: null, dropPad: null, radius: 300, maxAlt: 15, cruiseAlt: 2 };
  assert.equal(LIMITS.minCruise, 2);
  assert.equal(configProblem(c), null);
  assert.match(configProblem({ ...c, cruiseAlt: 1.9 })!, /Cruise altitude/);
  assert.match(configProblem({ ...c, cruiseAlt: 16 })!, /Cruise altitude/);
  assert.match(configProblem({ ...c, maxAlt: 1, cruiseAlt: 1 })!, /Maximum altitude/);
});
test('Street View links open Google Maps at the point (lat,lng order)', async () => {
  const { streetViewUrl } = await import('../lib/fleet-view');
  assert.equal(streetViewUrl([-122.448821, 37.804262]), 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=37.804262,-122.448821');
});
test('flight plan: three legs, a GPS corridor, the emergency return, and honest warnings', async () => {
  const { flightPlan, pointOffset } = await import('../lib/fleet-view');
  const home: Point = [-122.4488, 37.8043];
  const base = { home, pickupPad: pointOffset(home, 0, 40), dropPad: pointOffset(home, 40, 40), radius: 300, maxAlt: 15, cruiseAlt: 10 };
  assert.equal(flightPlan({ ...base, dropPad: null }), null);
  const p = flightPlan(base)!;
  assert.deepEqual(p.legs.map(l => `${l.from}>${l.to}`), ['Home>Pickup pad', 'Pickup pad>Drop pad', 'Drop pad>Home']);
  assert.ok(Math.abs(p.meters - (40 + 40 + Math.hypot(40, 40))) < 0.3);
  assert.equal(p.corridor.length, 3 + 3);
  assert.deepEqual(p.escapes, [[base.pickupPad, home]]);
  assert.deepEqual(p.warnings, []);
  // Last night's setup: 2 m cruise, pickup ~3 m from home, drop ~20 m away.
  const risky = flightPlan({ ...base, cruiseAlt: 2, pickupPad: pointOffset(home, 0, 3), dropPad: pointOffset(home, 0, 20) })!;
  assert.ok(risky.warnings.some(w => /below 5 m/.test(w)));
  assert.ok(risky.warnings.some(w => /Pickup pad is 3\.0 m from home, inside GPS error/.test(w)));
  assert.ok(risky.warnings.some(w => /Drop pad is 20 m from home: after landing there/.test(w)));
});
