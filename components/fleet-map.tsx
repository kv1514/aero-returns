'use client';
import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, GeoJSONSource, Marker } from 'maplibre-gl';
import { fmtMeters, type DroneConfig } from '@/lib/drone-mission';
import { distance, type LiveTelemetry, type Point } from '@/lib/simulation';
import { flightPlan } from '@/lib/fleet-view';
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
// Satellite imagery with road and place labels on top (Esri World Imagery; no key needed), so pads are placed against what is really on the ground.
const esri = (path: string) => `https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`;
const SATELLITE = { version: 8 as const, sources: {
  imagery: { type: 'raster' as const, tiles: [esri('World_Imagery')], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  roads: { type: 'raster' as const, tiles: [esri('Reference/World_Transportation')], tileSize: 256, maxzoom: 19 },
  places: { type: 'raster' as const, tiles: [esri('Reference/World_Boundaries_and_Places')], tileSize: 256, maxzoom: 19 } },
  layers: [{ id: 'imagery', type: 'raster' as const, source: 'imagery' }, { id: 'roads', type: 'raster' as const, source: 'roads', paint: { 'raster-opacity': .8 } }, { id: 'places', type: 'raster' as const, source: 'places' }] };
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
    // Every leg the drone flies, plus drone → pickup, with its length at the midpoint.
    const drone: Point | null = t ? [t.lon, t.lat] : null;
    const all: [string, Point | null, Point | null][] = [['hp', c.home, c.pickupPad], ['pd', c.pickupPad, c.dropPad], ['dh', c.dropPad, c.home], ['xp', drone, c.pickupPad]];
    const legs = all.filter((g): g is [string, Point, Point] => !!g[1] && !!g[2]);
    (m.getSource('legs') as GeoJSONSource).setData({ type: 'FeatureCollection', features: legs.map(([, a, b]) => line([a, b])) });
    const plan = flightPlan(c);
    (m.getSource('corridor') as GeoJSONSource).setData(plan ? { type: 'FeatureCollection', features: plan.corridor.map(r => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [r] } })) } : none);
    (m.getSource('escape') as GeoJSONSource).setData(plan ? { type: 'FeatureCollection', features: plan.escapes.map(([a, b]) => line([a, b])) } : none);
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
      for (const id of ['hp', 'pd', 'dh', 'xp']) {
        const leg = legs.find(g => g[0] === id), key = `leg-${id}`;
        if (!leg) { markers.current[key]?.remove(); delete markers.current[key]; continue; }
        const [, a, b] = leg, mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], text = `${id === 'xp' ? 'drone ' : ''}${near(distance(a, b))}`;
        if (!markers.current[key]) { const el = document.createElement('div'); el.className = 'fleet-dist'; markers.current[key] = new ml.Marker({ element: el, anchor: 'center' }).setLngLat(mid).addTo(m); }
        markers.current[key].setLngLat(mid); markers.current[key].getElement().textContent = text;
      }
      const arrow = markers.current.drone?.getElement().querySelector('i') as HTMLElement | null; if (arrow && t) arrow.style.transform = `rotate(${t.heading}deg)`;
    });
  }
  useEffect(() => {
    let disposed = false;
    import('maplibre-gl').then(ml => {
      if (disposed || !container.current) return;
      // app/fleet/fleet.css lifts the attribution above the Home/Pickup/Drop bar along the bottom of the card.
      const m = new ml.Map({ container: container.current, style: SATELLITE, center: latest.current.config.home, zoom: 16, maxZoom: 21, attributionControl: { compact: true } });
      m.addControl(new ml.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'top-left');
      map.current = m;
      m.once('style.load', () => {
        m.addSource('fence', { type: 'geojson', data: circle(latest.current.config.home, latest.current.config.radius) });
        m.addLayer({ id: 'fence-fill', type: 'fill', source: 'fence', paint: { 'fill-color': '#06c167', 'fill-opacity': .07 } });
        m.addLayer({ id: 'fence-line', type: 'line', source: 'fence', paint: { 'line-color': '#3cf08a', 'line-width': 2, 'line-dasharray': [2, 2] } });
        m.addSource('pinzone', { type: 'geojson', data: none });
        m.addLayer({ id: 'pinzone-fill', type: 'fill', source: 'pinzone', paint: { 'fill-color': '#ff6937', 'fill-opacity': .08 } });
        m.addLayer({ id: 'pinzone-line', type: 'line', source: 'pinzone', paint: { 'line-color': '#e0521f', 'line-width': 1.5, 'line-dasharray': [1, 2] } });
        m.addSource('trail', { type: 'geojson', data: line([]) });
        m.addLayer({ id: 'trail', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffd400', 'line-width': 3, 'line-opacity': .9 } });
        // Flight-plan analysis under the legs: the ±GPS-error corridor and landing circles, and the emergency return path.
        m.addSource('corridor', { type: 'geojson', data: none });
        m.addLayer({ id: 'corridor-fill', type: 'fill', source: 'corridor', paint: { 'fill-color': '#ffffff', 'fill-opacity': .16 } });
        m.addLayer({ id: 'corridor-line', type: 'line', source: 'corridor', paint: { 'line-color': '#ffffff', 'line-width': 1, 'line-opacity': .55 } });
        m.addSource('escape', { type: 'geojson', data: none });
        m.addLayer({ id: 'escape', type: 'line', source: 'escape', paint: { 'line-color': '#ff4d4d', 'line-width': 2.5, 'line-dasharray': [1.5, 1.5] } });
        m.addSource('legs', { type: 'geojson', data: none });
        m.addLayer({ id: 'legs-casing', type: 'line', source: 'legs', paint: { 'line-color': '#000', 'line-width': 4, 'line-opacity': .45 } });
        m.addLayer({ id: 'legs', type: 'line', source: 'legs', paint: { 'line-color': '#fff', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
        ready.current = true; draw();
        const c = latest.current.config, pts = [c.home, c.pickupPad, c.dropPad].filter(Boolean) as Point[];
        const r = c.radius / 111000;
        // Open on the pads (zoomed in close for short test hops); with no pads yet, show the whole geofence.
        if (pts.length > 1) m.fitBounds([[Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))], [Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]], { padding: 70, duration: 0, maxZoom: 20 });
        else m.fitBounds([[c.home[0] - r * 1.3, c.home[1] - r], [c.home[0] + r * 1.3, c.home[1] + r]], { padding: 30, duration: 0, maxZoom: 17 });
      });
      m.on('click', e => { if (latest.current.placing) latest.current.onPlace([e.lngLat.lng, e.lngLat.lat]); });
    });
    return () => { disposed = true; ready.current = false; Object.values(markers.current).forEach(m => m.remove()); markers.current = {}; map.current?.remove(); map.current = null; };
  }, []);
  useEffect(() => { latest.current = { config, telemetry, trail, customerPin, placing, onPlace, editable, onMove }; draw(); });
  return <div ref={container} className={`fleet-map ${placing ? 'placing' : ''} ${editable && onMove ? 'editable' : ''}`} aria-label="Drone map with geofence, pin zone, pads and live position" />;
}
