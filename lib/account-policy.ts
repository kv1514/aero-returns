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
