import {z} from 'zod';
import {DEMO_PACKAGE,type PackageInput} from './simulation';
import {inDemoArea} from './location';

export const DRAFT_KEY='aero:booking-draft:v1';
const ttl=12*60*60*1000;
const number=z.number().finite().min(0).max(10000);
const schema=z.object({
  version:z.literal(1),updatedAt:z.number().finite(),step:z.number().int().min(0).max(2),
  package:z.object({retailer:z.enum(['Amazon','Nike','Zara','Other']),method:z.enum(['qr','label']),weight:number,
    dimensions:z.tuple([number,number,number]),fragile:z.boolean(),address:z.string().max(160),
    pickup:z.tuple([z.number().finite(),z.number().finite()]).refine(inDemoArea),
    instructions:z.string().max(500),service:z.enum(['standard','priority']),returnReference:z.string().max(150).optional()})
});
export type BookingDraft={version:1;updatedAt:number;step:number;package:PackageInput};
export const blankPackage=():PackageInput=>({...DEMO_PACKAGE,returnReference:undefined});
// A draft is worth restoring only when it differs from the untouched wizard defaults.
export function isRecoverableDraft(draft:BookingDraft|null){if(!draft)return false;if(draft.step>0)return true;const blank=blankPackage();return (Object.keys({...blank,...draft.package}) as (keyof PackageInput)[]).some(k=>JSON.stringify(draft.package[k])!==JSON.stringify(blank[k]));}
export function readDraft(raw:string|null,now=Date.now()):BookingDraft|null{
  try{const result=schema.safeParse(JSON.parse(raw||'null'));if(!result.success)return null;const draft=result.data;
    if(draft.updatedAt>now||now-draft.updatedAt>ttl)return null;
    return draft;
  }catch{return null;}
}
export function bookingProblem(pkg:PackageInput){
  if(pkg.address.trim().length<3)return 'Enter a pickup address or entrance with at least three characters.';
  if(!inDemoArea(pkg.pickup))return 'Choose a pickup inside the Berkeley demo area.';
  if(!Number.isFinite(pkg.weight)||pkg.weight<=0||pkg.dimensions.some(d=>!Number.isFinite(d)||d<=0))return 'Enter a positive weight and all three dimensions.';
  return '';
}
