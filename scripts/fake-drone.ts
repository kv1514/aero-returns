/** A simulated drone that speaks the real /api/drone/sync protocol, for demos and testing without hardware.
 *   node_modules/.bin/tsx scripts/fake-drone.ts --server http://127.0.0.1:5173 --token aero_<id>.<secret> [--home 37.8719,-122.2585]
 * Real drones use drone-agent/aero_agent.py, which has the same behavior plus MAVLink, SMS and failsafes. */
import { bearing, distance, type Point } from '../lib/simulation';
import type { DroneState, FlyRoute, Telemetry } from '../lib/drone-protocol';

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const server = (arg('server', 'http://127.0.0.1:5173') as string).replace(/\/$/, ''), token = arg('token') || process.env.AERO_DRONE_TOKEN;
if (!token) { console.error('Pass --token aero_<id>.<secret> (copy it from the Fly page).'); process.exit(1); }
const [homeLat, homeLng] = (arg('home', '37.8719,-122.2585') as string).split(/[\s,]+/).map(Number);
if (!Number.isFinite(homeLat) || !Number.isFinite(homeLng) || Math.abs(homeLat) > 90 || Math.abs(homeLng) > 180) { console.error('Use --home lat,lng (quote it in PowerShell: --home "37.8719,-122.2585").'); process.exit(1); }

const move = (p: Point, heading: number, m: number): Point => { const r = heading * Math.PI / 180; return [p[0] + m * Math.sin(r) / (111195 * Math.cos(p[1] * Math.PI / 180)), p[1] + m * Math.cos(r) / 111195]; };
const home: Point = [homeLng, homeLat];
let p: Point = home, alt = 0, heading = 0, speed = 0, battery = 100, armed = false, mode = 'GUIDED', state: DroneState = 'landed', message = 'Simulated drone ready.';
let route: FlyRoute | null = null, wp = 0, active: string | null = null, action: 'idle' | 'takeoff' | 'goto' | 'hold' | 'land' | 'rtl' = 'idle';
let acks: { commandId: string; status: 'accepted' | 'done' | 'failed'; message?: string }[] = [];
const seen = new Set<string>();
const ack = (commandId: string | null, status: 'accepted' | 'done' | 'failed', text: string) => { if (commandId) acks.push({ commandId, status, message: text }); message = text; console.log(`${status.padEnd(8)} ${text}`); };

function handle(c: { id: string; type: string; params: FlyRoute | null }) {
  if (seen.has(c.id)) return; seen.add(c.id);
  if (c.type === 'PING') return ack(c.id, 'done', 'Pong from the simulated drone.');
  if (active && route) ack(active, 'failed', `Replaced by ${c.type}.`);
  route = null; active = c.id;
  if (c.type === 'HOLD') { action = 'hold'; mode = 'LOITER'; state = alt > 0.1 ? 'holding' : 'landed'; active = null; return ack(c.id, 'done', 'Holding position.'); }
  if (c.type === 'LAND') { action = 'land'; mode = 'LAND'; state = 'landing'; return ack(c.id, 'accepted', 'Landing now.'); }
  if (c.type === 'RTL') { action = 'rtl'; mode = 'RTL'; state = 'returning'; return ack(c.id, 'accepted', 'Returning home.'); }
  if (c.type === 'FLY_ROUTE' && c.params) {
    route = c.params; wp = 0; mode = 'GUIDED';
    if (!armed) { armed = true; action = 'takeoff'; state = 'taking_off'; } else { action = 'goto'; state = 'en_route'; }
    return ack(c.id, 'accepted', `Flying ${route.waypoints.length} waypoint(s) at ${route.altM} m.`);
  }
  ack(c.id, 'failed', `Unknown command ${c.type}.`);
}

function step(dt: number) {
  if (armed) battery = Math.max(0, battery - dt * (0.05 + 0.004 * speed));
  const climb = (target: number) => { alt += Math.max(-1.5 * dt, Math.min(2.5 * dt, target - alt)); };
  const towards = (target: Point, v: number) => { const d = distance(p, target); if (d < 0.05) { speed = 0; return; } heading = bearing(p, target); const s = Math.min(d, v * dt); p = s >= d ? target : move(p, heading, s); speed = s / dt; };
  if (action === 'takeoff' && route) { climb(route.altM); speed = 0; if (alt >= route.altM * 0.9) { action = 'goto'; state = 'en_route'; } }
  else if (action === 'goto' && route) {
    climb(route.altM); towards(route.waypoints[wp], route.speedMs);
    if (distance(p, route.waypoints[wp]) <= 4) {
      if (wp + 1 < route.waypoints.length) wp++;
      else if (route.land) { action = 'land'; mode = 'LAND'; state = 'landing'; }
      else { action = 'hold'; mode = 'LOITER'; state = 'holding'; ack(active, 'done', 'Arrived. Hovering at the destination.'); active = null; route = null; }
    }
  } else if (action === 'rtl') { if (distance(p, home) > 1) { climb(Math.max(alt, 30)); towards(home, 8); } else action = 'land'; }
  else if (action === 'hold') speed = 0;
  if (action === 'land') { speed = 0; alt = Math.max(0, alt - 1.5 * dt); if (alt <= 0.05) { alt = 0; armed = false; action = 'idle'; mode = 'GUIDED'; state = 'landed'; ack(active, 'done', 'Landed.'); active = null; route = null; } }
}

const telemetry = (): Telemetry => ({ lat: p[1], lng: p[0], altM: +alt.toFixed(2), headingDeg: +heading.toFixed(1), groundSpeedMs: +speed.toFixed(2), batteryPct: +battery.toFixed(1), gpsFix: 3, satellites: 14, armed, mode, state, flightAllowed: true, link: 'sim', activeCommandId: active, waypointIndex: route ? wp : null, message, simulated: true, agentVersion: 'fake-1.0' });

async function sync() {
  const sending = acks; acks = [];
  try {
    const response = await fetch(`${server}/api/drone/sync`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ telemetry: telemetry(), acks: sending }), signal: AbortSignal.timeout(8000) });
    const data = await response.json() as { command?: { id: string; type: string; params: FlyRoute | null } | null; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (data.command) handle(data.command);
  } catch (error) { acks = [...sending, ...acks]; console.warn('sync failed:', (error as Error).message); }
}

console.log(`Simulated AERO drone at ${homeLat}, ${homeLng} → ${server}. Ctrl+C to stop.`);
let last = Date.now();
setInterval(() => { const now = Date.now(); step((now - last) / 1000); last = now; }, 200);
setInterval(() => void sync(), 1000);
void sync();
