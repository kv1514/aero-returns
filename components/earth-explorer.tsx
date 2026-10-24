'use client';
import {useEffect,useRef,useState} from 'react';
import {Earth,ExternalLink,MapPin,RotateCw,Square,Camera} from 'lucide-react';
import {loadGoogle,type GoogleConfig} from '@/lib/google-maps';
import {earthURL,streetViewURL} from '@/lib/map-links';
import {latLng} from '@/lib/location';
import {snapshot,type ReturnRecord,type Point} from '@/lib/simulation';
import type {Map as MapLibreMap,Marker} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import PickupPhoto from './pickup-guide';
import type {PickupGuide} from '@/lib/pickup-guide';
type ExplorerProps={config:GoogleConfig;record:ReturnRecord;clockOffset:number;stale:boolean;frozenAt:number};
export default function EarthExplorer(props:ExplorerProps&{initialTab?:'earth'|'pickup';guide:PickupGuide|null;onGuideChange:(guide:PickupGuide|null)=>void}){
  const [tab,setTab]=useState(props.initialTab||'earth');
  return <><div className="explorer-tabs" role="group" aria-label="Pickup explorer views"><button aria-pressed={tab==='earth'} onClick={()=>setTab('earth')}><Earth size={17}/>3D neighborhood</button><button aria-pressed={tab==='pickup'} onClick={()=>setTab('pickup')}><Camera size={17}/>Pickup photo{props.guide?.confirmed&&<span className="explorer-saved">Ready</span>}</button></div>{tab==='earth'?<EarthScene {...props}/>:<PickupPhoto record={props.record} guide={props.guide} onChange={props.onGuideChange}/>}</>;
}
type Camera={center:{lat:number;lng:number;altitude:number};range:number;tilt:number;heading:number};
type EarthMap=HTMLElement&{center:Camera['center'];flyCameraTo(options:{endCamera:Camera;durationMillis:number}):void;flyCameraAround(options:{camera:Camera;durationMillis:number;repeatCount:number}):void;stopCameraAnimation():void;};
type Library3D={Map3DElement:new(options:Record<string,unknown>)=>EarthMap};
function EarthScene({config,record,clockOffset,stale,frozenAt}:ExplorerProps){
  const [target,setTarget]=useState<'pickup'|'drone'|'hub'>('pickup'),[status,setStatus]=useState(config.key?'Loading 3D imagery…':'Loading free 3D buildings…'),[ready,setReady]=useState(false),[orbit,setOrbit]=useState(false),[open3d,setOpen3d]=useState(!config.key);
  const element=useRef<HTMLDivElement>(null),map=useRef<EarthMap|null>(null),openMap=useRef<MapLibreMap|null>(null),orbitStop=useRef<(()=>void)|null>(null),readyStatus=useRef(''),current=useRef({record,clockOffset,stale,frozenAt});current.current={record,clockOffset,stale,frozenAt};
  // Route endpoints come from the snapshot so live flights use the operator's pads.
  const pointFor=(which:typeof target):Point=>{const c=current.current,s=snapshot(c.record,c.stale?c.frozenAt:Date.now()+c.clockOffset);return which==='pickup'?s.path.inbound[s.path.inbound.length-1]:which==='hub'?s.path.outbound[s.path.outbound.length-1]:s.point;};
  const hubLabel=record.live?'Drop pad':'Demo return hub';
  const camera=(which:typeof target):Camera=>({center:{...latLng(pointFor(which)),altitude:0},range:1000,tilt:60,heading:20});
  const selected=pointFor(target);
  useEffect(()=>{
    let cancelled=false;let node:EarthMap|undefined;const timeout=setTimeout(()=>{if(!cancelled)setStatus('3D imagery is taking longer than expected. You can open Google Earth below.');},25000);
    if(!config.key){clearTimeout(timeout);return;}
    void loadGoogle(config.key).then(async g=>{
      const library=await g.importLibrary('maps3d') as Library3D;if(cancelled||!element.current)return;
      node=new library.Map3DElement({...camera('pickup'),mode:'HYBRID',gestureHandling:'COOPERATIVE'});map.current=node;
      node.style.width='100%';node.style.height='100%';node.setAttribute('aria-label','Google photorealistic 3D location explorer');
      node.addEventListener('gmp-steadychange',(event)=>{if(!cancelled&&(event as Event&{isSteady?:boolean}).isSteady){clearTimeout(timeout);setReady(true);readyStatus.current='Google 3D imagery · explore by dragging the map';setStatus(readyStatus.current);}});
      node.addEventListener('gmp-error',()=>{if(!cancelled){clearTimeout(timeout);setReady(false);setOpen3d(true);}});
      node.addEventListener('gmp-animationend',()=>{if(!cancelled)setOrbit(false);});element.current.replaceChildren(node);
    }).catch(()=>{if(!cancelled){clearTimeout(timeout);setOpen3d(true);}});
    return()=>{cancelled=true;clearTimeout(timeout);node?.stopCameraAnimation();node?.remove();map.current=null;};
  },[config.key,record.id]);
  // Key-free 3D: OpenFreeMap's Liberty style extrudes OpenStreetMap building heights.
  useEffect(()=>{
    if(!open3d)return;let disposed=false,m:MapLibreMap|undefined,drone:Marker|undefined;
    const pin=(kind:string,text:string)=>{const el=document.createElement('div');el.className=`fleet-pin ${kind}`;el.innerHTML='<i></i><span></span>';el.querySelector('span')!.textContent=text;return el;};
    void import('maplibre-gl').then(ml=>{
      if(disposed||!element.current)return;element.current.replaceChildren();
      m=new ml.Map({container:element.current,style:'https://tiles.openfreemap.org/styles/liberty',center:pointFor('pickup'),zoom:16.6,pitch:62,bearing:20,maxPitch:75,attributionControl:{compact:true}});openMap.current=m;
      new ml.Marker({element:pin('home','Pickup'),anchor:'center'}).setLngLat(pointFor('pickup')).addTo(m);
      new ml.Marker({element:pin('pad drop',hubLabel),anchor:'center'}).setLngLat(pointFor('hub')).addTo(m);
      drone=new ml.Marker({element:pin('drone',current.current.record.live?.droneName||'AERO–104'),anchor:'center'}).setLngLat(pointFor('drone')).addTo(m);
      m.once('style.load',()=>{if(!disposed){setReady(true);readyStatus.current=config.key?'Google 3D is unavailable here, so this view uses free OpenStreetMap 3D buildings. Drag to explore.':'Free 3D buildings from OpenStreetMap. Drag to explore; add a Google Maps key for photorealistic imagery.';setStatus(readyStatus.current);}});
      m.on('error',()=>{if(!disposed&&!m?.isStyleLoaded())setStatus('Could not load 3D buildings. Open Google Earth below or return to tracking.');});
    }).catch(()=>{if(!disposed)setStatus('Could not load 3D buildings. Open Google Earth below or return to tracking.');});
    const tick=setInterval(()=>drone?.setLngLat(pointFor('drone')),1000);
    return()=>{disposed=true;clearInterval(tick);orbitStop.current?.();m?.remove();openMap.current=null;};
  },[open3d,record.id]);
  function go(which:typeof target){setTarget(which);setOrbit(false);orbitStop.current?.();const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;const o=openMap.current;if(o){o.stop();o.flyTo({center:pointFor(which),zoom:16.8,pitch:62,bearing:20,duration:reduced?0:1800});return;}const m=map.current;if(!m)return;m.stopCameraAnimation();m.flyCameraTo({endCamera:camera(which),durationMillis:reduced?0:1800});}
  function toggleOrbit(){
    const o=openMap.current;
    if(!orbit&&(matchMedia('(prefers-reduced-motion: reduce)').matches||document.body.dataset.motion==='true')){setStatus('Orbit is off because reduced motion is on. Drag the map to look around.');return;}
    // rotateTo(+359) normalizes to a 1° turn and, under reduced motion, finishes before a moveend listener exists, so the bearing is driven per frame.
    if(o){if(orbitStop.current){orbitStop.current();return;}o.stop();const start=o.getBearing(),t0=performance.now(),stops=['mousedown','touchstart','wheel'] as const;let raf=0;
      // Any pointer, wheel or keyboard input hands the camera back to the person.
      const keys=o.getCanvasContainer(),end=()=>{cancelAnimationFrame(raf);stops.forEach(e=>o.off(e,end));keys.removeEventListener('keydown',end);orbitStop.current=null;setOrbit(false);setStatus(readyStatus.current);};
      const step=()=>{const k=Math.min(1,(performance.now()-t0)/18000);o.setBearing(start+360*k);if(k<1)raf=requestAnimationFrame(step);else end();};
      stops.forEach(e=>o.on(e,end));keys.addEventListener('keydown',end);orbitStop.current=end;setOrbit(true);setStatus('Orbiting · drag the map or press Stop orbit to end.');raf=requestAnimationFrame(step);return;}
    if(!map.current)return;if(orbit){map.current.stopCameraAnimation();setOrbit(false);setStatus(readyStatus.current);}else{map.current.flyCameraAround({camera:camera(target),durationMillis:18000,repeatCount:1});setOrbit(true);setStatus('Orbiting · press Stop orbit to end.');}
  }
  return <div className="earth-explorer"><p className="body-copy">Explore the neighborhood in 3D, or open Street View to inspect a possible entrance. Imagery is recorded, not a live drone camera.</p><div className="earth-targets" role="group" aria-label="Explore location">{(['pickup','drone','hub'] as const).map(t=><button key={t} className={target===t?'primary':'secondary'} aria-pressed={target===t} onClick={()=>go(t)}><MapPin size={15}/>{t==='pickup'?'Pickup':t==='drone'?'Drone position':hubLabel}</button>)}</div><div className="earth-viewport" ref={element}/><div className="earth-status"><span role="status">{status}</span><button className="secondary" disabled={!ready} onClick={toggleOrbit}>{orbit?<Square size={15}/>:<RotateCw size={15}/>} {orbit?'Stop orbit':'Orbit this location'}</button></div><div className="earth-links"><a className="primary" href={earthURL(selected)} target="_blank" rel="noreferrer"><Earth size={17}/>Open Google Earth<ExternalLink size={14}/></a><a className="secondary" href={streetViewURL(selected)} target="_blank" rel="noreferrer"><MapPin size={17}/>Open Street View<ExternalLink size={14}/></a></div><p className="fine-print">Street View opens in Google Maps, keeping this free demo independent of paid panorama APIs. Coverage and imagery dates vary. A view of a building does not establish return acceptance or permission to fly.</p></div>;
}
