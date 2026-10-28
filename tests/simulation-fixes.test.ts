import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReturn, control, recommend, settle, snapshot, timing, DEMO_PACKAGE } from '../lib/simulation';

const t0 = 1700000000000;
test('next milestone is refused while a test interruption has the flight paused', () => {
  const failed = control(createReturn({ ...DEMO_PACKAGE }, 'r1', t0), 'fail', t0 + 1000);
  assert.throws(() => control(failed, 'advance', t0 + 2000), /resumes/);
  assert.notEqual(snapshot(control(failed, 'retry', t0 + 3000), t0 + 3000).state, 'FAILED');
});
test('after loading, the ETA counts down to the handoff instead of reading zero', () => {
  let r = createReturn({ ...DEMO_PACKAGE }, 'r2', t0); const t = timing(r);
  const atPickup = t0 + Math.ceil((t.pickup + 4) * 1000);
  r = control(r, 'load', atPickup);
  const s = snapshot(r, atPickup + 1000);
  assert.equal(s.state, 'PACKAGE_LOADED'); assert.ok(s.eta > 30, `eta ${s.eta}`);
});
test('skipped milestones are never stamped earlier than the event before them', () => {
  let r = createReturn({ ...DEMO_PACKAGE }, 'r3', t0); const t = timing(r);
  r = control(r, 'advance', t0 + 2000);
  r = control(r, 'load', t0 + 3000);
  r = settle(control(r, 'advance', t0 + Math.ceil(t.depart * 10)), t0 + Math.ceil(t.depart * 10) + 500);
  for (let i = 1; i < r.events.length; i++) assert.ok(r.events[i].at >= r.events[i - 1].at, `${r.events[i].state} before ${r.events[i - 1].state}`);
});
test('priority estimates use the faster priority flight speed', () => {
  const standard = recommend({ ...DEMO_PACKAGE, service: 'standard' }).find(f => !f.reason)!, priority = recommend({ ...DEMO_PACKAGE, service: 'priority' }).find(f => f.id === standard.id)!;
  assert.ok(priority.minutes <= standard.minutes);
});
