import {env} from 'cloudflare:workers';
import {z} from 'zod';
import {session} from './session';
import {demoMode,exitDemoCookie} from './demo-account';
import {sessionFailure} from './integration-server';
import {amazonAuthorizeURL,pkceChallenge,validCallback} from './amazon-oauth';
/** Why linking cannot start on this origin, or null when it can. A callback registered for another Site would fail every attempt. */
function amazonSetup(request:Request):'missing'|'callback_origin'|null{if(!(env.AMAZON_CLIENT_ID&&env.AMAZON_CLIENT_SECRET&&env.AMAZON_REDIRECT_URI&&validCallback(env.AMAZON_REDIRECT_URI)))return 'missing';return new URL(env.AMAZON_REDIRECT_URI).origin===new URL(request.url).origin?null:'callback_origin';}
export const amazonConfigured=(request:Request)=>!amazonSetup(request);
export async function amazonAccount(request:Request){
 let identity:Awaited<ReturnType<typeof session>>;try{identity=await session(request);}catch{return sessionFailure(request);}
 const {owner,cookie}=identity;const headers={'Cache-Control':'no-store',...(cookie?{'Set-Cookie':cookie}:{})};const reply=(data:unknown,status=200)=>Response.json(data,{status,headers});
 try{if(!env.DB)return reply({error:'Account storage is unavailable.'},503);
 const setup=amazonSetup(request);
 if(request.method==='GET'){const profile=await env.DB.prepare('SELECT name,email,linked_at FROM amazon_accounts WHERE owner = ?').bind(owner).first<{name:string;email:string;linked_at:number}>();return reply({configured:!setup,setup,connected:!!profile,profile,scope:'profile',ordersAvailable:false});}
 if(request.headers.get('origin')!==new URL(request.url).origin)return reply({error:'Request origin is not allowed.'},403);
 if(request.method==='DELETE'){await env.DB.batch([env.DB.prepare('DELETE FROM amazon_accounts WHERE owner = ?').bind(owner),env.DB.prepare('DELETE FROM amazon_oauth_states WHERE owner = ?').bind(owner)]);return reply({connected:false});}
 if(request.method!=='POST')return reply({error:'Method not allowed.'},405);
 if(setup)return reply({error:setup==='missing'?'Amazon linking needs a registered Login with Amazon app. Configure AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, and AMAZON_REDIRECT_URI.':`The configured Amazon callback belongs to a different Site. Set AMAZON_REDIRECT_URI to ${new URL('/api/amazon/callback',request.url).href}.`},503);
 const state=crypto.randomUUID(),verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 await env.DB.batch([env.DB.prepare('DELETE FROM amazon_oauth_states WHERE expires_at < ? OR owner = ?').bind(Date.now(),owner),env.DB.prepare('INSERT INTO amazon_oauth_states (state,owner,verifier,expires_at) VALUES (?,?,?,?)').bind(state,owner,verifier,Date.now()+600000)]);
 const response=reply({url:amazonAuthorizeURL(env.AMAZON_CLIENT_ID!,env.AMAZON_REDIRECT_URI!,state,await pkceChallenge(verifier))});response.headers.append('Set-Cookie',`aero_amazon_state=${state}; Path=/api/amazon; HttpOnly; SameSite=Lax; Max-Age=600${new URL(request.url).protocol==='https:'?'; Secure':''}`);return response;
 }catch{return reply({error:'Could not update the Amazon connection. Try again shortly.'},503);}
}
export async function amazonCallback(request:Request){
 const url=new URL(request.url);
 const finish=(status:string)=>new Response(null,{status:303,headers:{Location:new URL('/?amazon='+status,url.origin).href,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':`aero_amazon_state=; Path=/api/amazon; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol==='https:'?'; Secure':''}`}});
 // Keep the 303 contract (and clear the state cookie) when the session cannot be resolved.
 let owner:string;try{({owner}=await session(request));}catch{const response=finish('session');if(demoMode(request.headers.get('cookie')))response.headers.append('Set-Cookie',exitDemoCookie(request));return response;}
 try{if(!env.DB||!amazonConfigured(request))return finish('setup');const state=url.searchParams.get('state'),cookie=request.headers.get('cookie')?.match(/(?:^|;\s*)aero_amazon_state=([a-f0-9-]{36})(?:;|$)/)?.[1];
 if(!state||state!==cookie||state.length!==36)return finish('invalid');
 const pending=await env.DB.prepare('DELETE FROM amazon_oauth_states WHERE state = ? AND owner = ? AND expires_at > ? RETURNING verifier').bind(state,owner,Date.now()).first<{verifier:string}>();if(!pending)return finish('expired');
 if(url.searchParams.has('error'))return finish('cancelled');const code=url.searchParams.get('code');if(!code||code.length>4096)return finish('invalid');
 const tokenResponse=await fetch('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,client_id:env.AMAZON_CLIENT_ID!,client_secret:env.AMAZON_CLIENT_SECRET!,redirect_uri:env.AMAZON_REDIRECT_URI!,code_verifier:pending.verifier}),signal:AbortSignal.timeout(15000)});if(!tokenResponse.ok)return finish('failed');
 const token=z.object({access_token:z.string().min(1)}).parse(await tokenResponse.json());
 const profileResponse=await fetch('https://api.amazon.com/user/profile',{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(15000)});if(!profileResponse.ok)return finish('failed');
 const profile=z.object({user_id:z.string().min(1).max(500),name:z.string().max(300),email:z.string().email().max(320)}).parse(await profileResponse.json());
 await env.DB.prepare('INSERT INTO amazon_accounts (owner,amazon_user_id,name,email,linked_at) VALUES (?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET amazon_user_id=excluded.amazon_user_id,name=excluded.name,email=excluded.email,linked_at=excluded.linked_at').bind(owner,profile.user_id,profile.name,profile.email,Date.now()).run();
 // No access or refresh tokens are persisted: this connection associates a profile only.
 return finish('linked');
 }catch{return finish('failed');}
}
