'use client';
import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, GeoJSONSource, Marker } from 'maplibre-gl';
import type { DroneConfig } from '@/lib/drone-mission';
import type { LiveTelemetry, Point } from '@/lib/simulation';
import 'maplibre-gl/dist/maplibre-gl.css';

type Props = { config: DroneConfig; telemetry: LiveTelemetry | null; trail: LiveTelemetry[]; placing: string | null; onPlace: (p: Point) => void };
const circle = ([lng, lat]: Point, meters: number) => {
  const ring = Array.from({ length: 65 }, (_, i) => { const a = (i / 64) * 2 * Math.PI; return [lng + (meters / (111320 * Math.cos(lat * Math.PI / 180))) * Math.cos(a), lat + (meters / 110540) * Math.sin(a)]; });
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [ring] } };
};
const line = (coordinates: number[][]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: coordinates.length > 1 ? coordinates : [[0, 0], [0, 0]] } });
const pin = (kind: string, text: string) => { const el = document.createElement('div'); el.className = `fleet-pin ${kind}`; el.innerHTML = '<i></i><span></span>'; el.querySelector('span')!.textContent = text; return el; };

/** Operator map: geofence, home and pads, live drone position and recent track. */
export default function FleetMap({ config, telemetry, trail, placing, onPlace }: Props) {
  const container = useRef<HTMLDivElement>(null), map = useRef<MapLibreMap | null>(null), markers = useRef<Record<string, Marker>>({}), ready = useRef(false);
  const latest = useRef({ config, telemetry, trail, placing, onPlace });
  function draw() {
    const m = map.current; if (!m || !ready.current) return;
    const { config: c, telemetry: t, trail: tr } = latest.current;
    (m.getSource('fence') as GeoJSONSource).setData(circle(c.home, c.radius));
    (m.getSource('trail') as GeoJSONSource).setData(line(tr.map(p => [p.lon, p.lat])));
    import('maplibre-gl').then(ml => {
      const place = (key: string, point: Point | null, kind: string, label: string) => {
        if (!point) { markers.current[key]?.remove(); delete markers.current[key]; return; }
        markers.current[key] ??= new ml.Marker({ element: pin(kind, label), anchor: 'center' }).setLngLat(point).addTo(m);
        markers.current[key].setLngLat(point);
        markers.current[key].getElement().querySelector('span')!.textContent = label;
      };
      place('home', c.home, 'home', 'Home'); place('pickup', c.pickupPad, 'pad', 'Pickup pad'); place('drop', c.dropPad, 'pad drop', 'Drop pad');
      place('drone', t ? [t.lon, t.lat] : null, 'drone', `${Math.round(t?.alt ?? 0)} m`);
      const arrow = markers.current.drone?.getElement().querySelector('i') as HTMLElement | null; if (arrow && t) arrow.style.transform = `rotate(${t.heading}deg)`;
    });
  }
  useEffect(() => {
    let disposed = false;
    import('maplibre-gl').then(ml => {
      if (disposed || !container.current) return;
      const m = new ml.Map({ container: container.current, style: 'https://tiles.openfreemap.org/styles/positron', center: latest.current.config.home, zoom: 16, attributionControl: { compact: true } });
      map.current = m;
      m.once('style.load', () => {
        m.addSource('fence', { type: 'geojson', data: circle(latest.current.config.home, latest.current.config.radius) });
        m.addLayer({ id: 'fence-fill', type: 'fill', source: 'fence', paint: { 'fill-color': '#06c167', 'fill-opacity': .07 } });
        m.addLayer({ id: 'fence-line', type: 'line', source: 'fence', paint: { 'line-color': '#06a35a', 'line-width': 2, 'line-dasharray': [2, 2] } });
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
  useEffect(() => { latest.current = { config, telemetry, trail, placing, onPlace }; draw(); });
  return <div ref={container} className={`fleet-map ${placing ? 'placing' : ''}`} aria-label="Drone map with geofence, pads and live position" />;
}
