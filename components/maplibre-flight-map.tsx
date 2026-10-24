'use client';
import { useEffect, useRef, useState } from 'react';
import { Crosshair, Plus, Minus, Maximize, Navigation, Layers, MapPin } from 'lucide-react';
import type { Map as MapLibreMap, GeoJSONSource, Marker } from 'maplibre-gl';
import { snapshot, routes, FACILITIES, type ReturnRecord } from '@/lib/simulation';
import { droneMarkerSvg } from './drone';
import { FLEET, fleetPositions, MAP_ATTRIBUTION, MAP_STYLE } from '@/lib/fleet';
import 'maplibre-gl/dist/maplibre-gl.css';

const line = (coordinates: number[][]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates } });
export function fleetMarkerElement(id: string) {
  const el = document.createElement('div'); el.className = 'fleet-marker';
  el.innerHTML = `<div class="fleet-shadow"></div><div class="drone-graphic">${droneMarkerSvg}</div><span></span>`;
  el.querySelector('span')!.textContent = id; el.title = `${id} · simulated fleet`;
  return el;
}
export default function FlightMap({ record, clockOffset, stale, frozenAt, booking, onPin }: {record: ReturnRecord; clockOffset: number; stale: boolean; frozenAt: number; booking: boolean; onPin: (p: [number,number]) => void}) {
  const container = useRef<HTMLDivElement>(null), map = useRef<MapLibreMap | null>(null), drone = useRef<Marker | null>(null), markers = useRef<Marker[]>([]);
  const current = useRef({record, clockOffset, stale, frozenAt}); current.current = {record, clockOffset, stale, frozenAt};
  const choose = useRef({booking, onPin}); choose.current = {booking, onPin};
  const followRef = useRef(false), [follow, setFollow] = useState(false), [cinematic, setCinematic] = useState(false), [ready, setReady] = useState(false), [fallback, setFallback] = useState(false);
  const [fallbackTime,setFallbackTime] = useState(0);
  useEffect(()=>{if(ready)return;const timer=setInterval(()=>setFallbackTime(Date.now()),250);return()=>clearInterval(timer);},[ready]);
  const fallbackSnapshot=snapshot(record,stale?frozenAt:(fallbackTime||record.anchor)+clockOffset);
  const fallbackPath=[...fallbackSnapshot.path.inbound,...fallbackSnapshot.path.outbound.slice(1)];
  const west=Math.min(...fallbackPath.map(p=>p[0])),east=Math.max(...fallbackPath.map(p=>p[0]));
  const north=Math.max(...fallbackPath.map(p=>p[1])),south=Math.min(...fallbackPath.map(p=>p[1]));
  const project=([lng,lat]:readonly number[])=>[650+(lng-west)/Math.max(.01,east-west)*600,260+(north-lat)/Math.max(.01,north-south)*350];
  const projectedDrone=project(fallbackSnapshot.point);
  function fit() {
    const path = routes(current.current.record), coords = [...path.inbound, ...path.outbound], mobile = window.innerWidth < 760;
    map.current?.fitBounds([[Math.min(...coords.map(p=>p[0]))-.002, Math.min(...coords.map(p=>p[1]))-.001],[Math.max(...coords.map(p=>p[0]))+.002, Math.max(...coords.map(p=>p[1]))+.001]], {padding: mobile ? {left:40,right:60,top:90,bottom:450} : {left:475,right:150,top:160,bottom:180}, duration: 1300, maxZoom:14.5, pitch:0, bearing:0});
    followRef.current = false; setFollow(false); setCinematic(false);
  }
  useEffect(() => {
    let disposed = false, frame = 0, mapInstance: MapLibreMap | undefined;
    const timer = setTimeout(()=>{if (!map.current?.loaded()) setFallback(true);}, 12000);
    import('maplibre-gl').then(ml=>{
      if (disposed || !container.current) return;
      try {
        const m = new ml.Map({container: container.current, center: [-122.279,37.873], zoom:14, attributionControl:false, style: MAP_STYLE, maxPitch:60 });
        map.current = m; mapInstance=m;
        m.on('load',()=>{
          if(disposed)return; clearTimeout(timer); setReady(true); setFallback(false);
          // Ambient simulated fleet: faint loop corridors plus drones that never stop flying.
          m.addSource('fleet-routes',{type:'geojson',data:{type:'FeatureCollection',features:FLEET.map(d=>line(d.path))}});
          m.addLayer({id:'fleet-routes',type:'line',source:'fleet-routes',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#64748b','line-width':1.5,'line-opacity':.35,'line-dasharray':[1,3]}});
          const fleet=fleetPositions(Date.now()).map(f=>new ml.Marker({element:fleetMarkerElement(f.id),rotationAlignment:'map'}).setLngLat(f.point).addTo(m));
          m.addSource('route',{type:'geojson',data:line([[0,0],[0,0]])});
          m.addLayer({id:'route-halo',type:'line',source:'route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#fff','line-width':10,'line-opacity':.9}});
          m.addLayer({id:'route-upcoming',type:'line',source:'route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#4f88f5','line-width':4,'line-dasharray':[1.4,1.8],'line-opacity':.72}});
          m.addSource('completed',{type:'geojson',data:line([[0,0],[0,0]])});
          m.addLayer({id:'route-traveled',type:'line',source:'completed',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#2563eb','line-width':5}});
          const el=document.createElement('div');el.className='drone-map-marker';el.innerHTML=`<div class="drone-pulse"></div><div class="drone-graphic">${droneMarkerSvg}</div><span class="drone-marker-label">AERO–104 <i></i></span>`;
          drone.current=new ml.Marker({element:el,rotationAlignment:'map'}).setLngLat(snapshot(current.current.record,Date.now()+current.current.clockOffset).point).addTo(m);
          fit();
          let lastRoute=0, lastFollow=0, heading=0;
          function animate(ts: number) {
            if(disposed)return;
            const c=current.current, now=c.stale ? c.frozenAt : Date.now()+c.clockOffset;
            const s=snapshot(c.record,now);
            drone.current?.setLngLat(s.point);
            fleetPositions(Date.now()).forEach((f,i)=>{const marker=fleet[i];marker.setLngLat(f.point);const g=marker.getElement().querySelector<HTMLElement>('.drone-graphic');if(g)g.style.transform=`rotate(${f.heading}deg)`;});
            heading += (((s.heading-heading+540)%360)-180)*.09;
            const graphic=el.querySelector<HTMLElement>('.drone-graphic');if(graphic)graphic.style.transform=`rotate(${heading}deg)`;
            if(ts-lastRoute>100){
              (m.getSource('route') as GeoJSONSource)?.setData(line([...s.path.inbound,...s.path.outbound.slice(1)]));
              const completed=s.outbound?[...s.path.inbound,...s.completed.slice(1)]:s.completed;
              (m.getSource('completed') as GeoJSONSource)?.setData(line(completed.length>1?completed:[...completed,...completed]));lastRoute=ts;
            }
            if(followRef.current&&ts-lastFollow>150){m.easeTo({center:s.point,duration:300,essential:true});lastFollow=ts;}
            frame=requestAnimationFrame(animate);
          }
          frame=requestAnimationFrame(animate);
        });
        m.on('dragstart',()=>{followRef.current=false;setFollow(false);});
        m.on('click',e=>{if(choose.current.booking)choose.current.onPin([e.lngLat.lng,e.lngLat.lat]);});
      }catch{setFallback(true);}
    }).catch(()=>setFallback(true));
    return ()=>{disposed=true;clearTimeout(timer);cancelAnimationFrame(frame);markers.current.forEach(m=>m.remove());mapInstance?.remove();map.current=null;};
  },[]);
  useEffect(()=>{
    if(!ready||!map.current)return;
    let disposed=false;
    import('maplibre-gl').then(ml=>{
      if(disposed||!map.current)return;
      markers.current.forEach(marker=>marker.remove());markers.current=[];
      const facility=FACILITIES.find(f=>f.id===record.facilityId)!;
      for(const [p,kind,label] of [[record.package.pickup,'home','Your pickup'],[facility.point,'hub',facility.name]] as const){
        const element=document.createElement('div');element.className=`place-marker ${kind}`;
        element.innerHTML=`<div>${kind==='home'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-8h6v8"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 7 9-4 9 4v13H3Z"/><path d="M8 20v-8h8v8M3 7h18"/></svg>'}</div><span></span>`;
        element.querySelector('span')!.textContent=label;
        markers.current.push(new ml.Marker({element,anchor:'center'}).setLngLat(p).addTo(map.current!));
      }
    });
    return()=>{disposed=true;};
  },[ready,record.id,record.package.pickup[0],record.package.pickup[1],record.facilityId]);
  useEffect(()=>{if(ready)fit();},[record.id]);
  function toggleFollow(){const next=!follow;setFollow(next);followRef.current=next;if(next)map.current?.easeTo({center:snapshot(record,Date.now()+clockOffset).point,zoom:15.3,padding:{left:window.innerWidth>760?350:0,right:0,top:0,bottom:window.innerWidth>760?0:250},duration:1000});}
  function toggle3d(){const next=!cinematic;setCinematic(next);map.current?.easeTo({pitch:next?52:0,bearing:next?-25:0,duration:1200});}
  return <>
    <div className="map-fallback" aria-hidden="true"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"><defs><pattern id="streets" width="84" height="64" patternTransform="rotate(-13)" patternUnits="userSpaceOnUse"><rect width="84" height="64" fill="#eef0ec"/><rect x="5" y="5" width="71" height="51" rx="3" fill="#e5e8e3"/><path d="M0 0h84M0 0v64" stroke="#fff" strokeWidth="7"/></pattern></defs><rect width="1600" height="1000" fill="url(#streets)"/><path d="M0 0H230L150 260l60 160L60 760 0 800Z" fill="#d7e6ea"/><path d="M1130 140h300v200h-300zM600 650h180v150H600z" fill="#dce8d5"/><g fill="#87918a" fontSize="21" fontFamily="sans-serif" letterSpacing="5"><text x="880" y="510">BERKELEY</text><text x="1190" y="240" fontSize="14">UC BERKELEY</text><text x="390" y="320" fontSize="14">WEST BERKELEY</text></g></svg></div>
    <div ref={container} className={`flight-map ${fallback&&!ready?'unavailable':''}`} aria-label="Interactive Berkeley map showing simulated drone route" />
    {!ready&&<svg className="fallback-flight" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-label="Offline schematic of the simulated drone route"><polyline points={fallbackPath.map(p=>project(p).join(',')).join(' ')} fill="none" stroke="white" strokeWidth="10"/><polyline points={fallbackPath.map(p=>project(p).join(',')).join(' ')} fill="none" stroke="#2563eb" strokeWidth="4" strokeDasharray="9 8"/>{[record.package.pickup,fallbackPath[fallbackPath.length-1]].map((p,i)=>{const [x,y]=project(p);return <g key={i} transform={`translate(${x} ${y})`}><circle r="20" fill={i?'#2563eb':'#192832'} stroke="white" strokeWidth="4"/><text textAnchor="middle" y="5" fill="white" fontSize="13">{i?'H':'P'}</text><text textAnchor="middle" y="39" fill="#192832" fontSize="15" fontWeight="600">{i?'Return hub':'Your pickup'}</text></g>;})}<g transform={`translate(${projectedDrone[0]} ${projectedDrone[1]})`}><circle r="29" fill="#fff" stroke="#c8d9ff" strokeWidth="3"/><g transform={`rotate(${fallbackSnapshot.heading})`}><path d="M-17-17 17 17M17-17-17 17" stroke="#1d2f42" strokeWidth="5"/>{[[-17,-17],[17,17],[-17,17],[17,-17]].map(([cx,cy],i)=><circle key={i} cx={cx} cy={cy} r="8" fill="none" stroke="#5f768b" strokeWidth="3"/>)}<rect x="-7" y="-10" width="14" height="20" rx="5" fill="#2563eb"/></g></g></svg>}
    {fallback&&!ready&&<div className="map-offline"><MapPin size={15}/> Offline route view · simulation continues <button onClick={()=>location.reload()}>Retry map</button></div>}
    <div className="map-intro"><div className="eyebrow"><span className="location-dot"/> BERKELEY, CALIFORNIA</div><h2>A little less on your to-do list.</h2></div>
    <div className="map-controls"><button title="Zoom in" aria-label="Zoom in" onClick={()=>map.current?.zoomIn()}><Plus size={19}/></button><button title="Zoom out" aria-label="Zoom out" onClick={()=>map.current?.zoomOut()}><Minus size={19}/></button><span/><button title="Fit entire route" aria-label="Fit entire route" onClick={fit}><Maximize size={18}/></button><button title="Follow drone" aria-label="Follow drone" aria-pressed={follow} className={follow?'active':''} onClick={toggleFollow}><Crosshair size={19}/></button></div>
    <div className="map-view-controls"><button className={cinematic?'selected':''} onClick={toggle3d}><Layers size={16}/>{cinematic?'2D map':'3D view'}</button><button className={follow?'selected':''} onClick={toggleFollow}><Navigation size={15}/>{follow?'Following drone':'Follow drone'}</button></div>
    <div className="map-attribution">{MAP_ATTRIBUTION.map(([label, href], i) => <span key={href}>{i ? ' · ' : ''}<a href={href} target="_blank" rel="noreferrer">{label}</a></span>)}</div>
  </>;
}
