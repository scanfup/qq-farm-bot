import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { NativeGameRpc } from './native-rpc.mjs';
const svc='gamepb.animalpb.AnimalService';
function fixture() {
  const records=[];const types={};
  for(const method of ['GetRanchDetail','HarvestRanch']) {
    types[method+'Request']={encode:request=>({finish:()=>Buffer.from(JSON.stringify(request))})};
    types[method+'Reply']={decode:bytes=>JSON.parse(Buffer.from(bytes).toString()||'{}')};
  }
  const bridge={async evaluate(expression){return JSON.parse(JSON.stringify(vm.runInNewContext(expression,{System:{get:()=>({gamepb:{animalpb:types}})},Buffer})));},async call(service,method,body){records.push({service,method,request:JSON.parse(body.toString())});return{body:Buffer.from('{"ranches":[]}')};}};
  let writes=0;const rpc=new NativeGameRpc({bridge,onWrite:()=>writes++});return{bridge,rpc,records,types,writes:()=>writes};
}
test('native RPC uses the loaded request encoder and reply decoder without flagging reads',async()=>{
  const f=fixture();assert.deepEqual(await f.rpc.call(svc,'GetRanchDetail',{host_gid:123}),{ranches:[]});assert.equal(f.writes(),0);assert.deepEqual(f.records[0].request,{host_gid:123});
});
test('unknown RPC and falsely declared read cannot reach the game transport',async()=>{
  const f=fixture();await assert.rejects(f.rpc.call(svc,'DeleteEverything',{}),/允许列表/);await assert.rejects(f.rpc.call(svc,'HarvestRanch',{}, {write:false}),/只读/);assert.equal(f.records.length,0);assert.equal(f.writes(),0);
});
test('encoding failure occurs before any write attempt',async()=>{
  const f=fixture();delete f.types.HarvestRanchRequest;await assert.rejects(f.rpc.call(svc,'HarvestRanch',{}),/未加载/);assert.equal(f.writes(),0);assert.equal(f.records.length,0);
});
test('a write transport reset or reply decode failure is uncertain, numeric business rejection is final',async()=>{
  const f=fixture();f.bridge.call=async()=>{throw Object.assign(new Error('reset'),{code:'ECONNRESET'})};await assert.rejects(f.rpc.call(svc,'HarvestRanch',{op:1}),e=>e.uncertain===true);assert.equal(f.writes(),1);
  f.bridge.call=async()=>{throw Object.assign(new Error('denied'),{code:1001046})};await assert.rejects(f.rpc.call(svc,'HarvestRanch',{op:1}),e=>!e.uncertain&&e.code===1001046);
  f.bridge.call=async()=>({body:Buffer.from('not json')});await assert.rejects(f.rpc.call(svc,'HarvestRanch',{op:1}),e=>e.uncertain===true);
});
test('request values remain data inside the runtime expression',async()=>{
  const f=fixture();const value='`); globalThis.injected = true; //';await f.rpc.call(svc,'GetRanchDetail',{marker:value});assert.equal(f.records[0].request.marker,value);assert.equal(globalThis.injected,undefined);
});

test('metadata resolves pending cached MC configuration via the public lazy getter',async()=>{
  const reads=[];
  const factory={configs:new Map(),getConfig(name){reads.push(name);const data={MCAnimalConfig:[{id:60001,cub_item_id:60001,name:'鸡',husbandry_type:'窝',enable_flag:true}],MCGoods:[{id:10002,shop_id:5,item_id:60001,price_id:1007,price_count:2}],ItemInfo:[{id:60001,name:'鸡幼崽',type:105},{id:1007,name:'金券',type:102}]}[name]||[];return{_configMap:Object.fromEntries(data.map(x=>[x.id,x]))};}};
  const bridge={async evaluate(expression){return JSON.parse(JSON.stringify(vm.runInNewContext(expression,{System:{get:()=>({oops:{configFactory:factory}})}})));}};
  const result=await new NativeGameRpc({bridge}).metadata();assert.deepEqual(reads,['MCAnimalConfig','MCGoods','ItemInfo']);assert.equal(result.animals[0].name,'鸡');assert.equal(result.goods[0].price_count,2);assert.equal(result.animals[0].husbandryType,1);
});
