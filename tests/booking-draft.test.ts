import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readDraft,bookingProblem} from '../lib/booking-draft';
import {DEMO_PACKAGE} from '../lib/simulation';
import {normalizeMapConfig} from '../lib/maps-config';
const draft={version:1,updatedAt:100,step:1,package:{...DEMO_PACKAGE,returnReference:'AMZ-RETURN-12'}};
test('draft restores reviewed details but strips unknown fields',()=>{
  const loaded=readDraft(JSON.stringify({...draft,token:'do-not-keep'}),101);
  assert.equal(loaded?.package.returnReference,'AMZ-RETURN-12');assert.equal(loaded?.step,1);assert.equal('token' in loaded!,false);
});
test('draft rejects corrupt, expired, future, and out-of-area data',()=>{
  assert.equal(readDraft('{'),null);assert.equal(readDraft(JSON.stringify(draft),100+13*3600000),null);
  assert.equal(readDraft(JSON.stringify(draft),99),null);
  assert.equal(readDraft(JSON.stringify({...draft,package:{...DEMO_PACKAGE,pickup:[0,0]}}),101),null);
});
test('draft preserves incomplete numeric inputs for correction and validation blocks booking',()=>{
  const invalid={...DEMO_PACKAGE,weight:0};assert.ok(readDraft(JSON.stringify({...draft,package:invalid}),101));
  assert.match(bookingProblem(invalid),/positive/);assert.match(bookingProblem({...DEMO_PACKAGE,address:' '}),/address/);
  assert.equal(bookingProblem(DEMO_PACKAGE),'');
});
test('malformed Maps settings cannot crash map rendering',()=>{
  for(const value of [null,undefined,[],{key:5,mapId:false}])assert.deepEqual(normalizeMapConfig(value),{key:'',mapId:'DEMO_MAP_ID'});
  assert.deepEqual(normalizeMapConfig({key:' test ',mapId:' '}),{key:'test',mapId:'DEMO_MAP_ID'});
});
