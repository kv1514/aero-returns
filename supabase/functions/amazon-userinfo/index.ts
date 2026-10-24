// Public OAuth userinfo adapter. Supabase Auth calls this with the Amazon access
// token it obtained through the authorization-code exchange, never a Supabase JWT.
// Deploy with verify_jwt=false. No admin/service-role key is required.
type AmazonProfile={user_id?:unknown;name?:unknown};
Deno.serve(async(request:Request)=>{
  const headers={'Cache-Control':'no-store','Content-Type':'application/json'};
  if(request.method!=='GET')return new Response('{}',{status:405,headers});
  const authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer ')||authorization.length>8192)return new Response('{}',{status:401,headers});
  try{
    const result=await fetch('https://api.amazon.com/user/profile',{headers:{Authorization:authorization},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!result.ok)return new Response('{}',{status:401,headers});
    const profile=await result.json() as AmazonProfile;
    if(typeof profile.user_id!=='string'||!profile.user_id||profile.user_id.length>500)return new Response('{}',{status:502,headers});
    // Amazon has no email_verified claim. Omit email so Supabase cannot link to a
    // Google identity by an unverified address. Configure email_optional=true.
    return Response.json({sub:profile.user_id,name:typeof profile.name==='string'?profile.name.slice(0,300):'AERO member'},{headers});
  }catch{return new Response('{}',{status:502,headers});}
});
