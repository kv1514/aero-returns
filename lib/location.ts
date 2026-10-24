import { distance, type Point } from './simulation';
export const DEMO_BOUNDS={west:-122.31,east:-122.24,south:37.85,north:37.90};
export const inDemoArea=([lng,lat]:Point)=>Number.isFinite(lng)&&Number.isFinite(lat)&&lng>=DEMO_BOUNDS.west&&lng<=DEMO_BOUNDS.east&&lat>=DEMO_BOUNDS.south&&lat<=DEMO_BOUNDS.north;
export const latLng=([lng,lat]:Point)=>({lat,lng});
export function locationError(code:number){return code===1?'Location permission was declined. Choose a location manually instead.':code===3?'Location took too long. Try again outdoors or choose a location manually.':'Your device could not determine a location. Choose a location manually instead.';}
export function locateOnce():Promise<{point:Point;accuracy:number}>{return new Promise((resolve,reject)=>{
  if(!globalThis.navigator?.geolocation){reject(new Error('Location is unavailable in this browser. Choose a location manually instead.'));return;}
  navigator.geolocation.getCurrentPosition(p=>resolve({point:[p.coords.longitude,p.coords.latitude],accuracy:p.coords.accuracy}),e=>reject(new Error(locationError(e.code))),{enableHighAccuracy:true,timeout:15000,maximumAge:30000});
});}
export type NearbyPlace={id:string;name:string;address:string;point:Point;status:string;meters:number;url:string};
export function nearbyWithin(places:NearbyPlace[],center:Point,radius:number){return [...new Map(places.map(p=>[p.id,{...p,meters:distance(center,p.point)}])).values()].filter(p=>p.meters<=radius&&p.status!=='CLOSED_PERMANENTLY').sort((a,b)=>a.meters-b.meters);}
export function directionsURL(place:Pick<NearbyPlace,'id'|'point'>){const q=new URLSearchParams({api:'1',destination:`${place.point[1]},${place.point[0]}`,destination_place_id:place.id});return `https://www.google.com/maps/dir/?${q}`;}
