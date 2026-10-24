import { env } from 'cloudflare:workers';
import {verifiedAccount} from './supabase-server';
import {demoIdentity} from './demo-account';
/** Resolves the owner that scopes every stored return, drone and linked account. */
export async function session(request: Request) {
  const demo=demoIdentity(request.headers.get('cookie'));
  if(demo)return {...demo,cookie:''};
  const account=await verifiedAccount();
  if(account)return {owner:account.owner,cookie:''};
  // Only the ChatGPT Sites proxy sets this header. On a public Worker any client could send it, so it is ignored unless explicitly enabled.
  const user = env.AERO_TRUST_SITES_IDENTITY === 'true' ? request.headers.get('oai-authenticated-user-id') : null;
  if (user) return { owner: `user:${user}`, cookie: '' };
  const cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)aero_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
  const token = cookie || crypto.randomUUID();
  return { owner: `guest:${token}`, cookie: cookie ? '' : `aero_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}` };
}
