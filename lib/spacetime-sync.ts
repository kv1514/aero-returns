/**
 * SpacetimeDB live sync, the pure half (docs/SPACETIMEDB.md): config, opaque keys, reducer payloads and the two HTTP calls.
 * No Worker bindings, so tests import it directly; lib/spacetime-server.ts reads env and D1 and schedules the calls.
 * Payloads are built field by field, never spread: no address, pickup, reference, instructions, name, phone, email, photo
 * or drone config (home, pads, fence) ever leaves the Worker.
 */
import { isStale, type Drone } from './drone-mission';
import { SIM_FLEET, snapshot, type FlightState, type ReturnRecord } from './simulation';

export type SyncEnv = { SPACETIMEDB_URI?: string; SPACETIMEDB_DATABASE?: string; SPACETIMEDB_TOKEN?: string; DRONE_LINK_SECRET?: string };
export type SyncConfig = { uri: string; database: string; token: string; secret: string };
export const DEFAULT_URI = 'https://maincloud.spacetimedb.com', CALL_TIMEOUT_MS = 1500;
const DATABASE = /^[a-z0-9]+(-[a-z0-9]+)*$/, LOCAL = ['localhost', '127.0.0.1', '[::1]'];

/** On only with a database name, the Worker's token and a 32+ character DRONE_LINK_SECRET (the key secret). Plain http only to this machine. */
export function syncConfig(e: SyncEnv): SyncConfig | null {
  const database = e.SPACETIMEDB_DATABASE?.trim() ?? '', token = e.SPACETIMEDB_TOKEN?.trim() ?? '', secret = e.DRONE_LINK_SECRET ?? '';
  if (!DATABASE.test(database) || !token || secret.length < 32) return null;
  let url: URL; try { url = new URL(e.SPACETIMEDB_URI?.trim() || DEFAULT_URI); } catch { return null; }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL.includes(url.hostname))) || url.username || url.password || url.search || url.hash) return null;
  return { uri: url.href.replace(/\/+$/, ''), database, token, secret };
}
/** What the browser may know: whether sync is on and where to connect. Never the token or the secret. */
export const publicSync = (cfg: SyncConfig | null) => (cfg ? { enabled: true, uri: cfg.uri, database: cfg.database } : { enabled: false, uri: null, database: null });

async function key(secret: string, text: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
/** Opaque per-owner key, also the account row's key. The owner string itself never leaves the Worker. */
export const ownerKey = (secret: string, owner: string) => key(secret, `aero-stdb-owner:${owner}`);
/** Key of a simulated flight's row, which only the module's fleet_stats count reads: unlinkable to its return id without the secret. */
export const flightKey = (secret: string, returnId: string) => key(secret, `aero-stdb-flight:${returnId}`);

export type AccountKind = 'demo' | 'account' | 'guest';
/** demo:<uuid>, supabase:<uuid> or user:<id> (Sites proxy), guest:<uuid>; any other owner is not synced. */
export const accountKind = (owner: string): AccountKind | null => (owner.startsWith('demo:') ? 'demo' : owner.startsWith('supabase:') || owner.startsWith('user:') ? 'account' : owner.startsWith('guest:') ? 'guest' : null);
/** Whether an account gets a row: every demo and signed-in account, a guest only once it has booked (anyone can mint a guest cookie). */
export const listed = (kind: AccountKind, returnsTotal: number) => kind !== 'guest' || returnsTotal > 0;

// SpacetimeDB rejects a NaN or out-of-range argument, so every number is made finite and in range here.
const f64 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const u32 = (v: unknown) => Math.min(0xffffffff, Math.max(0, Math.round(f64(v))));
const str = (v: unknown, max = 32) => (typeof v === 'string' ? v.slice(0, max) : '');
const ENDED_STATES: FlightState[] = ['COMPLETED', 'CANCELLED'];
/** Returns that have not ended, counted like busyDrones; an unreadable record counts as ended. */
export const activeReturns = (records: ReturnRecord[], now: number) => records.filter(r => { try { return !ENDED_STATES.includes(snapshot(r, now).state); } catch { return false; } }).length;

export const accountArgs = (accountKey: string, kind: AccountKind, returnsTotal: number, returnsActive: number) => ({ accountKey, kind, returnsTotal: u32(returnsTotal), returnsActive: u32(returnsActive) });

/** The drone fields sync reads. Name, phone and config (home, pads, fence) are deliberately not among them. */
export type SyncDrone = Pick<Drone, 'id' | 'owner' | 'transport' | 'armedUntil' | 'activeReturn' | 'lastSeen' | 'telemetry'>;
/**
 * upsert_drone for the owner's own Fleet (private table, owner-filtered view). Null until the bridge has reported. transport sets
 * how long the module's sweep waits before it marks the drone stale. The position is sent as reported, so a parked drone's is its home or a pad.
 */
export function droneArgs(ownerKey: string, d: SyncDrone, mission: ReturnRecord | null, now: number) {
  const t = d.telemetry; if (!t) return null;
  const live = mission?.live && mission.id === d.activeReturn && mission.live.droneId === d.id ? mission.live : null;
  return { droneId: d.id, ownerKey, lat: f64(t.lat), lng: f64(t.lon), alt: f64(t.alt), heading: f64(t.heading), speed: f64(t.speed), battery: f64(t.battery), sats: u32(t.sats), state: str(t.state), phase: live ? live.phase : '', fault: str(live?.fault), armed: d.armedUntil > now, stale: isStale(d, now), onMission: !!d.activeReturn, transport: d.transport === 'sms' ? 'sms' : 'https' };
}
/** upsert_return: the owner's own status row. A live record has its drone's telemetry attached while that drone flies it, as in attachLive. */
export function returnArgs(ownerKey: string, r: ReturnRecord, now: number) {
  const s = snapshot(r, now);
  // A simulated ETA is in timeline seconds; the customer sees it at the demo's playback rate.
  return { returnId: r.id, ownerKey, mode: r.live ? 'live' : 'simulated', state: s.state, progress: Math.min(1, Math.max(0, f64(s.progress))), etaSeconds: u32(s.eta / (r.live ? 1 : r.rate || 1)), droneLabel: r.live ? 'Live drone' : r.drone ? str(r.drone.id).toUpperCase() : 'Simulated drone' };
}
/** upsert_sim_flight for the shared count (a private row; only fleet_stats reads it): opaque key, demo fleet drone id and state, never coordinates. Null for live flights and records without a fleet drone. */
export function simFlightArgs(flightKey: string, r: ReturnRecord, now: number) {
  const droneId = r.drone?.id; if (r.live || !droneId || !SIM_FLEET.some(d => d.id === droneId)) return null;
  const state = snapshot(r, now).state;
  return { flightKey, droneId, state, done: ENDED_STATES.includes(state) };
}

const IDENTITY = /^(?:0x)?([0-9a-f]{64})$/i, TOKEN = /^[A-Za-z0-9_.-]{16,4000}$/;
/** A SpacetimeDB identity as 64 lowercase hex characters (no 0x), or null. */
export const viewerIdentity = (value: unknown) => (typeof value === 'string' ? value.match(IDENTITY)?.[1].toLowerCase() ?? null : null);
/** POST /api/live-sync body: the browser's own SpacetimeDB identity, its token and the account key it was last granted (if any). */
export function parseGrant(raw: string): { identity: string; token: string; account: string | null } | null {
  try {
    const v = JSON.parse(raw) as { identity?: unknown; token?: unknown; account?: unknown } | null, identity = viewerIdentity(v?.identity), token = typeof v?.token === 'string' && TOKEN.test(v.token) ? v.token : null;
    return identity && token ? { identity, token, account: typeof v?.account === 'string' && /^[0-9a-f]{32}$/.test(v.account) ? v.account : null } : null;
  } catch { return null; }
}
const identityArg = (viewer: string) => ({ __identity__: `0x${viewer}` });
export const grantArgs = (viewer: string, ownerKey: string) => ({ viewer: identityArg(viewer), ownerKey });

/** Whether a link report changed what Fleet shows: an idle drone's report is written at most every few seconds (GROUND_WRITE_MS), a mission's every time. */
export const droneChanged = (before: Pick<SyncDrone, 'lastSeen' | 'activeReturn'>, after: Pick<SyncDrone, 'lastSeen' | 'activeReturn'>) => after.lastSeen !== before.lastSeen || !!(after.activeReturn || before.activeReturn);

export type Reducer = 'upsert_account' | 'upsert_drone' | 'remove_drone' | 'upsert_return' | 'upsert_sim_flight' | 'grant_viewer' | 'revoke_viewer';
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
/** Calls one Worker-only reducer with named (camelCase) arguments. Never throws: false on a network error, timeout or non-2xx (530 is the module's SenderError). */
export async function callReducer(cfg: SyncConfig, name: Reducer, args: object, fetchImpl: Fetch = fetch, timeoutMs = CALL_TIMEOUT_MS) {
  try {
    const res = await fetchImpl(`${cfg.uri}/v1/database/${cfg.database}/call/${name}?confirmed=false`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return res.ok;
  } catch { return false; }
}
export type Verified = 'ok' | 'refused' | 'unavailable';
/** Whether `token` belongs to `identity` on that server: 204 yes; 400 (another identity's token) or 401 (missing or invalid) no; anything else unknown. */
export async function verifyIdentity(cfg: SyncConfig, identity: string, token: string, fetchImpl: Fetch = fetch, timeoutMs = CALL_TIMEOUT_MS): Promise<Verified> {
  if (!/^[0-9a-f]{64}$/.test(identity) || !TOKEN.test(token)) return 'refused';
  try {
    const res = await fetchImpl(`${cfg.uri}/v1/identity/${identity}/verify`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return res.status === 204 ? 'ok' : res.status === 400 || res.status === 401 ? 'refused' : 'unavailable';
  } catch { return 'unavailable'; }
}

export type GrantResult = { status: 'granted'; account: string } | { status: 'rotate' | Exclude<Verified, 'ok'> };
/**
 * The viewer grant behind POST /api/live-sync, once SpacetimeDB confirms the token is that identity's. `previous` is the account
 * key this browser was last granted with this identity: when it is another account's (sign-in, sign-out or a demo switch since),
 * the identity is revoked instead and the browser starts a new one, so a copied token never follows the browser's next account.
 */
export async function grantFlow(cfg: SyncConfig, key: string, identity: string, token: string, previous: string | null, account: () => Promise<unknown>, fetchImpl: Fetch = fetch): Promise<GrantResult> {
  const verified = await verifyIdentity(cfg, identity, token, fetchImpl); if (verified !== 'ok') return { status: verified };
  if (previous && previous !== key) { await callReducer(cfg, 'revoke_viewer', { viewer: identityArg(identity) }, fetchImpl); return { status: 'rotate' }; }
  const [granted] = await Promise.all([callReducer(cfg, 'grant_viewer', grantArgs(identity, key), fetchImpl), account().catch(() => false)]);
  return granted ? { status: 'granted', account: key } : { status: 'unavailable' };
}
/** The route's answer. The account key is the one this viewer already sees in my_account; the token is never echoed. */
export function grantReply(r: GrantResult): { status: number; body: Record<string, unknown> } {
  if (r.status === 'granted') return { status: 200, body: { granted: true, account: r.account } };
  if (r.status === 'rotate') return { status: 409, body: { granted: false, rotate: true, error: 'This browser’s live-sync identity belonged to another account. Connect with a new one.' } };
  return r.status === 'refused' ? { status: 403, body: { granted: false, error: 'SpacetimeDB did not confirm this identity.' } } : { status: 502, body: { granted: false, error: 'Live sync is unavailable right now.' } };
}
