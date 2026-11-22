import test from 'node:test';
import assert from 'node:assert/strict';
import { FriendsService } from './friends.mjs';
import { encCat, wMsg, wVarint, wBytes, wPackedInts, parse, num, repeatedInts } from '../tools/farm.mjs';

const text = (no,value) => wBytes(no,Buffer.from(value));
const friend = (gid, { summary = true, stealable = 1, weed = 0, insect = 0 } = {}) => wMsg(1, encCat(wVarint(1,gid),text(3,'好友'+gid),wVarint(6,10),...(summary?[wMsg(9,encCat(wVarint(6,stealable),wVarint(8,weed),wVarint(9,insect)))]:[])));
const friends = (...entries) => encCat(friend(1,{summary:false}),...entries);
const land = (id,{ phase=6, begin=1, locked=false, master=0, stealable=true, fruit=5, weed=[], insect=[], stealers=[], natural=false }={}) => wMsg(2,encCat(
  wVarint(1,id), wVarint(2,locked?0:1), wVarint(13,master),
  wMsg(10,encCat(wVarint(1,1020002),text(2,'白萝卜'),wMsg(4,encCat(wVarint(1,phase),wVarint(2,begin),...(natural?[wVarint(7,1)]:[]))),wVarint(16,stealable?1:0),wVarint(18,fruit),wPackedInts(12,weed),wPackedInts(13,insect),wPackedInts(14,stealers)))));
const business = code => Object.assign(new Error('明确业务拒绝 '+code),{code});
function setup({list=friends(friend(2)), visit=encCat(land(1)), handler}={}) {
  const calls=[];
  const bridge={async call(service,method,body,timeout){
    const call={service,method,body,timeout}; calls.push(call);
    if(handler){const answer=await handler(call,calls);if(answer!==undefined)return answer;}
    if(method==='GetAll')return{body:typeof list==='function'?list():list};
    if(method==='Enter')return{body:typeof visit==='function'?visit(call):visit};
    return{body:Buffer.alloc(0)};
  }};
  const module=new FriendsService({bridge}); module._pause=async()=>{};
  return{module,calls,bridge};
}
const writeCalls=calls=>calls.filter(call=>call.service==='gamepb.plantpb.PlantService');

test('refresh uses only full FriendService.GetAll, authoritative self and snapshot copies', async()=>{
  const {module,calls}=setup({list:friends(friend(2,{stealable:3,weed:4,insect:5}))});
  const state=await module.refresh();
  assert.equal(calls.length,1);assert.equal(calls[0].service,'gamepb.friendpb.FriendService');assert.equal(calls[0].method,'GetAll');assert.equal(calls[0].timeout,15000);
  assert.equal(module.selfGid,1);assert.equal(state.account.gid,1);assert.equal(state.friends[0].isSelf,true);
  assert.deepEqual(state.friends[1],{gid:2,name:'好友2',level:10,hasSummary:true,stealable:3,weed:4,insect:5,isSelf:false});
  state.friends.length=0;assert.equal(module.state().friends.length,2);
});
test('visit decodes lands and always leaves, preserves preview on same-account refresh', async()=>{
  const {module,calls}=setup({visit:encCat(land(5),land(6,{master:5}))});
  const result=await module.run('friend-visit',2);
  assert.equal(result.count,0);assert.equal(result.scanned,1);assert.equal(result.preview.lands[1].masterLandId,5);
  assert.deepEqual(calls.map(c=>c.method),['GetAll','Enter','Leave']);assert.equal(module.activeGid,0);
  await module.refresh();assert.equal(module.state().preview.gid,2);
});
test('steal requires a mature crop as well as summary and fruit eligibility',async()=>{
  const visit=encCat(land(1,{phase:6}),land(2,{phase:2}),land(3,{master:2}),land(4,{locked:true}),land(5,{phase:7}),land(6,{stealable:false}),land(7,{fruit:0}));
  const {module,calls}=setup({list:friends(friend(2,{stealable:0}),friend(3)),visit});
  const result=await module.run('friend-steal');const write=writeCalls(calls)[0];const body=parse(write.body);
  assert.equal(result.count,1);assert.equal(result.scanned,1);assert.equal(result.attemptedWrites,1);assert.equal(result.changed,true);
  assert.equal(num(body,2),3);assert.equal(num(body,3),1);assert.deepEqual(repeatedInts(body,1),[1]);
  assert.equal(calls.filter(c=>c.method==='Enter').length,1);assert.equal(calls.at(-1).method,'Leave');
});
test('one-click steal sends all eligible plots in one Harvest regardless of placement limit',async()=>{
  const {module,calls}=setup({visit:encCat(...Array.from({length:10},(_,i)=>land(i+1)))});
  module.maxPerFriend=6;const result=await module.run('friend-steal',2);
  assert.equal(result.count,10);assert.equal(writeCalls(calls).length,1);assert.equal(repeatedInts(parse(writeCalls(calls)[0].body),1).length,10);assert.equal(num(parse(writeCalls(calls)[0].body),3),1);
});
test('invalid/missing gid, self and no-summary targets cannot be operated on',async()=>{
  const {module,calls}=setup();
  for(const gid of [null,0,-1,'2',1.2,Number.MAX_SAFE_INTEGER+1])await assert.rejects(module.run('friend-steal',gid),/安全正整数/);
  for(const type of ['friend-visit','friend-insect','friend-weed'])await assert.rejects(module.run(type),/必须指定/);
  await assert.rejects(module.run('friend-visit',1),/其他好友/);
  assert.equal(writeCalls(calls).length,0);
});
test('identity ambiguity rejects writes; explicit positive self is fallback only when no missing-summary entry',async()=>{
  const ambiguous=setup({list:encCat(friend(1,{summary:false}),friend(4,{summary:false}),friend(2))});
  await assert.rejects(ambiguous.module.run('friend-steal'),/唯一确认/);assert.equal(writeCalls(ambiguous.calls).length,0);
  const {bridge,calls}=setup({list:friend(2)});const module=new FriendsService({bridge,selfGid:1});module._pause=async()=>{};
  assert.equal((await module.run('friend-steal')).count,1);assert.equal(writeCalls(calls).length,1);
});
test('empty, malformed or rejected Enter still leaves; transport/decode errors stop later friends',async()=>{
  for(const problem of ['empty','malformed','timeout']){
    const {module,calls}=setup({list:friends(friend(2),friend(3)),handler:async call=>{
      if(call.method==='Enter'){if(problem==='timeout')throw new Error('CDP 超时');return{body:problem==='empty'?Buffer.alloc(0):Buffer.from([0x12,0x80])};}
    }});
    await assert.rejects(module.run('friend-steal'));
    assert.deepEqual(calls.map(c=>c.method),['GetAll','Enter','Leave']);assert.equal(module.activeGid,0);
  }
  const {module,calls}=setup({list:friends(friend(2),friend(3)),handler:async call=>{if(call.method==='Enter'&&num(parse(call.body),1)===2)throw business(1001001);}});
  const result=await module.run('friend-steal');assert.equal(result.count,1);assert.equal(result.errors.length,1);assert.equal(calls.filter(c=>c.method==='Leave').length,2);
});
test('ambiguous write is never retried or reported successful',async()=>{
  const original=Object.assign(new Error('Harvest 超时，结果未知'),{uncertain:true});
  const {module,calls}=setup({list:friends(friend(2),friend(3)),handler:async call=>{if(call.method==='Harvest')throw original;}});
  await assert.rejects(module.run('friend-steal'),error=>error===original&&error.uncertain&&error.partialResult.count===0&&error.partialResult.attemptedWrites===1);
  assert.equal(writeCalls(calls).length,1);assert.equal(calls.at(-1).method,'Leave');assert.equal(calls.filter(c=>c.method==='Enter').length,1);
});
test('Leave failure is terminal and retains uncertain operation error; ensureHome retries only Leave',async()=>{
  let leaveFail=true;
  const original=Object.assign(new Error('写入响应丢失'),{uncertain:true});
  const {module,calls}=setup({list:friends(friend(2),friend(3)),handler:async call=>{
    if(call.method==='Harvest')throw original;
    if(call.method==='Leave'&&leaveFail)throw business(12345);
  }});
  await assert.rejects(module.run('friend-steal'),error=>error.cleanupFailed&&error.uncertain&&error.visitGid===2&&error.operationError===original&&error.cause.code===12345&&/写入响应丢失/.test(error.message));
  assert.equal(module.activeGid,2);assert.equal(calls.filter(c=>c.method==='Enter').length,1);
  module.invalidate();assert.equal(module.activeGid,2);assert.equal(module.state().status,'not-loaded');
  leaveFail=false;await module.ensureHome();assert.equal(module.activeGid,0);assert.equal(calls.at(-1).method,'Leave');assert.equal(writeCalls(calls).length,1);
});
test('shared quota is required, respected across weed/insect, and no self-farm RPC is used',async()=>{
  const {module,calls}=setup({visit:encCat(land(1),land(2),land(3,{insect:[5]}),land(4,{weed:[5]}),land(5,{phase:7}),land(6,{phase:0}),land(7,{master:1}))});
  await assert.rejects(module.run('friend-insect',2),/额度未知/);assert.equal(writeCalls(calls).length,0);
  module.updateLimits([{id:10003,dayTimes:98,dayLimit:100}]);
  const result=await module.run('friend-insect',2);assert.equal(result.count,2);assert.equal(module.state().quota.remaining,0);
  for(const call of writeCalls(calls)){assert.equal(call.method,'PutInsects');assert.equal(num(parse(call.body),1),2);assert.equal(repeatedInts(parse(call.body),2).length,1);}
  const before=writeCalls(calls).length;const weed=await module.run('friend-weed',2);assert.equal(weed.count,0);assert.equal(writeCalls(calls).length,before);
  assert.equal(calls.some(c=>c.method==='AllLands'),false);
});
test('single-land weed/insect business rejections continue, quota rejection stops globally',async()=>{
  let writes=0;
  const {module,calls}=setup({visit:encCat(land(1),land(2),land(3),land(4)),handler:async call=>{
    if(call.method==='PutWeeds'){writes++;if(writes===1)throw business(1001036);if(writes===3)throw business(1001046);}
  }});
  module.updateLimits([{id:10003,dayTimes:0,dayLimit:100}]);
  const result=await module.run('friend-weed',2);
  assert.equal(result.count,1);assert.equal(result.errors.length,2);assert.equal(result.stopped,true);assert.equal(writeCalls(calls).length,3);assert.equal(module.quota.remaining,0);assert.equal(calls.at(-1).method,'Leave');
});
test('per-land transport error stops immediately while preserving prior success',async()=>{
  let writes=0;const {module,calls}=setup({visit:encCat(land(1),land(2),land(3)),handler:async call=>{if(call.method==='PutInsects'&&++writes===2)throw new Error('ECONNRESET');}});
  module.updateLimits([{id:10003,dayTimes:0,dayLimit:100}]);
  await assert.rejects(module.run('friend-insect',2),error=>error.partialResult.count===1&&error.partialResult.attemptedWrites===2&&error.partialResult.changed);
  assert.equal(writeCalls(calls).length,2);assert.equal(calls.at(-1).method,'Leave');
});
test('care scans summary-zero friends, decodes rewards, only main lands, at most 3 Enter/Leave rounds',async()=>{
  const {module,calls}=setup({list:friends(friend(2,{weed:0,insect:0})),visit:encCat(land(1,{natural:true}),land(2,{weed:[7]}),land(3,{insect:[7],master:1}),land(4,{phase:7,weed:[7]})),handler:async call=>{
    if(call.method==='Farming')return{body:encCat(wMsg(3,encCat(wVarint(1,1),wMsg(2,encCat(wVarint(1,1101),wVarint(2,2))))),wMsg(3,wVarint(1,2)))};
  }});
  const result=await module.run('friend-care');assert.equal(result.scanned,1);assert.equal(result.count,6);assert.equal(result.rewardTotal,6);assert.equal(result.rounds,3);
  assert.equal(calls.filter(c=>c.method==='Enter').length,3);assert.equal(calls.filter(c=>c.method==='Leave').length,3);
  for(const call of writeCalls(calls)){const request=parse(call.body);assert.equal(call.timeout,25000);assert.equal(num(request,2),2);assert.equal(num(request,4),2);assert.deepEqual(repeatedInts(request,1),[1,2]);}
});
test('care business 1001057 converges and still leaves',async()=>{
  const {module,calls}=setup({visit:land(1,{weed:[9]}),handler:async call=>{if(call.method==='Farming')throw business(1001057);}});
  const result=await module.run('friend-care',2);assert.equal(result.count,0);assert.equal(result.errors.length,0);assert.equal(result.rounds,1);assert.equal(calls.at(-1).method,'Leave');
});
test('refresh failure never leaves stale friends usable and account change clears preview',async()=>{
  let list=friends(friend(2));let fail=false;
  const {module,calls}=setup({list:()=>list,handler:async call=>{if(call.method==='GetAll'&&fail)throw new Error('GetAll 断线');}});
  await module.run('friend-visit',2);assert.ok(module.preview);
  list=encCat(friend(5,{summary:false}),friend(2));await module.refresh();assert.equal(module.selfGid,5);assert.equal(module.preview,null);
  fail=true;await assert.rejects(module.run('friend-steal'),/断线/);assert.equal(module.status,'error');assert.equal(module.friends.length,0);assert.equal(writeCalls(calls).length,0);
});
test('unknown phases and truncated owners stop unsafe candidate selection',async()=>{
  const unknown=setup({visit:land(1,{phase:99})});unknown.module.updateLimits([{id:10003,dayTimes:0,dayLimit:100}]);
  assert.equal((await unknown.module.run('friend-weed',2)).count,0);assert.equal(writeCalls(unknown.calls).length,0);
  const malformed=wMsg(2,encCat(wVarint(1,1),wVarint(2,1),wMsg(10,encCat(wVarint(1,1020002),wMsg(4,encCat(wVarint(1,2),wVarint(2,1))),wBytes(12,Buffer.from([0x80]))))));
  const strict=setup({visit:malformed});await assert.rejects(strict.module.run('friend-care',2),/truncated/);assert.equal(strict.calls.at(-1).method,'Leave');assert.equal(writeCalls(strict.calls).length,0);
});
test('uncertain flag remains terminal even if an error also carries a business code',async()=>{
  const {module,calls}=setup({list:friends(friend(2),friend(3)),handler:async call=>{if(call.method==='Harvest')throw Object.assign(business(1001046),{uncertain:true});}});
  await assert.rejects(module.run('friend-steal'),error=>error.uncertain===true);assert.equal(calls.filter(c=>c.method==='Enter').length,1);assert.equal(writeCalls(calls).length,1);
});
test('runtime identity resolves two missing-summary entries and overrides stale explicit gid',async()=>{
  const {module,calls}=setup({list:friends(friend(4,{summary:false}),friend(2))});
  module.explicitSelfGid=4;module.identityProvider=async()=>({gid:1,name:'实时登录农场主',level:63});
  const result=await module.run('friend-steal');assert.equal(result.count,1);assert.equal(module.selfGid,1);
  assert.equal(module.account.name,'实时登录农场主');assert.equal(module.account.level,63);assert.equal(module.state().identitySource,'游戏当前登录资料');
  assert.equal(module.friends.find(friend=>friend.gid===1).isSelf,true);assert.equal(module.friends.find(friend=>friend.gid===4).isSelf,false);
  assert.deepEqual(calls.filter(call=>call.method==='Enter').map(call=>num(parse(call.body),1)),[2]);
});
test('runtime identity is read afresh, account changes clear preview, and invalidation clears profile',async()=>{
  let identity={gid:1,name:'旧账号',level:3},reads=0;
  const {module}=setup({list:friends(friend(4,{summary:false}),friend(2))});
  module.identityProvider=async()=>{reads++;return identity;};
  await module.run('friend-visit',2);assert.equal(module.preview.gid,2);
  await module.refresh();assert.equal(module.preview.gid,2);
  identity={gid:4,name:'新账号',level:63};await module.refresh();assert.equal(module.selfGid,4);assert.equal(module.preview,null);assert.equal(module.account.name,'新账号');assert.equal(reads,3);
  module.invalidate();assert.equal(module.account,null);assert.equal(module.identitySource,null);
});
test('valid runtime gid absent from GetAll fails closed, provider failure only uses conservative fallback',async()=>{
  const absent=setup();absent.module.identityProvider=async()=>({gid:999,name:'不匹配'});
  await assert.rejects(absent.module.run('friend-steal'),/登录资料与好友列表身份不一致/);
  assert.equal(absent.module.status,'error');assert.equal(absent.module.friends.length,0);assert.equal(writeCalls(absent.calls).length,0);
  const failure=setup({list:friends(friend(4,{summary:false}),friend(2))});failure.module.identityProvider=async()=>{throw new Error('未加载');};
  await assert.rejects(failure.module.run('friend-steal'),/唯一确认/);assert.equal(writeCalls(failure.calls).length,0);
  const unique=setup();unique.module.identityProvider=async()=>{throw new Error('未加载');};assert.equal((await unique.module.run('friend-steal')).count,1);assert.equal(unique.module.identitySource,'好友列表唯一无摘要条目');
});
test('demo uses independent in-memory fixtures without bridge and simulates visits/actions',async()=>{
  const bridge={call(){throw new Error('demo must not connect');}};
  const a=new FriendsService({bridge,demo:true});const b=new FriendsService({bridge,demo:true});
  const state=await a.refresh();const gid=state.friends.find(f=>!f.isSelf).gid;
  assert.equal((await a.run('friend-visit',gid)).preview.lands.length,2);
  assert.equal((await a.run('friend-steal',gid)).count,1);
  assert.equal((await a.run('friend-steal',gid)).count,0);
  assert.equal((await b.run('friend-steal',gid)).count,1);
  assert.equal((await a.run('friend-care',gid)).count,1);
  assert.equal(a.activeGid,0);
});

test('unripe but stealable crops cause no Harvest RPC or business rejection',async()=>{
 const {module,calls}=setup({visit:encCat(land(1,{phase:2}),land(2,{phase:5}))});const result=await module.run('friend-steal');assert.equal(result.count,0);assert.equal(result.attemptedWrites,0);assert.equal(writeCalls(calls).length,0);assert.equal(result.errors.length,0);assert.equal(calls.at(-1).method,'Leave');
});

test('future mature time never produces a steal request even with a positive steal flag',async()=>{const {module,calls}=setup({visit:encCat(land(1,{phase:6,begin:Math.floor(Date.now()/1000)+600}))});const result=await module.run('friend-steal');assert.equal(result.count,0);assert.equal(writeCalls(calls).length,0);});


test('native one-click steal omits already-stolen-by-self plots but includes every other eligible plot in one request',async()=>{
 const visit=encCat(...Array.from({length:24},(_,i)=>land(i+1,{stealers:i<6?[1,99]:[99]})));const {module,calls}=setup({visit});const result=await module.run('friend-steal',2);const writes=writeCalls(calls);assert.equal(writes.length,1);assert.equal(result.count,18);assert.equal(result.attemptedWrites,1);assert.deepEqual(repeatedInts(parse(writes[0].body),1),Array.from({length:18},(_,i)=>i+7));assert.equal(num(parse(writes[0].body),2),2);assert.equal(num(parse(writes[0].body),3),1);
});
test('all plots already stolen by self produce no Harvest while mature crops remain visible',async()=>{
 const{module,calls}=setup({visit:encCat(land(1,{stealers:[1]}),land(2,{stealers:[1,9]}))});const result=await module.run('friend-steal');assert.equal(result.count,0);assert.equal(writeCalls(calls).length,0);
});
test('packed and unpacked stealers match native codec; malformed stealer data fails before write',async()=>{
 const{decodePlantInfo}=await import('../tools/farm.mjs');assert.deepEqual(decodePlantInfo(wPackedInts(14,[1229136306,123])).stealers,[1229136306,123]);assert.deepEqual(decodePlantInfo(encCat(wVarint(14,1229136306),wVarint(14,123))).stealers,[1229136306,123]);
 const broken=wMsg(2,encCat(wVarint(1,1),wVarint(2,1),wMsg(10,encCat(wVarint(1,1020002),wMsg(4,encCat(wVarint(1,6),wVarint(2,1))),wVarint(16,1),wVarint(18,5),wBytes(14,Buffer.from([0x80]))))));const{module,calls}=setup({visit:broken});await assert.rejects(module.run('friend-steal'));assert.equal(writeCalls(calls).length,0);assert.equal(calls.at(-1).method,'Leave');
});
