import assert from 'node:assert/strict';
import { DEMO_PACKAGE, type ReturnRecord, type FlightState } from '../lib/simulation';
const base=process.argv[2]||process.env.AERO_TEST_URL||'http://127.0.0.1:5173';
let cookie='';
async function req(path:string,method='GET',data?:unknown,anonymous=false){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','Origin':base,...(!anonymous&&cookie?{Cookie:cookie}:{})},body:data?JSON.stringify(data):undefined});if(!cookie&&response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0];return {status:response.status,data:await response.json() as {record:ReturnRecord;returns:ReturnRecord[];telemetry:{state:FlightState};anthropic:boolean;error?:string}};}
await req('/api/returns');
const created=await req('/api/returns','POST',{...DEMO_PACKAGE,returnReference:'AMZ-SMOKE-RETURN'});assert.equal(created.status,201,JSON.stringify(created.data));
const id=created.data.record.id,path=`/api/returns/${id}`;
// The server assigns the nearest free simulated drone; a second active return gets a different one, and the browser cannot choose it.
assert.ok(created.data.record.drone?.name,'the server assigns a simulated drone');
const second=await req('/api/returns','POST',{...DEMO_PACKAGE,drone:{id:created.data.record.drone!.id,name:'Spoofed',base:[0,0],meters:0}});assert.equal(second.status,201,JSON.stringify(second.data));
assert.notEqual(second.data.record.drone?.id,created.data.record.drone?.id,'two active returns get different drones');assert.notEqual(second.data.record.drone?.name,'Spoofed','the browser cannot pick a drone');
assert.equal((await req(`/api/returns/${second.data.record.id}`,'PATCH',{action:'cancel'})).data.telemetry.state,'CANCELLED');
assert.equal((await req(path,'GET',undefined,true)).status,404,'another session cannot read a return');
assert.equal((await req(path,'PATCH',{action:'load'})).status,400,'premature load is blocked');
let response=await req(path,'PATCH',{action:'advance'});assert.equal(response.data.telemetry.state,'AWAITING_PACKAGE');
assert.equal((await req(path,'PATCH',{action:'advance'})).status,400,'advance cannot bypass loading');
response=await req(path,'PATCH',{action:'load'});assert.equal(response.data.telemetry.state,'PACKAGE_LOADED');
assert.equal((await req(path,'PATCH',{action:'cancel'})).status,400,'loaded flight cannot be cancelled');
await req(path,'PATCH',{action:'advance'});await req(path,'PATCH',{action:'advance'});response=await req(path,'PATCH',{action:'advance'});assert.equal(response.data.telemetry.state,'COMPLETED');
const restored=await req(path);assert.equal(restored.data.telemetry.state,'COMPLETED');assert.equal(restored.data.record.package.returnReference,'AMZ-SMOKE-RETURN');assert.ok(restored.data.record.events.some((e:{state:string})=>e.state==='COMPLETED'));
const history=await req('/api/returns');assert.ok(history.data.returns.some((r:{id:string})=>r.id===id));
assert.equal((await req('/api/returns','POST',{...DEMO_PACKAGE,weight:100})).status,400);
assert.equal((await req('/api/returns','POST',{...DEMO_PACKAGE,address:'   '})).status,400,'blank pickup addresses are blocked');
const raw=async(body:string)=>{const response=await fetch(base+'/api/returns',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:cookie},body});return {status:response.status,error:(await response.json() as {error?:string}).error};};
assert.deepEqual(await raw('null'),{status:400,error:'Send the request as a JSON object.'});
assert.deepEqual(await raw(JSON.stringify({...DEMO_PACKAGE,pickup:[-118.24,34.05]})),{status:400,error:'Pickup must be inside the Berkeley demo service area.'});
const integrations=await req('/api/integrations');assert.equal(integrations.status,200);assert.equal(typeof integrations.data.anthropic,'boolean');
console.log('PASS: booking → server-assigned nearest free drone → pickup wait → explicit load → delivery → persisted receipt; session isolation; payload validation with readable messages; integration status.');
