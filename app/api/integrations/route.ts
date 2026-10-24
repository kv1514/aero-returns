import { env } from 'cloudflare:workers';
import { integrations, sessionFailure } from '@/lib/integration-server';
import { session } from '@/lib/server';
import { amazonConfigured } from '@/lib/amazon-server';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const config={...integrations(),googleMaps:!!env.GOOGLE_MAPS_BROWSER_KEY,amazon:amazonConfigured(request)};
  // Provider configuration is not owner-scoped, so it is still reported when the session cannot be resolved.
  let identity:Awaited<ReturnType<typeof session>>;try{identity=await session(request);}catch{return sessionFailure(request,{...config,verified:{anthropic:0,apify:0}});}
  const {owner,cookie}=identity;let verified={anthropic:0,apify:0};
  if(env.DB){try{const rows=await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM integration_events WHERE owner = ? AND status = 'complete' GROUP BY kind").bind(owner).all<{kind:string;n:number}>();verified={anthropic:rows.results.find(r=>r.kind==='review')?.n||0,apify:rows.results.find(r=>r.kind==='lookup')?.n||0};}catch{}}
  return Response.json({...config,verified},{headers:{'Cache-Control':'no-store',...(cookie?{'Set-Cookie':cookie}:{})}});
}
