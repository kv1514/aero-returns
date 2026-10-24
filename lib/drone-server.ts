/** Live drone API. Website users (owner + invited pilots) queue commands; the drone's agent
 * polls /api/drone/sync over 4G, reports telemetry and receives the next command. */
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { session } from './server';
import type { Point } from './simulation';
import {
  appendTrail, commandRequestSchema, droneSettingsSchema, FLY_EXPIRES_MS, formatToken, isOnline, isSafety, nextCommand, parseToken,
  preflight, randomHex, SAFETY_EXPIRES_MS, sameHex, sha256Hex, smsCommandSchema, smsText, syncSchema,
  type CommandStatus, type CommandType, type DroneCommand, type DroneConfig, type DroneView, type FlyRoute, type Telemetry, MIN_BATTERY_PCT,
} from './drone-protocol';

type Row = { id: string; owner: string; name: string; token_hash: string; pilots: string; pilot_code: string | null; phone: string | null; home_lng: number | null; home_lat: number | null; geofence_m: number; max_alt_m: number; created_at: number; last_seen: number | null; telemetry: string | null; trail: string };
type CommandRow = { id: string; drone_id: string; issued_by: string; type: string; params: string | null; status: string; channel: string; created_at: number; updated_at: number; expires_at: number; message: string | null };

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
async function view(row: Row, owner: string, now: number): Promise<DroneView> {
  const commands = await db().prepare('SELECT * FROM drone_commands WHERE drone_id = ? ORDER BY created_at DESC LIMIT 12').bind(row.id).all<CommandRow>();
  const mine = row.owner === owner;
  return {
    id: row.id, name: row.name, role: mine ? 'owner' : 'pilot', online: isOnline(row.last_seen, now), lastSeen: row.last_seen, telemetry: telemetryOf(row),
    trail: JSON.parse(row.trail), home: home(row), geofenceM: row.geofence_m, maxAltM: row.max_alt_m, phone: row.phone,
    pilotCode: mine ? row.pilot_code : null, pilots: pilotsOf(row).length,
    commands: commands.results.map(c => ({ ...command(c), expiresAt: c.status === 'queued' && c.expires_at <= now ? now : c.expires_at, status: c.status === 'queued' && c.expires_at <= now ? 'expired' : c.status as CommandStatus })),
  };
}
async function queue(row: Row, issuedBy: string, type: CommandType, params: FlyRoute | null, channel: 'internet' | 'sms', now: number) {
  // A new flight replaces any flight still waiting. Any safety command replaces everything still waiting.
  const superseded = isSafety(type) ? "status = 'queued'" : "status = 'queued' AND type = 'FLY_ROUTE'";
  const id = crypto.randomUUID();
  await db().batch([
    db().prepare(`UPDATE drone_commands SET status = 'superseded', updated_at = ? WHERE drone_id = ? AND ${superseded}`).bind(now, row.id),
    db().prepare('INSERT INTO drone_commands (id, drone_id, issued_by, type, params, status, channel, created_at, updated_at, expires_at, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, row.id, issuedBy, type, params ? JSON.stringify(params) : null, channel === 'sms' ? 'sent' : 'queued', channel, now, now, now + (type === 'FLY_ROUTE' ? FLY_EXPIRES_MS : SAFETY_EXPIRES_MS), channel === 'sms' ? 'Sent as a text message' : null),
  ]);
  return id;
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
      if (isOwner) await db().batch([db().prepare('DELETE FROM drone_commands WHERE drone_id = ?').bind(id), db().prepare('DELETE FROM drones WHERE id = ?').bind(id)]);
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
    if (action === 'sms') {
      const req = parse(raw, smsCommandSchema);
      const args = req.command === 'GOTO' ? [req.point[1].toFixed(6), req.point[0].toFixed(6), String(req.altM)] : [];
      const text = await smsText(row.token_hash, row.id, req.command, args, now);
      const sent = row.phone ? await sendSms(row.phone, text) : false;
      if (sent && req.command !== 'STATUS') await queue(row, owner, req.command === 'GOTO' ? 'FLY_ROUTE' : req.command, req.command === 'GOTO' ? { waypoints: [req.point], altM: req.altM, speedMs: 6, land: false } : null, 'sms', now);
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
    const statements = [
      db().prepare('UPDATE drones SET last_seen = ?, telemetry = ?, trail = ?, home_lng = ?, home_lat = ? WHERE id = ?')
        .bind(now, JSON.stringify(telemetry), JSON.stringify(trail), setHome ? p[0] : row.home_lng, setHome ? p[1] : row.home_lat, row.id),
      db().prepare("UPDATE drone_commands SET status = 'expired', updated_at = ? WHERE drone_id = ? AND status = 'queued' AND expires_at <= ?").bind(now, row.id, now),
      ...acks.map(a => db().prepare("UPDATE drone_commands SET status = ?, message = ?, updated_at = ? WHERE id = ? AND drone_id = ? AND status NOT IN ('done', 'failed', 'superseded')").bind(a.status, a.message ?? null, now, a.commandId, row.id)),
    ];
    await db().batch(statements);
    const queued = await db().prepare("SELECT * FROM drone_commands WHERE drone_id = ? AND status = 'queued' AND expires_at > ?").bind(row.id, now).all<CommandRow>();
    const next = nextCommand(queued.results.map(c => ({ ...c, createdAt: c.created_at, expiresAt: c.expires_at })), now);
    if (next) await db().prepare("UPDATE drone_commands SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'queued'").bind(now, next.id).run();
    const config: DroneConfig = { droneId: row.id, name: row.name, home: setHome ? p : home(row), geofenceM: row.geofence_m, maxAltM: row.max_alt_m, minBatteryPct: MIN_BATTERY_PCT };
    return reply({ command: next ? { id: next.id, type: next.type, params: next.params ? JSON.parse(next.params) : null, expiresAt: next.expires_at } : null, config, serverTime: now });
  } catch (error) { return failure(error, reply); }
}

function failure(error: unknown, reply: (value: unknown, status?: number) => Response) {
  if (error instanceof HttpError) return reply({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return reply({ error: error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join(' · ') }, 400);
  if (error instanceof SyntaxError) return reply({ error: 'Invalid request.' }, 400);
  console.error('AERO drone operation failed', error);
  return reply({ error: 'Could not reach drone storage. Retry in a moment.' }, 503);
}
