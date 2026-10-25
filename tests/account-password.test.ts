import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {checkPasswordRequest,parsePasswordRequest,passwordAuthError,weakPasswordMessage,CONFIRM_EMAIL_MESSAGE,SIGNUP_FAILED,TOO_MANY_ATTEMPTS,WRONG_CREDENTIALS,EMAIL_UNAVAILABLE,EMAIL_SETUP_NEEDED,EMAIL_NOT_USABLE} from '../lib/account-policy';
import AccountPanel,{AccountRecentReturns,EmailAccountForm} from '../components/account-panel';
import {createReturn,DEMO_PACKAGE} from '../lib/simulation';
import {readBody} from '../lib/http';

const body=(value:unknown)=>JSON.stringify(value);
const secret='correct horse battery';

test('email is trimmed and lowercased; the password is kept exactly as typed',()=>{
  const r=parsePasswordRequest(body({mode:'signup',email:'  Alex.Demo@Example.COM ',password:` ${secret} `}));
  assert.ok(r.ok);if(!r.ok)return;
  assert.deepEqual(r.value,{mode:'signup',email:'alex.demo@example.com',password:` ${secret} `});
  assert.ok(parsePasswordRequest(body({mode:'signup',email:'a@b.co',password:'12345678'})).ok,'8 characters is enough for a new password');
});

test('only a new password needs 8 characters: sign-in takes the shorter passwords Supabase itself allows',()=>{
  // Supabase's own minimum is 6, so accounts made in its dashboard or another client may have one.
  for(const password of ['123456','x'])assert.ok(parsePasswordRequest(body({mode:'signin',email:'a@b.co',password})).ok,password);
  const signup=parsePasswordRequest(body({mode:'signup',email:'a@b.co',password:'123456'}));
  assert.equal(signup.ok,false);if(!signup.ok)assert.match(signup.error,/at least 8/);
  for(const mode of ['signup','signin'] as const){
    const empty=checkPasswordRequest({mode,email:'a@b.co',password:''});
    assert.deepEqual(empty,{ok:false,error:'Enter your password.'},`${mode}: an empty password says so, not "at least 8"`);
    const long=checkPasswordRequest({mode,email:'a@b.co',password:'x'.repeat(73)});
    assert.equal(long.ok,false,`${mode}: 72 is Supabase's limit either way`);
  }
  // The first problem wins: a bad email comes before a short new password.
  assert.deepEqual(checkPasswordRequest({mode:'signup',email:'nope',password:'123'}),{ok:false,error:'Enter a valid email address.'});
});

test('invalid requests get one readable message that never echoes the email or password',()=>{
  const cases:[unknown,RegExp][]=[
    [{mode:'reset',email:'a@b.co',password:secret},/Choose Create account or Sign in/],
    [{mode:'signin',email:'not-an-email',password:secret},/valid email/],
    [{mode:'signin',email:'   ',password:secret},/Enter your email/],
    [{mode:'signin',email:`${'a'.repeat(250)}@b.co`,password:secret},/too long/],
    [{mode:'signup',email:'a@b.co',password:'short7!'},/at least 8/],
    [{mode:'signup',email:'a@b.co',password:'x'.repeat(73)},/at most 72/],
    [{mode:'signup',email:'a@b.co',password:'é'.repeat(40)},/too long/],
    [{mode:'signin',email:'a@b.co'},/Enter your password/],
    [{mode:'signin',email:42,password:secret},/Enter your email/],
    ['signin',/Invalid sign-in request/],
  ];
  for(const [value,message] of cases){
    const r=parsePasswordRequest(body(value));
    assert.equal(r.ok,false,JSON.stringify(value));if(r.ok)continue;
    assert.equal(r.status,400);assert.match(r.error,message);
    assert.doesNotMatch(r.error,/not-an-email|short7|correct horse|aaaa|éé/);
  }
  assert.deepEqual(parsePasswordRequest('{"mode":'),{ok:false,status:400,error:'Invalid sign-in request.'});
  assert.equal(checkPasswordRequest(null).ok,false);
});

test('a body of 1000 bytes or more is refused before parsing',()=>{
  const padded=(n:number)=>{const base=body({mode:'signin',email:'a@b.co',password:secret,pad:''});return body({mode:'signin',email:'a@b.co',password:secret,pad:'p'.repeat(n-base.length)});};
  assert.equal(padded(999).length,999);assert.ok(parsePasswordRequest(padded(999)).ok,'unknown keys are dropped');
  const r=parsePasswordRequest(padded(1000));assert.equal(r.ok,false);if(!r.ok)assert.equal(r.status,413);
  // Multi-byte text counts in bytes, not characters.
  const wide=parsePasswordRequest(body({mode:'signin',email:'a@b.co',password:secret,pad:'é'.repeat(480)}));assert.equal(wide.ok,false);
});

test('sign-in never says whether an email has an account',()=>{
  // Supabase answers an unknown email and a wrong password the same way; both, and any other refusal, read the same here.
  const unknownEmail=passwordAuthError('signin',{status:400,code:'invalid_credentials',message:'Invalid login credentials'});
  const wrongPassword=passwordAuthError('signin',{status:400,code:'invalid_credentials',message:'Invalid login credentials'});
  const notFound=passwordAuthError('signin',{status:404,code:'user_not_found',message:'User not found'});
  const banned=passwordAuthError('signin',{status:400,code:'user_banned',message:'User is banned'});
  const legacy=passwordAuthError('signin',{status:400,message:'Invalid login credentials'});
  for(const r of [unknownEmail,wrongPassword,notFound,banned,legacy])assert.deepEqual(r,{status:401,error:WRONG_CREDENTIALS});
});

test('sign-up for an email that already has an account looks like any other sign-up failure',()=>{
  const existing=[
    passwordAuthError('signup',{status:422,code:'user_already_exists',message:'User already registered'}),
    passwordAuthError('signup',{status:422,code:'email_exists',message:'Email address already exists'}),
    passwordAuthError('signup',{status:400,message:'User already registered'}),
  ];
  const other=[passwordAuthError('signup',{status:400,code:'validation_failed',message:'Unable to validate email address'})];
  for(const r of [...existing,...other]){assert.deepEqual(r,{status:400,error:SIGNUP_FAILED});assert.doesNotMatch(r.error,/already|exists|registered/i);}
});

test('outages and setup mistakes never pose as a wrong password or an existing account',()=>{
  for(const mode of ['signup','signin'] as const){
    // Supabase server errors, including a mailer that failed to send the confirmation email.
    for(const failure of [{status:500,code:'unexpected_failure',message:'Error sending confirmation email'},{status:502},{status:503},{status:504,message:'Gateway Timeout'}])
      assert.deepEqual(passwordAuthError(mode,failure),{status:503,error:EMAIL_UNAVAILABLE},`${mode} ${failure.status}`);
    // Project setup: CAPTCHA on, built-in mailer refusing a non-team address, a wrong publishable key or URL (gateway errors carry no code).
    for(const failure of [{status:400,code:'captcha_failed',message:'captcha protection: request disallowed'},{status:400,code:'email_address_not_authorized',message:'Email address "a@b.co" cannot be used as it is not authorized'},{status:401,message:'Invalid API key'},{status:403,message:'Forbidden'},{status:404,message:'Not found'},{status:400,code:'email_provider_disabled'}])
      assert.deepEqual(passwordAuthError(mode,failure),{status:503,error:EMAIL_SETUP_NEEDED},`${mode} ${failure.code||failure.status}`);
    assert.deepEqual(passwordAuthError(mode,{status:400,code:'email_address_invalid',message:'Email address "a@example.com" is invalid'}),{status:400,error:EMAIL_NOT_USABLE});
  }
  for(const r of [EMAIL_UNAVAILABLE,EMAIL_SETUP_NEEDED,EMAIL_NOT_USABLE]){assert.notEqual(r,WRONG_CREDENTIALS);assert.notEqual(r,SIGNUP_FAILED);}
  // An Auth refusal with a code is still about the account, not setup.
  assert.deepEqual(passwordAuthError('signin',{status:404,code:'user_not_found'}),{status:401,error:WRONG_CREDENTIALS});
});

test('rate limits, unconfirmed email, outages and setup each get their own plain message',()=>{
  for(const code of ['over_request_rate_limit','over_email_send_rate_limit','over_sms_send_rate_limit'])for(const mode of ['signup','signin'] as const)
    assert.deepEqual(passwordAuthError(mode,{status:429,code}),{status:429,error:TOO_MANY_ATTEMPTS});
  assert.equal(passwordAuthError('signin',{status:429}).error,TOO_MANY_ATTEMPTS);
  assert.deepEqual(passwordAuthError('signin',{status:400,code:'email_not_confirmed',message:'Email not confirmed'}),{status:403,error:CONFIRM_EMAIL_MESSAGE,confirm:true});
  assert.equal(CONFIRM_EMAIL_MESSAGE,'Check your email to confirm your account, then sign in.');
  for(const mode of ['signup','signin'] as const){
    assert.deepEqual(passwordAuthError(mode,{status:0,message:'fetch failed'}),{status:503,error:EMAIL_UNAVAILABLE},'no HTTP answer');
    assert.deepEqual(passwordAuthError(mode,{message:'TypeError'}),{status:503,error:EMAIL_UNAVAILABLE});
    assert.equal(passwordAuthError(mode,{status:400,code:'email_provider_disabled'}).status,503);
  }
  assert.deepEqual(passwordAuthError('signin',{status:502}),{status:503,error:EMAIL_UNAVAILABLE});
  assert.equal(passwordAuthError('signup',{status:422,code:'signup_disabled'}).status,503);
});

test('a weak password gets Supabase’s reason in plain words',()=>{
  const length=passwordAuthError('signup',{status:422,code:'weak_password',message:'Password should be at least 10 characters.',reasons:['length']});
  assert.deepEqual(length,{status:422,error:'Choose a stronger password. Use at least 10 characters.'});
  assert.equal(weakPasswordMessage({message:'Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, ABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789, !@#$%^&*()_+-=[]{};\':"|<>?,./`~.',reasons:['characters']}),'Choose a stronger password. Include at least a lowercase letter, an uppercase letter, a number and a symbol.');
  assert.equal(weakPasswordMessage({message:'Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789',reasons:['characters']}),'Choose a stronger password. Include at least a letter and a number.');
  assert.match(weakPasswordMessage({message:'Password is known to be weak and easy to guess, please choose a different one.',reasons:['pwned']}),/known data breach/);
  assert.equal(weakPasswordMessage({message:'Password should be at least 6 characters.'}),'Password should be at least 6 characters.','no reasons: Supabase’s own words');
  assert.equal(weakPasswordMessage({}),'Choose a stronger password.');
});

const render=(mode?:'signup'|'signin')=>renderToStaticMarkup(createElement(EmailAccountForm,{initialMode:mode,onSignedIn:()=>{}}));
test('the email form has labelled fields with the right autocomplete for each mode',()=>{
  const signup=render('signup'),signin=render('signin');
  assert.match(signup,/<label class="account-field" for="account-email">Email<\/label><input id="account-email"[^>]*type="email"[^>]*autoComplete="email"/);
  assert.match(signup,/<label class="account-field" for="account-password">Password<\/label>/);
  assert.match(signup,/id="account-password" type="password"[^>]*autoComplete="new-password"[^>]*minLength="8" maxLength="72"/);
  assert.match(signin,/id="account-password" type="password"[^>]*autoComplete="current-password"/);
  assert.doesNotMatch(signin,/minLength/,'sign-in sets no minimum length on the field');
  assert.match(signup,/aria-label="Show password"/);assert.match(signup,/aria-controls="account-password"/);
  assert.match(signup,/<button type="button" aria-pressed="true"[^>]*>Create account<\/button><button type="button" aria-pressed="false"[^>]*>Sign in<\/button>/);
  assert.match(signin,/aria-pressed="false"[^>]*>Create account<\/button><button type="button" aria-pressed="true"/);
  assert.match(signup,/<button type="submit" class="primary full">.*Create account<\/button>/);
  assert.match(signin,/<button type="submit" class="primary full">.*Sign in<\/button>/);
  assert.match(signup,/role="status"/,'the confirmation notice has a live region from the start');
  assert.match(signup,/Accounts are stored with Supabase/);assert.match(signup,/Returns you request stay tied to this account in AERO\./);
  assert.match(render(),/autoComplete="new-password"/,'Create account is the default');
});

test('a signed-in account lists its five newest returns with date, reference and status, each a plain link',()=>{
  const t0=Date.UTC(2026,9,20,18);
  const list=Array.from({length:7},(_,i)=>({...createReturn({...DEMO_PACKAGE,returnReference:i===6?'AMZ-REF-6':undefined},`id-${i}`,t0+i*86400000)}));
  const html=renderToStaticMarkup(createElement(AccountRecentReturns,{returns:list,now:t0+7*86400000,onOpen:()=>{}}));
  const ids=[...html.matchAll(/href="\/track\/([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(ids,['id-6','id-5','id-4','id-3','id-2'],'newest first, at most five');
  assert.match(html,/<h4 id="account-recent-title">Recent returns<\/h4>/);
  assert.match(html,/Amazon return<\/strong><small>[^<]+ · AMZ-REF-6<\/small>/);
  assert.match(html,/class="history-status">(Delivered|In progress|Cancelled)</);
  assert.match(renderToStaticMarkup(createElement(AccountRecentReturns,{returns:[],now:t0,onOpen:()=>{}})),/No returns on this account yet/);
  // A failed refresh is not an empty account.
  const failed=renderToStaticMarkup(createElement(AccountRecentReturns,{returns:[],now:t0,onOpen:()=>{},failed:true}));
  assert.match(failed,/role="alert">Could not load this account’s returns/);assert.doesNotMatch(failed,/No returns on this account yet/);
  assert.match(renderToStaticMarkup(createElement(AccountRecentReturns,{returns:list,now:t0,onOpen:()=>{},failed:true})),/href="\/track\/id-6"/,'returns already loaded still show');
});

test('before the account settings load, the panel names no sign-in option it may not have',()=>{
  // useEffect does not run here, so this is the panel as it first paints, before GET /api/account answers.
  const html=renderToStaticMarkup(createElement(AccountPanel,{onHistory:()=>{},returns:[],now:0,onOpen:()=>{}}));
  assert.match(html,/Loading account options/);
  assert.doesNotMatch(html,/Continue with Google|with Google|email account/);
  assert.match(html,/Try the built-in demo account, or sign in to keep your own return history\./);
});

test('a body is read only up to its cap, with or without a Content-Length',async()=>{
  const post=(body:BodyInit,headers:Record<string,string>={})=>new Request('http://aero.test/api/account/password',{method:'POST',body,headers,duplex:'half'} as RequestInit);
  assert.equal(await readBody(post('{"mode":"signin"}'),1000),'{"mode":"signin"}');
  assert.equal(await readBody(post('x'.repeat(1000)),1000),null,'1000 bytes is over');
  assert.equal(await readBody(post('é'.repeat(500)),1000),null,'counted in bytes');
  assert.equal(await readBody(new Request('http://aero.test/',{method:'POST'}),1000),'');
  // Chunked: no Content-Length, so only the reader can stop it. It must not pull the whole 5 MB.
  let pulled=0;
  const stream=new ReadableStream<Uint8Array>({pull(controller){pulled++;if(pulled>5000)controller.close();else controller.enqueue(new Uint8Array(1024).fill(120));}});
  const chunked=post(stream);assert.equal(chunked.headers.get('content-length'),null);
  assert.equal(await readBody(chunked,1000),null);
  assert.ok(pulled<5,`stopped after ${pulled} chunks`);
  // A declared length over the cap is refused without reading at all.
  let touched=false;
  const declared=post(new ReadableStream({pull(){touched=true;}},{highWaterMark:0}),{'content-length':'5000000'});
  assert.equal(await readBody(declared,1000),null);assert.equal(touched,false);
});

test('the password route keeps responses private, never logs, and uses no privileged key',()=>{
  const route=readFileSync(new URL('../app/api/account/password/route.ts',import.meta.url),'utf8');
  assert.match(route,/'Cache-Control':'private, no-store'/);
  assert.doesNotMatch(route,/console\./);
  assert.doesNotMatch(route,/service[_-]?role|SECRET_KEY|SUPABASE_SECRET/i);
  assert.match(route,/sameOrigin\(request\)/);
  assert.match(route,/unsupported\('POST'\)/);
  // Bounded read, Retry-After on 429, and a failed verification removes the session it just wrote.
  assert.match(route,/readBody\(request,PASSWORD_BODY_LIMIT\)/);assert.doesNotMatch(route,/request\.text\(\)/);
  assert.match(route,/'Retry-After':'60'/);
  assert.match(route,/verifyAccountUser\([^\n]*catch\{restoreVerifiers\(\);await clearAccountSession\(\);return reply\(\{error:NOT_COMPLETED\},502\)/);
  const start=readFileSync(new URL('../app/api/account/start/route.ts',import.meta.url),'utf8');
  assert.match(start,/readBody\(request,201\)/);assert.doesNotMatch(start,/request\.text\(\)/);
});
