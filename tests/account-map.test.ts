import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedProvider,accountOwner,sameOrigin,authOutcome} from '../lib/account-policy';
import {verifyAccountUser} from '../lib/verified-identity';
import {earthURL,streetViewURL} from '../lib/map-links';
test('only the intended OAuth providers can start a sign-in and origin must match',()=>{
  assert.ok(allowedProvider('google'));assert.ok(allowedProvider('custom:amazon'));
  for(const input of ['amazon','github','https://evil.example',null])assert.equal(allowedProvider(input),false);
  assert.ok(sameOrigin(new Request('https://aero.example/api/account',{headers:{Origin:'https://aero.example'}})));
  assert.equal(sameOrigin(new Request('https://aero.example/api/account')),false);
  assert.equal(sameOrigin(new Request('https://aero.example/api/account',{headers:{Origin:'https://evil.example'}})),false);
});
test('account ownership comes from verified user ID, never user-editable metadata',async()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const result=await verifyAccountUser(async()=>({data:{user:{id,user_metadata:{owner:'user:victim',sub:'victim'}}},error:null}));
  assert.equal(result.owner,`supabase:${id}`);
  assert.notEqual(accountOwner('22222222-2222-4222-8222-222222222222'),result.owner);
  assert.throws(()=>accountOwner('user:victim'));
});
test('expired or rejected sessions cannot fall back to a different owner',async()=>{
  await assert.rejects(verifyAccountUser(async()=>({data:{user:null},error:new Error('expired')})),/session expired/);
  await assert.rejects(verifyAccountUser(async()=>({data:{user:{id:'11111111-1111-4111-8111-111111111111'}},error:new Error('revoked')})),/session expired/);
  assert.equal(authOutcome('?auth=<script>alert(1)</script>'),null);
});
test('Earth and Street View use encoded coordinates without API credentials',()=>{
  const u=new URL(streetViewURL([-122.27,37.869]));
  assert.equal(u.origin,'https://www.google.com');assert.equal(u.searchParams.get('api'),'1');
  assert.equal(u.searchParams.get('map_action'),'pano');assert.equal(u.searchParams.get('viewpoint'),'37.869000,-122.270000');
  assert.equal(new URL(earthURL([-122.27,37.869])).origin,'https://earth.google.com');
  assert.throws(()=>streetViewURL([NaN,37]));assert.throws(()=>earthURL([0,91]));
});
