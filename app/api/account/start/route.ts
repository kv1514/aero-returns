import {accountClient,accountConfig} from '@/lib/supabase-server';
import {allowedProvider,sameOrigin} from '@/lib/account-policy';
import {readBody,unsupported} from '@/lib/http';
export const dynamic='force-dynamic';
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
export async function POST(request:Request){
  if(!sameOrigin(request))return reply({error:'Start sign-in from AirCart.'},403);
  try{
    // Over 200 bytes is refused without reading the rest (a chunked body has no Content-Length to check first).
    const raw=await readBody(request,201);if(raw===null)return reply({error:'Invalid sign-in request.'},400);
    const provider=(JSON.parse(raw) as {provider?:unknown}).provider;
    if(!allowedProvider(provider))return reply({error:'Unsupported sign-in provider.'},400);
    const config=accountConfig();
    if(!(provider==='google'?config.google:config.amazon))return reply({error:'This sign-in provider still needs administrator setup.'},503);
    const client=await accountClient();if(!client)return reply({error:'Supabase setup is incomplete.'},503);
    const {data,error}=await client.auth.signInWithOAuth({provider,options:{redirectTo:new URL('/api/account/callback',request.url).href,skipBrowserRedirect:true,...(provider==='google'?{queryParams:{prompt:'select_account'}}:{})}});
    if(error||!data.url)return reply({error:'Could not start sign-in. Check the provider configuration.'},502);
    return reply({url:data.url});
  }catch{return reply({error:'Could not start sign-in. Please retry.'},400);}
}
const no=unsupported('POST');
export const GET=no,HEAD=no,PUT=no,DELETE=no,PATCH=no,OPTIONS=no;
