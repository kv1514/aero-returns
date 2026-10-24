import assert from 'node:assert/strict';
import {DEMO_PACKAGE,type ReturnRecord,type FlightState} from '../lib/simulation';
type Result={record:ReturnRecord;telemetry:{state:FlightState};user:{name:string};demo:boolean;error?:string};
const base=process.env.AERO_TEST_URL||'http://127.0.0.1:5173';
const a=new Map<string,string>(),b=new Map<string,string>();
async function req(jar:Map<string,string>,path:string,method='GET',data?:unknown,origin=base){
  const r=await fetch(base+path,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:data===undefined?undefined:JSON.stringify(data)});
  for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),n=pair.indexOf('=');if(/Max-Age=0(?:;|$)/.test(c))jar.delete(pair.slice(0,n));else jar.set(pair.slice(0,n),pair.slice(n+1));}
  const resultData=r.headers.get('content-type')?.includes('application/json')?await r.json():{error:await r.text()};
  return {status:r.status,headers:r.headers,data:resultData as Result};
}
const original=await req(a,'/api/returns','POST',{...DEMO_PACKAGE,returnReference:'QA-ORIGINAL'});assert.equal(original.status,201);
for(const method of ['POST','DELETE'])assert.equal((await req(a,'/api/account/demo',method,undefined,'https://wrong.example')).status,403);
const entered=await req(a,'/api/account/demo','POST');assert.equal(entered.status,200);assert.match(entered.headers.get('cache-control')||'',/no-store/);
assert.equal((await req(a,'/api/account')).data.user.name,'Alex Demo');
assert.equal((await req(a,`/api/returns/${original.data.record.id}`)).status,404,'demo cannot read original account');
const made=await req(a,'/api/returns','POST',{...DEMO_PACKAGE,returnReference:'QA-DEMO-ACCOUNT'});assert.equal(made.status,201);const path=`/api/returns/${made.data.record.id}`;
await req(b,'/api/account/demo','POST');assert.notEqual(a.get('aero_demo_id'),b.get('aero_demo_id'));
assert.equal((await req(b,path)).status,404,'another demo browser cannot read a return');
assert.equal((await req(b,path,'PATCH',{action:'advance'})).status,404,'another demo browser cannot mutate a return');
assert.equal((await req(a,path,'PATCH',{action:'advance'})).data.telemetry.state,'AWAITING_PACKAGE');
assert.equal((await req(a,path,'PATCH',{action:'advance'})).status,400,'demo cannot bypass explicit loading');
assert.equal((await req(a,path,'PATCH',{action:'load'})).data.telemetry.state,'PACKAGE_LOADED');
await req(a,path,'PATCH',{action:'advance'});await req(a,path,'PATCH',{action:'advance'});
assert.equal((await req(a,path,'PATCH',{action:'advance'})).data.telemetry.state,'COMPLETED');
const token=a.get('aero_demo_id');await req(a,'/api/account/demo','DELETE');assert.equal(a.get('aero_demo_id'),token);assert.equal((await req(a,path)).status,404);
assert.equal((await req(a,`/api/returns/${original.data.record.id}`)).status,200,'exit restores original account');
await req(a,'/api/account/demo','POST');assert.equal(a.get('aero_demo_id'),token);assert.equal((await req(a,path)).data.telemetry.state,'COMPLETED','resume preserves history');
await req(a,'/api/account','DELETE');assert.equal((await req(a,'/api/account')).data.demo,false);
a.set('aero_demo_active','1');a.set('aero_demo_id','invalid');assert.equal((await req(a,'/api/returns')).status,401,'invalid active demo must not fall back');
assert.equal((await req(a,'/api/account','DELETE')).status,200,'invalid mode can be cleared');
console.log('PASS: demo entry, origin protection, original/demo/browser isolation, explicit loading, completed receipt state, exit, resume, and invalid-session recovery.');
