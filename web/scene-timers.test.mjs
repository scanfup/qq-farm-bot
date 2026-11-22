import test from 'node:test';
import assert from 'node:assert/strict';
import { FarmApp, AppError } from './service.mjs';
import { createServer } from './server.mjs';

async function fixture() {
  const app = new FarmApp({ demo:true, journal:false });
  await app.refreshFriends();
  const calls=[];
  app.command=async(type,payload)=>{calls.push({type,payload});return{count:0};};
  app.manageScene=async type=>{calls.push({type,payload:{}});return{count:0};};
  app.pastureCommand=async(type,payload)=>{calls.push({type,payload});return{count:0};};
  return{app,calls};
}
function gate(){let release,announce;return{wait:new Promise(r=>release=r),started:new Promise(r=>announce=r),release:()=>release(),announce:()=>announce()};}
const enable=(app,scope,extra={})=>app.setSceneMonitor(scope,{enabled:true,intervalSec:60,...extra});

 test('scene monitor defaults are off and do not submit work when enabled',async()=>{
  const{app,calls}=await fixture();try{
    assert.equal(app.state().monitors.farm.enabled,false);assert.equal(app.state().monitors.pasture.enabled,false);
    assert.equal(app.monitors.farm.seedId,20002);assert.equal(app.monitors.pasture.feedEnabled,true);
    enable(app,'farm');enable(app,'pasture');assert.deepEqual(calls,[]);assert.equal(app.pending,0);
    assert.ok(Date.parse(app.monitors.farm.nextRunAt)>Date.now());assert.ok(app.sceneTimers.farm);assert.ok(app.sceneTimers.pasture);
  }finally{await app.close();}
});
test('each scene has independent settings, handle and generation',async()=>{
  const{app}=await fixture();try{
    enable(app,'farm');enable(app,'pasture',{intervalSec:180,feedEnabled:false});
    const pasture={...app.monitors.pasture},handle=app.sceneTimers.pasture,generation=app.sceneGenerations.pasture;
    enable(app,'farm',{intervalSec:240,friendsEnabled:false});app.stopSceneMonitor('farm');
    assert.deepEqual(app.monitors.pasture,pasture);assert.equal(app.sceneTimers.pasture,handle);assert.equal(app.sceneGenerations.pasture,generation);assert.equal(app.monitors.farm.enabled,false);
  }finally{await app.close();}
});
test('farm cycle runs harvest cleanup explicit seed planting and all-friend management only',async()=>{
  const{app,calls}=await fixture();try{
    enable(app,'farm');const result=await app.runSceneMonitorCycle('farm');
    assert.equal(result.completed,true);assert.deepEqual(calls.map(x=>x.type),['harvest','remove-dead','plant','farm-manage']);assert.equal(calls[2].payload.seedId,20002);
    assert.ok(app.jobs.every(x=>x.scope==='farm'));assert.equal(app.monitors.farm.running,false);assert.ok(app.monitors.farm.lastRunAt);
  }finally{await app.close();}
});
test('farm saved priority and fallback policy choose plant-priority; disabling friends uses care-self',async()=>{
  for(const policy of [{seedPriority:[20002]},{seedFallback:true}]){
    const{app,calls}=await fixture();try{app.setPreferences(policy);enable(app,'farm',{friendsEnabled:false});await app.runSceneMonitorCycle('farm');assert.deepEqual(calls.map(x=>x.type),['harvest','remove-dead','plant-priority','care-self']);assert.ok(calls.every(x=>!x.type.startsWith('pasture-')));}finally{await app.close();}
  }
});
test('pasture cycle includes stock feed before production and all friends, without farm writes',async()=>{
  const{app,calls}=await fixture();try{enable(app,'pasture');const result=await app.runSceneMonitorCycle('pasture');assert.equal(result.completed,true);assert.deepEqual(calls.map(x=>x.type),['pasture-clean','pasture-feed','pasture-produce','pasture-harvest','pasture-place','pasture-friends-clean','pasture-friends-steal']);assert.ok(app.jobs.every(x=>x.scope==='pasture'));}finally{await app.close();}
});
test('pasture feed/friend options affect only their own steps',async()=>{
  const{app,calls}=await fixture();try{enable(app,'pasture',{feedEnabled:false,friendsEnabled:false});await app.runSceneMonitorCycle('pasture');assert.deepEqual(calls.map(x=>x.type),['pasture-clean','pasture-produce','pasture-harvest','pasture-place']);}finally{await app.close();}
});
test('stopping the active scene cancels unissued steps without changing the other enabled monitor',async()=>{
  const{app,calls}=await fixture(),g=gate();app.command=async type=>{calls.push({type});g.announce();await g.wait;return{count:1};};
  try{enable(app,'farm');enable(app,'pasture');const cycle=app.runSceneMonitorCycle('farm');await g.started;assert.equal(app.monitors.farm.running,true);assert.throws(()=>app.setPreferences({seedFallback:true}),/结束/);app.stopSceneMonitor('farm');assert.equal(app.monitors.pasture.enabled,true);g.release();const result=await cycle;assert.equal(result.cancelled,true);assert.deepEqual(calls.map(x=>x.type),['harvest']);assert.equal(app.monitors.farm.running,false);}finally{g.release();await app.close();}
});
test('updating a running scene invalidates its old generation and uses a new interval handle',async()=>{
  const{app,calls}=await fixture(),g=gate();app.pastureCommand=async type=>{calls.push({type});g.announce();await g.wait;return{count:1};};
  try{enable(app,'pasture');const before=app.sceneGenerations.pasture,handle=app.sceneTimers.pasture;const cycle=app.runSceneMonitorCycle('pasture');await g.started;enable(app,'pasture',{intervalSec:180,feedEnabled:false});assert.ok(app.sceneGenerations.pasture>before);assert.notEqual(app.sceneTimers.pasture,handle);g.release();const result=await cycle;assert.equal(result.cancelled,true);assert.deepEqual(calls.map(x=>x.type),['pasture-clean']);assert.equal(app.monitors.pasture.enabled,true);assert.equal(app.monitors.pasture.intervalSec,180);}finally{g.release();await app.close();}
});
test('shared cycle lock skips concurrent scene cycles and pending manual work',async()=>{
  const{app,calls}=await fixture(),g=gate();app.command=async type=>{calls.push({type});g.announce();await g.wait;return{count:1};};
  try{enable(app,'farm');enable(app,'pasture');const cycle=app.runSceneMonitorCycle('farm');await g.started;assert.equal((await app.runSceneMonitorCycle('pasture')).reason,'busy');assert.equal((await app.runSceneMonitorCycle('farm')).reason,'busy');app.stopSceneMonitor('farm');g.release();await cycle;
    const job=app.submit('harvest',{},'manual-busy-test');assert.equal((await app.runSceneMonitorCycle('pasture')).reason,'busy');await app.tail;assert.equal(job.status,'succeeded');assert.ok(app.logs.some(x=>x.scope==='pasture'&&x.message.includes('等待队列空闲')));
  }finally{g.release();await app.close();}
});
test('scene validation is atomic and rejects cross-scene or unknown fields',async()=>{
  const{app}=await fixture();try{enable(app,'farm');enable(app,'pasture');const before=JSON.stringify(app.monitors),handles={...app.sceneTimers},generations={...app.sceneGenerations};
    for(const[scope,input]of [['farm',{enabled:true,intervalSec:59}],['pasture',{enabled:true,intervalSec:3601}],['farm',{enabled:true,friendsEnabled:1}],['pasture',{enabled:true,feedEnabled:'yes'}],['farm',{enabled:true,feedEnabled:true}],['pasture',{enabled:true,seedId:20002}],['farm',{enabled:true,farmEnabled:true}],['pasture',{enabled:true,pastureEnabled:true}]])assert.throws(()=>app.setSceneMonitor(scope,input),AppError);
    assert.equal(JSON.stringify(app.monitors),before);assert.deepEqual(app.sceneTimers,handles);assert.deepEqual(app.sceneGenerations,generations);
  }finally{await app.close();}
});
test('closing remains available while disconnected, reconcile-locked, and with malformed drafts',async()=>{
  const{app}=await fixture();try{enable(app,'farm');enable(app,'pasture');app.connection.status='error';app.needsReconcile=true;
    app.setSceneMonitor('farm',{enabled:false,intervalSec:'bad',seedId:0,friendsEnabled:'bad'});app.setSceneMonitor('pasture',{enabled:false,intervalSec:-1,feedEnabled:'bad'});
    assert.equal(app.monitors.farm.enabled,false);assert.equal(app.monitors.pasture.enabled,false);assert.equal(app.monitors.farm.intervalSec,60);assert.equal(app.monitors.pasture.feedEnabled,true);
  }finally{await app.close();}
});
test('enable guards require connection, reconciliation, inventory and matching friend identity',async()=>{
  for(const[scope,mutate]of [
    ['farm',app=>app.connection.status='error'],['farm',app=>app.needsReconcile=true],['farm',app=>app.inventory.status='error'],['farm',app=>app.seeds=[]],['farm',app=>app.friendService.identitySource=null],
    ['pasture',app=>app.pasture.inventoryStatus='error'],['pasture',app=>app.pasture.friends.status='error'],['pasture',app=>app.pasture.selfGid=0],
  ]){const{app}=await fixture();try{mutate(app);assert.throws(()=>enable(app,scope));assert.equal(app.monitors[scope].enabled,false);assert.equal(app.sceneTimers[scope],null);assert.equal(app.pending,0);}finally{await app.close();}}
});
test('new scene and legacy monitor cannot run together in either direction',async()=>{
  const{app}=await fixture();try{app.setMonitor({enabled:true,intervalSec:60});assert.throws(()=>enable(app,'farm'),e=>e.status===409);assert.equal(app.monitor.enabled,true);app.stopMonitor();enable(app,'pasture');assert.throws(()=>app.setMonitor({enabled:true,intervalSec:60}),e=>e.status===409);assert.equal(app.monitors.pasture.enabled,true);assert.equal(app.monitor.enabled,false);}finally{await app.close();}
});
test('known business failure pauses only its scene while unknown write pauses both with reason',async()=>{
  for(const uncertain of [false,true]){const{app}=await fixture();try{enable(app,'farm');enable(app,'pasture');app.command=async()=>{app._taskWriteAttempted=true;throw Object.assign(new Error(uncertain?'connection reset':'rejected'),uncertain?{}:{code:123});};const job=app.submit('harvest',{},'failure-test-'+uncertain);await app.tail;assert.equal(job.status,uncertain?'uncertain':'failed');assert.equal(app.monitors.farm.enabled,false);assert.equal(app.monitors.pasture.enabled,!uncertain);assert.equal(app.needsReconcile,uncertain);if(uncertain){assert.match(app.monitors.pasture.lastError,/另一场景/);assert.ok(app.logs.some(l=>l.scope==='pasture'&&l.message.includes('全局核对')));}}finally{await app.close();}}
});
test('cycle logs stay in their scene and close cancels both handles without automatic restart',async()=>{
  const{app}=await fixture();enable(app,'farm');enable(app,'pasture');await app.runSceneMonitorCycle('farm');await app.runSceneMonitorCycle('pasture');
  for(const scene of ['farm','pasture']){const logs=app.logs.filter(l=>l.message.includes('托管')&&l.message.startsWith(scene==='farm'?'农场':'牧场'));assert.ok(logs.some(l=>l.message.includes('本轮开始')));assert.ok(logs.some(l=>l.message.includes('本轮完成')));assert.ok(logs.every(l=>l.scope===scene));}
  await app.close();assert.equal(app.sceneTimers.farm,null);assert.equal(app.sceneTimers.pasture,null);assert.equal(app.monitors.farm.enabled,false);assert.equal(app.monitors.pasture.enabled,false);assert.throws(()=>enable(app,'farm'),e=>e.status===503);
  const next=new FarmApp({demo:true,journal:false});assert.equal(next.monitors.farm.enabled,false);assert.equal(next.monitors.pasture.enabled,false);await next.close();
});
test('scene monitor API updates independently, is visible in state, and unknown scope is 404',async()=>{
  const{app,calls}=await fixture(),server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const post=(path,data)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Farm-Request':'1'},body:JSON.stringify(data)});
  try{let res=await post('/api/monitor/farm',{enabled:true,intervalSec:90});assert.equal(res.status,200);assert.equal((await res.json()).intervalSec,90);res=await post('/api/monitor/pasture',{enabled:true,intervalSec:180,feedEnabled:false});assert.equal(res.status,200);let state=await(await fetch(base+'/api/state')).json();assert.equal(state.monitors.farm.intervalSec,90);assert.equal(state.monitors.pasture.feedEnabled,false);assert.equal(state.monitor.enabled,false);assert.equal(calls.length,0);
    assert.equal((await post('/api/monitor/unknown',{enabled:true})).status,404);assert.equal((await post('/api/monitor/farm',{enabled:true,pastureEnabled:true})).status,400);assert.equal((await post('/api/monitor/farm',{enabled:false,intervalSec:'bad'})).status,200);state=await(await fetch(base+'/api/state')).json();assert.equal(state.monitors.farm.enabled,false);assert.equal(state.monitors.pasture.enabled,true);
  }finally{server.closeStreams();await new Promise(r=>server.close(r));await app.close();}
});

test('interval callback runs unattended only when due, with no UI connection or immediate writes',async t=>{
  const{app,calls}=await fixture();t.mock.timers.enable({apis:['setInterval','Date']});
  const original=app.runSceneMonitorCycle.bind(app);let fired;
  app.runSceneMonitorCycle=scope=>(fired=original(scope));
  try{enable(app,'farm',{friendsEnabled:false});assert.equal(calls.length,0);t.mock.timers.tick(59999);assert.equal(fired,undefined);t.mock.timers.tick(1);assert.ok(fired);await fired;assert.deepEqual(calls.map(x=>x.type),['harvest','remove-dead','plant','care-self']);assert.equal(app.listeners.size,0);app.stopSceneMonitor('farm');const count=calls.length;t.mock.timers.tick(180000);await Promise.resolve();assert.equal(calls.length,count);}finally{await app.close();t.mock.timers.reset();}
});
test('stopping immediately after a timer submission prevents the queued write being sent',async()=>{
  const{app,calls}=await fixture();try{enable(app,'farm');const cycle=app.runSceneMonitorCycle('farm');app.stopSceneMonitor('farm');const result=await cycle;assert.equal(result.cancelled,true);assert.equal(calls.length,0);assert.equal(app.jobs[0].result.cancelled,true);}finally{await app.close();}
});
test('stopping during combined farm management cancels its unissued steal step and retains prior result',async()=>{
  const{app}=await fixture(),g=gate(),calls=[];
  app.manageScene=FarmApp.prototype.manageScene;
  app.refresh=async()=>({count:0});
  app.careAll=async()=>{calls.push('care');g.announce();await g.wait;return{count:3,changed:true};};
  app.friendCommand=async()=>{calls.push('steal');return{count:2};};
  try{enable(app,'farm');const cycle=app.runSceneMonitorCycle('farm');await g.started;app.stopSceneMonitor('farm');g.release();const result=await cycle;const manage=app.jobs.find(job=>job.type==='farm-manage');assert.deepEqual(calls,['care']);assert.equal(result.cancelled,true);assert.equal(manage.result.count,3);assert.equal(manage.result.cancelled,true);assert.equal(app.needsReconcile,false);}finally{g.release();await app.close();}
});

test('idle settings can be saved independently without enabling or accessing the game',async()=>{
 const{app,calls}=await fixture();try{app.connection.status='error';app.setSceneMonitor('farm',{enabled:false,intervalSec:180,friendsEnabled:false,seedId:20002});app.setSceneMonitor('pasture',{enabled:false,intervalSec:420,friendsEnabled:true,feedEnabled:false});assert.equal(app.monitors.farm.intervalSec,180);assert.equal(app.monitors.pasture.intervalSec,420);assert.equal(app.monitors.farm.enabled,false);assert.equal(app.monitors.pasture.enabled,false);assert.deepEqual(calls,[]);}finally{await app.close();}
});
test('a due pasture cycle is not starved by a busy farm cycle with the same interval',async()=>{
 const{app,calls}=await fixture(),g=gate();let held=false;app.command=async type=>{calls.push({type});if(!held){held=true;g.announce();await g.wait;}return{count:0};};
 try{enable(app,'farm');enable(app,'pasture');const farm=app.runSceneMonitorCycle('farm');await g.started;const due=await app.runSceneMonitorCycle('pasture');assert.equal(due.waiting,true);assert.equal(app.monitors.pasture.waiting,true);g.release();await farm;await new Promise(setImmediate);await app.tail;assert.ok(calls.some(x=>x.type==='pasture-clean'));assert.ok(app.monitors.pasture.lastRunAt);assert.equal(app.monitors.pasture.waiting,false);}finally{g.release();await app.close();}
});
