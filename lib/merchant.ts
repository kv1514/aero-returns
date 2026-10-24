/**
 * Merchant returns desk: pure aggregation over one owner's stored returns (no I/O, no SDK, client-safe).
 * It only describes what AERO recorded. It never issues a refund or acts on a Claude grade by itself: a needs_person
 * return stays on the ground until a person approves or declines it through the returns API.
 * "Time saved" is an explicitly labelled demo assumption, not a measurement.
 */
import { FACILITIES, heldForPerson, settle, snapshot, type FlightState, type ReturnRecord } from './simulation';
import { DISPOSITIONS, type ReturnReview } from './return-agent-shared';

export type MerchantStage = 'Booked' | 'Picked up' | 'In flight' | 'Received' | 'Cancelled';
export type MerchantDisposition = ReturnReview['disposition'] | 'awaiting check';
export const MERCHANT_STAGES: MerchantStage[] = ['Booked', 'Picked up', 'In flight', 'Received', 'Cancelled'];
export const MERCHANT_DISPOSITIONS: MerchantDisposition[] = [...DISPOSITIONS, 'awaiting check'];
/** Demo assumption: one avoided round trip to a store or carrier counter per received return. */
export const MINUTES_PER_STORE_TRIP = 25;
/** Same threshold lib/return-agent-shared.ts gateDecision uses to send a grade to a person. */
export const CONFIDENT = .85;
export const CONDITION_LABEL: Record<ReturnReview['condition'], string> = { new: 'New', like_new: 'Like new', used: 'Used', damaged: 'Damaged', unknown: 'Condition unclear' };
/** The merchant half of the one shared needs_person phrase (the booking check says the customer half). */
export const PERSON_WAIT = 'Waiting for a person before it flies — inspect on arrival.';
/** A flagged return a person cleared: it flies, and the dock still inspects it. */
export const PERSON_APPROVED = 'Approved by a person — inspect on arrival.';
/** Rounded down, so a grade just under the 85% gate never reads as 85%. The epsilon absorbs float error (.29 * 100 = 28.999…). */
export const confidencePct = (confidence: number) => Math.floor(confidence * 100 + 1e-9);
/** Whole minutes as "45 min", "1 h" or "2 h 5 min"; rounds first so 119.6 is "2 h", never "1 h 60 min". */
export function formatDuration(min: number) {
  const m = Math.round(min);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

export type MerchantRow = {
  id: string; shortId: string; retailer: string; reference: string | null; createdAt: number;
  /** Snapshot state, exactly as the customer app derives it. */
  state: FlightState; live: boolean; stage: MerchantStage; status: string;
  review: ReturnReview | null; disposition: MerchantDisposition; needsPerson: boolean; approvedAt: number | null; declinedAt: number | null;
  destination: string; drone: string | null; loadedAt: number | null; receivedAt: number | null;
};
export type MerchantAggregates = {
  total: number; booked: number; received: number; inFlight: number; cancelled: number; live: number; liveReceived: number; needsPerson: number;
  byDisposition: Record<MerchantDisposition, number>; checked: number; checkedByClaude: number; avgMinutesToReceipt: number | null;
  storeTripsAvoided: number; estimatedMinutesSaved: number; minutesPerTrip: number;
};
export type MerchantView = { rows: MerchantRow[]; aggregates: MerchantAggregates; skipped: number };
/** Whose returns the desk shows: a guest browser cookie, the demo account, or a signed-in account. Never the owner id itself. */
export type MerchantScope = 'browser' | 'demo' | 'account';
export const scopeOf = (owner: string): MerchantScope => (owner.startsWith('guest:') ? 'browser' : owner.startsWith('demo:') ? 'demo' : 'account');

export const shortId = (id: string) => `AR-${id.slice(0, 8).toUpperCase()}`;

/** Merchant-facing stage of a tracking state. FAILED is resolved by the caller to the stage it paused in. */
export function stageOf(state: FlightState): MerchantStage {
  if (state === 'CANCELLED') return 'Cancelled';
  if (state === 'COMPLETED') return 'Received';
  if (state === 'EN_ROUTE_TO_DROPOFF' || state === 'ARRIVED_AT_DROPOFF' || state === 'HANDOFF_PENDING') return 'In flight';
  if (state === 'PACKAGE_LOADED') return 'Picked up';
  return 'Booked';
}
const STATUS: Record<FlightState, string> = { IDLE: 'Drone assigned', ASSIGNED: 'Drone assigned', PRE_FLIGHT: 'Preparing for takeoff', EN_ROUTE_TO_PICKUP: 'Flying to the customer', ARRIVED_AT_PICKUP: 'At the customer’s pickup', AWAITING_PACKAGE: 'Waiting for the customer to load', PACKAGE_LOADED: 'Loaded by the customer', EN_ROUTE_TO_DROPOFF: 'Flying to the drop-off', ARRIVED_AT_DROPOFF: 'Landed at the drop-off', HANDOFF_PENDING: 'Handoff in progress', COMPLETED: 'Simulated handoff complete', FAILED: 'Paused for assistance', CANCELLED: 'Cancelled by the customer' };

/** One settled return as the desk shows it. Pickup address and instructions are deliberately left out. */
export function merchantRow(record: ReturnRecord, now: number): MerchantRow {
  const r = settle(record, now), state = snapshot(r, now).state;
  // A paused flight keeps the stage it paused in: a fault never moves a package backwards or forwards.
  const base = state !== 'FAILED' ? state : snapshot(r.live ? { ...r, live: { ...r.live, fault: null } } : { ...r, failed: false, paused: true }, now).state;
  const stage = stageOf(base === 'FAILED' ? 'ASSIGNED' : base), review = r.review ?? null;
  const at = (s: FlightState) => r.events.find(e => e.state === s)?.at ?? null;
  const held = heldForPerson(review) && state !== 'CANCELLED', declinedAt = review?.declinedAt ?? null;
  const status = held ? 'On the ground until a person approves it' : state === 'CANCELLED' && declinedAt ? 'Declined for drone pickup by a person' : state === 'COMPLETED' && r.live ? 'Unload confirmed at the drop pad' : state === 'CANCELLED' && r.live && !r.cancelled ? 'Ended by the pilot' : STATUS[state];
  return {
    id: r.id, shortId: shortId(r.id), retailer: r.package.retailer, reference: r.package.returnReference?.trim() || null, createdAt: r.createdAt,
    state, live: !!r.live, stage, status, review, disposition: review?.disposition ?? 'awaiting check',
    // Only a return still on hold is waiting; an approved one flies, and a cancelled one never arrives.
    needsPerson: held, approvedAt: review?.approvedAt ?? null, declinedAt,
    destination: r.live ? 'Drop pad' : FACILITIES.find(f => f.id === r.facilityId)?.name ?? 'Demo facility', drone: r.live?.droneName ?? null,
    loadedAt: at('PACKAGE_LOADED'), receivedAt: stage === 'Received' ? at('COMPLETED') : null,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
export function aggregate(rows: MerchantRow[]): MerchantAggregates {
  const count = (keep: (r: MerchantRow) => boolean) => rows.filter(keep).length;
  const received = rows.filter(r => r.stage === 'Received'), open = rows.filter(r => r.stage !== 'Cancelled');
  const minutes = received.flatMap(r => (r.receivedAt === null ? [] : [Math.max(0, r.receivedAt - r.createdAt) / 60000]));
  const checked = count(r => !!r.review);
  return {
    total: rows.length, booked: count(r => r.stage === 'Booked'), received: received.length, inFlight: count(r => r.stage === 'Picked up' || r.stage === 'In flight'),
    cancelled: count(r => r.stage === 'Cancelled'), live: count(r => r.live), liveReceived: received.filter(r => r.live).length, needsPerson: count(r => r.needsPerson),
    // What the dock should expect: cancelled returns never arrive, so they are not part of the mix.
    byDisposition: Object.fromEntries(MERCHANT_DISPOSITIONS.map(d => [d, open.filter(r => r.disposition === d).length])) as Record<MerchantDisposition, number>,
    checked, checkedByClaude: rows.length ? checked / rows.length : 0,
    avgMinutesToReceipt: minutes.length ? round1(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null,
    storeTripsAvoided: received.length, estimatedMinutesSaved: received.length * MINUTES_PER_STORE_TRIP, minutesPerTrip: MINUTES_PER_STORE_TRIP,
  };
}

/** Returns on hold for a person, longest-waiting first. */
export function needsPersonQueue(rows: MerchantRow[]) {
  return rows.filter(r => r.needsPerson).sort((a, b) => a.createdAt - b.createdAt);
}

/** Why the server's gate sent a grade to a person, as far as the stored summary shows it. */
export function needsPersonReasons(review: Pick<ReturnReview, 'condition' | 'confidence'>) {
  const reasons: string[] = [];
  if (review.condition === 'damaged') reasons.push('Possible damage');
  if (review.condition === 'unknown') reasons.push('Condition unclear from the description and any photos');
  if (review.confidence < CONFIDENT) reasons.push(`Low confidence (${confidencePct(review.confidence)}%, under ${CONFIDENT * 100}%)`);
  // Not stored with the return: a description mismatch, or Claude asking for a person itself (including a not-eligible call the size rules don't back).
  return reasons.length ? reasons : ['The item may not match its description, or Claude asked for a person to judge it'];
}

/** Settles every record; one unreadable record is skipped and counted instead of failing the whole desk. */
export function merchantView(records: unknown[], now: number): MerchantView {
  const rows: MerchantRow[] = []; let skipped = 0;
  for (const record of records) { try { rows.push(merchantRow(record as ReturnRecord, now)); } catch { skipped++; } }
  return { rows, aggregates: aggregate(rows), skipped };
}
