/** Requesting a drone, Uber style: what the app opens on, the matching beat, and readable request errors. Client-safe, no I/O. */
import { z } from 'zod';
import { inDemoArea } from './location';
import { FACILITIES, snapshot, type ReturnRecord } from './simulation';
import { VERDICT_LABEL, type ReturnReview } from './return-agent-shared';

export const isEnded = (r: ReturnRecord, now: number) => ['COMPLETED', 'CANCELLED'].includes(snapshot(r, now).state);
/**
 * What the customer screen opens on. Nothing is ever booked here: a return exists only after the person taps Request.
 * A tracking link opens that return; otherwise the newest active return; otherwise the home screen.
 */
export function initialView(list: ReturnRecord[], initialId: string | undefined, now: number): 'home' | { track: string } {
  if (initialId && list.some(r => r.id === initialId)) return { track: initialId };
  const active = [...list].sort((a, b) => b.createdAt - a.createdAt).find(r => { try { return !isEnded(r, now); } catch { return false; } });
  return active ? { track: active.id } : 'home';
}
/** Up to `n` most recent returns for the home screen, newest first. */
export const recentReturns = (list: ReturnRecord[], n = 3) => [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
export function returnStatus(r: ReturnRecord, now: number) {
  const state = snapshot(r, now).state;
  return state === 'COMPLETED' ? 'Delivered' : state === 'CANCELLED' ? (r.live && !r.cancelled ? 'Ended by pilot' : 'Cancelled') : 'In progress';
}
/** Where a return in the history list went: a live flight never shows the simulated hub it was booked against. */
export const historyPlace = (r: ReturnRecord) => r.live ? 'Drop pad · Live flight' : `${FACILITIES.find(f => f.id === r.facilityId)?.name ?? 'Demo return hub'} · Simulated`;
/** Claude's check as the customer sees it. Once a person decides a held return, their decision replaces "A person needs to check". */
export const checkLabel = (review: ReturnReview | undefined, time: (ts: number) => string) => !review ? 'Not checked' : review.approvedAt ? `Approved by a person at ${time(review.approvedAt)}` : review.declinedAt ? `Declined by a person at ${time(review.declinedAt)}` : VERDICT_LABEL[review.verdict];
/** The pickup line on the tracking sheet. A live flight lands at the customer's pin (only after the pilot clears the area) or at the operator's pad. */
export function pickupNote(r: ReturnRecord, now: number) {
  if (!r.live) return 'Berkeley, CA';
  if (r.live.pickupSource !== 'pin') return 'Pickup pad set by the operator';
  const s = snapshot(r, now);
  return r.loaded || s.outbound ? 'Picked up at your pin' : s.state === 'CANCELLED' ? 'Your pin' : s.state === 'AWAITING_PACKAGE' ? 'Your pin · the drone waits here for your package' : 'Your pin · the drone lands here once the pilot confirms the area is clear';
}
/** While a live drone hovers over the customer's pin, the pilot decides when it lands. */
export const HOVER_COPY = { headline: 'Your drone is overhead', subline: 'The pilot lands it when the area is clear.', courier: 'Hovering overhead' };
/** "Finding your nearest drone…" stays up at least this long, and until the booking request returns. */
export const MATCH_MIN_MS = 1800;
/** The matched card continues to tracking on its own after this long. */
export const MATCHED_HOLD_MS = 2500;

export const SERVICE_AREA_MESSAGE = 'Pickup must be inside the Berkeley demo service area.';
/** Booking input as the returns API accepts it. The browser never chooses the drone: the server assigns it. */
export const packageSchema = z.object({
  retailer: z.enum(['Amazon', 'Nike', 'Zara', 'Other']), method: z.enum(['qr', 'label']),
  weight: z.number().finite().positive().max(20), dimensions: z.tuple([z.number().positive().max(150), z.number().positive().max(150), z.number().positive().max(150)]),
  fragile: z.boolean(), address: z.string().trim().min(3).max(160), pickup: z.tuple([z.number().finite(), z.number().finite()]).refine(inDemoArea, SERVICE_AREA_MESSAGE),
  instructions: z.string().max(500), service: z.enum(['standard', 'priority']), returnReference: z.string().max(150).optional(),
});
/** One readable 400 message: a body that is not an object says so, and a custom rule's message stands on its own. */
export const validationMessage = (error: z.ZodError) => [...new Set(error.issues.map(i => !i.path.length ? 'Send the request as a JSON object.' : i.code === 'custom' ? i.message : `${i.path.join('.')}: ${i.message}`))].join(' · ');
