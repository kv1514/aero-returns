import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assignDrone, busyDrones, control, createReturn, DEMO_PACKAGE, DISPATCH, distance, nearestDrones, PICKUPS, recommend, routes, settle, SIM_FLEET, snapshot, timing, type ReturnRecord } from '../lib/simulation';
import { initialView, packageSchema, recentReturns, returnStatus, SERVICE_AREA_MESSAGE, validationMessage } from '../lib/request-flow';
import { DEMO_BOUNDS, inDemoArea } from '../lib/location';
import Booking, { rideOptions } from '../components/booking';
import type { BookingDraft } from '../lib/booking-draft';
import { fleetMarkerName, flightDroneName, routeWords } from '../components/drone';

const t0 = Date.UTC(2026, 9, 24, 19, 0), min = 60_000;
const book = (id: string, at = t0, pickup = DEMO_PACKAGE.pickup) => createReturn({ ...DEMO_PACKAGE, pickup }, id, at);
const complete = (r: ReturnRecord, at: number) => { let x = control(r, 'advance', at); x = control(x, 'load', at); for (let i = 0; i < 3; i++) x = control(x, 'advance', at); return x; };
/** A record stored before the simulated fleet existed: no drone field. */
const legacy = (id: string) => { const { drone: _drone, ...r } = book(id); void _drone; return r as ReturnRecord; };

test('nothing is booked on a visit: no returns, or only ended ones, open the home screen', () => {
  assert.equal(initialView([], undefined, t0), 'home');
  const done = complete(book('done', t0), t0 + 1000), cancelled = control(book('gone', t0), 'cancel', t0 + 1000);
  assert.equal(snapshot(done, t0 + 2000).state, 'COMPLETED');
  assert.equal(initialView([done, cancelled], undefined, t0 + 2000), 'home');
});
test('an active return reopens its tracking, newest first; a tracking link opens that return', () => {
  const older = book('older', t0), newer = book('newer', t0 + min), done = complete(book('done', t0 + 2 * min), t0 + 2 * min);
  assert.deepEqual(initialView([older, done, newer], undefined, t0 + 3 * min), { track: 'newer' });
  assert.deepEqual(initialView([older, newer, done], 'done', t0 + 3 * min), { track: 'done' });
  assert.deepEqual(initialView([older], 'not-mine', t0 + 3 * min), { track: 'older' }, 'an unknown link falls back like a plain visit');
  assert.deepEqual(recentReturns([older, done, newer]).map(r => r.id), ['done', 'newer', 'older']);
  assert.deepEqual([returnStatus(done, t0 + 3 * min), returnStatus(newer, t0 + 3 * min), returnStatus(control(older, 'cancel', t0 + 3 * min), t0 + 3 * min)], ['Delivered', 'In progress', 'Cancelled']);
});
test('the simulated fleet: five drones inside the booking area, AERO–104 among them', () => {
  assert.equal(SIM_FLEET.length, 5); assert.equal(new Set(SIM_FLEET.map(d => d.id)).size, 5);
  assert.ok(SIM_FLEET.some(d => d.name === 'AERO–104'));
  for (const d of SIM_FLEET) assert.ok(inDemoArea(d.base) && d.base[0] > DEMO_BOUNDS.west && d.base[1] < DEMO_BOUNDS.north, d.name);
});
test('nearest drones come nearest first, skip busy ones, and quote the ETA tracking will use', () => {
  const list = nearestDrones(PICKUPS[0].point);
  assert.equal(list.length, 5); assert.equal(list[0].drone.name, 'AERO–217');
  for (let i = 1; i < list.length; i++) assert.ok(list[i].meters >= list[i - 1].meters);
  assert.ok(Math.abs(list[0].meters - distance(list[0].drone.base, PICKUPS[0].point)) < 1e-6);
  const skip = nearestDrones(PICKUPS[0].point, ['aero-217']);
  assert.equal(skip.length, 4); assert.ok(!skip.some(n => n.drone.id === 'aero-217')); assert.equal(skip[0].drone.id, list[1].drone.id);
  assert.deepEqual(nearestDrones(PICKUPS[0].point, SIM_FLEET.map(d => d.id)), []);
  // The quoted minutes are the booked flight's arrival at the pickup, pre-flight included.
  const r = book('eta'), quoted = nearestDrones(r.package.pickup)[0];
  assert.equal(quoted.minutes, Math.max(1, Math.ceil(timing(r).pickup / 60)));
  assert.ok(nearestDrones(PICKUPS[2].point, [], 'priority')[0].minutes <= nearestDrones(PICKUPS[2].point)[0].minutes);
  assert.equal(nearestDrones(PICKUPS[2].point)[0].drone.name, 'AERO–332', 'South Berkeley gets its own nearby drone');
});
test('a booking records its drone and the inbound route starts at that drone’s base', () => {
  const r = book('r1'), near = nearestDrones(r.package.pickup)[0].drone;
  assert.deepEqual(r.drone, { id: near.id, name: near.name, base: near.base, meters: Math.round(distance(near.base, r.package.pickup)) });
  assert.deepEqual(routes(r).inbound[0], near.base); assert.deepEqual(snapshot(r, t0).point, near.base);
  const chosen = SIM_FLEET.find(d => d.id === 'aero-458')!, other = createReturn({ ...DEMO_PACKAGE }, 'r2', t0, chosen);
  assert.equal(other.drone?.name, 'AERO–458'); assert.deepEqual(routes(other).inbound[0], chosen.base);
  assert.ok(timing(other).pickup > timing(r).pickup, 'a farther drone takes longer to arrive');
  // Facility estimates use the nearest drone, not the old fixed dispatch point.
  const nearest = recommend(DEMO_PACKAGE).find(f => !f.reason)!, fromDispatch = recommend(DEMO_PACKAGE, DISPATCH).find(f => f.id === nearest.id)!;
  assert.ok(nearest.minutes <= fromDispatch.minutes);
});
test('records saved before the fleet still fly from DISPATCH, and a reset keeps whichever drone a return had', () => {
  const old = legacy('old');
  assert.equal(old.drone, undefined); assert.deepEqual(routes(old).inbound[0], DISPATCH);
  assert.equal(snapshot(settle(old, t0 + 30_000), t0 + 30_000).state, 'EN_ROUTE_TO_PICKUP');
  assert.equal(control(old, 'reset', t0 + min).drone, undefined);
  const r = createReturn({ ...DEMO_PACKAGE }, 'r3', t0, SIM_FLEET[3]);
  assert.deepEqual(control(control(r, 'advance', t0 + 1000), 'reset', t0 + min).drone, r.drone);
  assert.equal(createReturn({ ...DEMO_PACKAGE }, 'r4', t0, null).drone, undefined);
});
test('the server gives two simultaneous returns different drones, and frees a drone when its return ends', () => {
  const first = createReturn({ ...DEMO_PACKAGE }, 'a', t0, assignDrone(DEMO_PACKAGE.pickup, [], t0));
  const second = createReturn({ ...DEMO_PACKAGE }, 'b', t0 + 1000, assignDrone(DEMO_PACKAGE.pickup, [first], t0 + 1000));
  assert.equal(first.drone?.id, 'aero-217'); assert.notEqual(second.drone?.id, first.drone?.id);
  assert.equal(second.drone?.id, nearestDrones(DEMO_PACKAGE.pickup)[1].drone.id, 'the next nearest free drone');
  assert.deepEqual(busyDrones([first, second], t0 + 2000).sort(), [first.drone!.id, second.drone!.id].sort());
  const cancelled = control(first, 'cancel', t0 + 2000);
  assert.deepEqual(busyDrones([cancelled, second], t0 + 3000), [second.drone!.id]);
  assert.equal(assignDrone(DEMO_PACKAGE.pickup, [cancelled, second], t0 + 3000).id, 'aero-217');
  assert.deepEqual(busyDrones([legacy('old'), { ...first, live: { droneId: 'x' } as ReturnRecord['live'] }, { record: 'broken' } as unknown as ReturnRecord], t0), [], 'old, live and unreadable records hold no simulated drone');
  const all = SIM_FLEET.map((d, i) => createReturn({ ...DEMO_PACKAGE }, `f${i}`, t0, d));
  assert.equal(assignDrone(DEMO_PACKAGE.pickup, all, t0).id, 'aero-217', 'with every drone busy the nearest one still serves');
});
test('booking input: the browser cannot pick a drone, and bad bodies get plain 400 messages', () => {
  const parsed = packageSchema.parse({ ...DEMO_PACKAGE, drone: { id: 'aero-561' } });
  assert.equal('drone' in parsed, false);
  const message = (body: unknown) => { const r = packageSchema.safeParse(body); assert.equal(r.success, false); return validationMessage(r.error!); };
  assert.equal(message(null), 'Send the request as a JSON object.');
  assert.equal(message([]), 'Send the request as a JSON object.');
  assert.equal(message({ ...DEMO_PACKAGE, pickup: [-118.24, 34.05] }), SERVICE_AREA_MESSAGE);
  assert.match(message({ ...DEMO_PACKAGE, weight: 100 }), /^weight: /);
});
test('choose a ride: each tier quotes its nearest free drone, and a tier the package can’t fly is greyed with the reason', () => {
  const [standard, priority] = rideOptions(DEMO_PACKAGE);
  assert.deepEqual([standard.name, standard.drone.name, standard.reason], ['AERO Standard', 'AERO–217', null]);
  assert.ok(priority.price! > standard.price!); assert.ok(priority.minutes <= standard.minutes);
  assert.equal(rideOptions(DEMO_PACKAGE, ['aero-217'])[0].drone.name, nearestDrones(DEMO_PACKAGE.pickup)[1].drone.name);
  const heavy = rideOptions({ ...DEMO_PACKAGE, weight: 3.4, dimensions: [40, 30, 20] });
  assert.match(heavy[0].reason!, /2\.5 kg/); assert.equal(heavy[0].price, null); assert.equal(heavy[1].reason, null);
  const draft = (step: number, pkg = DEMO_PACKAGE): BookingDraft => ({ version: 1, updatedAt: t0, step, package: { ...pkg } });
  const html = (d: BookingDraft) => renderToStaticMarkup(createElement(Booking, { onBook: async () => {}, busy: false, config: { key: '', mapId: 'DEMO_MAP_ID' }, onConfigure: () => {}, draft: d, onDraftChange: () => {}, now: t0 }));
  const rides = html(draft(1, { ...DEMO_PACKAGE, weight: 3.4, dimensions: [40, 30, 20], service: 'priority' }));
  assert.match(rides, /Choose a ride/); assert.match(rides, /Not available · Exceeds 2\.5 kg payload limit/);
  assert.match(rides, /role="radio" aria-checked="false" disabled=""/); assert.match(rides, /min away · arrives /);
  assert.match(html(draft(2)), /Request AERO Standard/); assert.match(html(draft(2, { ...DEMO_PACKAGE, service: 'priority' })), /Request AERO Priority/);
  assert.doesNotMatch(html(draft(2)), /No payment or real pickup will occur/, 'booking no longer promises something Fleet could change');
});
test('the keyless map names its markers and never calls a live flight a simulation', () => {
  assert.equal(fleetMarkerName('AERO–217', true), 'Simulated drone AERO–217, nearest to your pickup');
  assert.equal(fleetMarkerName('AERO–104', false), 'Simulated drone AERO–104');
  const sim = book('m1'), live = { ...sim, live: { droneName: 'Test X500' } as ReturnRecord['live'] };
  assert.equal(flightDroneName(sim), 'Simulated drone AERO–217'); assert.equal(flightDroneName(live), 'Live drone Test X500');
  assert.equal(flightDroneName(legacy('m2')), 'Simulated drone AERO–104', 'records from before the fleet keep the old name');
  const words = routeWords(live);
  for (const text of Object.values(words)) assert.doesNotMatch(text, /simulat|demo/i, text);
  assert.deepEqual([words.hub, words.pickup, words.offline], ['Drop pad', 'Pickup pad', 'Offline route view · last reported position']);
  assert.deepEqual([routeWords(sim).hub, routeWords(sim).offline], ['Return hub', 'Offline route view · simulation continues']);
  assert.match(routeWords(sim).map, /simulated drone route/); assert.equal(routeWords(null).offline, 'Offline map view');
});
