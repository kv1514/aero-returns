import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { EVIDENCE_SQL, SCAN_LIMIT, collectEvidence, countSettledCompleted, evidenceChip, shareChip, verifiedCounts, type EvidenceDB } from '../lib/evidence';
import { DEMO_PACKAGE, createReturn, type LiveFlight, type ReturnRecord } from '../lib/simulation';

const t0 = 1700000000000, now = t0 + 3600_000;
// The real migrations on node:sqlite, behind the same prepare().first()/all() shape D1 exposes.
function database(upTo = 99) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort().filter(f => Number(f.slice(0, 4)) <= upTo))
    for (const sql of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint')) if (sql.trim()) db.exec(sql);
  const d1: EvidenceDB = { prepare: sql => ({ first: async <T,>() => (db.prepare(sql).get() ?? null) as T | null, all: async <T,>() => ({ results: db.prepare(sql).all() as T[] }) }) };
  const put = (id: string, at: number, record: ReturnRecord | string) => db.prepare('INSERT INTO returns (id, owner, created_at, version, record) VALUES (?, ?, ?, 0, ?)').run(id, 'owner-secret-1', at, typeof record === 'string' ? record : JSON.stringify(record));
  const event = (id: string, kind: string, status: string, result: unknown) => db.prepare('INSERT INTO integration_events (id, owner, kind, created_at, status, result) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'owner-secret-2', kind, t0, status, typeof result === 'string' ? result : JSON.stringify(result));
  return { db, d1, put, event };
}
const sim = (id: string, extra: Partial<ReturnRecord> = {}): ReturnRecord => ({ ...createReturn({ ...DEMO_PACKAGE, address: '1820 Private Lane' }, id, t0), ...extra });
const done = (id: string) => sim(id, { loaded: true, elapsed: 100_000 }); // finished by elapsed time; COMPLETED was never persisted
const live = (id: string, phase: LiveFlight['phase'], fault: string | null = null) => sim(id, { loaded: true, live: { droneId: 'd1', droneName: 'Test', transport: 'https', phase, home: [-122.29, 37.88], pickupPad: [-122.28, 37.87], dropPad: [-122.27, 37.86], cruiseAlt: 30, cmdSeq: null, fault, startedAt: t0, phaseAt: t0, telemetry: null } });

test('evidence counts settled completions, live missions, Claude checks and drones, and nothing else', async () => {
  const { d1, put, event, db } = database();
  put('a', t0, done('a'));
  put('b', t0 + 1, sim('b', { elapsed: 100_000 })); // never loaded: waits at pickup forever
  put('c', t0 + 2, sim('c', { loaded: true, elapsed: 100_000, failed: true }));
  put('d', t0 + 3, live('d', 'COMPLETE'));
  put('e', t0 + 4, live('e', 'TO_DROP'));
  put('f', t0 + 5, live('f', 'LAND_DROP', 'LINK_LOST')); // a fault before the handoff pauses the mission: not complete yet
  put('g', t0 + 6, { ...sim('g'), review: { verdict: 'needs_person', condition: 'used', disposition: 'inspect', confidence: .6, explanation: 'x', model: 'm', eventId: 'e1', at: t0 } });
  put('h', t0 + 7, 'not json at all');
  event('1', 'agent', 'complete', { verdict: 'needs_person' }); event('2', 'agent', 'complete', { verdict: 'fly_standard' });
  event('3', 'agent', 'started', {}); event('4', 'agent', 'failed', { verdict: 'needs_person' }); event('5', 'agent', 'complete', '{broken');
  event('6', 'review', 'complete', {}); event('7', 'pickup', 'complete', {}); event('8', 'pickup', 'failed', {}); event('9', 'lookup', 'complete', {});
  db.prepare("INSERT INTO drones (id, owner, name, transport, config, created_at) VALUES ('d1', 'owner-secret-3', 'Test', 'https', '{}', ?)").run(t0);
  const evidence = await collectEvidence(d1, { anthropic: true, apify: false }, now);
  assert.deepEqual({ ...evidence }, {
    storage: true, generatedAt: now, integrations: { anthropic: true, apify: false },
    returnsBooked: 8, returnsCompleted: 2, returnsWithClaudeCheck: 1, liveFlightsCompleted: 1,
    claudeChecks: 3, claudeNeedsPerson: 1, claudePhotoChecks: 2, dronesRegistered: 1,
  });
  const body = JSON.stringify(evidence);
  for (const secret of ['owner-secret', 'Private Lane', 'AERO-DEMO', 'needs_person']) assert.ok(!body.includes(secret), `${secret} must not leave the server`);
});

test('a missing database or unmigrated table blanks only the counts it affects', async () => {
  const missing = await collectEvidence(undefined, { anthropic: false, apify: true }, now);
  assert.equal(missing.storage, false); assert.equal(missing.returnsBooked, null); assert.equal(missing.claudeChecks, null); assert.deepEqual(missing.integrations, { anthropic: false, apify: true });
  const { d1, put } = database(1); // before 0002_drone_link: no drones table
  put('a', t0, done('a'));
  const partial = await collectEvidence(d1, { anthropic: false, apify: false }, now);
  assert.equal(partial.dronesRegistered, null); assert.equal(partial.returnsBooked, 1); assert.equal(partial.returnsCompleted, 1); assert.equal(partial.claudeChecks, 0);
});

test('only the newest loaded returns are settled in code; older ones use their last recorded state', async () => {
  const { d1, put } = database();
  const recorded = (id: string, state: 'COMPLETED' | 'HANDOFF_PENDING') => ({ ...done(id), events: [{ state: 'ASSIGNED' as const, title: '', at: t0 }, { state, title: '', at: t0 }] });
  put('old-1', t0 - 3, recorded('old-1', 'COMPLETED')); put('old-2', t0 - 2, recorded('old-2', 'COMPLETED'));
  put('old-3', t0 - 1, recorded('old-3', 'HANDOFF_PENDING')); // finished by time but never re-read: beyond the scan it is not counted
  for (let i = 0; i < SCAN_LIMIT; i++) put(`new-${i}`, t0 + i, done(`new-${i}`));
  for (let i = 0; i < 5; i++) put(`waiting-${i}`, t0 + SCAN_LIMIT + i, sim(`waiting-${i}`)); // unloaded rows never use up the scan
  const evidence = await collectEvidence(d1, { anthropic: false, apify: false }, now);
  assert.equal(evidence.returnsBooked, SCAN_LIMIT + 8); assert.equal(evidence.returnsCompleted, SCAN_LIMIT + 2);
});

test('rows with the same timestamp are split the same way at the scan boundary: each counted once', async () => {
  const { d1, put } = database();
  // Done by elapsed time and recorded COMPLETED, so a row in both halves would count twice and a row in neither not at all.
  const recorded = (id: string) => ({ ...done(id), events: [{ state: 'ASSIGNED' as const, title: '', at: t0 }, { state: 'COMPLETED' as const, title: '', at: t0 }] });
  const ids = Array.from({ length: SCAN_LIMIT + 40 }, (_, i) => `tie-${String((i * 7919) % (SCAN_LIMIT + 40)).padStart(4, '0')}`);
  for (const id of ids) put(id, t0, recorded(id));
  const evidence = await collectEvidence(d1, { anthropic: false, apify: false }, now);
  assert.equal(evidence.returnsBooked, SCAN_LIMIT + 40); assert.equal(evidence.returnsCompleted, SCAN_LIMIT + 40);
  // SQLite happens to sort ties the same way in both queries; D1 promises nothing, so both must name the tie-breaker.
  for (const sql of [EVIDENCE_SQL.scan, EVIDENCE_SQL.older]) assert.match(sql, /ORDER BY created_at DESC, id DESC LIMIT/);
});

test('a record missing its clock is not counted as completed', () => {
  const broken = (drop: 'rate' | 'anchor' | 'elapsed') => { const r: Record<string, unknown> = { ...done(drop) }; delete r[drop]; return { record: JSON.stringify(r) }; };
  const badPickup = { record: JSON.stringify({ ...done('p'), package: { ...done('p').package, pickup: ['east', 'north'] } }) }; // NaN route timing
  assert.equal(countSettledCompleted([broken('rate'), broken('anchor'), broken('elapsed'), badPickup, { record: JSON.stringify(done('ok')) }], now), 1);
});

test('settled completion is computed from the record, never trusted from it', () => {
  assert.equal(countSettledCompleted([{ record: JSON.stringify(done('a')) }, { record: JSON.stringify(sim('b', { loaded: true, paused: true })) }, { record: '{' }, { record: JSON.stringify({ ...done('c'), facilityId: 'nowhere' }) }, { record: null }], now), 1);
  assert.equal(countSettledCompleted([{ record: JSON.stringify(live('x', 'ABORTED')) }, { record: JSON.stringify({ ...live('y', 'TO_DROP'), cancelled: true }) }, { record: JSON.stringify(live('z', 'LAND_HOME')) }], now), 1);
});

test('chips show only real counts', () => {
  assert.deepEqual(evidenceChip(0, 'Claude check'), { text: 'Claude checks: not yet recorded', recorded: false });
  assert.deepEqual(evidenceChip(null, 'drone'), { text: 'Drones: unavailable', recorded: false });
  assert.deepEqual(evidenceChip(1, 'drone'), { text: '1 drone', recorded: true });
  assert.deepEqual(evidenceChip(1234, 'return booked', 'returns booked'), { text: '1,234 returns booked', recorded: true });
  assert.deepEqual(shareChip(2, 7, 'Claude checks', 'sent to a person'), { text: '2 of 7 Claude checks sent to a person', recorded: true });
  assert.deepEqual(shareChip(0, 0, 'Claude checks', 'sent to a person'), { text: 'Claude checks sent to a person: not yet recorded', recorded: false });
  assert.equal(shareChip(0, 4, 'Claude checks', 'sent to a person').recorded, false);
  assert.equal(shareChip(1, null, 'Claude checks', 'sent to a person').text, 'Claude checks sent to a person: unavailable');
});

test('a not-eligible check counts as sent to a person only when its owner booked it with the hold stamp', async () => {
  const { d1, db } = database();
  const agent = (id: string, owner: string, verdict: string) => db.prepare("INSERT INTO integration_events (id, owner, kind, created_at, status, result) VALUES (?, ?, 'agent', ?, 'complete', ?)").run(id, owner, t0, JSON.stringify({ verdict }));
  const booked = (id: string, owner: string, eventId: string, hold: boolean) => db.prepare('INSERT INTO returns (id, owner, created_at, version, record) VALUES (?, ?, ?, 0, ?)').run(id, owner, t0, JSON.stringify({ ...sim(id), review: { verdict: 'not_drone_eligible', condition: 'new', disposition: 'inspect', confidence: .9, explanation: 'x', model: 'm', eventId, at: t0, ...(hold ? { hold: true } : {}) } }));
  agent('np', 'o1', 'needs_person'); agent('held', 'o1', 'not_drone_eligible'); agent('unbooked', 'o1', 'not_drone_eligible'); agent('legacy', 'o1', 'not_drone_eligible'); agent('foreign', 'o1', 'not_drone_eligible'); agent('ok', 'o1', 'fly_standard');
  booked('r1', 'o1', 'held', true); booked('r2', 'o1', 'held', true); booked('r3', 'o1', 'legacy', false); booked('r4', 'o2', 'foreign', true);
  const evidence = await collectEvidence(d1, { anthropic: true, apify: false }, now);
  assert.deepEqual([evidence.claudeChecks, evidence.claudeNeedsPerson], [6, 2], 'needs_person, plus the stamped one booked twice counted once; never booked, unstamped or another owner’s booking hold nothing');
  assert.ok(!JSON.stringify(evidence).includes('not_drone_eligible'));
});

test('a session’s verified Claude calls include the return check and pickup photo, not only photo reviews', () => {
  assert.deepEqual(verifiedCounts([{ kind: 'agent', n: 2 }, { kind: 'review', n: 1 }, { kind: 'pickup', n: 3 }, { kind: 'lookup', n: 4 }, { kind: 'other', n: 9 }]), { anthropic: 6, apify: 4 });
  assert.deepEqual(verifiedCounts([]), { anthropic: 0, apify: 0 });
  assert.deepEqual(verifiedCounts([{ kind: 'agent', n: null }, { kind: 'review', n: '2' }]), { anthropic: 2, apify: 0 });
});
