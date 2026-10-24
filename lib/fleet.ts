/** Ambient simulated fleet: a few demo drones that loop between the demo hubs forever, so the
 * tracking map is always alive. Positions are a pure function of time, so every tab agrees. */
import { along, DISPATCH, FACILITIES, PICKUPS, pathDistance, type Point } from './simulation';

/** Keyless vector basemap (OpenFreeMap, OpenMapTiles schema, OpenStreetMap data). */
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
export const MAP_ATTRIBUTION = [['OpenFreeMap', 'https://openfreemap.org'], ['© OpenMapTiles', 'https://www.openmaptiles.org/'], ['© OpenStreetMap', 'https://www.openstreetmap.org/copyright']] as const;

const hub = (id: string) => FACILITIES.find(f => f.id === id)!.point;
const bend = (a: Point, b: Point, k: number): Point => { const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return [mid[0] - (b[1] - a[1]) * k, mid[1] + (b[0] - a[0]) * k]; };
function loop(stops: Point[], k = .18): Point[] {
  const path: Point[] = [];
  stops.forEach((p, i) => { const next = stops[(i + 1) % stops.length]; path.push(p, bend(p, next, k)); });
  path.push(stops[0]);
  return path;
}
export type FleetDrone = { id: string; speed: number; offset: number; path: Point[]; length: number };
export const FLEET: FleetDrone[] = [
  { id: 'AERO–201', speed: 13, offset: 0, path: loop([DISPATCH, hub('north'), hub('downtown')]) },
  { id: 'AERO–117', speed: 11, offset: 900, path: loop([hub('west'), PICKUPS[1].point, hub('downtown'), PICKUPS[2].point], -.12) },
  { id: 'AERO–342', speed: 14, offset: 2100, path: loop([hub('downtown'), PICKUPS[0].point, hub('north'), DISPATCH], .1) },
].map(d => ({ ...d, length: pathDistance(d.path) }));

export function fleetPositions(now: number) {
  return FLEET.map(d => {
    const { point, heading } = along(d.path, (now / 1000 * d.speed + d.offset) % d.length);
    return { id: d.id, point, heading };
  });
}
