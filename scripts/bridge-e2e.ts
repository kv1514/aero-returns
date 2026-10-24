/**
 * Full mission through the real Python bridge with its fake vehicle: registers a drone, starts
 * bridge/aero_bridge.py, dispatches a return and walks every operator/customer step. No hardware.
 * Usage: tsx scripts/bridge-e2e.ts [baseUrl]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:5173';
type Live = { id: string; live: { phase: string; fault: string | null }; events: { state: string }[] };
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
const bridge = spawn('python3', ['-I', 'bridge/aero_bridge.py', '--transport', 'https', '--server', base, '--vehicle', 'fake', '--fence-center', `${home[1]},${home[0]}`, '--fence-radius', '250', '--max-alt', '40', '--cruise-alt', '15', '--state-file', join(stateDir, 'state.json')], { env: { ...process.env, AERO_DRONE_ID: drone.id, AERO_DRONE_KEY: key }, stdio: ['ignore', 'inherit', 'inherit'] });
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
try {
  for (let i = 0; i < 20; i++) { const { drone: d } = await api<{ drone: { stale: boolean; telemetry: unknown } }>(`/api/fleet/${drone.id}`); if (d.telemetry && !d.stale) break; await new Promise(r => setTimeout(r, 1000)); }
  const { record } = await api<{ record: Live }>('/api/returns', { method: 'POST', body: JSON.stringify({ retailer: 'Amazon', method: 'qr', weight: 1.2, dimensions: [28, 20, 12], fragile: false, address: '1820 Delaware Street, Berkeley', pickup: [-122.2764, 37.8738], instructions: 'Bridge e2e', service: 'standard' }) });
  await patch(`/api/fleet/${drone.id}`, { action: 'arm', checklist: { pilot: true, airspace: true, pads: true, failsafe: true } });
  await patch(`/api/fleet/${drone.id}`, { action: 'dispatch', returnId: record.id });
  console.log('dispatched', record.id);
  await until(record.id, 'AWAITING_LOAD'); console.log('landed at pickup');
  await patch(`/api/returns/${record.id}`, { action: 'load' });
  await patch(`/api/fleet/${drone.id}`, { action: 'launch' });
  await until(record.id, 'AWAITING_UNLOAD'); console.log('landed at drop pad');
  await patch(`/api/fleet/${drone.id}`, { action: 'unload' });
  const final = await until(record.id, 'COMPLETE');
  const { commands } = await api<{ commands: { seq: number; type: string; status: string }[] }>(`/api/fleet/${drone.id}`);
  console.log('commands:', commands.reverse().map(c => `${c.type}:${c.status}`).join(' '));
  console.log('events:', final.events.map(e => e.state).join(' → '));
  console.log('PASS bridge e2e');
} finally {
  bridge.kill('SIGINT');
  await new Promise(r => setTimeout(r, 1500));
  await api(`/api/fleet/${drone.id}`, { method: 'DELETE' }).catch(e => console.error('cleanup:', e.message));
  rmSync(stateDir, { recursive: true, force: true });
}
