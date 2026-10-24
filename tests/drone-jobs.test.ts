import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJob, isActiveJob, jobRequestSchema, jobStep, legCommand, onAck, onCancel, onLoaded, onResume, remainingWaypoints, JOB_STEPS, type DeliveryJob } from '../lib/drone-jobs';

const t0 = 1_800_000_000_000;
const pickup: [number, number] = [-122.2585, 37.8726], dropoff: [number, number] = [-122.2570, 37.8735];
const fresh = (returnHome = true) => createJob({ op: 'create', pickup, dropoff, altM: 25, speedMs: 6, returnHome, pilotReady: true }, 'job-1', 'drone-1', t0);
const statuses = (j: DeliveryJob) => j.events.map(e => e.status);

test('a full delivery walks every status in order and returns home', () => {
  let j = fresh();
  assert.equal(j.status, 'dispatched'); assert.equal(j.leg, 'pickup');
  assert.deepEqual(legCommand(j, 'pickup'), { type: 'FLY_ROUTE', params: { waypoints: [pickup], altM: 25, speedMs: 6, land: true, release: false } });
  j = onAck(j, 'pickup', 'accepted', undefined, t0 + 1).job;
  let r = onAck(j, 'pickup', 'done', 'Landed.', t0 + 2); j = r.job;
  assert.equal(j.status, 'at_pickup'); assert.equal(r.next, null, 'the drone waits for a person to load the package');
  j = onLoaded(j, t0 + 3);
  assert.equal(j.status, 'package_loaded'); assert.equal(j.leg, 'dropoff'); assert.equal(j.loaded, true);
  assert.equal(legCommand(j, 'dropoff').params?.release, true);
  j = onAck(j, 'dropoff', 'accepted', undefined, t0 + 4).job;
  r = onAck(j, 'dropoff', 'done', 'Landed. Package released.', t0 + 5); j = r.job;
  assert.equal(j.status, 'delivered'); assert.equal(r.next, 'return');
  assert.deepEqual(legCommand(j, 'return'), { type: 'RTL', params: null });
  j = onAck(j, 'return', 'accepted', undefined, t0 + 6).job;
  j = onAck(j, 'return', 'done', 'Landed.', t0 + 7).job;
  assert.deepEqual(statuses(j), ['dispatched', 'en_route_pickup', 'at_pickup', 'package_loaded', 'en_route_dropoff', 'delivered', 'returning', 'completed']);
  assert.equal(isActiveJob(j), false); assert.equal(jobStep(j), JOB_STEPS.length - 1);
});
test('without return home, delivery completes at the drop-off', () => {
  let j = onLoaded(onAck(fresh(false), 'pickup', 'done', undefined, t0 + 1).job, t0 + 2);
  const r = onAck(j, 'dropoff', 'done', undefined, t0 + 3); j = r.job;
  assert.equal(r.next, null); assert.equal(j.status, 'completed');
  assert.ok(statuses(j).includes('delivered'));
});
test('loading cannot be confirmed before the drone lands at the pickup', () => {
  assert.throws(() => onLoaded(fresh(), t0 + 1), /land at the pickup/);
  const flying = onAck(fresh(), 'pickup', 'accepted', undefined, t0 + 1).job;
  assert.throws(() => onLoaded(flying, t0 + 2));
});
test('acks for an old leg, duplicates and finished jobs are ignored', () => {
  const j = onAck(fresh(), 'pickup', 'accepted', undefined, t0 + 1).job;
  assert.equal(onAck(j, 'pickup', 'accepted', undefined, t0 + 2).job, j, 'duplicate accepted ack');
  assert.equal(onAck(j, 'dropoff', 'done', undefined, t0 + 2).job, j, 'wrong leg');
  const cancelled = onCancel(j, t0 + 3);
  assert.equal(onAck(cancelled, 'pickup', 'done', undefined, t0 + 4).job, cancelled);
  assert.throws(() => onCancel(cancelled, t0 + 5));
});
test('a failed leg needs attention and resumes from where it stopped', () => {
  const loaded = onLoaded(onAck(fresh(), 'pickup', 'done', undefined, t0 + 1).job, t0 + 2);
  const failed = onAck(loaded, 'dropoff', 'failed', 'Command stopped: website link lost.', t0 + 3).job;
  assert.equal(failed.status, 'failed'); assert.match(failed.error!, /link lost/);
  const resumed = onResume(failed, t0 + 4);
  assert.equal(resumed.leg, 'dropoff'); assert.equal(resumed.status, 'package_loaded'); assert.equal(resumed.error, null);
  assert.deepEqual(remainingWaypoints(resumed), [dropoff]);
  const early = onResume(onAck(fresh(), 'pickup', 'failed', 'Replaced by LAND.', t0 + 1).job, t0 + 2);
  assert.equal(early.leg, 'pickup'); assert.deepEqual(remainingWaypoints(early), [pickup, dropoff]);
  assert.throws(() => onResume(fresh(), t0 + 1), /needs attention/);
});
test('job requests are validated', () => {
  assert.equal(jobRequestSchema.safeParse({ op: 'create', pickup, dropoff, altM: 25 }).success, false, 'pilot confirmation required');
  assert.equal(jobRequestSchema.safeParse({ op: 'create', pickup, dropoff, altM: 500, pilotReady: true }).success, false);
  assert.equal(jobRequestSchema.safeParse({ op: 'create', pickup, dropoff, altM: 25, pilotReady: true }).success, true);
  assert.equal(jobRequestSchema.safeParse({ op: 'loaded', jobId: 'job-1' }).success, true);
  assert.equal(jobRequestSchema.safeParse({ op: 'teleport', jobId: 'job-1' }).success, false);
});
