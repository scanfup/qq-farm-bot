import test from 'node:test';
import assert from 'node:assert/strict';
import { FarmApp, AppError, COMMANDS } from './service.mjs';

function app() { return new FarmApp({ demo: true, journal: false }); }
async function finish(a, job) { await a.tail; return job; }

test('new scene management commands are top-level and reject target narrowing', async () => {
  assert.ok(COMMANDS.includes('farm-manage')); assert.ok(COMMANDS.includes('pasture-manage'));
  const a = app();
  try {
    for (const type of ['farm-manage', 'pasture-manage']) for (const key of ['gid', 'maxFriends', 'limit']) {
      assert.throws(() => a.submit(type, { [key]: 1 }, `reject-${type}-${key}`), AppError);
    }
  } finally { await a.close(); }
});

test('farm-manage cares self and all friends then steals all, without pasture calls', async () => {
  const a = app(), calls = [];
  a.careAll = async include => { calls.push(['care', include]); a.log('自家照料完成'); return { count: 2, changed: true, attemptedWrites: 1 }; };
  a.friendCommand = async (type, payload) => { calls.push([type, payload]); a.log('好友偷菜完成'); return { count: 3, changed: true, attemptedWrites: 1 }; };
  a.pastureCommand = async () => { throw new Error('farm-manage不得调用牧场'); };
  try { const job = await finish(a, a.submit('farm-manage', {}, 'farm-manage-1')); assert.equal(job.status, 'succeeded'); assert.deepEqual(calls, [['care', true], ['friend-steal', {}]]); assert.equal(job.scope, 'farm'); assert.deepEqual(job.result.steps.map(s => s.type), ['care', 'friend-steal']); assert.equal(job.result.count, 5); assert.ok(a.logs.every(log => log.scope === 'farm')); }
  finally { await a.close(); }
});

test('pasture-manage runs seven pasture steps in order without farm calls or preference changes', async () => {
  const a = app(), calls = [], before = a.preferenceStore.state();
  a.pastureCommand = async (type, payload) => { calls.push([type, payload]); a.log(type + ' done'); return { count: 1, changed: true, attemptedWrites: 1 }; };
  a.refresh = async () => { throw new Error('pasture-manage不得调用农场刷新'); };
  try { const job = await finish(a, a.submit('pasture-manage', {}, 'pasture-manage-1')); assert.equal(job.status, 'succeeded'); assert.deepEqual(calls.map(x => x[0]), ['pasture-clean', 'pasture-feed', 'pasture-produce', 'pasture-harvest', 'pasture-place', 'pasture-friends-clean', 'pasture-friends-steal']); assert.equal(job.scope, 'pasture'); assert.equal(job.result.steps.length, 7); assert.deepEqual(a.preferenceStore.state(), before); assert.ok(a.logs.every(log => log.scope === 'pasture')); }
  finally { await a.close(); }
});

test('management stops after uncertain partial step and preserves earlier steps', async () => {
  const a = app(), calls = [];
  a.pastureCommand = async type => { calls.push(type); if (type === 'pasture-produce') throw Object.assign(new Error('连接中断'), { uncertain: true, partialResult: { count: 0 } }); return { count: 1 }; };
  try { const job = await finish(a, a.submit('pasture-manage', {}, 'pasture-partial-1')); assert.equal(job.status, 'uncertain'); assert.deepEqual(calls, ['pasture-clean', 'pasture-feed', 'pasture-produce']); assert.deepEqual(job.result.steps.map(s => s.type), ['pasture-clean', 'pasture-feed', 'pasture-produce']); assert.equal(job.result.failedStep, 'pasture-produce'); assert.ok(job.result.steps[2].error); assert.ok(a.logs.filter(x => x.scope === 'pasture').some(x => x.message.includes('开始pasture-produce')) || a.logs.some(x => x.scope === 'pasture')); }
  finally { await a.close(); }
});

test('ALS scopes explicit parallel logs and management settings logs do not cross', async () => {
  const a = app();
  try { await Promise.all([a.als.run({ scope: 'farm' }, async () => { await Promise.resolve(); a.log('farm scoped'); }), a.als.run({ scope: 'pasture' }, async () => { await Promise.resolve(); a.log('pasture scoped'); }), Promise.resolve().then(() => a.log('system explicit', 'system'))]); const by = new Map(a.logs.map(x => [x.message, x.scope])); assert.equal(by.get('farm scoped'), 'farm'); assert.equal(by.get('pasture scoped'), 'pasture'); assert.equal(by.get('system explicit'), 'system'); }
  finally { await a.close(); }
});

test('scope log and job retention are independent', async () => {
  const a = app();
  try { for (const scope of ['farm', 'pasture', 'system']) for (let i = 0; i < 125; i++) a.log(`${scope}-${i}`, scope); assert.equal(a.logs.filter(x => x.scope === 'farm').length, 120); assert.equal(a.logs.filter(x => x.scope === 'pasture').length, 120); assert.equal(a.logs.filter(x => x.scope === 'system').length, 120); assert.equal(a.logs.length, 360); }
  finally { await a.close(); }
});

test('legacy jobs derive scope and remain readable without changing readonly history behavior', async () => {
  const a = app();
  try { const old = { id: 'legacy123', type: 'pasture-harvest', status: 'succeeded', createdAt: new Date().toISOString() }; a.ids.set(old.id, old); a.jobs.unshift(old); assert.equal(old.scope, undefined); const derived = old.scope || (old.type.startsWith('pasture-') ? 'pasture' : 'farm'); assert.equal(derived, 'pasture'); assert.equal(a.state().jobs[0], old); }
  finally { await a.close(); }
});

test('both one-click commands honor reconciliation before ready or any game step', async()=>{
  for(const type of ['farm-manage','pasture-manage']) {
    const a=app();let calls=0;a.needsReconcile=true;a.ready=async()=>{calls++;};a.careAll=async()=>{calls++;};a.pastureCommand=async()=>{calls++;};
    try{const job=await finish(a,a.submit(type,{},'blocked-'+type));assert.equal(job.status,'failed');assert.match(job.error,/核对/);assert.equal(calls,0);assert.equal(a.needsReconcile,true);}finally{await a.close();}
  }
});
test('farm management refreshes the current snapshot before self care',async()=>{
  const a=app(),calls=[];let fresh=false;a.refresh=async()=>{fresh=true;calls.push('refresh');};a.careAll=async()=>{assert.equal(fresh,true);calls.push('care');return{count:1};};a.friendCommand=async()=>{calls.push('steal');return{count:2};};
  try{const job=await finish(a,a.submit('farm-manage',{},'fresh-farm'));assert.equal(job.status,'succeeded');assert.deepEqual(calls,['refresh','care','steal']);}finally{await a.close();}
});
test('partial failed steps contribute confirmed counts and errors without continuing',async()=>{
  const a=app(),calls=[];a.pastureCommand=async type=>{calls.push(type);if(type==='pasture-feed')throw Object.assign(new Error('unknown reply'),{uncertain:true,partialResult:{count:3,attemptedWrites:2,changed:true,errors:[{message:'partial'}]}});return{count:2,attemptedWrites:1,changed:true,errors:[{message:'rejected item'}]};};
  try{const job=await finish(a,a.submit('pasture-manage',{},'partial-counts'));assert.equal(job.status,'uncertain');assert.deepEqual(calls,['pasture-clean','pasture-feed']);assert.equal(job.result.count,5);assert.equal(job.result.attemptedWrites,3);assert.equal(job.result.changed,true);assert.equal(job.result.errors.length,3);assert.deepEqual([...a.reconcileScopes],['pasture']);}finally{await a.close();}
});
test('mixed preference updates produce separate seed and animal logs',async()=>{
  const a=app();try{a.setPreferences({seedFallback:false,animalFallback:false});assert.equal(a.logs.filter(x=>x.scope==='farm').length,1);assert.equal(a.logs.filter(x=>x.scope==='pasture').length,1);}finally{await a.close();}
});
test('runtime task retention keeps newest global order and independent scene capacity',async()=>{
  const a=app();a.ready=async()=>{};a.command=async()=>({count:0});a.pastureCommand=async()=>({count:0});
  try{for(let i=0;i<105;i++)await finish(a,a.submit('harvest',{},'farm-retain-'+i));for(let i=0;i<125;i++)await finish(a,a.submit('pasture-clean',{},'pasture-retain-'+i));assert.equal(a.jobs.filter(x=>x.scope==='farm').length,100);assert.equal(a.jobs.filter(x=>x.scope==='pasture').length,100);assert.equal(a.jobs[0].id,'pasture-retain-124');assert.equal(a.jobs.at(-1).id,'farm-retain-5');}finally{await a.close();}
});
test('journal reload retains old other-scene jobs and system read recovery uses farm checkpoint',async()=>{
  const{mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const{tmpdir}=await import('node:os');const{join,dirname,basename}=await import('node:path');const dir=mkdtempSync(join(tmpdir(),'qqfarm-scene-'));
  const records=[{id:'old-farm-id',type:'harvest',status:'succeeded'},{id:'old-system-id',type:'connect',status:'queued'},...Array.from({length:320},(_,i)=>({id:'old-pasture-'+i,type:'pasture-harvest',status:'succeeded'}))];
  writeFileSync(join(dir,'demo-jobs.jsonl'),records.map(x=>JSON.stringify(x)).join('\n')+'\n');let a;
  try{a=new FarmApp({demo:true,dataDir:dir});assert.ok(a.jobs.some(x=>x.id==='old-farm-id'&&x.scope==='farm'));assert.equal(a.jobs.filter(x=>x.scope==='pasture').length,100);assert.equal(a.ids.get('old-system-id').scope,'system');assert.deepEqual([...a.reconcileScopes],['farm']);a.markReconciled('farm');await a.close();a=new FarmApp({demo:true,dataDir:dir});assert.equal(a.needsReconcile,false);assert.equal(a.ids.get('old-system-id').status,'uncertain');}finally{if(a)await a.close();assert.equal(dirname(dir),tmpdir());assert.ok(basename(dir).startsWith('qqfarm-scene-'));rmSync(dir,{recursive:true});}
});
