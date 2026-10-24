'use client';
import {useEffect,useRef,useState} from 'react';
import {Earth,ExternalLink,MapPin,RotateCw,Square} from 'lucide-react';
import {loadGoogle,type GoogleConfig} from '@/lib/google-maps';
import {earthURL,streetViewURL} from '@/lib/map-links';
import {latLng} from '@/lib/location';
import {FACILITIES,snapshot,type ReturnRecord,type Point} from '@/lib/simulation';
type Camera={center:{lat:number;lng:number;altitude:number};range:number;tilt:number;heading:number};
type EarthMap=HTMLElement&{center:Camera['center'];flyCameraTo(options:{endCamera:Camera;durationMillis:number}):void;flyCameraAround(options:{camera:Camera;durationMillis:number;repeatCount:number}):void;stopCameraAnimation():void;};
type Library3D={Map3DElement:new(options:Record<string,unknown>)=>EarthMap};
export default function EarthExplorer({config,record,clockOffset,stale,frozenAt}:{config:GoogleConfig;record:ReturnRecord;clockOffset:number;stale:boolean;frozenAt:number}){
  const [target,setTarget]=useState<'pickup'|'drone'|'hub'>('pickup'),[status,setStatus]=useState('Loading 3D imagery…'),[ready,setReady]=useState(false),[orbit,setOrbit]=useState(false);
  const element=useRef<HTMLDivElement>(null),map=useRef<EarthMap|null>(null),current=useRef({record,clockOffset,stale,frozenAt});current.current={record,clockOffset,stale,frozenAt};
  const pointFor=(which:typeof target):Point=>{const c=current.current;return which==='pickup'?c.record.package.pickup:which==='hub'?FACILITIES.find(f=>f.id===c.record.facilityId)!.point:snapshot(c.record,c.stale?c.frozenAt:Date.now()+c.clockOffset).point;};
  const camera=(which:typeof target):Camera=>({center:{...latLng(pointFor(which)),altitude:0},range:1000,tilt:60,heading:20});
  const selected=pointFor(target);
  useEffect(()=>{
    let cancelled=false;let node:EarthMap|undefined;const timeout=setTimeout(()=>{if(!cancelled)setStatus('3D imagery is taking longer than expected. You can open Google Earth below.');},25000);
    if(!config.key){setStatus('Connect Google Maps to load 3D imagery. Google Earth and Street View links work without a key.');clearTimeout(timeout);return;}
    void loadGoogle(config.key).then(async g=>{
      const library=await g.importLibrary('maps3d') as Library3D;if(cancelled||!element.current)return;
      node=new library.Map3DElement({...camera('pickup'),mode:'HYBRID',gestureHandling:'COOPERATIVE'});map.current=node;
      node.style.width='100%';node.style.height='100%';node.setAttribute('aria-label','Google photorealistic 3D location explorer');
      node.addEventListener('gmp-steadychange',(event)=>{if(!cancelled&&(event as Event&{isSteady?:boolean}).isSteady){clearTimeout(timeout);setReady(true);setStatus('Google 3D imagery · explore by dragging the map');}});
      node.addEventListener('gmp-error',()=>{if(!cancelled){clearTimeout(timeout);setReady(false);setStatus('3D imagery is unavailable on this device or key. Use the Google Earth link below.');}});
      node.addEventListener('gmp-animationend',()=>{if(!cancelled)setOrbit(false);});element.current.replaceChildren(node);
    }).catch(()=>{if(!cancelled){clearTimeout(timeout);setStatus('Could not load 3D imagery. Open Google Earth below or return to tracking.');}});
    return()=>{cancelled=true;clearTimeout(timeout);node?.stopCameraAnimation();node?.remove();map.current=null;};
  },[config.key,record.id]);
  function go(which:typeof target){setTarget(which);setOrbit(false);const m=map.current;if(!m)return;m.stopCameraAnimation();m.flyCameraTo({endCamera:camera(which),durationMillis:matchMedia('(prefers-reduced-motion: reduce)').matches?0:1800});}
  function toggleOrbit(){if(!map.current)return;if(orbit){map.current.stopCameraAnimation();setOrbit(false);}else{map.current.flyCameraAround({camera:camera(target),durationMillis:18000,repeatCount:1});setOrbit(true);}}
  return <div className="earth-explorer"><p className="body-copy">Explore the neighborhood in Google’s photorealistic 3D imagery, or open Street View to inspect a possible entrance. Imagery is recorded, not a live drone camera.</p><div className="earth-targets" role="group" aria-label="Explore location">{(['pickup','drone','hub'] as const).map(t=><button key={t} className={target===t?'primary':'secondary'} aria-pressed={target===t} onClick={()=>go(t)}><MapPin size={15}/>{t==='pickup'?'Pickup':t==='drone'?'Drone position':'Demo return hub'}</button>)}</div><div className="earth-viewport" ref={element}/><div className="earth-status"><span role="status">{status}</span><button className="secondary" disabled={!ready} onClick={toggleOrbit}>{orbit?<Square size={15}/>:<RotateCw size={15}/>} {orbit?'Stop orbit':'Orbit this location'}</button></div><div className="earth-links"><a className="primary" href={earthURL(selected)} target="_blank" rel="noreferrer"><Earth size={17}/>Open Google Earth<ExternalLink size={14}/></a><a className="secondary" href={streetViewURL(selected)} target="_blank" rel="noreferrer"><MapPin size={17}/>Open Street View<ExternalLink size={14}/></a></div><p className="fine-print">Street View opens in Google Maps, keeping this free demo independent of paid panorama APIs. Coverage and imagery dates vary. A view of a building does not establish return acceptance or permission to fly.</p></div>;
}
