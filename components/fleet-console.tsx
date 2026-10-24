'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Battery, Check, Copy, Crosshair, Gauge, Home, KeyRound, LocateFixed, MapPin, Navigation, OctagonX, Package, Pause, Plane, PlaneLanding, Plus, Radio, RotateCcw, Satellite, ShieldCheck, Signal, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import FleetMap from './fleet-map';
import Modal from './modal';
import { useAccessibility } from './accessibility';
import type { DroneConfig } from '@/lib/drone-mission';
import { snapshot, type LiveTelemetry, type MissionPhase, type Point, type ReturnRecord } from '@/lib/simulation';

type Drone = { id: string; name: string; transport: 'https' | 'sms'; phone: string | null; phoneVerified: boolean; config: DroneConfig; armed: boolean; armedUntil: number; activeReturn: string | null; lastSeen: number; stale: boolean; telemetry: LiveTelemetry | null; createdAt: number };
type Setup = { link: boolean; sms: boolean; linkUrl: string; smsWebhook: string };
type Command = { seq: number; type: string; status: string; reason: string | null; phase: string | null; created_at: number; updated_at: number };
type Detail = { setup: Setup; drone: Drone; key?: string; trail: LiveTelemetry[]; commands: Command[]; mission: ReturnRecord | null; now: number };
type PadKey = 'home' | 'pickupPad' | 'dropPad';
const PHASE: Record<MissionPhase, string> = { TAKEOFF_OUT: 'Taking off', TO_PICKUP: 'Flying to pickup', LAND_PICKUP: 'Landing at pickup', AWAITING_LOAD: 'Waiting for the customer to load', READY_TO_LAUNCH: 'Loaded · ready to launch', TAKEOFF_LOADED: 'Taking off with package', TO_DROP: 'Flying to drop pad', LAND_DROP: 'Landing at drop pad', AWAITING_UNLOAD: 'Landed · confirm unload', TAKEOFF_HOME: 'Taking off for home', RETURNING: 'Flying home', LAND_HOME: 'Landing at home', COMPLETE: 'Complete', ABORTED: 'Ended by operator' };
const CHECKS = [['pilot', 'A pilot with RC override is ready and watching the drone.'], ['airspace', 'The area is clear and the flight is authorized (Part 107/TRUST, LAANC if needed).'], ['pads', 'Home, pads and geofence on the map match the real site.'], ['failsafe', 'Autopilot failsafes are set: RTL on link loss, geofence, low battery.']] as const;
const ago = (ts: number, now: number) => !ts ? 'never' : now - ts < 2000 ? 'just now' : now - ts < 120_000 ? `${Math.round((now - ts) / 1000)}s ago` : `${Math.round((now - ts) / 60_000)} min ago`;
const fmtPoint = (p: Point | null) => (p ? `${p[1].toFixed(6)}, ${p[0].toFixed(6)}` : 'Not set');
async function api<T>(path: string, init?: RequestInit) {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function bridgeCommand(d: Drone, origin: string, key = '<key from registration>') {
  const [lng, lat] = d.config.home, transport = d.transport === 'sms' ? '--transport sms --modem /dev/ttyUSB0 --sms-to <Twilio number>' : `--transport https --server ${origin}`;
  return `export AERO_DRONE_ID=${d.id}\nexport AERO_DRONE_KEY=${key}\n\n# Test first with the built-in simulator (no drone):\npython3 bridge/aero_bridge.py ${transport} --vehicle fake --fake-home ${lat.toFixed(6)},${lng.toFixed(6)}\n\n# PX4 / ArduPilot (SITL or real flight controller):\npython3 bridge/aero_bridge.py ${transport} --vehicle mavlink --connect udpin:0.0.0.0:14550 \\\n  --fence-center ${lat.toFixed(6)},${lng.toFixed(6)} --fence-radius ${d.config.radius} --max-alt ${d.config.maxAlt} --cruise-alt ${d.config.cruiseAlt} --live`;
}

export default function FleetConsole() {
  useAccessibility();
  const [list, setList] = useState<{ setup: Setup; drones: Drone[] } | null>(null), [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [returns, setReturns] = useState<ReturnRecord[]>([]), [returnId, setReturnId] = useState(''), [registering, setRegistering] = useState(false), [secret, setSecret] = useState<{ drone: Drone; key: string } | null>(null);
  const [placing, setPlacing] = useState<PadKey | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null), [checks, setChecks] = useState<Record<string, boolean>>({}), [confirmDelete, setConfirmDelete] = useState(false);
  const say = (tone: 'error' | 'ok', text: string) => setNotice({ tone, text });
  const [failures, setFailures] = useState(0), offline = failures >= 3;
  const applyList = useCallback((data: { setup: Setup; drones: Drone[] }) => { setList(data); setSelected(s => s && data.drones.some(d => d.id === s) ? s : data.drones[0]?.id ?? null); }, []);
  const loadList = useCallback(() => api<{ setup: Setup; drones: Drone[] }>('/api/fleet').then(applyList), [applyList]);
  useEffect(() => {
    const tick = () => api<{ setup: Setup; drones: Drone[] }>('/api/fleet').then(applyList);
    tick().catch(e => say('error', e.message));
    const t = setInterval(() => tick().catch(() => {}), 5000); return () => clearInterval(t);
  }, [applyList]);
  function choose(id: string) { setSelected(id); setChecks({}); setPlacing(null); setNotice(null); }
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const loadDetail = () => api<Detail>(`/api/fleet/${selected}`).then(data => { if (active) { setDetail(data); setFailures(0); } }, error => { if (active) setFailures(f => f + 1); throw error; });
    const loadReturns = () => api<{ returns: ReturnRecord[] }>('/api/returns').then(d => { if (active) setReturns(d.returns); }).catch(() => {});
    loadDetail().catch(e => say('error', e.message)); void loadReturns();
    const fast = setInterval(() => loadDetail().catch(() => {}), 1500), slow = setInterval(loadReturns, 6000);
    return () => { active = false; clearInterval(fast); clearInterval(slow); };
  }, [selected]);
  async function patch(body: object, success?: string) {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const data = await api<Detail>(`/api/fleet/${selected}`, { method: 'PATCH', body: JSON.stringify(body) }); setDetail(data); if (data.key) setSecret({ drone: data.drone, key: data.key }); if (success) say('ok', success); void loadList();
      // The checklist is confirmed fresh for every arming, and against the current pads and limits.
      if (['arm', 'disarm', 'config', 'pad-from-drone'].includes((body as { action: string }).action)) setChecks({});
    }
    catch (e) { say('error', (e as Error).message); }
    finally { setBusy(false); }
  }
  /** ABORT never waits for another console request and is never disabled. */
  async function abort() {
    if (!selected) return;
    try { const data = await api<Detail>(`/api/fleet/${selected}`, { method: 'PATCH', body: JSON.stringify({ action: 'abort' }) }); setDetail(data); say('ok', 'ABORT sent. The drone returns home.'); }
    catch (e) { say('error', `ABORT did not reach AERO: ${(e as Error).message} Use your RC transmitter.`); }
  }
  async function remove() {
    if (!selected) return; setBusy(true);
    try { await api(`/api/fleet/${selected}`, { method: 'DELETE' }); setSelected(null); setConfirmDelete(false); await loadList(); say('ok', 'Drone removed.'); } catch (e) { say('error', (e as Error).message); } finally { setBusy(false); }
  }
  const current = detail?.drone.id === selected ? detail : null, d = current?.drone, t = d?.telemetry ?? null, now = current?.now ?? 0, mission = current?.mission?.live ? current.mission : null, phase = mission?.live?.phase;
  const eligible = returns.filter(r => !r.live && !r.loaded && !r.cancelled && !['COMPLETED', 'CANCELLED'].includes(snapshot(r, now).state));
  const linkState = !d ? '' : offline ? 'stale' : !d.lastSeen ? 'waiting' : d.stale ? 'stale' : 'live';
  return <main className="fleet">
    <header className="fleet-top">
      <Link href="/" className="fleet-back"><ArrowLeft size={18} />Customer app</Link>
      <h1><Radio size={20} />AERO Fleet</h1>
      <div className="fleet-setup">
        <span className={list?.setup.link ? 'ok' : 'warn'}><i />{list?.setup.link ? 'Drone link ready' : 'Drone link not configured'}</span>
        <span className={list?.setup.sms ? 'ok' : ''}><i />{list?.setup.sms ? 'SMS ready' : 'SMS off'}</span>
      </div>
    </header>
    <div className="fleet-body">
      <aside className="fleet-list">
        <div className="fleet-list-head"><h2>Your drones</h2><button className="ux-pill small" onClick={() => setRegistering(true)}><Plus size={16} />Add</button></div>
        {list?.drones.map(x => <button key={x.id} className={`fleet-drone ${x.id === selected ? 'selected' : ''}`} onClick={() => choose(x.id)}>
          <span className={`fleet-dot ${!x.lastSeen ? '' : x.stale ? 'stale' : 'live'}`} />
          <span><strong>{x.name}</strong><small>{x.id} · {x.transport === 'sms' ? 'SMS' : '4G data'} · {x.activeReturn ? 'On a mission' : x.armed ? 'Armed' : 'Disarmed'}</small></span>
          {x.telemetry && <span className="fleet-batt"><Battery size={14} />{x.telemetry.battery < 0 ? '—' : `${Math.round(x.telemetry.battery)}%`}</span>}
        </button>)}
        {list && !list.drones.length && <div className="fleet-empty"><Plane size={28} /><p>No drones yet. Register your PX4 or ArduPilot drone to fly real returns.</p><button className="ux-primary" onClick={() => setRegistering(true)}><Plus size={18} />Register a drone</button></div>}
        <p className="fleet-note"><ShieldCheck size={14} />Simulated returns keep working without a drone. Live flights need a pilot in command with RC override.</p>
      </aside>
      {d ? <section className="fleet-main">
        <div className="fleet-headline">
          <div><h2>{d.name}</h2><p>{d.id} · {d.transport === 'sms' ? `SMS via ${d.phone}${d.phoneVerified ? '' : ' (waiting for its first signed text)'}` : '4G data link'} · registered {new Date(d.createdAt).toLocaleDateString()}</p></div>
          <span className={`fleet-link ${linkState}`}><Signal size={15} />{offline ? 'Console offline · retrying' : linkState === 'waiting' ? 'Waiting for bridge' : linkState === 'stale' ? `Signal lost · ${ago(d.lastSeen, now)}` : `Connected · ${ago(d.lastSeen, now)}`}</span>
        </div>
        {offline && <div className="fleet-notice error" role="alert"><Signal size={16} /><span>Lost contact with AERO. Showing the last data received while the console retries. Your RC transmitter always overrides.</span></div>}
        {notice && <div className={`fleet-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'error' ? <TriangleAlert size={16} /> : <Check size={16} />}<span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}
        <div className="fleet-grid">
          <div className="fleet-card map-card">
            <FleetMap config={d.config} telemetry={t} trail={current?.trail ?? []} placing={placing} onPlace={p => { const pad = placing!; setPlacing(null); void patch({ action: 'config', [pad]: p }, 'Pad updated. Re-arm with the checklist.'); }} />
            <div className="fleet-place">{placing ? <><span>Click the map to place the {placing === 'home' ? 'home point' : placing === 'pickupPad' ? 'pickup pad' : 'drop pad'}.</span><button onClick={() => setPlacing(null)}>Cancel</button></> : <>{(['home', 'pickupPad', 'dropPad'] as PadKey[]).map(k => <button key={k} disabled={!!mission || busy} onClick={() => setPlacing(k)}>{k === 'home' ? <Home size={14} /> : <MapPin size={14} />}{k === 'home' ? 'Home' : k === 'pickupPad' ? 'Pickup' : 'Drop'}</button>)}</>}</div>
          </div>
          <div className="fleet-card telemetry">
            <h3>Telemetry</h3>
            <div className="fleet-tiles">
              <div><span><Navigation size={14} />State</span><strong>{t?.state ?? '—'}</strong><small>{t?.mode ?? 'No data'}</small></div>
              <div><span><Gauge size={14} />Altitude</span><strong>{t ? t.alt.toFixed(1) : '—'}<small> m</small></strong><small>{t ? `${t.speed.toFixed(1)} m/s` : ''}</small></div>
              <div><span><Battery size={14} />Battery</span><strong>{t && t.battery >= 0 ? `${Math.round(t.battery)}%` : '—'}</strong><small>Floor 40% to dispatch</small></div>
              <div><span><Satellite size={14} />GPS</span><strong>{t ? (t.fix >= 3 ? '3D fix' : `Fix ${t.fix}`) : '—'}</strong><small>{t ? `${t.sats} satellites` : ''}</small></div>
            </div>
            <dl className="fleet-pads"><div><dt>Home</dt><dd>{fmtPoint(d.config.home)}</dd></div><div><dt>Pickup pad</dt><dd>{fmtPoint(d.config.pickupPad)}</dd></div><div><dt>Drop pad</dt><dd>{fmtPoint(d.config.dropPad)}</dd></div><div><dt>Limits</dt><dd>{d.config.radius} m fence · {d.config.maxAlt} m max · {d.config.cruiseAlt} m cruise</dd></div></dl>
            <div className="fleet-row-buttons">{(['home', 'pickupPad', 'dropPad'] as PadKey[]).map(k => <button key={k} disabled={!t || d.stale || !!mission || busy} onClick={() => void patch({ action: 'pad-from-drone', pad: k }, 'Pad set from the drone’s position.')}><LocateFixed size={14} />{k === 'home' ? 'Home' : k === 'pickupPad' ? 'Pickup' : 'Drop'} = drone</button>)}</div>
          </div>
          <div className="fleet-card mission">
            <h3>Mission</h3>
            {mission ? <>
              <div className="fleet-phase"><span className={mission.live!.fault ? 'warn' : ''}>{mission.live!.fault ? `Paused · ${mission.live!.fault.replace(/_/g, ' ').toLowerCase()}` : PHASE[phase!]}</span><small>{mission.package.retailer} return · {mission.package.address.split(',')[0]}</small></div>
              <div className="fleet-mission-buttons">
                {phase === 'READY_TO_LAUNCH' && <button className="ux-primary" disabled={busy} onClick={() => void patch({ action: 'launch' }, 'Launch sent.')}><Plane size={18} />Area clear · launch</button>}
                {phase === 'AWAITING_UNLOAD' && <button className="ux-primary" disabled={busy} onClick={() => void patch({ action: 'unload' }, 'Unload confirmed. Drone heading home.')}><Package size={18} />Unloaded · send home</button>}
                {mission.live!.fault && <button className="ux-primary" disabled={busy} onClick={() => void patch({ action: 'retry' }, 'Step re-sent.')}><RotateCcw size={18} />Retry this step</button>}
                {phase === 'AWAITING_LOAD' && <p className="fleet-hint">The customer confirms loading in their app. You launch after that.</p>}
              </div>
            </> : <>
              <p className="fleet-hint">Fly one of your active returns with this drone. The drone goes home → pickup pad → drop pad → home.</p>
              <select value={returnId} onChange={e => setReturnId(e.target.value)} aria-label="Return to dispatch"><option value="">Choose a return…</option>{eligible.map(r => <option key={r.id} value={r.id}>{r.package.retailer} · {r.package.address.split(',')[0]} · AR-{r.id.slice(0, 8).toUpperCase()}</option>)}</select>
              <button className="ux-primary" disabled={!returnId || busy} onClick={() => void patch({ action: 'dispatch', returnId }, 'Dispatched. Takeoff command sent.')}><Plane size={18} />Dispatch live flight</button>
              {!eligible.length && <p className="fleet-hint">No unloaded active returns. <Link href="/">Book one in the customer app</Link>.</p>}
            </>}
          </div>
          <div className="fleet-card safety">
            <h3>Pre-flight checklist</h3>
            {d.armed ? <div className="fleet-armed"><ShieldCheck size={18} /><span>Armed for live missions until {new Date(d.armedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><button disabled={busy} onClick={() => void patch({ action: 'disarm' }, 'Disarmed.')}>Disarm</button></div> : <>
              {CHECKS.map(([k, text]) => <label key={k} className="fleet-check"><input type="checkbox" checked={!!checks[k]} onChange={e => setChecks({ ...checks, [k]: e.target.checked })} /><span>{text}</span></label>)}
              <button className="ux-secondary" disabled={busy || CHECKS.some(([k]) => !checks[k])} onClick={() => void patch({ action: 'arm', checklist: checks }, 'Armed for 30 minutes.')}><ShieldCheck size={18} />Arm for 30 minutes</button>
            </>}
          </div>
          <div className="fleet-card controls">
            <h3>Manual commands</h3>
            <div className="fleet-command-grid">
              <button disabled={busy} onClick={() => void patch({ action: 'command', type: 'PING' }, 'Ping sent.')}><Radio size={16} />Ping</button>
              <button disabled={busy} onClick={() => void patch({ action: 'command', type: 'HOLD' }, 'Hold sent.')}><Pause size={16} />Hold</button>
              <button disabled={busy} onClick={() => void patch({ action: 'command', type: 'LAND' }, 'Land sent.')}><PlaneLanding size={16} />Land</button>
              <button disabled={busy} onClick={() => void patch({ action: 'command', type: 'RTL' }, 'Return-to-launch sent.')}><Undo2 size={16} />Return home</button>
            </div>
            <button className="fleet-abort" onClick={() => void abort()}><OctagonX size={20} />ABORT</button>
            <p className="fleet-hint">Commands reach the bridge within a second over 4G, or by text over SMS. Your RC transmitter always overrides.</p>
          </div>
          <div className="fleet-card log">
            <h3>Command log</h3>
            <table><thead><tr><th>#</th><th>Command</th><th>Status</th><th>Step</th><th>Updated</th></tr></thead><tbody>{current?.commands.map(c => <tr key={c.seq}><td>{c.seq}</td><td>{c.type}</td><td><span className={`fleet-status ${c.status}`}>{c.status}{c.reason ? ` · ${c.reason}` : ''}</span></td><td>{c.phase ? PHASE[c.phase as MissionPhase] : '—'}</td><td>{ago(c.updated_at, now)}</td></tr>)}</tbody></table>
            {!current?.commands.length && <p className="fleet-hint">No commands yet.</p>}
          </div>
          <div className="fleet-card bridge">
            <h3>Connect the bridge</h3>
            <p className="fleet-hint">Run on the drone’s companion computer (or a laptop wired to the flight controller). See <code>bridge/README.md</code>.</p>
            <pre>{bridgeCommand(d, typeof location === 'undefined' ? '' : location.origin)}</pre>
            {d.transport === 'sms' && <p className="fleet-hint">Twilio webhook: <code>{current?.setup.smsWebhook}</code></p>}
            <div className="fleet-row-buttons"><button disabled={busy || !!mission} onClick={() => void patch({ action: 'rotate-key' }, 'New key issued. The old key stops working.')}><KeyRound size={14} />Rotate key</button><button className="danger" disabled={busy || !!mission} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />Remove drone</button></div>
          </div>
        </div>
      </section> : <section className="fleet-main fleet-placeholder">{list?.drones.length ? <p>Loading drone…</p> : <><Crosshair size={36} /><h2>Connect a real drone</h2><p>AERO talks to PX4 and ArduPilot through a small bridge over 4G data or SMS. Every command is signed, geofenced and acknowledged.</p></>}</section>}
    </div>
    {registering && <Modal title="Register a drone" onClose={() => setRegistering(false)}><RegisterForm onDone={async (drone, key) => { setRegistering(false); setSecret({ drone, key }); await loadList(); choose(drone.id); }} /></Modal>}
    {secret && <Modal title="Save the drone key" onClose={() => setSecret(null)}><div className="fleet-secret"><p>This key signs every message between AERO and <strong>{secret.drone.name}</strong>. It’s shown once. Store it on the bridge, not in source control.</p><div className="fleet-key"><code>{secret.key}</code><button onClick={() => void navigator.clipboard.writeText(secret.key).then(() => say('ok', 'Key copied.'))}><Copy size={15} />Copy</button></div><pre>{bridgeCommand(secret.drone, location.origin, secret.key)}</pre><button className="ux-primary" onClick={() => setSecret(null)}>I saved it</button></div></Modal>}
    {confirmDelete && d && <Modal title={`Remove ${d.name}?`} onClose={() => setConfirmDelete(false)}><div className="fleet-secret"><p>This deletes the drone, its telemetry and its command log. The bridge stops being accepted.</p><div className="fleet-row-buttons"><button onClick={() => setConfirmDelete(false)}>Keep it</button><button className="danger" disabled={busy} onClick={() => void remove()}><Trash2 size={14} />Remove</button></div></div></Modal>}
  </main>;
}

function RegisterForm({ onDone }: { onDone: (drone: Drone, key: string) => void }) {
  const [form, setForm] = useState({ name: '', transport: 'https', phone: '', lat: '', lng: '', radius: '300', maxAlt: '60', cruiseAlt: '30' }), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  function locate() { navigator.geolocation?.getCurrentPosition(p => setForm(f => ({ ...f, lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) })), () => setError('Location unavailable. Type the home coordinates instead.'), { enableHighAccuracy: true, timeout: 10000 }); }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const body = { name: form.name, transport: form.transport, ...(form.transport === 'sms' ? { phone: form.phone.trim() } : {}), home: [Number(form.lng), Number(form.lat)], radius: Number(form.radius), maxAlt: Number(form.maxAlt), cruiseAlt: Number(form.cruiseAlt) };
      const data = await api<{ drone: Drone; key: string }>('/api/fleet', { method: 'POST', body: JSON.stringify(body) });
      onDone(data.drone, data.key);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <form className="fleet-form" onSubmit={submit}>
    <label>Name<input required maxLength={40} value={form.name} onChange={set('name')} placeholder="X500 return drone" /></label>
    <fieldset><legend>Link</legend><label className="fleet-radio"><input type="radio" name="transport" checked={form.transport === 'https'} onChange={() => setForm({ ...form, transport: 'https' })} />4G data (HTTPS)</label><label className="fleet-radio"><input type="radio" name="transport" checked={form.transport === 'sms'} onChange={() => setForm({ ...form, transport: 'sms' })} />SMS only</label></fieldset>
    {form.transport === 'sms' && <label>Drone SIM phone number<input required value={form.phone} onChange={set('phone')} placeholder="+15105550123" inputMode="tel" /></label>}
    <div className="fleet-form-row"><label>Home latitude<input required inputMode="decimal" value={form.lat} onChange={set('lat')} placeholder="37.8719" /></label><label>Home longitude<input required inputMode="decimal" value={form.lng} onChange={set('lng')} placeholder="-122.2595" /></label></div>
    <button type="button" className="ux-secondary" onClick={locate}><LocateFixed size={16} />Use my current location</button>
    <div className="fleet-form-row three"><label>Geofence (m)<input required type="number" min={20} max={2000} value={form.radius} onChange={set('radius')} /></label><label>Max alt (m)<input required type="number" min={10} max={120} value={form.maxAlt} onChange={set('maxAlt')} /></label><label>Cruise (m)<input required type="number" min={10} max={120} value={form.cruiseAlt} onChange={set('cruiseAlt')} /></label></div>
    <p className="fleet-hint">Set the pickup and drop pads on the map after registering. 120 m (400 ft) is the hard altitude cap.</p>
    {error && <div className="fleet-notice error"><TriangleAlert size={16} /><span>{error}</span></div>}
    <button className="ux-primary" disabled={busy}>{busy ? 'Registering…' : 'Register drone'}</button>
  </form>;
}
