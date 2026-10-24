'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
/* eslint-disable @next/next/no-html-link-for-pages -- vinext's <Link> client navigation throws in this app (RSC prefetch setup error), so internal links are plain full page loads. */
import { ArrowLeft, ArrowRight, Battery, Bell, Check, Copy, Crosshair, Gauge, Home, KeyRound, LandPlot, MapPin, MessageSquareText, Mountain, Navigation, Package, PackageCheck, Pause, Plus, Radio, RotateCcw, Satellite, Settings, ShieldCheck, Signal, Trash2, TriangleAlert, UserPlus, Users, Wifi, WifiOff, X } from 'lucide-react';
import DroneMap, { type MapStop } from './drone-map';
import { useAccessibility } from './accessibility';
import { preflight, plannedPath, MIN_BATTERY_PCT, type CommandType, type DroneCommand, type DroneEvent, type DroneView, type FlyRoute, type SmsCommand } from '@/lib/drone-protocol';
import { isActiveJob, JOB_STEPS, JOB_TITLES, jobStep, type DeliveryJob } from '@/lib/drone-jobs';
import { FACILITIES, distance, pathDistance, type Point, type ReturnRecord } from '@/lib/simulation';
import './drone-control.css';

type Tab = 'fly' | 'connect' | 'sms' | 'settings';
type PickTarget = 'A' | 'B' | 'P' | 'D';
const PICK_LABEL: Record<PickTarget, string> = { A: 'point A', B: 'point B', P: 'the pickup', D: 'the drop-off' };
const JOB_GUIDANCE: Record<DeliveryJob['status'], string> = {
  dispatched: 'Sending the drone to the pickup.', en_route_pickup: 'Flying to the pickup spot.', at_pickup: 'The drone has landed. Secure the package on it, then confirm.',
  package_loaded: 'Taking off with the package.', en_route_dropoff: 'Carrying the package to the drop-off.', delivered: 'Package released at the drop-off.',
  returning: 'Package delivered. Heading home.', completed: 'Delivered. All done.', cancelled: 'This delivery was cancelled.', failed: 'The drone stopped this delivery.',
};
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}
const ago = (ts: number | null) => { if (!ts) return 'never'; const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(ts).toLocaleString(); };
const fmtPoint = (p: Point) => `${p[1].toFixed(5)}, ${p[0].toFixed(5)}`;
const STATE_LABEL: Record<string, string> = { idle: 'Ready', arming: 'Arming', taking_off: 'Taking off', en_route: 'Flying to target', holding: 'Hovering', landing: 'Landing', returning: 'Returning home', landed: 'On the ground', error: 'Needs attention' };
const COMMAND_LABEL: Record<CommandType, string> = { FLY_ROUTE: 'Fly route', HOLD: 'Hold position', LAND: 'Land', RTL: 'Return home', PING: 'Ping' };

export default function DroneControl() {
  useAccessibility();
  const [drones, setDrones] = useState<DroneView[]>([]), [selected, setSelected] = useState<string | null>(null), [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>('fly'), [busy, setBusy] = useState(false), [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [token, setToken] = useState<{ id: string; value: string } | null>(null), [smsReady, setSmsReady] = useState(false);
  const [pick, setPick] = useState<PickTarget | null>(null), [a, setA] = useState<Point | null>(null), [b, setB] = useState<Point | null>(null);
  const [mode, setMode] = useState<'deliver' | 'free'>('deliver'), [pickup, setPickup] = useState<Point | null>(null), [dropoff, setDropoff] = useState<Point | null>(null);
  const [returnHome, setReturnHome] = useState(true), [returnId, setReturnId] = useState<string | null>(null);
  const [altM, setAltM] = useState(30), [speedMs, setSpeedMs] = useState(6), [land, setLand] = useState(true), [pilotReady, setPilotReady] = useState(false);
  const [returnPoints, setReturnPoints] = useState<{ id: string; pickup: Point; hub: Point; hubName: string } | null>(null);
  const [sms, setSms] = useState<{ text: string; to: string | null; sent: boolean } | null>(null), [sheet, setSheet] = useState(false), [now, setNow] = useState(0);
  const drone = drones.find(d => d.id === selected) ?? null;
  const notify = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => { setToast({ text, tone }); setTimeout(() => setToast(t => t?.text === text ? null : t), 5000); }, []);
  const upsert = useCallback((d: DroneView) => setDrones(list => list.some(x => x.id === d.id) ? list.map(x => x.id === d.id ? d : x) : [d, ...list]), []);

  useEffect(() => {
    let active = true;
    const loadAll = () => api<{ drones: DroneView[]; sms: boolean }>('/api/drones').then(data => { if (!active) return; setDrones(data.drones); setSmsReady(data.sms); setSelected(s => s && data.drones.some(d => d.id === s) ? s : data.drones[0]?.id ?? null); setLoaded(true); }).catch(e => { if (active) { setLoaded(true); notify(e.message, 'error'); } });
    void loadAll();
    api<{ returns: ReturnRecord[] }>('/api/returns').then(({ returns }) => { const r = returns[0]; const f = r && FACILITIES.find(x => x.id === r.facilityId); if (active && r && f) setReturnPoints({ id: r.id, pickup: r.package.pickup, hub: f.point, hubName: f.name }); }).catch(() => {});
    const list = setInterval(() => { if (!document.hidden) void loadAll(); }, 15000);
    return () => { active = false; clearInterval(list); };
  }, [notify]);
  useEffect(() => {
    if (!selected) return;
    let active = true, inflight = false;
    const poll = async () => { if (inflight || document.hidden) return; inflight = true; try { const { drone } = await api<{ drone: DroneView }>(`/api/drones/${selected}`); if (active) { upsert(drone); setNow(Date.now()); } } catch { /* keep last known state */ } finally { inflight = false; } };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [selected, upsert]);
  const alt = Math.min(altM, drone?.maxAltM ?? altM);
  const route: FlyRoute | null = b ? { waypoints: a ? [a, b] : [b], altM: alt, speedMs, land, release: false } : null;
  const refused = drone && route ? preflight(drone, route, now) : null;
  const length = drone && route ? pathDistance(plannedPath(drone.telemetry, route)) : 0;
  const eta = route ? length / speedMs + alt / 2.5 + (land ? alt / 1.5 : 0) : 0;
  // Delivery: pickup (land, wait for loading) → drop-off (land, release) → home.
  const delivery: FlyRoute | null = pickup && dropoff ? { waypoints: [pickup, dropoff], altM: alt, speedMs, land: true, release: false } : null;
  const deliveryRefused = drone && delivery ? preflight(drone, delivery, now) : null;
  const deliveryLength = drone && delivery ? pathDistance(plannedPath(drone.telemetry, delivery)) : 0;
  const job = drone?.job ?? null, jobLive = !!job && isActiveJob(job);
  const here: Point | null = drone?.telemetry ? [drone.telemetry.lng, drone.telemetry.lat] : null;
  const stop = (key: string, label: string, kind: MapStop['kind'], point: Point | null): MapStop[] => point ? [{ key, label, kind, point }] : [];
  const stops: MapStop[] = jobLive ? [...stop('p', 'P', 'pickup', job.pickup), ...stop('d', 'D', 'dropoff', job.dropoff)]
    : mode === 'deliver' ? [...stop('p', 'P', 'pickup', pickup), ...stop('d', 'D', 'dropoff', dropoff)] : [...stop('a', 'A', 'a', a), ...stop('b', 'B', 'b', b)];
  const ahead: (Point | null | undefined)[] = jobLive
    ? (['delivered', 'returning'].includes(job.status) ? [drone?.home] : job.loaded ? [job.dropoff] : [job.pickup, job.dropoff])
    : mode === 'deliver' ? [pickup, dropoff] : [a, b];
  const plan = [here, ...ahead].filter((p): p is Point => !!p);
  // Toast every new delivery status as it arrives from the drone.
  const seenJob = useRef<{ id: string; count: number } | null>(null);
  useEffect(() => {
    if (!job) return;
    const last = seenJob.current; seenJob.current = { id: job.id, count: job.events.length };
    if (last?.id === job.id && job.events.length > last.count) { const e = job.events[job.events.length - 1]; notify(`${JOB_TITLES[e.status]}${e.status === 'failed' && job.error ? `: ${job.error}` : ''}`, e.status === 'failed' ? 'error' : 'ok'); }
  }, [job, notify]);

  async function run<T>(work: () => Promise<T>, done?: string) { setBusy(true); try { const result = await work(); if (done) notify(done); return result; } catch (e) { notify((e as Error).message, 'error'); return null; } finally { setBusy(false); } }
  const send = (type: CommandType) => run(async () => { const data = await api<{ drone: DroneView }>(`/api/drones/${drone!.id}/commands`, { method: 'POST', body: JSON.stringify(type === 'FLY_ROUTE' ? { type, params: route, pilotReady } : { type }) }); upsert(data.drone); }, type === 'FLY_ROUTE' ? 'Flight sent. The drone will take off within a few seconds.' : `${COMMAND_LABEL[type]} sent to the drone.`);
  async function create(name: string) { const data = await run(() => api<{ drone: DroneView; token: string }>('/api/drones', { method: 'POST', body: JSON.stringify({ name }) }), 'Drone link created. Start the agent on your drone to connect it.'); if (data) { upsert(data.drone); setSelected(data.drone.id); setToken({ id: data.drone.id, value: data.token }); setTab('connect'); } }
  async function join(code: string) { const data = await run(() => api<{ drone: DroneView }>('/api/drones/join', { method: 'POST', body: JSON.stringify({ code }) }), 'You can now fly this drone.'); if (data) { upsert(data.drone); setSelected(data.drone.id); setTab('fly'); } }
  async function patch(body: object, done = 'Settings saved.') { const data = await run(() => api<{ drone: DroneView }>(`/api/drones/${drone!.id}`, { method: 'PATCH', body: JSON.stringify(body) }), done); if (data) upsert(data.drone); }
  async function action<T extends { drone: DroneView }>(path: string, body: object, done: string) { const data = await run(() => api<T>(`/api/drones/${drone!.id}/${path}`, { method: 'POST', body: JSON.stringify(body) }), done); if (data) upsert(data.drone); return data; }
  async function remove() { if (!drone || !confirm(drone.role === 'owner' ? `Remove ${drone.name}? Its token stops working immediately.` : `Leave ${drone.name}?`)) return; const ok = await run(() => api(`/api/drones/${drone.id}`, { method: 'DELETE' }), 'Drone removed.'); if (ok) { setDrones(list => list.filter(d => d.id !== drone.id)); setSelected(drones.find(d => d.id !== drone.id)?.id ?? null); } }
  async function text(command: SmsCommand) { const body = command === 'GOTO' ? { command, point: b, altM } : { command }; const data = await run(() => api<{ text: string; to: string | null; sent: boolean }>(`/api/drones/${drone!.id}/sms`, { method: 'POST', body: JSON.stringify(body) })); if (data) { setSms(data); if (data.sent) notify(`Texted ${command} to the drone.`); } }
  function onPick(p: Point) { ({ A: setA, B: setB, P: (v: Point) => { setPickup(v); setReturnId(null); }, D: (v: Point) => { setDropoff(v); setReturnId(null); } } as const)[pick!](p); setPick(null); setSheet(true); }
  const startPick = (target: PickTarget) => { setPick(pick === target ? null : target); setSheet(false); };
  const jobOp = (op: 'create' | 'loaded' | 'cancel' | 'resume', done: string) => action<{ drone: DroneView; job: DeliveryJob }>('jobs',
    op === 'create' ? { op, pickup, dropoff, altM: alt, speedMs, returnHome, ...(returnId ? { returnId } : {}), pilotReady: true } : { op, jobId: job!.id, ...(op === 'resume' ? { pilotReady: true } : {}) }, done);
  const copy = (value: string) => navigator.clipboard.writeText(value).then(() => notify('Copied.'), () => notify('Select the text and copy it manually.', 'error'));

  const t = drone?.telemetry, online = !!drone?.online, origin = typeof location === 'undefined' ? '' : location.origin;
  return <main className="fly-app">
    <header className="fly-topbar">
      <a className="brand" href="/" aria-label="Back to AERO returns"><span className="brand-symbol"><svg viewBox="0 0 30 30"><path d="M2 25 12 4h6l10 21H19L15 14l-5 11Z" fill="currentColor" /><path d="m4 22 20-8" stroke="white" strokeWidth="2.5" /></svg></span>AERO<span className="fly-brand-tag">FLY</span></a>
      <nav><a href="/"><ArrowLeft size={15} />Returns</a></nav>
      {drone && <span className={`fly-link-pill ${online ? 'live' : ''}`}>{online ? <Wifi size={14} /> : <WifiOff size={14} />}{online ? `Live · ${t?.link.toUpperCase()}` : 'Offline'}</span>}
    </header>
    <section className="fly-canvas">
      <DroneMap drone={drone} stops={stops} plan={plan} pick={pick ? PICK_LABEL[pick] : null} onPick={onPick} />
      {drone && t && <div className="fly-hud" aria-live="polite">
        <div><span><Mountain size={14} />Altitude</span><strong>{t.altM.toFixed(0)}<small>m</small></strong></div>
        <div><span><Gauge size={14} />Speed</span><strong>{(t.groundSpeedMs * 3.6).toFixed(0)}<small>km/h</small></strong></div>
        <div className={t.batteryPct < MIN_BATTERY_PCT ? 'warn' : ''}><span><Battery size={14} />Battery</span><strong>{t.batteryPct.toFixed(0)}<small>%</small></strong></div>
        <div><span><Navigation size={14} />Status</span><strong className="state">{STATE_LABEL[t.state] ?? t.state}</strong></div>
      </div>}
      <aside className={`fly-panel ${sheet ? 'expanded' : ''}`}>
        <button className="sheet-handle fly-sheet-handle" onClick={() => setSheet(!sheet)} aria-label={sheet ? 'Collapse controls' : 'Expand controls'}><span /></button>
        {!loaded ? <div className="fly-empty"><div className="fly-spinner" />Loading your drones…</div> : !drone ? <Onboarding busy={busy} onCreate={create} onJoin={join} /> : <>
          <div className="fly-drone-head">
            <div className="fly-drone-avatar"><Radio size={20} /><i className={online ? 'live' : ''} /></div>
            <div><h1>{drone.name}</h1><p>{online ? <>Connected {t?.signalDbm ? `· ${t.signalDbm} dBm` : ''} {t?.simulated && <span className="fly-badge sim">Simulated</span>}</> : <>Last seen {ago(drone.lastSeen)}</>} <span className="fly-badge">{drone.role === 'owner' ? 'Owner' : 'Pilot'}</span></p></div>
            {drones.length > 1 && <select aria-label="Choose drone" value={drone.id} onChange={e => setSelected(e.target.value)}>{drones.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}
          </div>
          {t?.message && <p className="fly-message"><Radio size={13} />{t.message}</p>}
          {online && t && !t.flightAllowed && <p className="fly-note warn"><TriangleAlert size={15} />Observe-only. Restart the agent with <code>--allow-flight</code> to fly from here.</p>}
          {!online && <p className="fly-note"><WifiOff size={15} />{drone.lastSeen ? 'No data from the drone. Check its 4G signal and power, or use Text backup.' : 'Waiting for the drone to connect. Start the agent from the Connect tab.'}</p>}
          {job && <DeliveryCard job={job} payload={t?.payload ?? 'unknown'} busy={busy} online={online} pilotReady={pilotReady} onPilotReady={setPilotReady}
            onLoaded={() => void jobOp('loaded', 'Package picked up. Taking off for the drop-off.')}
            onCancel={() => void jobOp('cancel', 'Delivery cancelled.')}
            onResume={() => void jobOp('resume', 'Delivery resumed.')} />}
          <div className="fly-emergency" role="group" aria-label="Safety controls">
            <button disabled={busy || !online} onClick={() => void send('HOLD')}><Pause size={16} />Hold</button>
            <button disabled={busy || !online} onClick={() => void send('LAND')}><LandPlot size={16} />Land</button>
            <button disabled={busy || !online} onClick={() => void send('RTL')}><Home size={16} />Return home</button>
          </div>
          <div className="fly-tabs" role="tablist">{([['fly', 'Fly', Navigation], ['connect', 'Connect', KeyRound], ['sms', 'Text backup', MessageSquareText], ['settings', 'Settings', Settings]] as const).map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={14} />{label}</button>)}</div>

          {tab === 'fly' && <div className="fly-section">
            <div className="fly-mode" role="radiogroup" aria-label="Flight type"><button role="radio" aria-checked={mode === 'deliver'} className={mode === 'deliver' ? 'selected' : ''} onClick={() => { setMode('deliver'); setPick(null); }}><Package size={14} />Delivery</button><button role="radio" aria-checked={mode === 'free'} className={mode === 'free' ? 'selected' : ''} onClick={() => { setMode('free'); setPick(null); }}><Navigation size={14} />Free flight</button></div>
            {mode === 'deliver' ? (jobLive ? <p className="fly-note"><PackageCheck size={15} />A delivery is in progress. Follow it in the card above; status updates appear below.</p> : <>
              <div className="fly-points">
                <div className="fly-point"><span className="fly-dot pickup">P</span><div><small>PICK UP FROM</small><strong>{pickup ? fmtPoint(pickup) : 'Choose the pickup spot'}</strong></div>
                  <div className="fly-point-actions">{pickup && <button onClick={() => setPickup(null)} title="Clear pickup"><X size={14} /></button>}<button className={pick === 'P' ? 'active' : ''} onClick={() => startPick('P')}><MapPin size={14} />{pick === 'P' ? 'Tap map…' : 'Pick'}</button></div></div>
                <div className="fly-point-line" />
                <div className="fly-point"><span className="fly-dot b">D</span><div><small>DELIVER TO</small><strong>{dropoff ? fmtPoint(dropoff) : 'Choose the drop-off'}</strong></div>
                  <div className="fly-point-actions">{dropoff && <button onClick={() => setDropoff(null)} title="Clear drop-off"><X size={14} /></button>}<button className={pick === 'D' ? 'active' : ''} onClick={() => startPick('D')}><MapPin size={14} />{pick === 'D' ? 'Tap map…' : 'Pick'}</button></div></div>
              </div>
              {returnPoints && <button className="fly-return-route" onClick={() => { setPickup(returnPoints.pickup); setDropoff(returnPoints.hub); setReturnId(returnPoints.id); }}><Package size={16} /><span><strong>Use my latest return</strong><small>Pickup = your doorstep · Drop-off = {returnPoints.hubName}</small></span><ArrowRight size={15} /></button>}
              <label className="fly-slider"><span>Altitude <strong>{alt} m</strong></span><input type="range" min={5} max={drone.maxAltM} value={alt} onChange={e => setAltM(Number(e.target.value))} /></label>
              <label className="fly-slider"><span>Speed <strong>{speedMs} m/s · {(speedMs * 3.6).toFixed(0)} km/h</strong></span><input type="range" min={2} max={12} value={speedMs} onChange={e => setSpeedMs(Number(e.target.value))} /></label>
              <div className="fly-toggle" role="radiogroup" aria-label="After delivery"><button role="radio" aria-checked={returnHome} className={returnHome ? 'selected' : ''} onClick={() => setReturnHome(true)}>Return home after</button><button role="radio" aria-checked={!returnHome} className={!returnHome ? 'selected' : ''} onClick={() => setReturnHome(false)}>Stay at drop-off</button></div>
              {delivery && <div className="fly-estimate"><span>{(deliveryLength / 1000).toFixed(2)} km</span><span>~{Math.ceil((deliveryLength / speedMs + alt / 1.2) / 60)} min flying</span><span>lands at both stops</span></div>}
              <label className="fly-check"><input type="checkbox" checked={pilotReady} onChange={e => setPilotReady(e.target.checked)} /><span>A pilot with a remote controller can see the drone and will take over if needed.</span></label>
              {delivery && deliveryRefused && <p className="fly-note warn"><TriangleAlert size={15} />{deliveryRefused.replace('Point A', 'The pickup').replace('Point B', 'The drop-off')}</p>}
              <button className="primary fly-go" disabled={busy || !delivery || !!deliveryRefused || !pilotReady} onClick={() => void jobOp('create', 'Delivery started. The drone is heading to the pickup.')}>{delivery ? 'Start delivery' : 'Choose pickup and drop-off'}<ArrowRight size={17} /></button>
              <p className="fly-fine"><ShieldCheck size={13} />The drone lands at the pickup and waits. Nothing flies with a package until a person confirms it is secured. At the drop-off it lands and opens the gripper.</p>
            </>) : <>
            <div className="fly-points">
              <div className="fly-point"><span className="fly-dot a">A</span><div><small>FROM</small><strong>{a ? fmtPoint(a) : 'Where the drone is now'}</strong></div>
                <div className="fly-point-actions">{a && <button onClick={() => setA(null)} title="Start from the drone's position"><Crosshair size={14} /></button>}<button className={pick === 'A' ? 'active' : ''} onClick={() => startPick('A')}><MapPin size={14} />{pick === 'A' ? 'Tap map…' : 'Pick'}</button></div></div>
              <div className="fly-point-line" />
              <div className="fly-point"><span className="fly-dot b">B</span><div><small>TO</small><strong>{b ? fmtPoint(b) : 'Choose a destination'}</strong></div>
                <div className="fly-point-actions">{b && <button onClick={() => setB(null)} title="Clear destination"><X size={14} /></button>}<button className={pick === 'B' ? 'active' : ''} onClick={() => startPick('B')}><MapPin size={14} />{pick === 'B' ? 'Tap map…' : 'Pick'}</button></div></div>
            </div>
            <label className="fly-slider"><span>Altitude <strong>{alt} m</strong></span><input type="range" min={5} max={drone.maxAltM} value={alt} onChange={e => setAltM(Number(e.target.value))} /></label>
            <label className="fly-slider"><span>Speed <strong>{speedMs} m/s · {(speedMs * 3.6).toFixed(0)} km/h</strong></span><input type="range" min={2} max={12} value={speedMs} onChange={e => setSpeedMs(Number(e.target.value))} /></label>
            <div className="fly-toggle" role="radiogroup" aria-label="At point B"><button role="radio" aria-checked={land} className={land ? 'selected' : ''} onClick={() => setLand(true)}>Land at B</button><button role="radio" aria-checked={!land} className={!land ? 'selected' : ''} onClick={() => setLand(false)}>Hover at B</button></div>
            {route && <div className="fly-estimate"><span>{(length / 1000).toFixed(2)} km</span><span>~{Math.ceil(eta / 60)} min</span><span>{drone.home && b ? `${Math.round(distance(drone.home, b))} m from home` : ''}</span></div>}
            <label className="fly-check"><input type="checkbox" checked={pilotReady} onChange={e => setPilotReady(e.target.checked)} /><span>A pilot with a remote controller can see the drone and will take over if needed.</span></label>
            {route && refused && <p className="fly-note warn"><TriangleAlert size={15} />{refused}</p>}
            <button className="primary fly-go" disabled={busy || !route || !!refused || !pilotReady} onClick={() => void send('FLY_ROUTE')}>{b ? <>Fly {a ? 'A → B' : 'to B'}</> : 'Pick point B to fly'}<ArrowRight size={17} /></button>
            <p className="fly-fine"><ShieldCheck size={13} />Flights stay inside the {drone.geofenceM} m safety zone around <strong>H</strong>, below {drone.maxAltM} m. The drone re-checks every command and returns home if it loses this website for 45 s.</p>
            </>}
            <EventFeed events={drone.events} />
            {mode === 'free' && <CommandLog commands={drone.commands} />}
          </div>}

          {tab === 'connect' && <div className="fly-section">
            <h2>Connect the drone</h2>
            <ol className="fly-steps">
              <li><strong>Flight controller.</strong> ArduPilot Copter, with a telemetry port wired to the onboard computer (for example a Raspberry Pi on <code>/dev/serial0</code>).</li>
              <li><strong>4G.</strong> A USB 4G modem or HAT with a data SIM. Its AT port (often <code>/dev/ttyUSB2</code>) also receives texts.</li>
              <li><strong>Agent.</strong> Copy <code>drone-agent/aero_agent.py</code> to the drone, <code>pip install -r requirements.txt</code>, then run:</li>
            </ol>
            {token?.id === drone.id ? <>
              <div className="fly-secret"><span><KeyRound size={14} />Drone token, shown once</span><code>{token.value}</code><button onClick={() => copy(token.value)}><Copy size={14} />Copy</button></div>
              <Command label="Real drone" value={`python3 aero_agent.py --server ${origin} --token ${token.value} --connect /dev/serial0 --baud 921600 --modem /dev/ttyUSB2 --allow-flight`} onCopy={copy} />
              <Command label="No hardware yet: simulated drone" value={`python3 aero_agent.py --server ${origin} --token ${token.value} --sim --allow-flight`} onCopy={copy} />
              <Command label="Or from this repo (Node)" value={`node_modules/.bin/tsx scripts/fake-drone.ts --server ${origin} --token ${token.value}`} onCopy={copy} />
            </> : <div className="fly-secret muted"><span><KeyRound size={14} />The token is only shown when it is created.</span>{drone.role === 'owner' && <button disabled={busy} onClick={async () => { const data = await action<{ drone: DroneView; token: string }>('token', {}, 'New token created. The old one stopped working.'); if (data) setToken({ id: drone.id, value: data.token }); }}><KeyRound size={14} />New token</button>}</div>}
            {drone.role === 'owner' && <div className="fly-share"><h3><Users size={15} />Let others fly it</h3><p>Share a pilot code. Pilots can fly and use safety controls; only you change limits. {drone.pilots ? `${drone.pilots} pilot${drone.pilots === 1 ? '' : 's'} connected.` : ''}</p>
              {drone.pilotCode ? <div className="fly-code"><strong>{drone.pilotCode}</strong><button onClick={() => copy(drone.pilotCode!)}><Copy size={14} /></button><button disabled={busy} onClick={() => void action('share', { revoke: true }, 'Pilot code revoked and pilots removed.')}>Revoke</button></div>
                : <button className="secondary" disabled={busy} onClick={() => void action('share', {}, 'Pilot code ready to share.')}><UserPlus size={15} />Create pilot code</button>}</div>}
            <JoinForm busy={busy} onJoin={join} />
            <AddDrone busy={busy} onCreate={create} />
          </div>}

          {tab === 'sms' && <div className="fly-section">
            <h2>Text backup</h2>
            <p className="fly-body">If mobile data drops but the SIM still has signal, text the drone. Each message carries a code that expires in 5 minutes and works once.</p>
            <PhoneField key={`${drone.id}:${drone.phone ?? ''}`} drone={drone} busy={busy} onSave={phone => patch({ phone }, 'Drone phone number saved.')} />
            <div className="fly-sms-grid">{(['HOLD', 'LAND', 'RTL', 'STATUS'] as const).map(c => <button key={c} className="secondary" disabled={busy} onClick={() => void text(c)}>{c === 'RTL' ? 'Return home' : c[0] + c.slice(1).toLowerCase()}</button>)}<button className="secondary" disabled={busy || !b} onClick={() => void text('GOTO')}>Go to B</button></div>
            {sms && <div className="fly-sms-result">{sms.sent ? <span className="ok"><Check size={14} />Sent to {sms.to}</span> : <span>Send this from your phone{sms.to ? ` to ${sms.to}` : ''}:</span>}<code>{sms.text}</code><div><button onClick={() => copy(sms.text)}><Copy size={14} />Copy</button>{!sms.sent && sms.to && <a href={`sms:${sms.to}?&body=${encodeURIComponent(sms.text)}`}><MessageSquareText size={14} />Open Messages</a>}</div></div>}
            <p className="fly-fine">{smsReady ? 'Automatic texting is on (Twilio).' : 'Automatic texting is off. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to send from the website.'} Start the agent with <code>--modem</code> to receive texts.</p>
          </div>}

          {tab === 'settings' && <div className="fly-section">{drone.role === 'owner' ? <SettingsForm key={drone.id} drone={drone} busy={busy} onSave={patch} /> : <p className="fly-body">You are a pilot on this drone. Only the owner can change its limits.</p>}
            <button className="fly-danger" onClick={() => void remove()}><Trash2 size={15} />{drone.role === 'owner' ? 'Remove this drone' : 'Leave this drone'}</button></div>}
        </>}
      </aside>
      {toast && <div className={`toast fly-toast ${toast.tone}`} role="status"><span>{toast.tone === 'ok' ? <Check size={15} /> : <TriangleAlert size={15} />}</span>{toast.text}<button aria-label="Dismiss" onClick={() => setToast(null)}><X size={15} /></button></div>}
    </section>
  </main>;
}

function Onboarding({ busy, onCreate, onJoin }: { busy: boolean; onCreate: (name: string) => void; onJoin: (code: string) => void }) {
  return <div className="fly-onboarding">
    <span className="eyebrow">LIVE DRONE CONTROL</span>
    <h1>Connect your drone.<br />Fly it from A to B.</h1>
    <p>Link a real drone over 4G, watch it move live on the map, and send it anywhere inside its safety zone. Texts work as a backup when data drops.</p>
    <ul className="fly-features"><li><Signal size={16} />4G link, 1-second telemetry</li><li><ShieldCheck size={16} />Geofence, battery and link-loss failsafes</li><li><MessageSquareText size={16} />Signed SMS commands</li></ul>
    <AddDrone busy={busy} onCreate={onCreate} open />
    <JoinForm busy={busy} onJoin={onJoin} />
  </div>;
}
function AddDrone({ busy, onCreate, open = false }: { busy: boolean; onCreate: (name: string) => void; open?: boolean }) {
  const [name, setName] = useState(''), [show, setShow] = useState(open);
  if (!show) return <button className="fly-text-button" onClick={() => setShow(true)}><Plus size={14} />Link another drone</button>;
  return <form className="fly-inline-form" onSubmit={e => { e.preventDefault(); if (name.trim()) onCreate(name.trim()); }}><label><span>Drone name</span><input value={name} maxLength={40} placeholder="e.g. AERO-01 Quad" onChange={e => setName(e.target.value)} /></label><button className="primary" disabled={busy || !name.trim()}>Create drone link<ArrowRight size={16} /></button></form>;
}
function JoinForm({ busy, onJoin }: { busy: boolean; onJoin: (code: string) => void }) {
  const [code, setCode] = useState('');
  return <form className="fly-inline-form join" onSubmit={e => { e.preventDefault(); onJoin(code); }}><label><span>Have a pilot code?</span><input value={code} maxLength={6} placeholder="6-character code" autoCapitalize="characters" onChange={e => setCode(e.target.value.toUpperCase())} /></label><button className="secondary" disabled={busy || code.length !== 6}><UserPlus size={15} />Join</button></form>;
}
function PhoneField({ drone, busy, onSave }: { drone: DroneView; busy: boolean; onSave: (phone: string) => void }) {
  const [phone, setPhone] = useState(drone.phone ?? '');
  if (drone.role !== 'owner') return <p className="fly-body">Drone number: <strong>{drone.phone || 'not set by the owner'}</strong></p>;
  return <form className="fly-inline-form row" onSubmit={e => { e.preventDefault(); onSave(phone.trim()); }}><label><span>Drone SIM number</span><input value={phone} inputMode="tel" placeholder="+14155550123" onChange={e => setPhone(e.target.value)} /></label><button className="secondary" disabled={busy || phone === (drone.phone ?? '')}>Save</button></form>;
}
function SettingsForm({ drone, busy, onSave }: { drone: DroneView; busy: boolean; onSave: (body: object, done?: string) => void }) {
  const [name, setName] = useState(drone.name), [fence, setFence] = useState(drone.geofenceM), [alt, setAlt] = useState(drone.maxAltM);
  return <>
    <h2>Safety limits</h2>
    <label className="fly-inline-form"><span>Name</span><input value={name} maxLength={40} onChange={e => setName(e.target.value)} /></label>
    <label className="fly-slider"><span>Safety zone radius <strong>{fence} m</strong></span><input type="range" min={50} max={3000} step={50} value={fence} onChange={e => setFence(Number(e.target.value))} /></label>
    <label className="fly-slider"><span>Maximum altitude <strong>{alt} m</strong></span><input type="range" min={10} max={120} value={alt} onChange={e => setAlt(Number(e.target.value))} /></label>
    <p className="fly-fine">120 m (400 ft) is the US legal ceiling for small drones. Fly within sight and check local rules and airspace.</p>
    <button className="primary" disabled={busy || !name.trim()} onClick={() => onSave({ name: name.trim(), geofenceM: fence, maxAltM: alt })}>Save limits</button>
    <div className="fly-home-row"><span><Home size={15} />Home {drone.home ? fmtPoint(drone.home) : 'not set'}</span><button className="secondary" disabled={busy || !drone.telemetry || drone.telemetry.gpsFix < 3} onClick={() => onSave({ home: 'current' }, 'Home moved to the drone’s position.')}>Set home here</button></div>
  </>;
}
function Command({ label, value, onCopy }: { label: string; value: string; onCopy: (v: string) => void }) {
  return <div className="fly-command"><span>{label}</span><code>{value}</code><button onClick={() => onCopy(value)} aria-label={`Copy ${label} command`}><Copy size={14} /></button></div>;
}
const clockTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
function DeliveryCard({ job, payload, busy, online, pilotReady, onPilotReady, onLoaded, onCancel, onResume }: { job: DeliveryJob; payload: 'loaded' | 'empty' | 'unknown'; busy: boolean; online: boolean; pilotReady: boolean; onPilotReady: (v: boolean) => void; onLoaded: () => void; onCancel: () => void; onResume: () => void }) {
  const live = isActiveJob(job), step = jobStep(job), last = job.events[job.events.length - 1];
  const onBoard = payload === 'loaded' || (payload === 'unknown' && job.loaded && !job.events.some(e => e.status === 'delivered'));
  // Two-step confirmation in the card instead of a browser dialog (works on phones and stays visible).
  const [confirming, setConfirming] = useState<{ op: 'loaded' | 'cancel'; status: DeliveryJob['status'] } | null>(null);
  const ask = confirming?.status === job.status ? confirming.op : null;
  return <section className={`fly-job ${job.status} ${live ? 'live' : 'ended'}`} aria-live="polite">
    <div className="fly-job-head"><span className="eyebrow">DELIVERY · {job.id.slice(0, 6).toUpperCase()}</span>{onBoard && <span className="fly-badge onboard"><PackageCheck size={12} />Package on board</span>}<time>{clockTime(last.at)}</time></div>
    <h2>{JOB_TITLES[job.status]}</h2>
    <p>{job.status === 'failed' && job.error ? job.error : JOB_GUIDANCE[job.status]}{job.status === 'delivered' && job.returnHome ? ' Returning home next.' : ''}</p>
    <ol className="fly-job-steps" aria-label={`Step ${step + 1} of ${JOB_STEPS.length}`}>{JOB_STEPS.map((s, i) => <li key={s.status} className={`${i < step || (!live && job.status === 'completed') ? 'done' : ''} ${i === step && live ? 'current' : ''}`}><span>{i < step || job.status === 'completed' ? <Check size={11} /> : i + 1}</span><small>{s.label}</small></li>)}</ol>
    {ask ? <div className="fly-confirm" role="alertdialog" aria-label={ask === 'loaded' ? 'Confirm the package is secured' : 'Confirm cancelling the delivery'}>
      <p>{ask === 'loaded' ? 'Is the package secured on the drone? It takes off for the drop-off right away.' : job.loaded ? 'Cancel this delivery? The drone flies home with the package.' : 'Cancel this delivery? The drone stops and comes home if it is flying.'}</p>
      <div><button className="secondary" onClick={() => setConfirming(null)}>{ask === 'loaded' ? 'Not yet' : 'Keep delivering'}</button><button className={ask === 'loaded' ? 'primary' : 'fly-danger-button'} disabled={busy || (ask === 'loaded' && !online)} onClick={() => { setConfirming(null); if (ask === 'loaded') onLoaded(); else onCancel(); }}>{ask === 'loaded' ? 'Yes, take off' : 'Cancel delivery'}</button></div>
    </div> : <>
    {job.status === 'at_pickup' && <button className="primary fly-go" disabled={busy || !online} onClick={() => setConfirming({ op: 'loaded', status: job.status })}><PackageCheck size={17} />Package is loaded. Send it.</button>}
    {job.status === 'failed' && <>
      <label className="fly-check"><input type="checkbox" checked={pilotReady} onChange={e => onPilotReady(e.target.checked)} /><span>A pilot with a remote controller can see the drone.</span></label>
      <button className="primary fly-go" disabled={busy || !online || !pilotReady} onClick={onResume}><RotateCcw size={16} />Resume delivery</button>
    </>}
    {live && <button className="fly-text-button danger" disabled={busy} onClick={() => setConfirming({ op: 'cancel', status: job.status })}><X size={14} />Cancel delivery</button>}
    </>}
  </section>;
}
function EventFeed({ events }: { events: DroneEvent[] }) {
  if (!events.length) return null;
  return <div className="fly-log"><h3><Bell size={14} />Status updates</h3><ol>{events.slice(0, 10).map(e => <li key={e.id}><span className={`fly-event-dot ${e.kind}`} /><div><strong>{e.title}</strong>{e.detail && <small>{e.detail}</small>}</div><time>{clockTime(e.at)}</time></li>)}</ol></div>;
}
function CommandLog({ commands }: { commands: DroneCommand[] }) {
  if (!commands.length) return null;
  return <div className="fly-log"><h3><Satellite size={14} />Recent commands</h3><ol>{commands.slice(0, 6).map(c => <li key={c.id}><span className={`fly-status ${c.status}`}>{c.status}</span><div><strong>{COMMAND_LABEL[c.type]}{c.channel === 'sms' ? ' · SMS' : ''}</strong>{c.message && <small>{c.message}</small>}</div><time>{new Date(c.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time></li>)}</ol></div>;
}
