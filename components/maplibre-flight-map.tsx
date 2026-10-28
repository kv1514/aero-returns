'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Crosshair, Plus, Minus, Maximize, Navigation, Layers, MapPin } from 'lucide-react';
import type { Map as MapLibreMap, GeoJSONSource, Marker } from 'maplibre-gl';
import { snapshot, FACILITIES, type Point, type ReturnRecord } from '@/lib/simulation';
import { droneMarkerSvg, fleetMarkerName, flightDroneName, prefersReducedMotion, routeWords } from './drone';
import 'maplibre-gl/dist/maplibre-gl.css';

/** The home screen before a return exists: the person's pickup and the simulated fleet standing by, nearest one highlighted. */
export type HomeScene = { pickup: Point; label: string; drones: { id: string; name: string; base: Point }[]; nearestId: string | null; matching: boolean };
export type MapProps = { record: ReturnRecord | null; scene?: HomeScene | null; clockOffset: number; stale: boolean; frozenAt: number; booking: boolean; onPin: (p: [number,number]) => void };
const line = (coordinates: number[][]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates } });
// Same breakpoint as @media(max-width:760px): the sheet covers the bottom 46dvh on phones and the left 400px on desktop.
// Phones keep marker labels (centred on their pins) clear of the screen edge and the map-control column on the right, and keep
// pins and the labels under them above the Demo controls float (12–56px above the sheet), so the drop-off name is not hidden.
const mobile = () => window.innerWidth <= 760;
const sheetPadding = () => mobile() ? {left:72,right:110,top:120,bottom:Math.min(Math.round(window.innerHeight*.46)+100,Math.max(30,window.innerHeight-180))} : {left:470,right:90,top:130,bottom:90};
// Follow frames the drone with a per-ease offset; easeTo padding would persist on the transform and shrink every later fitBounds.
const followOffset = (): [number, number] => mobile() ? [0,-125] : [175,0];
const scenePoints = (scene: HomeScene): Point[] => [scene.pickup, ...scene.drones.map(d => d.base)];
/** Changes whenever the markers on the map must change. */
export const sceneKey = (record: ReturnRecord | null, scene?: HomeScene | null) => record ? `r:${record.id}:${record.package.pickup.join()}:${record.facilityId}:${record.live?.droneId || ''}:${record.live?.pickupSource || ''}:${record.live?.pickupPad.join() || ''}` : scene ? `h:${scene.pickup.join()}:${scene.drones.map(d => d.id).join()}:${scene.nearestId}:${scene.matching}` : '';
const homeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-8h6v8"/></svg>';
/** DOM for one simulated drone standing by; text goes in through textContent. */
export function fleetMarker(name: string, nearest: boolean) {
  const el = document.createElement('div'); el.className = `sim-drone-marker ${nearest ? 'nearest' : ''}`; el.setAttribute('role', 'img'); el.setAttribute('aria-label', fleetMarkerName(name, nearest));
  el.innerHTML = `<div class="sim-drone-icon">${droneMarkerSvg}</div><span></span>`; el.querySelector('span')!.textContent = nearest ? `${name} · nearest` : name; return el;
}
export function matchPulse() { const el = document.createElement('div'); el.className = 'match-pulse'; el.setAttribute('aria-hidden', 'true'); el.innerHTML = '<i></i><i></i><b></b>'; return el; }
export default function FlightMap({ record, scene = null, clockOffset, stale, frozenAt, booking, onPin }: MapProps) {
  const container = useRef<HTMLDivElement>(null), map = useRef<MapLibreMap | null>(null), drone = useRef<Marker | null>(null), markers = useRef<Marker[]>([]);
  const current = useRef({record, scene, clockOffset, stale, frozenAt}), choose = useRef({booking, onPin});
  // The animation loop and map callbacks read the latest props from here; they are copied in before any other effect runs.
  useLayoutEffect(() => { current.current = {record, scene, clockOffset, stale, frozenAt}; choose.current = {booking, onPin}; });
  const followRef = useRef(false), [follow, setFollow] = useState(false), [cinematic, setCinematic] = useState(false), [ready, setReady] = useState(false), [fallback, setFallback] = useState(false);
  const [fallbackTime,setFallbackTime] = useState(0), [box,setBox] = useState({w:1600,h:1000,pad:{left:470,right:90,top:130,bottom:90}});
  useEffect(()=>{const el=container.current;if(ready||!el)return;const observer=new ResizeObserver(()=>{if(el.clientWidth&&el.clientHeight)setBox({w:el.clientWidth,h:el.clientHeight,pad:sheetPadding()});});observer.observe(el);return()=>observer.disconnect();},[ready]);
  useEffect(()=>{if(ready)return;const timer=setInterval(()=>setFallbackTime(Date.now()),250);return()=>clearInterval(timer);},[ready]);
  const fallbackSnapshot=record?snapshot(record,stale?frozenAt:(fallbackTime||record.anchor)+clockOffset):null;
  const fallbackPath:Point[]=fallbackSnapshot?[...fallbackSnapshot.path.inbound,...fallbackSnapshot.path.outbound.slice(1)]:scene?scenePoints(scene):[[-122.279,37.873]];
  const west=Math.min(...fallbackPath.map(p=>p[0])),east=Math.max(...fallbackPath.map(p=>p[0]));
  const north=Math.max(...fallbackPath.map(p=>p[1])),south=Math.min(...fallbackPath.map(p=>p[1]));
  // Offline schematic: fit the route, in screen pixels, into the area the sheet and controls leave uncovered, with room for pins and labels.
  // When the band above the sheet is too short (landscape phones), let the schematic run under the sheet instead of collapsing to a point.
  const tightH=box.h-box.pad.bottom-75-box.pad.top<120,tightW=box.w-box.pad.right-60-box.pad.left<120,x0=tightW?30:box.pad.left+30,y0=tightH?60:box.pad.top+30,rw=tightW?Math.max(120,box.w-60):box.w-box.pad.right-30-x0,rh=tightH?Math.max(120,box.h-105):box.h-box.pad.bottom-45-y0,cosLat=Math.cos((north+south)/2*Math.PI/180),k=Math.min(rw/Math.max(.01,(east-west)*cosLat),rh/Math.max(.01,north-south));
  const project=([lng,lat]:readonly number[])=>[x0+rw/2+(lng-(west+east)/2)*cosLat*k,y0+rh/2-(lat-(north+south)/2)*k];
  const dronePoint=()=>{const c=current.current;return c.record?snapshot(c.record,c.stale?c.frozenAt:Date.now()+c.clockOffset).point:null;};
  const projectedDrone=fallbackSnapshot?project(fallbackSnapshot.point):null,words=routeWords(record);
  function fit() {
    const c=current.current,path=c.record?snapshot(c.record,Date.now()).path:null,coords=path?[...path.inbound,...path.outbound]:c.scene?scenePoints(c.scene):null;
    if(!coords)return;
    map.current?.fitBounds([[Math.min(...coords.map(p=>p[0]))-.002, Math.min(...coords.map(p=>p[1]))-.001],[Math.max(...coords.map(p=>p[0]))+.002, Math.max(...coords.map(p=>p[1]))+.001]], {padding: sheetPadding(), duration: prefersReducedMotion()?0:1300, maxZoom:c.record?.live?17.5:14.5, pitch:0, bearing:0});
    followRef.current = false; setFollow(false); setCinematic(false);
  }
  useEffect(() => {
    let disposed = false, frame = 0, mapInstance: MapLibreMap | undefined;
    const timer = setTimeout(()=>{if (!map.current?.loaded()) setFallback(true);}, 12000);
    import('maplibre-gl').then(ml=>{
      if (disposed || !container.current) return;
      try {
        const m = new ml.Map({container: container.current, center: [-122.279,37.873], zoom:14, attributionControl:false, style: 'https://tiles.openfreemap.org/styles/positron', maxPitch:60 });
        map.current = m; mapInstance=m;
        m.once('style.load',()=>{
          if(disposed)return; clearTimeout(timer); setReady(true); setFallback(false);
          m.addSource('route',{type:'geojson',data:line([[0,0],[0,0]])});
          m.addLayer({id:'route-halo',type:'line',source:'route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#fff','line-width':9,'line-opacity':.95}});
          m.addLayer({id:'route-upcoming',type:'line',source:'route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#000','line-width':4,'line-dasharray':[1.2,1.6],'line-opacity':.35}});
          m.addSource('completed',{type:'geojson',data:line([[0,0],[0,0]])});
          m.addLayer({id:'route-traveled',type:'line',source:'completed',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#000','line-width':5}});
          const el=document.createElement('div');el.className='drone-map-marker';el.setAttribute('role','img');el.setAttribute('aria-label','Drone');el.innerHTML=`<div class="drone-pulse"></div><div class="drone-graphic">${droneMarkerSvg}</div><span class="drone-marker-label"><b></b> <i></i></span>`;
          const label=el.querySelector('b')!;
          drone.current=new ml.Marker({element:el,rotationAlignment:'map'}).setLngLat(dronePoint()??[-122.279,37.873]).addTo(m);
          let lastRoute=0, lastFollow=0, heading=0, shown: string | null = null;
          function animate(ts: number) {
            if(disposed)return;
            const c=current.current, r=c.record;
            // Before a return exists there is no drone in flight and no route: the fleet markers stand in.
            if(shown!==(r?.id||'')){shown=r?.id||'';el.style.display=r?'':'none';if(!r){(m.getSource('route') as GeoJSONSource)?.setData(line([[0,0],[0,0]]));(m.getSource('completed') as GeoJSONSource)?.setData(line([[0,0],[0,0]]));}}
            if(r){
              const s=snapshot(r,c.stale ? c.frozenAt : Date.now()+c.clockOffset);
              drone.current?.setLngLat(s.point);
              heading += (((s.heading-heading+540)%360)-180)*.09;
              const graphic=el.querySelector<HTMLElement>('.drone-graphic');if(graphic)graphic.style.transform=`rotate(${heading}deg)`;
              if(ts-lastRoute>100){
                label.textContent=r.live?.droneName||r.drone?.name||'AirCart–104';const name=flightDroneName(r);if(el.getAttribute('aria-label')!==name)el.setAttribute('aria-label',name);
                (m.getSource('route') as GeoJSONSource)?.setData(line([...s.path.inbound,...s.path.outbound.slice(1)]));
                const completed=s.outbound?[...s.path.inbound,...s.completed.slice(1)]:s.completed;
                (m.getSource('completed') as GeoJSONSource)?.setData(line(completed.length>1?completed:[...completed,...completed]));lastRoute=ts;
              }
              // easeTo cancels any running ease, so wait for Follow's zoom, the 3D tilt, zoom buttons and fit to finish. Reduced motion jumps instead.
              if(followRef.current&&!m.isEasing()&&ts-lastFollow>150){if(prefersReducedMotion())m.jumpTo({center:s.point});else m.easeTo({center:s.point,offset:followOffset(),duration:300});lastFollow=ts;}
            }
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
  const key=sceneKey(record,scene),fitKey=record?`r:${record.id}:${record.live?.droneId||''}`:scene?`h:${scene.pickup.join()}`:'';
  useEffect(()=>{
    if(!ready||!map.current)return;
    let disposed=false;
    import('maplibre-gl').then(ml=>{
      if(disposed||!map.current)return;
      markers.current.forEach(marker=>marker.remove());markers.current=[];
      const {record,scene}=current.current,add=(element:HTMLElement,p:Point)=>markers.current.push(new ml.Marker({element,anchor:'center'}).setLngLat(p).addTo(map.current!));
      const place=(kind:'home'|'hub',label:string,name=label)=>{const element=document.createElement('div');element.className=`place-marker ${kind}`;element.setAttribute('role','img');element.setAttribute('aria-label',name);element.innerHTML=`<div>${kind==='home'?homeIcon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 7 9-4 9 4v13H3Z"/><path d="M8 20v-8h8v8M3 7h18"/></svg>'}</div><span></span>`;element.querySelector('span')!.textContent=label;return element;};
      if(record){
        const facility=FACILITIES.find(f=>f.id===record.facilityId)!,{path}=snapshot(record,Date.now());
        add(place('home',routeWords(record).pickup),path.inbound[path.inbound.length-1]);
        add(place('hub',record.live?'Drop pad':facility.name,record.live?'Drop pad':`Drop-off: ${facility.name}`),path.outbound[path.outbound.length-1]);
      }else if(scene){
        for(const d of scene.drones)add(fleetMarker(d.name,d.id===scene.nearestId),d.base);
        if(scene.matching)add(matchPulse(),scene.pickup);
        add(place('home',scene.label),scene.pickup);
      }
    });
    return()=>{disposed=true;};
  },[ready,key]);
  // Reframe when a different return (or the home screen) is shown; the frame callback keeps the camera move out of the render pass.
  useEffect(()=>{if(!ready)return;const f=requestAnimationFrame(()=>fit());return()=>cancelAnimationFrame(f);},[ready,fitKey]);
  function toggleFollow(){const next=!follow,p=dronePoint();setFollow(next);followRef.current=next;if(next&&p)map.current?.easeTo({center:p,zoom:15.3,offset:followOffset(),duration:prefersReducedMotion()?0:1000});}
  function toggle3d(){const next=!cinematic,p=dronePoint();setCinematic(next);map.current?.easeTo({pitch:next?52:0,bearing:next?-25:0,duration:prefersReducedMotion()?0:1200,...(followRef.current&&p?{center:p,offset:followOffset()}:{})});}
  const zoom=(by:1|-1)=>{const m=map.current,o={...(followRef.current?{offset:followOffset()}:{}),...(prefersReducedMotion()?{duration:0}:{})};if(by>0)m?.zoomIn(o);else m?.zoomOut(o);};
  return <>
    <div className="map-fallback" aria-hidden="true"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"><defs><pattern id="streets" width="84" height="64" patternTransform="rotate(-13)" patternUnits="userSpaceOnUse"><rect width="84" height="64" fill="#eef0ec"/><rect x="5" y="5" width="71" height="51" rx="3" fill="#e5e8e3"/><path d="M0 0h84M0 0v64" stroke="#fff" strokeWidth="7"/></pattern></defs><rect width="1600" height="1000" fill="url(#streets)"/><path d="M0 0H230L150 260l60 160L60 760 0 800Z" fill="#d7e6ea"/><path d="M1130 140h300v200h-300zM600 650h180v150H600z" fill="#dce8d5"/><g fill="#87918a" fontSize="21" fontFamily="sans-serif" letterSpacing="5"><text x="880" y="510">BERKELEY</text><text x="1190" y="240" fontSize="14">UC BERKELEY</text><text x="390" y="320" fontSize="14">WEST BERKELEY</text></g></svg></div>
    <div ref={container} className={`flight-map ${fallback&&!ready?'unavailable':''}`} aria-label={words.map} />
    {!ready&&fallbackSnapshot&&projectedDrone&&<svg className="fallback-flight" viewBox={`0 0 ${box.w} ${box.h}`} role="img" aria-label={words.schematic}><polyline points={fallbackPath.map(p=>project(p).join(',')).join(' ')} fill="none" stroke="white" strokeWidth="10"/><polyline points={fallbackPath.map(p=>project(p).join(',')).join(' ')} fill="none" stroke="#000" strokeWidth="4" strokeDasharray="9 8"/>{[fallbackSnapshot.path.inbound[fallbackSnapshot.path.inbound.length-1],fallbackPath[fallbackPath.length-1]].map((p,i)=>{const [x,y]=project(p);return <g key={i} transform={`translate(${x} ${y})`}><circle r="20" fill={i?'#2563eb':'#192832'} stroke="white" strokeWidth="4"/><text textAnchor="middle" y="5" fill="white" fontSize="13">{i?'H':'P'}</text><text textAnchor="middle" y="39" fill="#192832" fontSize="15" fontWeight="600">{i?words.hub:words.pickup}</text></g>;})}<g transform={`translate(${projectedDrone[0]} ${projectedDrone[1]})`}><circle r="29" fill="#fff" stroke="#c8d9ff" strokeWidth="3"/><g transform={`rotate(${fallbackSnapshot.heading})`}><path d="M-17-17 17 17M17-17-17 17" stroke="#1d2f42" strokeWidth="5"/>{[[-17,-17],[17,17],[-17,17],[17,-17]].map(([cx,cy],i)=><circle key={i} cx={cx} cy={cy} r="8" fill="none" stroke="#5f768b" strokeWidth="3"/>)}<rect x="-7" y="-10" width="14" height="20" rx="5" fill="#2563eb"/></g></g></svg>}
    {!ready&&!record&&scene&&<svg className="fallback-flight" viewBox={`0 0 ${box.w} ${box.h}`} role="img" aria-label="Offline schematic of your pickup and the simulated drones nearby">{scene.drones.map(d=>{const [x,y]=project(d.base),near=d.id===scene.nearestId;return <g key={d.id} transform={`translate(${x} ${y})`}><circle r={near?14:10} fill="#fff" stroke={near?'#000':'#5f768b'} strokeWidth="3"/><text textAnchor="middle" y={near?34:30} fill="#192832" fontSize="13" fontWeight={near?700:500}>{near?`${d.name} · nearest`:d.name}</text></g>;})}{(()=>{const [x,y]=project(scene.pickup);return <g transform={`translate(${x} ${y})`}><circle r="20" fill="#192832" stroke="white" strokeWidth="4"/><text textAnchor="middle" y="5" fill="white" fontSize="13">P</text><text textAnchor="middle" y="39" fill="#192832" fontSize="15" fontWeight="600">{scene.label}</text></g>;})()}</svg>}
    {fallback&&!ready&&<div className="map-offline"><MapPin size={15}/> {words.offline} <button onClick={()=>location.reload()}>Retry map</button></div>}
    <div className="map-controls"><button title="Zoom in" aria-label="Zoom in" onClick={()=>zoom(1)}><Plus size={19}/></button><button title="Zoom out" aria-label="Zoom out" onClick={()=>zoom(-1)}><Minus size={19}/></button><span/><button title={record?'Fit entire route':'Fit pickup and drones'} aria-label={record?'Fit entire route':'Fit pickup and drones'} onClick={fit}><Maximize size={18}/></button>{record&&<button title="Follow drone" aria-label="Follow drone" aria-pressed={follow} className={follow?'active':''} onClick={toggleFollow}><Crosshair size={19}/></button>}</div>
    {record&&<div className="map-view-controls"><button className={cinematic?'selected':''} onClick={toggle3d}><Layers size={16}/>{cinematic?'2D map':'3D view'}</button><button className={follow?'selected':''} onClick={toggleFollow}><Navigation size={15}/>{follow?'Following drone':'Follow drone'}</button></div>}
    <div className="map-attribution"><a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a></div>
  </>;
}
