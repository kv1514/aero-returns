'use client';
import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Check, ChevronDown, ImagePlus, Info, LoaderCircle, RefreshCw, Sparkles, Store, TriangleAlert, UserRound, X, Zap } from 'lucide-react';
import type { PackageInput } from '@/lib/simulation';
import { DISPOSITION_LABEL, VERDICT_LABEL, type AgentDecision, type AgentStep, type Eligibility, type Verdict } from '@/lib/return-agent-shared';
import { bookingProblem } from '@/lib/booking-draft';
import { validProductURL } from '@/lib/integrations';
import { resizeImage, type PreparedImage } from '@/lib/image-resize';

/** One finished Claude check, tied to the package details it was made from. Kept by Booking so it survives wizard steps. */
export type ReturnCheckResult = { eventId: string; source: string; model: string; decision: AgentDecision; eligibility: Eligibility; steps: AgentStep[]; key: string; evidenceChanged: boolean; at: number };

// ---------- Pure helpers (unit-tested in tests/return-check.test.ts) ----------
/** The package fields a check depends on. Changing any of them makes the result stale. */
export const checkKey = (p: PackageInput) => JSON.stringify([p.retailer, p.method, p.weight, p.dimensions, p.fragile, p.service]);
export const isFresh = (r: ReturnCheckResult | null, p: PackageInput): r is ReturnCheckResult => !!r && !r.evidenceChanged && r.key === checkKey(p);
/** Only a fresh check is attached to a booking; the server re-verifies that the event belongs to this owner. */
export const freshEventId = (r: ReturnCheckResult | null, p: PackageInput) => (isFresh(r, p) ? r.eventId : undefined);
/**
 * Choosing a service keeps a fresh result when AERO's limit check allows that tier: the check covers Standard and
 * Priority whichever was selected, and the server gate ignores the selection. A tier the check ruled out goes stale.
 */
export const withService = (r: ReturnCheckResult | null, p: PackageInput, service: PackageInput['service']) => (r && isFresh(r, p) && r.eligibility[service].eligible ? { ...r, key: checkKey({ ...p, service }) } : r);
/** The customer-side wording for a needs_person verdict; the merchant desk uses its own matching line. */
export const PERSON_NOTE = 'A person will review this return before the drone flies.';
/** The server's own source label (e.g. “live Claude API”) and model. Nothing is claimed when the server didn't say. */
export const sourceLabel = (r: Pick<ReturnCheckResult, 'source' | 'model'>) => [r.source ? r.source.charAt(0).toUpperCase() + r.source.slice(1) : '', r.model || 'Claude'].filter(Boolean).join(' · ');
export const defaultDescription = (p: PackageInput) => `${p.retailer} return${p.returnReference?.trim() ? ` (reference ${p.returnReference.trim()})` : ''}. Item: `;
export const VERDICT_TONE: Record<Verdict, 'green' | 'blue' | 'red' | 'amber'> = { fly_standard: 'green', fly_priority: 'blue', not_drone_eligible: 'red', needs_person: 'amber' };
/** UI stages only: they describe what usually happens, not events reported by the server. */
export const stagesFor = (photos: number) => [photos ? 'Reading your photos…' : 'Reading your description…', 'Checking AERO’s drone limits…', 'Deciding…'];
const PERSON_CONFIDENCE = .85;

export function checkProblem(description: string, productUrl: string, pkg: PackageInput) {
  const text = description.trim();
  if (text.length < 3) return 'Describe the item in a few words first.';
  if (text === defaultDescription(pkg).trim()) return 'Add what the item is and its condition, for example “Wireless headphones, opened once”.';
  const problem = bookingProblem(pkg); if (problem) return `Finish the details above first. ${problem}`;
  if (pkg.weight > 20 || pkg.dimensions.some(d => d > 150)) return 'Claude can check parcels up to 20 kg and 150 cm per side. This one is beyond every AERO drone, so booking a drone won’t work for it.';
  if (productUrl.trim()) { try { validProductURL(productUrl.trim()); } catch (e) { return e instanceof Error ? e.message : 'Use a public HTTPS product page.'; } }
  return '';
}
/** The package exactly as the API schema expects it: no booking-only fields, trimmed text. */
export function checkPackage(p: PackageInput): PackageInput {
  const ref = p.returnReference?.trim();
  return { retailer: p.retailer, method: p.method, weight: p.weight, dimensions: p.dimensions, fragile: p.fragile, address: p.address.trim(), pickup: p.pickup, instructions: p.instructions, service: p.service, ...(ref ? { returnReference: ref } : {}) };
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
const triple = (v: unknown) => (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? v as number[] : null);
const fmt = (n: number) => String(Math.round(n * 100) / 100);
const has = (o: object, k: unknown) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** Validates the API answer before anything is shown or attached; a malformed answer is treated as no answer. */
export function parseAgentResponse(data: unknown, key: string, at: number): ReturnCheckResult | null {
  const d = rec(data), x = rec(d.decision), e = rec(d.eligibility);
  const confidence = num(x.confidence);
  if (!str(d.eventId, 100) || !has(VERDICT_LABEL, x.verdict) || !has(DISPOSITION_LABEL, x.disposition) || confidence === null || typeof x.explanation !== 'string' || !Array.isArray(x.checks) || !Array.isArray(x.questions)) return null;
  const tier = (t: unknown) => { const r = rec(t); if (typeof r.eligible !== 'boolean') return null; const f = rec(r.facility); return { eligible: r.eligible, reasons: Array.isArray(r.reasons) ? r.reasons.filter((s): s is string => typeof s === 'string') : [], facility: str(f.name) ? { name: str(f.name, 120), minutes: num(f.minutes) ?? 0, price: num(f.price) ?? 0 } : null }; };
  const standard = tier(e.standard), priority = tier(e.priority);
  if (!standard || !priority) return null;
  const m = rec(e.measured), l = rec(e.limits);
  const eligibility = { measured: { weightKg: num(m.weightKg) ?? 0, dimensionsCm: (triple(m.dimensionsCm) ?? [0, 0, 0]) as [number, number, number], fragile: m.fragile === true }, limits: { standard: { maxKg: num(rec(l.standard).maxKg) ?? 2.5, maxSideCm: num(rec(l.standard).maxSideCm) ?? 45 }, priority: { maxKg: num(rec(l.priority).maxKg) ?? 5, maxSideCm: num(rec(l.priority).maxSideCm) ?? 60 } }, standard, priority } as Eligibility;
  const decision: AgentDecision = {
    verdict: x.verdict as Verdict, condition: (str(x.condition, 20) || 'unknown') as AgentDecision['condition'], matchesDescription: x.matchesDescription === true, confidence: Math.min(1, Math.max(0, confidence)),
    checks: x.checks.map(rec).filter(c => str(c.label)).map(c => ({ label: str(c.label, 80), ok: c.ok === true, detail: str(c.detail) })),
    questions: x.questions.filter((q): q is string => typeof q === 'string' && !!q.trim()).map(q => q.slice(0, 200)),
    disposition: x.disposition as AgentDecision['disposition'], explanation: x.explanation.slice(0, 1200),
  };
  const steps = (Array.isArray(d.steps) ? d.steps : []).map(rec).filter(s => str(s.tool)).map(s => ({ tool: str(s.tool, 60), input: rec(s.input), output: rec(s.output) }));
  return { eventId: str(d.eventId, 100), source: str(d.source, 60), model: str(d.model, 80) || 'Claude', decision, eligibility, steps, key, evidenceChanged: false, at };
}
export function failureFor(status: number, data: unknown): { setup: boolean; message: string } {
  const d = rec(data), error = str(d.error, 400);
  if (status === 503 && d.needsSetup === true) return { setup: true, message: '' };
  if (status === 429) return { setup: false, message: error || 'Claude checks are limited per hour. Try again later. You can book now without one.' };
  return { setup: false, message: error || (status === 413 ? 'Those photos are too large together. Remove one and try again.' : 'The check didn’t finish. Try again, or book with your details. The check is optional.') };
}
/**
 * Reasons arrive per hub, so they repeat and include hub-only ones (a hub switched off, a smaller hub's lower cap).
 * When size or weight is the problem, show only the most generous limit that was exceeded; otherwise the hub reasons.
 */
const FACILITY_ONLY = new Set(['Not enabled for drone handoff', 'Currently unavailable']);
const limitOf = (r: string) => Number(/([\d.]+)\s*(?:kg|cm)/.exec(r)?.[1] ?? 0);
const loosest = (list: string[]) => [...list].sort((a, b) => limitOf(b) - limitOf(a))[0];
export function packageReasons(reasons: string[]) {
  const own = reasons.filter(r => !FACILITY_ONLY.has(r)), kg = own.filter(r => /payload limit/i.test(r)), cm = own.filter(r => /dimension must be/i.test(r));
  if (kg.length || cm.length) return [kg.length ? loosest(kg) : '', cm.length ? loosest(cm) : ''].filter(Boolean);
  return own.length ? own : reasons;
}
/** The server's limit check lists every hub's reason for Priority; show the package's own reasons, as the action box does. */
export const checkDetail = (c: AgentDecision['checks'][number]) => (!c.ok && /drone limit/i.test(c.label) && c.detail ? packageReasons(c.detail.split('; ')).join('; ') : c.detail);
export function whyNotEligible(e: Eligibility) {
  return (['standard', 'priority'] as const).filter(t => !e[t].eligible).map(t => ({ tier: t === 'standard' ? 'Standard' : 'Priority', limits: `up to ${e.limits[t].maxKg} kg, ${e.limits[t].maxSideCm} cm per side`, reasons: packageReasons(e[t].reasons) }));
}
/** Why the server sent this to a person, using the same thresholds as gateDecision. */
export function personReasons(d: AgentDecision) {
  const out: string[] = [];
  if (d.confidence < PERSON_CONFIDENCE) out.push(`Claude was ${Math.round(d.confidence * 100)}% sure; AERO asks a person below ${PERSON_CONFIDENCE * 100}%.`);
  if (!d.matchesDescription) out.push('The photos may not match your description.');
  if (d.condition === 'damaged') out.push('The item may be damaged.');
  if (d.condition === 'unknown') out.push('Its condition couldn’t be judged from what you shared.');
  return out.length ? out : ['Claude saw something AERO’s size rules don’t cover, so a person decides.'];
}
const TOOL_TITLE: Record<string, string> = { check_drone_eligibility: 'Checked AERO’s drone limits', lookup_product_specs: 'Looked up the product page' };
export type StepView = { title: string; by: string; used: string[]; results: string[] };
/** Plain-language view of one tool call: what it used and what came back, per tier for the limit check. */
export function describeStep(step: AgentStep, entered?: PackageInput): StepView {
  const input = rec(step.input), output = rec(step.output), error = str(output.error);
  const byServer = input.by === 'server';
  const view: StepView = { title: TOOL_TITLE[step.tool] || step.tool.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), by: byServer ? 'AERO ran this itself because Claude skipped it' : 'Claude asked · AERO ran it', used: [], results: [] };
  if (step.tool === 'check_drone_eligibility') {
    const kg = num(input.weightKg), dims = triple(input.dimensionsCm);
    if (kg !== null) view.used.push(`${fmt(kg)} kg`);
    if (dims) view.used.push(`${dims.map(fmt).join(' × ')} cm`);
    if (typeof input.fragile === 'boolean') view.used.push(input.fragile ? 'fragile' : 'not fragile');
    if (entered && kg !== null && dims && (kg !== entered.weight || dims.some((v, i) => v !== entered.dimensions[i]))) view.used.push(`you entered ${fmt(entered.weight)} kg, ${entered.dimensions.map(fmt).join(' × ')} cm`);
    if (error) { view.results.push(`Not run: ${error}`); return view; }
    const limits = rec(output.limits);
    for (const t of ['standard', 'priority'] as const) {
      const tier = rec(output[t]), lim = rec(limits[t]), name = t === 'standard' ? 'Standard' : 'Priority';
      const cap = num(lim.maxKg) !== null ? ` (up to ${num(lim.maxKg)} kg, ${num(lim.maxSideCm)} cm)` : '';
      if (typeof tier.eligible !== 'boolean') continue;
      const f = rec(tier.facility), reasons = Array.isArray(tier.reasons) ? tier.reasons.filter((r): r is string => typeof r === 'string') : [];
      view.results.push(tier.eligible ? `${name}${cap}: fits${str(f.name) ? ` · ${str(f.name, 120)}` : ''}${num(f.minutes) !== null ? ` · about ${num(f.minutes)} min` : ''}` : `${name}${cap}: ruled out · ${packageReasons(reasons).join('; ') || 'no compatible facility'}`);
    }
    return view;
  }
  if (step.tool === 'lookup_product_specs') {
    try { if (str(input.url, 2000)) view.used.push(new URL(str(input.url, 2000)).hostname); } catch { view.used.push('the product link'); }
    if (error) view.results.push(error);
    else if (output.available === false) view.results.push(`Lookup failed: ${str(output.reason) || 'no details'}. Claude used your measurements.`);
    else {
      const w = num(output.weightKg), d = triple(output.dimensionsCm);
      if (str(output.title)) view.results.push(str(output.title, 160));
      view.results.push(w !== null ? `Published weight ${fmt(w)} kg` : 'Weight not published');
      view.results.push(d ? `Published size ${d.map(fmt).join(' × ')} cm (unpacked item)` : 'Size not published');
    }
    return view;
  }
  const brief = (o: Record<string, unknown>) => Object.entries(o).slice(0, 4).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80)}`);
  view.used = brief(input); view.results = error ? [error] : brief(output);
  return view;
}
const DISPOSITION_NOTE: Record<AgentDecision['disposition'], string> = { restock: 'Looks ready to go back on sale, so the merchant can plan to restock it on arrival.', inspect: 'Worth a quick look before it goes back on sale.', refurbish: 'Likely needs cleaning or repair before resale.', return_to_vendor: 'Likely goes back to the supplier rather than onto the shelf.' };

// ---------- Component ----------
type Photo = PreparedImage & { id: number; name: string };
type Props = { pkg: PackageInput; result: ReturnCheckResult | null; onResult: Dispatch<SetStateAction<ReturnCheckResult | null>>; onService: (service: PackageInput['service']) => void; onBusy?: (busy: boolean) => void; hidden?: boolean };
export default function ReturnCheck({ pkg, result, onResult, onService, onBusy, hidden = false }: Props) {
  const id = useId();
  const [open, setOpen] = useState(!!result), [text, setText] = useState<string | null>(null), [url, setUrl] = useState(''), [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false), [stage, setStage] = useState(0), [preparing, setPreparing] = useState(false), [dragging, setDragging] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [setup, setSetup] = useState<'unknown' | 'ready' | 'missing'>('unknown'), [lookup, setLookup] = useState<boolean | null>(null);
  // Mutable run state: the active request, its stage timers, an evidence revision counter and photo ids.
  const live = useRef({ controller: null as AbortController | null, timers: [] as number[], rev: 0, photoId: 0, status: false });
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => { const l = live.current; return () => { const c = l.controller; l.controller = null; c?.abort(); l.timers.forEach(clearTimeout); }; }, []);
  const description = text ?? defaultDescription(pkg), fresh = isFresh(result, pkg), stages = stagesFor(photos.length);
  /** Any edit to the evidence retires a finished result (it described other photos or text) and marks one still in flight. */
  const touched = () => { live.current.rev++; onResult(r => (r && !r.evidenceChanged ? { ...r, evidenceChanged: true } : r)); };
  function toggle() {
    const next = !open; setOpen(next);
    if (next && !live.current.status) {
      live.current.status = true;
      // Configuration flags are reported even with a session error, so the setup state is known before anyone fills the form.
      fetch('/api/integrations').then(r => r.json()).then((d: unknown) => { const x = rec(d); if (typeof x.anthropic === 'boolean') setSetup(s => (s === 'unknown' ? (x.anthropic ? 'ready' : 'missing') : s)); if (typeof x.apify === 'boolean') setLookup(x.apify); }).catch(() => {});
    }
  }
  async function addPhotos(list: FileList | File[] | null) {
    const files = Array.from(list || []), room = 3 - photos.length; if (!files.length || preparing) return;
    setError(''); setNotice(files.length > room ? `Only 3 photos fit, so ${files.length - Math.max(room, 0)} ${files.length - Math.max(room, 0) === 1 ? 'was' : 'were'} skipped.` : '');
    if (room <= 0) return;
    setPreparing(true);
    const added: Photo[] = [], problems: string[] = [];
    for (const file of files.slice(0, room)) { try { added.push({ ...(await resizeImage(file)), id: ++live.current.photoId, name: file.name }); } catch (e) { problems.push(e instanceof Error ? e.message : 'Could not read that photo.'); } }
    setPhotos(p => [...p, ...added].slice(0, 3)); setPreparing(false);
    if (added.length) touched();
    if (problems.length) setError(problems[0]);
  }
  function removePhoto(photoId: number) { setPhotos(p => p.filter(x => x.id !== photoId)); touched(); }
  function stopTimers() { const l = live.current; l.timers.forEach(clearTimeout); l.timers = []; }
  /** Booking shows on Review whether a check is still running. */
  function running(on: boolean) { setBusy(on); onBusy?.(on); }
  function stop() { const l = live.current, c = l.controller; l.controller = null; c?.abort(); stopTimers(); running(false); setNotice('Stopped waiting. The check may still finish on AERO’s server and counts toward the hourly limit.'); }
  async function check() {
    const problem = checkProblem(description, url, pkg); if (problem) { setError(problem); return; }
    const l = live.current; l.controller?.abort(); stopTimers();
    const controller = new AbortController(), rev = l.rev, key = checkKey(pkg);
    l.controller = controller;
    let timedOut = false;
    // An earlier result stays (and stays attached while it matches) until a new one arrives, so a failed re-run loses nothing.
    running(true); setStage(0); setError(''); setNotice('');
    l.timers = [window.setTimeout(() => setStage(1), photos.length ? 4000 : 2000), window.setTimeout(() => setStage(2), 11000), window.setTimeout(() => { timedOut = true; controller.abort(); }, 120000)];
    try {
      const res = await fetch('/api/return-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ description: description.trim().slice(0, 1000), ...(url.trim() ? { productUrl: url.trim() } : {}), package: checkPackage(pkg), images: photos.map(({ mediaType, data }) => ({ mediaType, data })) }) });
      const data: unknown = await res.json().catch(() => null);
      if (l.controller !== controller) return; // stopped, replaced, or the dialog closed
      if (!res.ok) { const f = failureFor(res.status, data); if (f.setup) setSetup('missing'); else setError(f.message); return; }
      const parsed = parseAgentResponse(data, key, Date.now());
      if (!parsed) { setError('AERO got an incomplete answer from the check. Try again, or book with your details.'); return; }
      setSetup('ready'); onResult({ ...parsed, evidenceChanged: l.rev !== rev });
    } catch {
      if (l.controller !== controller) return;
      setError(timedOut ? 'The check took more than two minutes, so AERO stopped waiting. Try again, or book with your details. The check is optional.' : 'Could not reach AERO. Check your connection and try again.');
    } finally {
      if (l.controller === controller) { l.controller = null; stopTimers(); running(false); }
    }
  }

  const d = result?.decision, tone = d ? VERDICT_TONE[d.verdict] : 'amber';
  const liveText = busy ? stages[stage] : result ? `Check finished: ${VERDICT_LABEL[result.decision.verdict]}${fresh ? '' : '. Details changed, check again'}.` : setup === 'missing' ? 'Claude check is not set up on this server.' : '';
  return <section className="return-check" hidden={hidden} aria-labelledby={`${id}-title`}>
    <style>{CSS}</style>
    <p className="rc-sr" role="status" aria-live="polite">{liveText}</p>
    <button type="button" className="rc-head" aria-expanded={open} aria-controls={`${id}-body`} onClick={toggle}>
      <span className="rc-icon" aria-hidden="true"><Sparkles size={18}/></span>
      <span className="rc-head-text"><strong id={`${id}-title`}>Not sure it can fly? Let Claude check</strong><span className="rc-sub">Optional · a short description and photos · about 10–40 seconds</span>
        {/* Under the subtitle rather than beside it, so a narrow card doesn't squeeze the title. */}
        {result && !open && <span className={`rc-chip tone-${fresh ? tone : 'amber'}`}><i/>{fresh ? VERDICT_LABEL[result.decision.verdict] : 'Check again'}</span>}</span>
      {busy && !open && <LoaderCircle className="spin" size={18} aria-hidden="true"/>}
      <ChevronDown className="rc-chev" size={18} aria-hidden="true"/>
    </button>
    <div id={`${id}-body`} className="rc-body" hidden={!open}>
      {setup === 'missing' ? <div className="rc-setup"><Info size={18} aria-hidden="true"/><div><strong>Claude check isn’t switched on for this AERO server</strong><p>It needs an Anthropic API key, set as the server secret <code>ANTHROPIC_API_KEY</code>. Nothing else changes: book with the details above, and AERO’s drone limits still decide which drone can fly.</p></div></div> : <>
        {/* Hints sit outside the <label> so they are read once, as descriptions, not as part of the field's name. */}
        <div className="rc-field"><label htmlFor={`${id}-desc`}>What are you returning?</label><textarea id={`${id}-desc`} rows={3} maxLength={1000} value={description} aria-describedby={`${id}-desc-hint`} onChange={e => { setText(e.target.value); touched(); }}/><span className="rc-hint" id={`${id}-desc-hint`}>Say what the item is and its condition, for example “Wireless headphones, opened once, original box”.</span></div>
        <div className="rc-field" role="group" aria-labelledby={`${id}-photos`}>
          <span id={`${id}-photos`}>Photos <span className="rc-hint">(optional, up to 3)</span></span>
          <div className={`rc-photos ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); if (!dragging) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); void addPhotos(e.dataTransfer.files); }}>
            {photos.map((p, i) => <div className="rc-thumb" key={p.id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- in-memory data URL preview, nothing to optimise */}
              <img src={p.preview} alt={`Photo ${i + 1} of your return`}/>
              <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => removePhoto(p.id)}><X size={14}/></button></div>)}
            {photos.length < 3 && <button type="button" className="rc-add" disabled={preparing} onClick={() => picker.current?.click()}>{preparing ? <LoaderCircle className="spin" size={20} aria-hidden="true"/> : <ImagePlus size={20} aria-hidden="true"/>}<span>{preparing ? 'Preparing…' : 'Add photos'}</span><span className="rc-count">{photos.length}/3</span></button>}
            <span className="rc-drop">Or drop photos here. They’re resized on this device, which also removes location data.</span>
          </div>
          <input ref={picker} type="file" accept="image/*" multiple hidden onChange={e => { void addPhotos(e.target.files); e.target.value = ''; }}/>
        </div>
        <div className="rc-field"><label htmlFor={`${id}-url`}>Product page link <span className="rc-hint">(optional)</span></label><input id={`${id}-url`} type="url" inputMode="url" placeholder="https://www.amazon.com/…" value={url} aria-describedby={`${id}-url-hint`} onChange={e => { setUrl(e.target.value); touched(); }}/><span className="rc-hint" id={`${id}-url-hint`}>Amazon, Nike, Zara, Walmart, Target, Best Buy or REI. {lookup === false ? 'Product lookup isn’t set up on this server, so Claude relies on your measurements.' : 'Claude can compare published specs with your packed measurements.'}</span></div>
        <p className="rc-fine">“Check my return” sends your description, photos and package details to Anthropic’s Claude API. AERO keeps the verdict and Claude’s short explanation, not your photos or description.</p>
        <button type="button" className="ux-primary" disabled={busy || preparing} onClick={() => void check()}>{busy ? <LoaderCircle className="spin" size={18} aria-hidden="true"/> : <Sparkles size={18} aria-hidden="true"/>}{busy ? 'Checking your return…' : result ? 'Check again' : 'Check my return'}</button>
        {busy && <div className="rc-running"><ol className="rc-progress" aria-label="Check progress">{stages.map((s, i) => <li key={s} className={i < stage ? 'done' : i === stage ? 'now' : ''}><i aria-hidden="true">{i < stage ? <Check size={12}/> : i === stage ? <LoaderCircle className="spin" size={12}/> : null}</i>{s}</li>)}</ol><p className="rc-fine">These steps show what usually happens. Claude’s actual steps appear under “How Claude decided”. You can keep booking while this runs.</p><button type="button" className="rc-text" onClick={stop}>Stop waiting</button></div>}
      </>}
      {error && <p className="rc-error" role="alert"><TriangleAlert size={16} aria-hidden="true"/><span>{error}{result && fresh ? ' Your earlier result below still applies and stays attached.' : ''}</span></p>}
      {notice && <p className="rc-note" role="status"><Info size={16} aria-hidden="true"/><span>{notice}</span></p>}
      {result && d && <div className={`rc-result tone-${tone} ${fresh ? '' : 'stale'}`}>
        {busy && <p className="rc-note"><LoaderCircle className="spin" size={16} aria-hidden="true"/><span>Checking again. {fresh ? 'This earlier result stays attached until the new one arrives.' : 'This earlier result is kept until the new one arrives.'}</span></p>}
        {!fresh && <div className="rc-stale"><RefreshCw size={16} aria-hidden="true"/><span><strong>Details changed — check again.</strong> This result described different details, so it won’t be attached to your booking.</span>{setup !== 'missing' && <button type="button" className="ux-secondary rc-small" disabled={busy || preparing} onClick={() => void check()}>Check again</button>}</div>}
        <div className="rc-dim">
          <span className="rc-source">{result.source && <i aria-hidden="true"/>}{sourceLabel(result)}</span>
          <div className="rc-verdict"><span className="rc-badge"><i aria-hidden="true"/>{VERDICT_LABEL[d.verdict]}</span><span className="rc-meta">{Math.round(d.confidence * 100)}% confidence · {d.condition.replace(/_/g, ' ')} · {d.matchesDescription ? 'matches your description' : 'may not match your description'}</span></div>
          <p className="rc-explain">{d.explanation}</p>
          {/* Booking re-keys the result on a service change only when the limit check allows that tier, so it stays attached. */}
          {fresh && d.verdict === 'fly_priority' && (pkg.service === 'standard' ? <div className="rc-action tone-blue"><Zap size={18} aria-hidden="true"/><div><strong>{result.eligibility.standard.eligible ? 'Claude suggests AERO Priority. Standard also fits AERO’s limits.' : 'This package fits AERO Priority, not Standard.'}</strong><p>Priority carries up to {result.eligibility.limits.priority.maxKg} kg and {result.eligibility.limits.priority.maxSideCm} cm per side ($3 demo upgrade, nothing is charged).</p></div><button type="button" className={`${result.eligibility.standard.eligible ? 'ux-secondary' : 'ux-primary'} rc-small`} onClick={() => onService('priority')}>Switch to Priority</button></div> : <div className="rc-action tone-blue"><Check size={18} aria-hidden="true"/><div><strong>Priority is selected, so this package can fly.</strong></div></div>)}
          {fresh && d.verdict === 'fly_standard' && <div className="rc-action tone-green"><Check size={18} aria-hidden="true"/><div><strong>{pkg.service === 'priority' ? 'Standard would also fit. Priority is still fine.' : 'Standard fits this package.'}</strong></div></div>}
          {fresh && d.verdict === 'not_drone_eligible' && <div className="rc-action tone-red"><TriangleAlert size={18} aria-hidden="true"/><div><strong>Booking a drone won’t work for this package.</strong><ul>{whyNotEligible(result.eligibility).map(w => <li key={w.tier}>{w.tier} ({w.limits}): {w.reasons.join('; ') || 'no compatible facility'}</li>)}</ul><p>If a measurement above is wrong, fix it and check again. Otherwise use your retailer’s usual drop-off.</p></div></div>}
          {fresh && d.verdict === 'needs_person' && <div className="rc-action tone-amber"><UserRound size={18} aria-hidden="true"/><div><strong>{PERSON_NOTE}</strong><ul>{personReasons(d).map(r => <li key={r}>{r}</li>)}</ul><p>You can still book.{d.questions.length ? ' Have answers to the questions below ready.' : ''}</p></div></div>}
          {d.checks.length > 0 && <div><h5>What was checked</h5><ul className="rc-checks">{d.checks.map((c, i) => <li key={i} className={c.ok ? 'ok' : 'bad'}><span className="rc-mark" aria-hidden="true">{c.ok ? <Check size={13}/> : <X size={13}/>}</span><span><strong>{c.label}</strong><span className="rc-sr">{c.ok ? ', passed' : ', needs attention'}</span>{c.detail ? ` · ${checkDetail(c)}` : ''}</span></li>)}</ul></div>}
          {d.questions.length > 0 && <div className="rc-questions"><h5>Please confirm before pickup</h5><ul>{d.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
          <div className="rc-merchant"><Store size={18} aria-hidden="true"/><div><span className="rc-label">Suggested next step for the merchant</span><strong>{DISPOSITION_LABEL[d.disposition]}</strong><p>{DISPOSITION_NOTE[d.disposition]} Advisory; the retailer decides.</p></div></div>
          <details className="rc-trace"><summary>How Claude decided</summary><ol className="rc-steps">
            {result.steps.map((s, i) => { const v = describeStep(s, pkg); return <li key={i}><strong>{v.title}</strong><span className="rc-by">{v.by}</span>{v.used.length > 0 && <p><span className="rc-label-inline">Used:</span> {v.used.join(' · ')}</p>}{v.results.map((r, j) => <p key={j}>{r}</p>)}</li>; })}
            <li><strong>Claude decided, then AERO’s rules checked it</strong><span className="rc-by">AERO server gate</span><p>The verdict can’t fly a package the limit check rules out. Anything under {PERSON_CONFIDENCE * 100}% confidence, a description mismatch, damage or an unknown condition goes to a person.</p><p>Final: {VERDICT_LABEL[d.verdict]} · {Math.round(d.confidence * 100)}%</p></li>
          </ol></details>
          <p className="rc-fine">{fresh ? 'Attached to your booking when you confirm: AERO saves the verdict and explanation with the return. ' : ''}Advisory only. It doesn’t approve a retailer return or refund, and it doesn’t clear a flight.</p>
        </div>
      </div>}
    </div>
  </section>;
}

const CSS = `
.return-check{margin:18px 0 4px;border:1px solid var(--ux-line,#e8e8e8);border-radius:16px;background:var(--ux-bg,#fff);color:var(--ux-ink,#000);font-family:var(--ux-font,inherit);position:relative;overflow:hidden}
.return-check[hidden],.return-check [hidden]{display:none!important}
.return-check p{margin:0}
.return-check .rc-head{width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;text-align:left;color:inherit;background:none;border-radius:0}
.return-check .rc-head:hover{filter:none;background:var(--ux-soft,#f3f3f3)}
.return-check .rc-head:focus-visible{outline-offset:-3px}
.return-check .rc-icon{width:36px;height:36px;border-radius:50%;background:var(--ux-ink,#000);color:var(--ux-bg,#fff);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.return-check .rc-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.return-check .rc-head-text strong{font:600 calc(15px * var(--font-scale,1))/1.3 var(--ux-head,inherit);letter-spacing:-.01em}
.return-check .rc-head-text>.rc-sub{font-size:calc(13px * var(--font-scale,1));color:var(--ux-muted,#5e5e5e);line-height:1.4}
.return-check .rc-chev{transition:transform .2s;color:var(--ux-muted,#5e5e5e)}
.return-check .rc-head[aria-expanded=true] .rc-chev{transform:rotate(180deg)}
.return-check .rc-chip{align-self:flex-start;max-width:100%;margin-top:4px;display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:4px 10px;border-radius:13px;background:var(--ux-soft,#f3f3f3);color:var(--ux-ink,#000);font-size:calc(12px * var(--font-scale,1));font-weight:600;line-height:1.3}
.return-check .rc-chip i,.return-check .rc-badge i{width:8px;height:8px;border-radius:50%;background:var(--tone);flex-shrink:0}
.return-check .tone-green{--tone:var(--ux-green,#06c167)}.return-check .tone-blue{--tone:var(--ux-blue,#276ef1)}.return-check .tone-red{--tone:var(--ux-red,#e11900)}.return-check .tone-amber{--tone:var(--ux-amber,#ffc043)}
.return-check .rc-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:14px;border-top:1px solid var(--ux-line,#e8e8e8)}
.return-check .rc-field{display:flex;flex-direction:column;gap:6px;margin:0;font-size:calc(13px * var(--font-scale,1));font-weight:600;color:var(--ux-ink,#000)}
.return-check .rc-hint{font-size:calc(12px * var(--font-scale,1));font-weight:400;color:var(--ux-muted,#5e5e5e);line-height:1.45}
.return-check :is(textarea,input[type=url]){width:100%;min-width:0;margin:0;border:1px solid var(--ux-line,#e8e8e8);border-radius:10px;background:var(--ux-bg,#fff);color:var(--ux-ink,#000);padding:10px 12px;font:400 calc(14px * var(--font-scale,1))/1.45 var(--ux-font,inherit);box-shadow:none}
.return-check textarea{resize:vertical;min-height:76px}
.return-check :is(textarea,input):focus-visible{outline:3px solid var(--ux-blue,#276ef1);outline-offset:1px}
.return-check .rc-photos{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px;border:1px dashed var(--ux-line,#e8e8e8);border-radius:12px;font-weight:400}
.return-check .rc-photos.dragging{border-color:var(--ux-blue,#276ef1);background:color-mix(in srgb,var(--ux-blue,#276ef1) 8%,transparent)}
.return-check .rc-thumb{position:relative;width:84px;height:84px;border-radius:10px;overflow:hidden;background:var(--ux-soft,#f3f3f3)}
.return-check .rc-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.return-check .rc-thumb button{position:absolute;top:4px;right:4px;width:28px;height:28px;border-radius:50%;background:rgba(0,0,0,.72);color:#fff;display:inline-flex;align-items:center;justify-content:center;padding:0}
.return-check .rc-add{width:84px;height:84px;border-radius:10px;background:var(--ux-soft,#f3f3f3);color:var(--ux-ink,#000);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:calc(12px * var(--font-scale,1));font-weight:600;padding:4px}
.return-check .rc-count{font-weight:400;color:var(--ux-muted,#5e5e5e)}
.return-check .rc-drop{flex:1 1 160px;font-size:calc(12px * var(--font-scale,1));color:var(--ux-muted,#5e5e5e);line-height:1.45}
.return-check .rc-fine{font-size:calc(12px * var(--font-scale,1));color:var(--ux-muted,#5e5e5e);line-height:1.5}
.return-check .ux-primary,.return-check .ux-secondary{min-height:48px}
.return-check .rc-small{width:auto;min-height:40px;padding:0 14px;font-size:calc(14px * var(--font-scale,1))}
.return-check .rc-text{align-self:flex-start;padding:0;font-size:calc(13px * var(--font-scale,1));font-weight:600;color:var(--ux-ink,#000);text-decoration:underline}
.return-check .rc-running{display:flex;flex-direction:column;gap:8px}
.return-check .rc-progress{list-style:none;margin:0;padding:12px;border-radius:12px;background:var(--ux-soft,#f3f3f3);display:flex;flex-direction:column;gap:8px}
.return-check .rc-progress li{display:flex;align-items:center;gap:10px;font-size:calc(14px * var(--font-scale,1));color:var(--ux-muted,#5e5e5e)}
.return-check .rc-progress li.now{color:var(--ux-ink,#000);font-weight:600}
.return-check .rc-progress li.done{color:var(--ux-ink,#000)}
.return-check .rc-progress i{width:20px;height:20px;border-radius:50%;border:2px solid var(--ux-line,#e8e8e8);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.return-check .rc-progress li.now i{border-color:var(--ux-ink,#000)}
.return-check .rc-progress li.done i{background:var(--ux-ink,#000);border-color:var(--ux-ink,#000);color:var(--ux-bg,#fff)}
.return-check :is(.rc-error,.rc-note){display:flex;gap:8px;align-items:flex-start;margin:0;padding:10px 12px;border-radius:10px;font-size:calc(13px * var(--font-scale,1));line-height:1.45;color:var(--ux-ink,#000)}
.return-check .rc-error{background:color-mix(in srgb,var(--ux-red,#e11900) 10%,var(--ux-bg,#fff))}
.return-check .rc-note{background:var(--ux-soft,#f3f3f3)}
.return-check .rc-setup{display:flex;gap:12px;align-items:flex-start;padding:14px;border-radius:12px;background:var(--ux-soft,#f3f3f3);font-size:calc(13px * var(--font-scale,1));line-height:1.5}
.return-check .rc-setup strong{display:block;margin-bottom:4px;font-size:calc(14px * var(--font-scale,1))}
.return-check code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:calc(12px * var(--font-scale,1));background:var(--ux-bg,#fff);border:1px solid var(--ux-line,#e8e8e8);padding:1px 5px;border-radius:5px}
.return-check .rc-result{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:14px;border:1px solid var(--ux-line,#e8e8e8);border-left:4px solid var(--tone)}
.return-check .rc-result.stale{border-left-color:var(--ux-line,#e8e8e8)}
.return-check .rc-dim{display:flex;flex-direction:column;gap:12px}
.return-check .rc-stale{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--ux-amber,#ffc043) 24%,var(--ux-bg,#fff));font-size:calc(13px * var(--font-scale,1));line-height:1.45}
.return-check .rc-stale>span{flex:1 1 200px}
.return-check .rc-source{display:inline-flex;align-items:center;gap:6px;font-size:calc(12px * var(--font-scale,1));font-weight:600;color:var(--ux-muted,#5e5e5e)}
.return-check .rc-source i{width:8px;height:8px;border-radius:50%;background:var(--ux-green,#06c167)}
.return-check .rc-verdict{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.return-check .rc-badge{display:inline-flex;align-items:center;gap:7px;min-height:32px;padding:4px 12px;border-radius:16px;background:color-mix(in srgb,var(--tone) 18%,var(--ux-bg,#fff));color:var(--ux-ink,#000);font:700 calc(15px * var(--font-scale,1))/1.2 var(--ux-head,inherit)}
.return-check .rc-badge i{width:10px;height:10px}
.return-check .rc-meta{font-size:calc(13px * var(--font-scale,1));color:var(--ux-muted,#5e5e5e)}
.return-check .rc-explain{font-size:calc(14px * var(--font-scale,1));line-height:1.5}
.return-check h5{margin:0 0 6px;font:600 calc(13px * var(--font-scale,1))/1.3 var(--ux-head,inherit);color:var(--ux-ink,#000)}
.return-check .rc-checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.return-check .rc-checks li{display:flex;gap:10px;align-items:flex-start;font-size:calc(13px * var(--font-scale,1));line-height:1.45}
.return-check .rc-mark{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;background:color-mix(in srgb,var(--ux-green,#06c167) 22%,var(--ux-bg,#fff));color:var(--ux-ink,#000)}
.return-check .bad .rc-mark{background:color-mix(in srgb,var(--ux-red,#e11900) 20%,var(--ux-bg,#fff))}
.return-check :is(.rc-questions,.rc-action) ul{margin:4px 0 0;padding-left:18px;list-style:disc;font-size:calc(13px * var(--font-scale,1));line-height:1.5}
.return-check .rc-action{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;padding:12px;border-radius:12px;background:color-mix(in srgb,var(--tone) 12%,var(--ux-bg,#fff));font-size:calc(13px * var(--font-scale,1));line-height:1.45}
.return-check .rc-action>div{flex:1 1 200px}
.return-check .rc-action p{margin-top:4px}
.return-check .rc-merchant{display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:12px;background:var(--ux-soft,#f3f3f3);font-size:calc(13px * var(--font-scale,1));line-height:1.45}
.return-check .rc-merchant strong{display:block;font-size:calc(14px * var(--font-scale,1))}
.return-check .rc-label{display:block;font-size:calc(12px * var(--font-scale,1));color:var(--ux-muted,#5e5e5e)}
.return-check .rc-label-inline{color:var(--ux-muted,#5e5e5e)}
.return-check .rc-trace{border:0;padding:0;margin:0}
.return-check .rc-trace p{margin:0;font-size:calc(13px * var(--font-scale,1));line-height:1.45;color:var(--ux-ink,#000)}
.return-check .rc-trace summary{cursor:pointer;font-weight:600;font-size:calc(14px * var(--font-scale,1));color:var(--ux-ink,#000);padding:4px 0;border-radius:4px}
.return-check .rc-trace summary:focus-visible{outline:3px solid var(--ux-blue,#276ef1);outline-offset:2px}
.return-check .rc-steps{margin:10px 0 0;padding:0;list-style:none;counter-reset:rc;display:flex;flex-direction:column;gap:12px}
.return-check .rc-steps li{position:relative;padding-left:30px;font-size:calc(13px * var(--font-scale,1));line-height:1.45;counter-increment:rc;display:flex;flex-direction:column;gap:2px}
.return-check .rc-steps li:before{content:counter(rc);position:absolute;left:0;top:0;width:20px;height:20px;border-radius:50%;background:var(--ux-ink,#000);color:var(--ux-bg,#fff);font-size:calc(11px * var(--font-scale,1));font-weight:700;display:flex;align-items:center;justify-content:center}
.return-check .rc-by{font-size:calc(12px * var(--font-scale,1));color:var(--ux-muted,#5e5e5e)}
.return-check .rc-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
@media(max-width:520px){.return-check .rc-thumb,.return-check .rc-add{width:72px;height:72px}.return-check .rc-head{padding:12px}.return-check .rc-body{padding:12px}}
body[data-motion=true] .return-check .rc-chev{transition:none}
`;
