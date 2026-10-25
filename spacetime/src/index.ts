/**
 * AERO's SpacetimeDB module: a real-time mirror of D1 for live fleet and return status (D1 stays the source of truth).
 * Only the AERO Worker (env WORKER_IDENTITY) writes. Every table is private: owner rows reach a browser only through the
 * my_* views, filtered by the viewer grant the Worker gave that browser's identity, and the shared view across all
 * customers is fleet_stats, counts only. No per-flight row is public: a simulated flight's drone and state-change times
 * are enough to work out roughly where its pickup is.
 */
import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// Columns shared by a private table and the row its view returns (fresh builders each call; tables add their indexes).
const accountCols = () => ({ accountKey: t.string().primaryKey(), kind: t.string(), returnsTotal: t.u32(), returnsActive: t.u32(), firstSeen: t.timestamp(), lastSeen: t.timestamp() });
const droneCols = () => ({
  droneId: t.string().primaryKey(), ownerKey: t.string(), lat: t.f64(), lng: t.f64(), alt: t.f64(), heading: t.f64(), speed: t.f64(), battery: t.f64(), sats: t.u32(),
  state: t.string(), phase: t.string(), fault: t.string(), armed: t.bool(), stale: t.bool(), onMission: t.bool(), transport: t.string(), updatedAt: t.timestamp(),
});
const returnCols = () => ({ returnId: t.string().primaryKey(), ownerKey: t.string(), mode: t.string(), state: t.string(), progress: t.f64(), etaSeconds: t.u32(), droneLabel: t.string(), updatedAt: t.timestamp() });

/** One row per active AERO account (demo, signed-in or guest); accountKey is the owner's HMAC key. Dropped after a day unseen. */
const accountSession = table({ name: 'account_session' }, { ...accountCols(), kind: t.string().index('btree') });
/** Live drone-link telemetry and mission state. stale is set by the Worker, and by sweep once a drone misses its transport's report window. */
const fleetDrone = table({ name: 'fleet_drone' }, { ...droneCols(), ownerKey: t.string().index('btree'), stale: t.bool().index('btree') });
/** Each customer's return status, simulated or live. Dropped after a day without an update. */
const returnStatus = table({ name: 'return_status' }, { ...returnCols(), ownerKey: t.string().index('btree') });
/** Simulated flights across all customers, read only by fleet_stats (a count). flightKey is an HMAC of the return id; there are no coordinates. */
const simFlight = table({ name: 'sim_flight' }, {
  flightKey: t.string().primaryKey(), droneId: t.string().index('btree'), state: t.string(), done: t.bool().index('btree'), startedAt: t.timestamp(), updatedAt: t.timestamp(),
});
/** Which SpacetimeDB identity (a browser) may see which owner's rows. Granted by the Worker after it checks the session. */
const viewerGrant = table({ name: 'viewer_grant' }, { viewer: t.identity().primaryKey(), ownerKey: t.string().index('btree'), grantedAt: t.timestamp() });
const sweepSchedule = table({ name: 'sweep_schedule' }, { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() });

const spacetimedb = schema({ accountSession, fleetDrone, returnStatus, simFlight, viewerGrant, sweepSchedule }, { env: { WORKER_IDENTITY: t.string() } });
export default spacetimedb;

const SECOND = 1_000_000n, HOUR = 3_600n, DAY = 86_400n, KINDS = ['demo', 'account', 'guest'], MODES = ['simulated', 'live'], TRANSPORTS = ['https', 'sms'];
// Seconds without a report before sweep marks a drone stale: the Worker's STALE_MS (https 10 s, sms 120 s) plus one sweep.
const SILENT: Record<string, bigint> = { https: 20n, sms: 130n };
/** Every write reducer: only the Worker's identity may call it. Browsers, anonymous callers and the module owner get 530. */
function onlyWorker(ctx: { sender: { toHexString(): string }; env: { WORKER_IDENTITY: string } }) {
  if (ctx.sender.toHexString() !== ctx.env.WORKER_IDENTITY.toLowerCase()) throw new SenderError('forbidden');
}
const oneOf = (value: string, allowed: string[], field: string) => { if (!allowed.includes(value)) throw new SenderError(`bad ${field}`); };

export const init = spacetimedb.init(ctx => {
  if (!ctx.db.sweepSchedule.count()) ctx.db.sweepSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(10n * SECOND) });
});

// Each upsert rewrites the row with fresh updatedAt/lastSeen, keeping firstSeen/startedAt from the first write.
export const upsertAccount = spacetimedb.reducer({ accountKey: t.string(), kind: t.string(), returnsTotal: t.u32(), returnsActive: t.u32() }, (ctx, a) => {
  onlyWorker(ctx); oneOf(a.kind, KINDS, 'kind');
  const old = ctx.db.accountSession.accountKey.find(a.accountKey), row = { ...a, firstSeen: old?.firstSeen ?? ctx.timestamp, lastSeen: ctx.timestamp };
  if (old) ctx.db.accountSession.accountKey.update(row); else ctx.db.accountSession.insert(row);
});

export const upsertDrone = spacetimedb.reducer({
  droneId: t.string(), ownerKey: t.string(), lat: t.f64(), lng: t.f64(), alt: t.f64(), heading: t.f64(), speed: t.f64(), battery: t.f64(), sats: t.u32(),
  state: t.string(), phase: t.string(), fault: t.string(), armed: t.bool(), stale: t.bool(), onMission: t.bool(), transport: t.string(),
}, (ctx, a) => {
  onlyWorker(ctx); oneOf(a.transport, TRANSPORTS, 'transport');
  const row = { ...a, updatedAt: ctx.timestamp };
  if (ctx.db.fleetDrone.droneId.find(a.droneId)) ctx.db.fleetDrone.droneId.update(row); else ctx.db.fleetDrone.insert(row);
});

export const removeDrone = spacetimedb.reducer({ droneId: t.string() }, (ctx, { droneId }) => {
  onlyWorker(ctx);
  ctx.db.fleetDrone.droneId.delete(droneId);
});

export const upsertReturn = spacetimedb.reducer({ returnId: t.string(), ownerKey: t.string(), mode: t.string(), state: t.string(), progress: t.f64(), etaSeconds: t.u32(), droneLabel: t.string() }, (ctx, a) => {
  onlyWorker(ctx); oneOf(a.mode, MODES, 'mode');
  const row = { ...a, progress: Math.min(1, Math.max(0, a.progress || 0)), updatedAt: ctx.timestamp };
  if (ctx.db.returnStatus.returnId.find(a.returnId)) ctx.db.returnStatus.returnId.update(row); else ctx.db.returnStatus.insert(row);
});

export const upsertSimFlight = spacetimedb.reducer({ flightKey: t.string(), droneId: t.string(), state: t.string(), done: t.bool() }, (ctx, a) => {
  onlyWorker(ctx);
  const old = ctx.db.simFlight.flightKey.find(a.flightKey), row = { ...a, startedAt: old?.startedAt ?? ctx.timestamp, updatedAt: ctx.timestamp };
  if (old) ctx.db.simFlight.flightKey.update(row); else ctx.db.simFlight.insert(row);
});

/** Lets one browser identity see one owner's rows through the my_* views for two hours. The Worker verifies the identity's token first. */
export const grantViewer = spacetimedb.reducer({ viewer: t.identity(), ownerKey: t.string() }, (ctx, a) => {
  onlyWorker(ctx);
  const row = { ...a, grantedAt: ctx.timestamp };
  if (ctx.db.viewerGrant.viewer.find(a.viewer)) ctx.db.viewerGrant.viewer.update(row); else ctx.db.viewerGrant.insert(row);
});
/** Ends a browser identity's grant: the Worker calls it when that browser's account changed (sign-in, sign-out, demo switch). */
export const revokeViewer = spacetimedb.reducer({ viewer: t.identity() }, (ctx, { viewer }) => {
  onlyWorker(ctx);
  ctx.db.viewerGrant.viewer.delete(viewer);
});

/**
 * Every 10 s (private: no client or HTTP caller can run it): drops finished sim flights after 120 s and flights no screen has
 * updated for 5 min (a simulated flight moves only while its customer has it open), marks drones that missed their report
 * window stale, drops grants after two hours (open tabs renew them every 30 min) and drops accounts, drones and return
 * rows after a day without an update (a drone removed while SpacetimeDB was unreachable goes then too).
 */
export const sweep = spacetimedb.reducer({ onSchedule: sweepSchedule }, { arg: sweepSchedule.rowType }, ctx => {
  const now = ctx.timestamp.microsSinceUnixEpoch, older = (at: { microsSinceUnixEpoch: bigint }, seconds: bigint) => at.microsSinceUnixEpoch < now - seconds * SECOND;
  for (const f of [...ctx.db.simFlight.iter()]) if (older(f.updatedAt, f.done ? 120n : 300n)) ctx.db.simFlight.flightKey.delete(f.flightKey);
  for (const d of [...ctx.db.fleetDrone.stale.filter(false)]) if (older(d.updatedAt, SILENT[d.transport] ?? 20n)) ctx.db.fleetDrone.droneId.update({ ...d, stale: true });
  for (const d of [...ctx.db.fleetDrone.stale.filter(true)]) if (older(d.updatedAt, DAY)) ctx.db.fleetDrone.droneId.delete(d.droneId);
  for (const g of [...ctx.db.viewerGrant.iter()]) if (older(g.grantedAt, 2n * HOUR)) ctx.db.viewerGrant.viewer.delete(g.viewer);
  for (const a of [...ctx.db.accountSession.iter()]) if (older(a.lastSeen, DAY)) ctx.db.accountSession.accountKey.delete(a.accountKey);
  for (const r of [...ctx.db.returnStatus.iter()]) if (older(r.updatedAt, DAY)) ctx.db.returnStatus.returnId.delete(r.returnId);
});

// View rows declare a primary key so clients get onUpdate (a bare table rowType gives no insert/update/delete callbacks).
const MyAccountRow = t.row('MyAccountRow', accountCols()), MyDroneRow = t.row('MyDroneRow', droneCols()), MyReturnRow = t.row('MyReturnRow', returnCols());
const FleetStatsRow = t.row('FleetStatsRow', { id: t.u32().primaryKey(), demoAccounts: t.u32(), signedInAccounts: t.u32(), guestAccounts: t.u32(), activeSimFlights: t.u32(), liveDronesOnline: t.u32() });

export const myAccount = spacetimedb.view({ name: 'my_account', public: true }, t.array(MyAccountRow), ctx => {
  const g = ctx.db.viewerGrant.viewer.find(ctx.sender), a = g && ctx.db.accountSession.accountKey.find(g.ownerKey);
  return a ? [a] : [];
});
export const myFleet = spacetimedb.view({ name: 'my_fleet', public: true }, t.array(MyDroneRow), ctx => {
  const g = ctx.db.viewerGrant.viewer.find(ctx.sender);
  return g ? [...ctx.db.fleetDrone.ownerKey.filter(g.ownerKey)] : [];
});
export const myReturns = spacetimedb.view({ name: 'my_returns', public: true }, t.array(MyReturnRow), ctx => {
  const g = ctx.db.viewerGrant.viewer.find(ctx.sender);
  return g ? [...ctx.db.returnStatus.ownerKey.filter(g.ownerKey)] : [];
});

const count = (rows: Iterable<unknown>) => [...rows].length;
/** Shared counts for every viewer, computed once from index lookups. One row, id 0. */
export const fleetStats = spacetimedb.anonymousView({ name: 'fleet_stats', public: true }, t.array(FleetStatsRow), ctx => [{
  id: 0, demoAccounts: count(ctx.db.accountSession.kind.filter('demo')), signedInAccounts: count(ctx.db.accountSession.kind.filter('account')), guestAccounts: count(ctx.db.accountSession.kind.filter('guest')),
  activeSimFlights: count(ctx.db.simFlight.done.filter(false)), liveDronesOnline: count(ctx.db.fleetDrone.stale.filter(false)),
}]);
