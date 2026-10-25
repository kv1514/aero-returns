'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Battery, Check, Copy, Crosshair, Gauge, Home, KeyRound, LocateFixed, MapPin, Navigation, OctagonX, Package, Pause, Plane, PlaneLanding, Plus, Radio, RotateCcw, Satellite, ShieldCheck, Signal, Trash2, TriangleAlert, Undo2, UserRound } from 'lucide-react';
import FleetMap from './fleet-map';
import Modal from './modal';
import { useAccessibility } from './accessibility';
import { LIMITS, atPin, fmtMeters, phaseCommand, pickupFor, type DroneConfig } from '@/lib/drone-mission';
import { ago, awayOnGround, bridgeCommand, compass, dispatchChoices, pickupPreview, pointAhead, pointOffset, serverNow } from '@/lib/fleet-view';
import { DEMO_PACKAGE, type LiveTelemetry, type MissionPhase, type Point, type ReturnRecord } from '@/lib/simulation';

type Drone = { id: string; name: string; transport: 'https' | 'sms'; phone: string | null; phoneVerified: boolean; config: DroneConfig; armed: boolean; armedUntil: number; activeReturn: string | null; lastSeen: number; stale: boolean; telemetry: LiveTelemetry | null; createdAt: number };
type Setup = { link: boolean; sms: boolean; linkUrl: string; smsWebhook: string };
type Command = { seq: number; type: string; status: string; reason: string | null; phase: string | null; created_at: number; updated_at: number };
type Detail = { setup: Setup; drone: Drone; key?: string; trail: LiveTelemetry[]; commands: Command[]; mission: ReturnRecord | null; now: number };
type PadKey = 'home' | 'pickupPad' | 'dropPad';
const PAD_NAME: Record<PadKey, string> = { home: 'Home', pickupPad: 'Pickup pad', dropPad: 'Drop pad' };
const PHASE: Record<MissionPhase, string> = { TAKEOFF_OUT: 'Taking off', TO_PICKUP: 'Flying to pickup', HOVER_PICKUP: "Hovering over the customer's pin · check the landing area", LAND_PICKUP: 'Landing at pickup', AWAITING_LOAD: 'Waiting for the customer to load', READY_TO_LAUNCH: 'Loaded · ready to launch', TAKEOFF_LOADED: 'Taking off with package', TO_DROP: 'Flying to drop pad', LAND_DROP: 'Landing at drop pad', AWAITING_UNLOAD: 'Landed · confirm unload', TAKEOFF_HOME: 'Taking off for home', RETURNING: 'Flying home', LAND_HOME: 'Landing at home', COMPLETE: 'Complete', ABORTED: 'Ended by operator' };
const CHECKS = [['pilot', 'A pilot with RC override is ready and watching the drone.'], ['airspace', 'The area is clear and the flight is authorized (Part 107/TRUST, LAANC if needed).'], ['pads', 'Home, pads and geofence on the map match the real site.'], ['failsafe', 'Autopilot failsafes are set: RTL on link loss, geofence, low battery.']] as const;
const fmtPoint = (p: Point | null) => (p ? `${p[1].toFixed(6)}, ${p[0].toFixed(6)}` : 'Not set');
const returnLabel = (r: ReturnRecord) => `${r.package.retailer} · ${r.package.address.split(',')[0]} · AR-${r.id.slice(0, 8).toUpperCase()}`;
async function api<T>(path: string, init?: RequestInit) {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

export default function FleetConsole() {
  useAccessibility();
  const [list, setList] = useState<{ setup: Setup; drones: Drone[] } | null>(null), [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [returns, setReturns] = useState<ReturnRecord[]>([]), [returnId, setReturnId] = useState(''), [registering, setRegistering] = useState(false), [secret, setSecret] = useState<{ drone: Drone; key: string } | null>(null);
  const [placing, setPlacing] = useState<PadKey | null>(null), [nudgePad, setNudgePad] = useState<PadKey>('pickupPad'), [busy, setBusy] = useState(false), [notice, setNotice] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null), [checks, setChecks] = useState<Record<string, boolean>>({}), [confirmDelete, setConfirmDelete] = useState(false);
  // pinZone: the pin landing zone being typed (null shows the saved value); askClear: a takeoff from the ground away from home waiting for the operator's yes.
  const [confirmRotate, setConfirmRotate] = useState(false), [pinZone, setPinZone] = useState<string | null>(null), [cruise, setCruise] = useState<string | null>(null), [askClear, setAskClear] = useState<{ body: object; success: string } | null>(null);
  const say = (tone: 'error' | 'ok', text: string) => setNotice({ tone, text });
  const [failures, setFailures] = useState(0), offline = failures >= 3, [listError, setListError] = useState('');
  // When the last drone answer arrived on this device, and a clock that ticks while the link is down (see `seen` below).
  const [receivedAt, setReceivedAt] = useState(0), [clock, setClock] = useState(0);
  const receive = useCallback((data: Detail) => { setDetail(data); setReceivedAt(Date.now()); }, []);
  const applyList = useCallback((data: { setup: Setup; drones: Drone[] }) => { setList(data); setListError(''); setSelected(s => s && data.drones.some(d => d.id === s) ? s : data.drones[0]?.id ?? null); }, []);
  const loadList = useCallback(() => api<{ setup: Setup; drones: Drone[] }>('/api/fleet').then(applyList), [applyList]);
  // A failed list load is shown in place of the drone panel (it only matters while nothing has loaded yet).
  useEffect(() => {
    const tick = () => api<{ setup: Setup; drones: Drone[] }>('/api/fleet').then(applyList, (e: Error) => setListError(e.message));
    void tick();
    const t = setInterval(() => void tick(), 5000); return () => clearInterval(t);
  }, [applyList]);
  function choose(id: string) { setSelected(id); setChecks({}); setPlacing(null); setNotice(null); setPinZone(null); setCruise(null); setAskClear(null); }
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const loadDetail = () => api<Detail>(`/api/fleet/${selected}`).then(data => { if (active) { receive(data); setFailures(0); } }, error => { if (active) setFailures(f => f + 1); throw error; });
    const loadReturns = () => api<{ returns: ReturnRecord[] }>('/api/returns').then(d => { if (active) setReturns(d.returns); }).catch(() => {});
    loadDetail().catch(e => say('error', e.message)); void loadReturns();
    const fast = setInterval(() => loadDetail().catch(() => {}), 1500), slow = setInterval(loadReturns, 6000);
    return () => { active = false; clearInterval(fast); clearInterval(slow); };
  }, [selected, receive]);
  /** Books a demo return for this browser and selects it, so a test flight needs no trip through the customer app. Dispatch stays a separate tap. */
  async function newTrip() {
    if (busy) return;
    setBusy(true);
    try {
      const { record } = await api<{ record: ReturnRecord }>('/api/returns', { method: 'POST', body: JSON.stringify({ ...DEMO_PACKAGE, returnReference: 'Fleet test trip' }) });
      setReturns(rs => [record, ...rs.filter(r => r.id !== record.id)]); setReturnId(record.id);
      say('ok', `Test trip AR-${record.id.slice(0, 8).toUpperCase()} is ready. Check where it flies below, then tap Dispatch live flight.`);
    } catch (e) { say('error', (e as Error).message); }
    finally { setBusy(false); }
  }
  async function patch(body: object, success?: string) {
    if (!selected || busy) return false;
    setBusy(true);
    try {
      const data = await api<Detail>(`/api/fleet/${selected}`, { method: 'PATCH', body: JSON.stringify(body) }); receive(data); if (data.key) setSecret({ drone: data.drone, key: data.key }); if (success) say('ok', success); void loadList();
      // The checklist is confirmed fresh for every arming, and against the current pads and limits.
      if (['arm', 'disarm', 'config', 'pad-from-drone'].includes((body as { action: string }).action)) setChecks({});
      return true;
    }
    catch (e) { say('error', (e as Error).message); return false; }
    finally { setBusy(false); }
  }
  /** ABORT never waits for another console request and is never disabled. */
  async function abort() {
    if (!selected) return;
    try { const data = await api<Detail>(`/api/fleet/${selected}`, { method: 'PATCH', body: JSON.stringify({ action: 'abort' }) }); receive(data); say('ok', 'ABORT sent. The drone returns home.'); }
    catch (e) { say('error', `ABORT did not reach AERO: ${(e as Error).message} Use your RC transmitter.`); }
  }
  async function remove() {
    if (!selected) return; setBusy(true);
    try { await api(`/api/fleet/${selected}`, { method: 'DELETE' }); setSelected(null); setConfirmDelete(false); await loadList(); say('ok', 'Drone removed.'); } catch (e) { say('error', (e as Error).message); } finally { setBusy(false); }
  }
  const current = detail?.drone.id === selected ? detail : null, d = current?.drone, t = d?.telemetry ?? null, now = current?.now ?? 0, mission = current?.mission?.live ? current.mission : null, phase = mission?.live?.phase;
  const { ready, held } = dispatchChoices(returns, now);
  // A return that was dispatched, cancelled or loaded elsewhere leaves the list, and the selection with it.
  const chosen = d ? ready.find(r => r.id === returnId) : undefined, chosenPickup = chosen && d ? pickupFor(d.config, chosen.package.pickup) : null;
  const pinRadius = d?.config.pinRadius ?? 0, pinFlight = mission?.live?.pickupSource === 'pin', away = d ? awayOnGround(d.config.home, t) : null;
  // While the mission waits in HOVER_PICKUP, where the drone's fresh report puts it: the bridge's own link-loss return or an RC landing sends no ack, so the phase alone cannot tell.
  const hover = phase === 'HOVER_PICKUP' && d ? (d.stale ? { where: 'unknown' as const, meters: null } : atPin(t, mission!.live!.pickupPad)) : null, grounded = hover?.where === 'landed' || hover?.where === 'ground';
  /** Commands that may lift the drone off the ground away from home (an RTL from a remote pad climbs first) ask about people nearby first. */
  const takeoff = (body: object, success: string) => (away !== null ? setAskClear({ body, success }) : void patch(body, success));
  function savePinZone() {
    const n = Number(pinZone);
    if (!pinZone?.trim() || !(n >= 0 && n <= LIMITS.maxPinRadius)) { say('error', `The pin landing zone must be 0–${LIMITS.maxPinRadius} m from the pickup pad (0 = always use the pad).`); return; }
    void patch({ action: 'config', pinRadius: n }, n ? `Pins within ${fmtMeters(n)} of the pickup pad. Re-arm with the checklist.` : 'Pins off: every pickup uses the pickup pad. Re-arm with the checklist.').then(ok => { if (ok) setPinZone(null); });
  }
  function saveCruise(maxAlt: number) {
    const n = Number(cruise);
    if (!cruise?.trim() || !(n >= LIMITS.minCruise && n <= maxAlt)) { say('error', `Cruise altitude must be ${LIMITS.minCruise}–${maxAlt} m (the maximum altitude).`); return; }
    void patch({ action: 'config', cruiseAlt: n }, `Cruise altitude ${n} m: takeoffs and flights use it from now on. Re-arm with the checklist.`).then(ok => { if (ok) setCruise(null); });
  }
  const linkState = !d ? '' : offline ? 'stale' : !d.lastSeen ? 'waiting' : d.stale ? 'stale' : 'live';
  // Connectivity, not configuration: shown in the sticky header (a sticky bar on phones) so it stays in view at the controls.
  const warn = !!d && linkState === 'stale', lastKnown = !!t && warn;
  // Offline, `now` is the server time of the last answer and stops moving, so the age would freeze ("just now" for the whole outage). This 1 s clock keeps it counting.
  useEffect(() => { if (!warn) return; const tick = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(tick); }, [warn]);
  const seen = warn ? serverNow(now, receivedAt, clock) : now;
  const linkText = !d ? '' : offline ? 'Console offline · retrying' : linkState === 'waiting' ? 'Waiting for bridge' : linkState === 'stale' ? `Signal lost · ${ago(d.lastSeen, seen)}` : 'Bridge connected';
  const noticeBox = notice && <div className={`fleet-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'error' ? <TriangleAlert size={16} /> : <Check size={16} />}<span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>;
  return <main className="fleet">
    <header className="fleet-top">
      <a href="/" className="fleet-back" aria-label="Customer app"><ArrowLeft size={18} /><span>Customer app</span></a>
      <h1><Radio size={20} />AERO Fleet</h1>
      <div className="fleet-setup">
        {d && <span className={`fleet-live ${warn ? 'warn' : linkState === 'live' ? 'ok' : ''}`}><i />{linkText}</span>}
        <span className={!list ? '' : list.setup.link ? 'ok' : 'warn'}><i />{!list ? (listError ? 'Link status unavailable' : 'Checking drone link…') : list.setup.link ? 'Drone link configured' : 'Drone link not configured'}</span>
        <span className={list?.setup.sms ? 'ok' : ''}><i />{list?.setup.sms ? 'SMS ready' : 'SMS off'}</span>
      </div>
    </header>
    {warn && <div className="fleet-alertbar"><Signal size={15} /><span>{linkText}{lastKnown ? (offline ? ` · last telemetry ${ago(d.lastSeen, seen)}` : ' · telemetry is last known') : ''}. Your RC transmitter always overrides.</span></div>}
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
          <span className={`fleet-link ${linkState}`}><Signal size={15} />{linkState === 'live' ? `Connected · ${ago(d.lastSeen, now)}` : linkText}</span>
        </div>
        {offline && <div className="fleet-notice error" role="alert"><Signal size={16} /><span>Lost contact with AERO. Showing the last data received while the console retries. Your RC transmitter always overrides.</span></div>}
        {noticeBox}
        <div className="fleet-grid">
          <div className="fleet-card map-card">
            <FleetMap config={d.config} telemetry={t} trail={current?.trail ?? []} customerPin={mission?.live?.pickupSource === 'pin' ? mission.live.pickupPad : !mission && chosenPickup?.source === 'pin' ? chosenPickup.point : null} placing={placing} onPlace={p => { const pad = placing!; setPlacing(null); void patch({ action: 'config', [pad]: p }, 'Pad updated. Re-arm with the checklist.'); }} editable={!mission && !busy && !placing} onMove={(pad, p) => patch({ action: 'config', [pad]: p }, `${PAD_NAME[pad]} moved. Re-arm with the checklist.`)} />
            <div className="fleet-place">{placing ? <><span>Click the map to place the {placing === 'home' ? 'home point' : placing === 'pickupPad' ? 'pickup pad' : 'drop pad'}.</span><button onClick={() => setPlacing(null)}>Cancel</button></> : <>{(['home', 'pickupPad', 'dropPad'] as PadKey[]).map(k => <button key={k} disabled={!!mission || busy} onClick={() => setPlacing(k)}>{k === 'home' ? <Home size={14} /> : <MapPin size={14} />}{k === 'home' ? 'Home' : k === 'pickupPad' ? 'Pickup' : 'Drop'}</button>)}</>}</div>
          </div>
          <div className="fleet-card telemetry">
            <h3>Telemetry{lastKnown && <span className="fleet-last">Last known · {ago(d.lastSeen, seen)}</span>}</h3>
            <div className={`fleet-tiles${lastKnown ? ' stale' : ''}`}>
              <div><span><Navigation size={14} />State</span><strong>{t?.state ?? '—'}</strong><small>{t?.mode ?? 'No data'}</small></div>
              <div><span><Gauge size={14} />Altitude</span><strong>{t ? t.alt.toFixed(1) : '—'}<small> m</small></strong><small>{t ? `${t.speed.toFixed(1)} m/s` : ''}</small></div>
              <div><span><Battery size={14} />Battery</span><strong>{t && t.battery >= 0 ? `${Math.round(t.battery)}%` : '—'}</strong><small>Floor 40% to dispatch</small></div>
              <div><span><Satellite size={14} />GPS</span><strong>{t ? (t.fix >= 3 ? '3D fix' : `Fix ${t.fix}`) : '—'}</strong><small>{t ? `${t.sats} satellites` : ''}</small></div>
            </div>
            <dl className="fleet-pads"><div><dt>Home</dt><dd>{fmtPoint(d.config.home)}</dd></div><div><dt>Pickup pad</dt><dd>{fmtPoint(d.config.pickupPad)}</dd></div><div><dt>Drop pad</dt><dd>{fmtPoint(d.config.dropPad)}</dd></div><div><dt>Limits</dt><dd>{d.config.radius} m fence · {d.config.maxAlt} m max · {d.config.cruiseAlt} m cruise</dd></div></dl>
            <form className="fleet-pin-zone" onSubmit={e => { e.preventDefault(); savePinZone(); }}>
              <label>Land at customer pins within <input type="number" inputMode="decimal" min={0} max={LIMITS.maxPinRadius} step="any" value={pinZone ?? String(pinRadius)} disabled={!!mission || busy} onChange={e => setPinZone(e.target.value)} /> m of the pickup pad (0 = always use the pad)</label>
              <button disabled={!!mission || busy || pinZone === null || Number(pinZone) === pinRadius}>Save</button>
            </form>
            <form className="fleet-pin-zone" onSubmit={e => { e.preventDefault(); saveCruise(d.config.maxAlt); }}>
              <label>Cruise altitude <input type="number" inputMode="decimal" min={LIMITS.minCruise} max={d.config.maxAlt} step="any" value={cruise ?? String(d.config.cruiseAlt)} disabled={!!mission || busy} onChange={e => setCruise(e.target.value)} /> m: how high it takes off and flies ({LIMITS.minCruise}–{d.config.maxAlt} m)</label>
              <button disabled={!!mission || busy || cruise === null || Number(cruise) === d.config.cruiseAlt}>Save</button>
            </form>
            {d.config.cruiseAlt < 10 && <p className="fleet-hint fleet-landing"><TriangleAlert size={14} /><span>Low test altitude: at {d.config.cruiseAlt} m the drone flies at about head height, so keep everyone well clear. ABORT and Return home use the flight controller’s own return altitude (ArduPilot RTL_ALT), not this setting.</span></p>}
            <div className="fleet-row-buttons">{(['home', 'pickupPad', 'dropPad'] as PadKey[]).map(k => <button key={k} disabled={!t || d.stale || !!mission || busy} onClick={() => void patch({ action: 'pad-from-drone', pad: k }, 'Pad set from the drone’s position.')}><LocateFixed size={14} />{k === 'home' ? 'Home' : k === 'pickupPad' ? 'Pickup' : 'Drop'} = drone</button>)}</div>
            {(['pickupPad', 'dropPad'] as const).map(k => <div key={k} className="fleet-row-buttons fleet-ahead"><span>{k === 'pickupPad' ? 'Pickup' : 'Drop'} ahead of the nose</span>{[2, 5, 10].map(m => <button key={m} disabled={!t || d.stale || !!mission || busy} onClick={() => t && void patch({ action: 'config', [k]: pointAhead(t, m) }, `${k === 'pickupPad' ? 'Pickup' : 'Drop'} pad set ${m} m ahead of the drone's nose. Re-arm with the checklist.`)}><Navigation size={14} />{m} m</button>)}</div>)}
            <div className="fleet-row-buttons fleet-ahead fleet-nudge"><label><span>Nudge</span><select value={nudgePad} onChange={e => setNudgePad(e.target.value as PadKey)} aria-label="Pad to nudge">{(['pickupPad', 'dropPad', 'home'] as PadKey[]).map(k => <option key={k} value={k}>{PAD_NAME[k]}</option>)}</select></label>{([['north', 1, 0, ArrowUp], ['south', -1, 0, ArrowDown], ['west', 0, -1, ArrowLeft], ['east', 0, 1, ArrowRight]] as const).map(([dir, n, e, Icon]) => { const at = d.config[nudgePad]; return <button key={dir} aria-label={`Move the ${PAD_NAME[nudgePad].toLowerCase()} 1 m ${dir}`} title={`1 m ${dir}`} disabled={!at || !!mission || busy} onClick={() => at && void patch({ action: 'config', [nudgePad]: pointOffset(at, n, e) }, `${PAD_NAME[nudgePad]} moved 1 m ${dir}. Re-arm with the checklist.`)}><Icon size={16} /></button>; })}<small>1 m per tap</small></div>
            <p className="fleet-hint">{mission ? 'Pads are locked while this drone has a mission. Finish it, or tap ABORT (on the ground ABORT never takes off), then move them.' : `Drag Home, Pickup or Drop on the map, nudge them 1 m at a time, or ${t ? `point the drone's nose where you want it to go (now ${Math.round(t.heading)}° ${compass(t.heading)}) and use the ahead buttons.` : 'set them from the drone once its telemetry arrives.'} Moving a pad disarms the drone.`}</p>
          </div>
          <div className="fleet-card mission">
            <h3>Mission</h3>
            {mission ? <>
              <div className="fleet-phase"><span className={mission.live!.fault ? 'warn' : ''}>{mission.live!.fault ? `Paused · ${mission.live!.fault.replace(/_/g, ' ').toLowerCase()}` : hover?.where === 'landed' ? 'On the ground at the customer’s pin · confirm the landing' : hover?.where === 'ground' ? 'On the ground away from the customer’s pin' : PHASE[phase!]}</span><small>{mission.package.retailer} return · {mission.package.address.split(',')[0]} · {pinFlight ? 'customer’s pin' : 'pickup pad'}</small></div>
              <div className="fleet-mission-buttons">
                {hover?.where === 'landed' ? <button className="ux-primary" disabled={busy} onClick={() => void patch({ action: 'land' }, 'Landing at the pin confirmed. Waiting for the customer to load.')}><PlaneLanding size={18} />It landed at the pin · continue</button> : hover && !grounded && <button className="ux-primary" disabled={busy || hover.where !== 'over'} onClick={() => void patch({ action: 'land' }, 'Landing at the customer’s pin.')}><PlaneLanding size={18} />Landing area clear · land</button>}
                {pinFlight && (phase === 'TO_PICKUP' || phase === 'HOVER_PICKUP') && !grounded && <button className="ux-secondary" disabled={busy || hover?.where === 'unknown'} onClick={() => void patch({ action: 'divert-pad' }, 'Flying to the pickup pad instead.')}><MapPin size={18} />Use the pickup pad instead</button>}
                {hover && <p className="fleet-hint">{hover.where === 'over' ? 'The drone holds over the pin, using battery, until you land it or send it to the pad. Land only once you can see the spot is clear.' : hover.where === 'landed' ? `The drone reports it is on the ground at the pin (${fmtMeters(hover.meters!)} away), landed by RC or by the bridge’s own failsafe. Continue once it is safe for the customer to load: AERO sends LAND, which only disarms it. Or end the flight with ABORT.` : hover.where === 'ground' ? `The drone reports it is on the ground ${fmtMeters(hover.meters!)} from the pin (an RC landing or the bridge’s link-loss return), so it cannot land there from here. End the flight with Return home or ABORT.` : hover.where === 'away' ? `The drone is ${fmtMeters(hover.meters!)} from the pin, so it cannot land there. Send it to the pickup pad, or bring it home with Return home or ABORT.` : 'No fresh report from the drone, so it cannot land from here. Wait for the link or use your RC transmitter. ABORT always works.'}</p>}
                {phase === 'READY_TO_LAUNCH' && <button className="ux-primary" disabled={busy} onClick={() => void patch({ action: 'launch' }, 'Launch sent.')}><Plane size={18} />Area clear · launch</button>}
                {phase === 'AWAITING_UNLOAD' && <button className="ux-primary" disabled={busy} onClick={() => takeoff({ action: 'unload' }, 'Unload confirmed. Drone heading home.')}><Package size={18} />Unloaded · send home</button>}
                {mission.live!.fault && <button className="ux-primary" disabled={busy} onClick={() => (phaseCommand(mission.live!, phase!)?.type === 'TAKEOFF' ? takeoff({ action: 'retry' }, 'Step re-sent.') : void patch({ action: 'retry' }, 'Step re-sent.'))}><RotateCcw size={18} />Retry this step</button>}
                {phase === 'AWAITING_LOAD' && <p className="fleet-hint">The customer confirms loading in their app. You launch after that.</p>}
              </div>
            </> : <>
              <p className="fleet-hint">Fly one of your active returns with this drone. The drone goes home → the customer’s pin (when pins are on and it is inside the pin zone) or the pickup pad → drop pad → home.</p>
              <div className="fleet-trip"><select value={chosen?.id ?? ''} onChange={e => setReturnId(e.target.value)} aria-label="Return to dispatch"><option value="">Choose a return…</option>{ready.map(r => <option key={r.id} value={r.id}>{returnLabel(r)}</option>)}{held.map(r => <option key={r.id} value={r.id} disabled>{returnLabel(r)} · waiting for a person</option>)}</select><button className="secondary" disabled={busy} onClick={() => void newTrip()}><Plus size={16} />New test trip</button></div>
              {held.length > 0 && <p className="fleet-hint fleet-landing"><UserRound size={14} /><span>{held.length === 1 ? '1 return is' : `${held.length} returns are`} waiting for a person, so {held.length === 1 ? 'it' : 'they'} can’t fly yet. Approve or decline on the <a href="/merchant">merchant desk</a> first.</span></p>}
              {chosenPickup && <p className={`fleet-hint fleet-landing ${chosenPickup.source}`}><MapPin size={14} /><span>{pickupPreview(chosenPickup)}</span></p>}
              <button className="ux-primary" disabled={!chosen || !chosenPickup?.point || busy} onClick={() => { if (chosen && chosenPickup?.point) takeoff({ action: 'dispatch', returnId: chosen.id, pickup: { source: chosenPickup.source, point: chosenPickup.point } }, 'Dispatched. Takeoff command sent.'); }}><Plane size={18} />Dispatch live flight</button>
              {!ready.length && !held.length && <p className="fleet-hint">No unloaded active returns. Tap New test trip, or <a href="/">book one in the customer app</a>.</p>}
            </>}
          </div>
          <div className="fleet-card safety">
            <h3>Pre-flight checklist</h3>
            {d.armed ? <div className="fleet-armed"><ShieldCheck size={18} /><span>Armed for live missions until {new Date(d.armedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><button disabled={busy} onClick={() => void patch({ action: 'disarm' }, 'Disarmed.')}>Disarm</button></div> : <>
              {CHECKS.map(([k, text]) => <label key={k} className="fleet-check"><input type="checkbox" checked={!!checks[k]} onChange={e => setChecks({ ...checks, [k]: e.target.checked })} /><span>{text}</span></label>)}
              <button className="ux-secondary" disabled={busy || CHECKS.some(([k]) => !checks[k])} onClick={() => void patch({ action: 'arm', checklist: checks }, 'Armed for 30 minutes.')}><ShieldCheck size={18} />Arm for 30 minutes</button>
            </>}
            {pinRadius > 0 && <p className="fleet-hint fleet-landing"><MapPin size={14} /><span>Pins: the drone can land within {fmtMeters(pinRadius)} of the pickup pad. You confirm each landing while it hovers.</span></p>}
          </div>
          <div className="fleet-card controls">
            <h3>Manual commands</h3>
            <div className="fleet-command-grid">
              <button disabled={busy} onClick={() => void patch({ action: 'command', type: 'PING' }, 'Ping sent.')}><Radio size={16} />Ping</button>
              <button disabled={busy} onClick={() => void patch({ action: 'command', type: 'HOLD' }, 'Hold sent.')}><Pause size={16} />Hold</button>
              <button disabled={busy} onClick={() => void patch({ action: 'command', type: 'LAND' }, 'Land sent.')}><PlaneLanding size={16} />Land</button>
              <button disabled={busy} onClick={() => takeoff({ action: 'command', type: 'RTL' }, 'Return-to-launch sent.')}><Undo2 size={16} />Return home</button>
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
            <div className="fleet-row-buttons"><button disabled={busy || !!mission} onClick={() => setConfirmRotate(true)}><KeyRound size={14} />Rotate key</button><button className="danger" disabled={busy || !!mission} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />Remove drone</button></div>
          </div>
        </div>
      </section> : <section className="fleet-main fleet-placeholder">{noticeBox}{!list ? listError ? <><TriangleAlert size={36} /><h2>Could not load your drones</h2><p role="alert">{listError}</p><button className="ux-secondary" onClick={() => void loadList().catch((e: Error) => setListError(e.message))}><RotateCcw size={16} />Try again</button></> : <p role="status">Loading your drones…</p> : list.drones.length ? <p>Loading drone…</p> : <><Crosshair size={36} /><h2>Connect a real drone</h2><p>AERO talks to PX4 and ArduPilot through a small bridge over 4G data or SMS. Every command is signed, geofenced and acknowledged.</p></>}</section>}
    </div>
    {registering && <Modal title="Register a drone" onClose={() => setRegistering(false)}><RegisterForm onDone={async (drone, key) => { setRegistering(false); setSecret({ drone, key }); await loadList(); choose(drone.id); }} /></Modal>}
    {secret && <Modal title="Save the drone key" onClose={() => setSecret(null)}><div className="fleet-secret"><p>This key signs every message between AERO and <strong>{secret.drone.name}</strong>. It’s shown once. Store it on the bridge, not in source control.</p><div className="fleet-key"><code>{secret.key}</code><button onClick={() => void navigator.clipboard.writeText(secret.key).then(() => say('ok', 'Key copied.'))}><Copy size={15} />Copy</button></div><pre>{bridgeCommand(secret.drone, location.origin, secret.key)}</pre><button className="ux-primary" onClick={() => setSecret(null)}>I saved it</button></div></Modal>}
    {confirmRotate && d && <Modal title="Rotate the key?" onClose={() => setConfirmRotate(false)}><div className="fleet-secret"><p>The bridge stops working until you install the new key on the companion computer. Commands still queued with the old key are dropped.</p><div className="fleet-row-buttons"><button onClick={() => setConfirmRotate(false)}>Keep current key</button><button className="danger" disabled={busy} onClick={() => { setConfirmRotate(false); void patch({ action: 'rotate-key' }, 'New key issued. The old key stops working.'); }}><KeyRound size={14} />Rotate key</button></div></div></Modal>}
    {askClear && d && <Modal title="Is the area around the drone clear of people?" onClose={() => setAskClear(null)}><div className="fleet-secret"><p>{away !== null && Number.isFinite(away) ? `The drone takes off from where it stands, ${fmtMeters(away)} from home.` : 'AERO has no position for the drone, so it may take off from where it stands.'} Make sure nobody is near it.</p><div className="fleet-row-buttons"><button onClick={() => setAskClear(null)}>Not yet</button><button className="danger" disabled={busy} onClick={() => { const next = askClear; setAskClear(null); void patch(next.body, next.success); }}><Plane size={14} />Area clear · send</button></div></div></Modal>}
    {confirmDelete && d && <Modal title={`Remove ${d.name}?`} onClose={() => setConfirmDelete(false)}><div className="fleet-secret"><p>This deletes the drone, its telemetry and its command log. The bridge stops being accepted.</p><div className="fleet-row-buttons"><button onClick={() => setConfirmDelete(false)}>Keep it</button><button className="danger" disabled={busy} onClick={() => void remove()}><Trash2 size={14} />Remove</button></div></div></Modal>}
  </main>;
}

function RegisterForm({ onDone }: { onDone: (drone: Drone, key: string) => void }) {
  const [form, setForm] = useState({ name: '', transport: 'https', phone: '', lat: '', lng: '', radius: '300', maxAlt: '60', cruiseAlt: '30' }), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  function locate() { navigator.geolocation?.getCurrentPosition(p => setForm(f => ({ ...f, lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) })), () => setError('Location unavailable. Type the home coordinates instead.'), { enableHighAccuracy: true, timeout: 10000 }); }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Checked here in plain words before anything is sent; the server checks again.
    const lat = Number(form.lat), lng = Number(form.lng);
    const problem = !form.lat.trim() || !Number.isFinite(lat) || Math.abs(lat) > 90 ? 'Home latitude must be a number between -90 and 90, such as 37.8719.' : !form.lng.trim() || !Number.isFinite(lng) || Math.abs(lng) > 180 ? 'Home longitude must be a number between -180 and 180, such as -122.2595.' : '';
    if (problem) { setError(problem); return; }
    setBusy(true); setError('');
    try {
      const body = { name: form.name, transport: form.transport, ...(form.transport === 'sms' ? { phone: form.phone.trim() } : {}), home: [lng, lat], radius: Number(form.radius), maxAlt: Number(form.maxAlt), cruiseAlt: Number(form.cruiseAlt) };
      const data = await api<{ drone: Drone; key: string }>('/api/fleet', { method: 'POST', body: JSON.stringify(body) });
      onDone(data.drone, data.key);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <form className="fleet-form" onSubmit={submit}>
    <label>Name<input required maxLength={40} value={form.name} onChange={set('name')} placeholder="X500 return drone" /></label>
    <fieldset><legend>Link</legend><label className="fleet-radio"><input type="radio" name="transport" checked={form.transport === 'https'} onChange={() => setForm({ ...form, transport: 'https' })} />4G data (HTTPS)</label><label className="fleet-radio"><input type="radio" name="transport" checked={form.transport === 'sms'} onChange={() => setForm({ ...form, transport: 'sms' })} />SMS only</label></fieldset>
    {form.transport === 'sms' && <label>Drone SIM phone number<input required value={form.phone} onChange={set('phone')} placeholder="+15105550123" inputMode="tel" /></label>}
    <div className="fleet-form-row"><label>Home latitude<input required type="number" step="any" min={-90} max={90} value={form.lat} onChange={set('lat')} placeholder="37.8719" /></label><label>Home longitude<input required type="number" step="any" min={-180} max={180} value={form.lng} onChange={set('lng')} placeholder="-122.2595" /></label></div>
    <button type="button" className="ux-secondary" onClick={locate}><LocateFixed size={16} />Use my current location</button>
    <div className="fleet-form-row three"><label>Geofence (m)<input required type="number" min={20} max={2000} value={form.radius} onChange={set('radius')} /></label><label>Max alt (m)<input required type="number" min={LIMITS.minCruise} max={LIMITS.maxAlt} step="any" value={form.maxAlt} onChange={set('maxAlt')} /></label><label>Cruise (m)<input required type="number" min={LIMITS.minCruise} max={LIMITS.maxAlt} step="any" value={form.cruiseAlt} onChange={set('cruiseAlt')} /></label></div>
    <p className="fleet-hint">Set the pickup and drop pads on the map after registering. 120 m (400 ft) is the hard altitude cap.</p>
    {error && <div className="fleet-notice error" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}
    <button className="ux-primary" disabled={busy}>{busy ? 'Registering…' : 'Register drone'}</button>
  </form>;
}
