import test from 'node:test';
import assert from 'node:assert/strict';
import {demoIdentity,demoToken,demoCookie,exitDemoCookie} from '../lib/demo-account';
test('demo identity is inactive by default and cannot select a real account namespace',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  assert.equal(demoIdentity(null),null);
  assert.equal(demoIdentity(`aero_demo_id=${id}`),null);
  assert.equal(demoIdentity(`aero_demo_active=1; aero_demo_id=${id}`)?.owner,`demo:${id}`);
  for(const token of ['', 'supabase:11111111-1111-4111-8111-111111111111','../../victim',`${id}suffix`]){
    assert.equal(demoToken(`aero_demo_id=${token}`),null);
    assert.throws(()=>demoIdentity(`aero_demo_active=1; aero_demo_id=${token}`),/invalid/);
  }
});
test('demo cookies are HttpOnly and secure on HTTPS; exit clears only active mode',()=>{
  const request=new Request('https://aero.example/api/account/demo');
  assert.match(demoCookie('aero_demo_id','token',request),/HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  assert.match(exitDemoCookie(request),/^aero_demo_active=;.*Max-Age=0; Secure$/);
  assert.doesNotMatch(exitDemoCookie(request),/aero_demo_id|aero_auth/);
});
