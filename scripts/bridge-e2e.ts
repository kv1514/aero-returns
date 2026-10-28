/**
 * Full missions through the real Python bridge with its fake vehicle: registers a drone, starts
 * bridge/aero_bridge.py, dispatches a return and walks every operator/customer step. No hardware.
 * Pass 1 picks up at the pickup pad. Pass 2 turns on a 60 m pin zone and books a pin inside it: the
 * drone flies to the pin, hovers there with no LAND sent until the operator's `land`, then finishes.
 * Usage: tsx scripts/bridge-e2e.ts [baseUrl]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:5173';
type Live = { id: string; live: { phase: string; fault: string | null; pickupSource?: string; pickupPad: [number, number] }; events: { state: string }[] };
type Command = { seq: number; type: string; status: string; phase: string | null };
let cookie = '';
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', origin: base, cookie, ...init.headers } });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  const body = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${body.error}`);
  return body;
}
const patch = (path: string, body: object) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
const home: [number, number] = [-122.2595, 37.8719], pickup: [number, number] = [-122.2589, 37.8722], drop: [number, number] = [-122.2590, 37.8714];
const { drone, key } = await api<{ drone: { id: string }; key: string }>('/api/fleet', { method: 'POST', body: JSON.stringify({ name: 'Bridge e2e drone', transport: 'https', home, pickupPad: pickup, dropPad: drop, radius: 250, maxAlt: 40, cruiseAlt: 15 }) });
const stateDir = mkdtempSync(join(tmpdir(), 'aero-bridge-e2e-'));
const bridge = spawn('python3', ['-I', 'bridge/aero_bridge.py', '--transport', 'https', '--server', base, '--vehicle', 'fake', '--fence-center', `${home[1]},${home[0]}`, '--fence-radius', '250', '--max-alt', '40', '--cruise-alt', '15', '--state-file', join(stateDir, 'state.json')], { env: { ...process.env, AERO_DRONE_ID: drone.id, AERO_DRONE_KEY: key }, stdio: ['ignore', 'inherit', 'pipe'] });
// The bridge logs every command it runs, with its GOTO target, to stderr: keep a copy to check where it flew.
let bridgeLog = '';
bridge.stderr.on('data', (chunk: Buffer) => { bridgeLog += chunk; process.stderr.write(chunk); });
console.log('registered', drone.id, '· bridge pid', bridge.pid);
async function until(returnId: string, phase: string, seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    const { record } = await api<{ record: Live }>(`/api/returns/${returnId}`);
    if (record.live.fault) throw new Error(`mission paused: ${record.live.fault}`);
    if (record.live.phase === phase) return record;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`mission did not reach ${phase}`);
}
const book = (pickup: [number, number], address: string) => api<{ record: Live }>('/api/returns', { method: 'POST', body: JSON.stringify({ retailer: 'Amazon', method: 'qr', weight: 1.2, dimensions: [28, 20, 12], fragile: false, address, pickup, instructions: 'Bridge e2e', service: 'standard' }) });
const arm = () => patch(`/api/fleet/${drone.id}`, { action: 'arm', checklist: { pilot: true, airspace: true, pads: true, failsafe: true } });
const commandLog = async () => (await api<{ commands: Command[] }>(`/api/fleet/${drone.id}`)).commands;
/** From the drone on the pickup's ground to the end of the mission. */
async function finish(returnId: string) {
  await patch(`/api/returns/${returnId}`, { action: 'load' });
  await patch(`/api/fleet/${drone.id}`, { action: 'launch' });
  await until(returnId, 'AWAITING_UNLOAD'); console.log('landed at drop pad');
  await patch(`/api/fleet/${drone.id}`, { action: 'unload' });
  const final = await until(returnId, 'COMPLETE');
  console.log('commands:', (await commandLog()).reverse().map(c => `${c.type}:${c.status}`).join(' '));
  console.log('events:', final.events.map(e => e.state).join(' → '));
}
try {
  for (let i = 0; i < 20; i++) { const { drone: d } = await api<{ drone: { stale: boolean; telemetry: unknown } }>(`/api/fleet/${drone.id}`); if (d.telemetry && !d.stale) break; await new Promise(r => setTimeout(r, 1000)); }
  // Pass 1: pins are off (the default), so the pickup pad is used. An old client body (no pickup field) may dispatch it.
  const { record } = await book([-122.2764, 37.8738], '1820 Delaware Street, Berkeley');
  await arm();
  await patch(`/api/fleet/${drone.id}`, { action: 'dispatch', returnId: record.id });
  console.log('pass 1 dispatched', record.id, 'to the pickup pad');
  await until(record.id, 'AWAITING_LOAD'); console.log('landed at pickup pad');
  await finish(record.id);
  console.log('PASS bridge e2e: pickup pad');

  // Pass 2: a 60 m pin zone around the pickup pad, and a pin about 30 m from it.
  const pin: [number, number] = [-122.258900, 37.872470];
  await patch(`/api/fleet/${drone.id}`, { action: 'config', pinRadius: 60 });
  await arm(); // changing the config disarmed the drone
  const { record: pinned } = await book(pin, '2400 Durant Avenue, Berkeley');
  await patch(`/api/fleet/${drone.id}`, { action: 'dispatch', returnId: pinned.id, pickup: { source: 'pin', point: pin } });
  console.log('pass 2 dispatched', pinned.id, 'to the customer pin');
  const hovering = await until(pinned.id, 'HOVER_PICKUP');
  if (hovering.live.pickupSource !== 'pin' || hovering.live.pickupPad[0] !== pin[0] || hovering.live.pickupPad[1] !== pin[1]) throw new Error(`mission is not flying to the pin: ${JSON.stringify(hovering.live)}`);
  const goto = `GOTO ${pin[1].toFixed(6)},${pin[0].toFixed(6)} 15.0 m`;
  if (!bridgeLog.includes(goto)) throw new Error(`the bridge never ran ${goto}`);
  console.log('bridge flew', goto, '· hovering over the pin');
  await new Promise(r => setTimeout(r, 6000));
  const waiting = await until(pinned.id, 'HOVER_PICKUP', 1), [latest] = await commandLog();
  if (latest.type !== 'GOTO' || latest.phase !== 'TO_PICKUP' || latest.status !== 'done') throw new Error(`a command was sent while hovering: ${JSON.stringify(latest)}`);
  const { drone: overhead } = await api<{ drone: { telemetry: { lat: number; lon: number; alt: number; state: string } } }>(`/api/fleet/${drone.id}`);
  const offset = Math.hypot((overhead.telemetry.lat - pin[1]) * 111_320, (overhead.telemetry.lon - pin[0]) * 111_320 * Math.cos(pin[1] * Math.PI / 180));
  if (offset > 3 || overhead.telemetry.alt < 10) throw new Error(`the drone is not holding over the pin: ${JSON.stringify(overhead.telemetry)}`);
  console.log(`still in ${waiting.live.phase} after 6 s, no LAND sent, ${offset.toFixed(1)} m from the pin at ${overhead.telemetry.alt.toFixed(1)} m`);
  await patch(`/api/fleet/${drone.id}`, { action: 'land' });
  await until(pinned.id, 'AWAITING_LOAD'); console.log('operator confirmed the landing area; landed at the pin');
  await finish(pinned.id);
  console.log('PASS bridge e2e: customer pin with the hover gate');
} finally {
  bridge.kill('SIGINT');
  await new Promise(r => setTimeout(r, 1500));
  await api(`/api/fleet/${drone.id}`, { method: 'DELETE' }).catch(e => console.error('cleanup:', e.message));
  rmSync(stateDir, { recursive: true, force: true });
}
