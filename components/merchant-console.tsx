'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Footprints, Package, PackageCheck, Plane, ShieldCheck, Sparkles, Store, Timer, TriangleAlert, UserRound, X } from 'lucide-react';
import { useAccessibility } from './accessibility';
import { CONDITION_LABEL, CONFIDENT, confidencePct, formatDuration, MERCHANT_DISPOSITIONS, needsPersonQueue, needsPersonReasons, NO_CHECK, PERSON_APPROVED, PERSON_WAIT, reviewQuestions, type MerchantDisposition, type MerchantRow, type MerchantScope, type MerchantStage, type MerchantView } from '@/lib/merchant';
import { DISPOSITION_LABEL, VERDICT_LABEL, type ReturnReview } from '@/lib/return-agent-shared';

export type View = MerchantView & { limit: number; now: number; scope: MerchantScope };
const GH = 'https://github.com/kv1514/aero-returns';
const SCOPE: Record<MerchantScope, { whose: string; where: string }> = { browser: { whose: 'this browser’s returns', where: 'in this browser' }, demo: { whose: 'the demo account’s returns', where: 'in the demo account' }, account: { whose: 'your account’s returns', where: 'in your account' } };
const ANY_SCOPE = { whose: 'your returns', where: 'by you' };
const STAGE_TONE: Record<MerchantStage, string> = { Booked: '', 'Picked up': 'info', 'In flight': 'info', Received: 'good', Cancelled: 'muted' };
const VERDICT_TONE: Record<ReturnReview['verdict'], string> = { fly_standard: 'good', fly_priority: 'good', not_drone_eligible: 'bad', needs_person: 'warn' };
const DISPOSITION_TONE: Record<MerchantDisposition, string> = { restock: 'good', inspect: 'warn', refurbish: 'info', return_to_vendor: 'bad', 'awaiting check': 'muted' };
// A check can only run before booking, so a return without one is never "awaiting" it.
const dispositionLabel = (d: MerchantDisposition) => (d === 'awaiting check' ? NO_CHECK : DISPOSITION_LABEL[d]);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const confident = (c: number) => `${confidencePct(c)}% confident`;
function clock(ts: number | null, now: number) {
  if (!ts) return '—';
  const d = new Date(ts), today = new Date(now).toDateString() === d.toDateString();
  return d.toLocaleString([], today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const minutes = (min: number | null) => (min === null ? '—' : min < 10 ? `${min.toFixed(1)} min` : formatDuration(min));
/** Plain words for a failed load: the server's own message when it sent one. */
function failure(e: unknown, timedOut: boolean) {
  if (timedOut) return 'AirCart took too long to answer.';
  if (e instanceof TypeError) return 'Can’t reach AirCart. Check your connection.';
  return e instanceof Error && e.message ? e.message : 'Could not load the returns desk.';
}

function Flight({ row }: { row: MerchantRow }) {
  return row.live ? <span className="m-flight live"><i />Live flight{row.drone ? ` · ${row.drone}` : ''}</span> : <span className="m-flight"><Sparkles size={12} />Simulation{row.drone ? ` · ${row.drone}` : ''}</span>;
}
function Grade({ review }: { review: ReturnReview | null }) {
  if (!review) return <span className="m-sub">{NO_CHECK}</span>;
  // A flagged return keeps Claude's verdict; the person's decision is shown next to it, never in place of it.
  const decided = review.approvedAt ? ' · approved by a person' : review.declinedAt ? ' · declined by a person' : '';
  return <><span className={`m-pill ${VERDICT_TONE[review.verdict]}`}>{VERDICT_LABEL[review.verdict]}{decided}</span><span className="m-sub">{CONDITION_LABEL[review.condition]} · {confident(review.confidence)}</span></>;
}
function Kpi({ icon, label, value, note, tag, tone = '' }: { icon: React.ReactNode; label: string; value: React.ReactNode; note: string; tag?: string; tone?: string }) {
  return <div className={`merchant-kpi ${tone}`}><span className="m-label">{icon}{label}{tag && <b className="m-tag">{tag}</b>}</span><strong>{value}</strong><span className="m-sub">{note}</span></div>;
}

export type PollEnv = {
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
  document: { hidden: boolean; addEventListener(type: 'visibilitychange', fn: () => void): void; removeEventListener(type: 'visibilitychange', fn: () => void): void };
};
/**
 * Loads the desk now, every 5 s while the tab is visible, and when the tab is shown again; returns the cleanup.
 * A request stalled for 10 s is aborted and counts as a failure, so polling never stops on a hung request.
 * An expired session (401) does not fix itself: polling stops until the tab is shown again, e.g. after signing in elsewhere.
 */
export function pollDesk(on: { data: (view: View) => void; fail: (message: string, signedOut: boolean) => void }, env: PollEnv) {
  let active = true, request: AbortController | null = null, poll: ReturnType<typeof setInterval> | undefined;
  const start = () => { poll ??= setInterval(load, 5000); };
  const stop = () => { clearInterval(poll); poll = undefined; };
  function load() {
    if (request || env.document.hidden) return;
    const ctl = request = new AbortController(), timeout = setTimeout(() => ctl.abort(), 10_000);
    env.fetch('/api/merchant', { cache: 'no-store', headers: { Accept: 'application/json' }, signal: ctl.signal })
      .then(async res => { const data = await res.json().catch(() => ({})) as View & { error?: string }; if (!res.ok || !data.aggregates) throw Object.assign(new Error(data.error || 'Could not load the returns desk.'), { status: res.status }); return data; })
      .then(data => { if (active) { on.data(data); start(); } }, (e: unknown) => {
        if (!active) return;
        const signedOut = (e as { status?: number }).status === 401;
        on.fail(failure(e, ctl.signal.aborted), signedOut);
        if (signedOut) stop(); else start();
      })
      .finally(() => { clearTimeout(timeout); if (request === ctl) request = null; });
  }
  load(); start();
  env.document.addEventListener('visibilitychange', load);
  const cleanup = () => { active = false; stop(); request?.abort(); env.document.removeEventListener('visibilitychange', load); };
  return Object.assign(cleanup, { refresh: load });
}

export default function MerchantConsole() {
  useAccessibility();
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(''), [failures, setFailures] = useState(0), [halted, setHalted] = useState(false);
  const [deciding, setDeciding] = useState(''), [decision, setDecision] = useState(''), refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const poll = pollDesk({
      data: data => { setView(data); setError(''); setFailures(0); setHalted(false); },
      fail: (message, signedOut) => { setError(message); setFailures(f => f + 1); setHalted(signedOut); },
    }, { fetch: (url, init) => fetch(url, init), document });
    refresh.current = poll.refresh;
    return poll;
  }, []);
  async function decide(row: MerchantRow, action: Decision) {
    if (deciding) return;
    setDeciding(row.id); setDecision('');
    try {
      const res = await fetch(`/api/returns/${row.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ action }) });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Could not save that decision.');
      setDecision(`${row.shortId} ${action === 'approve' ? 'approved. Its drone can fly now.' : 'declined. No drone will fly for it.'}`);
      refresh.current();
    } catch (e) { setDecision(failure(e, false)); } finally { setDeciding(''); }
  }
  return <MerchantDesk view={view} error={error} offline={!!view && failures >= 3} halted={halted} onDecide={decide} deciding={deciding} decision={decision} />;
}
export type Decision = 'approve' | 'decline';

/** The desk itself, from one /api/merchant response. `halted` means polling stopped on an expired session. */
export function MerchantDesk({ view, error, offline, halted = false, onDecide, deciding = '', decision = '' }: { view: View | null; error: string; offline: boolean; halted?: boolean; onDecide?: (row: MerchantRow, action: Decision) => void; deciding?: string; decision?: string }) {
  const a = view?.aggregates, rows = view?.rows ?? [], now = view?.now ?? 0, queue = needsPersonQueue(rows);
  const scope = (view && SCOPE[view.scope]) || ANY_SCOPE, stale = !!view && (offline || halted);
  const mix = a ? Math.max(1, ...MERCHANT_DISPOSITIONS.map(d => a.byDisposition[d])) : 1;
  // "Live" means the signed drone link, not proof that an aircraft flew; the trust panel says so.
  const simulated = a ? a.received - a.liveReceived : 0, plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const receivedSplit = !a?.received ? '' : !a.liveReceived ? 'Received: all simulated · ' : !simulated ? 'Received: all over the drone link · ' : `Received: ${simulated} simulated, ${a.liveReceived} over the drone link · `;
  return <main className="merchant">
    <header className="merchant-top">
      <a href="/" className="merchant-back"><ArrowLeft size={18} />Customer app</a>
      <h1><Store size={20} />AirCart Merchant · Returns desk</h1>
      <div className="merchant-status">
        <span className="merchant-chip demo"><i />Demo merchant view of {scope.whose}</span>
        <span className={`merchant-chip ${halted || offline ? 'warn' : ''}`}>{halted ? 'Not refreshing' : offline ? 'Offline · retrying' : view ? `Updated ${new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'Connecting…'}</span>
      </div>
    </header>
    <div className="merchant-body">
      <section className="merchant-intro">
        <h2>Returns that come back to you, not to a store counter.</h2>
        <p>Customers hand off a return from home, with no car or store trip. When they run the Claude return check before booking, its advisory grade travels with the package, so your team knows what to restock, inspect or send back before it lands.</p>
      </section>
      {stale && <div className="merchant-notice error" role="alert"><TriangleAlert size={16} /><span>{error} {halted ? 'The desk stopped refreshing and shows the last data received. It checks again when you come back to this tab.' : 'Showing the last data received while the desk retries.'}</span></div>}
      {error && !view && <div className="merchant-notice error" role="alert"><TriangleAlert size={16} /><span>{error} {halted ? 'The desk checks again when you come back to this tab.' : 'Retrying every 5 seconds.'}</span></div>}
      {!view && !error && <div className="merchant-card merchant-loading" role="status">Loading returns…</div>}
      {a && <>
        <section className="merchant-kpis" aria-label="Returns desk summary">
          <Kpi icon={<PackageCheck size={15} />} label="Returns received" value={a.received} note={`${receivedSplit}${a.total} booked${a.cancelled ? ` · ${a.cancelled} cancelled` : ''}`} />
          <Kpi icon={<Plane size={15} />} label="In flight" value={a.inFlight} note="Loaded and on the way" />
          <Kpi icon={<UserRound size={15} />} label="Needs a person" value={a.needsPerson} note={a.needsPerson ? 'Waiting for a person' : 'Nothing waiting'} tone={a.needsPerson ? 'warn' : ''} />
          <Kpi icon={<Footprints size={15} />} label="Store trips avoided" tag="Demo" value={a.storeTripsAvoided} note="Assumes one per received return, simulated or live" />
          <Kpi icon={<Timer size={15} />} label="Time saved" tag="Estimate" value={formatDuration(a.estimatedMinutesSaved)} note={`Demo assumption: ${a.minutesPerTrip} min per avoided trip`} />
        </section>
        {a.total > 0 && <section className="merchant-insights">
          <div className="merchant-card"><span className="m-label">Checked by Claude</span><strong className="m-figure">{a.total ? pct(a.checkedByClaude) : '—'}</strong><span className="m-sub">{a.checked} of {a.total} returns carried an advisory Claude check from booking.</span></div>
          <div className="merchant-card"><span className="m-label">Booking → received</span><strong className="m-figure">{minutes(a.avgMinutesToReceipt)}</strong><span className="m-sub">{!a.received ? 'No returns received yet.' : `Average over ${plural(a.received, 'received return', 'received returns')}. ${!a.liveReceived ? 'All are simulated flights; demo speed controls shorten them.' : !simulated ? 'All ran over the live drone link.' : `${simulated} simulated (demo speed controls shorten them) and ${a.liveReceived} over the live drone link.`}`}</span></div>
          <div className="merchant-card merchant-mix"><span className="m-label">Expected disposition</span>
            <ul>{MERCHANT_DISPOSITIONS.map(d => <li key={d}><span>{dispositionLabel(d)}</span><span className="m-bar" aria-hidden="true"><i style={{ width: `${a.byDisposition[d] / mix * 100}%` }} /></span><b>{a.byDisposition[d]}</b></li>)}</ul>
            <span className="m-sub">Active and received returns, from Claude’s advisory grade. Your team decides.</span>
          </div>
        </section>}
        {view.skipped > 0 && <div className="merchant-notice" role="status"><TriangleAlert size={16} /><span>{view.skipped} stored {view.skipped === 1 ? 'return' : 'returns'} could not be read and {view.skipped === 1 ? 'is' : 'are'} not counted.</span></div>}
        {!a.total ? <section className="merchant-card merchant-empty"><Package size={32} /><h2>No returns yet</h2><p>Book a return in the customer app. It appears here as soon as it is booked, then moves from Booked to Received as the drone brings it to the drop-off.</p><a href="/" className="ux-primary">Book a return<ArrowRight size={18} /></a></section> : <>
          <section className="merchant-card merchant-queue" aria-labelledby="merchant-queue-title">
            <div className="merchant-card-head"><h2 id="merchant-queue-title"><UserRound size={18} />Needs a person</h2><span className={`m-count ${queue.length ? 'warn' : ''}`} aria-live="polite">{queue.length}<span className="m-sr"> {queue.length === 1 ? 'return' : 'returns'} waiting for a person</span></span></div>
            <p className="m-hint">AirCart’s rules send a return to a person when Claude is under {CONFIDENT * 100}% confident, the item may not match its description, it may be damaged or its condition is unclear, Claude finds it may be outside the drone limits, or Claude asks for a person’s judgement. Its drone stays on the ground, simulated or live, until someone approves it here. Declining cancels the pickup. Longest-waiting first.</p>
            <p className="m-hint m-demo-note"><b className="m-tag">Demo</b> You are the reviewer here, signed in as the customer. A retailer would review from its own staff account.</p>
            {decision && <div className="merchant-notice" role="status"><Check size={16} /><span>{decision}</span></div>}
            {queue.length ? <ol className="merchant-queue-list">{queue.map(r => { const review = r.review!; return <li key={r.id}>
              <div className="m-queue-head"><strong>{r.shortId}</strong><span className="m-sub">{r.retailer}{r.reference ? ` · ${r.reference}` : ''}</span><span className={`m-pill ${STAGE_TONE[r.stage]}`}>{r.stage}</span><Flight row={r} /></div>
              <p className="m-wait"><UserRound size={14} />{PERSON_WAIT}</p>
              <p className="m-queue-grade">{CONDITION_LABEL[review.condition]} · {confident(review.confidence)} · Suggested: {DISPOSITION_LABEL[review.disposition]}</p>
              <ul className="m-reasons">{needsPersonReasons(review).map(reason => <li key={reason}>{reason}</li>)}</ul>
              {/* Shown in full before Approve/Decline. Claude wrote it before booking and can't change booking details, so it is labelled as its note. */}
              {review.explanation && <figure className="m-note"><figcaption>Claude’s note from the return check · advisory. Claude can’t change the booking; any setting it mentions is a suggestion.</figcaption><blockquote className="m-explain">“{review.explanation}”</blockquote></figure>}
              {reviewQuestions(review).length > 0 && <div className="m-questions"><span className="m-label">Claude’s questions to confirm before pickup</span><ul>{reviewQuestions(review).map(q => <li key={q}>{q}</li>)}</ul></div>}
              <span className="m-audit">Checked {clock(review.at, now)} · {review.model} · audit event {review.eventId.slice(0, 8)}</span>
              {onDecide && <div className="m-decide">
                <button className="m-approve" aria-label={`Approve ${r.shortId} for drone pickup`} disabled={!!deciding || stale} onClick={() => onDecide(r, 'approve')}><Check size={16} />{deciding === r.id ? 'Saving…' : 'Approve for drone pickup'}</button>
                <button className="m-decline" aria-label={`Decline ${r.shortId} for drone pickup`} disabled={!!deciding || stale} onClick={() => onDecide(r, 'decline')}><X size={16} />Decline</button>
              </div>}
            </li>; })}</ol> : <div className="merchant-clear"><ShieldCheck size={18} />No returns are waiting for a person.</div>}
          </section>
          <section className="merchant-card merchant-returns" aria-labelledby="merchant-returns-title">
            <div className="merchant-card-head"><h2 id="merchant-returns-title"><Package size={18} />All returns</h2><span className="m-sub">{a.total} booked {scope.where} · newest first{a.total + view.skipped >= view.limit ? ` · latest ${view.limit} shown` : ''}</span></div>
            <p className="m-hint m-legend"><span className="m-flight"><Sparkles size={12} />Simulation</span> AirCart’s demo flight model; no drone flew. <span className="m-flight live"><i />Live flight</span> Sent over the signed drone link from the Fleet console; the vehicle may be a simulator.</p>
            {/* Explicit roles keep table semantics when the phone layout restyles rows as cards. */}
            <div className="merchant-table-wrap"><table className="merchant-table" role="table" aria-labelledby="merchant-returns-title">
              <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Return</th><th scope="col" role="columnheader">Stage</th><th scope="col" role="columnheader">Claude grade</th><th scope="col" role="columnheader">Disposition</th><th scope="col" role="columnheader">Booked</th><th scope="col" role="columnheader">Picked up</th><th scope="col" role="columnheader">Received</th></tr></thead>
              <tbody role="rowgroup">{rows.map(r => <tr key={r.id} role="row" className={r.needsPerson ? 'flag' : ''}>
                <th scope="row" role="rowheader" data-label="Return"><strong>{r.shortId}</strong><span className="m-sub">{r.retailer}{r.reference ? ` · ${r.reference}` : ''}</span><Flight row={r} /></th>
                <td role="cell" data-label="Stage"><span className={`m-pill ${STAGE_TONE[r.stage]}`}>{r.stage}</span><span className="m-sub">{r.status} · {r.destination}</span></td>
                <td role="cell" data-label="Claude grade"><Grade review={r.review} /></td>
                <td role="cell" data-label="Disposition"><span className={`m-pill ${DISPOSITION_TONE[r.disposition]}`}>{dispositionLabel(r.disposition)}</span>{r.needsPerson ? <span className="m-sub">Suggested · {PERSON_WAIT}</span> : r.approvedAt ? <span className="m-sub">Suggested · {PERSON_APPROVED}</span> : null}</td>
                <td role="cell" data-label="Booked">{clock(r.createdAt, now)}</td>
                <td role="cell" data-label="Picked up">{clock(r.loadedAt, now)}</td>
                <td role="cell" data-label="Received">{clock(r.receivedAt, now)}</td>
              </tr>)}</tbody>
            </table></div>
          </section>
        </>}
      </>}
      <section className="merchant-trust" aria-labelledby="merchant-trust-title">
        <h2 id="merchant-trust-title"><ShieldCheck size={18} />What this desk does and doesn’t do</h2>
        <ul>
          <li><strong>No refunds are issued.</strong> AirCart never approves a return, charges or refunds anyone. Refunds stay with your existing returns process.</li>
          <li><strong>Claude grades are advisory.</strong> They come from the customer’s description and any photos before pickup, inside AirCart’s fixed drone limits. A “needs a person” return stays on the ground until someone approves or declines it on this desk, and live dispatch from Fleet is blocked until then. Nothing is restocked or rejected automatically.</li>
          <li><strong>Simulation and live flights are labelled.</strong> Simulated returns follow AirCart’s demo flight model; no drone flies. A live flight row ran through the signed drone link from the <a href="/fleet">Fleet console</a>. AirCart’s record doesn’t show whether a real aircraft or a simulator answered: test missions use scripted acknowledgements or the bridge’s simulated vehicle.</li>
          <li><strong>Demo data.</strong> This view shows the latest {view?.limit ?? 100} returns booked {scope.where}, not a retailer’s account, and no customer addresses. Store trips avoided and time saved are estimates, not measurements. <a href={`${GH}/blob/main/lib/merchant.ts`} target="_blank" rel="noreferrer">How each number is counted<ArrowUpRight size={12} /></a></li>
        </ul>
      </section>
    </div>
  </main>;
}
