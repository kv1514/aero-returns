import {accountClient,accountConfig,clearAccountSession,verifierCheckpoint} from '@/lib/supabase-server';
import {verifyAccountUser} from '@/lib/verified-identity';
import {CONFIRM_EMAIL_MESSAGE,EMAIL_SETUP_NEEDED,EMAIL_UNAVAILABLE,PASSWORD_BODY_LIMIT,SIGNUP_FAILED,parsePasswordRequest,passwordAuthError,sameOrigin} from '@/lib/account-policy';
import {demoMode,exitDemoCookie} from '@/lib/demo-account';
import {readBody,unsupported} from '@/lib/http';
export const dynamic='force-dynamic';
const reply=(value:unknown,status=200,headers:Record<string,string>={})=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store',...headers}});
const NOT_COMPLETED='Sign-in did not complete. Please try again.';
// Email + password sign-up and sign-in through Supabase Auth. The body holds a password: never log it, echo it or store it.
// Supabase keeps the account; AERO keeps only the verified user ID as the owner of that account's returns (supabase:<uuid>).
export async function POST(request:Request){
  if(!sameOrigin(request))return reply({error:'Sign in from AERO.'},403);
  if(!accountConfig().email)return reply({error:EMAIL_SETUP_NEEDED},503);
  // Stops reading at the cap, so a body sent without a Content-Length is refused without being buffered whole.
  let raw:string|null;try{raw=await readBody(request,PASSWORD_BODY_LIMIT);}catch{return reply({error:'Invalid sign-in request.'},400);}
  if(raw===null)return reply({error:'Invalid sign-in request.'},413);
  const parsed=parsePasswordRequest(raw);if(!parsed.ok)return reply({error:parsed.error},parsed.status);
  const {mode,email,password}=parsed.value;
  try{
    const client=await accountClient();if(!client)return reply({error:EMAIL_SETUP_NEEDED},503);
    // Sign-up stores a PKCE verifier for a confirmation link. It stays only when a link was sent (the confirm reply below).
    const restoreVerifiers=mode==='signup'?await verifierCheckpoint():()=>{};
    // A confirmation link comes back through the same PKCE callback as Google, so it signs in only in this browser.
    const {data,error}=mode==='signup'
      ?await client.auth.signUp({email,password,options:{emailRedirectTo:new URL('/api/account/callback',request.url).href}})
      :await client.auth.signInWithPassword({email,password});
    if(error){
      restoreVerifiers();
      const failure=passwordAuthError(mode,error);
      return reply(failure.confirm?{confirm:true,message:failure.error}:{error:failure.error},failure.status,failure.status===429?{'Retry-After':'60'}:{});
    }
    if(!data.session){
      // "Confirm email" is on: Supabase sent a link (or, for an email that already has an account, answers the same way).
      if(mode==='signup'&&data.user)return reply({confirm:true,message:CONFIRM_EMAIL_MESSAGE});
      restoreVerifiers();
      return reply(mode==='signup'?{error:SIGNUP_FAILED}:{error:NOT_COMPLETED},mode==='signup'?400:502);
    }
    // Same check as the Google callback: the new session must verify with Supabase before AERO treats it as signed in.
    // The session cookies are already written by then, so a failed check removes them; "did not complete" stays true.
    try{await verifyAccountUser(()=>client.auth.getUser());}catch{restoreVerifiers();await clearAccountSession();return reply({error:NOT_COMPLETED},502);}
    restoreVerifiers();
    // An account sign-in always lands in that account, never behind an active demo profile (the demo history is kept).
    return reply({signedIn:true},200,demoMode(request.headers.get('cookie'))?{'Set-Cookie':exitDemoCookie(request)}:{});
  }catch{return reply({error:EMAIL_UNAVAILABLE},503);}
}
const no=unsupported('POST');
export const GET=no,HEAD=no,PUT=no,DELETE=no,PATCH=no,OPTIONS=no;
