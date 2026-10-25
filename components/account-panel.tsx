'use client';
import {useEffect,useState,type FormEvent} from 'react';
import {ChevronRight,Eye,EyeOff,LogIn,LogOut,Mail,Package,Play,ShieldCheck} from 'lucide-react';
import {DRAFT_KEY} from '@/lib/booking-draft';
import {checkPasswordRequest,CONFIRM_EMAIL_MESSAGE,EMAIL_MAX,PASSWORD_MAX,PASSWORD_MIN,type PasswordMode} from '@/lib/account-policy';
import {recentReturns,returnStatus} from '@/lib/request-flow';
import type {ReturnRecord} from '@/lib/simulation';
type Account={configured:boolean;google:boolean;amazon:boolean;email?:boolean;demo?:boolean;user:{id:string;name:string;email:string}|null;sessionError?:boolean;error?:string};
/**
 * Up to five of this account's returns, newest first, from the GET /api/returns list the app already loaded for the signed-in
 * owner. `failed`: refreshing that list failed, so an empty list is not evidence that the account has no returns.
 */
export function AccountRecentReturns({returns,now,onOpen,failed=false}:{returns:ReturnRecord[];now:number;onOpen:(id:string)=>void;failed?:boolean}){
  const recent=recentReturns(returns,5);
  return <section className="account-recent" aria-labelledby="account-recent-title">
    <h4 id="account-recent-title">Recent returns</h4>
    {recent.length?<ul>{recent.map(r=><li key={r.id}><a href={`/track/${r.id}`} onClick={e=>{e.preventDefault();onOpen(r.id);}}>
      <span className="account-recent-icon"><Package size={18} aria-hidden="true"/></span>
      <span className="account-recent-text"><strong>{r.package.retailer} return</strong><small>{new Date(r.createdAt).toLocaleDateString()}{r.package.returnReference?` · ${r.package.returnReference}`:''}</small></span>
      <span className="history-status">{returnStatus(r,now)}</span><ChevronRight size={16} aria-hidden="true"/>
    </a></li>)}</ul>:failed?<p className="error-note" role="alert">Could not load this account’s returns. Close and reopen to retry.</p>:<p className="fine-print">No returns on this account yet. Request a drone and it shows up here.</p>}
  </section>;
}
/** Email + password sign-up and sign-in through Supabase (POST /api/account/password). The password lives only in this form's state until it is sent. */
export function EmailAccountForm({disabled=false,initialMode='signup',onBusyChange,onSignedIn}:{disabled?:boolean;initialMode?:PasswordMode;onBusyChange?:(busy:boolean)=>void;onSignedIn:()=>void}){
  const [mode,setMode]=useState<PasswordMode>(initialMode),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[show,setShow]=useState(false),[busy,setBusyState]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const signup=mode==='signup',locked=busy||disabled;
  function setBusy(value:boolean){setBusyState(value);onBusyChange?.(value);}
  function choose(next:PasswordMode){setMode(next);setError('');setNotice('');}
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(locked)return;
    // The same rules as the server, so a typo is explained here without a round trip.
    const checked=checkPasswordRequest({mode,email,password});
    if(!checked.ok){setError(checked.error);setNotice('');return;}
    setBusy(true);setError('');setNotice('');
    try{
      const r=await fetch('/api/account/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(checked.value)});
      const data=await r.json().catch(()=>({})) as {signedIn?:boolean;confirm?:boolean;message?:string;error?:string};
      if(data.confirm){setNotice(data.message||CONFIRM_EMAIL_MESSAGE);setMode('signin');setPassword('');setShow(false);setBusy(false);return;}
      if(!r.ok||!data.signedIn)throw new Error(data.error||'Sign-in did not complete. Please try again.');
      setPassword('');onSignedIn();
    }catch(e){setError(e instanceof TypeError?'Could not reach AirCart. Check your connection and try again.':(e as Error).message);setBusy(false);}
  }
  return <form className="account-email" noValidate aria-busy={busy} aria-labelledby="account-email-title" onSubmit={e=>void submit(e)}>
    <h4 id="account-email-title">{signup?'Create an AirCart account':'Sign in with email'}</h4>
    <div className="account-mode" role="group" aria-label="Email account">
      <button type="button" aria-pressed={signup} disabled={locked} onClick={()=>choose('signup')}>Create account</button>
      <button type="button" aria-pressed={!signup} disabled={locked} onClick={()=>choose('signin')}>Sign in</button>
    </div>
    <label className="account-field" htmlFor="account-email">Email</label>
    <input id="account-email" className="account-input" type="email" name="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} required maxLength={EMAIL_MAX} value={email} readOnly={busy} onChange={e=>setEmail(e.target.value)}/>
    <label className="account-field" htmlFor="account-password">Password</label>
    <div className="account-password">
      <input id="account-password" type={show?'text':'password'} name="password" autoComplete={signup?'new-password':'current-password'} autoCapitalize="none" spellCheck={false} required minLength={signup?PASSWORD_MIN:undefined} maxLength={PASSWORD_MAX} value={password} readOnly={busy} aria-describedby={signup?'account-password-hint':undefined} onChange={e=>setPassword(e.target.value)}/>
      <button type="button" aria-controls="account-password" aria-label={show?'Hide password':'Show password'} onClick={()=>setShow(s=>!s)}>{show?<EyeOff size={17} aria-hidden="true"/>:<Eye size={17} aria-hidden="true"/>}<span aria-hidden="true">{show?'Hide':'Show'}</span></button>
    </div>
    {signup&&<p id="account-password-hint" className="account-hint">At least {PASSWORD_MIN} characters.</p>}
    <button type="submit" className="primary full" disabled={locked}><Mail size={17} aria-hidden="true"/>{busy?(signup?'Creating account…':'Signing in…'):(signup?'Create account':'Sign in')}</button>
    <div role="status" className="account-live">{notice&&<p className="account-notice">{notice}</p>}</div>
    {error&&<p className="error-note" role="alert">{error}</p>}
    <p className="fine-print">Accounts are stored with Supabase, AirCart’s sign-in service (your email and a hashed password). Returns you request stay tied to this account in AirCart.</p>
  </form>;
}
export default function AccountPanel({onHistory,returns,now,onOpen,returnsFailed=false}:{onHistory:()=>void;returns:ReturnRecord[];now:number;onOpen:(id:string)=>void;returnsFailed?:boolean}){
  const [account,setAccount]=useState<Account|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let active=true;fetch('/api/account').then(r=>r.json() as Promise<Account>).then(a=>{if(active)setAccount(a);}).catch(()=>{if(active)setError('Could not load account settings. Close and reopen to retry.');});return()=>{active=false;};},[]);
  function reloadAccount(){
    try{sessionStorage.removeItem(DRAFT_KEY);}catch{}
    try{const c=new BroadcastChannel('aero-returns');c.postMessage({authChanged:true});c.close();}catch{}
    location.assign('/');
  }
  async function demo(start:boolean){
    setBusy('demo');setError('');
    try{const r=await fetch('/api/account/demo',{method:start?'POST':'DELETE'});if(!r.ok)throw new Error('Could not switch demo accounts. Please retry.');reloadAccount();}
    catch(e){setError((e as Error).message);setBusy('');}
  }
  async function signIn(provider:'google'|'custom:amazon'){
    setBusy(provider);setError('');try{const r=await fetch('/api/account/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider})});const data=await r.json() as {url?:string;error?:string};if(!r.ok||!data.url)throw new Error(data.error||'Sign-in could not start.');location.assign(data.url);}catch(e){setError((e as Error).message);setBusy('');}
  }
  async function signOut(){setBusy('out');setError('');try{const r=await fetch('/api/account',{method:'DELETE'});if(!r.ok)throw new Error('Sign-out did not complete. Please retry.');reloadAccount();}catch(e){setError((e as Error).message);setBusy('');}}
  // Lands where the Google callback does: /?auth=success clears booking drafts, reloads other tabs and confirms the sign-in.
  function emailSignedIn(){location.assign('/?auth=success');}
  const first=account?.user&&account.user.name&&account.user.name!==account.user.email?account.user.name.split(' ')[0]:'';
  // Until the settings arrive nothing names a sign-in option, so no Google copy or button shows and then vanishes.
  const intro=!account?'Try the built-in demo account, or sign in to keep your own return history.':account.email?`Try the built-in demo account, or use an email account${account.google?' or Google':''} to keep your own return history.`:'Try the built-in demo account, or sign in with Google to keep your own return history.';
  return <div className="detail-content account-panel">
    <span className="account-symbol"><ShieldCheck size={30}/></span>
    <h3>{account?.demo?'Meet Alex, your demo account.':account?.user?(first?`Welcome, ${first}`:'You’re signed in.'):'Your returns, in one place.'}</h3>
    <p className="body-copy">{account?.demo?'Try a complete return with Alex Demo. No password, retailer account, real flight, or payment required.':account?.user?'Your account is connected. Your saved returns stay with this account.':intro}</p>
    {!account&&!error&&<p role="status">Loading account options…</p>}
    {account?.demo?<>
      <span className="status-pill">Demo account · Alex Demo</span>
      <p className="fine-print">Practice history belongs to this browser. Exit to return to your previous account; choose Try demo account again to resume. This is a simulated profile, not a Google or Amazon login.</p>
      <button className="primary full" onClick={onHistory}>View demo returns</button>
      <button className="secondary full" disabled={!!busy} onClick={()=>void demo(false)}><LogOut size={17}/>{busy?'Leaving demo…':'Exit demo account'}</button>
    </>:<>
      <button className={account?.user?'secondary full':'primary full'} disabled={!!busy} onClick={()=>void demo(true)}><Play size={17}/>{busy==='demo'?'Opening demo…':'Try demo account'}</button>
      <p className="fine-print">Alex Demo · One click, no sign-up. Separate practice history for this browser.</p>
      {account?.user?<>
        <p className="account-signed-in">Signed in as <strong>{account.user.email||account.user.name}</strong></p>
        <AccountRecentReturns returns={returns} now={now} onOpen={onOpen} failed={returnsFailed}/>
        <button className="primary full" onClick={onHistory}>View your returns</button>
        <button className="secondary full" disabled={!!busy} onClick={()=>void signOut()}><LogOut size={17}/>{busy==='out'?'Signing out…':'Sign out of AirCart'}</button>
      </>:<>
        {account?.email&&<>
          <p className="account-divider"><span>or use an email account</span></p>
          <EmailAccountForm disabled={!!busy&&busy!=='email'} onBusyChange={b=>setBusy(b?'email':'')} onSignedIn={emailSignedIn}/>
        </>}
        {account&&(account.google||!account.email)&&<button className="secondary full" disabled={!!busy||!account?.google} onClick={()=>void signIn('google')}><LogIn size={17}/>{busy==='google'?'Opening Google…':'Continue with Google'}</button>}
        {account&&!account.google&&!account.email&&<p className="fine-print">Google sign-in needs provider setup.</p>}
        <button className="secondary full" disabled={!!busy||!account?.amazon} onClick={()=>void signIn('custom:amazon')}><LogIn size={17}/>{busy==='custom:amazon'?'Opening Amazon…':'Continue with Amazon'}</button>
        {account&&!account.amazon&&<p className="fine-print">Amazon sign-in is coming later. You can test returns with the demo account now.</p>}
        {account?.sessionError&&<button className="text-button" disabled={!!busy} onClick={()=>void signOut()}>Clear this account session</button>}
        <button className="text-button centered" onClick={onHistory}>Continue with your current history</button>
      </>}
    </>}
    {error&&<p className="error-note" role="alert">{error}</p>}
    {account?.error&&<p className="error-note" role="alert">{account.error}</p>}
    <p className="fine-print">Signing in does not import purchases from Amazon or anywhere else, create retailer returns, or authorize refunds. Switching accounts keeps each return history separate.</p>
    <p className="fine-print">Anyone with the link can use this demo. Each browser and signed-in account keeps its own return history.</p>
  </div>;
}
