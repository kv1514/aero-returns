'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Camera,Check,CheckCircle2,Crosshair,ImagePlus,LoaderCircle,MapPin,ScanLine,ShieldCheck,Sparkles,Trash2} from 'lucide-react';
import {streetViewURL} from '@/lib/map-links';
import {gatePickupDetection,placeBox,type PickupGuide,type PackageBox} from '@/lib/pickup-guide';
import type {ReturnRecord} from '@/lib/simulation';

export default function PickupPhoto({record,guide,onChange}:{record:ReturnRecord;guide:PickupGuide|null;onChange:(guide:PickupGuide|null)=>void}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(''),[configured,setConfigured]=useState(false),[scan,setScan]=useState(false);
  const picker=useRef<HTMLInputElement>(null),request=useRef<AbortController|null>(null),generation=useRef(0),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>{const abort=new AbortController();fetch('/api/integrations',{signal:abort.signal}).then(r=>r.json().catch(()=>null) as Promise<{anthropic?:boolean}|null>).then((s:{anthropic?:boolean}|null)=>setConfigured(!!s?.anthropic)).catch(()=>{});return()=>{abort.abort();request.current?.abort();generation.current++;clearTimeout(timer.current);};},[]);
  const current=guide?.recordId===record.id?guide:null;
  function resetWork(){request.current?.abort();generation.current++;setBusy('');setScan(false);clearTimeout(timer.current);setError('');}
  function change(patch:Partial<PickupGuide>){if(current){setScan(false);clearTimeout(timer.current);onChange({...current,...patch,confirmed:false});}}
  async function upload(file?:File){
    if(!file)return;resetWork();const token=generation.current;
    if(!/^image\/(jpeg|png|webp)$/.test(file.type)||file.size>8*1024*1024){setError('Choose a JPG, PNG, or WebP image under 8 MB. Convert HEIC photos to JPG first.');return;}
    setBusy('photo');let bitmap:ImageBitmap|undefined;
    try{
      bitmap=await createImageBitmap(file);if(bitmap.width*bitmap.height>40000000)throw new Error('This image is too large. Choose a photo below 40 megapixels.');
      const scale=Math.min(1,1200/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const context=canvas.getContext('2d');if(!context)throw new Error('This browser could not prepare the photo.');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const preview=canvas.toDataURL('image/jpeg',.82);if(preview.length>2000000)throw new Error('Try a smaller photo.');
      if(token===generation.current)onChange({recordId:record.id,preview,imageData:preview.split(',')[1],sample:false,box:null,notes:'',confirmed:false,detection:null});
    }catch(e){if(token===generation.current)setError(e instanceof Error?e.message:'Could not read that photo.');}
    finally{bitmap?.close();if(token===generation.current)setBusy('');}
  }
  function sample(){resetWork();onChange({recordId:record.id,preview:'/sample-pickup.svg',imageData:null,sample:true,box:null,notes:'Brown box to the right of the green door.',confirmed:false,detection:null});}
  async function detect(){if(!current?.imageData)return;resetWork();const token=generation.current;const controller=new AbortController();request.current=controller;setBusy('detect');
    try{const response=await fetch('/api/pickup-review',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({images:[{mediaType:'image/jpeg',data:current.imageData}],product:`Pickup placement notes: ${current.notes||'Locate a parcel in this pickup photo.'}`})});
      const data=await response.json().catch(()=>({})) as {error?:string;detection?:unknown};if(!response.ok)throw new Error(data.error||'The photo check did not finish.');const detection=gatePickupDetection(data.detection);
      // No single-package suggestion keeps the frame the person already marked; any AI check still needs re-confirmation.
      if(token===generation.current)onChange({...current,detection,box:detection.box??current.box,confirmed:false});
    }catch(e){if(token===generation.current&&!controller.signal.aborted)setError(e instanceof Error?e.message:'Try marking the package yourself.');}finally{if(token===generation.current)setBusy('');}}
  const box=current?.box;
  function move(patch:Partial<PackageBox>){const b={...(box||placeBox(.5,.5)),...patch};change({box:placeBox(b.x+b.width/2,b.y+b.height/2,b.width,b.height)});}
  function previewScan(){setScan(true);clearTimeout(timer.current);timer.current=setTimeout(()=>setScan(false),2400);}
  return <div className="pickup-guide">
    <div className="pickup-heading"><span className="pickup-kicker"><Crosshair size={14}/>VISUAL PICKUP GUIDE</span><h3>A familiar spot.<br/>An easier pickup.</h3><p>Show us your package in its pickup spot. A fresh photo gives the demo a visual reference that Street View can’t.</p></div>
    <div className="pickup-location"><span className="pickup-location-icon"><MapPin size={20}/></span><div><small>YOUR PICKUP</small><strong>{record.package.address}</strong></div><a href={streetViewURL(record.package.pickup)} target="_blank" rel="noreferrer">Street View<ArrowUpRight size={15}/></a></div>
    <ol className="pickup-steps"><li className="active"><span>{current?<Check size={13}/>:'1'}</span>Add a photo</li><li className={current?'active':''}><span>{box?<Check size={13}/>:'2'}</span>Mark the package</li><li className={current?.confirmed?'active':''}><span>{current?.confirmed?<Check size={13}/>:'3'}</span>Confirm reference</li></ol>
    <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e=>{const file=e.target.files?.[0];e.target.value='';void upload(file);}}/>
    {!current?<div className="pickup-empty" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void upload(e.dataTransfer.files[0]);}}><span className="pickup-camera"><Camera size={30}/></span><h4>Your package. Its surroundings.</h4><p>Include the whole parcel and a nearby landmark,<br/>like your doorway or porch.</p><button className="primary" disabled={!!busy} onClick={()=>picker.current?.click()}>{busy?<LoaderCircle size={17} className="spin"/>:<ImagePlus size={17}/>}Choose a pickup photo</button><small>or drop an image here · JPG, PNG, WebP · up to 8 MB</small><button className="text-button" disabled={!!busy} onClick={sample}>Try an illustrated example<ArrowUpRight size={14}/></button></div>:<div className="pickup-workspace">
      <div className="pickup-visual"><div className="pickup-photo-toolbar"><span><span className="pickup-live-dot"/>{current.sample?'Illustrated example':'Your pickup photo'}</span><div><button aria-label="Replace pickup photo" disabled={!!busy} onClick={()=>picker.current?.click()}><ImagePlus size={17}/></button><button aria-label="Remove pickup photo" onClick={()=>{resetWork();onChange(null);}}><Trash2 size={16}/></button></div></div>
        <button type="button" className={`pickup-image ${scan?'scanning':''}`} disabled={!!busy} aria-label="Mark package in photo. Click its center, or use the position controls below." onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();change({box:placeBox((e.clientX-rect.left)/rect.width,(e.clientY-rect.top)/rect.height,box?.width||.25,box?.height||.28)});}} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const b=box||placeBox(.5,.5);move({x:b.x+(e.key==='ArrowLeft'?-.02:e.key==='ArrowRight'?.02:0),y:b.y+(e.key==='ArrowUp'?-.02:e.key==='ArrowDown'?.02:0)});}if(e.key==='Enter'||e.key===' '){e.preventDefault();change({box:box||placeBox(.5,.5)});}}}>
          <img src={current.preview} alt={current.sample?'Illustrated porch with a brown parcel to the right of a green door':'Your uploaded package and pickup surroundings'} draggable={false}/>
          {box&&<span className={`pickup-box ${current.confirmed?'confirmed':''}`} style={{left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.width*100}%`,height:`${box.height*100}%`}}><span>{current.confirmed?'Your confirmed reference':'Package · review selection'}</span><i/><i/><i/><i/></span>}{scan&&<span className="pickup-scan-line"/>}
        </button>
        <p className="pickup-image-caption"><Crosshair size={14}/>{box?'Adjust the frame so it includes only your package.':'Tap the center of your package to place the frame.'}</p>
        {box&&<details className="pickup-adjust"><summary>Adjust frame position & size</summary><div>{(['x','y','width','height'] as const).map(key=><label key={key}>{({x:'Left',y:'Top',width:'Width',height:'Height'})[key]}<input aria-label={`Package frame ${key}`} type="range" min={key==='width'||key==='height'?2:0} max={key==='x'?Math.round((1-box.width)*100):key==='y'?Math.round((1-box.height)*100):100} value={Math.round(box[key]*100)} disabled={!!busy} onChange={e=>move({[key]:Number(e.target.value)/100})}/><output>{Math.round(box[key]*100)}%</output></label>)}</div></details>}
      </div>
      <aside className="pickup-sidebar"><span className="pickup-section-label">A LITTLE CONTEXT HELPS</span><label className="pickup-notes">Where should we look?<textarea maxLength={400} rows={3} disabled={!!busy} placeholder="Brown box beside the blue planter, right of the front door…" value={current.notes} onChange={e=>change({notes:e.target.value})}/></label>
        <div className="pickup-ai"><Sparkles size={19}/><h4>Help find the package</h4><p>Claude can suggest a package frame from your photo. You’ll review it before using it.</p><button className="secondary full" disabled={!configured||current.sample||!!busy} onClick={()=>void detect()}>{busy==='detect'?<LoaderCircle size={15} className="spin"/>:<ScanLine size={16}/>} {busy==='detect'?'Checking the photo…':'Send photo to Claude'}</button><small>{!configured?'AI setup pending. Manual marking works now.':current.sample?'Upload a real photo to use AI assistance.':'This sends the photo and your notes to Anthropic. AirCart does not save the image on its server.'}</small></div>
        {current.detection&&<div className="pickup-detection" role="status"><strong>Claude suggestion · needs your review</strong><p>{current.detection.description}</p>{!current.detection.box&&<p>{current.box?'Claude could not pick a single package. Review your frame before confirming.':'No single package selected. Please mark yours manually.'}</p>}{current.detection.concerns.map((concern,i)=><p key={i}>{concern}</p>)}</div>}
        <button className="primary full" disabled={!box||!!busy||current.confirmed} onClick={()=>onChange({...current,confirmed:true})}><CheckCircle2 size={17}/>{current.confirmed?'Reference confirmed':'This is my package'}</button>
        {current.confirmed&&<div className="pickup-confirmed" role="status"><ShieldCheck size={19}/><div><strong>Ready for the pickup demo</strong><p>Human-confirmed reference. No live camera match or physical pickup has occurred.</p><button className="text-button" onClick={previewScan} disabled={scan}><ScanLine size={14}/>{scan?'Previewing reference overlay…':'Preview reference overlay'}</button></div></div>}
      </aside></div>}
    {error&&<p className="error-note" role="alert">{error}</p>}
    <div className="pickup-privacy"><ShieldCheck size={16}/><p>Your photo stays in this page’s memory unless you choose the AI check. It clears on refresh, sign-out, or switching returns. Street View opens separately; nothing is published to Google. Keep faces and shipping-label details out of the frame.</p></div>
  </div>;
}
