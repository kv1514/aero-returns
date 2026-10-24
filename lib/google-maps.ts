import {latLng,nearbyWithin,type NearbyPlace} from './location';
import type {Point} from './simulation';
export {geocode} from './geocoding';
export type GoogleConfig={key:string;mapId:string};
export type GLocation={lat():number;lng():number};
type Listener={remove():void};
export interface GMap{setCenter(p:{lat:number;lng:number}):void;panTo(p:{lat:number;lng:number}):void;setZoom(n:number):void;getZoom():number|undefined;setTilt(n:number):void;setHeading(n:number):void;fitBounds(b:GBounds,padding?:number|{left:number;right:number;top:number;bottom:number}):void;addListener(name:string,fn:(e:{latLng?:GLocation})=>void):Listener;}
export interface GBounds{extend(p:{lat:number;lng:number}):GBounds;}
export interface GMarker extends HTMLElement{map:GMap|null;position:{lat:number;lng:number}|GLocation|null;}
export interface GLine{setPath(path:{lat:number;lng:number}[]):void;setMap(map:GMap|null):void;}
export interface GoogleSDK{
 importLibrary(name:string):Promise<unknown>;
 Map:new(el:HTMLElement,options:Record<string,unknown>)=>GMap;
 LatLngBounds:new()=>GBounds;
 Polyline:new(options:Record<string,unknown>)=>GLine;
 marker:{AdvancedMarkerElement:new(options:Record<string,unknown>)=>GMarker};
 places:{Place:{searchByText(request:Record<string,unknown>):Promise<{places:{id:string;displayName?:string;formattedAddress?:string;location?:GLocation;businessStatus?:string;googleMapsURI?:string}[]}>}};
 event:{clearInstanceListeners(instance:unknown):void};
}
declare global{interface Window{google?:{maps:GoogleSDK};aeroGoogleReady?:()=>void;gm_authFailure?:()=>void;}}
let loading:Promise<GoogleSDK>|undefined;
export function loadGoogle(key:string):Promise<GoogleSDK>{
 if(!key)return Promise.reject(new Error('Add a Google Maps browser key in Maps & location.'));
 if(loading)return loading;
 loading=new Promise((resolve,reject)=>{
  const script=document.createElement('script');const timer=setTimeout(()=>reject(new Error('Google Maps did not load. Check your connection and key settings.')),20000);
  window.aeroGoogleReady=()=>{clearTimeout(timer);if(window.google?.maps)resolve(window.google.maps);else reject(new Error('Google Maps is unavailable.'));};
  window.gm_authFailure=()=>{clearTimeout(timer);window.dispatchEvent(new Event('aero:google-auth-error'));reject(new Error('Google rejected this key. Check API access, quota, and website restrictions.'));};
  script.src='https://maps.googleapis.com/maps/api/js?'+new URLSearchParams({key,loading:'async',callback:'aeroGoogleReady',v:'quarterly',libraries:'maps,marker,places'});
  script.async=true;script.onerror=()=>{clearTimeout(timer);reject(new Error('Could not connect to Google Maps.'));};document.head.appendChild(script);
 });return loading;
}
export const PLACE_QUERIES={'UPS drop-offs':'UPS Store UPS Access Point package drop off','Other drop-offs':'package shipping drop off FedEx USPS','Warehouses':'warehouse distribution center'} as const;
export async function searchNearby(config:GoogleConfig,center:Point,category:keyof typeof PLACE_QUERIES,radius:number):Promise<NearbyPlace[]>{
 const g=await loadGoogle(config.key);const {places}=await g.places.Place.searchByText({textQuery:PLACE_QUERIES[category],fields:['id','displayName','formattedAddress','location','businessStatus','googleMapsURI'],locationBias:{center:latLng(center),radius},maxResultCount:20});
 return nearbyWithin(places.filter(p=>p.location).map(p=>({id:p.id,name:p.displayName||'Place',address:p.formattedAddress||'Address unavailable',point:[p.location!.lng(),p.location!.lat()] as Point,status:p.businessStatus||'UNKNOWN',meters:0,url:p.googleMapsURI||`https://www.google.com/maps/search/?api=1&query=${p.location!.lat()},${p.location!.lng()}&query_place_id=${encodeURIComponent(p.id)}`})),center,radius);
}
