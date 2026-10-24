// A demo identity is an unguessable browser capability, never a shared login or
// a Supabase user. The inactive token lets this browser resume its practice history.
export const DEMO_ID_COOKIE='aero_demo_id';
export const DEMO_MODE_COOKIE='aero_demo_active';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function cookieValue(header:string|null,name:string){return header?.split(';').map(s=>s.trim()).find(s=>s.startsWith(`${name}=`))?.slice(name.length+1);}
export function demoMode(header:string|null){return cookieValue(header,DEMO_MODE_COOKIE)==='1';}
export function demoToken(header:string|null){const value=cookieValue(header,DEMO_ID_COOKIE);return value&&uuid.test(value)?value:null;}
export function demoIdentity(header:string|null){
  if(!demoMode(header))return null;
  const token=demoToken(header);
  if(!token)throw new Error('Demo session is invalid. Exit the demo account and try again.');
  return {owner:`demo:${token}`};
}
export function demoCookie(name:string,value:string,request:Request,maxAge=2592000){
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol==='https:'?'; Secure':''}`;
}
export function exitDemoCookie(request:Request){return demoCookie(DEMO_MODE_COOKIE,'',request,0);}
