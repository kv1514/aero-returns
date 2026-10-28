import {grantViewer,liveSync} from '@/lib/spacetime-server';
import {grantReply,parseGrant,publicSync} from '@/lib/spacetime-sync';
import {sameOrigin} from '@/lib/account-policy';
import {session} from '@/lib/session';
import {readBody,sessionFailure,unsupported} from '@/lib/http';
export const dynamic='force-dynamic';
const reply=(value:unknown,status=200,cookie='')=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store',...(cookie?{'Set-Cookie':cookie}:{})}});
// Where the browser's SpacetimeDB client connects (docs/SPACETIMEDB.md). The Worker's own token never leaves the server.
export function GET(){return reply(publicSync(liveSync()));}
// The browser proves it holds its SpacetimeDB identity's token; the Worker then lets that identity see this session's own rows,
// or revokes it (409) when it was granted to another account in this browser. The token is checked once and never stored, logged or echoed.
export async function POST(request:Request){
  if(!sameOrigin(request))return reply({error:'Request origin is not allowed.'},403);
  const cfg=liveSync();if(!cfg)return reply({error:'Live sync is not configured.'},503);
  let raw:string|null;try{raw=await readBody(request,4096);}catch{return reply({error:'Invalid request.'},400);}
  if(raw===null)return reply({error:'Request is too large.'},413);
  const input=parseGrant(raw);if(!input)return reply({error:'Invalid request.'},400);
  let identity:Awaited<ReturnType<typeof session>>;
  try{identity=await session(request);}catch{return sessionFailure(request);}
  const {status,body}=grantReply(await grantViewer(cfg,identity.owner,input.identity,input.token,input.account));
  return reply(body,status,identity.cookie);
}
const no=unsupported('GET','POST');
export const PUT=no,DELETE=no,PATCH=no,OPTIONS=no;
