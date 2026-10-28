import { test } from 'node:test';
import assert from 'node:assert/strict';
import { control, createReturn, DEMO_PACKAGE, heldForPerson, HOLD_MESSAGE, snapshot, type Point, type ReturnRecord } from '../lib/simulation';
import { dispatchBlockers, type Drone } from '../lib/drone-mission';
import { merchantRow } from '../lib/merchant';
import type { ReturnReview } from '../lib/return-agent-shared';

const t0 = Date.UTC(2026, 9, 24, 17, 0), min = 60_000;
const flag: ReturnReview = { verdict: 'needs_person', condition: 'unknown', disposition: 'inspect', confidence: .6, explanation: 'The photo is too blurry to judge.', model: 'claude-opus-5-5', eventId: '22222222-2222-4222-8222-222222222222', at: t0 };
const held = (id = 'h1', review: ReturnReview = flag): ReturnRecord => ({ ...createReturn({ ...DEMO_PACKAGE }, id, t0), review });
const home: Point = [-122.2595, 37.8719], pad: Point = [-122.2590, 37.8722], drop: Point = [-122.2585, 37.8716];
const drone: Drone = { id: 'tst001', owner: 'guest:x', name: 'Test X500', transport: 'https', phone: null, phoneVerified: false, keyVersion: 1, config: { home, pickupPad: pad, dropPad: drop, radius: 300, maxAlt: 60, cruiseAlt: 25 }, armedUntil: t0 + 30 * min, activeReturn: null, lastSeq: 0, lastSeen: t0, telemetry: null, createdAt: t0 };

test('an undecided needs_person verdict holds a return (not_drone_eligible too: tests/simulation-hold.test.ts)', () => {
  assert.equal(heldForPerson(flag), true);
  assert.equal(heldForPerson({ ...flag, approvedAt: t0 }), false);
  assert.equal(heldForPerson({ ...flag, declinedAt: t0 }), false);
  assert.equal(heldForPerson({ ...flag, verdict: 'fly_standard' }), false);
  assert.equal(heldForPerson(undefined), false);
});
test('a held return stays on the ground however much time passes, and cannot be skipped ahead', () => {
  const r = held();
  assert.equal(snapshot(r, t0 + 60 * min).state, 'ASSIGNED');
  assert.equal(snapshot(r, t0 + 60 * min).altitude, 0);
  assert.throws(() => control(r, 'advance', t0 + min), { message: HOLD_MESSAGE });
  assert.equal(snapshot(control(r, 'speed', t0 + min, 10), t0 + 60 * min).state, 'ASSIGNED', 'demo speed does not release the hold');
});
test('approving releases the hold from the moment of approval', () => {
  const approved = control(held(), 'approve', t0 + 5 * min);
  assert.equal(approved.review?.approvedAt, t0 + 5 * min);
  assert.equal(snapshot(approved, t0 + 5 * min + 2000).state, 'ASSIGNED');
  assert.equal(snapshot(approved, t0 + 5 * min + 12_000).state, 'EN_ROUTE_TO_PICKUP');
  assert.throws(() => control(approved, 'approve', t0 + 6 * min), /not waiting for a person/);
});
test('declining cancels the pickup and says who decided', () => {
  const declined = control(held(), 'decline', t0 + min);
  assert.equal(snapshot(declined, t0 + 2 * min).state, 'CANCELLED');
  const row = merchantRow(declined, t0 + 2 * min);
  assert.deepEqual([row.stage, row.status, row.needsPerson, row.declinedAt], ['Cancelled', 'Declined for drone pickup by a person', false, t0 + min]);
});
test('a declined return that is reset waits for a person again', () => {
  const again = control(control(held(), 'decline', t0 + min), 'reset', t0 + 2 * min);
  assert.equal(heldForPerson(again.review), true);
  assert.equal(merchantRow(again, t0 + 3 * min).needsPerson, true);
});
test('approve and decline only apply to a held return', () => {
  assert.throws(() => control(held('h2', { ...flag, verdict: 'fly_standard' }), 'approve', t0 + min), /not waiting for a person/);
  assert.throws(() => control(createReturn({ ...DEMO_PACKAGE }, 'h3', t0), 'decline', t0 + min), /not waiting for a person/);
});
test('the merchant desk shows a held return as on the ground', () => {
  const row = merchantRow(held(), t0 + 30 * min);
  assert.deepEqual([row.stage, row.status, row.needsPerson], ['Booked', 'On the ground until a person approves it', true]);
});
test('live dispatch is blocked until a person approves the return', () => {
  assert.ok(dispatchBlockers(drone, held(), t0).includes(HOLD_MESSAGE));
  assert.ok(!dispatchBlockers(drone, control(held(), 'approve', t0), t0).includes(HOLD_MESSAGE));
  assert.ok(!dispatchBlockers(drone, createReturn({ ...DEMO_PACKAGE }, 'h4', t0), t0).includes(HOLD_MESSAGE));
});
