import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ReturnCheck,{checkKey,isFresh,freshEventId,withService,sourceLabel,checkDetail,PERSON_NOTE,defaultDescription,checkProblem,checkPackage,parseAgentResponse,failureFor,whyNotEligible,packageReasons,personReasons,describeStep,stagesFor,type ReturnCheckResult} from '../components/return-check';
import {checkDroneEligibility,gateDecision,type AgentDecision} from '../lib/return-agent-shared';
import {fitWithin,encodePlan,base64Bytes,resizeImage,MAX_SIDE} from '../lib/image-resize';
import {DEMO_PACKAGE,type PackageInput} from '../lib/simulation';

const pkg:PackageInput={...DEMO_PACKAGE};
const decision:AgentDecision={verdict:'fly_standard',condition:'like_new',matchesDescription:true,confidence:.93,checks:[{label:'Drone limits (AERO rules)',ok:true,detail:'Fits Standard.'},{label:'Condition',ok:true,detail:'No visible damage.'}],questions:['Is the original charger included?'],disposition:'restock',explanation:'Looks like new headphones in the box.'};
const eligibility=checkDroneEligibility(pkg,{weightKg:pkg.weight,dimensionsCm:pkg.dimensions,fragile:false});
const response={source:'live Claude API',model:'claude-opus-5-5',decision,eligibility,steps:[{tool:'check_drone_eligibility',input:{weightKg:1.2,dimensionsCm:[28,20,12],fragile:false},output:eligibility}],eventId:'3f9a4c1e-2b7d-4e5f-9a1b-0c2d3e4f5a6b'};
const fresh=():ReturnCheckResult=>parseAgentResponse(response,checkKey(pkg),1)!;

test('a check goes stale when any package field it depends on changes, and only a fresh one is sent',()=>{
  const r=fresh();assert.equal(isFresh(r,pkg),true);assert.equal(freshEventId(r,pkg),response.eventId);
  for(const patch of [{weight:1.3},{dimensions:[28,20,13]},{fragile:true},{service:'priority'},{retailer:'Nike'},{method:'label'}] as Partial<PackageInput>[])
    {assert.equal(isFresh(r,{...pkg,...patch}),false,JSON.stringify(patch));assert.equal(freshEventId(r,{...pkg,...patch}),undefined);}
  // Pickup text and instructions do not change the drone-fit answer.
  assert.equal(isFresh(r,{...pkg,instructions:'Side gate',address:'1520 Addison Street, Berkeley'}),true);
  assert.equal(freshEventId({...r,evidenceChanged:true},pkg),undefined,'edited photos or description retire the result');
  assert.equal(freshEventId(null,pkg),undefined);
});
const checked=(p:PackageInput,d:AgentDecision=decision)=>{const e=checkDroneEligibility(p,{weightKg:p.weight,dimensionsCm:p.dimensions,fragile:p.fragile});return parseAgentResponse({...response,decision:gateDecision({...d},e),eligibility:e},checkKey(p),1)!;};
test('choosing a service, on the card or on "Your drone", keeps a fresh check when the limit check allows that tier',()=>{
  // Checked while Standard was selected: a 3.4 kg parcel only fits Priority, so the gate answers fly_priority.
  const heavy:PackageInput={...pkg,weight:3.4,dimensions:[40,30,20]},onPriority={...heavy,service:'priority' as const},r=checked(heavy);
  assert.equal(r.decision.verdict,'fly_priority');
  assert.equal(freshEventId(r,onPriority),undefined,'a bare service update would retire it');
  const switched=withService(r,heavy,'priority');assert.equal(freshEventId(switched,onPriority),r.eventId);
  assert.equal(freshEventId(withService(switched,onPriority,'standard'),heavy),undefined,'Standard is ruled out for this parcel');
  // A Standard-fit check stays attached when Priority is picked for speed, and when switching back.
  const s=fresh(),fast={...pkg,service:'priority' as const},sp=withService(s,pkg,'priority');
  assert.equal(freshEventId(sp,fast),s.eventId);assert.equal(freshEventId(withService(sp,fast,'standard'),pkg),s.eventId);
  // Stale, missing and not-eligible results are left as they are.
  const stale={...s,evidenceChanged:true};assert.equal(withService(stale,pkg,'priority'),stale);assert.equal(withService(null,pkg,'priority'),null);
  const tooBig:PackageInput={...pkg,weight:7,dimensions:[30,30,30]},no=checked(tooBig);
  assert.equal(no.decision.verdict,'not_drone_eligible');assert.equal(freshEventId(withService(no,tooBig,'priority'),{...tooBig,service:'priority'}),undefined);
});
test('the source label repeats what the server said and claims nothing when it said nothing',()=>{
  assert.equal(sourceLabel(fresh()),'Live Claude API · claude-opus-5-5');
  const bare=parseAgentResponse({...response,source:undefined,model:undefined},'k',1)!;
  assert.equal(bare.source,'');assert.equal(sourceLabel(bare),'Claude');
});
test('the limit check in "What was checked" shows the package reasons, not every hub',()=>{
  const no=checked({...pkg,weight:7,dimensions:[30,30,30]}),limit=no.decision.checks[0];
  assert.equal(limit.ok,false);assert.match(limit.detail,/Not enabled for drone handoff; /);
  assert.equal(checkDetail(limit),'Exceeds 5 kg payload limit');
  assert.equal(checkDetail(fresh().decision.checks[0]),'Fits Standard.');assert.equal(checkDetail({label:'Condition',ok:false,detail:'Scuffed; dented'}),'Scuffed; dented');
});
const render=(result:ReturnCheckResult|null,p=pkg)=>renderToStaticMarkup(createElement(ReturnCheck,{pkg:p,result,onResult:()=>{},onService:()=>{}}));
const text=(html:string)=>html.replace(/<[^>]+>/g,'');
test('field hints describe the fields instead of being read as part of their names',()=>{
  const html=render(null),labels=[...html.matchAll(/<label for="([^"]+)">([\s\S]*?)<\/label>/g)];
  assert.deepEqual(labels.map(m=>text(m[2])),['What are you returning?','Product page link (optional)']);
  for(const [,id] of labels){
    const field=new RegExp(`<(?:textarea|input)[^>]*id="${id}"[^>]*>`).exec(html)?.[0]||'',hint=/aria-describedby="([^"]+)"/.exec(field)?.[1];
    assert.ok(hint,`${id} has a description`);assert.match(html,new RegExp(`id="${hint}">[^<]{20,}`));
  }
});
test('result wording: shared needs-person line, honest storage and source notes, a readable stale result',()=>{
  const person=parseAgentResponse({...response,decision:{...decision,verdict:'needs_person',confidence:.6}},checkKey(pkg),1)!,html=render(person);
  assert.equal(PERSON_NOTE,'A person will review this return before the drone flies.');
  assert.ok(html.includes(PERSON_NOTE));assert.doesNotMatch(html,/confirm this return at pickup/);
  assert.ok(html.includes('AERO keeps the verdict and Claude’s short explanation, not your photos or description.'));
  assert.ok(html.includes('Live Claude API · claude-opus-5-5'));assert.ok(!render({...person,source:''}).includes('Live Claude API'));
  const stale=render({...person,evidenceChanged:true});assert.match(stale,/Details changed/);assert.doesNotMatch(stale,/\.stale[^{]*\{[^}]*opacity/,'stale text keeps full contrast');
});
test('a Priority verdict only says Standard is ruled out when the limit check ruled it out',()=>{
  const prefers=parseAgentResponse({...response,decision:{...decision,verdict:'fly_priority'}},checkKey(pkg),1)!;
  assert.match(render(prefers),/Standard also fits/);assert.doesNotMatch(render(prefers),/not Standard/);
  const heavy:PackageInput={...pkg,weight:3.4,dimensions:[40,30,20]};
  assert.match(render(checked(heavy),heavy),/fits AERO Priority, not Standard/);
});
test('the description prefill and client-side checks guide, but never invent, input',()=>{
  assert.equal(defaultDescription({...pkg,returnReference:' AMZ-1 '}),'Amazon return (reference AMZ-1). Item: ');
  assert.equal(defaultDescription({...pkg,returnReference:undefined,retailer:'Zara'}),'Zara return. Item: ');
  assert.match(checkProblem('ab','',pkg),/few words/);
  assert.match(checkProblem(defaultDescription(pkg),'',pkg),/what the item is/);
  assert.match(checkProblem('Wireless headphones, unopened','',{...pkg,address:' '}),/details above/);
  assert.match(checkProblem('Wireless headphones, unopened','',{...pkg,weight:25}),/20 kg/);
  assert.match(checkProblem('Wireless headphones, unopened','http://amazon.com/x',pkg),/HTTPS/);
  assert.match(checkProblem('Wireless headphones, unopened','https://example.com/x',pkg),/Amazon, Nike/);
  assert.equal(checkProblem('Wireless headphones, unopened','https://www.amazon.com/dp/B0',pkg),'');
  assert.equal(checkProblem('Wireless headphones, unopened','',pkg),'');
});
test('the request package carries no booking-only fields',()=>{
  const sent=checkPackage({...pkg,address:'  1820 Delaware Street ',returnReference:'  ',agentEventId:'x'});
  assert.equal('agentEventId' in sent,false);assert.equal('returnReference' in sent,false);assert.equal(sent.address,'1820 Delaware Street');
});
test('malformed or hostile answers are treated as no answer',()=>{
  assert.ok(fresh());
  assert.equal(parseAgentResponse(null,'k',1),null);
  assert.equal(parseAgentResponse({...response,eventId:''},'k',1),null);
  assert.equal(parseAgentResponse({...response,decision:{...decision,verdict:'toString'}},'k',1),null);
  assert.equal(parseAgentResponse({...response,decision:{...decision,disposition:'burn'}},'k',1),null);
  assert.equal(parseAgentResponse({...response,decision:{...decision,confidence:'high'}},'k',1),null);
  assert.equal(parseAgentResponse({...response,eligibility:{}},'k',1),null);
  const odd=parseAgentResponse({...response,steps:'nope',decision:{...decision,confidence:7,checks:[{label:'x',ok:'yes'},{}],questions:['ok',3,'']}},'k',1)!;
  assert.equal(odd.decision.confidence,1);assert.deepEqual(odd.decision.checks,[{label:'x',ok:false,detail:''}]);assert.deepEqual(odd.decision.questions,['ok']);assert.deepEqual(odd.steps,[]);
});
test('setup, rate-limit and other failures map to honest states',()=>{
  assert.deepEqual(failureFor(503,{error:'needs key',needsSetup:true}),{setup:true,message:''});
  assert.equal(failureFor(503,{error:'Usage storage is unavailable.'}).setup,false);
  assert.match(failureFor(429,{}).message,/per hour/);
  assert.equal(failureFor(429,{error:'The demo allows 12 sponsor API requests per hour'}).message,'The demo allows 12 sponsor API requests per hour');
  assert.match(failureFor(502,null).message,/optional/);
});
test('ineligible packages explain the package reasons per tier, not switched-off hubs',()=>{
  const heavy=checkDroneEligibility(pkg,{weightKg:7,dimensionsCm:[30,30,30],fragile:false});
  const why=whyNotEligible(heavy);assert.deepEqual(why.map(w=>w.tier),['Standard','Priority']);
  assert.ok(why.every(w=>w.reasons.length&&!w.reasons.includes('Not enabled for drone handoff')));
  assert.deepEqual(why[0].reasons,['Exceeds 2.5 kg payload limit']);assert.deepEqual(why[1].reasons,['Exceeds 5 kg payload limit'],'a smaller hub\'s 2.5 kg cap is not the Priority limit');assert.match(why[1].limits,/5 kg, 60 cm/);
  assert.deepEqual(packageReasons(['Not enabled for drone handoff','Each dimension must be ≤ 45 cm','Exceeds 2.5 kg payload limit','Each dimension must be ≤ 60 cm']),['Exceeds 2.5 kg payload limit','Each dimension must be ≤ 60 cm']);
  assert.deepEqual(packageReasons(['Not enabled for drone handoff','Outside the demo service area']),['Outside the demo service area']);
  assert.deepEqual(packageReasons(['Not enabled for drone handoff']),['Not enabled for drone handoff']);
  assert.deepEqual(whyNotEligible(eligibility),[]);
  const mid=checkDroneEligibility(pkg,{weightKg:4,dimensionsCm:[30,30,30],fragile:false});
  assert.deepEqual(whyNotEligible(mid).map(w=>w.tier),['Standard']);
  // The server gate agrees: a fly_standard claim on a 4 kg parcel becomes Priority.
  assert.equal(gateDecision({...decision},mid).verdict,'fly_priority');
});
test('needs-person reasons follow the server gate thresholds',()=>{
  assert.match(personReasons({...decision,confidence:.6}).join(' '),/60% sure/);
  assert.match(personReasons({...decision,matchesDescription:false}).join(' '),/not match/);
  assert.match(personReasons({...decision,condition:'damaged'}).join(' '),/damaged/);
  assert.match(personReasons(decision).join(' '),/person decides/);
});
test('the trace describes measurements used and the result per tier in plain words',()=>{
  const heavy=checkDroneEligibility(pkg,{weightKg:3.4,dimensionsCm:[40,30,20],fragile:true});
  const v=describeStep({tool:'check_drone_eligibility',input:{weightKg:3.4,dimensionsCm:[40,30,20],fragile:true},output:heavy},pkg);
  assert.equal(v.title,'Checked AERO’s drone limits');assert.match(v.by,/Claude asked/);
  assert.deepEqual(v.used.slice(0,3),['3.4 kg','40 × 30 × 20 cm','fragile']);assert.match(v.used[3],/you entered 1.2 kg/);
  assert.match(v.results[0],/^Standard \(up to 2.5 kg, 45 cm\): ruled out · Exceeds 2.5 kg/);assert.match(v.results[1],/^Priority \(up to 5 kg, 60 cm\): fits · /);
  const server=describeStep({tool:'check_drone_eligibility',input:{weightKg:1.2,dimensionsCm:[28,20,12],fragile:false,by:'server'},output:eligibility},pkg);
  assert.match(server.by,/Claude skipped/);assert.equal(server.used.length,3);
  assert.match(describeStep({tool:'check_drone_eligibility',input:{weightKg:-1},output:{error:'Use a positive weight'}}).results[0],/Not run: Use a positive weight/);
  const look=describeStep({tool:'lookup_product_specs',input:{url:'https://www.amazon.com/dp/B0'},output:{available:true,title:'Headphones',weightKg:.25,dimensionsCm:null}});
  assert.equal(look.title,'Looked up the product page');assert.deepEqual(look.used,['www.amazon.com']);assert.deepEqual(look.results,['Headphones','Published weight 0.25 kg','Size not published']);
  assert.match(describeStep({tool:'lookup_product_specs',input:{url:'https://www.amazon.com/dp/B0'},output:{available:false,reason:'Blocked'}}).results[0],/Lookup failed: Blocked/);
  assert.equal(describeStep({tool:'mystery_tool',input:{a:1},output:{b:'two'}}).title,'Mystery tool');
});
test('progress stages are UI labels that reflect whether photos were added',()=>{
  assert.equal(stagesFor(2)[0],'Reading your photos…');assert.equal(stagesFor(0)[0],'Reading your description…');assert.equal(stagesFor(1).length,3);
});
test('photos scale down to fit 1600 px, never up, with a shrinking fallback plan',()=>{
  assert.deepEqual(fitWithin(4032,3024,MAX_SIDE),{width:1600,height:1200});
  assert.deepEqual(fitWithin(3024,4032,1600),{width:1200,height:1600});
  assert.deepEqual(fitWithin(800,600,1600),{width:800,height:600});
  assert.deepEqual(fitWithin(0,600,1600),{width:0,height:0});
  const plan=encodePlan();assert.equal(plan[0].side,1600);assert.ok(plan.every((p,i)=>i===0||p.side<=plan[i-1].side));
  assert.ok(encodePlan(1000).every(p=>p.side<=1000));assert.equal(new Set(encodePlan(1000).map(p=>`${p.side}/${p.quality}`)).size,encodePlan(1000).length);
  assert.equal(base64Bytes(Buffer.from('hello world').toString('base64')),11);assert.equal(base64Bytes(Buffer.from('abc').toString('base64')),3);
});
test('a photo is decoded once, released before smaller fallbacks are drawn from the first copy, and never upscaled',async()=>{
  // Fake canvas and bitmap: the encoded length grows with pixels and quality, so the size limit picks a fallback step.
  const g=globalThis as Record<string,unknown>,saved={document:g.document,createImageBitmap:g.createImageBitmap};
  const draws:{from:string;width:number;height:number;released:boolean}[]=[];let size={width:4000,height:3000},closed=0;
  class FakeCanvas{width=0;height=0;getContext(){return {fillStyle:'',imageSmoothingQuality:'',fillRect(){},drawImage:(src:unknown,_x:number,_y:number,width:number,height:number)=>{draws.push({from:src instanceof FakeCanvas?'copy':'decode',width,height,released:closed>0});}};}toDataURL(_type:string,q:number){return 'data:image/jpeg;base64,'+'A'.repeat(Math.round(this.width*this.height*q/100));}}
  g.document={createElement:()=>new FakeCanvas()};g.createImageBitmap=async()=>({...size,close:()=>{closed++;}});
  try{
    const photo=new Blob([new Uint8Array(8)],{type:'image/jpeg'});
    const out=await resizeImage(photo,{maxBase64:6000});
    assert.deepEqual([out.width,out.height],[1024,768]);assert.equal(closed,1);
    assert.deepEqual(draws,[{from:'decode',width:1600,height:1200,released:false},{from:'copy',width:1280,height:960,released:true},{from:'copy',width:1024,height:768,released:true}],'the second 1600 px step re-encodes the first copy without redrawing');
    draws.length=0;closed=0;size={width:800,height:600};
    await assert.rejects(resizeImage(photo,{maxBase64:10}),/too detailed/);
    assert.equal(closed,1);assert.deepEqual(draws.map(d=>[d.width,d.height]),[[800,600]],'a small photo is never drawn larger');
  }finally{g.document=saved.document;g.createImageBitmap=saved.createImageBitmap;if(saved.document===undefined)delete g.document;if(saved.createImageBitmap===undefined)delete g.createImageBitmap;}
});
