/**
 * Mirrors live state into SpacetimeDB (docs/SPACETIMEDB.md). D1 stays the source of truth: every publish is scheduled with
 * waitUntil, never awaited by a request, time-limited and dropped on failure, and all of it is a no-op until
 * SPACETIMEDB_DATABASE, SPACETIMEDB_TOKEN and DRONE_LINK_SECRET are set. Reads are owner-scoped, and drones arrive already
 * loaded; only the fields droneArgs picks leave the Worker. Shaping, redaction and the grant flow are pure, in spacetime-sync.ts.
 */
import { env, waitUntil } from 'cloudflare:workers';
import type { ReturnRecord } from './simulation';
import { accountArgs, accountKind, activeReturns, callReducer, droneArgs, droneChanged, flightKey, grantFlow, listed, ownerKey, returnArgs, simFlightArgs, syncConfig, type GrantResult, type SyncConfig, type SyncDrone } from './spacetime-sync';

export const liveSync = () => syncConfig(env);
/** Runs `work` in the background of this request; the response never waits for it and nothing it does can fail the request. */
function later(work: (cfg: SyncConfig) => Promise<unknown>) {
  const cfg = liveSync(); if (!cfg) return;
  try { waitUntil(work(cfg).catch(() => {})); } catch { /* no request context: the work still runs, unattended */ }
}

const loadRecord = async (db: D1Database, id: string, owner: string) => { const row = await db.prepare('SELECT record FROM returns WHERE id = ? AND owner = ?').bind(id, owner).first<{ record: string }>(); return row ? JSON.parse(row.record) as ReturnRecord : null; };
async function sendReturn(cfg: SyncConfig, owner: string, r: ReturnRecord, now: number) {
  const key = await ownerKey(cfg.secret, owner), flight = r.live ? null : simFlightArgs(await flightKey(cfg.secret, r.id), r, now);
  await Promise.all([callReducer(cfg, 'upsert_return', returnArgs(key, r, now)), flight && callReducer(cfg, 'upsert_sim_flight', flight)]);
}
async function sendAccount(cfg: SyncConfig, owner: string) {
  const db = env.DB, kind = accountKind(owner); if (!db || !kind) return false;
  // Active counts the 20 newest returns, the same window booking uses to find busy drones.
  const [total, recent] = await Promise.all([db.prepare('SELECT COUNT(*) AS n FROM returns WHERE owner = ?').bind(owner).first<{ n: number }>(), db.prepare('SELECT record FROM returns WHERE owner = ? ORDER BY created_at DESC LIMIT 20').bind(owner).all<{ record: string }>()]);
  const records = recent.results.flatMap(row => { try { return [JSON.parse(row.record) as ReturnRecord]; } catch { return []; } });
  if (!listed(kind, total?.n ?? 0)) return false;
  return callReducer(cfg, 'upsert_account', accountArgs(await ownerKey(cfg.secret, owner), kind, total?.n ?? 0, activeReturns(records, Date.now())));
}

/**
 * A real drone's telemetry and mission state for its owner's Fleet, plus the customer's status of the live return it flies.
 * `returnId` is the return it flew before this request, so a flight that just ended still sends its final state and the owner's new counts.
 */
export function publishDrone(db: D1Database, drone: SyncDrone, returnId?: string | null) {
  later(async cfg => {
    const now = Date.now(), ids = [...new Set([drone.activeReturn, returnId].filter((id): id is string => !!id))];
    const records = (await Promise.all(ids.map(id => loadRecord(db, id, drone.owner)))).filter((r): r is ReturnRecord => !!r?.live && r.live.droneId === drone.id);
    const key = await ownerKey(cfg.secret, drone.owner), args = droneArgs(key, drone, records.find(r => r.id === drone.activeReturn) ?? null, now);
    await Promise.all([
      args && callReducer(cfg, 'upsert_drone', args),
      // As in attachLive, only the flight the drone is flying now reads its telemetry; an ended one keeps its final report.
      ...records.map(r => callReducer(cfg, 'upsert_return', returnArgs(key, r.id === drone.activeReturn ? { ...r, live: { ...r.live!, telemetry: drone.telemetry } } : r, now))),
      returnId && returnId !== drone.activeReturn && sendAccount(cfg, drone.owner),
    ]);
  });
}
/** publishDrone after a link report (HTTPS or SMS), only when the report changed the stored drone (see droneChanged). */
export function publishReport(db: D1Database, before: SyncDrone, after: SyncDrone) { if (droneChanged(before, after)) publishDrone(db, after, before.activeReturn); }
/** A return's status for its owner's screens and, when simulated, its row in the shared flight count. `account` also refreshes the owner's return counts. */
export function publishReturn(owner: string, r: ReturnRecord, now: number, account = false) { later(cfg => Promise.all([sendReturn(cfg, owner, r, now), account && sendAccount(cfg, owner)])); }
/** This account's row (kind and return counts) in the live account list; a guest only once it has booked. */
export function publishAccount(owner: string | null | undefined) { if (owner) later(cfg => sendAccount(cfg, owner)); }
/** Drops a removed drone from its owner's live Fleet. */
export function removeDrone(droneId: string) { later(cfg => callReducer(cfg, 'remove_drone', { droneId })); }

/**
 * Lets one browser's SpacetimeDB identity see its owner's private rows (grantFlow), or revokes it when the browser's account
 * changed. Awaited by POST /api/live-sync, every call time-limited; the token is used for that check only, never stored or logged.
 */
export async function grantViewer(cfg: SyncConfig, owner: string, identity: string, token: string, previous: string | null): Promise<GrantResult> {
  return grantFlow(cfg, await ownerKey(cfg.secret, owner), identity, token, previous, () => sendAccount(cfg, owner));
}
