/** Pure, client-safe helpers for the Fleet console (components/fleet-console.tsx), kept here so tests can import them. */
import { bearing, distance, heldForPerson, snapshot, type LiveTelemetry, type Point, type ReturnRecord } from './simulation';
import { airborne, fmtMeters, type Drone, type DroneConfig, type PickupChoice } from './drone-mission';

/** How long ago a timestamp was: seconds, then whole minutes, hours and days (never "320 min ago"). */
export function ago(ts: number, now: number) {
  const ms = now - ts;
  return !ts ? 'never' : ms < 2000 ? 'just now' : ms < 120_000 ? `${Math.round(ms / 1000)}s ago` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)} h ago` : `${Math.floor(ms / 86_400_000)} d ago`;
}

/**
 * The server's clock now, from the server time of the last answer and how long ago the console received it. While the
 * console is offline no answer arrives, so ages measured with this keep counting instead of freezing at the last poll.
 */
export const serverNow = (serverAt: number, receivedAt: number, clientNow: number) => serverAt + Math.max(0, clientNow - receivedAt);

/**
 * Returns the operator could fly: `ready` can be dispatched; `held` wait for a person on the merchant desk, so Fleet lists
 * them as blocked instead of letting dispatch fail with HOLD_MESSAGE. The server's dispatchBlockers still decides.
 */
export function dispatchChoices(returns: ReturnRecord[], now: number) {
  const active = returns.filter(r => !r.live && !r.loaded && !r.cancelled && !r.failed && !['COMPLETED', 'CANCELLED'].includes(snapshot(r, now).state));
  return { ready: active.filter(r => !heldForPerson(r.review)), held: active.filter(r => heldForPerson(r.review)) };
}

/** The bridge command lines for a drone. Both the dry run and the MAVLink line carry the drone's own fence and altitude limits, so a dry run refuses exactly what the real one would. */
export function bridgeCommand(d: Pick<Drone, 'id' | 'transport' | 'config'>, origin: string, key = '<key from registration>') {
  const [lng, lat] = d.config.home, home = `${lat.toFixed(6)},${lng.toFixed(6)}`, transport = d.transport === 'sms' ? '--transport sms --modem /dev/ttyUSB0 --sms-to <Twilio number>' : `--transport https --server ${origin}`;
  const limits = `--fence-radius ${d.config.radius} --max-alt ${d.config.maxAlt} --cruise-alt ${d.config.cruiseAlt}`;
  return `export AERO_DRONE_ID=${d.id}\nexport AERO_DRONE_KEY=${key}\n\n# Test first with the built-in simulator (no drone):\npython3 bridge/aero_bridge.py ${transport} --vehicle fake --fake-home ${home} \\\n  --fence-center ${home} ${limits}\n\n# PX4 / ArduPilot (SITL or real flight controller):\npython3 bridge/aero_bridge.py ${transport} --vehicle mavlink --connect udpin:0.0.0.0:14550 \\\n  --fence-center ${home} ${limits} --live`;
}

/** Fleet's preview of where a dispatch picks up. A pin flight hovers there until the operator lands it. */
export function pickupPreview(p: PickupChoice) {
  if (!p.point) return 'Set a pickup pad first. It is the fallback for pins.';
  return p.source === 'pin' ? `Flies to the customer’s pin, ${fmtMeters(p.pinMeters!)} from the pickup pad, and hovers there. You land it from here once the area is clear.` : `Uses the pickup pad${p.reason ? `. ${p.reason}.` : '.'}`;
}

/** How far from home the drone would take off from the ground, when more than 20 m (people may be near a pickup or drop pad); Infinity without telemetry, null when airborne or at home. */
export function awayOnGround(home: Point, t: LiveTelemetry | null): number | null {
  if (airborne(t)) return null;
  const m = t ? distance(home, [t.lon, t.lat]) : Infinity;
  return m > 20 ? m : null;
}
/** The point `meters` ahead of the drone's nose ([lon, lat]), from its own GPS and compass, for placing a pad a few meters away. */
export function pointAhead(t: Pick<LiveTelemetry, 'lat' | 'lon' | 'heading'>, meters: number): Point {
  const h = t.heading * Math.PI / 180;
  return pointOffset([t.lon, t.lat], Math.cos(h) * meters, Math.sin(h) * meters);
}
/** `p` moved `north` and `east` meters (negative for south and west), for nudging a pad. */
export const pointOffset = ([lon, lat]: Point, north: number, east: number): Point => [lon + east / (111320 * Math.cos(lat * Math.PI / 180)), lat + north / 111320];
/** Compass word for a heading, e.g. 87 → "E". */
export const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
/** Google Street View at a point, through the public Maps URLs API (no key needed; opens in Google Maps). */
export const streetViewUrl = ([lon, lat]: Point) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}`;
/** Typical consumer-GPS error used for the flight-plan corridor (±m). An estimate for planning, not a measurement. */
export const GPS_ERROR_M = 3;
/** Horizontal speed assumed for the flight-plan time estimate (m/s). */
export const PLAN_SPEED_MS = 3;
const near = (m: number) => m < 10 ? `${m.toFixed(1)} m` : fmtMeters(m);
export type PlanLeg = { from: string; to: string; a: Point; b: Point; meters: number; bearing: number };
export type FlightPlan = { legs: PlanLeg[]; meters: number; minutes: number; corridor: Point[][]; escapes: [Point, Point][]; warnings: string[] };
const ring = (c: Point, r: number) => Array.from({ length: 25 }, (_, i) => pointOffset(c, Math.cos(i / 24 * 2 * Math.PI) * r, Math.sin(i / 24 * 2 * Math.PI) * r));
/**
 * The mission the drone flies (home → pickup pad → drop pad → home, all at cruise altitude), with a ±GPS-error corridor around
 * every leg and landing circle, the straight emergency return from the pickup pad (ABORT / link loss fly back to home), a rough
 * time estimate, and warnings for setups that leave no margin. Pins are not included: a pin pickup is decided per return.
 */
export function flightPlan(c: DroneConfig, gpsError = GPS_ERROR_M): FlightPlan | null {
  if (!c.pickupPad || !c.dropPad) return null;
  const stops: [string, Point][] = [['Home', c.home], ['Pickup pad', c.pickupPad], ['Drop pad', c.dropPad], ['Home', c.home]];
  const legs = stops.slice(1).map(([to, b], i): PlanLeg => { const [from, a] = stops[i]; return { from, to, a, b, meters: distance(a, b), bearing: bearing(a, b) }; });
  const meters = legs.reduce((sum, l) => sum + l.meters, 0);
  // Three climbs to cruise (~1 m/s) and three landings (~0.5 m/s) on top of the horizontal legs.
  const minutes = (meters / PLAN_SPEED_MS + 3 * (c.cruiseAlt / 1 + c.cruiseAlt / 0.5)) / 60;
  const corridor = [...legs.filter(l => l.meters > .1).map(l => {
    const left = (l.bearing - 90) * Math.PI / 180, n = Math.cos(left) * gpsError, e = Math.sin(left) * gpsError;
    return [pointOffset(l.a, n, e), pointOffset(l.b, n, e), pointOffset(l.b, -n, -e), pointOffset(l.a, -n, -e), pointOffset(l.a, n, e)];
  }), ring(c.pickupPad, gpsError), ring(c.dropPad, gpsError), ring(c.home, gpsError)];
  const warnings: string[] = [];
  if (c.cruiseAlt < 5) warnings.push(`Cruise ${c.cruiseAlt} m is below 5 m: almost no room for GPS error or obstacles, and an ABORT this low switches to Return home close to the ground.`);
  for (const [name, pad] of [['Pickup pad', c.pickupPad], ['Drop pad', c.dropPad]] as const) {
    const d = distance(c.home, pad);
    if (d < 2 * gpsError) warnings.push(`${name} is ${near(d)} from home, inside GPS error (about ±${gpsError} m each): it may land on the wrong spot.`);
    else if (d >= 10 && d <= 30) warnings.push(`${name} is ${near(d)} from home: after landing there, the bridge can take it as home, so Return home would come back to it. Keep pads more than 30 m from home.`);
    if (d + gpsError > c.radius) warnings.push(`${name} is within GPS error of the geofence edge.`);
  }
  const between = distance(c.pickupPad, c.dropPad);
  if (between < 2 * gpsError) warnings.push(`Pickup and drop pads are ${near(between)} apart, inside GPS error: the landings may overlap.`);
  return { legs, meters, minutes, corridor, escapes: [[c.pickupPad, c.home]], warnings };
}
