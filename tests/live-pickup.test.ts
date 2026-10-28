import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReturn, DEMO_PACKAGE, distance, snapshot, type LiveTelemetry, type Point, type ReturnRecord } from '../lib/simulation';
import { ackOutcome, configProblem, customerAction, enterPhase, operatorAction, PIN_MARGIN_M, phaseCommand, pickupFor, pickupMismatch, startLive, type Drone, type DroneConfig } from '../lib/drone-mission';

const t0 = Date.UTC(2026, 9, 24, 17, 0);
const home: Point = [-122.2595, 37.8719], drop: Point = [-122.2585, 37.8716];
/** The point `meters` east of `from` along its latitude, never farther than `meters` by the app's own distance(). */
function east(from: Point, meters: number): Point {
  let lo = 0, hi = meters / 50_000;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (distance(from, [from[0] + mid, from[1]]) <= meters) lo = mid; else hi = mid; }
  return [from[0] + lo, from[1]];
}
const pad = east(home, 50);
const off: DroneConfig = { home, pickupPad: pad, dropPad: drop, radius: 300, maxAlt: 60, cruiseAlt: 25 };
const on: DroneConfig = { ...off, pinRadius: 60 };
const drone = (config: DroneConfig): Drone => ({ id: 'tst001', owner: 'guest:x', name: 'Test X500', transport: 'https', phone: null, phoneVerified: false, keyVersion: 1, config, armedUntil: t0 + 60_000, activeReturn: null, lastSeq: 0, lastSeen: t0, telemetry: null, createdAt: t0 });
const booked = (pickup: Point) => createReturn({ ...DEMO_PACKAGE, pickup }, 'p1', t0);

test('pins are off unless the drone has a pin zone', () => {
  const pin = east(pad, 10);
  assert.deepEqual(pickupFor(off, pin), { point: pad, source: 'pad', pinMeters: distance(pad, pin), reason: 'Pins are off for this drone' });
  assert.equal(pickupFor({ ...off, pinRadius: 0 }, pin).source, 'pad');
  assert.equal(configProblem(off), null, 'a stored config without pinRadius is valid and means 0');
});
test('a pin up to pinRadius from the pickup pad is used; 1 m more falls back to the pad', () => {
  const edge = east(pad, 60), past = east(pad, 61);
  assert.ok(distance(pad, edge) > 59.999);
  assert.deepEqual(pickupFor(on, edge), { point: edge, source: 'pin', pinMeters: distance(pad, edge), reason: null });
  assert.deepEqual(pickupFor(on, past), { point: pad, source: 'pad', pinMeters: distance(pad, past), reason: 'Pin is 61 m from the pickup pad (zone 60 m)' });
  assert.equal(pickupFor(on, [-122.2764, 37.8738]).reason, 'Pin is 1.5 km from the pickup pad (zone 60 m)', 'km with one decimal above 1000 m');
});
test('a pin must also be at least PIN_MARGIN_M inside the geofence', () => {
  // Pad 250 m east of home in a 300 m fence: the zone reaches past the margin and the fence itself.
  const c: DroneConfig = { ...on, pickupPad: east(home, 250) };
  const inside = east(home, 300 - PIN_MARGIN_M), margin = east(home, 300 - PIN_MARGIN_M + 1), outside = east(home, 305);
  assert.equal(pickupFor(c, inside).source, 'pin');
  assert.deepEqual(pickupFor(c, margin), { point: c.pickupPad, source: 'pad', pinMeters: distance(c.pickupPad!, margin), reason: `Pin is within ${PIN_MARGIN_M} m of the fence edge` });
  assert.equal(pickupFor(c, outside).reason, 'Pin is outside the geofence');
});
test('in the smallest fence (20 m) a pin must be within 5 m of home', () => {
  const c: DroneConfig = { ...on, radius: 20, pickupPad: east(home, 3), dropPad: east(home, 2) };
  assert.equal(configProblem(c), null);
  assert.equal(pickupFor(c, east(home, 5)).source, 'pin');
  assert.equal(pickupFor(c, east(home, 6)).reason, `Pin is within ${PIN_MARGIN_M} m of the fence edge`);
});
test('invalid pins and a missing pickup pad never become a flight target', () => {
  for (const pin of [[Number.NaN, 37.87], [200, 37.87], [-122.26, 95], null, undefined] as (Point | null | undefined)[]) assert.deepEqual(pickupFor(on, pin), { point: pad, source: 'pad', pinMeters: null, reason: 'The customer’s pin is not a valid location' });
  assert.deepEqual(pickupFor({ ...on, pickupPad: null }, east(home, 10)), { point: null, source: 'pad', pinMeters: null, reason: 'No pickup pad set' });
});
test('the pin zone is 0–100 m, checked like every other limit', () => {
  for (const pinRadius of [0, 35.5, 100]) assert.equal(configProblem({ ...off, pinRadius }), null);
  for (const pinRadius of [-1, 101, Number.NaN]) assert.match(configProblem({ ...off, pinRadius })!, /pin landing zone must be 0–100 m/);
});
test('dispatch flies only to the pickup the operator previewed; old clients may only use the pad', () => {
  const pin = east(pad, 20), choice = pickupFor(on, pin), padChoice = pickupFor(off, pin);
  assert.equal(pickupMismatch(choice, { source: 'pin', point: pin }), null);
  assert.equal(pickupMismatch(choice, { source: 'pad', point: pad }), 'The pickup changed. Review it and dispatch again.');
  assert.equal(pickupMismatch(choice, { source: 'pin', point: east(pad, 21) }), 'The pickup changed. Review it and dispatch again.');
  assert.equal(pickupMismatch(padChoice, { source: 'pin', point: pin }), 'The pickup changed. Review it and dispatch again.', 'pins were turned off after the preview');
  assert.equal(pickupMismatch(padChoice, undefined), null, 'an old client body still flies to the pad');
  assert.equal(pickupMismatch(choice, undefined), 'The pickup changed. Review it and dispatch again.', 'an old client never flies to a pin it did not show');
});

/** Flies a booked return to the end of TO_PICKUP and acks the GOTO. */
function atPickup(config: DroneConfig, pickup: Point) {
  let r: ReturnRecord = enterPhase(startLive(booked(pickup), drone(config), t0), 'TAKEOFF_OUT', t0, 1);
  r = enterPhase(r, ackOutcome(r.live!, { cmdSeq: 1, status: 'DONE' })!.phase, t0 + 1000, 2);
  return { r, next: ackOutcome(r.live!, { cmdSeq: 2, status: 'DONE' })! };
}
test('a pin flight hovers over the pin and lands only when the operator says the area is clear', () => {
  const pin = east(pad, 30), { r: flying, next } = atPickup(on, pin);
  const over: LiveTelemetry = { ts: t0, receivedAt: t0, lat: pin[1], lon: pin[0] + 0.00003, alt: 25, battery: 80, heading: 0, speed: 0, fix: 3, sats: 12, state: 'HOLD', mode: 'GUIDED' };
  assert.equal(flying.live!.pickupSource, 'pin');
  assert.deepEqual(phaseCommand(flying.live!, 'TO_PICKUP'), { type: 'GOTO', args: [pin[1], pin[0], 25] });
  assert.deepEqual(snapshot(flying, t0).path.inbound, [home, pin], 'the tracking route goes home → pin');
  assert.equal(next.phase, 'HOVER_PICKUP');
  assert.equal(phaseCommand(flying.live!, 'HOVER_PICKUP'), null, 'hovering sends no command');
  const r = enterPhase(flying, next.phase, t0 + 2000, null);
  assert.equal(snapshot(r, t0 + 2000).state, 'ARRIVED_AT_PICKUP');
  assert.equal(ackOutcome(r.live!, { cmdSeq: 2, status: 'DONE' }), null, 'nothing moves it on by itself');
  assert.throws(() => operatorAction(flying, 'land', pad, over), /hovers over the customer’s pin/);
  const land = operatorAction(r, 'land', pad, over); assert.deepEqual(land, { phase: 'LAND_PICKUP', command: { type: 'LAND', args: [] } });
  // The bridge's own link-loss HOLD/RTL sends no ack, so the phase can still say HOVER_PICKUP: land only when the report puts the drone over the pin.
  assert.throws(() => operatorAction(r, 'land', pad, { ...over, lat: home[1], lon: home[0], state: 'RTL' }), /The drone is \d+ m from the customer’s pin, not over the pin, so it was not landed/);
  assert.throws(() => operatorAction(r, 'land', pad, null), /The drone is not hovering over the pin/);
  assert.throws(() => operatorAction(r, 'land', pad, { ...over, state: 'ERROR' }), /not hovering/);
  // On the ground at the pin (an RC landing, which sends no ack) `land` confirms it: the LAND only disarms, and loading follows.
  assert.deepEqual(operatorAction(r, 'land', pad, { ...over, alt: 0, state: 'LANDED' }), land);
  assert.deepEqual(operatorAction(r, 'land', pad, { ...over, alt: 0.4, state: 'ARMED' }), land);
  assert.throws(() => operatorAction(r, 'land', pad, { ...over, alt: 0, state: 'LANDED', lat: home[1], lon: home[0] }), /The drone is on the ground \d+ m from the customer’s pin, so it was not landed there/);
  assert.equal(operatorAction({ ...r, live: { ...r.live!, telemetry: over } }, 'land').phase, 'LAND_PICKUP', 'by default the report attached to the flight');
  const landing = enterPhase(r, land.phase, t0 + 3000, 3);
  assert.equal(ackOutcome(landing.live!, { cmdSeq: 3, status: 'DONE' })!.phase, 'AWAITING_LOAD');
  // A HOLD while hovering pauses; retry just clears it (there is no command to re-send), and land still works.
  const held = { ...r, live: { ...r.live!, fault: 'OPERATOR_HOLD', cmdSeq: 4 } };
  assert.deepEqual(operatorAction(held, 'retry'), { phase: 'HOVER_PICKUP' });
  assert.equal(operatorAction(held, 'land', pad, over).phase, 'LAND_PICKUP');
});
test('a pad flight, and a flight stored before pins existed, land at the pad straight away', () => {
  assert.equal(atPickup(off, east(pad, 30)).next.phase, 'LAND_PICKUP');
  const { r } = atPickup(on, east(pad, 30)), legacy = { ...r, live: { ...r.live!, pickupSource: undefined } };
  assert.equal(ackOutcome(legacy.live!, { cmdSeq: 2, status: 'DONE' })!.phase, 'LAND_PICKUP');
  assert.throws(() => operatorAction(legacy, 'divert-pad', pad), /Divert to the pickup pad/);
});
test('the operator can divert a pin flight to the pickup pad, also after the bridge refused the pin', () => {
  const pin = east(pad, 30), { r: flying } = atPickup(on, pin);
  const refused = enterPhase(flying, 'TO_PICKUP', t0 + 2000, 2, 'FENCE');
  assert.equal(snapshot(refused, t0 + 2000).state, 'FAILED');
  for (const r of [refused, enterPhase(flying, 'HOVER_PICKUP', t0 + 2000, null)]) {
    const step = operatorAction(r, 'divert-pad', pad);
    assert.deepEqual(step, { phase: 'TO_PICKUP', live: { pickupPad: pad, pickupSource: 'pad' }, command: { type: 'GOTO', args: [pad[1], pad[0], 25] } });
    const diverted = enterPhase({ ...r, live: { ...r.live!, ...step.live } }, step.phase, t0 + 3000, 5);
    assert.equal(diverted.live!.fault, null); assert.equal(snapshot(diverted, t0 + 3000).state, 'EN_ROUTE_TO_PICKUP');
    assert.deepEqual(snapshot(diverted, t0 + 3000).path.inbound, [home, pad]);
    assert.equal(ackOutcome(diverted.live!, { cmdSeq: 5, status: 'DONE' })!.phase, 'LAND_PICKUP', 'then it lands at the pad as usual');
    assert.throws(() => operatorAction(diverted, 'divert-pad', pad), /Divert/, 'only once');
  }
  assert.throws(() => operatorAction(enterPhase(flying, 'AWAITING_LOAD', t0, null), 'divert-pad', pad), /Divert/);
  assert.throws(() => operatorAction(flying, 'divert-pad', null), /Set a pickup pad first/);
  // The bridge refuses a GOTO on the ground, so a landed drone is never diverted into a stalled fault.
  const landed: LiveTelemetry = { ts: t0, receivedAt: t0, lat: pin[1], lon: pin[0], alt: 0, battery: 80, heading: 0, speed: 0, fix: 3, sats: 12, state: 'LANDED', mode: 'LOITER' };
  for (const t of [landed, { ...landed, lat: home[1], lon: home[0] }]) assert.throws(() => operatorAction(enterPhase(flying, 'HOVER_PICKUP', t0, null), 'divert-pad', pad, t), /The drone is on the ground, so it cannot fly to the pickup pad/);
  assert.equal(operatorAction(enterPhase(flying, 'HOVER_PICKUP', t0, null), 'divert-pad', pad, { ...landed, alt: 25, state: 'HOLD' }).phase, 'TO_PICKUP');
});
test('a customer cancel en route or over the pin sends ABORT, which flies home in the air and never takes off from the ground', () => {
  const pin = east(pad, 30), { r: flying } = atPickup(on, pin);
  const air: LiveTelemetry = { ts: t0, receivedAt: t0, lat: pin[1], lon: pin[0], alt: 25, battery: 80, heading: 0, speed: 0, fix: 3, sats: 12, state: 'HOLD', mode: 'GUIDED' };
  const ground = { ...air, alt: 0, state: 'LANDED' }, armed = { ...air, alt: 0.3, state: 'ARMED' };
  for (const phase of ['HOVER_PICKUP', 'TO_PICKUP'] as const) {
    const r = enterPhase(flying, phase, t0, null), at = (telemetry: LiveTelemetry | null) => customerAction({ ...r, live: { ...r.live!, telemetry } }, 'cancel');
    // Telemetry can lag an RC landing at the pin (no ack), so the command must be safe either way: the bridge runs an RTL on
    // the ground away from home as a takeoff, but an ABORT on the ground only lands (disarms) or does nothing.
    for (const t of [air, ground, armed, null]) assert.deepEqual(at(t), { phase: 'ABORTED', cancelled: true, command: { type: 'ABORT', args: [] } }, `${phase}: ${t?.state ?? 'no report'}`);
  }
  assert.throws(() => customerAction(enterPhase(flying, 'HOVER_PICKUP', t0, null), 'load'), /Wait until the drone has landed/);
});
