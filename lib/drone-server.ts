/** Live drone API. Website users (owner + invited pilots) queue commands; the drone's agent
 * polls /api/drone/sync over 4G, reports telemetry and receives the next command. */
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { session } from './server';
import type { Point } from './simulation';
import {
  appendTrail, commandRequestSchema, droneSettingsSchema, FLY_EXPIRES_MS, formatToken, isOnline, isSafety, nextCommand, parseToken,
  preflight, randomHex, SAFETY_EXPIRES_MS, sameHex, sha256Hex, smsCommandSchema, smsText, syncSchema,
  type CommandStatus, type CommandType, type DroneCommand, type DroneConfig, type DroneEvent, type DroneView, type FlyRoute, type Telemetry, MIN_BATTERY_PCT,
} from './drone-protocol';
import { createJob, isActiveJob, JOB_TITLES, jobRequestSchema, legCommand, onAck, onCancel, onLoaded, onResume, remainingWaypoints, type DeliveryJob, type JobLeg } from './drone-jobs';

type Row = { id: string; owner: string; name: string; token_hash: string; pilots: string; pilot_code: string | null; phone: string | null; home_lng: number | null; home_lat: number | null; geofence_m: number; max_alt_m: number; created_at: number; last_seen: number | null; telemetry: string | null; trail: string };
type CommandRow = { id: string; drone_id: string; issued_by: string; type: string; params: string | null; status: string; channel: string; created_at: number; updated_at: number; expires_at: number; message: string | null; job_id: string | null; leg: string | null };
type JobRow = { id: string; drone_id: string; record: string };
type EventRow = { id: string; drone_id: string; job_id: string | null; kind: DroneEvent['kind']; title: string; detail: string | null; at: number };
const JOB_WINDOW_MS = 3_600_000;

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const noStore = { 'Cache-Control': 'private, no-store' };
const home = (r: Row): Point | null => r.home_lng === null || r.home_lat === null ? null : [r.home_lng, r.home_lat];
const pilotsOf = (r: Row): string[] => { try { return JSON.parse(r.pilots); } catch { return []; } };
const telemetryOf = (r: Row): Telemetry | null => r.telemetry ? JSON.parse(r.telemetry) : null;
const command = (c: CommandRow): DroneCommand => ({ id: c.id, type: c.type as CommandType, params: c.params ? JSON.parse(c.params) as FlyRoute : null, status: c.status as CommandStatus, channel: c.channel as 'internet' | 'sms', createdAt: c.created_at, updatedAt: c.updated_at, expiresAt: c.expires_at, message: c.message });
const pilotCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

function db() { if (!env.DB) throw new HttpError(503, 'Drone storage is unavailable. Try again shortly.'); return env.DB; }
// Bodies are always read up front: replying before consuming one breaks the next request on a kept-alive connection.
function parse<S extends z.ZodTypeAny>(raw: string, schema: S, limit = 8000): z.output<S> {
  if (raw.length > limit) throw new HttpError(413, 'Request is too large.');
  return schema.parse(raw ? JSON.parse(raw) : {});
}
async function load(id: string) { return db().prepare('SELECT * FROM drones WHERE id = ?').bind(id).first<Row>(); }
async function access(id: string, owner: string) {
  const row = await load(id);
  if (!row || (row.owner !== owner && !pilotsOf(row).includes(owner))) throw new HttpError(404, 'This drone is not linked to your account.');
  return row;
}
const latestJob = (droneId: string, now: number) => db().prepare('SELECT * FROM drone_jobs WHERE drone_id = ? AND (status NOT IN (\'completed\', \'cancelled\', \'failed\') OR updated_at > ?) ORDER BY created_at DESC LIMIT 1').bind(droneId, now - JOB_WINDOW_MS).first<JobRow>();
const loadJob = (droneId: string, jobId: string) => db().prepare('SELECT * FROM drone_jobs WHERE id = ? AND drone_id = ?').bind(jobId, droneId).first<JobRow>();
const saveJob = (j: DeliveryJob) => db().prepare('UPDATE drone_jobs SET status = ?, record = ?, updated_at = ? WHERE id = ?').bind(j.status, JSON.stringify(j), j.updatedAt, j.id);
const logEvent = (droneId: string, jobId: string | null, kind: DroneEvent['kind'], title: string, detail: string | null, at: number) =>
  db().prepare('INSERT INTO drone_events (id, drone_id, job_id, kind, title, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), droneId, jobId, kind, title, detail, at);
/** Status events for every job transition since `before`. */
const jobEvents = (before: DeliveryJob, after: DeliveryJob) => after.events.slice(before.events.length).map(e => logEvent(after.droneId, after.id, 'job', JOB_TITLES[e.status], e.note ?? null, e.at));

async function view(row: Row, owner: string, now: number): Promise<DroneView> {
  const [commands, events, job] = await Promise.all([
    db().prepare('SELECT * FROM drone_commands WHERE drone_id = ? ORDER BY created_at DESC LIMIT 12').bind(row.id).all<CommandRow>(),
    db().prepare('SELECT * FROM drone_events WHERE drone_id = ? ORDER BY at DESC LIMIT 25').bind(row.id).all<EventRow>(),
    latestJob(row.id, now),
  ]);
  const mine = row.owner === owner;
  return {
    id: row.id, name: row.name, role: mine ? 'owner' : 'pilot', online: isOnline(row.last_seen, now), lastSeen: row.last_seen, telemetry: telemetryOf(row),
    trail: JSON.parse(row.trail), home: home(row), geofenceM: row.geofence_m, maxAltM: row.max_alt_m, phone: row.phone,
    pilotCode: mine ? row.pilot_code : null, pilots: pilotsOf(row).length,
    commands: commands.results.map(c => ({ ...command(c), expiresAt: c.status === 'queued' && c.expires_at <= now ? now : c.expires_at, status: c.status === 'queued' && c.expires_at <= now ? 'expired' : c.status as CommandStatus })),
    job: job ? JSON.parse(job.record) as DeliveryJob : null,
    events: events.results.map(e => ({ id: e.id, jobId: e.job_id, kind: e.kind, title: e.title, detail: e.detail, at: e.at })),
  };
}
function queueStatements(row: Row, issuedBy: string, type: CommandType, params: FlyRoute | null, channel: 'internet' | 'sms', now: number, job?: { id: string; leg: JobLeg }) {
  // A new flight replaces any flight still waiting. Any safety command replaces everything still waiting.
  const superseded = isSafety(type) ? "status = 'queued'" : "status = 'queued' AND type = 'FLY_ROUTE'";
  const id = crypto.randomUUID();
  return { id, statements: [
    db().prepare(`UPDATE drone_commands SET status = 'superseded', updated_at = ? WHERE drone_id = ? AND ${superseded}`).bind(now, row.id),
    db().prepare('INSERT INTO drone_commands (id, drone_id, issued_by, type, params, status, channel, created_at, updated_at, expires_at, message, job_id, leg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, row.id, issuedBy, type, params ? JSON.stringify(params) : null, channel === 'sms' ? 'sent' : 'queued', channel, now, now, now + (type === 'FLY_ROUTE' ? FLY_EXPIRES_MS : SAFETY_EXPIRES_MS), channel === 'sms' ? 'Sent as a text message' : null, job?.id ?? null, job?.leg ?? null),
  ] };
}
async function queue(row: Row, issuedBy: string, type: CommandType, params: FlyRoute | null, channel: 'internet' | 'sms', now: number) {
  const { id, statements } = queueStatements(row, issuedBy, type, params, channel, now);
  await db().batch([...statements, ...(isSafety(type) ? [logEvent(row.id, null, 'command', `${type === 'RTL' ? 'Return home' : type === 'HOLD' ? 'Hold' : 'Land'} sent${channel === 'sms' ? ' by text' : ''}`, null, now)] : [])]);
  return id;
}
const droneLimits = (row: Row) => ({ home: home(row), geofenceM: row.geofence_m, maxAltM: row.max_alt_m, lastSeen: row.last_seen, telemetry: telemetryOf(row) });
/** Preflight for the rest of a job: every remaining stop must be reachable from where the drone is now. */
function jobPreflight(row: Row, j: Pick<DeliveryJob, 'pickup' | 'dropoff' | 'loaded' | 'altM' | 'speedMs'>, now: number) {
  return preflight(droneLimits(row), { waypoints: remainingWaypoints(j), altM: j.altM, speedMs: j.speedMs, land: true, release: false }, now);
}

async function handleJobs(row: Row, owner: string, raw: string, now: number) {
  const req = parse(raw, jobRequestSchema);
  if (req.op === 'create') {
    const active = await latestJob(row.id, now);
    if (active && isActiveJob(JSON.parse(active.record))) throw new HttpError(409, 'This drone is already on a delivery. Finish or cancel it first.');
    const refused = jobPreflight(row, { ...req, loaded: false }, now);
    if (refused) throw new HttpError(409, refused);
    const job = createJob(req, crypto.randomUUID(), row.id, now), leg = legCommand(job, 'pickup');
    const { statements } = queueStatements(row, owner, leg.type, leg.params, 'internet', now, { id: job.id, leg: 'pickup' });
    await db().batch([
      db().prepare('INSERT INTO drone_jobs (id, drone_id, issued_by, return_id, status, record, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(job.id, row.id, owner, job.returnId, job.status, JSON.stringify(job), now, now),
      ...statements, ...jobEvents({ ...job, events: [] }, job),
    ]);
    return job;
  }
  const jobRow = await loadJob(row.id, req.jobId);
  if (!jobRow) throw new HttpError(404, 'That delivery was not found on this drone.');
  const before: DeliveryJob = JSON.parse(jobRow.record);
  let after: DeliveryJob;
  try { after = req.op === 'loaded' ? onLoaded(before, now) : req.op === 'cancel' ? onCancel(before, now) : onResume(before, now); }
  catch (error) { throw new HttpError(409, (error as Error).message); }
  const statements = [saveJob(after), ...jobEvents(before, after)];
  if (req.op === 'cancel') {
    // Stop any waiting leg. If the drone is in the air, bring it home.
    statements.push(db().prepare("UPDATE drone_commands SET status = 'superseded', updated_at = ? WHERE drone_id = ? AND job_id = ? AND status = 'queued'").bind(now, row.id, before.id));
    const t = telemetryOf(row);
    if (t && t.altM > 0.5 && isOnline(row.last_seen, now)) statements.push(...queueStatements(row, owner, 'RTL', null, 'internet', now).statements, logEvent(row.id, before.id, 'command', 'Return home sent', 'The delivery was cancelled in flight.', now));
  } else {
    const leg = after.leg!;
    if (leg !== 'return') { const refused = jobPreflight(row, after, now); if (refused) throw new HttpError(409, refused); }
    else if (!isOnline(row.last_seen, now)) throw new HttpError(409, 'The drone is offline. Check its 4G connection.');
    const cmd = legCommand(after, leg);
    statements.push(...queueStatements(row, owner, cmd.type, cmd.params, 'internet', now, { id: after.id, leg }).statements);
  }
  await db().batch(statements);
  return after;
}

async function sendSms(to: string, text: string): Promise<boolean> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) return false;
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text }),
  });
  if (!response.ok) throw new HttpError(502, 'The SMS provider rejected the message. Check the Twilio number and settings.');
  return true;
}

/** Website endpoints: /api/drones[/:id[/:action]] */
export async function handleDrones(request: Request, id?: string, action?: string): Promise<Response> {
  const raw = request.method === 'GET' ? '' : await request.text();
  let identity: Awaited<ReturnType<typeof session>>;
  try { identity = await session(request); } catch { return Response.json({ error: 'Your account session expired. Open Your account to sign in again.' }, { status: 401, headers: noStore }); }
  const { owner, cookie } = identity, now = Date.now();
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...noStore, ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
  try {
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Request origin is not allowed.');
    }
    if (!id && request.method === 'GET') {
      const rows = await db().prepare('SELECT * FROM drones WHERE owner = ?1 OR EXISTS (SELECT 1 FROM json_each(drones.pilots) WHERE value = ?1) ORDER BY created_at DESC LIMIT 20').bind(owner).all<Row>();
      if (new URL(request.url).searchParams.get('view') === 'jobs') {
        // Lightweight feed for the tracking page: live deliveries on drones this account can see.
        const jobs = await Promise.all(rows.results.map(async r => { const j = await latestJob(r.id, now); return j ? { droneId: r.id, droneName: r.name, online: isOnline(r.last_seen, now), job: JSON.parse(j.record) as DeliveryJob } : null; }));
        return reply({ jobs: jobs.filter(Boolean), now });
      }
      return reply({ drones: await Promise.all(rows.results.map(r => view(r, owner, now))), now, sms: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) });
    }
    if (!id && request.method === 'POST') {
      const { name } = parse(raw, z.object({ name: z.string().trim().min(1).max(40) }));
      const count = await db().prepare('SELECT COUNT(*) AS n FROM drones WHERE owner = ?').bind(owner).first<{ n: number }>();
      if ((count?.n || 0) >= 10) throw new HttpError(429, 'You can link up to 10 drones.');
      const droneId = crypto.randomUUID(), secret = randomHex(32);
      await db().prepare('INSERT INTO drones (id, owner, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(droneId, owner, name, await sha256Hex(secret), now).run();
      return reply({ drone: await view((await load(droneId))!, owner, now), token: formatToken(droneId, secret) }, 201);
    }
    if (id === 'join' && request.method === 'POST') {
      const { code } = parse(raw, z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z2-9]{6}$/, 'Pilot codes are 6 letters and numbers.') }));
      const row = await db().prepare('SELECT * FROM drones WHERE pilot_code = ?').bind(code).first<Row>();
      if (!row) throw new HttpError(404, 'That pilot code did not match a drone. Ask the owner for a fresh one.');
      const pilots = pilotsOf(row);
      if (row.owner !== owner && !pilots.includes(owner)) {
        if (pilots.length >= 20) throw new HttpError(429, 'This drone already has 20 pilots.');
        await db().prepare('UPDATE drones SET pilots = ? WHERE id = ?').bind(JSON.stringify([...pilots, owner]), row.id).run();
      }
      return reply({ drone: await view((await load(row.id))!, owner, now) });
    }
    if (!id) throw new HttpError(404, 'Not found.');
    let row = await access(id, owner);
    const isOwner = row.owner === owner;
    if (!action && request.method === 'GET') return reply({ drone: await view(row, owner, now), now });
    if (!action && request.method === 'PATCH') {
      if (!isOwner) throw new HttpError(403, 'Only the drone owner can change its settings.');
      const s = parse(raw, droneSettingsSchema);
      const t = telemetryOf(row);
      const nextHome = s.home === 'current' ? (t && t.gpsFix >= 3 ? [t.lng, t.lat] : null) : s.home ?? home(row);
      if (s.home === 'current' && !nextHome) throw new HttpError(400, 'The drone has no GPS fix yet, so its position cannot become home.');
      await db().prepare('UPDATE drones SET name = ?, phone = ?, geofence_m = ?, max_alt_m = ?, home_lng = ?, home_lat = ? WHERE id = ?')
        .bind(s.name ?? row.name, s.phone === undefined ? row.phone : s.phone || null, s.geofenceM ?? row.geofence_m, s.maxAltM ?? row.max_alt_m, nextHome?.[0] ?? null, nextHome?.[1] ?? null, id).run();
      return reply({ drone: await view((await load(id))!, owner, now) });
    }
    if (!action && request.method === 'DELETE') {
      if (isOwner) await db().batch(['drone_commands', 'drone_jobs', 'drone_events'].map(t => db().prepare(`DELETE FROM ${t} WHERE drone_id = ?`).bind(id)).concat(db().prepare('DELETE FROM drones WHERE id = ?').bind(id)));
      else await db().prepare('UPDATE drones SET pilots = ? WHERE id = ?').bind(JSON.stringify(pilotsOf(row).filter(p => p !== owner)), id).run();
      return reply({ removed: true });
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (action === 'commands') {
      const req = parse(raw, commandRequestSchema);
      const params = req.type === 'FLY_ROUTE' ? req.params : null;
      if (params) { const refused = preflight({ home: home(row), geofenceM: row.geofence_m, maxAltM: row.max_alt_m, lastSeen: row.last_seen, telemetry: telemetryOf(row) }, params, now); if (refused) throw new HttpError(409, refused); }
      else if (!isOnline(row.last_seen, now)) throw new HttpError(409, `The drone is offline, so ${req.type} cannot reach it over the internet. Use the SMS backup.`);
      const commandId = await queue(row, owner, req.type, params, 'internet', now);
      return reply({ commandId, drone: await view(row, owner, now) }, 201);
    }
    if (action === 'jobs') {
      const job = await handleJobs(row, owner, raw, now);
      return reply({ job, drone: await view((await load(row.id))!, owner, now) }, 201);
    }
    if (action === 'sms') {
      const req = parse(raw, smsCommandSchema);
      const args = req.command === 'GOTO' ? [req.point[1].toFixed(6), req.point[0].toFixed(6), String(req.altM)] : [];
      const text = await smsText(row.token_hash, row.id, req.command, args, now);
      const sent = row.phone ? await sendSms(row.phone, text) : false;
      if (sent && req.command !== 'STATUS') await queue(row, owner, req.command === 'GOTO' ? 'FLY_ROUTE' : req.command, req.command === 'GOTO' ? { waypoints: [req.point], altM: req.altM, speedMs: 6, land: false, release: false } : null, 'sms', now);
      return reply({ text, to: row.phone, sent, expiresInMinutes: 5 });
    }
    if (!isOwner) throw new HttpError(403, 'Only the drone owner can do that.');
    if (action === 'share') {
      const { revoke } = parse(raw, z.object({ revoke: z.boolean().default(false) }));
      await db().prepare('UPDATE drones SET pilot_code = ?, pilots = ? WHERE id = ?').bind(revoke ? null : pilotCode(), revoke ? '[]' : row.pilots, id).run();
      return reply({ drone: await view((await load(id))!, owner, now) });
    }
    if (action === 'token') {
      const secret = randomHex(32);
      await db().prepare('UPDATE drones SET token_hash = ? WHERE id = ?').bind(await sha256Hex(secret), id).run();
      row = (await load(id))!;
      return reply({ drone: await view(row, owner, now), token: formatToken(id, secret) });
    }
    throw new HttpError(404, 'Not found.');
  } catch (error) { return failure(error, reply); }
}

/** Device endpoint: POST /api/drone/sync with `Authorization: Bearer aero_<id>.<secret>`. */
export async function handleDroneSync(request: Request): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: noStore });
  try {
    const raw = await request.text();
    if (request.method !== 'POST') throw new HttpError(405, 'Use POST.');
    const token = parseToken(request.headers.get('authorization'));
    const row = token ? await load(token.droneId) : null;
    if (!token || !row || !sameHex(await sha256Hex(token.secret), row.token_hash)) throw new HttpError(401, 'Unknown drone token. Copy a fresh token from the Fly page.');
    const { telemetry, acks } = parse(raw, syncSchema, 16000);
    const now = Date.now(), p: Point = [telemetry.lng, telemetry.lat], good = telemetry.gpsFix >= 3;
    const trail = good ? appendTrail(JSON.parse(row.trail), p) : JSON.parse(row.trail);
    const setHome = good && home(row) === null;
    const previous = telemetryOf(row);
    const statements = [
      db().prepare('UPDATE drones SET last_seen = ?, telemetry = ?, trail = ?, home_lng = ?, home_lat = ? WHERE id = ?')
        .bind(now, JSON.stringify(telemetry), JSON.stringify(trail), setHome ? p[0] : row.home_lng, setHome ? p[1] : row.home_lat, row.id),
      db().prepare("UPDATE drone_commands SET status = 'expired', updated_at = ? WHERE drone_id = ? AND status = 'queued' AND expires_at <= ?").bind(now, row.id, now),
      ...acks.map(a => db().prepare("UPDATE drone_commands SET status = ?, message = ?, updated_at = ? WHERE id = ? AND drone_id = ? AND status NOT IN ('done', 'failed', 'superseded')").bind(a.status, a.message ?? null, now, a.commandId, row.id)),
      // Anything new the drone says (failsafes, takeover, arrival) becomes a status update.
      ...(telemetry.message && telemetry.message !== previous?.message ? [logEvent(row.id, null, 'alert', telemetry.message, null, now)] : []),
      ...(setHome ? [logEvent(row.id, null, 'alert', 'Home set from the first GPS fix', null, now)] : []),
    ];
    await db().batch(statements);
    if (acks.length) await advanceJobs(row, acks, now);
    const queued = await db().prepare("SELECT * FROM drone_commands WHERE drone_id = ? AND status = 'queued' AND expires_at > ?").bind(row.id, now).all<CommandRow>();
    const next = nextCommand(queued.results.map(c => ({ ...c, createdAt: c.created_at, expiresAt: c.expires_at })), now);
    if (next) await db().prepare("UPDATE drone_commands SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'queued'").bind(now, next.id).run();
    const config: DroneConfig = { droneId: row.id, name: row.name, home: setHome ? p : home(row), geofenceM: row.geofence_m, maxAltM: row.max_alt_m, minBatteryPct: MIN_BATTERY_PCT };
    return reply({ command: next ? { id: next.id, type: next.type, params: next.params ? JSON.parse(next.params) : null, expiresAt: next.expires_at } : null, config, serverTime: now });
  } catch (error) { return failure(error, reply); }
}

/** Move delivery jobs forward from the drone's acks, in the order the drone sent them, and queue the next leg. */
async function advanceJobs(row: Row, acks: { commandId: string; status: 'accepted' | 'done' | 'failed'; message?: string }[], now: number) {
  const placeholders = acks.map(() => '?').join(', ');
  const linked = await db().prepare(`SELECT id, job_id, leg FROM drone_commands WHERE drone_id = ? AND job_id IS NOT NULL AND id IN (${placeholders})`).bind(row.id, ...acks.map(a => a.commandId)).all<{ id: string; job_id: string; leg: JobLeg }>();
  const byId = new Map(linked.results.map(c => [c.id, c]));
  const jobs = new Map<string, { before: DeliveryJob; after: DeliveryJob; issuedBy: string }>();
  const queued: { job: DeliveryJob; leg: JobLeg; issuedBy: string }[] = [];
  for (const a of acks) {
    const c = byId.get(a.commandId); if (!c) continue;
    let entry = jobs.get(c.job_id);
    if (!entry) {
      const jr = await db().prepare('SELECT record, issued_by FROM drone_jobs WHERE id = ?').bind(c.job_id).first<{ record: string; issued_by: string }>();
      if (!jr) continue;
      const j = JSON.parse(jr.record) as DeliveryJob; entry = { before: j, after: j, issuedBy: jr.issued_by }; jobs.set(c.job_id, entry);
    }
    const { job, next } = onAck(entry.after, c.leg, a.status, a.message, now);
    entry.after = job;
    if (next) queued.push({ job, leg: next, issuedBy: entry.issuedBy });
  }
  const statements = [...jobs.values()].flatMap(({ before, after }) => after === before ? [] : [saveJob(after), ...jobEvents(before, after)]);
  for (const q of queued) { const cmd = legCommand(q.job, q.leg); statements.push(...queueStatements(row, q.issuedBy, cmd.type, cmd.params, 'internet', now, { id: q.job.id, leg: q.leg }).statements); }
  if (statements.length) await db().batch(statements);
}

function failure(error: unknown, reply: (value: unknown, status?: number) => Response) {
  if (error instanceof HttpError) return reply({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return reply({ error: error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join(' · ') }, 400);
  if (error instanceof SyntaxError) return reply({ error: 'Invalid request.' }, 400);
  console.error('AERO drone operation failed', error);
  return reply({ error: 'Could not reach drone storage. Retry in a moment.' }, 503);
}
