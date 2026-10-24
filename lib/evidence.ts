/**
 * Judge-room evidence: anonymous, aggregate-only counts from D1 for /api/evidence and /demo.
 * Only counts leave this module: no owner ids, record contents, photos or descriptions. Client-safe (no env, no secrets);
 * the route passes in the D1 binding and the integration flags.
 */
import { snapshot, type ReturnRecord } from './simulation';

/** null means the count could not be read (no database binding, or a table that has not been migrated). */
export type Count = number | null;
export type Evidence = {
  /** The returns table could be read. */
  storage: boolean; generatedAt: number;
  returnsBooked: Count; returnsCompleted: Count; returnsWithClaudeCheck: Count;
  claudeChecks: Count; claudeNeedsPerson: Count; claudePhotoChecks: Count;
  liveFlightsCompleted: Count; dronesRegistered: Count;
  /** Configuration only: a set key is not a verified call. */
  integrations: { anthropic: boolean; apify: boolean };
};
/** Structural subset of D1Database, so tests can run the same SQL on node:sqlite. */
type Statement = { first<T = Record<string, unknown>>(): Promise<T | null>; all<T = Record<string, unknown>>(): Promise<{ results: T[] }> };
export type EvidenceDB = { prepare(query: string): Statement };

/** Simulated returns finish by elapsed time, so the newest loaded rows are settled in code; older ones use their last recorded event. */
export const SCAN_LIMIT = 500;
// Malformed JSON makes json_extract throw for the whole query, so every read is guarded.
const field = (column: string, path: string) => `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '${path}') END`;
const loaded = `${field('record', '$.loaded')} = 1`, NEWEST_FIRST = 'ORDER BY created_at DESC, id DESC';
export const EVIDENCE_SQL = {
  returns: `SELECT COUNT(*) AS booked, COALESCE(SUM(${field('record', '$.live.phase')} = 'COMPLETE'), 0) AS liveCompleted, COALESCE(SUM(${field('record', '$.review.verdict')} IS NOT NULL), 0) AS withCheck FROM returns`,
  // Data minimisation: addresses, notes, references, reviews, the event journal and telemetry never leave D1. The pickup
  // coordinates do reach the Worker, because snapshot() needs them for the route, but only the resulting count goes further.
  // scan and older must split the rows the same way, so equal timestamps are ordered by id in both.
  scan: `SELECT json_remove(record, '$.events', '$.review', '$.package.address', '$.package.instructions', '$.package.returnReference', '$.live.telemetry') AS record FROM returns WHERE ${loaded} ${NEWEST_FIRST} LIMIT ${SCAN_LIMIT}`,
  older: `SELECT COUNT(*) AS n FROM (SELECT record FROM returns WHERE ${loaded} ${NEWEST_FIRST} LIMIT -1 OFFSET ${SCAN_LIMIT}) WHERE ${field('record', '$.events[#-1].state')} = 'COMPLETED'`,
  events: `SELECT COALESCE(SUM(kind = 'agent'), 0) AS checks, COALESCE(SUM(kind = 'agent' AND ${field('result', '$.verdict')} = 'needs_person'), 0) AS needsPerson, COALESCE(SUM(kind IN ('review', 'pickup')), 0) AS photo FROM integration_events WHERE status = 'complete' AND kind IN ('agent', 'review', 'pickup')`,
  drones: 'SELECT COUNT(*) AS n FROM drones',
};

const count = (value: unknown): Count => { const n = Number(value); return value == null || value === '' || !Number.isFinite(n) ? null : Math.max(0, Math.round(n)); };
const attempt = async <T,>(read: () => Promise<T>): Promise<T | null> => { try { return await read(); } catch { return null; } };

/** Counts records whose settled state is COMPLETED (simulated by elapsed time, live by mission phase). Unreadable rows count as nothing,
 *  including a record missing its clock (rate, anchor, elapsed): its elapsed time is NaN, which snapshot() would read as COMPLETED. */
export function countSettledCompleted(rows: { record: unknown }[], now: number): number {
  let n = 0;
  for (const row of rows) {
    try { const r = JSON.parse(String(row.record)) as ReturnRecord; const s = snapshot({ ...r, events: [] }, now); if (Number.isFinite(s.elapsed) && s.state === 'COMPLETED') n++; } catch { /* not evidence */ }
  }
  return n;
}

export const EMPTY_EVIDENCE: Omit<Evidence, 'generatedAt' | 'integrations'> = { storage: false, returnsBooked: null, returnsCompleted: null, returnsWithClaudeCheck: null, claudeChecks: null, claudeNeedsPerson: null, claudePhotoChecks: null, liveFlightsCompleted: null, dronesRegistered: null };

/** Every query is independent: a missing table (e.g. drones before migration 0002) blanks only its own counts. */
export async function collectEvidence(db: EvidenceDB | undefined, flags: Evidence['integrations'], now = Date.now()): Promise<Evidence> {
  const base: Evidence = { ...EMPTY_EVIDENCE, generatedAt: now, integrations: { anthropic: !!flags.anthropic, apify: !!flags.apify } };
  if (!db) return base;
  const first = <T,>(sql: string) => attempt(() => db.prepare(sql).first<T>());
  const [returns, scan, older, events, drones] = await Promise.all([
    first<{ booked: number; liveCompleted: number; withCheck: number }>(EVIDENCE_SQL.returns),
    attempt(async () => (await db.prepare(EVIDENCE_SQL.scan).all<{ record: string }>()).results),
    first<{ n: number }>(EVIDENCE_SQL.older), first<{ checks: number; needsPerson: number; photo: number }>(EVIDENCE_SQL.events), first<{ n: number }>(EVIDENCE_SQL.drones),
  ]);
  return {
    ...base, storage: !!returns,
    returnsBooked: count(returns?.booked), liveFlightsCompleted: count(returns?.liveCompleted), returnsWithClaudeCheck: count(returns?.withCheck),
    // If only the older-row query fails, the newest SCAN_LIMIT loaded returns are still an exact lower bound.
    returnsCompleted: scan ? countSettledCompleted(scan, now) + (count(older?.n) ?? 0) : null,
    claudeChecks: count(events?.checks), claudeNeedsPerson: count(events?.needsPerson), claudePhotoChecks: count(events?.photo),
    dronesRegistered: count(drones?.n),
  };
}

export type EvidenceChip = { text: string; recorded: boolean };
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Only real counts: zero reads "not yet recorded", an unreadable count reads "unavailable". */
export function evidenceChip(n: Count | undefined, one: string, many = `${one}s`): EvidenceChip {
  if (n == null) return { text: `${upper(many)}: unavailable`, recorded: false };
  if (n <= 0) return { text: `${upper(many)}: not yet recorded`, recorded: false };
  return { text: `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`, recorded: true };
}
/** "2 of 7 Claude checks sent to a person"; nothing to share until the total is recorded. */
export function shareChip(part: Count | undefined, total: Count | undefined, of: string, outcome: string): EvidenceChip {
  if (part == null || total == null) return { text: `${upper(of)} ${outcome}: unavailable`, recorded: false };
  if (total <= 0) return { text: `${upper(of)} ${outcome}: not yet recorded`, recorded: false };
  return { text: `${Math.min(part, total).toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${of} ${outcome}`, recorded: part > 0 };
}
