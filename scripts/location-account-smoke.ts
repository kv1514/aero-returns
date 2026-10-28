import assert from 'node:assert/strict';
const base=process.argv[2]||process.env.AERO_TEST_URL||'http://127.0.0.1:5173';
const configResponse=await fetch(base+'/api/maps-config');const config=await configResponse.json() as {key:string;mapId:string};assert.equal(configResponse.status,200);assert.equal(typeof config.key,'string');assert.ok(config.mapId);assert.deepEqual(Object.keys(config).sort(),['key','mapId']);
const accountResponse=await fetch(base+'/api/amazon');const account=await accountResponse.json() as {configured:boolean;connected:boolean;ordersAvailable:boolean};assert.equal(accountResponse.status,200);assert.equal(account.connected,false);assert.equal(account.ordersAvailable,false);const cookie=accountResponse.headers.get('set-cookie')?.split(';')[0]||'';
for(const method of ['POST','DELETE']){const response=await fetch(base+'/api/amazon',{method,headers:{Origin:'https://wrong-origin.example',Cookie:cookie}});assert.equal(response.status,403);}
if(!account.configured){const response=await fetch(base+'/api/amazon',{method:'POST',headers:{Origin:base,Cookie:cookie}});assert.equal(response.status,503);}
const callback=await fetch(base+'/api/amazon/callback?state=forged&code=not-a-real-code',{headers:{Cookie:cookie},redirect:'manual'});assert.equal(callback.status,303);assert.ok(callback.headers.get('location')?.includes(account.configured?'amazon=invalid':'amazon=setup'));assert.equal(callback.headers.get('referrer-policy'),'no-referrer');
const after=await fetch(base+'/api/amazon',{headers:{Cookie:cookie}});assert.equal((await after.json() as {connected:boolean}).connected,false);
const page=await fetch(base+'/');const html=await page.text();// The home screen waits for the person to request a drone; nothing is booked by opening it.
for(const text of ['Request a drone','Simulation','Nearby','Drop-off points','Amazon','Maps'])assert.ok(html.includes(text),`home page missing "${text}"`);
console.log('PASS: Maps configuration contract; Amazon setup state, origin checks, rejected callback, no account mutation; feature entry points render. No live provider calls made.');
