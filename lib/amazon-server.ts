import {env} from 'cloudflare:workers';
import {z} from 'zod';
import {session} from './server';
import {amazonAuthorizeURL,pkceChallenge,validCallback} from './amazon-oauth';
const configured=()=>!!(env.AMAZON_CLIENT_ID&&env.AMAZON_CLIENT_SECRET&&env.AMAZON_REDIRECT_URI&&validCallback(env.AMAZON_REDIRECT_URI));
export async function amazonAccount(request:Request){
 const {owner,cookie}=session(request);const headers={'Cache-Control':'no-store',...(cookie?{'Set-Cookie':cookie}:{})};const reply=(data:unknown,status=200)=>Response.json(data,{status,headers});
 try{if(!env.DB)return reply({error:'Account storage is unavailable.'},503);
 if(request.method==='GET'){const profile=await env.DB.prepare('SELECT name,email,linked_at FROM amazon_accounts WHERE owner = ?').bind(owner).first<{name:string;email:string;linked_at:number}>();return reply({configured:configured(),connected:!!profile,profile,scope:'profile',ordersAvailable:false});}
 if(request.headers.get('origin')!==new URL(request.url).origin)return reply({error:'Request origin is not allowed.'},403);
 if(request.method==='DELETE'){await env.DB.batch([env.DB.prepare('DELETE FROM amazon_accounts WHERE owner = ?').bind(owner),env.DB.prepare('DELETE FROM amazon_oauth_states WHERE owner = ?').bind(owner)]);return reply({connected:false});}
 if(request.method!=='POST')return reply({error:'Method not allowed.'},405);
 if(!configured())return reply({error:'Amazon linking needs a registered Login with Amazon app. Configure AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, and AMAZON_REDIRECT_URI.'},503);
 if(new URL(env.AMAZON_REDIRECT_URI!).origin!==new URL(request.url).origin)return reply({error:'The configured Amazon callback belongs to a different Site.'},503);
 const state=crypto.randomUUID(),verifier=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 await env.DB.batch([env.DB.prepare('DELETE FROM amazon_oauth_states WHERE expires_at < ? OR owner = ?').bind(Date.now(),owner),env.DB.prepare('INSERT INTO amazon_oauth_states (state,owner,verifier,expires_at) VALUES (?,?,?,?)').bind(state,owner,verifier,Date.now()+600000)]);
 const response=reply({url:amazonAuthorizeURL(env.AMAZON_CLIENT_ID!,env.AMAZON_REDIRECT_URI!,state,await pkceChallenge(verifier))});response.headers.append('Set-Cookie',`aero_amazon_state=${state}; Path=/api/amazon; HttpOnly; SameSite=Lax; Max-Age=600${new URL(request.url).protocol==='https:'?'; Secure':''}`);return response;
 }catch{return reply({error:'Could not update the Amazon connection. Try again shortly.'},503);}
}
export async function amazonCallback(request:Request){
 const url=new URL(request.url);const {owner}=session(request);
 const finish=(status:string)=>new Response(null,{status:303,headers:{Location:new URL('/?amazon='+status,url.origin).href,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':`aero_amazon_state=; Path=/api/amazon; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol==='https:'?'; Secure':''}`}});
 try{if(!env.DB||!configured())return finish('setup');const state=url.searchParams.get('state'),cookie=request.headers.get('cookie')?.match(/(?:^|;\s*)aero_amazon_state=([a-f0-9-]{36})(?:;|$)/)?.[1];
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
