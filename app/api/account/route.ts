import {accountClient,accountConfig,verifiedAccount} from '@/lib/supabase-server';
import {sameOrigin} from '@/lib/account-policy';
export const dynamic='force-dynamic';
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
export async function GET(){
  try{const account=await verifiedAccount();return reply({...accountConfig(),user:account?{id:account.user.id,email:account.user.email||'',name:typeof account.user.user_metadata?.name==='string'?account.user.user_metadata.name:account.user.email||'AERO member'}:null});}
  catch{return reply({...accountConfig(),user:null,error:'Your account session needs attention. Sign out and try again.',sessionError:true},401);}
}
export async function DELETE(request:Request){
  if(!sameOrigin(request))return reply({error:'Request origin is not allowed.'},403);
  try{const client=await accountClient();if(client){const {error}=await client.auth.signOut({scope:'local'});if(error)return reply({error:'Sign-out failed. Please retry.'},503);}return reply({signedOut:true});}
  catch{return reply({error:'Sign-out is temporarily unavailable.'},503);}
}
