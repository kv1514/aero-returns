/** Deterministic demo flight model. No hardware or flight-control integrations. */
export type Point = [number, number];
export type FlightState = 'IDLE' | 'ASSIGNED' | 'PRE_FLIGHT' | 'EN_ROUTE_TO_PICKUP' | 'ARRIVED_AT_PICKUP' | 'AWAITING_PACKAGE' | 'PACKAGE_LOADED' | 'EN_ROUTE_TO_DROPOFF' | 'ARRIVED_AT_DROPOFF' | 'HANDOFF_PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type PackageInput = { retailer: string; method: 'qr' | 'label'; weight: number; dimensions: [number, number, number]; fragile: boolean; address: string; pickup: Point; instructions: string; service: 'standard' | 'priority'; returnReference?: string; /** Booking-time only: id of this owner's Claude return check; the server verifies it and never stores it in the package. */ agentEventId?: string };
export type Facility = { id: string; name: string; address: string; point: Point; retailers: string[]; methods: string[]; enabled: boolean; available: boolean; maxWeight: number };
export const PICKUPS = [
  { address: '1820 Delaware Street, Berkeley', point: [-122.2764, 37.8738] as Point, label: 'North Berkeley' },
  { address: '1520 Addison Street, Berkeley', point: [-122.2824, 37.8690] as Point, label: 'Central Berkeley' },
  { address: '1900 Stuart Street, Berkeley', point: [-122.2722, 37.8580] as Point, label: 'South Berkeley' },
];
export const DISPATCH: Point = [-122.2933, 37.8798];
/** The simulated fleet standing by around Berkeley. Bases are illustrative demo spots, not real pads or vehicles. */
export type SimDrone = { id: string; name: string; base: Point; battery: number };
export const SIM_FLEET: SimDrone[] = [
  { id: 'aero-104', name: 'AirCart–104', base: DISPATCH, battery: 96 },
  { id: 'aero-217', name: 'AirCart–217', base: [-122.2700, 37.8800], battery: 91 },
  { id: 'aero-332', name: 'AirCart–332', base: [-122.2615, 37.8575], battery: 88 },
  { id: 'aero-458', name: 'AirCart–458', base: [-122.2862, 37.8935], battery: 84 },
  { id: 'aero-561', name: 'AirCart–561', base: [-122.2520, 37.8705], battery: 93 },
];
/** The simulated drone a booking was matched to, recorded at booking time. Returns booked before the fleet existed have none and fly from DISPATCH. */
export type ReturnDrone = { id: string; name: string; base: Point; meters: number };
export const SPEED = { standard: 12, priority: 15 } as const;
/** Seconds a simulated drone spends assigned and in pre-flight before it lifts off (see timing()). */
export const PRE_FLIGHT_S = 10;
export const FACILITIES: Facility[] = [
  { id: 'downtown', name: 'AirCart Downtown Hub', address: 'Shattuck Ave · Berkeley', point: [-122.2672, 37.8671], retailers: ['Amazon', 'Nike', 'Zara', 'Other'], methods: ['qr', 'label'], enabled: true, available: true, maxWeight: 5 },
  { id: 'west', name: 'AirCart West Berkeley', address: 'Fourth Street · Berkeley', point: [-122.2990, 37.8672], retailers: ['Amazon', 'Nike', 'Other'], methods: ['label'], enabled: true, available: true, maxWeight: 5 },
  { id: 'north', name: 'AirCart Northside', address: 'Solano Avenue · Berkeley', point: [-122.2825, 37.8911], retailers: ['Amazon', 'Zara'], methods: ['qr', 'label'], enabled: true, available: true, maxWeight: 2.5 },
  { id: 'retail', name: 'Neighborhood Drop-off', address: 'University Avenue · Berkeley', point: [-122.2757, 37.8715], retailers: ['Amazon', 'Nike', 'Zara', 'Other'], methods: ['qr', 'label'], enabled: false, available: true, maxWeight: 10 },
];
export const DEMO_PACKAGE: PackageInput = { retailer: 'Amazon', method: 'qr', weight: 1.2, dimensions: [28, 20, 12], fragile: false, address: PICKUPS[0].address, pickup: PICKUPS[0].point, instructions: 'Use the clear area in the front yard.', service: 'standard', returnReference: 'AIRCART-DEMO-2841' };
export function distance(a: Point, b: Point): number {
  const r = Math.PI / 180, dlat = (b[1] - a[1]) * r, dlng = (b[0] - a[0]) * r;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dlng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export function bearing(a: Point, b: Point): number {
  const r = Math.PI / 180, dlng = (b[0] - a[0]) * r;
  return (Math.atan2(Math.sin(dlng) * Math.cos(b[1] * r), Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos(dlng)) / r + 360) % 360;
}
export const pathDistance = (path: Point[]) => path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0);
export function along(path: Point[], meters: number): { point: Point; heading: number; completed: Point[] } {
  let remaining = Math.max(0, meters); const completed: Point[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const length = distance(path[i - 1], path[i]);
    if (remaining <= length) {
      const t = length ? remaining / length : 1;
      const point: Point = [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t];
      return { point, heading: bearing(path[i - 1], path[i]), completed: [...completed, point] };
    }
    completed.push(path[i]); remaining -= length;
  }
  return { point: path[path.length - 1], heading: bearing(path[path.length - 2], path[path.length - 1]), completed: path };
}
// Illustrative demo corridor from a drone's base to the pickup, never an aviation-approved route.
export const inboundRoute = (from: Point, pickup: Point): Point[] => [from, [from[0] + (pickup[0] - from[0]) * .42, from[1] + (pickup[1] - from[1]) * .25], [from[0] + (pickup[0] - from[0]) * .78, from[1] + (pickup[1] - from[1]) * .65], pickup];
/** Free simulated drones nearest the pickup first; minutes is the ETA to the pickup at that service's speed, pre-flight included. */
export function nearestDrones(pickup: Point, busy: string[] = [], service: PackageInput['service'] = 'standard'): { drone: SimDrone; meters: number; minutes: number }[] {
  return SIM_FLEET.filter(d => !busy.includes(d.id)).map(drone => ({ drone, meters: distance(drone.base, pickup), minutes: Math.max(1, Math.ceil((PRE_FLIGHT_S + pathDistance(inboundRoute(drone.base, pickup)) / SPEED[service]) / 60)) })).sort((a, b) => a.meters - b.meters || a.drone.id.localeCompare(b.drone.id));
}
export function recommend(pkg: PackageInput, from: Point = nearestDrones(pkg.pickup)[0]?.drone.base ?? DISPATCH) {
  const max = pkg.service === 'priority' ? 5 : 2.5, dimension = pkg.service === 'priority' ? 60 : 45;
  return FACILITIES.map(f => {
    const reason = !f.enabled ? 'Not enabled for drone handoff' : !f.available ? 'Currently unavailable' : !f.retailers.includes(pkg.retailer) ? 'Retailer not supported' : !f.methods.includes(pkg.method) ? 'Prepaid shipping label required' : pkg.weight > Math.min(max, f.maxWeight) ? `Exceeds ${Math.min(max, f.maxWeight)} kg payload limit` : pkg.dimensions.some(d => d > dimension) ? `Each dimension must be ≤ ${dimension} cm` : distance(pkg.pickup, f.point) > 6000 ? 'Outside the demo service area' : null;
    const meters = distance(pkg.pickup, f.point), minutes = Math.ceil((distance(from, pkg.pickup) + meters) / SPEED[pkg.service] / 60 + .5);
    const price = Math.round((3.5 + meters / 1000 * 1.3 + (pkg.service === 'priority' ? 3 : 0)) * 100) / 100;
    return { ...f, reason, meters, minutes, price };
  }).sort((a, b) => Number(!!a.reason) - Number(!!b.reason) || a.price - b.price || a.minutes - b.minutes);
}
export type FlightEvent = { state: FlightState; title: string; at: number };
/** Live flight phases; see docs/DRONE_LINK.md. Only lib/drone-mission.ts changes them. */
export type MissionPhase = 'TAKEOFF_OUT' | 'TO_PICKUP' | 'HOVER_PICKUP' | 'LAND_PICKUP' | 'AWAITING_LOAD' | 'READY_TO_LAUNCH' | 'TAKEOFF_LOADED' | 'TO_DROP' | 'LAND_DROP' | 'AWAITING_UNLOAD' | 'TAKEOFF_HOME' | 'RETURNING' | 'LAND_HOME' | 'COMPLETE' | 'ABORTED';
export type LiveTelemetry = { ts: number; receivedAt: number; lat: number; lon: number; alt: number; battery: number; heading: number; speed: number; fix: number; sats: number; state: string; mode: string };
export type LiveFlight = { droneId: string; droneName: string; transport: 'https' | 'sms'; phase: MissionPhase; home: Point; pickupPad: Point; /** 'pin' when the drone lands at the customer's map pin; missing on flights from before pins were used. */ pickupSource?: 'pin' | 'pad'; dropPad: Point; cruiseAlt: number; cmdSeq: number | null; fault: string | null; startedAt: number; phaseAt: number; /** When the operator confirmed the unload: from then on the customer's return is delivered, whatever happens to the empty drone. */ unloadedAt?: number; /** The drone's last report when the flight ended, so a finished flight never reads 0% / 0 m. */ finalTelemetry?: LiveTelemetry | null; telemetry?: LiveTelemetry | null; stale?: boolean };
/**
 * Verified summary of a Claude return check attached at booking (lib/return-agent-shared.ts). `hold` is stamped by
 * bookedReview when the check holds the booking for a person; checks stored before a not_drone_eligible verdict held
 * anything have none, so returns that already flew or were delivered keep the state they reached.
 */
export type StoredReview = import('./return-agent-shared').ReturnReview & { hold?: true };
export type ReturnRecord = { review?: StoredReview; id: string; createdAt: number; anchor: number; elapsed: number; rate: number; paused: boolean; loaded: boolean; cancelled: boolean; failed: boolean; version: number; package: PackageInput; facilityId: string; price: number; drone?: ReturnDrone; events: FlightEvent[]; live?: LiveFlight };
/**
 * A return checked as needs_person, or attached with a not_drone_eligible check (Claude's own measurements can rule out
 * a package the entered ones allow), stays on the ground, simulated or live, until a person approves or declines it.
 * needs_person always held; not_drone_eligible holds only when it was attached with the hold stamp (see StoredReview).
 */
export const heldForPerson = (review?: StoredReview | null) => (review?.verdict === 'needs_person' || (review?.verdict === 'not_drone_eligible' && review.hold === true)) && !review.approvedAt && !review.declinedAt;
/** A verified check as the server attaches it to a new booking: a verdict that holds the return is stamped so the hold never applies retroactively. */
export const bookedReview = (review: import('./return-agent-shared').ReturnReview): StoredReview => (review.verdict === 'needs_person' || review.verdict === 'not_drone_eligible' ? { ...review, hold: true } : review);
export const HOLD_MESSAGE = 'A person must approve this return before the drone flies. Approve or decline it on the merchant desk.';
export const STATE_TITLES: Record<FlightState, string> = { IDLE: 'Ready for your return', ASSIGNED: 'Your drone is assigned', PRE_FLIGHT: 'Getting ready for takeoff', EN_ROUTE_TO_PICKUP: 'Your drone is on the way', ARRIVED_AT_PICKUP: 'Your drone has arrived', AWAITING_PACKAGE: 'Ready when you are', PACKAGE_LOADED: 'Package securely loaded', EN_ROUTE_TO_DROPOFF: 'Your return is taking flight', ARRIVED_AT_DROPOFF: 'Your return has landed', HANDOFF_PENDING: 'Completing the handoff', COMPLETED: 'Your return has landed.', FAILED: 'Flight paused for assistance', CANCELLED: 'This return was cancelled' };
export function routes(r: ReturnRecord) {
  const pickup = r.package.pickup, drop = FACILITIES.find(f => f.id === r.facilityId)!.point;
  // Illustrative demo corridors, never aviation-approved routes. The inbound leg starts at the matched drone's base.
  const inbound = inboundRoute(r.drone?.base ?? DISPATCH, pickup);
  const outbound: Point[] = [pickup, [pickup[0] + (drop[0] - pickup[0]) * .3, pickup[1] + (drop[1] - pickup[1]) * .55], [pickup[0] + (drop[0] - pickup[0]) * .7, pickup[1] + (drop[1] - pickup[1]) * .85], drop];
  return { inbound, outbound };
}
export function timing(r: ReturnRecord) {
  const { inbound, outbound } = routes(r), speed = SPEED[r.package.service];
  const pickup = PRE_FLIGHT_S + pathDistance(inbound) / speed, depart = pickup + 8, dropoff = depart + pathDistance(outbound) / speed;
  return { speed, pickup, depart, dropoff, end: dropoff + 12 };
}
export const LIVE_STATE: Record<MissionPhase, FlightState> = { TAKEOFF_OUT: 'PRE_FLIGHT', TO_PICKUP: 'EN_ROUTE_TO_PICKUP', HOVER_PICKUP: 'ARRIVED_AT_PICKUP', LAND_PICKUP: 'ARRIVED_AT_PICKUP', AWAITING_LOAD: 'AWAITING_PACKAGE', READY_TO_LAUNCH: 'PACKAGE_LOADED', TAKEOFF_LOADED: 'PACKAGE_LOADED', TO_DROP: 'EN_ROUTE_TO_DROPOFF', LAND_DROP: 'ARRIVED_AT_DROPOFF', AWAITING_UNLOAD: 'HANDOFF_PENDING', TAKEOFF_HOME: 'COMPLETED', RETURNING: 'COMPLETED', LAND_HOME: 'COMPLETED', COMPLETE: 'COMPLETED', ABORTED: 'CANCELLED' };
export const OUTBOUND_PHASES: MissionPhase[] = ['READY_TO_LAUNCH', 'TAKEOFF_LOADED', 'TO_DROP', 'LAND_DROP', 'AWAITING_UNLOAD', 'TAKEOFF_HOME', 'RETURNING', 'LAND_HOME', 'COMPLETE'];
/** Phases after the operator confirmed the unload: the return is delivered and only the empty drone is still flying. */
export const HANDED_OFF_PHASES: MissionPhase[] = ['TAKEOFF_HOME', 'RETURNING', 'LAND_HOME', 'COMPLETE'];
export const handedOff = (l: Pick<LiveFlight, 'phase' | 'unloadedAt'>) => !!l.unloadedAt || HANDED_OFF_PHASES.includes(l.phase);
/** Tracking values for a live flight, from the drone's last reported telemetry instead of the timeline. */
function liveSnapshot(r: ReturnRecord, now: number) {
  const l = r.live!, tel = l.telemetry ?? l.finalTelemetry, outbound = OUTBOUND_PHASES.includes(l.phase) || (l.phase === 'ABORTED' && r.loaded);
  const path = { inbound: [l.home, l.pickupPad] as Point[], outbound: [l.pickupPad, l.dropPad] as Point[] };
  // After the handoff the return stays delivered: a fault or abort on the empty drone's way home is the operator's, not the customer's.
  // Before it, an ended flight (customer cancel or pilot abort) is terminal and a fault mid-flight is a pause.
  const state: FlightState = handedOff(l) ? 'COMPLETED' : r.cancelled || l.phase === 'ABORTED' ? 'CANCELLED' : l.fault ? 'FAILED' : LIVE_STATE[l.phase];
  const done = state === 'COMPLETED' || state === 'HANDOFF_PENDING', ended = done || state === 'CANCELLED';
  const start = outbound ? l.pickupPad : l.home, target = outbound ? l.dropPad : l.pickupPad;
  const point: Point = tel ? [tel.lon, tel.lat] : done ? l.dropPad : start;
  const leg = distance(start, target), remaining = done ? 0 : distance(point, target);
  const inboundTotal = distance(l.home, l.pickupPad), total = inboundTotal + distance(l.pickupPad, l.dropPad) || 1;
  const traveled = done ? total : (outbound ? inboundTotal : 0) + Math.max(0, leg - remaining);
  // Only the current report moves the drone; a finished flight's final report is shown at rest.
  const flying = !!l.telemetry && tel!.alt > 1.5 && ['TAKEOFF', 'ENROUTE', 'HOLD', 'RTL'].includes(tel!.state);
  const speed = l.telemetry ? l.telemetry.speed : 0, pace = Math.max(speed, 6), eta = ended ? 0 : remaining / pace + 25;
  return { state, elapsed: Math.max(0, now - l.startedAt) / 1000, point, heading: tel?.heading ?? bearing(start, target), completed: [start, point], altitude: tel ? Math.max(0, tel.alt) : 0, speed, battery: tel && tel.battery >= 0 ? tel.battery : 0, remaining, totalRemaining: Math.max(0, total - traveled), progress: Math.min(1, traveled / total), eta, totalEta: ended ? 0 : outbound ? eta : eta + distance(l.pickupPad, l.dropPad) / pace + 50, flying, outbound, path, timestamp: now };
}
export function snapshot(r: ReturnRecord, now: number) {
  if (r.live) return liveSnapshot(r, now);
  const t = timing(r), path = routes(r);
  const raw = r.elapsed + (r.paused || r.cancelled || r.failed || heldForPerson(r.review) ? 0 : Math.max(0, now - r.anchor) / 1000 * r.rate);
  const e = Math.min(raw, r.loaded ? t.end : t.pickup + 3);
  const state: FlightState = r.cancelled ? 'CANCELLED' : r.failed ? 'FAILED' : e < 3 ? 'ASSIGNED' : e < 10 ? 'PRE_FLIGHT' : e < t.pickup ? 'EN_ROUTE_TO_PICKUP' : e < t.pickup + 3 ? 'ARRIVED_AT_PICKUP' : !r.loaded ? 'AWAITING_PACKAGE' : e < t.depart ? 'PACKAGE_LOADED' : e < t.dropoff ? 'EN_ROUTE_TO_DROPOFF' : e < t.dropoff + 3 ? 'ARRIVED_AT_DROPOFF' : e < t.end ? 'HANDOFF_PENDING' : 'COMPLETED';
  const outbound = r.loaded && e >= t.depart, flightPath = outbound ? path.outbound : path.inbound;
  const legTime = outbound ? e - t.depart : e - 10, legDistance = pathDistance(flightPath), flown = Math.max(0, Math.min(legDistance, legTime * t.speed));
  const motion = along(flightPath, flown), flying = state === 'EN_ROUTE_TO_PICKUP' || state === 'EN_ROUTE_TO_DROPOFF';
  const legRemaining = Math.max(0, legDistance - flown), total = pathDistance(path.inbound) + pathDistance(path.outbound);
  const traveled = (outbound ? pathDistance(path.inbound) : 0) + flown;
  const altitude = flying ? Math.min(68, Math.max(0, legTime * 5), legRemaining / t.speed * 5) : 0;
  // Once loaded, the ETA counts down to the handoff even while the drone is still on the ground at pickup.
  const eta = state === 'COMPLETED' ? 0 : r.loaded ? Math.max(0, t.end - e) : Math.max(0, t.pickup - e);
  return { state, elapsed: e, ...motion, altitude, speed: flying && !r.paused ? t.speed : 0, battery: Math.max(0, 98 - traveled / 1000 * (4 + r.package.weight * .6) - e / 60 * .45), remaining: legRemaining, totalRemaining: Math.max(0, total - traveled), progress: traveled / total, eta, totalEta: Math.max(0, t.end - e), flying, outbound, path, timestamp: now };
}
export function settle(r: ReturnRecord, now: number): ReturnRecord {
  if (r.live) return r; // live events are recorded by the mission as the drone reports progress
  const s = snapshot(r, now), t = timing(r);
  const schedule: [FlightState, number][] = [['ASSIGNED', 0], ['PRE_FLIGHT', 3], ['EN_ROUTE_TO_PICKUP', 10], ['ARRIVED_AT_PICKUP', t.pickup], ['AWAITING_PACKAGE', t.pickup + 3]];
  if (r.loaded) schedule.push(['PACKAGE_LOADED', t.pickup + 3], ['EN_ROUTE_TO_DROPOFF', t.depart], ['ARRIVED_AT_DROPOFF', t.dropoff], ['HANDOFF_PENDING', t.dropoff + 3], ['COMPLETED', t.end]);
  const events = [...r.events];
  for (const [state, threshold] of schedule) if (s.elapsed >= threshold && !events.some(e => e.state === state)) events.push({ state, title: STATE_TITLES[state], at: Math.max(r.createdAt, events[events.length - 1]?.at ?? 0, Math.min(now, r.anchor + (threshold - r.elapsed) / r.rate * 1000)) });
  if ((r.cancelled || r.failed) && !events.some(e => e.state === s.state)) events.push({ state: s.state, title: STATE_TITLES[s.state], at: now });
  // Returns saved before the AirCart rename stored "AERO–104"; the id never changed, so show the fleet's current name for it.
  const current = r.drone && SIM_FLEET.find(d => d.id === r.drone!.id);
  return { ...r, events, ...(r.drone && current && current.name !== r.drone.name ? { drone: { ...r.drone, name: current.name } } : {}) };
}
/** Simulated drones flying this owner's other active returns. A live flight uses a real drone, and an ended return frees its drone. */
export function busyDrones(records: ReturnRecord[], now: number): string[] {
  const busy = new Set<string>();
  for (const r of records) { try { if (r.drone && !r.live && !['COMPLETED', 'CANCELLED'].includes(snapshot(r, now).state)) busy.add(r.drone.id); } catch { /* an unreadable record frees nothing */ } }
  return [...busy];
}
/** The drone a new booking gets: the nearest one not busy on another active return, or the nearest overall when all are busy. */
export const assignDrone = (pickup: Point, records: ReturnRecord[], now: number): SimDrone => (nearestDrones(pickup, busyDrones(records, now))[0] ?? nearestDrones(pickup)[0]).drone;
/** Books with `drone` (the nearest when omitted; null keeps a pre-fleet record flying from DISPATCH). */
export function createReturn(pkg: PackageInput, id: string, now: number, drone?: Pick<SimDrone, 'id' | 'name' | 'base'> | null): ReturnRecord {
  const d = drone === undefined ? nearestDrones(pkg.pickup)[0]?.drone : drone;
  const f = recommend(pkg, d?.base ?? DISPATCH).find(f => !f.reason);
  if (!f) throw new Error('No compatible demo facility. Adjust the package or service.');
  return { id, createdAt: now, anchor: now, elapsed: 0, rate: 1, paused: false, loaded: false, cancelled: false, failed: false, version: 0, package: pkg, facilityId: f.id, price: f.price, ...(d ? { drone: { id: d.id, name: d.name, base: d.base, meters: Math.round(distance(d.base, pkg.pickup)) } } : {}), events: [{ state: 'ASSIGNED', title: STATE_TITLES.ASSIGNED, at: now }] };
}
export type Action = 'load' | 'pause' | 'resume' | 'advance' | 'reset' | 'cancel' | 'speed' | 'fail' | 'retry' | 'approve' | 'decline';
export function control(record: ReturnRecord, action: Action, now: number, rate?: number): ReturnRecord {
  if (record.live) throw new Error('Live flight controls belong to the drone operator in Fleet.');
  let r = settle(record, now); const s = snapshot(r, now), t = timing(r);
  if ((s.state === 'COMPLETED' || s.state === 'CANCELLED') && action !== 'reset') throw new Error('This return has ended. Start a new demo or reset it.');
  r = { ...r, elapsed: s.elapsed, anchor: now, version: r.version + 1 };
  if (action === 'load') { if (s.state !== 'AWAITING_PACKAGE') throw new Error('Wait until the drone is ready for your package.'); r.loaded = true; }
  if (action === 'pause') r.paused = true;
  if (action === 'resume') r.paused = false;
  if (action === 'speed') { if (![1, 5, 10].includes(rate!)) throw new Error('Choose 1×, 5×, or 10×.'); r.rate = rate!; }
  if (action === 'approve' || action === 'decline') {
    if (!heldForPerson(r.review)) throw new Error('This return is not waiting for a person.');
    r.review = { ...r.review!, ...(action === 'approve' ? { approvedAt: now } : { declinedAt: now }) };
    if (action === 'decline') r.cancelled = true;
  }
  if (action === 'advance') {
    if (heldForPerson(r.review)) throw new Error(HOLD_MESSAGE);
    if (r.failed) throw new Error('Wait until the flight resumes before skipping ahead.');
    if (!r.loaded && s.elapsed >= t.pickup + 3) throw new Error('Confirm package loading before continuing.');
    r.elapsed = !r.loaded ? t.pickup + 3 : s.elapsed < t.depart ? t.depart : s.elapsed < t.dropoff ? t.dropoff : t.end;
  }
  if (action === 'cancel') { if (r.loaded) throw new Error('A loaded return cannot be cancelled. Complete the demo or reset it.'); r.cancelled = true; }
  if (action === 'fail') r.failed = true;
  if (action === 'retry') { r.failed = false; r.paused = false; }
  // A reset restarts the flight, not the return: its booking time, its drone and any verified Claude check stay attached.
  // A declined return that is reset goes back to waiting for a person; an approval stands.
  if (action === 'reset') r = { ...createReturn(r.package, r.id, now, record.drone ?? null), createdAt: record.createdAt, version: r.version, rate: record.rate, ...(record.review ? { review: { ...record.review, declinedAt: undefined } } : {}) };
  return settle(r, now);
}
