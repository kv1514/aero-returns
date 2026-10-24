'use client';
import {useEffect,useState} from 'react';
import {LogIn,LogOut,Play,ShieldCheck} from 'lucide-react';
import {DRAFT_KEY} from '@/lib/booking-draft';
type Account={configured:boolean;google:boolean;amazon:boolean;demo?:boolean;user:{id:string;name:string;email:string}|null;sessionError?:boolean;error?:string};
export default function AccountPanel({onHistory}:{onHistory:()=>void}){
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
  return <div className="detail-content account-panel">
    <span className="account-symbol"><ShieldCheck size={30}/></span>
    <h3>{account?.demo?'Meet Alex, your demo account.':account?.user?`Welcome, ${account.user.name.split(' ')[0]}`:'Your returns, in one place.'}</h3>
    <p className="body-copy">{account?.demo?'Try a complete return with Alex Demo. No password, retailer account, real flight, or payment required.':account?.user?'Your account is connected. Your saved returns stay with this account.':'Try the built-in demo account, or sign in with Google to keep your own return history.'}</p>
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
        <p>{account.user.email}</p>
        <button className="primary full" onClick={onHistory}>View your returns</button>
        <button className="secondary full" disabled={!!busy} onClick={()=>void signOut()}><LogOut size={17}/>{busy==='out'?'Signing out…':'Sign out of AERO'}</button>
      </>:<>
        <button className="secondary full" disabled={!!busy||!account?.google} onClick={()=>void signIn('google')}><LogIn size={17}/>{busy==='google'?'Opening Google…':'Continue with Google'}</button>
        {account&&!account.google&&<p className="fine-print">Google sign-in needs provider setup.</p>}
        <button className="secondary full" disabled={!!busy||!account?.amazon} onClick={()=>void signIn('custom:amazon')}><LogIn size={17}/>{busy==='custom:amazon'?'Opening Amazon…':'Continue with Amazon'}</button>
        {account&&!account.amazon&&<p className="fine-print">Amazon sign-in is coming later. You can test returns with the demo account now.</p>}
        {account?.sessionError&&<button className="text-button" disabled={!!busy} onClick={()=>void signOut()}>Clear this account session</button>}
        <button className="text-button centered" onClick={onHistory}>Continue with your current history</button>
      </>}
    </>}
    {error&&<p className="error-note" role="alert">{error}</p>}
    {account?.error&&<p className="error-note" role="alert">{account.error}</p>}
    <p className="fine-print">Signing in does not import Amazon purchases, create retailer returns, or authorize refunds. Switching accounts keeps each return history separate.</p>
    <p className="fine-print">This hosted prototype is private. App accounts do not bypass the Site’s sharing controls.</p>
  </div>;
}
