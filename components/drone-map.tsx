'use client';
import { useEffect, useRef, useState } from 'react';
import { Crosshair, Minus, Plus, Maximize } from 'lucide-react';
import type { GeoJSONSource, Map as MapLibreMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { droneMarkerSvg } from './drone';
import type { DroneView } from '@/lib/drone-protocol';
import type { Point } from '@/lib/simulation';
import { MAP_STYLE } from '@/lib/fleet';
const BERKELEY: Point = [-122.2585, 37.8719];
type Props = { drone: DroneView | null; a: Point | null; b: Point | null; pick: 'A' | 'B' | null; onPick: (p: Point) => void };
const line = (coordinates: Point[]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: coordinates.length > 1 ? coordinates : [...coordinates, ...coordinates] } });
function circle(center: Point, meters: number) {
  const ring: Point[] = [];
  for (let i = 0; i <= 72; i++) {
    const t = i / 72 * Math.PI * 2;
    ring.push([center[0] + meters * Math.sin(t) / (111195 * Math.cos(center[1] * Math.PI / 180)), center[1] + meters * Math.cos(t) / 111195]);
  }
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [ring] } };
}
const empty = { type: 'FeatureCollection' as const, features: [] };
// Keep the camera's centre in the part of the map not covered by the control panel.
const overlayPadding = (el: HTMLElement) => innerWidth < 760 ? { top: 70, bottom: Math.round(el.clientHeight * .54), left: 0, right: 0 } : { top: 0, bottom: 0, left: 440, right: 0 };
const pin = (label: string, kind: string) => { const el = document.createElement('div'); el.className = `fly-pin ${kind}`; el.innerHTML = `<span></span>`; el.querySelector('span')!.textContent = label; return el; };

export default function DroneMap({ drone, a, b, pick, onPick }: Props) {
  const container = useRef<HTMLDivElement>(null), map = useRef<MapLibreMap | null>(null), ml = useRef<typeof import('maplibre-gl') | null>(null);
  const markers = useRef<{ drone?: Marker; home?: Marker; a?: Marker; b?: Marker }>({});
  const motion = useRef({ from: null as Point | null, to: null as Point | null, start: 0, heading: 0, shown: null as Point | null });
  const pickRef = useRef({ pick, onPick });
  useEffect(() => { pickRef.current = { pick, onPick }; });
  const [ready, setReady] = useState(false), [follow, setFollow] = useState(false), followRef = useRef(false);
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false, frame = 0;
    import('maplibre-gl').then(lib => {
      if (disposed || !container.current) return;
      ml.current = lib;
      const m = new lib.Map({ container: container.current, style: MAP_STYLE, center: BERKELEY, zoom: 15, attributionControl: { compact: true }, maxPitch: 60 });
      map.current = m;
      const pad = () => { if (container.current) m.setPadding(overlayPadding(container.current)); };
      pad(); m.on('resize', pad);
      m.on('load', () => {
        if (disposed) return;
        m.addSource('fence', { type: 'geojson', data: empty });
        m.addLayer({ id: 'fence-fill', type: 'fill', source: 'fence', paint: { 'fill-color': '#2563eb', 'fill-opacity': .05 } });
        m.addLayer({ id: 'fence-line', type: 'line', source: 'fence', paint: { 'line-color': '#2563eb', 'line-width': 1.5, 'line-opacity': .55, 'line-dasharray': [2, 2] } });
        m.addSource('trail', { type: 'geojson', data: empty });
        m.addLayer({ id: 'trail', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0f172a', 'line-width': 3, 'line-opacity': .55 } });
        m.addSource('plan', { type: 'geojson', data: empty });
        m.addLayer({ id: 'plan-halo', type: 'line', source: 'plan', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 9 } });
        m.addLayer({ id: 'plan', type: 'line', source: 'plan', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2563eb', 'line-width': 4, 'line-dasharray': [1.2, 1.6] } });
        setReady(true);
      });
      m.on('error', e => console.warn('AERO map:', e.error?.message ?? e));
      m.on('click', e => { const { pick, onPick } = pickRef.current; if (pick) onPick([e.lngLat.lng, e.lngLat.lat]); });
      m.on('dragstart', () => { followRef.current = false; setFollow(false); });
      // Glide the marker between 1 Hz telemetry samples so the drone moves continuously.
      const animate = () => {
        if (disposed) return;
        const mo = motion.current, marker = markers.current.drone;
        if (marker && mo.to) {
          const t = mo.from ? Math.min(1, (performance.now() - mo.start) / 1000) : 1;
          const p: Point = mo.from ? [mo.from[0] + (mo.to[0] - mo.from[0]) * t, mo.from[1] + (mo.to[1] - mo.from[1]) * t] : mo.to;
          mo.shown = p; marker.setLngLat(p);
          const g = marker.getElement().querySelector<HTMLElement>('.drone-graphic'); if (g) g.style.transform = `rotate(${mo.heading}deg)`;
          if (followRef.current) m.setCenter(p);
        }
        frame = requestAnimationFrame(animate);
      };
      frame = requestAnimationFrame(animate);
    });
    return () => { disposed = true; cancelAnimationFrame(frame); map.current?.remove(); map.current = null; markers.current = {}; };
  }, []);

  useEffect(() => {
    const m = map.current, lib = ml.current; if (!ready || !m || !lib) return;
    const t = drone?.telemetry, here: Point | null = t ? [t.lng, t.lat] : null;
    (m.getSource('fence') as GeoJSONSource).setData(drone?.home ? circle(drone.home, drone.geofenceM) : empty);
    (m.getSource('trail') as GeoJSONSource).setData(drone && drone.trail.length > 1 ? line(drone.trail) : empty);
    const start = a ?? here, plan = [start, b].filter(Boolean) as Point[];
    (m.getSource('plan') as GeoJSONSource).setData(plan.length > 1 ? line(here && a ? [here, ...plan] : plan) : empty);
    const place = (key: 'home' | 'a' | 'b', p: Point | null, make: () => HTMLElement) => {
      const existing = markers.current[key];
      if (!p) { existing?.remove(); delete markers.current[key]; return; }
      if (existing) existing.setLngLat(p); else markers.current[key] = new lib.Marker({ element: make(), anchor: key === 'home' ? 'center' : 'bottom' }).setLngLat(p).addTo(m);
    };
    place('home', drone?.home ?? null, () => pin('H', 'home'));
    place('a', a, () => pin('A', 'a'));
    place('b', b, () => pin('B', 'b'));
    if (here) {
      const mo = motion.current;
      if (!markers.current.drone) {
        const el = document.createElement('div'); el.className = 'drone-map-marker fly-drone';
        el.innerHTML = `<div class="drone-pulse"></div><div class="drone-graphic">${droneMarkerSvg}</div><span class="drone-marker-label"></span>`;
        markers.current.drone = new lib.Marker({ element: el, rotationAlignment: 'map' }).setLngLat(here).addTo(m);
        mo.from = null; mo.to = here;
      } else if (!mo.to || mo.to[0] !== here[0] || mo.to[1] !== here[1]) { mo.from = mo.shown ?? mo.to; mo.to = here; mo.start = performance.now(); }
      mo.heading = t!.headingDeg;
      const el = markers.current.drone.getElement();
      el.classList.toggle('flying', !!t && t.altM > 0.5);
      el.classList.toggle('stale', !drone?.online);
      el.querySelector('.drone-marker-label')!.textContent = `${drone!.name} · ${Math.round(t!.altM)} m`;
    } else { markers.current.drone?.remove(); delete markers.current.drone; motion.current.to = null; }
    const key = drone?.id ?? 'none';
    if (fitted.current !== key && (drone?.home || here)) { fitted.current = key; m.jumpTo({ center: here ?? drone!.home!, zoom: 16 }); }
  }, [ready, drone, a, b]);

  useEffect(() => { if (container.current) container.current.style.cursor = pick ? 'crosshair' : ''; const c = map.current?.getCanvas(); if (c) c.style.cursor = pick ? 'crosshair' : ''; }, [pick, ready]);

  function fit() {
    const m = map.current; if (!m) return;
    const t = drone?.telemetry, pts = [drone?.home, t ? [t.lng, t.lat] as Point : null, a, b].filter(Boolean) as Point[];
    if (drone?.home) pts.push(...circle(drone.home, drone.geofenceM).geometry.coordinates[0].filter((_, i) => i % 18 === 0));
    if (!pts.length) return;
    const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1]);
    m.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 50, maxZoom: 17, duration: 800 });
  }
  function toggleFollow() { const next = !follow; followRef.current = next; setFollow(next); }
  return <>
    <div ref={container} className="fly-map" aria-label="Map of your drone, its safety zone and planned route" />
    {pick && <div className="fly-pick-hint">Tap the map to place point <strong>{pick}</strong></div>}
    <div className="map-controls fly-map-controls">
      <button aria-label="Zoom in" onClick={() => map.current?.zoomIn()}><Plus size={19} /></button>
      <button aria-label="Zoom out" onClick={() => map.current?.zoomOut()}><Minus size={19} /></button><span />
      <button aria-label="Fit drone, safety zone and route" onClick={fit}><Maximize size={18} /></button>
      <button aria-label="Follow drone" aria-pressed={follow} className={follow ? 'active' : ''} onClick={toggleFollow}><Crosshair size={19} /></button>
    </div>
  </>;
}
