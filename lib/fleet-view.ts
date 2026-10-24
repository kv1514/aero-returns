/** Pure, client-safe helpers for the Fleet console (components/fleet-console.tsx), kept here so tests can import them. */
import { distance, heldForPerson, snapshot, type LiveTelemetry, type Point, type ReturnRecord } from './simulation';
import { airborne, fmtMeters, type Drone, type PickupChoice } from './drone-mission';

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
