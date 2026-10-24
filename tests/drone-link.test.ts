import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveDroneKey, formatCommand, formatTelemetry, lineDroneId, parseCommandBody, parseDroneBody, signLine, verifyLine } from '../lib/drone-protocol';
import { ackOutcome, customerAction, dispatchBlockers, enterPhase, configProblem, operatorAction, phaseCommand, startLive, type Drone } from '../lib/drone-mission';
import { createReturn, DEMO_PACKAGE, snapshot, control, type LiveTelemetry, type MissionPhase, type Point } from '../lib/simulation';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/drone-link-vectors.json', import.meta.url), 'utf8'));
const t0 = 1761312345000, home: Point = [-122.2595, 37.8719], pickup: Point = [-122.2590, 37.8722], drop: Point = [-122.2585, 37.8716];
const ground: LiveTelemetry = { ts: t0, receivedAt: t0, lat: home[1], lon: home[0], alt: 0, battery: 92, heading: 0, speed: 0, fix: 3, sats: 12, state: 'LANDED', mode: 'LOITER' };
const drone = (patch: Partial<Drone> = {}): Drone => ({ id: 'tst001', owner: 'guest:x', name: 'Test X500', transport: 'https', phone: null, phoneVerified: false, keyVersion: 1, config: { home, pickupPad: pickup, dropPad: drop, radius: 300, maxAlt: 60, cruiseAlt: 25 }, armedUntil: t0 + 60_000, activeReturn: null, lastSeq: 0, lastSeen: t0, telemetry: ground, createdAt: t0, ...patch });

test('drone keys and signed lines match the shared vectors used by the Python bridge', async () => {
  const key = await deriveDroneKey(vectors.master, vectors.droneId, vectors.keyVersion);
  assert.equal(key, vectors.key);
  for (const line of Object.values(vectors.lines) as string[]) {
    const body = await verifyLine(key, line);
    assert.ok(body, line); assert.equal(await signLine(key, body!), line); assert.equal(lineDroneId(line), 'tst001');
  }
  assert.equal(await verifyLine(key, vectors.lines.goto.replace('30.0', '90.0')), null);
  assert.equal(await verifyLine(await deriveDroneKey(vectors.master, vectors.droneId, 2), vectors.lines.goto), null);
  await assert.rejects(deriveDroneKey('short', 'tst001', 1), /32 characters/);
});
test('parsers accept only well-formed, in-range messages', async () => {
  const key = vectors.key;
  const telemetry = parseDroneBody((await verifyLine(key, vectors.lines.telemetry))!);
  assert.equal(telemetry?.kind, 'telemetry'); assert.equal(telemetry && telemetry.kind === 'telemetry' && telemetry.state, 'ENROUTE');
  const ack = parseDroneBody((await verifyLine(key, vectors.lines.rejected))!);
  assert.deepEqual(ack, { kind: 'ack', droneId: 'tst001', seq: 1761312347000, ts: 1761312347, cmdSeq: 9, status: 'REJECTED', reason: 'FENCE' });
  assert.deepEqual(parseCommandBody((await verifyLine(key, vectors.lines.goto))!)?.args, [37.871234, -122.258901, 30]);
  const base = { droneId: 'tst001', seq: 5, ts: 1761312345, lat: 37.87, lon: -122.25, alt: 10, battery: 80, heading: 90, speed: 3, fix: 3, sats: 9, state: 'ENROUTE' as const, mode: 'GUIDED' };
  assert.ok(parseDroneBody(formatTelemetry(base)));
  assert.equal(parseDroneBody(formatTelemetry({ ...base, lat: 91 })), null);
  assert.equal(parseDroneBody(formatTelemetry(base).replace('ENROUTE', 'FLYING')), null);
  assert.equal(parseDroneBody(formatTelemetry(base) + ' extra'), null);
  assert.equal(parseDroneBody('AK1 tst001 5 1761312345 3 DONE bad-reason'), null);
  assert.equal(parseCommandBody('AC1 tst001 1 1761312400 GOTO 37.8 -122.2'), null);
  assert.equal(parseCommandBody('AC1 tst001 1 1761312400 GOTO 91.0 -122.2 30.0'), null, 'latitude is range-checked per argument');
  assert.equal(parseCommandBody('AC1 tst001 1 1761312400 TAKEOFF 121.0'), null, 'altitude stays under the 120 m cap');
  assert.throws(() => formatCommand({ droneId: 'tst001', seq: 1, expires: 1, type: 'GOTO', args: [37.8, -122.2, 130] }), /out of range/);
  assert.equal(formatTelemetry({ ...base, heading: -10 }).split(' ')[8], '350', 'heading wraps into [0, 360)');
  assert.ok(parseDroneBody(formatTelemetry({ ...base, fix: 8 })), 'RTK/PPP fix types up to 8 are valid');
});
test('geofence and altitude limits are enforced before a drone can fly', () => {
  assert.equal(configProblem(drone().config), null);
  assert.match(configProblem({ ...drone().config, maxAlt: 150 })!, /400 ft/);
  assert.match(configProblem({ ...drone().config, radius: 5000 })!, /radius/);
  assert.match(configProblem({ ...drone().config, cruiseAlt: 80 })!, /Cruise/);
  assert.match(configProblem({ ...drone().config, dropPad: [-122.27, 37.88] })!, /Drop pad is outside/);
});
test('dispatch requires an armed, fresh, grounded drone with GPS and battery', () => {
  const r = createReturn({ ...DEMO_PACKAGE }, 'ret-1', t0);
  assert.deepEqual(dispatchBlockers(drone(), r, t0), []);
  assert.match(dispatchBlockers(drone({ armedUntil: 0 }), r, t0).join(), /checklist/);
  assert.match(dispatchBlockers(drone({ lastSeen: t0 - 60_000 }), r, t0).join(), /fresh telemetry/);
  assert.match(dispatchBlockers(drone({ telemetry: { ...ground, sats: 3 } }), r, t0).join(), /GPS/);
  assert.match(dispatchBlockers(drone({ telemetry: { ...ground, battery: 20 } }), r, t0).join(), /Battery/);
  assert.match(dispatchBlockers(drone({ telemetry: { ...ground, alt: 12, state: 'HOLD' } }), r, t0).join(), /landed and idle/);
  assert.match(dispatchBlockers(drone({ telemetry: { ...ground, alt: 1, state: 'TAKEOFF' } }), r, t0).join(), /landed and idle/, 'low but airborne states count as flying');
  assert.match(dispatchBlockers(drone({ telemetry: { ...ground, state: 'ERROR' } }), r, t0).join(), /error/);
  assert.match(dispatchBlockers(drone({ activeReturn: 'other' }), r, t0).join(), /another return/);
  assert.match(dispatchBlockers(drone(), { ...r, loaded: true }, t0).join(), /unloaded/);
});
test('a live mission flies one acknowledged step at a time and never launches without the operator', () => {
  const d = drone();
  let r = enterPhase(startLive(createReturn({ ...DEMO_PACKAGE }, 'ret-2', t0), d, t0), 'TAKEOFF_OUT', t0, 1);
  assert.deepEqual(phaseCommand(r.live!, 'TAKEOFF_OUT'), { type: 'TAKEOFF', args: [25] });
  assert.deepEqual(phaseCommand(r.live!, 'TO_PICKUP'), { type: 'GOTO', args: [pickup[1], pickup[0], 25] });
  assert.equal(snapshot(r, t0).state, 'PRE_FLIGHT');
  assert.throws(() => control(r, 'advance', t0), /drone operator/);
  assert.equal(ackOutcome(r.live!, { cmdSeq: 99, status: 'DONE' }), null, 'acks for other commands are ignored');
  assert.equal(ackOutcome(r.live!, { cmdSeq: 1, status: 'ACCEPTED' }), null);
  const steps = [['TO_PICKUP', 'EN_ROUTE_TO_PICKUP'], ['LAND_PICKUP', 'ARRIVED_AT_PICKUP'], ['AWAITING_LOAD', 'AWAITING_PACKAGE']] as const;
  let seq = 1;
  for (const [phase, state] of steps) {
    const next = ackOutcome(r.live!, { cmdSeq: seq, status: 'DONE' })!; assert.equal(next.phase, phase);
    r = enterPhase(r, next.phase, t0, phaseCommand(r.live!, next.phase) ? ++seq : null); assert.equal(snapshot(r, t0).state, state);
  }
  assert.throws(() => customerAction({ ...r, live: { ...r.live!, telemetry: { ...ground, alt: 5, state: 'HOLD' } } }, 'load'), /landed/);
  assert.throws(() => operatorAction(r, 'launch'), /after the customer confirms/);
  const loaded = customerAction(r, 'load'); assert.equal(loaded.phase, 'READY_TO_LAUNCH'); assert.equal(loaded.command, undefined);
  r = enterPhase(r, loaded.phase, t0, null); assert.equal(r.loaded, true); assert.equal(snapshot(r, t0).state, 'PACKAGE_LOADED');
  assert.throws(() => customerAction(r, 'cancel'), /cannot be cancelled/);
  const launch = operatorAction(r, 'launch'); assert.deepEqual(launch, { phase: 'TAKEOFF_LOADED', command: { type: 'TAKEOFF', args: [25] } });
  r = enterPhase(r, launch.phase, t0, ++seq);
  for (const phase of ['TO_DROP', 'LAND_DROP', 'AWAITING_UNLOAD'] as const) { const n = ackOutcome(r.live!, { cmdSeq: seq, status: 'DONE' })!; assert.equal(n.phase, phase); r = enterPhase(r, phase, t0, phaseCommand(r.live!, phase) ? ++seq : null); }
  assert.equal(snapshot(r, t0).state, 'HANDOFF_PENDING');
  r = enterPhase(r, operatorAction(r, 'unload').phase, t0, ++seq); assert.equal(snapshot(r, t0).state, 'COMPLETED');
  assert.equal(ackOutcome(r.live!, { cmdSeq: seq, status: 'DONE' })!.phase, 'RETURNING');
  assert.deepEqual(phaseCommand(r.live!, 'RETURNING'), { type: 'GOTO', args: [home[1], home[0], 25] }, 'flies to the stored home pad, not RTL');
  r = enterPhase(r, 'RETURNING', t0, ++seq); assert.equal(ackOutcome(r.live!, { cmdSeq: seq, status: 'DONE' })!.phase, 'LAND_HOME');
  r = enterPhase(r, 'LAND_HOME', t0, ++seq); assert.equal(ackOutcome(r.live!, { cmdSeq: seq, status: 'DONE' })!.phase, 'COMPLETE');
  assert.deepEqual(r.events.map(e => e.state), ['ASSIGNED', 'PRE_FLIGHT', 'EN_ROUTE_TO_PICKUP', 'ARRIVED_AT_PICKUP', 'AWAITING_PACKAGE', 'PACKAGE_LOADED', 'EN_ROUTE_TO_DROPOFF', 'ARRIVED_AT_DROPOFF', 'HANDOFF_PENDING', 'COMPLETED']);
});
test('faults pause the mission until the operator retries, and abort always flies home', () => {
  let r = enterPhase(startLive(createReturn({ ...DEMO_PACKAGE }, 'ret-3', t0), drone(), t0), 'TO_PICKUP', t0, 4);
  const fault = ackOutcome(r.live!, { cmdSeq: 4, status: 'REJECTED', reason: 'FENCE' })!;
  assert.deepEqual(fault, { phase: 'TO_PICKUP', fault: 'FENCE' });
  r = enterPhase(r, fault.phase, t0, 4, fault.fault); assert.equal(snapshot(r, t0).state, 'FAILED');
  assert.equal(ackOutcome(r.live!, { cmdSeq: 4, status: 'DONE' }), null, 'a paused mission does not advance on stale acks');
  assert.deepEqual(operatorAction(r, 'retry'), { phase: 'TO_PICKUP', command: { type: 'GOTO', args: [pickup[1], pickup[0], 25] } });
  const atPhase = (phase: MissionPhase) => ({ ...r, live: { ...r.live!, fault: null, phase } });
  assert.deepEqual(customerAction(atPhase('TO_PICKUP'), 'cancel'), { phase: 'ABORTED', cancelled: true, command: { type: 'RTL', args: [] } }, 'en route: fly home');
  assert.deepEqual(customerAction(atPhase('TAKEOFF_OUT'), 'cancel'), { phase: 'ABORTED', cancelled: true, command: { type: 'LAND', args: [] } }, 'during takeoff: land, which supersedes the queued TAKEOFF');
  assert.deepEqual(customerAction(atPhase('LAND_PICKUP'), 'cancel'), { phase: 'ABORTED', cancelled: true, command: { type: 'LAND', args: [] } });
  assert.deepEqual(customerAction(atPhase('AWAITING_LOAD'), 'cancel'), { phase: 'ABORTED', cancelled: true }, 'no automatic takeoff after landing at pickup');
  assert.deepEqual(operatorAction({ ...r, live: { ...r.live!, phase: 'AWAITING_LOAD', fault: 'OPERATOR_HOLD' } }, 'retry'), { phase: 'AWAITING_LOAD' }, 'a fault in a waiting phase just clears');
  const ended = enterPhase(atPhase('TO_PICKUP'), 'ABORTED', t0, null);
  assert.equal(snapshot(ended, t0).state, 'CANCELLED'); assert.equal(snapshot(ended, t0).eta, 0);
  assert.equal(ended.events[ended.events.length - 1].title, 'Live flight ended by the pilot');
});
test('live tracking uses reported telemetry instead of the timeline', () => {
  const r = enterPhase(startLive(createReturn({ ...DEMO_PACKAGE }, 'ret-4', t0), drone(), t0), 'TO_PICKUP', t0, 2);
  const tel = { ...ground, lat: 37.87205, lon: -122.25925, alt: 24.6, state: 'ENROUTE', speed: 8, heading: 45 };
  const s = snapshot({ ...r, live: { ...r.live!, telemetry: tel } }, t0 + 999_000);
  assert.deepEqual(s.point, [tel.lon, tel.lat]); assert.equal(s.altitude, 24.6); assert.equal(s.flying, true); assert.equal(s.heading, 45);
  assert.equal(s.state, 'EN_ROUTE_TO_PICKUP'); assert.ok(s.remaining > 0 && s.remaining < 50); assert.ok(s.progress > 0 && s.progress < 1);
  assert.deepEqual(s.path.inbound, [home, pickup]);
});
