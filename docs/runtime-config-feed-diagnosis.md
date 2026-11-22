# ctx7 牧场配置惰性解析与 AddFeed 自家 host 约定

诊断日期：2026-11-20（Asia/Shanghai）。本文件由 pasture-runtime-recovery 只读诊断生成，未修改源文件，未导入模块、切换场景或调用任何业务 RPC（读/写均未调用）。Bridge CDP 请求 ID 使用随机1e9以上起点；每个独立诊断连接均已关闭。

## 1. “牧场动物配置尚未加载”不是 proto 缺失或改名

首先读取了 [native-rpc.mjs](../web/native-rpc.mjs) 当时的 pastureMetadataExpression：它直接 `oops.configFactory.configs.get(name)._configMap`，绕过原生工厂公开 getter。

ctx7 实测：

- System.entries 共2220个已加载模块。
- animalpb.ts、homesteadpb.ts、PastureWorld.ts、MCShop和牧场UI均已加载。
- AnimalService 仍有placeAnimal/triggerProduce/harvestRanch/stealProduce/getRanchDetail/feedAnimal/donateAnimal；RanchService仍有putHazard/cleanRanch/cleanAllRanch/getRanchOpTimes/strokeAnimal。
- GetRanchDetailRequest.encode 已存在。
- MCAnimalConfig、MCGoods、MCItemInfo、MCShop、MCRanchFacilityConfig 的配置实例已经注册，配置路径分别为 mcconfig/对应名称。
- 初次检查这些实例 `_configMap.size=0`、`_configArray.length=0`、`loadingStatus='pending'`；但 `rawTextCache.has(name)=true`，rawLoading=false。
- 当前runtime原始文本长度：MCAnimalConfig13448字符，MCGoods45640字符，MCItemInfo984500字符。不是使用昨天导出。
- 同时旧场景 ItemInfo loaded/map1176、Plant loaded/map323，说明工厂已初始化，只是MC配置尚未按需解析。

## 2. 原生公开 getter 是正确读取路径

从当前运行时读取了工厂函数源码，调用链为：

```js
getConfig(name)
  -> 已注册 configs.get(name)
  -> 若尚未 loaded 且 rawTextCache/rawJsonCache 有该名称
  -> parseConfigSync(name)
     -> decryptBinData(rawText)
     -> JSON.parse
     -> config.fromJsonArray / config.loadConfigs
     -> loadingStatus.set(name, 'loaded')
     -> 删除该raw缓存
  -> 返回已填充配置实例
```

因此rows(name)应通过 `configFactory.getConfig(name)` 读取，而非直接访问 configs map。这个路径在原始缓存已有时同步解析客户端内存，不会调用游戏业务RPC，不需要进入牧场、PlayerSceneLogin、EnterHomestead或System.import。

loadSingleConfig/preloadSingleRawAsset 是同一工厂已经存在的资源加载方法，但当前原始缓存齐全，不需要调用。若以后注册存在但raw缓存和数据都缺失，应报告资源未就绪，再按客户端资源加载链审查；不要恢复昨天的配置伪装当前live数据。

诊断期间另一次只读快照看到MCAnimalConfig变为loaded/map28、MCGoods变为loaded/map194、raw缓存删除，而WorldManager._curType仍是farm。此变化由root并行修复调用公开getter导致，本诊断未调用getConfig/parseConfigSync。它也证明无需切到牧场即可恢复元数据。

## 3. MCItemInfo 与 ItemInfo

为了检查MCItemInfo而不触发配置解析，只对当前rawTextCache中的副本调用了已检查为纯局部转换的 `decryptBinData` 并JSON.parse；检查后MCItemInfo仍pending/map0，未写工厂缓存。

- 当前 MCItemInfo 原始数据1176条。
- 当前已加载 ItemInfo1176条。
- 对所有条目比较 id/name/type：差异0条。
- 1007 金券 type102；1008 松果 type2；7001 牧草 type6；60001鸡、60002鸭、60003鹅均type105。
- MCItemInfo中1007明确描述为牧场专属货币，60001等明确是入窝/棚的幼崽。

建议牧场元数据优先读取已通过公开getter解析的MCItemInfo，ItemInfo作为可证实的fallback；当前两者所需字段完全一致，但不要把本次相等推成未来版本永久相等。

## 4. AddFeed 1045108：自家应使用 watchGid=0

root真实AddFeed请求 `{instance_id:10002,add_count:1,use_gold:false,host_gid:1229136306}` 返回1045108“只有牧场主人”。本诊断没有重发写入。

通过 CDP Runtime.getProperties 获取已加载函数的闭包和只读字符串表索引，解出真实客户端调用，不执行函数业务流程。

### GrassMachineSyncHelper.addGrass

```js
async function addGrass(instanceId, count, useGold) {
  // 校验参数与本地_pending；无场景登录/访问RPC前置
  const epoch = GrassMachineDataHelper.getEpoch();
  const host = GrassMachineDataHelper.getCurrentHostGid();
  const reply = await AddFeed({
    instance_id: instanceId,
    add_count: count,
    use_gold: useGold,
    host_gid: host,
  });
  const capacity = GrassMachineDataHelper.getComp(instanceId)?.capacity ?? 0;
  GrassMachineDataHelper.applyDetail(instanceId, reply.detail, capacity, host, epoch);
  return reply;
}
```

### GrassMachineDataHelper.getCurrentHostGid

```js
const scene = WorldManager.getCurrentScene();
const comp = scene?.isValid ? scene.get(MCWorldEnterComp) : null;
return comp ? Math.max(0, comp.watchGid) : 0;
```

当前只读调用此getter实测返回0，WorldManager._curType为farm。

### 自家与访客的直接判定证据

MCWorldEnterComp.compName="MCWorldEnterComp"，tid43。构造默认watchGid0，reset的解混淆源码为：

```js
this.watchGid = 0;
this.enterReason = MC_UNKNOWN;
this.applied = false;
```

MCWorldEnterHelper.isAtSelfHome：

```js
const scene = getScene();
if (!scene) return false;
const comp = scene.get(MCWorldEnterComp);
return !!comp && comp.watchGid <= 0;
```

MCWorldEnterHelper.enterMcWorld的分支：

```js
(param.watchGid ?? 0) > 0
  ? enterVisit(param, /* 设置comp.watchGid为访客目标 */)
  : (isAtSelfHome() || exitMcWorld(), enterSelf(param), dispatchMC_WORLD_ENTER());
```

结论：AddFeed.host_gid是场景的watchGid语义，自家为0/省略，而不是账号selfGid。即便传值等于自己的gid，只要>0也进入客户端访客语义。root可在正常API修正自家AddFeed为host_gid:0后验证明确业务拒绝，不能因此增加一次场景切换或盲发EnterHomestead。当前证据未显示AddFeed前需要PlayerSceneLogin/EnterHomestead。

同一调用还明确回包草料详情属性名为 `reply.detail`，适配器不要假定为reply.feed_machine。

## 5. 本诊断的边界

- 只定位和报告运行时接口/配置状态、公开getter语义、真实客户端请求字段。
- 不修改源文件，不导入模块，不切场景，不发送任何业务RPC。
- AddFeed host0的真正服务器成功、库存和草料变化由root随后验证；本文件不把协议证据当作写入成功证据。
- 未推断Harvest/PlaceAnimal的额外权限；PlaceAnimal本身无host字段，不能套AddFeed的字段规则。
