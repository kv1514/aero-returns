import {sameOrigin} from '@/lib/account-policy';
import {DEMO_ID_COOKIE,DEMO_MODE_COOKIE,demoToken,demoCookie,exitDemoCookie} from '@/lib/demo-account';
import {unsupported} from '@/lib/http';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  if(!sameOrigin(request))return Response.json({error:'Start the demo from AERO.'},{status:403});
  const token=demoToken(request.headers.get('cookie'))||crypto.randomUUID();
  const response=Response.json({demo:true},{headers:{'Cache-Control':'private, no-store'}});
  response.headers.append('Set-Cookie',demoCookie(DEMO_ID_COOKIE,token,request));
  response.headers.append('Set-Cookie',demoCookie(DEMO_MODE_COOKIE,'1',request));
  return response;
}
export async function DELETE(request:Request){
  if(!sameOrigin(request))return Response.json({error:'Exit the demo from AERO.'},{status:403});
  return Response.json({demo:false},{headers:{'Cache-Control':'private, no-store','Set-Cookie':exitDemoCookie(request)}});
}
const no=unsupported('POST','DELETE');
export const GET=no,HEAD=no,PUT=no,PATCH=no,OPTIONS=no;
