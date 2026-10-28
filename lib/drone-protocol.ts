/**
 * AERO drone link v1. Compact signed text lines that fit one SMS segment, shared by the
 * HTTPS polling and SMS transports. See docs/DRONE_LINK.md; bridge/aero_protocol.py mirrors this file.
 */
export const COMMAND_TYPES = ['PING', 'TAKEOFF', 'GOTO', 'HOLD', 'LAND', 'RTL', 'ABORT'] as const;
export const DRONE_STATES = ['IDLE', 'ARMED', 'TAKEOFF', 'ENROUTE', 'HOLD', 'LANDING', 'LANDED', 'RTL', 'ERROR'] as const;
export const ACK_STATUSES = ['ACCEPTED', 'DONE', 'REJECTED', 'FAILED'] as const;
export type CommandType = typeof COMMAND_TYPES[number];
export type DroneState = typeof DRONE_STATES[number];
export type AckStatus = typeof ACK_STATUSES[number];
export type Command = { droneId: string; seq: number; expires: number; type: CommandType; args: number[] };
export type Telemetry = { droneId: string; seq: number; ts: number; lat: number; lon: number; alt: number; battery: number; heading: number; speed: number; fix: number; sats: number; state: DroneState; mode: string };
export type Ack = { droneId: string; seq: number; ts: number; cmdSeq: number; status: AckStatus; reason?: string };
export type DroneMessage = ({ kind: 'telemetry' } & Telemetry) | ({ kind: 'ack' } & Ack);

export const DRONE_ID = /^[a-z0-9]{6,16}$/;
const DECIMAL = /^-?\d{1,3}(?:\.\d{1,7})?$/, INTEGER = /^\d{1,16}$/, MODE = /^[A-Za-z0-9_.]{1,20}$/, REASON = /^[A-Z0-9_]{1,24}$/;
const ARG_COUNT: Record<CommandType, number> = { PING: 0, TAKEOFF: 1, GOTO: 3, HOLD: 0, LAND: 0, RTL: 0, ABORT: 0 };
/** [min, max] per argument. Altitudes are meters above home and never exceed the 120 m cap. */
const ARG_RANGES: Partial<Record<CommandType, [number, number][]>> = { TAKEOFF: [[0, 120]], GOTO: [[-90, 90], [-180, 180], [0, 120]] };

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
function unhex(value: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error('Drone key must be lowercase hex.');
  return Uint8Array.from(value.match(/../g)!, b => parseInt(b, 16));
}
async function hmac(key: Uint8Array<ArrayBuffer>, text: string) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text))));
}
function sameText(a: string, b: string) { let diff = a.length ^ b.length; for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }

/** Per-drone 32-byte key derived from the Worker secret, so no drone key is stored in D1. */
export async function deriveDroneKey(masterSecret: string, droneId: string, version: number) {
  if (masterSecret.length < 32) throw new Error('DRONE_LINK_SECRET must be at least 32 characters.');
  return hmac(new TextEncoder().encode(masterSecret), `aero-drone-key:${droneId}:${version}`);
}
export async function signLine(keyHex: string, body: string) { return `${body} ~${(await hmac(unhex(keyHex), body)).slice(0, 16)}`; }
/** Returns the unsigned body when the 64-bit truncated HMAC matches, otherwise null. */
export async function verifyLine(keyHex: string, line: string) {
  const m = /^(.{1,200}) ~([0-9a-f]{16})$/.exec(line.trim());
  if (!m) return null;
  return sameText((await hmac(unhex(keyHex), m[1])).slice(0, 16), m[2]) ? m[1] : null;
}
export function lineDroneId(line: string) { const [tag, id] = line.trim().split(' '); return /^A[TKC]1$/.test(tag) && DRONE_ID.test(id || '') ? id : null; }

const coord = (n: number) => n.toFixed(6), meters = (n: number) => n.toFixed(1);
export function formatCommand(c: Command) {
  if (!DRONE_ID.test(c.droneId) || !Number.isSafeInteger(c.seq) || c.seq < 1) throw new Error('Invalid command identity.');
  if (c.args.length !== ARG_COUNT[c.type] || c.args.some(n => !Number.isFinite(n))) throw new Error(`${c.type} needs ${ARG_COUNT[c.type]} numeric arguments.`);
  if (c.args.some((n, i) => n < ARG_RANGES[c.type]![i][0] || n > ARG_RANGES[c.type]![i][1])) throw new Error(`${c.type} argument out of range.`);
  const args = c.type === 'GOTO' ? [coord(c.args[0]), coord(c.args[1]), meters(c.args[2])] : c.args.map(meters);
  return ['AC1', c.droneId, c.seq, Math.floor(c.expires), c.type, ...args].join(' ');
}
export function formatTelemetry(t: Telemetry) {
  return ['AT1', t.droneId, t.seq, Math.floor(t.ts), coord(t.lat), coord(t.lon), meters(t.alt), Math.round(t.battery), ((Math.round(t.heading) % 360) + 360) % 360, meters(t.speed), t.fix, t.sats, t.state, t.mode].join(' ');
}
export function formatAck(a: Ack) { return ['AK1', a.droneId, a.seq, Math.floor(a.ts), a.cmdSeq, a.status, ...(a.reason ? [a.reason] : [])].join(' '); }

function num(token: string | undefined, pattern: RegExp, min: number, max: number) {
  if (token === undefined || !pattern.test(token)) return null;
  const n = Number(token); return n >= min && n <= max ? n : null;
}
/** Strict parser for drone → server bodies (signature already removed). Unknown or out-of-range values return null. */
export function parseDroneBody(body: string): DroneMessage | null {
  const t = body.split(' ');
  if (!DRONE_ID.test(t[1] || '')) return null;
  const seq = num(t[2], INTEGER, 1, Number.MAX_SAFE_INTEGER), ts = num(t[3], INTEGER, 1, 4102444800);
  if (seq === null || ts === null) return null;
  if (t[0] === 'AT1' && t.length === 14) {
    const lat = num(t[4], DECIMAL, -90, 90), lon = num(t[5], DECIMAL, -180, 180), alt = num(t[6], DECIMAL, -100, 999.9);
    const battery = num(t[7], /^-?\d{1,3}$/, -1, 100), heading = num(t[8], /^\d{1,3}$/, 0, 359), speed = num(t[9], DECIMAL, 0, 100);
    const fix = num(t[10], /^\d$/, 0, 8), sats = num(t[11], /^\d{1,2}$/, 0, 99), state = t[12] as DroneState;
    if ([lat, lon, alt, battery, heading, speed, fix, sats].some(v => v === null) || !DRONE_STATES.includes(state) || !MODE.test(t[13])) return null;
    return { kind: 'telemetry', droneId: t[1], seq, ts, lat: lat!, lon: lon!, alt: alt!, battery: battery!, heading: heading!, speed: speed!, fix: fix!, sats: sats!, state, mode: t[13] };
  }
  if (t[0] === 'AK1' && (t.length === 6 || t.length === 7)) {
    const cmdSeq = num(t[4], INTEGER, 1, Number.MAX_SAFE_INTEGER), status = t[5] as AckStatus;
    if (cmdSeq === null || !ACK_STATUSES.includes(status) || (t[6] !== undefined && !REASON.test(t[6]))) return null;
    return { kind: 'ack', droneId: t[1], seq, ts, cmdSeq, status, ...(t[6] ? { reason: t[6] } : {}) };
  }
  return null;
}
/** Parses a server → drone command body. Used by tests and as the reference for bridge implementations. */
export function parseCommandBody(body: string): Command | null {
  const t = body.split(' '), type = t[4] as CommandType;
  if (t[0] !== 'AC1' || !DRONE_ID.test(t[1] || '') || !COMMAND_TYPES.includes(type) || t.length !== 5 + ARG_COUNT[type]) return null;
  const seq = num(t[2], INTEGER, 1, Number.MAX_SAFE_INTEGER), expires = num(t[3], INTEGER, 1, 4102444800);
  const args = t.slice(5).map((a, i) => num(a, DECIMAL, ...ARG_RANGES[type]![i]));
  if (seq === null || expires === null || args.some(a => a === null)) return null;
  return { droneId: t[1], seq, expires, type, args: args as number[] };
}
