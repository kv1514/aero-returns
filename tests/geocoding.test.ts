import test from 'node:test';
import assert from 'node:assert/strict';
import {geocode} from '../lib/geocoding';

test('v4 address lookup encodes input, keeps key out of URL and converts coordinate order',async()=>{
  const request:typeof fetch=async(url,init)=>{
    assert.equal(String(url),'https://geocode.googleapis.com/v4/geocode/address/2180%20Milvia%20St%20%235');
    assert.equal(new Headers(init?.headers).get('X-Goog-Api-Key'),'test-key');
    return Response.json({results:[{formattedAddress:'2180 Milvia St, Berkeley',location:{latitude:37.869,longitude:-122.27}}]});
  };
  assert.deepEqual(await geocode('test-key','2180 Milvia St #5',request),[{address:'2180 Milvia St, Berkeley',point:[-122.27,37.869]}]);
});
test('reverse geocoding sends latitude before longitude and allows empty results',async()=>{
  const request:typeof fetch=async url=>{assert.equal(String(url),'https://geocode.googleapis.com/v4/geocode/location/37.869,-122.27');return Response.json({});};
  assert.deepEqual(await geocode('test-key',[-122.27,37.869],request),[]);
});
test('quota failures and malformed provider coordinates never become selectable addresses',async()=>{
  await assert.rejects(geocode('test-key','Berkeley',async()=>new Response('',{status:429})),/daily usage limit/);
  await assert.rejects(geocode('test-key','Berkeley',async()=>Response.json({results:[{formattedAddress:'Bad',location:{latitude:999,longitude:0}}]})),/invalid address response/);
});
test('invalid input is rejected before any provider request',async()=>{
  const request:typeof fetch=async()=>{assert.fail('Must not send invalid coordinates');};
  await assert.rejects(geocode('test-key',[NaN,37],request),/valid address/);
  await assert.rejects(geocode('test-key',' ',request),/valid address/);
  await assert.rejects(geocode('','Berkeley',request),/Connect/);
});
