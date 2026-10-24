/** Delivery jobs: one real-drone package run, split into legs the drone flies one at a time.
 *
 *   pickup leg ──done──▶ at_pickup ──person confirms loading──▶ dropoff leg ──done (released)──▶ delivered ──▶ return leg ──▶ completed
 *
 * The server advances a job only from the drone's own acks (accepted / done / failed) and from an
 * explicit loading confirmation. Pure functions so the lifecycle is unit-tested without D1. */
import { z } from 'zod';
import { LEGAL_MAX_ALT_M, pointSchema, type FlyRoute } from './drone-protocol';
import type { Point } from './simulation';

export type JobStatus = 'dispatched' | 'en_route_pickup' | 'at_pickup' | 'package_loaded' | 'en_route_dropoff' | 'delivered' | 'returning' | 'completed' | 'cancelled' | 'failed';
export type JobLeg = 'pickup' | 'dropoff' | 'return';
export type JobEvent = { status: JobStatus; at: number; note?: string };
export type DeliveryJob = {
  id: string; droneId: string; returnId: string | null; pickup: Point; dropoff: Point; altM: number; speedMs: number; returnHome: boolean;
  status: JobStatus; leg: JobLeg | null; loaded: boolean; error: string | null; events: JobEvent[]; createdAt: number; updatedAt: number;
};

export const JOB_TITLES: Record<JobStatus, string> = {
  dispatched: 'Drone dispatched', en_route_pickup: 'On the way to pickup', at_pickup: 'Arrived at pickup', package_loaded: 'Package picked up',
  en_route_dropoff: 'Package in flight', delivered: 'Package delivered', returning: 'Drone returning home', completed: 'Delivery complete',
  cancelled: 'Delivery cancelled', failed: 'Delivery needs attention',
};
/** The customer-facing progress steps, in order. */
export const JOB_STEPS: { status: JobStatus; label: string }[] = [
  { status: 'dispatched', label: 'Dispatched' }, { status: 'at_pickup', label: 'At pickup' }, { status: 'package_loaded', label: 'Picked up' },
  { status: 'en_route_dropoff', label: 'In flight' }, { status: 'delivered', label: 'Delivered' }, { status: 'completed', label: 'Done' },
];
const ORDER: JobStatus[] = ['dispatched', 'en_route_pickup', 'at_pickup', 'package_loaded', 'en_route_dropoff', 'delivered', 'returning', 'completed'];
export const isActiveJob = (j: Pick<DeliveryJob, 'status'>) => !['completed', 'cancelled', 'failed'].includes(j.status);
/** Index into JOB_STEPS of the furthest step this job has reached. */
export function jobStep(j: DeliveryJob) {
  const reached = Math.max(...j.events.map(e => ORDER.indexOf(e.status)), 0);
  let step = 0; JOB_STEPS.forEach((s, i) => { if (ORDER.indexOf(s.status) <= reached) step = i; });
  return step;
}

const id64 = z.string().min(1).max(64);
export const jobRequestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'), pickup: pointSchema, dropoff: pointSchema, altM: z.number().finite().min(5).max(LEGAL_MAX_ALT_M), speedMs: z.number().finite().min(1).max(15).default(6),
    returnHome: z.boolean().default(true), returnId: id64.optional(),
    pilotReady: z.literal(true, { errorMap: () => ({ message: 'Confirm a pilot with a remote controller is watching the drone.' }) }),
  }),
  z.object({ op: z.literal('loaded'), jobId: id64 }),
  z.object({ op: z.literal('cancel'), jobId: id64 }),
  z.object({ op: z.literal('resume'), jobId: id64, pilotReady: z.literal(true, { errorMap: () => ({ message: 'Confirm a pilot with a remote controller is watching the drone.' }) }) }),
]);
export type JobRequest = z.infer<typeof jobRequestSchema>;

const event = (j: DeliveryJob, status: JobStatus, now: number, note?: string): DeliveryJob => ({ ...j, status, updatedAt: now, events: [...j.events, { status, at: now, ...(note ? { note } : {}) }] });

export function createJob(input: Extract<JobRequest, { op: 'create' }>, id: string, droneId: string, now: number): DeliveryJob {
  return event({ id, droneId, returnId: input.returnId ?? null, pickup: input.pickup, dropoff: input.dropoff, altM: input.altM, speedMs: input.speedMs, returnHome: input.returnHome, status: 'dispatched', leg: 'pickup', loaded: false, error: null, events: [], createdAt: now, updatedAt: now }, 'dispatched', now);
}

/** The command for a leg. Pickup lands and waits; drop-off lands and releases the package. */
export function legCommand(j: DeliveryJob, leg: JobLeg): { type: 'FLY_ROUTE'; params: FlyRoute } | { type: 'RTL'; params: null } {
  if (leg === 'return') return { type: 'RTL', params: null };
  return { type: 'FLY_ROUTE', params: { waypoints: [leg === 'pickup' ? j.pickup : j.dropoff], altM: j.altM, speedMs: j.speedMs, land: true, release: leg === 'dropoff' } };
}
/** Route the drone still has to fly for the whole job, used for preflight. */
export function remainingWaypoints(j: Pick<DeliveryJob, 'pickup' | 'dropoff' | 'loaded'>): Point[] { return j.loaded ? [j.dropoff] : [j.pickup, j.dropoff]; }

/** Apply the drone's ack for a job leg. Returns the updated job and the next leg to queue, if any. */
export function onAck(j: DeliveryJob, leg: JobLeg, status: 'accepted' | 'done' | 'failed', message: string | undefined, now: number): { job: DeliveryJob; next: JobLeg | null } {
  if (!isActiveJob(j) || leg !== j.leg) return { job: j, next: null };
  if (status === 'failed') return { job: { ...event(j, 'failed', now, message || 'The drone stopped this leg.'), error: message || 'The drone stopped this leg.' }, next: null };
  if (status === 'accepted') {
    const s: JobStatus = leg === 'pickup' ? 'en_route_pickup' : leg === 'dropoff' ? 'en_route_dropoff' : 'returning';
    return { job: j.status === s ? j : event(j, s, now), next: null };
  }
  if (leg === 'pickup') return { job: { ...event(j, 'at_pickup', now, 'Landed at pickup. Load the package and confirm.'), leg: null }, next: null };
  if (leg === 'dropoff') {
    const delivered = event(j, 'delivered', now, message || 'Landed at drop-off and released the package.');
    return j.returnHome ? { job: { ...delivered, leg: 'return' }, next: 'return' } : { job: { ...event(delivered, 'completed', now), leg: null }, next: null };
  }
  return { job: { ...event(j, 'completed', now, 'Drone is home.'), leg: null }, next: null };
}

/** A person confirms the package is secured on the drone. Required before the drone carries anything. */
export function onLoaded(j: DeliveryJob, now: number): DeliveryJob {
  if (j.status !== 'at_pickup') throw new Error('The drone has to land at the pickup before the package can be loaded.');
  return { ...event(j, 'package_loaded', now, 'Loading confirmed by a person.'), loaded: true, leg: 'dropoff' };
}
export function onCancel(j: DeliveryJob, now: number): DeliveryJob {
  if (!isActiveJob(j)) throw new Error('This delivery has already ended.');
  return { ...event(j, 'cancelled', now, j.loaded ? 'Cancelled with the package on board.' : undefined), leg: null };
}
/** Retry after a failure (link loss, a manual HOLD, a refused command) from the leg that was interrupted. */
export function onResume(j: DeliveryJob, now: number): DeliveryJob {
  if (j.status !== 'failed') throw new Error('Only a delivery that needs attention can be resumed.');
  const delivered = j.events.some(e => e.status === 'delivered');
  const leg: JobLeg = delivered ? 'return' : j.loaded ? 'dropoff' : 'pickup';
  return { ...event(j, delivered ? 'delivered' : j.loaded ? 'package_loaded' : 'dispatched', now, 'Resumed.'), leg, error: null };
}
