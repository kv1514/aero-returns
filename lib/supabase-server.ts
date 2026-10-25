import {env} from 'cloudflare:workers';
import {cookies} from 'next/headers';
import {createServerClient} from '@supabase/ssr';
import {verifyAccountUser} from './verified-identity';

export function accountConfig(){
  const configured=!!(env.SUPABASE_URL&&env.SUPABASE_PUBLISHABLE_KEY);
  return {configured,google:configured&&env.SUPABASE_GOOGLE_ENABLED==='true',amazon:configured&&env.SUPABASE_AMAZON_ENABLED==='true',email:configured&&env.SUPABASE_EMAIL_ENABLED==='true'};
}
const cookieOptions=()=>({httpOnly:true,sameSite:'lax' as const,secure:env.SUPABASE_COOKIE_SECURE!=='false',path:'/'});
/** The session cookie and its chunks (aero_auth, aero_auth.0, …). */
const SESSION_COOKIE=/^aero_auth(?:\.\d+)?$/;
/** auth-js's PKCE verifiers: one slot per pending flow, the index of those flows, and the fixed key mirroring the newest. */
const VERIFIER_COOKIE=/^aero_auth-(?:flow-[A-Za-z0-9_-]{8,64}-|flows-)?code-verifier(?:\.\d+)?$/;
const VERIFIER_MAX_AGE=400*24*60*60;// @supabase/ssr's own lifetime for these cookies
export async function accountClient(){
  if(!accountConfig().configured)return null;
  const store=await cookies();
  return createServerClient(env.SUPABASE_URL!,env.SUPABASE_PUBLISHABLE_KEY!,{
    cookieOptions:{name:'aero_auth',...cookieOptions()},
    cookies:{getAll:()=>store.getAll(),setAll:values=>{for(const {name,value,options} of values)store.set(name,value,options);}}
  });
}
/**
 * Drops the session cookies written during this request. For a sign-in whose new session then failed verification:
 * without this the browser would keep the unverified session and be signed in on its next load.
 */
export async function clearAccountSession(){
  const store=await cookies();
  for(const {name,value} of store.getAll())if(SESSION_COOKIE.test(name)&&value)store.set(name,'',{...cookieOptions(),maxAge:0});
}
/**
 * Notes the PKCE verifier cookies as they arrived and returns a function that puts them back. A sign-up that got a session
 * (or failed) needs no confirmation link, so its new verifier would otherwise stay for 400 days; other pending flows keep theirs.
 */
export async function verifierCheckpoint(){
  const store=await cookies();
  const before=new Map(store.getAll().filter(c=>VERIFIER_COOKIE.test(c.name)).map(c=>[c.name,c.value]));
  return ()=>{
    for(const {name,value} of store.getAll()){
      if(!VERIFIER_COOKIE.test(name))continue;
      const old=before.get(name);
      if(old===value||(old===undefined&&!value))continue;
      store.set(name,old??'',{...cookieOptions(),maxAge:old===undefined?0:VERIFIER_MAX_AGE});
    }
  };
}
export async function verifiedAccount(){
  const client=await accountClient();if(!client)return null;
  const store=await cookies();
  if(!store.getAll().some(c=>SESSION_COOKIE.test(c.name)&&c.value))return null;
  // Always verify with Auth. Cookie contents and user_metadata are not authorization evidence.
  return verifyAccountUser(()=>client.auth.getUser());
}
