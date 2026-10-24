import test from 'node:test';
import assert from 'node:assert/strict';
import {gatePickupDetection,packageBoxSchema,placeBox} from '../lib/pickup-guide';
const suggestion={packageCount:1,box:{x:.6,y:.5,width:.2,height:.3},description:'Brown box beside a door.',concerns:[]};
test('ambiguous and absent packages cannot become a selected target',()=>{
  for(const packageCount of [0,2,10])assert.equal(gatePickupDetection({...suggestion,packageCount}).box,null);
  assert.deepEqual(gatePickupDetection(suggestion).box,suggestion.box);
  assert.equal(gatePickupDetection({...suggestion,box:null,concerns:['Occluded']}).box,null);
});
test('untrusted detection coordinates and oversized text are rejected',()=>{
  for(const box of [{x:NaN,y:0,width:.2,height:.2},{x:.9,y:.2,width:.3,height:.3},{x:0,y:-.1,width:.2,height:.2},{x:0,y:0,width:0,height:1}])assert.throws(()=>gatePickupDetection({...suggestion,box}));
  assert.throws(()=>gatePickupDetection({...suggestion,description:'x'.repeat(501)}));
  assert.throws(()=>gatePickupDetection({...suggestion,packageCount:1.5}));
});
test('manual target movement remains within the image even at edges and with invalid input',()=>{
  for(const x of [-1,0,.5,1,2,NaN])for(const y of [-1,0,.5,1,2,Infinity])for(const width of [-1,.02,.3,1,5,NaN])assert.ok(packageBoxSchema.safeParse(placeBox(x,y,width,.3)).success);
  assert.deepEqual(placeBox(1,1,.2,.3),{x:.8,y:.7,width:.2,height:.3});
});
