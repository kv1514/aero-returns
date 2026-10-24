import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReturn, DEMO_PACKAGE, type LiveFlight, type MissionPhase, type ReturnRecord } from '../lib/simulation';
import { checkLabel, historyPlace, HOVER_COPY, pickupNote } from '../lib/request-flow';
import { pickupLabel, routeWords } from '../components/drone';
import { statusBarColor } from '../components/accessibility';
import type { ReturnReview } from '../lib/return-agent-shared';

const t0 = Date.UTC(2026, 9, 24, 19, 0), pin = DEMO_PACKAGE.pickup;
const sim = createReturn(DEMO_PACKAGE, 'c1', t0);
/** A live return at one mission phase, landing at the customer's pin or the operator's pad. */
function live(phase: MissionPhase, pickupSource: LiveFlight['pickupSource'], loaded = false): ReturnRecord {
  const flight: LiveFlight = { droneId: 'd1', droneName: 'Test X500', transport: 'https', phase, home: [pin[0] - .004, pin[1] - .003], pickupPad: pin, pickupSource, dropPad: [pin[0] + .006, pin[1] + .004], cruiseAlt: 40, cmdSeq: 1, fault: null, startedAt: t0, phaseAt: t0 };
  return { ...sim, loaded, live: flight };
}

test('the tracking sheet says where a live drone picks up: the customer’s pin (after the pilot clears it) or the operator’s pad', () => {
  assert.equal(pickupNote(sim, t0), 'Berkeley, CA');
  for (const phase of ['TO_PICKUP', 'HOVER_PICKUP'] as const) assert.equal(pickupNote(live(phase, 'pin'), t0), 'Your pin · the drone lands here once the pilot confirms the area is clear', phase);
  assert.equal(pickupNote(live('AWAITING_LOAD', 'pin'), t0), 'Your pin · the drone waits here for your package');
  assert.equal(pickupNote(live('TO_DROP', 'pin', true), t0), 'Picked up at your pin', 'past tense once loaded');
  assert.equal(pickupNote(live('ABORTED', 'pin'), t0), 'Your pin', 'an ended flight never promises a landing');
  for (const r of [live('TO_PICKUP', 'pad'), live('TO_DROP', 'pad', true), live('TO_PICKUP', undefined)]) assert.equal(pickupNote(r, t0), 'Pickup pad set by the operator');
  assert.deepEqual(HOVER_COPY, { headline: 'Your drone is overhead', subline: 'The pilot lands it when the area is clear.', courier: 'Hovering overhead' });
});

test('map markers call a live pin pickup “Your pin”, a pad “Pickup pad”, and a simulation keeps “Your pickup”', () => {
  assert.deepEqual([pickupLabel(sim), pickupLabel(null), pickupLabel(live('TO_PICKUP', 'pin')), pickupLabel(live('TO_PICKUP', 'pad')), pickupLabel(live('TO_PICKUP', undefined))], ['Your pickup', 'Your pickup', 'Your pin', 'Pickup pad', 'Pickup pad']);
  assert.equal(routeWords(live('HOVER_PICKUP', 'pin')).pickup, 'Your pin', 'the offline schematic uses the same label');
});

test('history never shows the simulated hub for a live return, and says which kind each row is', () => {
  assert.equal(historyPlace(live('COMPLETE', 'pin', true)), 'Drop pad · Live flight');
  assert.equal(historyPlace(sim), 'AERO Downtown Hub · Simulated');
});

test('after a person decides a held return, the customer sees that decision instead of “A person needs to check”', () => {
  const review: ReturnReview = { verdict: 'needs_person', condition: 'unknown', disposition: 'inspect', confidence: .6, explanation: 'Unclear photo.', eventId: 'e1', at: t0, model: 'claude' };
  const time = (ts: number) => new Date(ts).toISOString();
  assert.equal(checkLabel(undefined, time), 'Not checked');
  assert.equal(checkLabel(review, time), 'A person needs to check');
  assert.equal(checkLabel({ ...review, approvedAt: t0 + 60_000 }, time), 'Approved by a person at 2026-10-24T19:01:00.000Z');
  assert.equal(checkLabel({ ...review, declinedAt: t0 + 60_000 }, time), 'Declined by a person at 2026-10-24T19:01:00.000Z');
});

test('the installed app’s status bar follows AERO’s own theme', () => {
  assert.deepEqual([statusBarColor('dark'), statusBarColor('light'), statusBarColor(undefined)], ['#141414', '#ffffff', '#ffffff']);
});
