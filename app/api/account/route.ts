import {accountClient,accountConfig,verifiedAccount} from '@/lib/supabase-server';
import {sameOrigin} from '@/lib/account-policy';
import {demoIdentity,demoMode,exitDemoCookie} from '@/lib/demo-account';
import {sessionFailure,unsupported} from '@/lib/http';
import {publishAccount} from '@/lib/spacetime-server';
export const dynamic='force-dynamic';
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
export async function GET(request:Request){
  try{const demo=demoIdentity(request.headers.get('cookie'));publishAccount(demo?.owner);
    if(demo)return reply({...accountConfig(),demo:true,user:{id:'demo',email:'',name:'Alex Demo'}});
    const account=await verifiedAccount();publishAccount(account?.owner); // guests get a row when they book, never from a cookie alone
    return reply({...accountConfig(),demo:false,user:account?{id:account.user.id,email:account.user.email||'',name:typeof account.user.user_metadata?.name==='string'?account.user.user_metadata.name:account.user.email||'AirCart member'}:null});}
  catch{const extra={...accountConfig(),user:null};return demoMode(request.headers.get('cookie'))?sessionFailure(request,extra):reply({...extra,error:'Your account session needs attention. Sign out and try again.',sessionError:true},401);}
}
export async function DELETE(request:Request){
  if(!sameOrigin(request))return reply({error:'Request origin is not allowed.'},403);
  if(demoMode(request.headers.get('cookie')))return Response.json({signedOut:true},{headers:{'Cache-Control':'private, no-store','Set-Cookie':exitDemoCookie(request)}});
  try{const client=await accountClient();if(client){const {error}=await client.auth.signOut({scope:'local'});if(error)return reply({error:'Sign-out failed. Please retry.'},503);}return reply({signedOut:true});}
  catch{return reply({error:'Sign-out is temporarily unavailable.'},503);}
}
const no=unsupported('GET','DELETE');
export const POST=no,PUT=no,PATCH=no,OPTIONS=no;
