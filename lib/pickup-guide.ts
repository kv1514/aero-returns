import {z} from 'zod';

// Image coordinates only. These are never geographic coordinates or flight commands.
export const packageBoxSchema=z.object({x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1),width:z.number().finite().min(.02).max(1),height:z.number().finite().min(.02).max(1)}).refine(b=>b.x+b.width<=1.000001&&b.y+b.height<=1.000001,'Package box must fit inside the image.');
export type PackageBox=z.infer<typeof packageBoxSchema>;
export const pickupDetectionSchema=z.object({packageCount:z.number().int().min(0).max(100),box:packageBoxSchema.nullable(),description:z.string().max(500),concerns:z.array(z.string().max(250)).max(8)});
export type PickupDetection=z.infer<typeof pickupDetectionSchema>;
export function gatePickupDetection(raw:unknown):PickupDetection {
  const result=pickupDetectionSchema.parse(raw);
  // Multiple parcels or uncertain visibility require the person to choose, not the model.
  return result.packageCount===1?result:{...result,box:null};
}
export function placeBox(cx:number,cy:number,width=.3,height=.3):PackageBox {
  const w=Math.min(1,Math.max(.02,Number.isFinite(width)?width:.3));
  const h=Math.min(1,Math.max(.02,Number.isFinite(height)?height:.3));
  return {x:Math.min(1-w,Math.max(0,(Number.isFinite(cx)?cx:.5)-w/2)),y:Math.min(1-h,Math.max(0,(Number.isFinite(cy)?cy:.5)-h/2)),width:w,height:h};
}
export type PickupGuide={recordId:string;preview:string;imageData:string|null;sample:boolean;box:PackageBox|null;notes:string;confirmed:boolean;detection:PickupDetection|null};
