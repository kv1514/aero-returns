/** Deterministic demo flight model. No hardware or flight-control integrations. */
export type Point = [number, number];
export type FlightState = 'IDLE' | 'ASSIGNED' | 'PRE_FLIGHT' | 'EN_ROUTE_TO_PICKUP' | 'ARRIVED_AT_PICKUP' | 'AWAITING_PACKAGE' | 'PACKAGE_LOADED' | 'EN_ROUTE_TO_DROPOFF' | 'ARRIVED_AT_DROPOFF' | 'HANDOFF_PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type PackageInput = { retailer: string; method: 'qr' | 'label'; weight: number; dimensions: [number, number, number]; fragile: boolean; address: string; pickup: Point; instructions: string; service: 'standard' | 'priority'; returnReference?: string };
export type Facility = { id: string; name: string; address: string; point: Point; retailers: string[]; methods: string[]; enabled: boolean; available: boolean; maxWeight: number };
export const PICKUPS = [
  { address: '1820 Delaware Street, Berkeley', point: [-122.2764, 37.8738] as Point, label: 'North Berkeley' },
  { address: '1520 Addison Street, Berkeley', point: [-122.2824, 37.8690] as Point, label: 'Central Berkeley' },
  { address: '1900 Stuart Street, Berkeley', point: [-122.2722, 37.8580] as Point, label: 'South Berkeley' },
];
export const DISPATCH: Point = [-122.2933, 37.8798];
export const FACILITIES: Facility[] = [
  { id: 'downtown', name: 'AERO Downtown Hub', address: 'Shattuck Ave · Berkeley', point: [-122.2672, 37.8671], retailers: ['Amazon', 'Nike', 'Zara', 'Other'], methods: ['qr', 'label'], enabled: true, available: true, maxWeight: 5 },
  { id: 'west', name: 'AERO West Berkeley', address: 'Fourth Street · Berkeley', point: [-122.2990, 37.8672], retailers: ['Amazon', 'Nike', 'Other'], methods: ['label'], enabled: true, available: true, maxWeight: 5 },
  { id: 'north', name: 'AERO Northside', address: 'Solano Avenue · Berkeley', point: [-122.2825, 37.8911], retailers: ['Amazon', 'Zara'], methods: ['qr', 'label'], enabled: true, available: true, maxWeight: 2.5 },
  { id: 'retail', name: 'Neighborhood Drop-off', address: 'University Avenue · Berkeley', point: [-122.2757, 37.8715], retailers: ['Amazon', 'Nike', 'Zara', 'Other'], methods: ['qr', 'label'], enabled: false, available: true, maxWeight: 10 },
];
export const DEMO_PACKAGE: PackageInput = { retailer: 'Amazon', method: 'qr', weight: 1.2, dimensions: [28, 20, 12], fragile: false, address: PICKUPS[0].address, pickup: PICKUPS[0].point, instructions: 'Use the clear area in the front yard.', service: 'standard', returnReference: 'AERO-DEMO-2841' };
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
export function recommend(pkg: PackageInput) {
  const max = pkg.service === 'priority' ? 5 : 2.5, dimension = pkg.service === 'priority' ? 60 : 45;
  return FACILITIES.map(f => {
    const reason = !f.enabled ? 'Not enabled for drone handoff' : !f.available ? 'Currently unavailable' : !f.retailers.includes(pkg.retailer) ? 'Retailer not supported' : !f.methods.includes(pkg.method) ? 'Prepaid shipping label required' : pkg.weight > Math.min(max, f.maxWeight) ? `Exceeds ${Math.min(max, f.maxWeight)} kg payload limit` : pkg.dimensions.some(d => d > dimension) ? `Each dimension must be ≤ ${dimension} cm` : distance(pkg.pickup, f.point) > 6000 ? 'Outside the demo service area' : null;
    const meters = distance(pkg.pickup, f.point), minutes = Math.ceil((distance(DISPATCH, pkg.pickup) + meters) / 12 / 60 + .5);
    const price = Math.round((3.5 + meters / 1000 * 1.3 + (pkg.service === 'priority' ? 3 : 0)) * 100) / 100;
    return { ...f, reason, meters, minutes, price };
  }).sort((a, b) => Number(!!a.reason) - Number(!!b.reason) || a.price - b.price || a.minutes - b.minutes);
}
export type FlightEvent = { state: FlightState; title: string; at: number };
export type ReturnRecord = { id: string; createdAt: number; anchor: number; elapsed: number; rate: number; paused: boolean; loaded: boolean; cancelled: boolean; failed: boolean; version: number; package: PackageInput; facilityId: string; price: number; events: FlightEvent[] };
export const STATE_TITLES: Record<FlightState, string> = { IDLE: 'Ready for your return', ASSIGNED: 'Your drone is assigned', PRE_FLIGHT: 'Getting ready for takeoff', EN_ROUTE_TO_PICKUP: 'Your drone is on the way', ARRIVED_AT_PICKUP: 'Your drone has arrived', AWAITING_PACKAGE: 'Ready when you are', PACKAGE_LOADED: 'Package securely loaded', EN_ROUTE_TO_DROPOFF: 'Your return is taking flight', ARRIVED_AT_DROPOFF: 'Your return has landed', HANDOFF_PENDING: 'Completing the handoff', COMPLETED: 'Your return has landed.', FAILED: 'Flight paused for assistance', CANCELLED: 'This return was cancelled' };
export function routes(r: ReturnRecord) {
  const pickup = r.package.pickup, drop = FACILITIES.find(f => f.id === r.facilityId)!.point;
  // Illustrative demo corridors, never aviation-approved routes.
  const inbound: Point[] = [DISPATCH, [DISPATCH[0] + (pickup[0] - DISPATCH[0]) * .42, DISPATCH[1] + (pickup[1] - DISPATCH[1]) * .25], [DISPATCH[0] + (pickup[0] - DISPATCH[0]) * .78, DISPATCH[1] + (pickup[1] - DISPATCH[1]) * .65], pickup];
  const outbound: Point[] = [pickup, [pickup[0] + (drop[0] - pickup[0]) * .3, pickup[1] + (drop[1] - pickup[1]) * .55], [pickup[0] + (drop[0] - pickup[0]) * .7, pickup[1] + (drop[1] - pickup[1]) * .85], drop];
  return { inbound, outbound };
}
export function timing(r: ReturnRecord) {
  const { inbound, outbound } = routes(r), speed = r.package.service === 'priority' ? 15 : 12;
  const pickup = 10 + pathDistance(inbound) / speed, depart = pickup + 8, dropoff = depart + pathDistance(outbound) / speed;
  return { speed, pickup, depart, dropoff, end: dropoff + 12 };
}
export function snapshot(r: ReturnRecord, now: number) {
  const t = timing(r), path = routes(r);
  const raw = r.elapsed + (r.paused || r.cancelled || r.failed ? 0 : Math.max(0, now - r.anchor) / 1000 * r.rate);
  const e = Math.min(raw, r.loaded ? t.end : t.pickup + 3);
  const state: FlightState = r.cancelled ? 'CANCELLED' : r.failed ? 'FAILED' : e < 3 ? 'ASSIGNED' : e < 10 ? 'PRE_FLIGHT' : e < t.pickup ? 'EN_ROUTE_TO_PICKUP' : e < t.pickup + 3 ? 'ARRIVED_AT_PICKUP' : !r.loaded ? 'AWAITING_PACKAGE' : e < t.depart ? 'PACKAGE_LOADED' : e < t.dropoff ? 'EN_ROUTE_TO_DROPOFF' : e < t.dropoff + 3 ? 'ARRIVED_AT_DROPOFF' : e < t.end ? 'HANDOFF_PENDING' : 'COMPLETED';
  const outbound = r.loaded && e >= t.depart, flightPath = outbound ? path.outbound : path.inbound;
  const legTime = outbound ? e - t.depart : e - 10, legDistance = pathDistance(flightPath), flown = Math.max(0, Math.min(legDistance, legTime * t.speed));
  const motion = along(flightPath, flown), flying = state === 'EN_ROUTE_TO_PICKUP' || state === 'EN_ROUTE_TO_DROPOFF';
  const legRemaining = Math.max(0, legDistance - flown), total = pathDistance(path.inbound) + pathDistance(path.outbound);
  const traveled = (outbound ? pathDistance(path.inbound) : 0) + flown;
  const altitude = flying ? Math.min(68, Math.max(0, legTime * 5), legRemaining / t.speed * 5) : 0;
  const eta = state === 'COMPLETED' ? 0 : outbound ? Math.max(0, t.end - e) : Math.max(0, t.pickup - e);
  return { state, elapsed: e, ...motion, altitude, speed: flying && !r.paused ? t.speed : 0, battery: Math.max(0, 98 - traveled / 1000 * (4 + r.package.weight * .6) - e / 60 * .45), remaining: legRemaining, totalRemaining: Math.max(0, total - traveled), progress: traveled / total, eta, totalEta: Math.max(0, t.end - e), flying, outbound, path, timestamp: now };
}
export function settle(r: ReturnRecord, now: number): ReturnRecord {
  const s = snapshot(r, now), t = timing(r);
  const schedule: [FlightState, number][] = [['ASSIGNED', 0], ['PRE_FLIGHT', 3], ['EN_ROUTE_TO_PICKUP', 10], ['ARRIVED_AT_PICKUP', t.pickup], ['AWAITING_PACKAGE', t.pickup + 3]];
  if (r.loaded) schedule.push(['PACKAGE_LOADED', t.pickup + 3], ['EN_ROUTE_TO_DROPOFF', t.depart], ['ARRIVED_AT_DROPOFF', t.dropoff], ['HANDOFF_PENDING', t.dropoff + 3], ['COMPLETED', t.end]);
  const events = [...r.events];
  for (const [state, threshold] of schedule) if (s.elapsed >= threshold && !events.some(e => e.state === state)) events.push({ state, title: STATE_TITLES[state], at: Math.max(r.createdAt, Math.min(now, r.anchor + (threshold - r.elapsed) / r.rate * 1000)) });
  if ((r.cancelled || r.failed) && !events.some(e => e.state === s.state)) events.push({ state: s.state, title: STATE_TITLES[s.state], at: now });
  return { ...r, events };
}
export function createReturn(pkg: PackageInput, id: string, now: number): ReturnRecord {
  const f = recommend(pkg).find(f => !f.reason);
  if (!f) throw new Error('No compatible demo facility. Adjust the package or service.');
  return { id, createdAt: now, anchor: now, elapsed: 0, rate: 1, paused: false, loaded: false, cancelled: false, failed: false, version: 0, package: pkg, facilityId: f.id, price: f.price, events: [{ state: 'ASSIGNED', title: STATE_TITLES.ASSIGNED, at: now }] };
}
export type Action = 'load' | 'pause' | 'resume' | 'advance' | 'reset' | 'cancel' | 'speed' | 'fail' | 'retry';
export function control(record: ReturnRecord, action: Action, now: number, rate?: number): ReturnRecord {
  let r = settle(record, now); const s = snapshot(r, now), t = timing(r);
  if ((s.state === 'COMPLETED' || s.state === 'CANCELLED') && action !== 'reset') throw new Error('This return has ended. Start a new demo or reset it.');
  r = { ...r, elapsed: s.elapsed, anchor: now, version: r.version + 1 };
  if (action === 'load') { if (s.state !== 'AWAITING_PACKAGE') throw new Error('Wait until the drone is ready for your package.'); r.loaded = true; }
  if (action === 'pause') r.paused = true;
  if (action === 'resume') r.paused = false;
  if (action === 'speed') { if (![1, 5, 10].includes(rate!)) throw new Error('Choose 1×, 5×, or 10×.'); r.rate = rate!; }
  if (action === 'advance') {
    if (!r.loaded && s.elapsed >= t.pickup + 3) throw new Error('Confirm package loading before continuing.');
    r.elapsed = !r.loaded ? t.pickup + 3 : s.elapsed < t.depart ? t.depart : s.elapsed < t.dropoff ? t.dropoff : t.end;
  }
  if (action === 'cancel') { if (r.loaded) throw new Error('A loaded return cannot be cancelled. Complete the demo or reset it.'); r.cancelled = true; }
  if (action === 'fail') r.failed = true;
  if (action === 'retry') { r.failed = false; r.paused = false; }
  if (action === 'reset') r = { ...createReturn(r.package, r.id, now), version: r.version, rate: record.rate };
  return settle(r, now);
}
