import { randomInt } from 'node:crypto';

const SERVICES = {
  'gamepb.animalpb.AnimalService': { namespace: 'animalpb', read: ['GetRanchDetail'], write: ['PlaceAnimal','TriggerProduce','HarvestRanch','StealProduce','FeedAnimal','DonateAnimal'] },
  'gamepb.animalpb.RanchService': { namespace: 'animalpb', read: ['GetRanchOpTimes'], write: ['PutHazard','CleanRanch','CleanAllRanch','StrokeAnimal'] },
  'gamepb.shoppb.ShopService': { namespace: 'shoppb', read: ['ShopProfiles','ShopInfo'], write: ['BuyGoods'] },
  'gamepb.itempb.ItemService': { namespace: 'itempb', read: ['Bag','GetBag','GetBagTab'], write: [] },
  'gamepb.friendpb.FriendService': { namespace: 'friendpb', read: ['GetAll'], write: [] },
  'gamepb.homesteadpb.HomesteadService': { namespace: 'homesteadpb', read: ['AllCells','GetFacilityInfo','GetFacilityDetail'], write: [] },
  'gamepb.homesteadpb.FeedMachineService': { namespace: 'homesteadpb', read: [], write: ['AddFeed'] },
  'gamepb.visitpb.VisitService': { namespace: 'visitpb', read: [], write: ['EnterHomestead','LeaveHomestead'] },
};
export const identityExpression = `(() => {
  const model = globalThis.System?.get('chunks:///_virtual/GlobalData.ts')?.GlobalData?.selfModel;
  if (!model?.gid) return null;
  return { gid: Number(model.gid.toString()), name: String(model.name || ''), level: Number(model.level || 0) };
})()`;
export const pastureMetadataExpression = `(() => {
  const factory = System.get('chunks:///_virtual/Oops.ts')?.oops?.configFactory;
  if (!factory?.configs) throw new Error('游戏物品配置尚未加载');
  // Use the public getter: registered MC tables may still be pending with their
  // raw resource already cached. Reading the private map bypasses lazy parsing.
  const rows = name => {
    const config=typeof factory.getConfig==='function' ? factory.getConfig(name) : factory.configs.get(name);
    const map=config?._configMap;
    return map instanceof Map ? Array.from(map.values()) : Object.values(map || {});
  };
  const animals = rows('MCAnimalConfig').filter(a=>a.enable_flag !== false).map(a=>({
    animalId:Number(a.id),itemId:Number(a.cub_item_id),name:String(a.name || a.id),
    husbandryType: ['窝','COOP','HUSBANDRY_TYPE_COOP','1'].includes(String(a.husbandry_type)) ? 1 : ['棚','SHED','HUSBANDRY_TYPE_SHED','2'].includes(String(a.husbandry_type)) ? 2 : 0,
  }));
  if (!animals.length) throw new Error('牧场动物配置尚未加载');
  const goods=rows('MCGoods').filter(g=>[5,6].includes(Number(g.shop_id))).map(g=>({id:Number(g.id),shop_id:Number(g.shop_id),item_id:Number(g.item_id),price_id:Number(g.price_id),price_count:Number(g.price_count)}));
  const wanted=new Set([7001,1007,1008,...animals.map(a=>a.itemId),...goods.map(g=>g.item_id)]);
  const items=rows('ItemInfo').filter(i=>wanted.has(Number(i.id))).map(i=>({id:Number(i.id),name:String(i.name || i.id),type:Number(i.type)}));
  return {animals,goods,items};
})()`;

function rejected(error) {
  if (error?.uncertain || error?.cleanupFailed) return false;
  const raw=error?.code ?? error?.gateway?.meta?.err;
  const code=typeof raw==='number'?raw:typeof raw==='string'&&/^\d+$/.test(raw)?Number(raw):0;
  return Number.isSafeInteger(code)&&code>0;
}

/** Uses only the currently loaded game serializers and its existing encrypted transport.
 * This class never imports game bundles, changes scenes or accepts arbitrary RPC names. */
export class NativeGameRpc {
  constructor({bridge,onWrite=()=>{}}) { this.bridge=bridge; this.onWrite=onWrite; }
  async identity() { return this.bridge.evaluate(identityExpression,{timeoutMs:3000}); }
  async metadata() { return this.bridge.evaluate(pastureMetadataExpression,{timeoutMs:5000}); }
  async call(service,method,request={},options={}) {
    const spec=SERVICES[service];
    const write=!!spec?.write.includes(method);
    if (!spec || (!write&&!spec.read.includes(method))) throw new Error('牧场 RPC 不在允许列表');
    if (options.write === false && write) throw new Error('写接口不能声明为只读');
    if (!request || typeof request!=='object'||Array.isArray(request)) throw new Error('RPC 参数必须为对象');
    const json=JSON.stringify(request);
    if (Buffer.byteLength(json)>65536) throw new Error('牧场批量参数过大');
    const encoded=await this.bridge.evaluate(`(() => {
      const Type=System.get('chunks:///_virtual/${spec.namespace}.ts')?.gamepb?.${spec.namespace}?.${method}Request;
      if (typeof Type?.encode!=='function') throw new Error('当前游戏未加载 ${method}Request');
      return Array.from(Type.encode(${json}).finish());
    })()`,{timeoutMs:5000});
    if (!Array.isArray(encoded) || encoded.some(v=>!Number.isInteger(v)||v<0||v>255)) throw new Error('请求编码结果无效');
    if (write) this.onWrite(service,method);
    let reply;
    try { reply=await this.bridge.call(service,method,Buffer.from(encoded),options.timeoutMs||25000); }
    catch(error) { if(write&&!rejected(error)) error.uncertain=true; throw error; }
    try {
      if (!Buffer.isBuffer(reply?.body)) throw new Error('游戏回包缺少 protobuf body');
      const hex=reply.body.toString('hex');
      return await this.bridge.evaluate(`(() => {
        const Type=System.get('chunks:///_virtual/${spec.namespace}.ts')?.gamepb?.${spec.namespace}?.${method}Reply;
        if (typeof Type?.decode!=='function') throw new Error('当前游戏未加载 ${method}Reply');
        const bytes=new Uint8Array((${JSON.stringify(hex)}.match(/../g)||[]).map(value=>parseInt(value,16)));
        const plain=value=>{
          if (Array.isArray(value)) return value.map(plain);
          if (value&&typeof value==='object') {
            if (Number.isInteger(value.low)&&Number.isInteger(value.high)) return value.toString();
            return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,plain(child)]));
          }
          return value;
        };
        return plain(Type.decode(bytes));
      })()`,{timeoutMs:8000});
    } catch(error) { if(write) error.uncertain=true; throw error; }
  }
}

// Diagnostic clients may coexist with the Web bridge on the CDP proxy.
export function isolateCdpIds(bridge) { bridge._id=randomInt(1000000000,2000000000); return bridge; }
