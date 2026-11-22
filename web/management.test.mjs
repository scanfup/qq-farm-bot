import test from 'node:test';
import assert from 'node:assert/strict';
import { FarmApp } from './service.mjs';
import { createServer } from './server.mjs';
function demo() {
  const a=new FarmApp({demo:true,journal:false});const trace=[];
  a.pasture={state:()=>({status:'ready',animals:[{animalId:60001,itemId:60001,name:'鸡',count:3}],ranches:[],friends:{status:'ready',items:[]}}),invalidate(){},async refresh(){},async run(type,payload){trace.push({type,payload});return{count:0,errors:[],message:'ok'};}};
  return{a,trace};
}
test('priority planting fills vacancies in saved order and retains exhausted choices',async()=>{
  const{a}=demo();a.snapshot.lands=[1,2,3].map(id=>({id,unlocked:true,masterLandId:0,plant:null}));a.seeds=[{seed:20002,name:'白萝卜',count:1,canPlant:true},{seed:20516,name:'狗尾草',count:2,canPlant:true}];a.setPreferences({seedPriority:[20516,20002]});
  const job=a.submit('plant-priority',{},'priority-plant-001');await a.tail;assert.equal(job.status,'succeeded');assert.equal(job.result.count,3);assert.deepEqual(job.result.plantings.map(p=>p.seedId),[20516,20002]);assert.deepEqual(a.state().preferences.seedPriority,[20516,20002]);assert.equal(a.state().seedOptions.find(s=>s.seed===20516).count,0);await a.close();
});
test('an exhausted preferred seed never silently uses another without fallback',async()=>{
  const{a}=demo();a.snapshot.lands=[{id:1,unlocked:true,masterLandId:0,plant:null}];a.seeds=[{seed:20002,name:'白萝卜',count:2,canPlant:true}];a.setPreferences({seedPriority:[20516],seedFallback:false});
  const first=a.submit('plant-priority',{},'priority-empty-01');await a.tail;assert.equal(first.result.skipped,true);assert.equal(a.seeds[0].count,2);a.setPreferences({seedFallback:true});const second=a.submit('plant-priority',{},'priority-fallback');await a.tail;assert.equal(second.result.count,1);assert.equal(a.seeds[0].count,1);await a.close();
});
test('HTTP preferences validate syntax and pasture command dedup includes animal and count',async()=>{
  const{a,trace}=demo();const server=createServer(a);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;const post=(path,data)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Farm-Request':'1'},body:JSON.stringify(data)});
  try{let r=await post('/api/preferences',{seedPriority:[20516],animalPriority:[60001]});assert.equal(r.status,200);assert.deepEqual((await r.json()).animalPriority,[60001]);assert.equal((await post('/api/preferences',{seedPriority:'bad'})).status,400);
    r=await post('/api/commands',{type:'pasture-buy',animalId:60001,count:1,commandId:'buy-dedup-001'});assert.equal(r.status,202);await a.tail;assert.equal(trace[0].payload.animalId,60001);assert.equal((await post('/api/commands',{type:'pasture-buy',animalId:60001,count:2,commandId:'buy-dedup-001'})).status,409);assert.equal((await post('/api/commands',{type:'pasture-buy',animalId:60001,count:21,commandId:'buy-invalid-01'})).status,400);
  }finally{server.closeStreams();await new Promise(r=>server.close(r));await a.close();}
});
test('pasture uncertainty cannot be cleared by a failed pasture refresh or replay a write',async()=>{
  const{a}=demo();let writes=0,failRefresh=false;
  a.pasture.run=async()=>{writes++;a._taskWriteAttempted=true;throw Object.assign(new Error('reset'),{code:'ECONNRESET',partialResult:{count:1}});};
  a.pasture.refresh=async()=>{if(failRefresh)throw new Error('pasture unavailable');};
  const job=a.submit('pasture-harvest',{},'uncertain-ranch-01');await a.tail;assert.equal(job.status,'uncertain');assert.equal(job.result.count,1);assert.equal(a.needsReconcile,true);assert.equal(a.submit('pasture-harvest',{},'uncertain-ranch-01'),job);assert.equal(writes,1);
  failRefresh=true;const refresh=a.submit('pasture-refresh',{},'reconcile-ranch-01');await a.tail;assert.equal(refresh.status,'failed');assert.equal(a.needsReconcile,true);
  failRefresh=false;const good=a.submit('pasture-refresh',{},'reconcile-ranch-02');await a.tail;assert.equal(good.status,'succeeded');assert.equal(a.needsReconcile,false);assert.equal(writes,1);await a.close();
});
test('pasture-only timed cycle requires no seed inventory and includes all selected scopes',async()=>{
  const{a,trace}=demo();a.seeds=[];a.inventory.status='error';a.setMonitor({enabled:true,intervalSec:60,farmEnabled:false,pastureEnabled:true,pastureFriendsEnabled:true,pastureFeedEnabled:true});await a.runMonitorCycle();
  assert.deepEqual(trace.map(t=>t.type),['pasture-clean','pasture-produce','pasture-harvest','pasture-feed','pasture-place','pasture-friends-clean','pasture-friends-steal']);assert.equal(a.jobs.some(j=>j.type==='plant'),false);await a.close();
});
test('stopping management during one RPC prevents later steps and preferences cannot change mid-cycle',async()=>{
  const{a,trace}=demo();let announce,release;const started=new Promise(r=>announce=r);const gate=new Promise(r=>release=r);a.pasture.run=async(type)=>{trace.push({type});announce();await gate;return{count:0};};a.setMonitor({enabled:true,intervalSec:60,farmEnabled:false,pastureEnabled:true});const cycle=a.runMonitorCycle();await started;assert.throws(()=>a.setPreferences({animalPriority:[60001]}),/结束/);a.stopMonitor();release();await cycle;assert.equal(trace.length,1);await a.close();
});

test('reconfiguring a running monitor invalidates the remaining steps from its old scope',async()=>{
  const{a,trace}=demo();let announce,release;const started=new Promise(r=>announce=r),gate=new Promise(r=>release=r);
  a.pasture.run=async(type)=>{trace.push({type});announce();await gate;return{count:0};};
  a.setMonitor({enabled:true,intervalSec:60,farmEnabled:false,pastureEnabled:true});const cycle=a.runMonitorCycle();await started;
  a.setMonitor({enabled:true,intervalSec:60,farmEnabled:true,pastureEnabled:false,seedId:20002});release();await cycle;assert.deepEqual(trace.map(t=>t.type),['pasture-clean']);await a.close();
});
test('a persisted reconciliation clears only earlier uncertain jobs and retains their deduplication',async()=>{
  const{mkdtempSync,rmSync}=await import('node:fs');const{tmpdir}=await import('node:os');const{join,basename,dirname}=await import('node:path');const dir=mkdtempSync(join(tmpdir(),'qqfarm-management-'));
  const fail=a=>{a.pasture.run=async()=>{a._taskWriteAttempted=true;throw Object.assign(new Error('reset'),{code:'ECONNRESET'});};a.pasture.refresh=async()=>{};};
  let a;
  try {
    a=new FarmApp({demo:true,dataDir:dir});fail(a);const old=a.submit('pasture-harvest',{},'persist-ranch-old');await a.tail;assert.equal(old.status,'uncertain');a.submit('pasture-refresh',{},'persist-ranch-read');await a.tail;assert.equal(a.needsReconcile,false);await a.close();
    a=new FarmApp({demo:true,dataDir:dir});assert.equal(a.needsReconcile,false);assert.equal(a.submit('pasture-harvest',{},'persist-ranch-old').status,'uncertain');fail(a);a.submit('pasture-harvest',{},'persist-ranch-new');await a.tail;await a.close();
    a=new FarmApp({demo:true,dataDir:dir});assert.equal(a.needsReconcile,true);assert.deepEqual([...a.reconcileScopes],['pasture']);await a.close();
  } finally { if(a&&!a.stopped)await a.close();assert.equal(dirname(dir),tmpdir());assert.ok(basename(dir).startsWith('qqfarm-management-'));rmSync(dir,{recursive:true,force:true}); }
});

test('explicit seed fallback with no priority uses the same inventory policy in the monitor',async()=>{
  const{a}=demo();a.snapshot.lands=[{id:1,unlocked:true,masterLandId:0,plant:null}];a.setPreferences({seedFallback:true});a.setMonitor({enabled:true,intervalSec:60,farmEnabled:true,pastureEnabled:false,farmFriendsEnabled:false,seedId:null});await a.runMonitorCycle();assert.ok(a.jobs.some(j=>j.type==='plant-priority'));assert.equal(a.jobs.some(j=>j.type==='friend-steal'||j.type==='care'),false);await a.close();
});
