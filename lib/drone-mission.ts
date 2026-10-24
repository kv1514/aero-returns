/** Pure live-mission rules for a real drone. Storage and transport live in lib/drone-server.ts. */
import type { Ack, CommandType } from './drone-protocol';
import { distance, handedOff, heldForPerson, HOLD_MESSAGE, STATE_TITLES, snapshot, type LiveFlight, type LiveTelemetry, type MissionPhase, type Point, type ReturnRecord } from './simulation';

export const LIMITS = { maxRadius: 2000, maxAlt: 120, minCruise: 10, minBattery: 40, minSats: 6, maxDrones: 5, maxPinRadius: 100 };
export const ARM_WINDOW_MS = 30 * 60_000;
export const STALE_MS = { https: 10_000, sms: 120_000 } as const;
export const EXPIRY_S = { https: 30, sms: 300 } as const;
export type Transport = keyof typeof STALE_MS;
/** pinRadius: metres around the pickup pad where the drone may fly to a customer's pin instead (0 or missing = always the pad). */
export type DroneConfig = { home: Point; pickupPad: Point | null; dropPad: Point | null; radius: number; maxAlt: number; cruiseAlt: number; pinRadius?: number };
export type Drone = { id: string; owner: string; name: string; transport: Transport; phone: string | null; phoneVerified: boolean; keyVersion: number; config: DroneConfig; armedUntil: number; activeReturn: string | null; lastSeq: number; lastSeen: number; telemetry: LiveTelemetry | null; createdAt: number };
export type PlannedCommand = { type: CommandType; args: number[] };
export type ArmChecklist = { pilot: boolean; airspace: boolean; pads: boolean; failsafe: boolean };

const ON_GROUND = ['IDLE', 'LANDED'];
/** Phases where the drone sits landed waiting for a person; HOLD there is a no-op, not a pause. */
export const GROUND_PHASES: MissionPhase[] = ['AWAITING_LOAD', 'READY_TO_LAUNCH', 'AWAITING_UNLOAD'];
export const isStale = (drone: Pick<Drone, 'transport' | 'lastSeen'>, now: number) => now - drone.lastSeen > STALE_MS[drone.transport];
export const airborne = (t: LiveTelemetry | null | undefined) => !!t && !ON_GROUND.includes(t.state) && t.alt > 1.5;
export const insideFence = (c: DroneConfig, p: Point) => distance(c.home, p) <= c.radius;
/** Whether a ground report differs from the stored one in anything dispatchBlockers or Pad = drone reads: state, GPS fix or satellites, the battery floor, or a move of more than 2 m. Such a report is stored at once, not after the idle-ground write interval. */
export function groundChange(stored: LiveTelemetry | null, t: LiveTelemetry | null) {
  if (!t || !stored) return t !== stored;
  return t.state !== stored.state || (t.fix >= 3) !== (stored.fix >= 3) || (t.sats >= LIMITS.minSats) !== (stored.sats >= LIMITS.minSats) || (t.battery >= LIMITS.minBattery) !== (stored.battery >= LIMITS.minBattery) || distance([t.lon, t.lat], [stored.lon, stored.lat]) > 2;
}
/** How far inside the geofence edge a customer's pin must be to serve as the pickup, so the landing never brushes the fence. */
export const PIN_MARGIN_M = 15;
/** Whole metres under 1 km, then km with one decimal. */
export const fmtMeters = (m: number) => (Math.round(m) < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
export type PickupChoice = { point: Point | null; source: 'pin' | 'pad'; pinMeters: number | null; reason: string | null };
/**
 * Where a live flight picks up. The customer's map pin only when this drone has a pin zone (pinRadius > 0, opt-in), the
 * pin lies within pinRadius of the surveyed pickup pad and at least PIN_MARGIN_M inside the geofence; otherwise the
 * pickup pad. pinMeters is the pin's distance from the pickup pad; reason says why a pin was not used.
 */
export function pickupFor(c: DroneConfig, pin: Point | null | undefined): PickupChoice {
  const pad = c.pickupPad, zone = c.pinRadius ?? 0;
  const valid = !!pin && Number.isFinite(pin[0]) && Number.isFinite(pin[1]) && Math.abs(pin[1]) <= 90 && Math.abs(pin[0]) <= 180;
  const pinMeters = valid && pad ? distance(pad, pin!) : null, fromHome = valid ? distance(c.home, pin!) : Infinity;
  const fallback = (reason: string): PickupChoice => ({ point: pad, source: 'pad', pinMeters, reason });
  if (!pad) return fallback('No pickup pad set');
  if (!(zone > 0)) return fallback('Pins are off for this drone');
  if (!valid) return fallback('The customer’s pin is not a valid location');
  if (pinMeters! > zone) return fallback(`Pin is ${fmtMeters(pinMeters!)} from the pickup pad (zone ${fmtMeters(zone)})`);
  if (fromHome > c.radius) return fallback('Pin is outside the geofence');
  if (fromHome > c.radius - PIN_MARGIN_M) return fallback(`Pin is within ${PIN_MARGIN_M} m of the fence edge`);
  return { point: pin!, source: 'pin', pinMeters, reason: null };
}
/** Why a dispatch must be reviewed again: the pickup the operator saw in Fleet is not the one the server would fly to. Old clients that send none may only fly to the pad. */
export function pickupMismatch(choice: PickupChoice, expected: { source: 'pin' | 'pad'; point: Point } | undefined): string | null {
  const same = !expected ? choice.source === 'pad' : expected.source === choice.source && !!choice.point && expected.point[0] === choice.point[0] && expected.point[1] === choice.point[1];
  return same ? null : 'The pickup changed. Review it and dispatch again.';
}

export function configProblem(c: DroneConfig): string | null {
  const valid = (p: Point | null) => !p || (Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180);
  if (![c.home, c.pickupPad, c.dropPad].every(valid)) return 'Coordinates are out of range.';
  const zone = c.pinRadius ?? 0;
  if (!(zone >= 0 && zone <= LIMITS.maxPinRadius)) return `The pin landing zone must be 0–${LIMITS.maxPinRadius} m from the pickup pad (0 = always use the pad).`;
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

/** Moves the mission to `phase` and records a customer-visible event when the tracking state changes. After the unload, nothing the empty drone does changes the customer's return. */
export function enterPhase(r: ReturnRecord, phase: MissionPhase, now: number, cmdSeq: number | null, fault: string | null = null): ReturnRecord {
  const live = { ...r.live!, phase, phaseAt: now, cmdSeq, fault, ...(phase === 'TAKEOFF_HOME' && !r.live!.unloadedAt ? { unloadedAt: now } : {}) };
  const next = { ...r, live, loaded: r.loaded || phase === 'READY_TO_LAUNCH', events: [...r.events] };
  const state = snapshot(next, now).state;
  if (!handedOff(r.live!) && next.events[next.events.length - 1]?.state !== state) next.events.push({ state, title: phase === 'ABORTED' && !next.cancelled ? 'Live flight ended by the pilot' : STATE_TITLES[state], at: now });
  return next;
}
/**
 * A flight that ended in the air (an abort, or the empty drone's way home) takes the drone's first report from the ground
 * as its final one, so an ended flight never shows a mid-air altitude where it stopped. Null when nothing changes.
 */
export function settledFinal(r: ReturnRecord, t: LiveTelemetry): ReturnRecord | null {
  const l = r.live;
  return l && ENDED.includes(l.phase) && airborne(l.finalTelemetry) && !airborne(t) && t.state !== 'ERROR' && t.ts >= l.finalTelemetry!.ts ? { ...r, live: { ...l, finalTelemetry: t } } : null;
}
export function startLive(r: ReturnRecord, drone: Drone, now: number): ReturnRecord {
  const c = drone.config;
  const pickup = pickupFor(c, r.package.pickup);
  const live: LiveFlight = { droneId: drone.id, droneName: drone.name, transport: drone.transport, phase: 'TAKEOFF_OUT', home: c.home, pickupPad: pickup.point!, pickupSource: pickup.source, dropPad: c.dropPad!, cruiseAlt: c.cruiseAlt, cmdSeq: null, fault: null, startedAt: now, phaseAt: now };
  return { ...r, live, paused: false };
}

/** Phase the mission should enter after an ack, or null when the ack changes nothing. */
export function ackOutcome(l: LiveFlight, ack: Pick<Ack, 'cmdSeq' | 'status' | 'reason'>): { phase: MissionPhase; fault: string | null } | null {
  if (ENDED.includes(l.phase) || l.cmdSeq === null || ack.cmdSeq !== l.cmdSeq) return null;
  // A paused mission (operator HOLD, rejection, expiry) only moves again through an operator retry.
  if (l.fault) return null;
  // At a customer's pin the drone hovers until the operator sees the landing area is clear; a pad landing goes straight on.
  if (ack.status === 'DONE') { const next = l.phase === 'TO_PICKUP' && l.pickupSource === 'pin' ? 'HOVER_PICKUP' : NEXT[l.phase]; return next ? { phase: next, fault: null } : null; }
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
    // The new command supersedes any queued TAKEOFF or GOTO: near home or descending, land where it is; en route or over
    // the pin, ABORT, which the bridge flies as an RTL in the air but never as a takeoff from the ground (an RTL on the
    // ground away from home climbs first). So a drone that touches down just before the cancel arrives stays put: a
    // customer never launches a drone. Landed at pickup, nothing is sent. The operator brings it back.
    const command: PlannedCommand | null = l.phase === 'TO_PICKUP' || l.phase === 'HOVER_PICKUP' ? { type: 'ABORT', args: [] } : l.phase === 'TAKEOFF_OUT' || l.phase === 'LAND_PICKUP' ? { type: 'LAND', args: [] } : null;
    return { phase: 'ABORTED', cancelled: true, ...(command ? { command } : {}) };
  }
  throw new Error('Live flight controls belong to the drone operator in Fleet.');
}

export type OperatorAction = 'launch' | 'unload' | 'retry' | 'land' | 'divert-pad';
/** How close to the pin the drone must be hovering for `land`. The bridge's own link-loss HOLD/RTL sends no ack, so the phase alone cannot tell. */
export const PIN_HOVER_M = 10;
export type PinPosition = { where: 'over' | 'landed' | 'away' | 'ground' | 'unknown'; meters: number | null };
/**
 * Where the drone's report puts it while the mission waits in HOVER_PICKUP: hovering over the pin, on the ground at it
 * (an RC landing, or the bridge's own failsafe landing), airborne or on the ground elsewhere (its link-loss return), or unknown.
 */
export function atPin(t: LiveTelemetry | null | undefined, pin: Point): PinPosition {
  if (!t || t.state === 'ERROR') return { where: 'unknown', meters: null };
  const meters = distance([t.lon, t.lat], pin), near = meters <= PIN_HOVER_M;
  return { where: airborne(t) ? (near ? 'over' : 'away') : near ? 'landed' : 'ground', meters };
}
/**
 * Operator actions in Fleet. Every takeoff after dispatch starts here, never from a customer tap, and so does every
 * landing at a customer's pin (`land`, after the operator sees the area is clear, and only while the drone's report puts
 * it over the pin; on the ground at the pin it confirms that landing, and the LAND it sends only disarms the drone).
 * `divert-pad` sends a pin flight that is still airborne to the drone's pickup pad instead. ABORT is handled by the server directly.
 */
export function operatorAction(r: ReturnRecord, action: OperatorAction, pickupPad: Point | null = null, telemetry: LiveTelemetry | null = r.live?.telemetry ?? null): { phase: MissionPhase; command?: PlannedCommand; live?: Partial<LiveFlight> } {
  const l = r.live!;
  if (ENDED.includes(l.phase)) throw new Error('This live flight has ended.');
  if (action === 'launch') { if (l.phase !== 'READY_TO_LAUNCH') throw new Error('Launch is available after the customer confirms loading.'); return { phase: 'TAKEOFF_LOADED', command: phaseCommand(l, 'TAKEOFF_LOADED')! }; }
  if (action === 'unload') { if (l.phase !== 'AWAITING_UNLOAD') throw new Error('Confirm unloading after the drone lands at the drop pad.'); return { phase: 'TAKEOFF_HOME', command: phaseCommand(l, 'TAKEOFF_HOME')! }; }
  if (action === 'land') {
    if (l.phase !== 'HOVER_PICKUP') throw new Error('Land is available while the drone hovers over the customer’s pin.');
    const { where, meters } = atPin(telemetry, l.pickupPad);
    if (where === 'ground') throw new Error(`The drone is on the ground ${fmtMeters(meters!)} from the customer’s pin, so it was not landed there. End the flight with Return home or ABORT.`);
    if (where !== 'over' && where !== 'landed') throw new Error(`${where === 'unknown' ? 'The drone is not hovering' : `The drone is ${fmtMeters(meters!)} from the customer’s pin, not`} over the pin, so it was not landed. Send it to the pickup pad, or bring it home with Return home or ABORT.`);
    return { phase: 'LAND_PICKUP', command: phaseCommand(l, 'LAND_PICKUP')! };
  }
  if (action === 'divert-pad') {
    if (l.pickupSource !== 'pin' || (l.phase !== 'TO_PICKUP' && l.phase !== 'HOVER_PICKUP')) throw new Error('Divert to the pickup pad while the drone flies to or hovers over the customer’s pin.');
    if (!pickupPad) throw new Error('Set a pickup pad first. It is the fallback for pins.');
    // The bridge refuses a GOTO on the ground (NOT_AIRBORNE), so a landed drone would only stall at a fault.
    const at = atPin(telemetry, l.pickupPad).where;
    if (at === 'landed' || at === 'ground') throw new Error('The drone is on the ground, so it cannot fly to the pickup pad from there. Continue at the pin if it landed there, or end the flight with Return home or ABORT.');
    const live = { pickupPad, pickupSource: 'pad' as const };
    return { phase: 'TO_PICKUP', live, command: phaseCommand({ ...l, ...live }, 'TO_PICKUP')! };
  }
  if (!l.fault) throw new Error('There is no paused step to retry.');
  // Re-send the step's command; a fault in a waiting phase just clears.
  const command = phaseCommand(l, l.phase);
  return command ? { phase: l.phase, command } : { phase: l.phase };
}

/** Why a customer action on a live return changed nothing because its drone is gone from the owner's fleet. A drone can only be removed once its flight has ended. */
export const droneGoneError = (l: Pick<LiveFlight, 'phase'>) => (ENDED.includes(l.phase) ? 'This live flight has ended.' : 'The drone for this flight is no longer in the fleet, so nothing changed. Ask the pilot to check the flight.');

type Issue = { path: (string | number)[]; message: string };
const POINT_LABEL: Record<string, string> = { home: 'Home', pickupPad: 'Pickup pad', dropPad: 'Drop pad' };
const NUMBER_LABEL: Record<string, string> = { radius: 'Geofence radius', maxAlt: 'Maximum altitude', cruiseAlt: 'Cruise altitude' };
/** Plain words for a rejected Fleet request, never raw validator paths such as "home.1: Expected number, received null". Ranges come from configProblem. */
export function fleetInputError(issues: Issue[]) {
  const say = ({ path: [key, index] }: Issue) => {
    const k = String(key);
    if (POINT_LABEL[k]) return index === 1 ? `${POINT_LABEL[k]} latitude must be a number between -90 and 90.` : index === 0 ? `${POINT_LABEL[k]} longitude must be a number between -180 and 180.` : `${POINT_LABEL[k]} needs a latitude and a longitude.`;
    if (NUMBER_LABEL[k]) return `${NUMBER_LABEL[k]} must be a number in metres.`;
    if (k === 'pinRadius') return `The pin landing zone must be 0–${LIMITS.maxPinRadius} m from the pickup pad (0 = always use the pad).`;
    if (k === 'pickup') return 'The pickup changed. Review it and dispatch again.';
    if (k === 'name') return 'Give the drone a name of 1–40 characters.';
    if (k === 'phone') return 'Use an E.164 phone number like +15105550123.';
    if (k === 'checklist') return 'Confirm every pre-flight check before arming.';
    if (k === 'returnId') return 'Choose one of your own returns.';
    return 'Fleet did not understand that request. Reload the page and try again.';
  };
  return [...new Set(issues.map(say))].join(' ');
}
