import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { discoverNetwork } from '../tools/network-discovery.mjs';
import { seedMetadataExpression, aggregateItems, ownedSeeds } from './seed-inventory.mjs';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FarmApp } from './service.mjs';
import { createServer } from './server.mjs';
import { parse, fields, num, wMsg, wVarint, encCat } from '../tools/farm.mjs';
import http from 'node:http';
import { Bridge } from '../tools/core.mjs';
const fixture = readFileSync(new URL('../out/proto/AllLandsReply.bin', import.meta.url));
const land = (id, { master = 0, dead = false } = {}) => wMsg(1, encCat(wVarint(1,id), wVarint(2,1), wVarint(13,master), wMsg(10, encCat(wVarint(1,1020002), wMsg(4, encCat(wVarint(1,dead?7:6),wVarint(2,1)))))));
function fake(body = encCat(land(1),land(2,{master:1}),land(3,{dead:true}))) {
  return { port:62000, ctxId:9, gid:123, writes:[], active:0, max:0,
    async ensure(){}, async ping(){return {ok:true};}, close(){},
    async call(svc, method, bytes){
      this.active++; this.max = Math.max(this.max,this.active);
      try { await new Promise(r=>setTimeout(r,2)); if(method==='AllLands') return {body}; if(method==='Bag') return {body:wMsg(1,Buffer.alloc(0))}; if(method==='GetAll') return {body:wMsg(1,wVarint(1,123))}; this.writes.push({method,bytes}); if(this.fail) throw this.fail; return {body:Buffer.alloc(0)}; }
      finally {this.active--;}
    }
  };
}
test('serial writes, idempotency, omit self host, skip slave/dead lands', async () => {
  const b=fake(); const a=new FarmApp({bridge:b,journal:false});
  const one=a.submit('harvest',{},'harvest-0001');
  assert.equal(a.submit('harvest',{},'harvest-0001'),one);
  assert.throws(()=>a.submit('remove-dead',{},'harvest-0001'),/另一条/);
  a.submit('remove-dead',{},'remove-0001'); await a.tail;
  assert.equal(b.max,1); assert.equal(b.writes.length,2);
  assert.equal(one.status,'succeeded');
  const req=parse(b.writes[0].bytes); assert.equal(fields(req,2).length,0); assert.equal(fields(req,3).length,0);
  assert.deepEqual([...fields(req,1)[0]],[1]); assert.deepEqual([...fields(parse(b.writes[1].bytes),1)[0]],[3]);
  await a.close();
});
test('timeout marks uncertain and blocks writes until explicit refresh', async () => {
  const b=fake(); b.fail=new Error('CDP 超时'); const a=new FarmApp({bridge:b,journal:false});
  const one=a.submit('harvest',{},'timeout-0001'); await a.tail;
  assert.equal(one.status,'uncertain'); assert.equal(a.needsReconcile,true);
  const two=a.submit('harvest',{},'timeout-0002'); await a.tail;
  assert.equal(two.status,'failed'); assert.equal(b.writes.length,1);
  b.fail=null; a.submit('refresh',{},'refresh-0001'); await a.tail;
  assert.equal(a.needsReconcile,false); await a.close();
});
test('gateway rejection is failed, never a retry', async () => {
  const b=fake(); b.fail=Object.assign(new Error('日上限'),{code:1001046});
  const a=new FarmApp({bridge:b,journal:false});
  const j=a.submit('harvest',{},'limit-00001'); await a.tail;
  assert.equal(j.status,'failed'); assert.equal(b.writes.length,1); await a.close();
});
test('empty snapshot fails closed', async () => {
  const b=fake(Buffer.alloc(0)); const a=new FarmApp({bridge:b,journal:false});
  const j=a.submit('harvest',{},'empty-00001'); await a.tail;
  assert.equal(j.status,'failed'); assert.equal(b.writes.length,0); await a.close();
});
test('restart preserves command deduplication and disables monitor', async () => {
  const dir=mkdtempSync(join(tmpdir(),'farm-web-'));
  try {
    const a=new FarmApp({demo:true,dataDir:dir}); a.submit('harvest',{},'persist-0001'); await a.tail; await a.close();
    const b=new FarmApp({demo:true,dataDir:dir});
    assert.equal(b.submit('harvest',{},'persist-0001').status,'succeeded'); assert.equal(b.pending,0); assert.equal(b.monitor.enabled,false); await b.close();
  } finally { const resolved=dir; assert.ok(resolved.startsWith(join(tmpdir(),'farm-web-'))); rmSync(resolved,{recursive:true,force:true}); }
});
test('malformed protobuf rejected, real fixture decodes via app', async () => {
  assert.throws(()=>parse(Buffer.from([0x0a,0x7f,0x01])),/truncated/);
  assert.throws(()=>parse(Buffer.from([0x08,0x80])),/truncated/);
  assert.throws(()=>parse(Buffer.from([0])),/invalid/);
  const a=new FarmApp({bridge:fake(fixture),journal:false}); a.submit('connect',{},'connect-001'); await a.tail;
  assert.equal(a.snapshot.lands.length,24); assert.equal(a.snapshot.lands.filter(l=>l.unlocked).length,12); await a.close();
});
test('HTTP contract, origin restriction, no raw eval endpoint, SSE', async () => {
  const app=new FarmApp({demo:true,journal:false}); const server=createServer(app);
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Farm-Request':'1',...headers},body:JSON.stringify(body)});
  try {
    assert.equal((await (await fetch(base+'/api/state')).json()).mode,'demo');
    assert.equal((await post('/api/commands',{type:'plant',seedId:'20002',commandId:'badseed-001'})).status,400);
    assert.equal((await post('/api/commands',{type:'harvest',commandId:'http-00001'})).status,202);
    assert.equal((await post('/api/connect',{}, {Origin:'https://evil.example'})).status,403);
    const badHost = await new Promise((resolve,reject) => {
      http.get(base+'/api/state',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);
    });
    assert.equal(badHost,403);
    assert.equal((await fetch(base+'/api/connect',{method:'POST',body:'{}'})).status,403);
    assert.equal((await post('/api/eval',{expression:'1'})).status,404);
    assert.equal((await post('/api/monitor',{enabled:true,intervalSec:1,seedId:20002})).status,400);
    const controller=new AbortController(); const stream=await fetch(base+'/api/events',{signal:controller.signal});
    const chunk=await stream.body.getReader().read(); assert.match(new TextDecoder().decode(chunk.value),/event: state/); controller.abort();
    assert.match(await (await fetch(base+'/')).text(),/农场/);
  } finally { server.closeStreams(); await app.close(); await new Promise(r=>server.close(r)); }
});
test('plant caps targets to bag stock and never buys seeds', async () => {
  const empty = id => wMsg(1,encCat(wVarint(1,id),wVarint(2,1)));
  const b=fake(encCat(empty(1),empty(2))); const original=b.call.bind(b);
  b.call=async (svc,method,body) => method==='Bag'
    ? {body:wMsg(1,wMsg(1,encCat(wVarint(1,20002),wVarint(2,1))))}
    : original(svc,method,body);
  const a=new FarmApp({bridge:b,journal:false}); const job=a.submit('plant',{seedId:20002},'plant-stock-01'); await a.tail;
  assert.equal(job.status,'succeeded'); assert.equal(job.result.count,1);
  assert.deepEqual(b.writes.map(w=>w.method),['Plant']);
  const items=fields(parse(b.writes[0].bytes),2); assert.equal(items.length,1);
  assert.equal(num(parse(items[0]),1),20002); assert.equal(num(parse(items[0]),3),1);
  await a.close();
});
test('discovers the existing online game channel without importing or breakpoints', () => {
  let state=5; const net={send(){},getServiceFunName(){},getState(){return state;}};
  const modules=new Map([
    ['chunks:///_virtual/Oops.ts',{oops:{netWebSocket:{GAME_CHANNELID:0,_channels:new Map([[0,net]])}}}],
    ['chunks:///_virtual/NetNode.ts',{NetNodeState:{Working:5}}],
  ]);
  const context={System:{get:key=>modules.get(key)}};
  const found=runInNewContext(discoverNetwork,context);
  assert.equal(found.ok,true); assert.equal(context.__netInst,net);
  state=2; assert.equal(runInNewContext(discoverNetwork,context).ok,false);
  assert.equal(runInNewContext(discoverNetwork,{}).ok,false);
});
test('offline discovery fails immediately without installing breakpoints', async () => {
  const b=new Bridge(); b.evaluate=async()=>({ok:false,reason:'游戏网络当前不在线'});
  b._send=async()=>{throw new Error('unexpected debugger call');};
  await assert.rejects(b.grabNetInst(),/游戏网络当前不在线/);
});
test('repeated connect clicks share one in-flight job', async () => {
  const b=fake(); const a=new FarmApp({bridge:b,journal:false});
  const first=a.submit('connect',{},'connect-dedupe1');
  assert.equal(a.submit('connect',{},'connect-dedupe2'),first);
  await a.tail; assert.equal(first.status,'succeeded'); assert.equal(a.connection.status,'ready'); await a.close();
});
test('re-entry replaces the OPEN stale socket and merges concurrent recovery', async () => {
  const b=new Bridge(); let dials=0, closes=0, injected=0;
  const stale={readyState:1,close(){closes++;}}; b.ws=stale; b.ctxId=3; b.contexts=[{id:3}];
  b.ping=async()=>({ok:b.ctxId===42,reason:'Cannot find context with specified id'});
  b._dial=async()=>{dials++;b.ws={readyState:1,close(){closes++;}};};
  b.detectContext=async()=>{assert.equal(b.contexts.length,0);b.ctxId=42;return{id:42,info:{k:80}};};
  b.grabNetInst=async()=>true; b.injectBot=async()=>{injected++;};
  await Promise.all([b.ensure(),b.ensure(),b.ensure()]);
  assert.notEqual(b.ws,stale); assert.equal(dials,1); assert.equal(closes,1); assert.equal(injected,1); assert.equal(b.status,'ready');
  const second=b.ws; b.ctxId=null; b.contexts=[]; await b.ensure();
  assert.notEqual(b.ws,second); assert.equal(dials,2); b.close();
});
test('context discovery accepts real game capabilities without arbitrary key count', async () => {
  const b=new Bridge(); b.contexts=[{id:7,auxData:{type:'default'}}];
  b._send=async()=>({}); b.evaluate=async()=>JSON.stringify({t:'object',c:'object',s:'object',k:60});
  assert.equal((await b.detectContext({timeoutMs:100})).id,7); b.close();
});
test('live config includes seeds missing from static catalog and excludes fruit/currency', () => {
  const plants=new Map([[1020040,{id:1020040,seed_id:20040,name:'牧草'}],[1020516,{id:1020516,seed_id:20516,name:'狗尾草'}]]);
  const items=new Map([[20040,{type:5,name:'牧草种子'}],[20516,{type:5,name:'狗尾草种子'}],[40002,{type:3,name:'白萝卜'}],[1001,{type:2,name:'金币'}]]);
  const configs=new Map([['Plant',{_configMap:plants}],['ItemInfo',{_configMap:items}]]);
  const context={System:{get:()=>({oops:{configFactory:{configs}}})}};
  const result=runInNewContext(seedMetadataExpression([20040,20516,40002,1001]),context);
  assert.equal(result.available,true);
  const seeds=ownedSeeds(aggregateItems([{id:20516,count:2},{id:20516,count:3},{id:20040,count:16},{id:40002,count:99},{id:1001,count:1000}]),result.seeds);
  assert.deepEqual(seeds.map(s=>[s.seed,s.count]),[[20040,16],[20516,5]]);
});
test('plant uses the sum of duplicate bag stacks', async () => {
  const empty=id=>wMsg(1,encCat(wVarint(1,id),wVarint(2,1)));
  const b=fake(encCat(empty(1),empty(2),empty(3))); const original=b.call.bind(b);
  const bag=wMsg(1,encCat(wMsg(1,encCat(wVarint(1,20002),wVarint(2,1))),wMsg(1,encCat(wVarint(1,20002),wVarint(2,2)))));
  b.call=async(s,m,p)=>m==='Bag'?{body:bag}:original(s,m,p);
  b.evaluate=async()=>({available:true,seeds:[{seed:20002,name:'白萝卜',canPlant:true}]});
  const a=new FarmApp({bridge:b,journal:false});
  const job=a.submit('plant',{seedId:20002},'multi-stack-001'); await a.tail;
  assert.equal(job.status,'succeeded'); assert.equal(job.result.count,3); assert.equal(fields(parse(b.writes[0].bytes),2).length,3);
  await a.close();
});
test('exhausted selected seed reports alternatives instead of an empty bag', async () => {
  const b=fake(wMsg(1,encCat(wVarint(1,1),wVarint(2,1)))); const original=b.call.bind(b);
  b.call=async(s,m,p)=>m==='Bag'?{body:wMsg(1,wMsg(1,encCat(wVarint(1,20516),wVarint(2,373))))}:original(s,m,p);
  b.evaluate=async()=>({available:true,seeds:[{seed:20516,name:'狗尾草',canPlant:true}]});
  const a=new FarmApp({bridge:b,journal:false});
  const job=a.submit('plant',{seedId:20002},'white-zero-001'); await a.tail;
  assert.equal(job.status,'failed'); assert.match(job.error,/白萝卜.*库存为0/); assert.match(job.error,/狗尾草×373/); assert.equal(b.writes.length,0);
  assert.equal(a.seeds.length,1); assert.equal(a.seeds[0].count,373);
  await a.close();
});
test('bag failure clears stale inventory and monitor can always be disabled', async () => {
  const b=fake(); let fail=false; const original=b.call.bind(b);
  b.call=async(s,m,p)=>{if(m==='Bag'){if(fail)throw new Error('背包断线');return{body:wMsg(1,wMsg(1,encCat(wVarint(1,20516),wVarint(2,3))))};}return original(s,m,p);};
  b.evaluate=async()=>({available:true,seeds:[{seed:20516,name:'狗尾草',canPlant:true}]});
  const a=new FarmApp({bridge:b,journal:false}); a.submit('refresh',{},'bag-ready-01'); await a.tail;
  assert.equal(a.inventory.status,'ready'); assert.equal(a.seeds.length,1);
  a.setMonitor({enabled:true,intervalSec:60,seedId:20516});
  fail=true; a.submit('refresh',{},'bag-failed-01'); await a.tail;
  assert.equal(a.inventory.status,'error'); assert.equal(a.seeds.length,0);
  assert.doesNotThrow(()=>a.setMonitor({enabled:false})); assert.equal(a.monitor.enabled,false); assert.equal(a.monitor.seedId,20516);
  await a.close();
});
test('HTTP friend commands preserve target GID, idempotency and read-only preview', async () => {
  const a=new FarmApp({demo:true,journal:false}); await a.friendService.refresh();
  const targets=a.friendService.state().friends.filter(f=>f.hasSummary&&!f.isSelf);
  const server=createServer(a); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=body=>fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json','X-Farm-Request':'1'},body:JSON.stringify(body)});
  try {
    const response=await post({type:'friend-visit',gid:targets[0].gid,commandId:'http-friend-001'});
    assert.equal(response.status,202); const job=await response.json(); await a.tail;
    assert.equal(a.ids.get(job.id).status,'succeeded'); assert.equal(a.friendService.state().preview.gid,targets[0].gid); assert.equal(a.friendService.activeGid,0);
    assert.equal((await post({type:'friend-visit',gid:targets[0].gid+1,commandId:'http-friend-001'})).status,409);
    assert.equal((await post({type:'friend-visit',gid:String(targets[0].gid),commandId:'http-friend-002'})).status,400);
    assert.equal((await post({type:'friend-insect',commandId:'http-friend-003'})).status,400);
  } finally {server.closeStreams();await new Promise(r=>server.close(r));await a.close();}
});
test('friend write timeout stops the batch, leaves, and locks further writes without replay', async () => {
  const b=fake(); const original=b.call.bind(b); const visits=[];
  const person=(id,summary)=>wMsg(1,encCat(wVarint(1,id),...(summary?[wMsg(9,wVarint(6,1))]:[])));
  const friendLand=wMsg(2,encCat(wVarint(1,1),wVarint(2,1),wMsg(10,encCat(wVarint(1,1020002),wMsg(4,encCat(wVarint(1,6),wVarint(2,1))),wVarint(16,1),wVarint(18,5)))));
  b.call=async(s,m,p)=>{
    if(m==='GetAll')return{body:encCat(person(123,false),person(456,true),person(789,true))};
    if(s==='gamepb.visitpb.VisitService'){visits.push(m);return{body:m==='Enter'?friendLand:Buffer.alloc(0)};}
    return original(s,m,p);
  };
  b.fail=Object.assign(new Error('socket reset after send'),{code:'ECONNRESET'}); const a=new FarmApp({bridge:b,journal:false});
  const job=a.submit('friend-steal',{},'friend-timeout-01'); await a.tail;
  assert.equal(job.status,'uncertain'); assert.equal(a.needsReconcile,true); assert.equal(b.writes.length,1); assert.deepEqual(visits,['Enter','Leave']); assert.equal(a.friendService.activeGid,0);
  assert.equal(num(parse(b.writes[0].bytes),2),456); assert.equal(num(parse(b.writes[0].bytes),3),1);
  assert.equal(a.submit('friend-steal',{},'friend-timeout-01'),job);
  const blocked=a.submit('harvest',{},'friend-lock-001'); await a.tail; assert.equal(blocked.status,'failed'); assert.equal(b.writes.length,1);
  await a.close();
});
test('one-key care handles self with scene 0 then scans summary-zero friend with scene 2', async () => {
  const b=fake(); const original=b.call.bind(b); let ownCare=true,friendCare=true;
  const crop=(id,care)=>encCat(wVarint(1,id),wVarint(2,1),wMsg(10,encCat(wVarint(1,1020002),wMsg(4,encCat(wVarint(1,6),wVarint(2,1))),...(care?[wVarint(12,999)]:[]))));
  b.call=async(s,m,p)=>{
    if(m==='AllLands')return{body:wMsg(1,crop(1,ownCare))};
    if(m==='GetAll')return{body:encCat(wMsg(1,wVarint(1,123)),wMsg(1,encCat(wVarint(1,456),wMsg(9,Buffer.alloc(0)))))};
    if(s==='gamepb.visitpb.VisitService')return{body:m==='Enter'?wMsg(2,crop(2,friendCare)):Buffer.alloc(0)};
    if(m==='Farming'){
      const host=num(parse(p),2); if(host===0)ownCare=false;else friendCare=false;
      b.writes.push({method:m,bytes:p});
      return{body:wMsg(3,encCat(wVarint(1,host===0?1:2),wMsg(2,encCat(wVarint(1,1001),wVarint(2,2)))))};
    }
    return original(s,m,p);
  };
  const a=new FarmApp({bridge:b,journal:false}); const job=a.submit('care',{},'care-all-0001'); await a.tail;
  assert.equal(job.status,'succeeded'); assert.equal(job.result.selfCount,1); assert.equal(job.result.friendCount,1); assert.equal(job.result.count,2); assert.equal(job.result.rewardTotal,4);
  assert.deepEqual(b.writes.map(w=>[num(parse(w.bytes),2),num(parse(w.bytes),4)]),[[0,0],[456,2]]); await a.close();
});
test('Bridge closes pending requests and removes stale runtime contexts', async () => {
  const b=new Bridge(); b.ws={readyState:1,send(){},close(){}};
  const pending=b._send('Runtime.evaluate',{},1000); b.close();
  await assert.rejects(pending,/CDP 已关闭/); assert.equal(b._pending.size,0); assert.equal(b.ctxId,null);
});
