import {env} from 'cloudflare:workers';
import {cookies} from 'next/headers';
import {createServerClient} from '@supabase/ssr';
import {verifyAccountUser} from './verified-identity';

export function accountConfig(){
  const configured=!!(env.SUPABASE_URL&&env.SUPABASE_PUBLISHABLE_KEY);
  return {configured,google:configured&&env.SUPABASE_GOOGLE_ENABLED==='true',amazon:configured&&env.SUPABASE_AMAZON_ENABLED==='true'};
}
export async function accountClient(){
  if(!accountConfig().configured)return null;
  const store=await cookies();
  return createServerClient(env.SUPABASE_URL!,env.SUPABASE_PUBLISHABLE_KEY!,{
    cookieOptions:{name:'aero_auth',httpOnly:true,sameSite:'lax',secure:env.SUPABASE_COOKIE_SECURE!=='false',path:'/'},
    cookies:{getAll:()=>store.getAll(),setAll:values=>{for(const {name,value,options} of values)store.set(name,value,options);}}
  });
}
export async function verifiedAccount(){
  const client=await accountClient();if(!client)return null;
  const store=await cookies();
  if(!store.getAll().some(c=>/^aero_auth(?:\.\d+)?$/.test(c.name)&&c.value))return null;
  // Always verify with Auth. Cookie contents and user_metadata are not authorization evidence.
  return verifyAccountUser(()=>client.auth.getUser());
}
