// Explicitly allowlisted read-only RPC acceptance. No Enter/Leave or writes.
import { Bridge } from './core.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const b = new Bridge(); b._id = 1000000000 + Math.floor(Math.random() * 1000000000);
const allowed = new Set(['animalpb.AnimalService.GetRanchDetail','animalpb.RanchService.GetRanchOpTimes','homesteadpb.HomesteadService.AllCells','homesteadpb.MainCityService.GetMainCityInfo','shoppb.ShopService.ShopProfiles','shoppb.ShopService.ShopInfo','friendpb.FriendService.GetAll']);
const results = [];
async function query(ns, service, method, request) {
  if (!allowed.has(`${ns}.${service}.${method}`)) throw new Error('RPC outside read-only allowlist');
  const encoded = await b.evaluate(`Array.from(System.get('chunks:///_virtual/${ns}.ts').gamepb.${ns}.${method}Request.encode(${JSON.stringify(request)}).finish())`);
  try {
    const reply = await b.call(`gamepb.${ns}.${service}`, method, Buffer.from(encoded));
    const hex = reply.body.toString('hex');
    const decoded = await b.evaluate(`(() => {
      const bytes = new Uint8Array((${JSON.stringify(hex)}.match(/../g) || []).map(s => parseInt(s,16)));
      const Type = System.get('chunks:///_virtual/${ns}.ts').gamepb.${ns}.${method}Reply;
      const plain = value => {
        if (Array.isArray(value)) return value.map(plain);
        if (value && typeof value === 'object') {
          if (Number.isInteger(value.low) && Number.isInteger(value.high)) return value.toString();
          return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
        }
        return value;
      };
      const data = plain(Type.decode(bytes));
      ${method === 'GetAll' ? `return { game_friends: (data.game_friends || []).map(f=>({gid:f.gid,name:f.name,host_type:f.host_type,big_farm_status:f.big_farm_status,main_city_level:f.main_city_level,big_farm_level:f.big_farm_level})), count: data.game_friends?.length || 0 };` : 'return data;'}
    })()`);
    const item = { rpc: `gamepb.${ns}.${service}.${method}`, request, ok: true, bytes: reply.body.length, decoded };
    results.push(item); return decoded;
  } catch (error) {
    results.push({ rpc: `gamepb.${ns}.${service}.${method}`, request, ok: false, code: error.code || null, error: error.message });
    return null;
  }
}
try {
  await b.ensure();
  const metadata = await b.evaluate(`(() => {
    const s=System, config=s.get('chunks:///_virtual/Oops.ts').oops.configFactory.configs;
    const rows=name=>{const c=config.get(name)?._configMap;return c instanceof Map?Array.from(c.values()):Object.values(c||{});};
    const self=s.get('chunks:///_virtual/GlobalData.ts').GlobalData.selfModel;
    return { selfGid: Number(self.gid.toString()), animalConfigSample: rows('MCAnimalConfig').slice(0,4), operations: rows('MCRanchOperation'), facilityConfigSample:rows('MCRanchFacilityConfig').slice(0,3), shopConfigSample: rows('MCShop').filter(r=>[5,6].includes(Number(r.id))).slice(0,4), globalSceneIds:s.get('chunks:///_virtual/common.ts').GlobalSceneId, hazards:s.get('chunks:///_virtual/RanchHazardConfig.ts').RanchHazardOperationId };
  })()`);
  await query('animalpb','AnimalService','GetRanchDetail',{host_gid:metadata.selfGid,ranch_inst_ids:[]});
  const opIds = Object.values(metadata.hazards).filter(v=>typeof v==='number');
  await query('animalpb','RanchService','GetRanchOpTimes',{op_ids:opIds});
  await query('shoppb','ShopService','ShopProfiles',{global_scene_id:metadata.globalSceneIds.GLOBAL_SCENE_ID_OLD_FARM});
  const shops = await query('shoppb','ShopService','ShopProfiles',{global_scene_id:metadata.globalSceneIds.GLOBAL_SCENE_ID_BIG_FARM});
  for (const profile of shops?.shop_profiles || []) {
    if ([5,6].includes(Number(profile.shop_type))) await query('shoppb','ShopService','ShopInfo',{shop_id:profile.shop_id});
  }
  await query('friendpb','FriendService','GetAll',{global_scene_id:metadata.globalSceneIds.GLOBAL_SCENE_ID_OLD_FARM});
  const friends = await query('friendpb','FriendService','GetAll',{global_scene_id:metadata.globalSceneIds.GLOBAL_SCENE_ID_BIG_FARM});
  const target = friends?.game_friends?.find(f=>Number(f.gid)!==metadata.selfGid && f.big_farm_status);
  if (target) await query('animalpb','AnimalService','GetRanchDetail',{host_gid:Number(target.gid),ranch_inst_ids:[]});
  await query('homesteadpb','HomesteadService','AllCells',{});
  const data = { capturedAt:new Date().toISOString(),contextId:b.ctxId,source:'current game native protobuf; explicit read-only RPC allowlist; no Enter/Leave or writes',metadata,results };
  mkdirSync('out/protocol',{recursive:true});
  writeFileSync('out/protocol/pasture-readonly.json',JSON.stringify(data,null,2));
  console.log(JSON.stringify({ artifact:'out/protocol/pasture-readonly.json', metadata:{selfGid:metadata.selfGid,animalConfigSample:metadata.animalConfigSample,operations:metadata.operations}, results:results.map(r=>({rpc:r.rpc,request:r.request,ok:r.ok,bytes:r.bytes,code:r.code,error:r.error,keys:Object.keys(r.decoded||{}),...(r.decoded?.ranches?{ranches:r.decoded.ranches}:{}),...(r.decoded?.shop_profiles?{shops:r.decoded.shop_profiles}:{}),...(r.decoded?.goods_list?{goods:r.decoded.goods_list.slice(0,3),goodsCount:r.decoded.goods_list.length}:{})})) }));
} finally { b.close(); }
