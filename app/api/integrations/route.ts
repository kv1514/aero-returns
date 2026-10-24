import { env } from 'cloudflare:workers';
import { integrations } from '@/lib/integration-server';
import { session } from '@/lib/server';
import { validCallback } from '@/lib/amazon-oauth';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const {owner,cookie}=session(request);let verified={anthropic:0,apify:0};
  if(env.DB){try{const rows=await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM integration_events WHERE owner = ? AND status = 'complete' GROUP BY kind").bind(owner).all<{kind:string;n:number}>();verified={anthropic:rows.results.find(r=>r.kind==='review')?.n||0,apify:rows.results.find(r=>r.kind==='lookup')?.n||0};}catch{}}
  return Response.json({...integrations(),verified,googleMaps:!!env.GOOGLE_MAPS_BROWSER_KEY,amazon:!!(env.AMAZON_CLIENT_ID&&env.AMAZON_CLIENT_SECRET&&env.AMAZON_REDIRECT_URI&&validCallback(env.AMAZON_REDIRECT_URI))},{headers:{'Cache-Control':'no-store',...(cookie?{'Set-Cookie':cookie}:{})}});
}
