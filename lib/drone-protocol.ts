/** Live drone link: shared by the website, the device API, tests and the fake drone.
 * The drone's companion computer (see drone-agent/) talks to /api/drone/sync over 4G.
 * Every motion command is checked here on the server and again on the drone. */
import { z } from 'zod';
import { distance, pathDistance, type Point } from './simulation';

export const ONLINE_MS = 10_000;
export const FLY_EXPIRES_MS = 30_000;
export const SAFETY_EXPIRES_MS = 120_000;
export const MIN_BATTERY_PCT = 30;
export const MAX_ROUTE_M = 5_000;
export const LEGAL_MAX_ALT_M = 120; // FAA Part 107 ceiling (400 ft AGL)
export const TRAIL_POINTS = 300;
export const SMS_WINDOW_S = 300;

export const SAFETY_COMMANDS = ['HOLD', 'LAND', 'RTL'] as const;
export type SafetyCommand = typeof SAFETY_COMMANDS[number];
export type CommandType = 'FLY_ROUTE' | SafetyCommand | 'PING';
export type CommandStatus = 'queued' | 'sent' | 'accepted' | 'done' | 'failed' | 'expired' | 'superseded';
export type DroneState = 'idle' | 'arming' | 'taking_off' | 'en_route' | 'holding' | 'landing' | 'returning' | 'landed' | 'error';

const lng = z.number().finite().min(-180).max(180), lat = z.number().finite().min(-90).max(90);
export const pointSchema = z.tuple([lng, lat]);

export const telemetrySchema = z.object({
  lat, lng,
  altM: z.number().finite().min(-50).max(1000),
  headingDeg: z.number().finite().min(0).max(360),
  groundSpeedMs: z.number().finite().min(0).max(100),
  batteryPct: z.number().finite().min(0).max(100),
  gpsFix: z.number().int().min(0).max(6),
  satellites: z.number().int().min(0).max(64),
  armed: z.boolean(),
  mode: z.string().max(32),
  state: z.enum(['idle', 'arming', 'taking_off', 'en_route', 'holding', 'landing', 'returning', 'landed', 'error']),
  flightAllowed: z.boolean(),
  link: z.enum(['4g', 'lte', '5g', 'wifi', 'ethernet', 'sim', 'other']).default('other'),
  signalDbm: z.number().finite().min(-150).max(0).optional(),
  activeCommandId: z.string().max(64).nullable().optional(),
  waypointIndex: z.number().int().min(0).max(20).nullable().optional(),
  message: z.string().max(200).optional(),
  simulated: z.boolean().default(false),
  agentVersion: z.string().max(32).optional(),
});
export type Telemetry = z.infer<typeof telemetrySchema>;

export const ackSchema = z.object({
  commandId: z.string().max(64),
  status: z.enum(['accepted', 'done', 'failed']),
  message: z.string().max(200).optional(),
});
export const syncSchema = z.object({ telemetry: telemetrySchema, acks: z.array(ackSchema).max(20).default([]) });

export const flyRouteSchema = z.object({
  waypoints: z.array(pointSchema).min(1).max(10),
  altM: z.number().finite().min(5).max(LEGAL_MAX_ALT_M),
  speedMs: z.number().finite().min(1).max(15).default(6),
  land: z.boolean().default(true),
});
export type FlyRoute = z.infer<typeof flyRouteSchema>;

export const commandRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('FLY_ROUTE'), params: flyRouteSchema, pilotReady: z.literal(true, { errorMap: () => ({ message: 'Confirm a pilot with a remote controller is watching the drone.' }) }) }),
  z.object({ type: z.enum(['HOLD', 'LAND', 'RTL', 'PING']) }),
]);
export type CommandRequest = z.infer<typeof commandRequestSchema>;

export const droneSettingsSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Use international format, like +14155550123.').or(z.literal('')).optional(),
  geofenceM: z.number().int().min(50).max(3000).optional(),
  maxAltM: z.number().int().min(10).max(LEGAL_MAX_ALT_M).optional(),
  home: z.union([pointSchema, z.literal('current')]).optional(),
});

export type DroneConfig = { droneId: string; name: string; home: Point | null; geofenceM: number; maxAltM: number; minBatteryPct: number };
export type DroneCommand = { id: string; type: CommandType; params: FlyRoute | null; status: CommandStatus; channel: 'internet' | 'sms'; createdAt: number; updatedAt: number; expiresAt: number; message: string | null; issuedBy?: string };
export type DroneView = {
  id: string; name: string; role: 'owner' | 'pilot'; online: boolean; lastSeen: number | null; telemetry: Telemetry | null; trail: Point[];
  home: Point | null; geofenceM: number; maxAltM: number; phone: string | null; pilotCode: string | null; pilots: number; commands: DroneCommand[];
};

export const isSafety = (type: string): type is SafetyCommand => (SAFETY_COMMANDS as readonly string[]).includes(type);
export const isOnline = (lastSeen: number | null, now: number) => lastSeen !== null && now - lastSeen <= ONLINE_MS;
export const position = (t: Telemetry): Point => [t.lng, t.lat];

/** The route the drone will actually fly: from where it is now, through every waypoint. */
export function plannedPath(t: Telemetry | null, route: FlyRoute): Point[] {
  return t ? [position(t), ...route.waypoints] : route.waypoints;
}

/** Server-side preflight. Returns a reason the flight is refused, or null when it may be queued. */
export function preflight(d: { home: Point | null; geofenceM: number; maxAltM: number; lastSeen: number | null; telemetry: Telemetry | null }, route: FlyRoute, now: number): string | null {
  const t = d.telemetry;
  if (!t || !isOnline(d.lastSeen, now)) return 'The drone is offline. Check its 4G connection and that the AERO agent is running.';
  if (!t.flightAllowed) return 'The drone is in observe-only mode. Restart the agent with --allow-flight to accept flights.';
  if (t.state === 'error') return 'The drone reported an error. Resolve it before flying.';
  if (t.gpsFix < 3) return `Waiting for a 3D GPS fix (currently ${t.gpsFix}, ${t.satellites} satellites).`;
  if (t.batteryPct < MIN_BATTERY_PCT) return `Battery is ${Math.round(t.batteryPct)}%. Charge above ${MIN_BATTERY_PCT}% before flying.`;
  if (!d.home) return 'Set a home point before flying.';
  if (route.altM > d.maxAltM) return `Altitude is above this drone's ${d.maxAltM} m limit.`;
  const outside = route.waypoints.findIndex(p => distance(d.home!, p) > d.geofenceM);
  if (outside >= 0) return `Point ${String.fromCharCode(65 + outside + (route.waypoints.length > 1 ? 0 : 1))} is outside the ${d.geofenceM} m safety zone around home.`;
  if (distance(d.home, position(t)) > d.geofenceM + 50) return 'The drone is outside its safety zone. Bring it back manually.';
  const length = pathDistance(plannedPath(t, route));
  if (length > MAX_ROUTE_M) return `Route is ${(length / 1000).toFixed(1)} km. The limit is ${MAX_ROUTE_M / 1000} km.`;
  return null;
}

/** Commands the drone should run next: safety first, then the newest flight. */
export function nextCommand<T extends { type: string; status: string; createdAt: number; expiresAt: number }>(commands: T[], now: number): T | null {
  const ready = commands.filter(c => c.status === 'queued' && c.expiresAt > now);
  ready.sort((a, b) => Number(isSafety(b.type)) - Number(isSafety(a.type)) || b.createdAt - a.createdAt);
  return ready[0] || null;
}

export function appendTrail(trail: Point[], p: Point): Point[] {
  const last = trail[trail.length - 1];
  if (last && distance(last, p) < 2) return trail;
  return [...trail, p].slice(-TRAIL_POINTS);
}

// --- Device credentials -----------------------------------------------------------
const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256Hex(text: string) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
/** Token the agent stores: `aero_<droneId>.<secret>`. The server only keeps sha256(secret). */
export const formatToken = (droneId: string, secret: string) => `aero_${droneId}.${secret}`;
export function parseToken(header: string | null): { droneId: string; secret: string } | null {
  const m = header?.match(/^Bearer aero_([a-f0-9-]{36})\.([a-f0-9]{64})$/);
  return m ? { droneId: m[1], secret: m[2] } : null;
}
export function sameHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- SMS backup --------------------------------------------------------------------
/** SMS commands work without mobile data. Codes are HMAC-signed with sha256(secret), valid for ~5 minutes, and single-use on the drone. */
export const SMS_COMMANDS = ['HOLD', 'LAND', 'RTL', 'STATUS', 'GOTO'] as const;
export type SmsCommand = typeof SMS_COMMANDS[number];
export const smsCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.enum(['HOLD', 'LAND', 'RTL', 'STATUS']) }),
  z.object({ command: z.literal('GOTO'), point: pointSchema, altM: z.number().int().min(5).max(LEGAL_MAX_ALT_M) }),
]);
export function smsBody(command: SmsCommand, args: string[] = []) { return [command, ...args].join(' '); }
export async function smsCode(tokenHash: string, droneId: string, body: string, window: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(tokenHash), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${droneId}|${body}|${window}`)));
  return String(parseInt(mac.slice(0, 8), 16) % 100_000_000).padStart(8, '0');
}
export async function smsText(tokenHash: string, droneId: string, command: SmsCommand, args: string[], now: number) {
  const body = smsBody(command, args);
  return `AERO ${body} ${await smsCode(tokenHash, droneId, body, Math.floor(now / 1000 / SMS_WINDOW_S))}`;
}
