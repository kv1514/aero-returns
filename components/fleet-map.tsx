'use client';
import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, GeoJSONSource, Marker } from 'maplibre-gl';
import { fmtMeters, type DroneConfig } from '@/lib/drone-mission';
import { distance, type LiveTelemetry, type Point } from '@/lib/simulation';
import 'maplibre-gl/dist/maplibre-gl.css';

export type PadKey = 'home' | 'pickupPad' | 'dropPad';
type Props = { config: DroneConfig; telemetry: LiveTelemetry | null; trail: LiveTelemetry[]; customerPin?: Point | null; placing: string | null; onPlace: (p: Point) => void; editable?: boolean; onMove?: (pad: PadKey, p: Point) => Promise<boolean> };
const PAD_OF: Record<string, PadKey> = { home: 'home', pickup: 'pickupPad', drop: 'dropPad' };
const near = (m: number) => m < 10 ? `${m.toFixed(1)} m` : fmtMeters(m);
const circle = ([lng, lat]: Point, meters: number) => {
  const ring = Array.from({ length: 65 }, (_, i) => { const a = (i / 64) * 2 * Math.PI; return [lng + (meters / (111320 * Math.cos(lat * Math.PI / 180))) * Math.cos(a), lat + (meters / 110540) * Math.sin(a)]; });
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [ring] } };
};
const none = { type: 'FeatureCollection' as const, features: [] };
const line = (coordinates: number[][]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: coordinates.length > 1 ? coordinates : [[0, 0], [0, 0]] } });
const pin = (kind: string, text: string) => { const el = document.createElement('div'); el.className = `fleet-pin ${kind}`; el.innerHTML = '<i></i><span></span>'; el.querySelector('span')!.textContent = text; return el; };

/** Operator map: geofence, the pin zone around the pickup pad, home and pads, live drone position and recent track. */
export default function FleetMap({ config, telemetry, trail, customerPin = null, placing, onPlace, editable = false, onMove }: Props) {
  const container = useRef<HTMLDivElement>(null), map = useRef<MapLibreMap | null>(null), markers = useRef<Record<string, Marker>>({}), ready = useRef(false);
  // A pad being dragged, or dropped and waiting for the server, keeps its spot instead of snapping back on the next telemetry refresh.
  const dragging = useRef<string | null>(null), held = useRef<Record<string, Point>>({});
  const latest = useRef({ config, telemetry, trail, customerPin, placing, onPlace, editable, onMove });
  function draw() {
    const m = map.current; if (!m || !ready.current) return;
    const { config: c, telemetry: t, trail: tr, customerPin: pinPoint } = latest.current;
    (m.getSource('fence') as GeoJSONSource).setData(circle(c.home, c.radius));
    (m.getSource('pinzone') as GeoJSONSource).setData(c.pickupPad && (c.pinRadius ?? 0) > 0 ? circle(c.pickupPad, c.pinRadius!) : none);
    (m.getSource('trail') as GeoJSONSource).setData(line(tr.map(p => [p.lon, p.lat])));
    import('maplibre-gl').then(ml => {
      const place = (key: string, point: Point | null, kind: string, label: string) => {
        if (!point) { markers.current[key]?.remove(); delete markers.current[key]; return; }
        if (!markers.current[key]) {
          const mk = new ml.Marker({ element: pin(kind, label), anchor: 'center' }).setLngLat(point).addTo(m), pad = PAD_OF[key];
          if (pad) {
            const span = mk.getElement().querySelector('span')!;
            let start: Point = point;
            mk.on('dragstart', () => { dragging.current = key; const { lng, lat } = mk.getLngLat(); start = [lng, lat]; });
            // While dragging, the label shows how far the pad is from the drone, or how far it has moved with no telemetry.
            mk.on('drag', () => { const { lng, lat } = mk.getLngLat(), tel = latest.current.telemetry; span.textContent = tel ? `${near(distance([tel.lon, tel.lat], [lng, lat]))} from drone` : `moved ${near(distance(start, [lng, lat]))}`; });
            mk.on('dragend', () => {
              const { lng, lat } = mk.getLngLat(), p: Point = [lng, lat]; dragging.current = null; held.current[key] = p;
              // On success the pad stays where it was dropped; a refusal (e.g. outside the geofence) puts it back.
              void Promise.resolve(latest.current.onMove?.(pad, p)).then(ok => ok === false ? latest.current.config[pad] ?? p : p, () => latest.current.config[pad] ?? p).then(at => { delete held.current[key]; mk.setLngLat(at); span.textContent = label; });
            });
          }
          markers.current[key] = mk;
        }
        const mk = markers.current[key];
        if (PAD_OF[key]) mk.setDraggable(!!latest.current.editable && !!latest.current.onMove);
        if (dragging.current === key) return;
        mk.setLngLat(held.current[key] ?? point);
        mk.getElement().querySelector('span')!.textContent = label;
      };
      place('home', c.home, 'home', 'Home'); place('pickup', c.pickupPad, 'pad', 'Pickup pad'); place('drop', c.dropPad, 'pad drop', 'Drop pad'); place('customer', pinPoint, 'pad customer', 'Customer pin');
      place('drone', t ? [t.lon, t.lat] : null, 'drone', `${Math.round(t?.alt ?? 0)} m`);
      const arrow = markers.current.drone?.getElement().querySelector('i') as HTMLElement | null; if (arrow && t) arrow.style.transform = `rotate(${t.heading}deg)`;
    });
  }
  useEffect(() => {
    let disposed = false;
    import('maplibre-gl').then(ml => {
      if (disposed || !container.current) return;
      // app/fleet/fleet.css lifts the attribution above the Home/Pickup/Drop bar along the bottom of the card.
      const m = new ml.Map({ container: container.current, style: 'https://tiles.openfreemap.org/styles/positron', center: latest.current.config.home, zoom: 16, attributionControl: { compact: true } });
      map.current = m;
      m.once('style.load', () => {
        m.addSource('fence', { type: 'geojson', data: circle(latest.current.config.home, latest.current.config.radius) });
        m.addLayer({ id: 'fence-fill', type: 'fill', source: 'fence', paint: { 'fill-color': '#06c167', 'fill-opacity': .07 } });
        m.addLayer({ id: 'fence-line', type: 'line', source: 'fence', paint: { 'line-color': '#06a35a', 'line-width': 2, 'line-dasharray': [2, 2] } });
        m.addSource('pinzone', { type: 'geojson', data: none });
        m.addLayer({ id: 'pinzone-fill', type: 'fill', source: 'pinzone', paint: { 'fill-color': '#ff6937', 'fill-opacity': .08 } });
        m.addLayer({ id: 'pinzone-line', type: 'line', source: 'pinzone', paint: { 'line-color': '#e0521f', 'line-width': 1.5, 'line-dasharray': [1, 2] } });
        m.addSource('trail', { type: 'geojson', data: line([]) });
        m.addLayer({ id: 'trail', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-width': 3, 'line-opacity': .7 } });
        ready.current = true; draw();
        const c = latest.current.config, pts = [c.home, c.pickupPad, c.dropPad].filter(Boolean) as Point[];
        const r = c.radius / 111000;
        m.fitBounds([[c.home[0] - r * 1.3, c.home[1] - r], [c.home[0] + r * 1.3, c.home[1] + r]], { padding: 30, duration: 0, maxZoom: pts.length > 1 ? 18 : 17 });
      });
      m.on('click', e => { if (latest.current.placing) latest.current.onPlace([e.lngLat.lng, e.lngLat.lat]); });
    });
    return () => { disposed = true; ready.current = false; Object.values(markers.current).forEach(m => m.remove()); markers.current = {}; map.current?.remove(); map.current = null; };
  }, []);
  useEffect(() => { latest.current = { config, telemetry, trail, customerPin, placing, onPlace, editable, onMove }; draw(); });
  return <div ref={container} className={`fleet-map ${placing ? 'placing' : ''} ${editable && onMove ? 'editable' : ''}`} aria-label="Drone map with geofence, pin zone, pads and live position" />;
}
