import {z} from 'zod';
import type {Point} from './simulation';

const responseSchema=z.object({results:z.array(z.object({
  formattedAddress:z.string().min(1),
  location:z.object({latitude:z.number().finite().min(-90).max(90),longitude:z.number().finite().min(-180).max(180)})
})).default([])});

// Geocoding v4 supports Google's no-billing Maps Demo Key; the legacy JS Geocoder does not.
// https://developers.google.com/maps/documentation/geocoding/geocoding
export async function geocode(key:string,input:string|Point,request:typeof fetch=fetch){
  if(!key)throw new Error('Connect a Google Maps key first.');
  if(typeof input==='string'? !input.trim()||input.length>500 : input.length!==2||!input.every(Number.isFinite)||Math.abs(input[0])>180||Math.abs(input[1])>90){
    throw new Error('Enter a valid address or map location.');
  }
  const path=typeof input==='string'?`address/${encodeURIComponent(input.trim())}`:`location/${input[1]},${input[0]}`;
  const response=await request(`https://geocode.googleapis.com/v4/geocode/${path}`,{
    headers:{'X-Goog-Api-Key':key,'X-Goog-FieldMask':'results.formattedAddress,results.location'},
    signal:AbortSignal.timeout(15000),cache:'no-store',credentials:'omit'
  });
  if(!response.ok)throw new Error(response.status===429?'Google’s daily usage limit was reached. Try again later.':'Address lookup failed. Check Geocoding API access and key restrictions.');
  const parsed=responseSchema.safeParse(await response.json());
  if(!parsed.success)throw new Error('Google returned an invalid address response.');
  return parsed.data.results.map(r=>({address:r.formattedAddress,point:[r.location.longitude,r.location.latitude] as Point}));
}
