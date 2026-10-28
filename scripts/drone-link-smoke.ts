/**
 * End-to-end drone link check: registers a drone, plays a bridge over HTTPS, dispatches a return and flies the
 * full mission through acks. Never touches hardware. Usage: tsx scripts/drone-link-smoke.ts [baseUrl]
 */
import { formatAck, formatTelemetry, parseCommandBody, signLine, verifyLine, type DroneState } from '../lib/drone-protocol';
import { snapshot, type ReturnRecord } from '../lib/simulation';

const base = process.argv[2] || 'http://127.0.0.1:5173';
let cookie = '';
type Live = ReturnRecord & { live: NonNullable<ReturnRecord['live']> };
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', origin: base, cookie, ...init.headers } });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  const body = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${body.error}`);
  return body;
}
const home: [number, number] = [-122.2595, 37.8719], pickup: [number, number] = [-122.2590, 37.8722], drop: [number, number] = [-122.2585, 37.8716];
const { drone, key: firstKey } = await api<{ drone: { id: string }; key: string }>('/api/fleet', { method: 'POST', body: JSON.stringify({ name: 'Smoke test drone', transport: 'https', home, pickupPad: pickup, dropPad: drop, radius: 300, maxAlt: 60, cruiseAlt: 20 }) });
console.log('registered', drone.id);
let key = firstKey, seq = Date.now(), pos = { lat: home[1], lon: home[0], alt: 0 }, state: DroneState = 'LANDED', battery = 90;
const acks: string[] = [];
async function link() {
  const ts = Math.floor(Date.now() / 1000);
  const lines = [await signLine(key, formatTelemetry({ droneId: drone.id, seq: ++seq, ts, ...pos, battery, heading: 0, speed: state === 'ENROUTE' ? 8 : 0, fix: 3, sats: 12, state, mode: 'GUIDED' })), ...acks.splice(0)];
  const res = await fetch(base + '/api/drone/link', { method: 'POST', body: lines.join('\n') });
  if (!res.ok) throw new Error(`link → ${res.status}`);
  const commands = [];
  for (const line of (await res.text()).split('\n').filter(Boolean)) { const body = await verifyLine(key, line); if (!body) throw new Error('server sent an unsigned command'); commands.push(parseCommandBody(body)!); }
  return commands;
}
const ack = async (cmdSeq: number, status: 'ACCEPTED' | 'DONE') => acks.push(await signLine(key, formatAck({ droneId: drone.id, seq: ++seq, ts: Math.floor(Date.now() / 1000), cmdSeq, status })));
const done = new Set<number>();
const fleet = (body: object) => api(`/api/fleet/${drone.id}`, { method: 'PATCH', body: JSON.stringify(body) });
const refused = (body: object, pattern: RegExp, what: string) => fleet(body).then(() => { throw new Error(`${what} should be refused`); }, e => { if (!pattern.test(e.message)) throw e; });
const current = async (id: string) => (await api<{ record: Live; now: number }>(`/api/returns/${id}`));
async function fly(until: string, returnId: string) {
  for (let i = 0; i < 40; i++) {
    for (const c of await link()) {
      if (done.has(c.seq)) continue; done.add(c.seq);
      await ack(c.seq, 'ACCEPTED');
      if (c.type === 'TAKEOFF') { pos.alt = c.args[0]; state = 'HOLD'; }
      if (c.type === 'GOTO') { pos = { lat: c.args[0], lon: c.args[1], alt: c.args[2] }; state = 'HOLD'; }
      if (c.type === 'LAND' || c.type === 'RTL') { pos.alt = 0; state = 'LANDED'; if (c.type === 'RTL') pos = { lat: home[1], lon: home[0], alt: 0 }; }
      await ack(c.seq, 'DONE'); console.log('  flew', c.type, c.args.join(' '));
    }
    await link();
    const { record } = await api<{ record: Live }>(`/api/returns/${returnId}`);
    if (record.live.phase === until) return record;
  }
  throw new Error(`mission did not reach ${until}`);
}
try {
  await link();
  const { record } = await api<{ record: Live }>('/api/returns', { method: 'POST', body: JSON.stringify({ retailer: 'Amazon', method: 'qr', weight: 1.2, dimensions: [28, 20, 12], fragile: false, address: '1820 Delaware Street, Berkeley', pickup: [-122.2764, 37.8738], instructions: 'Smoke test', service: 'standard' }) });
  await api(`/api/fleet/${drone.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'dispatch', returnId: record.id }) }).then(() => { throw new Error('dispatch should require arming'); }, e => { if (!/checklist/.test(e.message)) throw e; });
  await refused({ action: 'config', pinRadius: 150 }, /pin landing zone must be 0–100 m/, 'a 150 m pin zone');
  await api(`/api/fleet/${drone.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'arm', checklist: { pilot: true, airspace: true, pads: true, failsafe: true } }) });
  // A low-battery report right after a good one is stored at once, so dispatch refuses it (not up to 5 s later).
  battery = 20; await link();
  await refused({ action: 'dispatch', returnId: record.id }, /Battery must be at least 40%/, 'dispatch on 20% battery');
  battery = 90; await link();
  await refused({ action: 'dispatch', returnId: record.id, pickup: { source: 'pin', point: [-122.2764, 37.8738] } }, /The pickup changed/, 'a dispatch for a pin outside the pin zone');
  await api(`/api/fleet/${drone.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'dispatch', returnId: record.id }) });
  console.log('dispatched', record.id, '(old client body, pickup pad)');
  await fly('AWAITING_LOAD', record.id); console.log('landed at pickup');
  await api(`/api/fleet/${drone.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'launch' }) }).then(() => { throw new Error('launch should wait for loading'); }, e => { if (!/confirms loading/.test(e.message)) throw e; });
  await api(`/api/returns/${record.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'load' }) });
  await api(`/api/fleet/${drone.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'launch' }) });
  await fly('AWAITING_UNLOAD', record.id); console.log('landed at drop pad');
  await api(`/api/fleet/${drone.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'unload' }) });
  // The handoff is final: a HOLD on the empty drone's way home pauses the drone, not the delivered return.
  await fleet({ action: 'command', type: 'HOLD' });
  const held = await current(record.id);
  if (held.record.live.fault !== 'OPERATOR_HOLD' || snapshot(held.record, held.now).state !== 'COMPLETED' || held.record.events.some(e => e.state === 'FAILED')) throw new Error(`a HOLD after the unload changed the delivered return: ${snapshot(held.record, held.now).state}`);
  await fleet({ action: 'retry' });
  const final = await fly('COMPLETE', record.id);
  console.log('events:', final.events.map(e => e.state).join(' → '));
  if (final.events.filter(e => e.state === 'COMPLETED').length !== 1) throw new Error('the handoff was recorded more than once');
  const ended = await current(record.id), last = snapshot(ended.record, ended.now);
  if (last.battery !== 90 || !ended.record.live.finalTelemetry) throw new Error(`a finished flight shows ${last.battery}% instead of its last report`);
  // Rotating the key retires commands signed with the old one: the next answer holds only lines the new key verifies.
  await fleet({ action: 'command', type: 'PING' });
  key = (await api<{ key: string }>(`/api/fleet/${drone.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'rotate-key' }) })).key;
  const after = await link();
  console.log('after key rotation the link served', after.length, 'command(s), all verified with the new key');
  const replay = await fetch(base + '/api/drone/link', { method: 'POST', body: 'AT1 ' + drone.id + ' 1 1 37.8 -122.2 0.0 90 0 0.0 3 12 LANDED X ~0000000000000000' });
  if (replay.status !== 401) throw new Error('forged telemetry was accepted');
  console.log('PASS drone link smoke');
} finally {
  await api(`/api/fleet/${drone.id}`, { method: 'DELETE' }).catch(e => console.error('cleanup:', e.message));
}
