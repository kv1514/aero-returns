import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, bearing, along, pathDistance, recommend, DEMO_PACKAGE, createReturn, snapshot, timing, control, settle } from '../lib/simulation';
import { parseReturnQR } from '../lib/qr';
const t0 = 1700000000000;
const seed = () => createReturn({...DEMO_PACKAGE}, 'test-return', t0);

test('Haversine distance agrees with one equatorial degree and bearing',()=>{
  assert.ok(Math.abs(distance([0,0],[1,0])-111194.9266)<.01);
  assert.equal(distance([1,1],[1,1]),0);assert.equal(bearing([0,0],[1,0]),90);
});
test('route interpolation follows traveled distance and clamps at endpoints',()=>{
  const path:[number,number][]=[[0,0],[.01,0],[.01,.01]],d=pathDistance(path);
  assert.deepEqual(along(path,0).point,[0,0]);assert.deepEqual(along(path,d+1).point,[.01,.01]);
  assert.ok(Math.abs(along(path,d/4).point[0]-.005)<1e-8);
});
test('facility selection excludes incompatible and nonparticipating sites',()=>{
  const ranked=recommend(DEMO_PACKAGE);assert.equal(ranked[0].id,'downtown');assert.equal(ranked[0].reason,null);
  assert.match(ranked.find(f=>f.id==='west')!.reason!,/label/);assert.match(ranked.find(f=>f.id==='retail')!.reason!,/Not enabled/);
  assert.ok(recommend({...DEMO_PACKAGE,weight:3}).every(f=>f.reason));
  assert.ok(recommend({...DEMO_PACKAGE,weight:3,service:'priority'}).some(f=>!f.reason));
  assert.ok(recommend({...DEMO_PACKAGE,dimensions:[61,20,10],service:'priority'}).every(f=>f.reason));
});
test('unsupported packages cannot create a booking',()=>{assert.throws(()=>createReturn({...DEMO_PACKAGE,weight:20},'x',t0),/No compatible/);});
test('full booking-to-handoff journey requires an explicit load confirmation',()=>{
  let r=seed();const t=timing(r);
  assert.equal(snapshot(r,t0).state,'ASSIGNED');assert.equal(snapshot(r,t0+4000).state,'PRE_FLIGHT');
  assert.equal(snapshot(r,t0+15000).state,'EN_ROUTE_TO_PICKUP');
  assert.throws(()=>control(r,'load',t0+15000),/Wait until/);
  const waitTime=t0+Math.ceil((t.pickup+4)*1000);
  r=settle(r,waitTime);assert.equal(snapshot(r,waitTime).state,'AWAITING_PACKAGE');
  assert.equal(snapshot(r,waitTime+86400000).state,'AWAITING_PACKAGE');
  assert.throws(()=>control(r,'advance',waitTime),/Confirm package/);
  r=control(r,'load',waitTime);assert.equal(snapshot(r,waitTime).state,'PACKAGE_LOADED');
  assert.equal(snapshot(r,waitTime+6000).state,'EN_ROUTE_TO_DROPOFF');
  r=settle(r,waitTime+Math.ceil((t.end-t.pickup)*1000));
  assert.equal(snapshot(r,waitTime+1000000).state,'COMPLETED');
  assert.ok(r.events.some(e=>e.state==='COMPLETED'));
  assert.equal(new Set(r.events.map(e=>e.state)).size,r.events.length);
  assert.ok(r.events.every((e,i)=>!i||e.at>=r.events[i-1].at));
});
test('pause, acceleration, resume and serialization preserve position without jumps',()=>{
  let r=seed();const at=t0+30000,before=snapshot(r,at);
  r=control(r,'pause',at);assert.deepEqual(snapshot(r,at+60000).point,before.point);
  r=control(r,'speed',at+60000,10);assert.deepEqual(snapshot(r,at+60000).point,before.point);
  r=control(r,'resume',at+60000);assert.equal(snapshot(r,at+61000).elapsed,before.elapsed+10);
  assert.deepEqual(snapshot(JSON.parse(JSON.stringify(r)),at+61000),snapshot(r,at+61000));
});
test('battery declines with progress; landing has zero ground speed and altitude',()=>{
  const r=seed();assert.ok(snapshot(r,t0+30000).battery<snapshot(r,t0+20000).battery);
  const s=snapshot(r,t0+10000000);assert.equal(s.speed,0);assert.equal(s.altitude,0);
});
test('cancellation and interruption are persistent, and loaded cancellation is rejected',()=>{
  const cancelled=control(seed(),'cancel',t0+20000);assert.equal(snapshot(cancelled,t0+100000).state,'CANCELLED');
  let r=control(seed(),'fail',t0+20000);assert.deepEqual(snapshot(r,t0+20000).point,snapshot(r,t0+100000).point);
  r=control(r,'retry',t0+100000);assert.equal(snapshot(r,t0+100000).state,'EN_ROUTE_TO_PICKUP');
  r=control(r,'advance',t0+100000);r=control(r,'load',t0+100000);assert.throws(()=>control(r,'cancel',t0+100000),/cannot be cancelled/);
});
test('reset clears prior events, loading and elapsed time',()=>{
  const r=control(control(seed(),'advance',t0+10000),'reset',t0+20000);
  assert.equal(r.loaded,false);assert.equal(r.elapsed,0);assert.equal(r.events.length,1);
});
test('QR parser accepts structured demo data but never invents retailer authorization',()=>{
  const parsed=parseReturnQR('AERO-RETURN:'+JSON.stringify({retailer:'Amazon',reference:'demo-1',weight:1.2}));
  assert.equal(parsed.recognized,true);assert.equal(parsed.details.retailer,'Amazon');
  assert.equal(parseReturnQR('https://amazon.com/opaque-code').recognized,false);
  assert.equal(parseReturnQR('AERO-RETURN:{bad}').recognized,false);
});

import { gateReview, SAMPLE_REVIEW, validProductURL } from '../lib/integrations';
test('uncertain AI output and any inconsistency flag always require a person',()=>{
  assert.equal(gateReview({...SAMPLE_REVIEW,confidence:.5}).recommendation,'manual_review');
  assert.equal(gateReview({...SAMPLE_REVIEW,fraudFlags:['Different product label']}).recommendation,'manual_review');
  assert.equal(gateReview({...SAMPLE_REVIEW,matchesProduct:false}).recommendation,'manual_review');
  assert.throws(()=>gateReview({...SAMPLE_REVIEW,confidence:10}));
});
test('product lookups reject local, private, credentialed and unapproved URLs',()=>{
  assert.equal(validProductURL('https://www.amazon.com/dp/EXAMPLE'),'https://www.amazon.com/dp/EXAMPLE');
  for(const value of ['http://amazon.com/a','https://127.0.0.1/a','https://amazon.com.evil.test','https://u:p@nike.com','https://nike.com:9000'])assert.throws(()=>validProductURL(value));
});
