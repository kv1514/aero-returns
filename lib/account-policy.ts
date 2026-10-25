import {z} from 'zod';
export type AccountProvider='google'|'custom:amazon';
export function allowedProvider(value:unknown):value is AccountProvider{return value==='google'||value==='custom:amazon';}
export function accountOwner(id:string){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Error('Invalid account identity.');
  return `supabase:${id}`;
}
export function sameOrigin(request:Request){return request.headers.get('origin')===new URL(request.url).origin;}
export function authOutcome(search:string){
  const value=new URLSearchParams(search).get('auth');
  return value==='success'?'You’re signed in. This account has its own return history.':value==='cancelled'?'Sign-in was cancelled. Your demo is still available.':value==='failed'?'Sign-in did not complete. Please try again.':null;
}

// Email and password accounts (POST /api/account/password). Client-safe and pure, so the panel and tests share the rules.
// Messages are fixed strings: they never echo the email or password back.
export type PasswordMode='signup'|'signin';
export const PASSWORD_MIN=8,PASSWORD_MAX=72,EMAIL_MAX=254,PASSWORD_BODY_LIMIT=1000;
export const CONFIRM_EMAIL_MESSAGE='Check your email to confirm your account, then sign in.';
export const WRONG_CREDENTIALS='Email or password is incorrect.';
export const SIGNUP_FAILED='Could not create that account. Try signing in instead.';
export const TOO_MANY_ATTEMPTS='Too many attempts. Wait a minute and try again.';
export const EMAIL_UNAVAILABLE='Email sign-in is temporarily unavailable. Please retry.';
export const EMAIL_SETUP_NEEDED='Email sign-in still needs administrator setup. You can use the demo account now.';
const BAD_REQUEST='Invalid sign-in request.';
const ENTER_EMAIL='Enter your email address.',ENTER_PASSWORD='Enter your password.';
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const passwordRequest=z.object({
  mode:z.enum(['signup','signin'],{errorMap:()=>({message:'Choose Create account or Sign in.'})}),
  // Trimmed and lowercased before the checks, so " Alex@Example.com " and "alex@example.com" are one account.
  email:z.string({required_error:ENTER_EMAIL,invalid_type_error:ENTER_EMAIL}).trim().toLowerCase().min(1,ENTER_EMAIL).max(EMAIL_MAX,'That email address is too long.').email('Enter a valid email address.'),
  // 72 is Supabase's (bcrypt's) limit, counted in bytes, so accented letters and emoji count for more than one.
  password:z.string({required_error:ENTER_PASSWORD,invalid_type_error:ENTER_PASSWORD}).min(1,ENTER_PASSWORD).max(PASSWORD_MAX,`Use at most ${PASSWORD_MAX} characters for your password.`).refine(p=>bytes(p)<=PASSWORD_MAX,'That password is too long. Use fewer accented letters or emoji.'),
},{required_error:BAD_REQUEST,invalid_type_error:BAD_REQUEST})
  // Only a new password needs AERO's minimum. Sign-in takes any password Supabase may hold (its own minimum is 6, and
  // accounts made in the dashboard or another client follow that), so those accounts can still sign in here.
  .superRefine((value,ctx)=>{if(value.mode==='signup'&&value.password.length<PASSWORD_MIN)ctx.addIssue({code:z.ZodIssueCode.custom,path:['password'],message:`Use at least ${PASSWORD_MIN} characters for your password.`});});
export type PasswordRequest=z.infer<typeof passwordRequest>;
/** Validates an already-parsed body: one readable message for the first problem. */
export function checkPasswordRequest(value:unknown):{ok:true;value:PasswordRequest}|{ok:false;error:string}{
  const parsed=passwordRequest.safeParse(value);
  return parsed.success?{ok:true,value:parsed.data}:{ok:false,error:parsed.error.issues[0]?.message||BAD_REQUEST};
}
/** The route's whole input step: size cap (under 1000 bytes), JSON, then the schema. */
export function parsePasswordRequest(raw:string):{ok:true;value:PasswordRequest}|{ok:false;status:number;error:string}{
  if(bytes(raw)>=PASSWORD_BODY_LIMIT)return {ok:false,status:413,error:BAD_REQUEST};
  let body:unknown;try{body=JSON.parse(raw);}catch{return {ok:false,status:400,error:BAD_REQUEST};}
  const checked=checkPasswordRequest(body);
  return checked.ok?checked:{ok:false,status:400,error:checked.error};
}

/** The parts of a Supabase AuthError (or AuthWeakPasswordError) this mapping reads. */
export type AuthFailure={code?:string;status?:number;message?:string;reasons?:readonly string[]};
export type PasswordFailure={status:number;error:string;confirm?:true};
const andList=(items:string[])=>items.length<2?items.join(''):`${items.slice(0,-1).join(', ')} and ${items[items.length-1]}`;
/** Supabase lists required characters as raw alphabets; say them in words. */
function characterRule(message:string){
  const need:string[]=[];
  if(message.includes('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'))need.push('a letter');
  else{if(message.includes('abcdefghijklmnopqrstuvwxyz'))need.push('a lowercase letter');if(message.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'))need.push('an uppercase letter');}
  if(message.includes('0123456789'))need.push('a number');
  if(/[!@#$%^&*]/.test(message))need.push('a symbol');
  return need.length?`Include at least ${andList(need)}.`:'Mix letters, numbers and symbols.';
}
/** Supabase's weak-password reasons in plain words. */
export function weakPasswordMessage(failure:AuthFailure){
  const message=failure.message||'';
  const words=(failure.reasons||[]).map(reason=>{
    if(reason==='length'){const min=/at least (\d+) characters/i.exec(message)?.[1];return min?`Use at least ${min} characters.`:'Use a longer password.';}
    if(reason==='characters')return characterRule(message);
    if(reason==='pwned')return 'That password has appeared in a known data breach. Choose a different one.';
    return '';
  }).filter(Boolean);
  if(words.length)return `Choose a stronger password. ${[...new Set(words)].join(' ')}`;
  return message&&message.length<=200?message:'Choose a stronger password.';
}
export const EMAIL_NOT_USABLE='That email address can’t be used for an account. Try a different one.';
/** Project setup, not the person: the Email provider is off, CAPTCHA is on, or Supabase's built-in mailer refuses non-team addresses. */
const SETUP_CODES=new Set(['email_provider_disabled','captcha_failed','email_address_not_authorized']);
/**
 * One reply per Supabase failure. Sign-in never says whether an email has an account: every refusal is "Email or
 * password is incorrect." Sign-up gives every unexplained refusal (including "User already registered") one message,
 * but with "Confirm email" off a new address is signed in straight away, so there sign-up does show that an address
 * already has an account (Supabase cannot avoid that in that mode); with it on, Supabase answers both alike.
 * Outages and setup problems never pose as a wrong password or an existing account, and none depends on the address.
 */
export function passwordAuthError(mode:PasswordMode,failure:AuthFailure):PasswordFailure{
  const code=failure.code||'',status=failure.status;
  if(status===429||/^over_[a-z_]*rate_limit$/.test(code))return {status:429,error:TOO_MANY_ATTEMPTS};
  // No HTTP answer at all (network error, Supabase unreachable) or a Supabase server error: nothing about the account is known.
  if(!status||status>=500)return {status:503,error:EMAIL_UNAVAILABLE};
  // A 401/403/404 with no error code comes from the API gateway (wrong publishable key or URL), not from Auth.
  if(SETUP_CODES.has(code)||(!code&&(status===401||status===403||status===404)))return {status:503,error:EMAIL_SETUP_NEEDED};
  if(code==='email_not_confirmed')return {status:403,error:CONFIRM_EMAIL_MESSAGE,confirm:true};
  if(code==='weak_password')return {status:422,error:weakPasswordMessage(failure)};
  if(code==='email_address_invalid')return {status:400,error:EMAIL_NOT_USABLE};
  if(mode==='signup'){
    if(code==='signup_disabled')return {status:503,error:'Creating new accounts is turned off right now. If you already have one, sign in.'};
    return {status:400,error:SIGNUP_FAILED};
  }
  return {status:401,error:WRONG_CREDENTIALS};
}
