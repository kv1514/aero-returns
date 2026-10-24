/** Pure live-mission rules for a real drone. Storage and transport live in lib/drone-server.ts. */
import type { Ack, CommandType } from './drone-protocol';
import { distance, heldForPerson, HOLD_MESSAGE, STATE_TITLES, snapshot, type LiveFlight, type LiveTelemetry, type MissionPhase, type Point, type ReturnRecord } from './simulation';

export const LIMITS = { maxRadius: 2000, maxAlt: 120, minCruise: 10, minBattery: 40, minSats: 6, maxDrones: 5 };
export const ARM_WINDOW_MS = 30 * 60_000;
export const STALE_MS = { https: 10_000, sms: 120_000 } as const;
export const EXPIRY_S = { https: 30, sms: 300 } as const;
export type Transport = keyof typeof STALE_MS;
export type DroneConfig = { home: Point; pickupPad: Point | null; dropPad: Point | null; radius: number; maxAlt: number; cruiseAlt: number };
export type Drone = { id: string; owner: string; name: string; transport: Transport; phone: string | null; phoneVerified: boolean; keyVersion: number; config: DroneConfig; armedUntil: number; activeReturn: string | null; lastSeq: number; lastSeen: number; telemetry: LiveTelemetry | null; createdAt: number };
export type PlannedCommand = { type: CommandType; args: number[] };
export type ArmChecklist = { pilot: boolean; airspace: boolean; pads: boolean; failsafe: boolean };

const ON_GROUND = ['IDLE', 'LANDED'];
/** Phases where the drone sits landed waiting for a person; HOLD there is a no-op, not a pause. */
export const GROUND_PHASES: MissionPhase[] = ['AWAITING_LOAD', 'READY_TO_LAUNCH', 'AWAITING_UNLOAD'];
export const isStale = (drone: Pick<Drone, 'transport' | 'lastSeen'>, now: number) => now - drone.lastSeen > STALE_MS[drone.transport];
export const airborne = (t: LiveTelemetry | null | undefined) => !!t && !ON_GROUND.includes(t.state) && t.alt > 1.5;
export const insideFence = (c: DroneConfig, p: Point) => distance(c.home, p) <= c.radius;

export function configProblem(c: DroneConfig): string | null {
  const valid = (p: Point | null) => !p || (Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180);
  if (![c.home, c.pickupPad, c.dropPad].every(valid)) return 'Coordinates are out of range.';
  if (!(c.radius >= 20 && c.radius <= LIMITS.maxRadius)) return `Geofence radius must be 20–${LIMITS.maxRadius} m.`;
  if (!(c.maxAlt >= LIMITS.minCruise && c.maxAlt <= LIMITS.maxAlt)) return `Maximum altitude must be ${LIMITS.minCruise}–${LIMITS.maxAlt} m (400 ft).`;
  if (!(c.cruiseAlt >= LIMITS.minCruise && c.cruiseAlt <= c.maxAlt)) return `Cruise altitude must be between ${LIMITS.minCruise} m and the maximum altitude.`;
  for (const [name, pad] of [['Pickup pad', c.pickupPad], ['Drop pad', c.dropPad]] as const) if (pad && !insideFence(c, pad)) return `${name} is outside the geofence.`;
  return null;
}

/** Every reason a drone cannot start this return as a live flight. Empty means dispatch is allowed. */
export function dispatchBlockers(drone: Drone, record: ReturnRecord, now: number): string[] {
  const t = drone.telemetry, c = drone.config, s = snapshot(record, now), blockers: string[] = [];
  if (record.live) blockers.push('This return is already a live flight.');
  if (record.loaded || record.cancelled || record.failed || ['COMPLETED', 'CANCELLED'].includes(s.state)) blockers.push('Only an unloaded, active return can be dispatched.');
  if (heldForPerson(record.review)) blockers.push(HOLD_MESSAGE);
  if (drone.activeReturn) blockers.push('The drone is already flying another return.');
  if (drone.armedUntil <= now) blockers.push('Complete the pre-flight checklist to arm live missions.');
  if (!c.pickupPad || !c.dropPad) blockers.push('Set both the pickup and drop pads.');
  const problem = configProblem(c); if (problem) blockers.push(problem);
  if (!t || isStale(drone, now)) blockers.push('No fresh telemetry from the bridge.');
  else {
    if (t.fix < 3 || t.sats < LIMITS.minSats) blockers.push(`Needs a 3D GPS fix with ${LIMITS.minSats}+ satellites.`);
    if (t.battery < LIMITS.minBattery) blockers.push(`Battery must be at least ${LIMITS.minBattery}%.`);
    if (t.state === 'ERROR') blockers.push('The drone reports an error. Check the bridge log.');
    else if (!ON_GROUND.includes(t.state) || t.alt > 1.5) blockers.push('The drone must be landed and idle.');
    if (!insideFence(c, [t.lon, t.lat])) blockers.push('The drone is outside its geofence.');
  }
  return blockers;
}

const NEXT: Partial<Record<MissionPhase, MissionPhase>> = { TAKEOFF_OUT: 'TO_PICKUP', TO_PICKUP: 'LAND_PICKUP', LAND_PICKUP: 'AWAITING_LOAD', TAKEOFF_LOADED: 'TO_DROP', TO_DROP: 'LAND_DROP', LAND_DROP: 'AWAITING_UNLOAD', TAKEOFF_HOME: 'RETURNING', RETURNING: 'LAND_HOME', LAND_HOME: 'COMPLETE' };
export const ENDED: MissionPhase[] = ['COMPLETE', 'ABORTED'];
export function phaseCommand(l: Pick<LiveFlight, 'home' | 'pickupPad' | 'dropPad' | 'cruiseAlt'>, phase: MissionPhase): PlannedCommand | null {
  if (phase === 'TAKEOFF_OUT' || phase === 'TAKEOFF_LOADED' || phase === 'TAKEOFF_HOME') return { type: 'TAKEOFF', args: [l.cruiseAlt] };
  if (phase === 'TO_PICKUP') return { type: 'GOTO', args: [l.pickupPad[1], l.pickupPad[0], l.cruiseAlt] };
  if (phase === 'TO_DROP') return { type: 'GOTO', args: [l.dropPad[1], l.dropPad[0], l.cruiseAlt] };
  // Flying back to the stored home pad, not RTL: arming at the drop pad resets the autopilot's home point.
  if (phase === 'RETURNING') return { type: 'GOTO', args: [l.home[1], l.home[0], l.cruiseAlt] };
  if (phase === 'LAND_PICKUP' || phase === 'LAND_DROP' || phase === 'LAND_HOME') return { type: 'LAND', args: [] };
  return null;
}

/** Moves the mission to `phase` and records a customer-visible event when the tracking state changes. */
export function enterPhase(r: ReturnRecord, phase: MissionPhase, now: number, cmdSeq: number | null, fault: string | null = null): ReturnRecord {
  const live = { ...r.live!, phase, phaseAt: now, cmdSeq, fault };
  const next = { ...r, live, loaded: r.loaded || phase === 'READY_TO_LAUNCH', events: [...r.events] };
  const state = snapshot(next, now).state;
  if (next.events[next.events.length - 1]?.state !== state) next.events.push({ state, title: phase === 'ABORTED' && !next.cancelled ? 'Live flight ended by the pilot' : STATE_TITLES[state], at: now });
  return next;
}
export function startLive(r: ReturnRecord, drone: Drone, now: number): ReturnRecord {
  const c = drone.config;
  const live: LiveFlight = { droneId: drone.id, droneName: drone.name, transport: drone.transport, phase: 'TAKEOFF_OUT', home: c.home, pickupPad: c.pickupPad!, dropPad: c.dropPad!, cruiseAlt: c.cruiseAlt, cmdSeq: null, fault: null, startedAt: now, phaseAt: now };
  return { ...r, live, paused: false };
}

/** Phase the mission should enter after an ack, or null when the ack changes nothing. */
export function ackOutcome(l: LiveFlight, ack: Pick<Ack, 'cmdSeq' | 'status' | 'reason'>): { phase: MissionPhase; fault: string | null } | null {
  if (ENDED.includes(l.phase) || l.cmdSeq === null || ack.cmdSeq !== l.cmdSeq) return null;
  // A paused mission (operator HOLD, rejection, expiry) only moves again through an operator retry.
  if (l.fault) return null;
  if (ack.status === 'DONE') { const next = NEXT[l.phase]; return next ? { phase: next, fault: null } : null; }
  if (ack.status === 'REJECTED' || ack.status === 'FAILED') return { phase: l.phase, fault: ack.reason || ack.status };
  return null;
}

/** Customer actions on a live return. Returns the new phase plus whether the drone should fly home. */
export function customerAction(r: ReturnRecord, action: string): { phase: MissionPhase; cancelled?: boolean; command?: PlannedCommand } {
  const l = r.live!;
  if (ENDED.includes(l.phase)) throw new Error('This live flight has ended.');
  if (action === 'load') {
    if (l.phase !== 'AWAITING_LOAD' || airborne(l.telemetry)) throw new Error('Wait until the drone has landed at your pickup spot.');
    return { phase: 'READY_TO_LAUNCH' };
  }
  if (action === 'cancel') {
    if (r.loaded) throw new Error('A loaded return cannot be cancelled. The operator will complete the flight.');
    // Decided by phase, not by possibly stale telemetry. The new command supersedes any queued TAKEOFF or GOTO:
    // near home or descending, land where it is; en route, fly home; landed at pickup, never take off automatically.
    const command: PlannedCommand | null = l.phase === 'TO_PICKUP' ? { type: 'RTL', args: [] } : l.phase === 'TAKEOFF_OUT' || l.phase === 'LAND_PICKUP' ? { type: 'LAND', args: [] } : null;
    return { phase: 'ABORTED', cancelled: true, ...(command ? { command } : {}) };
  }
  throw new Error('Live flight controls belong to the drone operator in Fleet.');
}

/** Operator actions in Fleet. Every takeoff after dispatch starts here, never from a customer tap. ABORT is handled by the server directly. */
export function operatorAction(r: ReturnRecord, action: 'launch' | 'unload' | 'retry'): { phase: MissionPhase; command?: PlannedCommand } {
  const l = r.live!;
  if (ENDED.includes(l.phase)) throw new Error('This live flight has ended.');
  if (action === 'launch') { if (l.phase !== 'READY_TO_LAUNCH') throw new Error('Launch is available after the customer confirms loading.'); return { phase: 'TAKEOFF_LOADED', command: phaseCommand(l, 'TAKEOFF_LOADED')! }; }
  if (action === 'unload') { if (l.phase !== 'AWAITING_UNLOAD') throw new Error('Confirm unloading after the drone lands at the drop pad.'); return { phase: 'TAKEOFF_HOME', command: phaseCommand(l, 'TAKEOFF_HOME')! }; }
  if (!l.fault) throw new Error('There is no paused step to retry.');
  // Re-send the step's command; a fault in a waiting phase just clears.
  const command = phaseCommand(l, l.phase);
  return command ? { phase: l.phase, command } : { phase: l.phase };
}
