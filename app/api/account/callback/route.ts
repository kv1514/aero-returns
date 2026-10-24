import {accountClient} from '@/lib/supabase-server';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const url=new URL(request.url);
  const finish=(outcome:string)=>new Response(null,{status:303,headers:{Location:new URL(`/?auth=${outcome}`,url.origin).href,'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
  if(url.searchParams.has('error'))return finish('cancelled');
  const code=url.searchParams.get('code');if(!code||code.length>4096)return finish('failed');
  try{const client=await accountClient();if(!client)return finish('failed');
    const {error}=await client.auth.exchangeCodeForSession(code);if(error)return finish('failed');
    const verified=await client.auth.getUser();return finish(verified.error||!verified.data.user?'failed':'success');
  }catch{return finish('failed');}
}
