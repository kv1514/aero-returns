/** Drone link storage and transports (docs/DRONE_LINK.md). Mission rules are pure functions in drone-mission.ts. */
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { session } from './session';
import { deriveDroneKey, formatCommand, lineDroneId, parseDroneBody, signLine, verifyLine, type Ack, type CommandType, type DroneMessage } from './drone-protocol';
import { ARM_WINDOW_MS, ENDED, EXPIRY_S, GROUND_PHASES, LIMITS, STALE_MS, ackOutcome, airborne, configProblem, customerAction, dispatchBlockers, enterPhase, isStale, operatorAction, phaseCommand, startLive, type Drone, type DroneConfig, type PlannedCommand } from './drone-mission';
import type { LiveTelemetry, MissionPhase, Point, ReturnRecord } from './simulation';

type DroneRow = { id: string; owner: string; name: string; transport: string; phone: string | null; phone_verified: number; key_version: number; config: string; armed_until: number; active_return: string | null; last_seq: number; cmd_seq: number; last_seen: number; telemetry: string | null; created_at: number };
const toDrone = (r: DroneRow): Drone => ({ id: r.id, owner: r.owner, name: r.name, transport: r.transport === 'sms' ? 'sms' : 'https', phone: r.phone, phoneVerified: !!r.phone_verified, keyVersion: r.key_version, config: JSON.parse(r.config), armedUntil: r.armed_until, activeReturn: r.active_return, lastSeq: r.last_seq, lastSeen: r.last_seen, telemetry: r.telemetry ? JSON.parse(r.telemetry) : null, createdAt: r.created_at });
const secret = () => (env.DRONE_LINK_SECRET && env.DRONE_LINK_SECRET.length >= 32 ? env.DRONE_LINK_SECRET : null);
const twilio = () => (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER ? { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM_NUMBER } : null);
const keyFor = (d: Drone) => deriveDroneKey(secret()!, d.id, d.keyVersion);
const loadDrone = async (db: D1Database, id: string) => { const row = await db.prepare('SELECT * FROM drones WHERE id = ?').bind(id).first<DroneRow>(); return row ? toDrone(row) : null; };
/** Telemetry and stale flags are attached on read and never persisted inside a return record. */
const persistable = (r: ReturnRecord): ReturnRecord => (r.live ? { ...r, live: { ...r.live, telemetry: undefined, stale: undefined } } : r);
const MOVEMENT: CommandType[] = ['TAKEOFF', 'GOTO', 'HOLD', 'LAND', 'RTL', 'ABORT'];
const RANK: Record<string, number> = { pending: 0, sent: 0, superseded: 0, expired: 0, accepted: 1, done: 2, rejected: 2, failed: 2 };
const SMS = { perMinute: 10, maxSends: 3 }, COMMANDS_PER_MINUTE = 30, GROUND_WRITE_MS = 5000;

async function allocSeq(db: D1Database, droneId: string) {
  const row = await db.prepare('UPDATE drones SET cmd_seq = cmd_seq + 1 WHERE id = ? RETURNING cmd_seq').bind(droneId).first<{ cmd_seq: number }>();
  if (!row) throw new Error('Drone not found.');
  return row.cmd_seq;
}
/**
 * Statements that queue one signed command. With `guard`, they only take effect if the return is still at that
 * version, so a mission step and its command commit together. A command never supersedes a newer one (seq < new).
 */
async function commandStatements(db: D1Database, drone: Drone, seq: number, cmd: PlannedCommand, link: { returnId: string; phase: MissionPhase } | null, now: number, guard?: { returnId: string; version: number }) {
  const expires = Math.floor(now / 1000) + EXPIRY_S[drone.transport];
  const line = await signLine(await keyFor(drone), formatCommand({ droneId: drone.id, seq, expires, ...cmd }));
  const cond = guard ? ' AND EXISTS (SELECT 1 FROM returns WHERE id = ? AND version = ?)' : '', g = guard ? [guard.returnId, guard.version] : [];
  const statements: D1PreparedStatement[] = [];
  // Only the newest movement command is live; PING can ride alongside it.
  if (MOVEMENT.includes(cmd.type)) statements.push(db.prepare(`UPDATE drone_commands SET status = 'superseded', updated_at = ? WHERE drone_id = ? AND status IN ('pending', 'sent') AND type != 'PING' AND seq < ?${cond}`).bind(now, drone.id, seq, ...g));
  statements.push(db.prepare(`INSERT INTO drone_commands (id, drone_id, seq, type, line, return_id, phase, status, created_at, expires_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ? WHERE 1${cond}`).bind(crypto.randomUUID(), drone.id, seq, cmd.type, line, link?.returnId ?? null, link?.phase ?? null, now, expires, now, ...g));
  return statements;
}
async function enqueue(db: D1Database, drone: Drone, cmd: PlannedCommand, now: number) {
  const seq = await allocSeq(db, drone.id);
  await db.batch(await commandStatements(db, drone, seq, cmd, null, now));
  if (drone.transport === 'sms') await flushSms(db, drone, now, false);
  return seq;
}
async function recentCommands(db: D1Database, droneId: string, now: number) {
  return (await db.prepare('SELECT COUNT(*) AS n FROM drone_commands WHERE drone_id = ? AND created_at > ?').bind(droneId, now - 60_000).first<{ n: number }>())?.n ?? 0;
}

type MissionMove = { fault?: string | null; command?: PlannedCommand | null; cancelled?: boolean; keepSeq?: boolean };
/** Compare-and-set a mission phase on a return together with the phase's command. Returns null when another request won. */
async function moveMission(db: D1Database, drone: Drone, r: ReturnRecord, version: number, phase: MissionPhase, move: MissionMove, now: number) {
  const command = move.command !== undefined ? move.command : phaseCommand(r.live!, phase);
  const seq = command ? await allocSeq(db, drone.id) : move.keepSeq ? r.live!.cmdSeq : null;
  const next = { ...enterPhase({ ...r, cancelled: r.cancelled || !!move.cancelled }, phase, now, seq, move.fault ?? null), version: version + 1 };
  const guard = { returnId: next.id, version: next.version };
  const statements = [db.prepare('UPDATE returns SET version = ?, record = ? WHERE id = ? AND owner = ? AND version = ?').bind(next.version, JSON.stringify(persistable(next)), next.id, drone.owner, version)];
  if (command) statements.push(...await commandStatements(db, drone, seq!, command, { returnId: next.id, phase }, now, guard));
  if (ENDED.includes(phase)) statements.push(db.prepare('UPDATE drones SET active_return = NULL WHERE id = ? AND active_return = ? AND EXISTS (SELECT 1 FROM returns WHERE id = ? AND version = ?)').bind(drone.id, next.id, guard.returnId, guard.version));
  const [result] = await db.batch(statements);
  if (result.meta.changes === 0) return null;
  if (command && drone.transport === 'sms') await flushSms(db, drone, now, false);
  return next;
}
async function missionReturn(db: D1Database, drone: Drone) {
  if (!drone.activeReturn) return null;
  const row = await db.prepare('SELECT record, version FROM returns WHERE id = ? AND owner = ?').bind(drone.activeReturn, drone.owner).first<{ record: string; version: number }>();
  return row ? { record: JSON.parse(row.record) as ReturnRecord, version: row.version } : null;
}
/** Applies a mission transition, re-reading once if a concurrent request changed the return. */
async function stepMission(db: D1Database, drone: Drone, decide: (r: ReturnRecord) => ({ phase: MissionPhase } & MissionMove) | null, now: number) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await missionReturn(db, drone); if (!current?.record.live) return null;
    const step = decide(current.record); if (!step) return current.record;
    const moved = await moveMission(db, drone, current.record, current.version, step.phase, step, now);
    if (moved) return moved;
  }
  throw new Error('This live flight changed at the same time. Please try again.');
}

async function applyAck(db: D1Database, drone: Drone, ack: Ack, now: number) {
  const cmd = await db.prepare('SELECT status, return_id FROM drone_commands WHERE drone_id = ? AND seq = ?').bind(drone.id, ack.cmdSeq).first<{ status: string; return_id: string | null }>();
  if (!cmd || RANK[ack.status.toLowerCase()] <= RANK[cmd.status] || RANK[cmd.status] === 2) return;
  await db.prepare('UPDATE drone_commands SET status = ?, reason = ?, updated_at = ? WHERE drone_id = ? AND seq = ?').bind(ack.status.toLowerCase(), ack.reason ?? null, now, drone.id, ack.cmdSeq).run();
  if (cmd.return_id && cmd.return_id === drone.activeReturn) await stepMission(db, drone, r => { const o = ackOutcome(r.live!, ack); return o && (o.fault ? { ...o, command: null, keepSeq: true } : o); }, now);
}
/**
 * Stores what the drone reported. Only new, fresh telemetry refreshes `last_seen`, so replayed or delayed lines can
 * never make a silent drone look connected. HTTPS bridges are judged by their own timestamps; SMS by receive time.
 */
async function ingest(db: D1Database, drone: Drone, messages: DroneMessage[], now: number) {
  let lastSeq = drone.lastSeq, telemetry: LiveTelemetry | null = null, fresh = false, acked = false; const rows: D1PreparedStatement[] = [];
  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    const age = now - m.ts * 1000;
    if (drone.transport === 'https' && Math.abs(age) > 600_000) continue;
    if (m.kind === 'telemetry') {
      if (m.seq <= lastSeq) continue;
      telemetry = { ts: m.ts * 1000, receivedAt: now, lat: m.lat, lon: m.lon, alt: m.alt, battery: m.battery, heading: m.heading, speed: m.speed, fix: m.fix, sats: m.sats, state: m.state, mode: m.mode };
      fresh = drone.transport === 'sms' || Math.abs(age) <= STALE_MS.https;
    } else { await applyAck(db, drone, m, now); acked = true; }
    lastSeq = Math.max(lastSeq, m.seq);
  }
  const flying = airborne(telemetry) || airborne(drone.telemetry), changed = telemetry?.state !== drone.telemetry?.state;
  // An idle drone on the ground writes at most every few seconds; flights and missions write every report.
  if (!telemetry || !(fresh || acked) || !(flying || drone.activeReturn || changed || acked || now - drone.lastSeen >= GROUND_WRITE_MS)) {
    if (lastSeq > drone.lastSeq && acked) await db.prepare('UPDATE drones SET last_seq = MAX(last_seq, ?) WHERE id = ?').bind(lastSeq, drone.id).run();
    return;
  }
  rows.push(db.prepare(`UPDATE drones SET last_seq = MAX(last_seq, ?), telemetry = ?${fresh ? ', last_seen = ?' : ''} WHERE id = ?`).bind(...[lastSeq, JSON.stringify(telemetry), ...(fresh ? [now] : []), drone.id]));
  if (flying) rows.push(db.prepare('INSERT OR IGNORE INTO drone_telemetry (drone_id, seq, received_at, data) VALUES (?, ?, ?, ?)').bind(drone.id, lastSeq, now, JSON.stringify(telemetry)));
  if (Math.random() < .01) rows.push(db.prepare('DELETE FROM drone_telemetry WHERE drone_id = ? AND received_at < ?').bind(drone.id, now - 3 * 3600_000));
  await db.batch(rows);
}
/** Unaccepted commands past their expiry pause the mission so the operator can retry over a better link. */
async function expireCommands(db: D1Database, drone: Drone, now: number) {
  const expired = await db.prepare("UPDATE drone_commands SET status = 'expired', updated_at = ? WHERE drone_id = ? AND status IN ('pending', 'sent') AND expires_at <= ? RETURNING seq, return_id").bind(now, drone.id, Math.floor(now / 1000)).all<{ seq: number; return_id: string | null }>();
  const seqs = expired.results.filter(c => c.return_id && c.return_id === drone.activeReturn).map(c => c.seq);
  if (seqs.length) await stepMission(db, drone, r => (r.live!.cmdSeq !== null && seqs.includes(r.live!.cmdSeq) && !r.live!.fault ? { phase: r.live!.phase, fault: 'EXPIRED', command: null, keepSeq: true } : null), now);
}
async function pendingLines(db: D1Database, droneId: string, now: number) {
  const rows = await db.prepare("SELECT seq, line FROM drone_commands WHERE drone_id = ? AND status IN ('pending', 'sent') AND expires_at > ? ORDER BY seq").bind(droneId, Math.floor(now / 1000)).all<{ seq: number; line: string }>();
  if (rows.results.length) await db.prepare("UPDATE drone_commands SET status = 'sent', updated_at = ? WHERE drone_id = ? AND status = 'pending'").bind(now, droneId).run();
  return rows.results.map(r => r.line);
}
/**
 * Texts commands to an SMS drone. New commands go out once; unacknowledged ones are re-sent only when the drone texts
 * in (`resend`), at most SMS.maxSends times. Nothing is sent to a number that has not proven itself with a signed text,
 * and each drone is capped at SMS.perMinute outbound messages.
 */
async function flushSms(db: D1Database, drone: Drone, now: number, resend: boolean) {
  const t = twilio(); if (!t || !drone.phone || !drone.phoneVerified) return;
  const recent = await db.prepare('SELECT COALESCE(SUM(send_count), 0) AS n FROM drone_commands WHERE drone_id = ? AND send_count > 0 AND updated_at > ?').bind(drone.id, now - 60_000).first<{ n: number }>();
  const budget = SMS.perMinute - (recent?.n ?? 0); if (budget <= 0) return;
  const filter = resend ? `(status = 'pending' OR (status = 'sent' AND send_count < ${SMS.maxSends}))` : "status = 'pending'";
  const rows = await db.prepare(`SELECT seq, line FROM drone_commands WHERE drone_id = ? AND expires_at > ? AND ${filter} ORDER BY seq LIMIT ?`).bind(drone.id, Math.floor(now / 1000), budget).all<{ seq: number; line: string }>();
  for (const row of rows.results) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.sid}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${btoa(`${t.sid}:${t.token}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: drone.phone, From: t.from, Body: row.line }) });
    if (!res.ok) { console.error('AERO SMS send failed', res.status); break; }
    await db.prepare("UPDATE drone_commands SET status = 'sent', send_count = send_count + 1, updated_at = ? WHERE drone_id = ? AND seq = ? AND status IN ('pending', 'sent')").bind(now, drone.id, row.seq).run();
  }
}
async function verifiedMessages(drone: Drone, lines: string[]) {
  const key = await keyFor(drone), out: DroneMessage[] = [];
  for (const line of lines) { const body = await verifyLine(key, line); const m = body && parseDroneBody(body); if (m && m.droneId === drone.id) out.push(m); }
  return out;
}

const text = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const tooLarge = (request: Request, max: number) => Number(request.headers.get('content-length') || 0) > max;
/** HTTPS transport: the bridge posts signed telemetry/acks and receives pending signed commands. */
export async function handleLink(request: Request) {
  const db = env.DB; if (!db || !secret()) return text('Drone link is not configured.', 503);
  if (tooLarge(request, 4096)) return text('Too large.', 413);
  const raw = await request.text(); if (raw.length > 4096) return text('Too large.', 413);
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 20), id = lines[0] && lineDroneId(lines[0]);
  const drone = id ? await loadDrone(db, id) : null; if (!drone || drone.transport !== 'https') return text('Unauthorized.', 401);
  const messages = await verifiedMessages(drone, lines); if (!messages.length) return text('Unauthorized.', 401);
  const now = Date.now();
  await ingest(db, drone, messages, now);
  const fresh = (await loadDrone(db, drone.id))!; await expireCommands(db, fresh, now);
  return text((await pendingLines(db, drone.id, now)).join('\n'));
}

async function twilioSignatureValid(request: Request, params: URLSearchParams, token: string) {
  const data = request.url + [...params.keys()].sort().map(k => k + params.get(k)).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const expected = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))));
  return expected === request.headers.get('x-twilio-signature');
}
/** SMS transport: Twilio forwards texts from the drone's SIM; commands go back out through the Twilio REST API. */
export async function handleSms(request: Request) {
  const db = env.DB, t = twilio(), twiml = new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { headers: { 'Content-Type': 'text/xml' } });
  if (!db || !secret() || !t) return text('SMS link is not configured.', 503);
  if (tooLarge(request, 16_000)) return text('Too large.', 413);
  const params = new URLSearchParams(await request.text());
  if (!(await twilioSignatureValid(request, params, t.token))) return text('Invalid signature.', 403);
  const row = await db.prepare("SELECT * FROM drones WHERE phone = ? AND transport = 'sms'").bind(params.get('From') || '').first<DroneRow>();
  if (!row) return twiml;
  const drone = toDrone(row), messages = await verifiedMessages(drone, (params.get('Body') || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 5));
  if (!messages.length) return twiml;
  const now = Date.now();
  // A correctly signed text from this number proves the operator controls it; only then may AERO text it back.
  if (!drone.phoneVerified) await db.prepare('UPDATE drones SET phone_verified = 1 WHERE id = ?').bind(drone.id).run();
  await ingest(db, drone, messages, now);
  const fresh = (await loadDrone(db, drone.id))!; await expireCommands(db, fresh, now); await flushSms(db, fresh, now, true);
  return twiml;
}

/** Adds the mission drone's latest telemetry to live returns for the customer view. */
export async function attachLive(db: D1Database, owner: string, records: ReturnRecord[], now: number) {
  const ids = [...new Set(records.flatMap(r => (r.live ? [r.live.droneId] : [])))];
  if (!ids.length) return records;
  const rows = await db.prepare(`SELECT * FROM drones WHERE owner = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(owner, ...ids).all<DroneRow>();
  const drones = new Map(rows.results.map(r => [r.id, toDrone(r)]));
  // Only the flight the drone is flying right now shows its telemetry; finished ones keep their final positions.
  return records.map(r => { const d = r.live && drones.get(r.live.droneId); return d && r.live && d.activeReturn === r.id ? { ...r, live: { ...r.live, telemetry: d.telemetry, stale: isStale(d, now) } } : r; });
}
const liveActionSchema = z.object({ action: z.string() });
export async function liveReturnRequest(db: D1Database, owner: string, record: ReturnRecord, version: number, request: Request, now: number): Promise<{ status: number; body: unknown }> {
  const drone = await loadDrone(db, record.live!.droneId);
  if (!drone || drone.owner !== owner) return { status: 200, body: { record, now } };
  if (request.method === 'GET') {
    await expireCommands(db, drone, now);
    const current = drone.activeReturn === record.id ? (await missionReturn(db, drone))?.record ?? record : record;
    const [withTelemetry] = await attachLive(db, owner, [current], now);
    return { status: 200, body: { record: withTelemetry, now } };
  }
  if (request.method !== 'PATCH') return { status: 405, body: { error: 'Method not allowed.' } };
  const raw = await request.text(); if (raw.length > 1000) return { status: 413, body: { error: 'Request is too large.' } };
  const { action } = liveActionSchema.parse(JSON.parse(raw));
  const r = { ...record, live: { ...record.live!, telemetry: drone.telemetry } };
  const step = customerAction(r, action);
  const moved = await moveMission(db, drone, record, version, step.phase, { command: step.command ?? null, cancelled: step.cancelled }, now);
  if (!moved) return { status: 409, body: { error: 'This return changed in another tab. Please try again.' } };
  const [withTelemetry] = await attachLive(db, owner, [moved], now);
  return { status: 200, body: { record: withTelemetry, now } };
}

const point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const createSchema = z.object({ name: z.string().trim().min(1).max(40), transport: z.enum(['https', 'sms']), phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use an E.164 phone number like +15105550123.').optional(), home: point, pickupPad: point.nullable().default(null), dropPad: point.nullable().default(null), radius: z.number(), maxAlt: z.number(), cruiseAlt: z.number() });
const patchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('arm'), checklist: z.object({ pilot: z.literal(true), airspace: z.literal(true), pads: z.literal(true), failsafe: z.literal(true) }) }),
  z.object({ action: z.literal('disarm') }),
  z.object({ action: z.literal('config'), name: z.string().trim().min(1).max(40).optional(), home: point.optional(), pickupPad: point.nullable().optional(), dropPad: point.nullable().optional(), radius: z.number().optional(), maxAlt: z.number().optional(), cruiseAlt: z.number().optional() }),
  z.object({ action: z.literal('pad-from-drone'), pad: z.enum(['home', 'pickupPad', 'dropPad']) }),
  z.object({ action: z.literal('command'), type: z.enum(['PING', 'HOLD', 'LAND', 'RTL', 'ABORT']) }),
  z.object({ action: z.literal('dispatch'), returnId: z.string().uuid() }),
  z.object({ action: z.enum(['launch', 'unload', 'retry']) }),
  z.object({ action: z.literal('abort') }),
  z.object({ action: z.literal('rotate-key') }),
]);
const publicDrone = (d: Drone, now: number) => ({ id: d.id, name: d.name, transport: d.transport, phone: d.phone, phoneVerified: d.phoneVerified, config: d.config, armed: d.armedUntil > now, armedUntil: d.armedUntil, activeReturn: d.activeReturn, lastSeen: d.lastSeen, stale: isStale(d, now), telemetry: d.telemetry, createdAt: d.createdAt });
const newDroneId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

/** Owner-scoped Fleet console API. */
export async function handleFleet(request: Request, id?: string): Promise<Response> {
  let identity: Awaited<ReturnType<typeof session>>;
  try { identity = await session(request); } catch { return Response.json({ error: 'Your account session expired. Open Your account to sign in again.' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } }); }
  const { owner, cookie } = identity;
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
  const db = env.DB; if (!db) return reply({ error: 'Storage is unavailable.' }, 503);
  const setup = { link: !!secret(), sms: !!twilio(), linkUrl: `${new URL(request.url).origin}/api/drone/link`, smsWebhook: `${new URL(request.url).origin}/api/drone/sms` };
  try {
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) return reply({ error: 'Request origin is not allowed.' }, 403);
      if (Number(request.headers.get('content-length') || 0) > 4000) return reply({ error: 'Request is too large.' }, 413);
    }
    const now = Date.now();
    if (!id && request.method === 'GET') {
      const rows = await db.prepare('SELECT * FROM drones WHERE owner = ? ORDER BY created_at').bind(owner).all<DroneRow>();
      return reply({ setup, limits: LIMITS, drones: rows.results.map(r => publicDrone(toDrone(r), now)), now });
    }
    if (!id && request.method === 'POST') {
      if (!secret()) return reply({ error: 'Set the DRONE_LINK_SECRET Worker secret before registering drones.' }, 503);
      const input = createSchema.parse(JSON.parse(await request.text()));
      if (input.transport === 'sms' && !input.phone) return reply({ error: 'SMS drones need the phone number of their SIM.' }, 400);
      const config: DroneConfig = { home: input.home as Point, pickupPad: input.pickupPad as Point | null, dropPad: input.dropPad as Point | null, radius: input.radius, maxAlt: input.maxAlt, cruiseAlt: input.cruiseAlt };
      const problem = configProblem(config); if (problem) return reply({ error: problem }, 400);
      const count = await db.prepare('SELECT COUNT(*) AS n FROM drones WHERE owner = ?').bind(owner).first<{ n: number }>();
      if ((count?.n || 0) >= LIMITS.maxDrones) return reply({ error: `You can register up to ${LIMITS.maxDrones} drones.` }, 429);
      const droneId = newDroneId();
      try { await db.prepare('INSERT INTO drones (id, owner, name, transport, phone, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(droneId, owner, input.name, input.transport, input.transport === 'sms' ? input.phone! : null, JSON.stringify(config), now).run(); }
      catch (error) { if (/UNIQUE/i.test(String(error))) return reply({ error: 'That phone number is already registered to a drone.' }, 409); throw error; }
      const drone = (await loadDrone(db, droneId))!;
      return reply({ drone: publicDrone(drone, now), key: await keyFor(drone), setup }, 201);
    }
    if (!id) return reply({ error: 'Not found.' }, 404);
    let drone = await loadDrone(db, id);
    if (!drone || drone.owner !== owner) return reply({ error: 'This drone is not in your fleet.' }, 404);
    if (request.method === 'DELETE') {
      if (drone.activeReturn) return reply({ error: 'End the live flight before removing this drone.' }, 409);
      if (airborne(drone.telemetry)) return reply({ error: 'Land the drone before removing it; ABORT stops working once it is removed.' }, 409);
      await db.batch([db.prepare('DELETE FROM drone_commands WHERE drone_id = ?').bind(id), db.prepare('DELETE FROM drone_telemetry WHERE drone_id = ?').bind(id), db.prepare('DELETE FROM drones WHERE id = ? AND owner = ?').bind(id, owner)]);
      return reply({ deleted: true });
    }
    let key: string | undefined;
    if (request.method === 'PATCH') {
      const input = patchSchema.parse(JSON.parse(await request.text()));
      const mission = drone.activeReturn ? await missionReturn(db, drone) : null;
      const needsLink = () => { if (!secret()) throw new Error('Set the DRONE_LINK_SECRET Worker secret first.'); };
      if (input.action === 'arm') await db.prepare('UPDATE drones SET armed_until = ? WHERE id = ?').bind(now + ARM_WINDOW_MS, id).run();
      else if (input.action === 'disarm') await db.prepare('UPDATE drones SET armed_until = 0 WHERE id = ?').bind(id).run();
      else if (input.action === 'config' || input.action === 'pad-from-drone') {
        if (mission) throw new Error('Pads and limits are locked during a live flight.');
        let config: DroneConfig, name = drone.name;
        if (input.action === 'pad-from-drone') {
          if (!drone.telemetry || isStale(drone, now)) throw new Error('Waiting for fresh telemetry from the bridge.');
          config = { ...drone.config, [input.pad]: [drone.telemetry.lon, drone.telemetry.lat] };
        } else { config = { ...drone.config, ...Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== 'action' && k !== 'name' && v !== undefined)) } as DroneConfig; name = input.name ?? name; }
        const problem = configProblem(config); if (problem) throw new Error(problem);
        // Changing limits disarms the drone so the checklist is confirmed against the new pads.
        await db.prepare('UPDATE drones SET name = ?, config = ?, armed_until = 0 WHERE id = ?').bind(name, JSON.stringify(config), id).run();
      } else if (input.action === 'command' || input.action === 'abort') {
        needsLink();
        const type = input.action === 'abort' ? 'ABORT' : input.type, live = mission?.record.live && !ENDED.includes(mission.record.live.phase) ? mission.record.live : null;
        if (type !== 'ABORT' && await recentCommands(db, drone.id, now) >= COMMANDS_PER_MINUTE) return reply({ error: 'Too many commands this minute. ABORT still works.' }, 429);
        if (type === 'HOLD' && live && !GROUND_PHASES.includes(live.phase)) {
          // An airborne HOLD pauses the mission until the operator retries the step or aborts.
          await stepMission(db, drone, r => ({ phase: r.live!.phase, fault: 'OPERATOR_HOLD', command: { type, args: [] } }), now);
        } else {
          // ABORT, LAND and RTL go straight to the queue so they reach the drone even if the mission record is contended.
          await enqueue(db, drone, { type, args: [] }, now);
          if (live && (type === 'ABORT' || type === 'LAND' || type === 'RTL')) await stepMission(db, drone, () => ({ phase: 'ABORTED', command: null }), now).catch(() => null);
        }
      } else if (input.action === 'dispatch') {
        needsLink();
        const row = await db.prepare('SELECT record, version FROM returns WHERE id = ? AND owner = ?').bind(input.returnId, owner).first<{ record: string; version: number }>();
        if (!row) throw new Error('Choose one of your own returns.');
        const record = JSON.parse(row.record) as ReturnRecord, blockers = dispatchBlockers(drone, record, now);
        if (blockers.length) return reply({ error: blockers.join(' '), blockers }, 400);
        const claimed = await db.prepare('UPDATE drones SET active_return = ? WHERE id = ? AND active_return IS NULL').bind(record.id, id).run();
        if (claimed.meta.changes === 0) return reply({ error: 'The drone is already flying another return.' }, 409);
        const release = () => db.prepare('UPDATE drones SET active_return = NULL WHERE id = ? AND active_return = ?').bind(id, record.id).run();
        let moved: ReturnRecord | null;
        try { moved = await moveMission(db, { ...drone, activeReturn: record.id }, startLive(record, drone, now), row.version, 'TAKEOFF_OUT', {}, now); }
        catch (error) { await release(); throw error; }
        if (!moved) { await release(); return reply({ error: 'That return changed at the same time. Please try again.' }, 409); }
      } else if (input.action === 'rotate-key') {
        needsLink(); if (mission) throw new Error('Rotate the key after the live flight ends.');
        if (airborne(drone.telemetry)) throw new Error('Land the drone before rotating its key; the old key stops working immediately.');
        await db.prepare('UPDATE drones SET key_version = key_version + 1, last_seq = 0 WHERE id = ?').bind(id).run();
        key = await keyFor((await loadDrone(db, id))!);
      } else {
        needsLink(); if (!mission?.record.live) throw new Error('This drone has no live flight.');
        const action = input.action;
        if (action !== 'retry' || phaseCommand(mission.record.live, mission.record.live.phase)) {
          if (drone.armedUntil <= now) throw new Error('Arm live missions again with the pre-flight checklist.');
          if (isStale(drone, now)) throw new Error('No fresh telemetry from the bridge.');
        }
        await stepMission(db, drone, r => operatorAction(r, action), now);
      }
      drone = (await loadDrone(db, id))!;
    }
    const [trail, commands] = await Promise.all([
      db.prepare('SELECT data FROM drone_telemetry WHERE drone_id = ? ORDER BY seq DESC LIMIT 240').bind(id).all<{ data: string }>(),
      db.prepare('SELECT seq, type, status, reason, phase, created_at, updated_at FROM drone_commands WHERE drone_id = ? ORDER BY seq DESC LIMIT 25').bind(id).all(),
    ]);
    const mission = drone.activeReturn ? await missionReturn(db, drone) : null;
    return reply({ setup, drone: publicDrone(drone, now), ...(key ? { key } : {}), trail: trail.results.map(t => JSON.parse(t.data) as LiveTelemetry).reverse(), commands: commands.results, mission: mission?.record ?? null, now });
  } catch (error) {
    if (error instanceof z.ZodError) return reply({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' · ') }, 400);
    if (error instanceof SyntaxError) return reply({ error: 'Invalid request.' }, 400);
    if (error instanceof Error && !/D1|SQLITE|network/i.test(error.message)) return reply({ error: error.message }, 400);
    console.error('AERO fleet operation failed', error);
    return reply({ error: 'Could not reach fleet storage. Try again in a moment.' }, 503);
  }
}
