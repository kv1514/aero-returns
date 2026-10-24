import type { PackageInput } from './simulation';
export function parseReturnQR(raw: string): { details: Partial<PackageInput>; message: string; recognized: boolean } {
  if(raw.startsWith('AERO-RETURN:')) {
    try {
      const data=JSON.parse(raw.slice(12));
      if(!['Amazon','Nike','Zara','Other'].includes(data.retailer)||typeof data.reference!=='string'||data.reference.length>150)throw new Error();
      const details:Partial<PackageInput>={retailer:data.retailer,method:data.method==='label'?'label':'qr',returnReference:data.reference};
      if(typeof data.weight==='number'&&Number.isFinite(data.weight)&&data.weight>0&&data.weight<=5)details.weight=data.weight;
      return {details,message:`Demo code read · ${data.retailer} · ${data.reference}. Review your package below.`,recognized:true};
    }catch{return {details:{},message:'The demo QR data is incomplete. Enter the return details below.',recognized:false};}
  }
  return {details:{},message:'QR code read. This retailer’s code does not expose package details. Choose the retailer and return method below; compatibility is simulated.',recognized:false};
}
export async function readQR(file: File) {
  if(!/^image\/(png|jpeg|webp)$/.test(file.type))throw new Error('Choose a PNG, JPG, or WebP image of your return code.');
  if(file.size>8*1024*1024)throw new Error('Choose an image smaller than 8 MB.');
  const bitmap=await createImageBitmap(file);
  try {
    if(bitmap.width*bitmap.height>40000000)throw new Error('This image is too large. Crop it to the return code.');
    const ratio=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*ratio);canvas.height=Math.round(bitmap.height*ratio);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw new Error('Image reading is unavailable in this browser.');
    // Transparent codes are drawn for light or dark backgrounds, so try each behind the image.
    const {default:jsQR}=await import('jsqr');let code:ReturnType<typeof jsQR>=null;
    for(const background of ['#fff','#000']){ctx.fillStyle=background;ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);const image=ctx.getImageData(0,0,canvas.width,canvas.height);code=jsQR(image.data,image.width,image.height,{inversionAttempts:'attemptBoth'});if(code)break;}
    if(!code)throw new Error('No readable QR code found. Try a sharper crop, or enter the details manually.');
    return parseReturnQR(code.data);
  }finally{bitmap.close();}
}
