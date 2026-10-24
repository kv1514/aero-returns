import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, confidencePct, formatDuration, merchantRow, merchantView, MINUTES_PER_STORE_TRIP, needsPersonQueue, needsPersonReasons, PERSON_WAIT, scopeOf, stageOf } from '../lib/merchant';
import { control, createReturn, DEMO_PACKAGE, type FlightState, type Point, type ReturnRecord } from '../lib/simulation';
import { enterPhase, startLive, type Drone } from '../lib/drone-mission';
import type { ReturnReview } from '../lib/return-agent-shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MerchantDesk, pollDesk, type PollEnv, type View } from '../components/merchant-console';

const t0 = Date.UTC(2026, 9, 24, 17, 0), min = 60_000;
const review = (patch: Partial<ReturnReview> = {}): ReturnReview => ({ verdict: 'fly_standard', condition: 'like_new', disposition: 'restock', confidence: .93, explanation: 'Unused, in the original box.', model: 'claude-opus-5-5', eventId: '11111111-1111-4111-8111-111111111111', at: t0, ...patch });
const book = (id: string, at = t0, rv?: ReturnReview): ReturnRecord => ({ ...createReturn({ ...DEMO_PACKAGE }, id, at), ...(rv ? { review: rv } : {}) });
/** Books, waits for the drone, loads, departs and pauses: the package stays in flight from `at + 3 s`. */
const inFlight = (id: string, at = t0, rv?: ReturnReview) => control(control(control(control(book(id, at, rv), 'advance', at + 1000), 'load', at + 2000), 'advance', at + 3000), 'pause', at + 3000);
/** A simulated return handed off exactly `after` ms after booking. */
const received = (id: string, at: number, after: number, rv?: ReturnReview) => control(control(inFlight(id, at, rv), 'advance', at + after), 'advance', at + after);
const home: Point = [-122.2595, 37.8719], pad: Point = [-122.2590, 37.8722], drop: Point = [-122.2585, 37.8716];
const drone: Drone = { id: 'tst001', owner: 'guest:x', name: 'Test X500', transport: 'https', phone: null, phoneVerified: false, keyVersion: 1, config: { home, pickupPad: pad, dropPad: drop, radius: 300, maxAlt: 60, cruiseAlt: 25 }, armedUntil: t0 + min, activeReturn: null, lastSeq: 0, lastSeen: t0, telemetry: null, createdAt: t0 };
const live = (id: string, phases: Parameters<typeof enterPhase>[1][], fault: string | null = null) => phases.reduce((r, phase, i) => enterPhase(r, phase, t0 + (i + 1) * min, i + 1, i === phases.length - 1 ? fault : null), startLive(book(id), drone, t0));

test('every tracking state maps to one merchant stage', () => {
  const expected: Partial<Record<FlightState, string>> = { ASSIGNED: 'Booked', PRE_FLIGHT: 'Booked', EN_ROUTE_TO_PICKUP: 'Booked', AWAITING_PACKAGE: 'Booked', PACKAGE_LOADED: 'Picked up', EN_ROUTE_TO_DROPOFF: 'In flight', ARRIVED_AT_DROPOFF: 'In flight', HANDOFF_PENDING: 'In flight', COMPLETED: 'Received', CANCELLED: 'Cancelled' };
  for (const [state, stage] of Object.entries(expected)) assert.equal(stageOf(state as FlightState), stage, state);
});
test('a simulated return moves Booked → Picked up → In flight → Received with real event times', () => {
  assert.equal(merchantRow(book('a1'), t0 + 500).stage, 'Booked');
  const waiting = control(book('a1'), 'advance', t0 + 1000);
  assert.deepEqual([merchantRow(waiting, t0 + 1000).stage, merchantRow(waiting, t0 + 1000).status], ['Booked', 'Waiting for the customer to load']);
  const loaded = control(waiting, 'load', t0 + 2000);
  assert.equal(merchantRow(loaded, t0 + 2000).stage, 'Picked up');
  assert.equal(merchantRow(inFlight('a1'), t0 + 4000).stage, 'In flight');
  const done = merchantRow(received('a1', t0, 7 * min), t0 + 8 * min);
  assert.equal(done.stage, 'Received'); assert.equal(done.state, 'COMPLETED'); assert.equal(done.live, false);
  assert.equal(done.receivedAt, t0 + 7 * min); assert.equal(done.loadedAt, t0 + 2000); assert.equal(done.destination, 'AERO Downtown Hub');
  assert.equal(done.status, 'Simulated handoff complete');
});
test('rows never expose the customer’s pickup address or instructions', () => {
  const row = merchantRow(book('p1'), t0) as Record<string, unknown>;
  assert.ok(!('address' in row) && !('pickup' in row) && !('instructions' in row) && !('package' in row));
  assert.equal(row.reference, DEMO_PACKAGE.returnReference); assert.equal(row.shortId, 'AR-P1');
});
test('a paused flight keeps the stage it paused in', () => {
  const before = merchantRow(control(book('f1'), 'fail', t0 + 1000), t0 + 5 * min), after = merchantRow(control(inFlight('f2'), 'fail', t0 + 4000), t0 + 5 * min);
  assert.deepEqual([before.state, before.stage, before.status], ['FAILED', 'Booked', 'Paused for assistance']);
  assert.deepEqual([after.state, after.stage], ['FAILED', 'In flight']);
});
test('disposition and the person queue come only from the server-verified review', () => {
  assert.equal(merchantRow(book('n1'), t0).disposition, 'awaiting check'); assert.equal(merchantRow(book('n1'), t0).review, null);
  const flagged = merchantRow(book('n2', t0, review({ verdict: 'needs_person', condition: 'damaged', disposition: 'inspect', confidence: .7 })), t0);
  assert.equal(flagged.needsPerson, true); assert.equal(flagged.disposition, 'inspect');
  const cancelled = merchantRow(control(book('n3', t0, review({ verdict: 'needs_person' })), 'cancel', t0 + 1000), t0 + 2000);
  assert.deepEqual([cancelled.stage, cancelled.status], ['Cancelled', 'Cancelled by the customer']); assert.equal(cancelled.needsPerson, false, 'a cancelled return never reaches the dock');
});
test('aggregates count received, in flight, people needed, Claude coverage and the labelled estimate', () => {
  const { rows, aggregates: a, skipped } = merchantView([
    received('r1', t0, 4 * min, review()),
    received('r2', t0 + min, 7 * min, review({ verdict: 'needs_person', condition: 'used', disposition: 'refurbish', confidence: .6, approvedAt: t0 + min })),
    inFlight('r3', t0 + 2 * min),
    book('r4', t0 + 3 * min, review({ verdict: 'needs_person', disposition: 'return_to_vendor', confidence: .6 })),
    control(book('r5', t0 + 4 * min, review()), 'cancel', t0 + 4 * min + 1000),
  ], t0 + 10 * min);
  assert.equal(skipped, 0); assert.equal(rows.length, 5);
  assert.deepEqual([a.total, a.received, a.inFlight, a.booked, a.cancelled, a.needsPerson, a.live, a.liveReceived], [5, 2, 1, 1, 1, 1, 0, 0]);
  assert.deepEqual(a.byDisposition, { restock: 1, inspect: 0, refurbish: 1, return_to_vendor: 1, 'awaiting check': 1 }, 'cancelled returns are not part of the expected mix');
  assert.equal(a.checked, 4); assert.equal(a.checkedByClaude, .8);
  assert.equal(a.avgMinutesToReceipt, 5.5, 'createdAt → COMPLETED, averaged over received returns');
  assert.equal(a.storeTripsAvoided, 2); assert.equal(a.estimatedMinutesSaved, 2 * MINUTES_PER_STORE_TRIP); assert.equal(a.minutesPerTrip, 25);
});
test('an empty desk reports zeros and no average instead of NaN', () => {
  const a = aggregate([]);
  assert.deepEqual([a.total, a.received, a.checkedByClaude, a.avgMinutesToReceipt, a.estimatedMinutesSaved], [0, 0, 0, null, 0]);
});
test('the person queue lists only returns still on hold, longest-waiting first', () => {
  const flag = review({ verdict: 'needs_person', confidence: .5 });
  const rows = [book('q1', t0 + 2 * min, flag), book('q2', t0, flag), received('q3', t0 + 3 * min, 4 * min, { ...flag, approvedAt: t0 + 3 * min }), book('q4', t0 - min, review())].map(r => merchantRow(r, t0 + 10 * min));
  assert.deepEqual(needsPersonQueue(rows).map(r => r.id), ['q2', 'q1'], 'an approved return has left the queue');
  assert.equal(rows[2].approvedAt, t0 + 3 * min);
});
test('needs-person reasons reflect the gate rules that are visible in the stored summary', () => {
  assert.deepEqual(needsPersonReasons({ condition: 'damaged', confidence: .6 }), ['Possible damage', 'Low confidence (60%, under 85%)']);
  assert.deepEqual(needsPersonReasons({ condition: 'unknown', confidence: .9 }), ['Condition unclear from the description and any photos'], 'photos are optional');
  assert.deepEqual(needsPersonReasons({ condition: 'like_new', confidence: .95 }), ['The item may not match its description, or Claude asked for a person to judge it'], 'a mismatch is not stored, so a generic reason is shown');
});
test('a grade just under the 85% gate never reads as 85%', () => {
  assert.deepEqual([.849, .8499, .85, .29, .57, 1, 0].map(confidencePct), [84, 84, 85, 29, 57, 100, 0], 'rounded down, without float error on .29 or .57');
  assert.deepEqual(needsPersonReasons({ condition: 'used', confidence: .849 }), ['Low confidence (84%, under 85%)']);
});
test('durations round before splitting hours, so there is never a "60 min" remainder', () => {
  assert.deepEqual([0, 4.4, 59.4, 59.6, 60, 119.5, 119.9, 125, 1500].map(formatDuration), ['0 min', '4 min', '59 min', '1 h', '1 h', '2 h', '2 h', '2 h 5 min', '25 h']);
});
test('the desk says whose returns it shows without exposing the owner id', () => {
  assert.deepEqual(['guest:0b1c', 'demo:0b1c', 'supabase:0b1c', 'user:0b1c'].map(scopeOf), ['browser', 'demo', 'account', 'account']);
});
test('the merchant side of the shared needs-person phrase', () => {
  assert.equal(PERSON_WAIT, 'Waiting for a person before it flies — inspect on arrival.');
});
test('a reset return keeps its booking time, Claude grade and approval on the desk', () => {
  const flag = review({ verdict: 'needs_person', condition: 'damaged', disposition: 'inspect', confidence: .7, approvedAt: t0 });
  const row = merchantRow(control(received('z1', t0, 4 * min, flag), 'reset', t0 + 9 * min), t0 + 9 * min);
  assert.deepEqual([row.stage, row.createdAt, row.review?.eventId, row.disposition, row.needsPerson, row.approvedAt, row.loadedAt, row.receivedAt], ['Booked', t0, flag.eventId, 'inspect', false, t0, null, null]);
});
test('live flights are labelled live and use the drop pad and the drone’s own events', () => {
  const done = merchantRow(live('l1', ['TAKEOFF_OUT', 'TO_PICKUP', 'LAND_PICKUP', 'AWAITING_LOAD', 'READY_TO_LAUNCH', 'TAKEOFF_LOADED', 'TO_DROP', 'LAND_DROP', 'AWAITING_UNLOAD', 'TAKEOFF_HOME', 'RETURNING', 'LAND_HOME', 'COMPLETE']), t0 + 20 * min);
  assert.deepEqual([done.live, done.stage, done.status, done.destination, done.drone], [true, 'Received', 'Unload confirmed at the drop pad', 'Drop pad', 'Test X500']);
  assert.equal(done.receivedAt, t0 + 10 * min, 'received when the operator confirmed unload and the drone left the pad');
  assert.equal(done.loadedAt, t0 + 5 * min);
  const paused = merchantRow(live('l2', ['TAKEOFF_OUT', 'TO_PICKUP', 'LAND_PICKUP', 'AWAITING_LOAD', 'READY_TO_LAUNCH', 'TAKEOFF_LOADED', 'TO_DROP'], 'LINK_LOST'), t0 + 20 * min);
  assert.deepEqual([paused.state, paused.stage], ['FAILED', 'In flight']);
  const ended = merchantRow(live('l3', ['TAKEOFF_OUT', 'TO_PICKUP', 'ABORTED']), t0 + 20 * min);
  assert.deepEqual([ended.stage, ended.status], ['Cancelled', 'Ended by the pilot']);
  const mixed = merchantView([live('l4', ['TAKEOFF_OUT']), live('l5', ['TAKEOFF_OUT', 'TO_PICKUP', 'LAND_PICKUP', 'AWAITING_LOAD', 'READY_TO_LAUNCH', 'TAKEOFF_LOADED', 'TO_DROP', 'LAND_DROP', 'AWAITING_UNLOAD', 'TAKEOFF_HOME']), received('s1', t0, 4 * min)], t0 + 20 * min).aggregates;
  assert.deepEqual([mixed.live, mixed.liveReceived, mixed.received], [2, 1, 2]);
});
test('unreadable stored records are skipped and counted, not fatal', () => {
  const view = merchantView([null, {}, { ...book('bad'), facilityId: 'nowhere' }, book('ok')], t0 + 1000);
  assert.equal(view.rows.length, 1); assert.equal(view.skipped, 3); assert.equal(view.rows[0].id, 'ok');
});

const LIVE_DONE = ['TAKEOFF_OUT', 'TO_PICKUP', 'LAND_PICKUP', 'AWAITING_LOAD', 'READY_TO_LAUNCH', 'TAKEOFF_LOADED', 'TO_DROP', 'LAND_DROP', 'AWAITING_UNLOAD', 'TAKEOFF_HOME'] as const;
const desk = (records: unknown[], extra: Partial<View> = {}, state: { error?: string; offline?: boolean; halted?: boolean } = {}) =>
  renderToStaticMarkup(createElement(MerchantDesk, { view: { ...merchantView(records, t0 + 20 * min), limit: 100, now: t0 + 20 * min, scope: 'browser', ...extra }, error: state.error ?? '', offline: !!state.offline, halted: state.halted }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
test('the desk splits received returns into simulated and live and never says a drone flew', () => {
  const html = text(desk([received('s1', t0, 4 * min), received('s2', t0, 5 * min), live('l1', [...LIVE_DONE])]));
  assert.match(html, /Returns received 3 2 simulated, 1 live flight · of 3 booked/);
  assert.match(html, /Store trips avoided Demo 3 Assumes one per received return, simulated or live/);
  assert.match(html, /2 simulated \(demo speed controls shorten them\) and 1 over the live drone link/);
  assert.match(html, /the vehicle may be a simulator/);
  assert.doesNotMatch(html, /\bflew on\b|private/i);
  assert.match(text(desk([received('s1', t0, 4 * min)])), /Returns received 1 All simulated · of 1 booked/);
});
test('a needs-person return shows the shared merchant phrase in the queue and the table', () => {
  const html = desk([book('n1', t0, review({ verdict: 'needs_person', condition: 'used', disposition: 'refurbish', confidence: .849 }))]);
  assert.equal(html.split(PERSON_WAIT).length - 1, 2);
  assert.match(text(html), /Used · 84% confident · Suggested: Refurbish/);
  assert.match(html, /aria-live="polite">1<span class="m-sr"> return waiting for a person<\/span>/);
});
test('the row cap counts skipped records too, and the scope names whose returns these are', () => {
  assert.match(text(desk([book('c1'), book('c2'), null], { limit: 3 })), /2 booked in this browser · newest first · latest 3 shown/);
  assert.doesNotMatch(text(desk([book('c1'), null], { limit: 3 })), /latest 3 shown/);
  const account = text(desk([book('c1')], { scope: 'account' }));
  assert.match(account, /Demo merchant view of your account’s returns/); assert.match(account, /1 booked in your account/); assert.match(account, /latest 100 returns booked in your account/);
  assert.doesNotMatch(account, /this browser/);
});
test('the returns table keeps table roles for the phone card layout', () => {
  const html = desk([book('r1')]);
  assert.match(html, /<table class="merchant-table" role="table"/);
  assert.match(html, /<th scope="row" role="rowheader" data-label="Return">/);
  assert.equal(html.split('role="cell"').length - 1, 6);
});
test('load failures show the reason: offline keeps it beside the stale data, an expired session stops retrying', () => {
  const offline = text(desk([book('o1')], {}, { error: 'Can’t reach AERO. Check your connection.', offline: true }));
  assert.match(offline, /Offline · retrying/); assert.match(offline, /Can’t reach AERO\. Check your connection\. Showing the last data received while the desk retries\./);
  const halted = text(desk([book('o1')], {}, { error: 'Your account session expired.', halted: true }));
  assert.match(halted, /Not refreshing/); assert.match(halted, /Your account session expired\. The desk stopped refreshing/); assert.doesNotMatch(halted, /retrying|Retrying/);
  const first = text(renderToStaticMarkup(createElement(MerchantDesk, { view: null, error: 'Your account session expired.', offline: false, halted: true })));
  assert.match(first, /Your account session expired\. The desk checks again when you come back to this tab\./); assert.doesNotMatch(first, /Retrying/);
  assert.match(renderToStaticMarkup(createElement(MerchantDesk, { view: null, error: '', offline: false })), /role="status">Loading returns…/);
});

/** A fake tab and server for pollDesk: fetch answers come from `answer`, timers are node:test mock timers. */
function poller(answer: (n: number, init: RequestInit) => Promise<Awaited<ReturnType<PollEnv['fetch']>>>) {
  const listeners = new Set<() => void>(), events: string[] = []; let calls = 0;
  const doc = { hidden: false, addEventListener: (_: string, fn: () => void) => { listeners.add(fn); }, removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); } };
  const stop = pollDesk({ data: () => events.push('data'), fail: (message, signedOut) => events.push(`${signedOut ? '401' : 'fail'}: ${message}`) }, { document: doc, fetch: (_, init) => answer(++calls, init) });
  return { events, stop, calls: () => calls, show: () => { doc.hidden = false; listeners.forEach(fn => fn()); }, listeners };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ok = async () => ({ ok: true, status: 200, json: async () => ({ ...merchantView([], t0), limit: 100, now: t0, scope: 'browser' }) });
const hang = (_: number, init: RequestInit) => new Promise<never>((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
test('a hung request is aborted after 10 s, reported, and polling carries on', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = poller((n, init) => (n === 1 ? hang(n, init) : ok()));
  t.mock.timers.tick(5000); assert.equal(p.calls(), 1, 'no second request while one is in flight');
  t.mock.timers.tick(5000); await flush();
  assert.deepEqual(p.events, ['fail: AERO took too long to answer.']);
  t.mock.timers.tick(5000); await flush();
  assert.equal(p.calls(), 2); assert.deepEqual(p.events.at(-1), 'data');
  p.stop();
});
test('an expired session stops polling until the tab is shown again; a network error keeps retrying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = poller(async n => (n === 1 ? { ok: false, status: 401, json: async () => ({ error: 'Your account session expired.' }) } : n === 2 ? Promise.reject(new TypeError('Failed to fetch')) : ok()));
  await flush(); assert.deepEqual(p.events, ['401: Your account session expired.']);
  t.mock.timers.tick(30_000); await flush(); assert.equal(p.calls(), 1, 'no retries after a 401');
  p.show(); await flush(); assert.equal(p.calls(), 2); assert.equal(p.events.at(-1), 'fail: Can’t reach AERO. Check your connection.');
  t.mock.timers.tick(5000); await flush(); assert.equal(p.calls(), 3, 'polling resumed after the non-401 failure'); assert.equal(p.events.at(-1), 'data');
  p.stop(); assert.equal(p.listeners.size, 0);
  t.mock.timers.tick(30_000); await flush(); assert.equal(p.calls(), 3, 'cleanup stops polling');
});
test('cleanup aborts an in-flight request without reporting it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let signal: AbortSignal | undefined;
  const p = poller((n, init) => { signal = init.signal ?? undefined; return hang(n, init); });
  p.stop(); await flush();
  assert.equal(signal?.aborted, true); assert.deepEqual(p.events, []);
});
