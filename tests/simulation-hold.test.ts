import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookedReview, control, createReturn, DEMO_PACKAGE, heldForPerson, HOLD_MESSAGE, settle, snapshot, type Point, type ReturnRecord } from '../lib/simulation';
import { dispatchBlockers, type Drone } from '../lib/drone-mission';
import { merchantRow, needsPersonQueue } from '../lib/merchant';
import { initialView } from '../lib/request-flow';
import type { ReturnReview } from '../lib/return-agent-shared';

// RT-01: Claude's own measurements can rule a package out while the entered ones fit, and that check still attaches to the booking.
// A not_drone_eligible check must hold the return for a person exactly like needs_person, never fly unchecked.
const t0 = Date.UTC(2026, 9, 24, 18, 0), min = 60_000;
const check: ReturnReview = { verdict: 'not_drone_eligible', condition: 'new', disposition: 'restock', confidence: .92, explanation: 'The product page lists a 7 kg item, beyond every AERO drone.', model: 'claude-opus-5-5', eventId: '33333333-3333-4333-8333-333333333333', at: t0 };
// As lib/server.ts attaches it to a new booking: stamped with the hold.
const ruledOut = bookedReview(check);
const booked = (id = 'n1', review: ReturnReview = ruledOut): ReturnRecord => ({ ...createReturn({ ...DEMO_PACKAGE }, id, t0), review });
const home: Point = [-122.2595, 37.8719], pad: Point = [-122.2590, 37.8722], drop: Point = [-122.2585, 37.8716];
const drone: Drone = { id: 'tst002', owner: 'guest:x', name: 'Test X500', transport: 'https', phone: null, phoneVerified: false, keyVersion: 1, config: { home, pickupPad: pad, dropPad: drop, radius: 300, maxAlt: 60, cruiseAlt: 25 }, armedUntil: t0 + 30 * min, activeReturn: null, lastSeq: 0, lastSeen: t0, telemetry: null, createdAt: t0 };

test('a not-drone-eligible check holds the return like needs_person until a person decides', () => {
  assert.equal(heldForPerson(ruledOut), true);
  assert.equal(heldForPerson({ ...ruledOut, approvedAt: t0 }), false);
  assert.equal(heldForPerson({ ...ruledOut, declinedAt: t0 }), false);
  for (const verdict of ['fly_standard', 'fly_priority'] as const) assert.equal(heldForPerson({ ...ruledOut, verdict }), false, verdict);
  const r = booked();
  assert.equal(snapshot(r, t0 + 60 * min).state, 'ASSIGNED', 'the simulated drone never takes off on its own');
  assert.equal(snapshot(r, t0 + 60 * min).altitude, 0);
  assert.throws(() => control(r, 'advance', t0 + min), { message: HOLD_MESSAGE });
  assert.ok(dispatchBlockers(drone, r, t0).includes(HOLD_MESSAGE), 'nor can it be dispatched as a live flight');
});
test('the merchant desk queues it, and approve or decline work as for needs_person', () => {
  const row = merchantRow(booked(), t0 + 5 * min);
  assert.deepEqual([row.needsPerson, row.status], [true, 'On the ground until a person approves it']);
  assert.deepEqual(needsPersonQueue([row]).map(x => x.id), ['n1']);
  const approved = control(booked(), 'approve', t0 + 5 * min);
  assert.equal(approved.review?.approvedAt, t0 + 5 * min);
  assert.equal(snapshot(approved, t0 + 5 * min + 12_000).state, 'EN_ROUTE_TO_PICKUP', 'released from the moment a person approves');
  assert.ok(!dispatchBlockers(drone, approved, t0 + 5 * min).includes(HOLD_MESSAGE));
  const declined = control(booked('n2'), 'decline', t0 + min);
  assert.equal(snapshot(declined, t0 + 2 * min).state, 'CANCELLED');
  assert.equal(merchantRow(declined, t0 + 2 * min).status, 'Declined for drone pickup by a person');
  assert.equal(heldForPerson(control(declined, 'reset', t0 + 3 * min).review), true, 'a reset waits for a person again');
});
test('the server stamps the hold on checks that hold a booking, and only those', () => {
  assert.equal(ruledOut.hold, true);
  assert.equal(bookedReview({ ...check, verdict: 'needs_person' }).hold, true);
  for (const verdict of ['fly_standard', 'fly_priority'] as const) assert.equal('hold' in bookedReview({ ...check, verdict }), false, verdict);
  assert.equal(heldForPerson({ ...check, verdict: 'needs_person' }), true, 'needs_person always held, stamp or not');
});
test('the hold never applies retroactively: a not-eligible check stored before the rule keeps the state its return reached', () => {
  // Booked, flown and delivered while a not_drone_eligible check did not hold anything: no hold stamp on the stored review.
  const fly = (id: string) => { let r = control(createReturn({ ...DEMO_PACKAGE }, id, t0, null), 'advance', t0 + 1000); r = control(r, 'load', t0 + 2000); return { ...r, review: check }; };
  const delivered = (() => { let r: ReturnRecord = fly('old'); for (let i = 0; i < 3; i++) r = control(r, 'advance', t0 + 3000); return r; })();
  assert.equal(heldForPerson(delivered.review), false);
  const later = t0 + 24 * 60 * min;
  assert.equal(snapshot(settle(delivered, later), later).state, 'COMPLETED');
  assert.equal(initialView([delivered], undefined, later), 'home', 'the home screen opens, not a return waiting for a person');
  const row = merchantRow(delivered, later);
  assert.deepEqual([row.stage, row.needsPerson], ['Received', false]); assert.deepEqual(needsPersonQueue([row]), []);
  assert.throws(() => control(delivered, 'approve', later), /has ended/, 'nothing to approve, so it cannot fly a second time');
  // One still in flight keeps flying as booked, and approve has nothing to release.
  const flying = fly('mid');
  assert.equal(snapshot(flying, t0 + 2000 + 30_000).state, 'EN_ROUTE_TO_DROPOFF');
  assert.throws(() => control(flying, 'approve', t0 + 5000), { message: 'This return is not waiting for a person.' });
  assert.ok(!dispatchBlockers(drone, { ...createReturn({ ...DEMO_PACKAGE }, 'u1', t0), review: check }, t0).includes(HOLD_MESSAGE));
});
