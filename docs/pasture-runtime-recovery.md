# 牧场运行时恢复：只读诊断结论

2026-11-20，CDP ctx7。诊断者 pasture-runtime-recovery；未修改源文件、未System.import、未切场景、未调用任何业务RPC（读写均无）。各诊断Bridge连接使用随机1e9以上CDP起点并已关闭。

## 配置错误的原因及修复

原metadataExpression直接访问 `configFactory.configs.get(name)._configMap`，绕过工厂公开getter。当前运行时已加载animalpb/homesteadpb、PastureWorld及牧场UI，AnimalService/RanchService方法名未变化。

初次快照MCAnimalConfig/MCGoods/MCItemInfo/MCShop等均已注册，`loadingStatus='pending'`、map和array均空，但`rawTextCache.has(name)=true`且rawLoading=false。MCAnimalConfig当前原始文本13448字符，MCGoods45640，MCItemInfo984500；旧ItemInfo/Plant正常loaded。

原生 `configFactory.getConfig(name)` 在缓存存在时调用 `parseConfigSync(name)`，进行解密/JSON.parse/fromJsonArray/loadConfigs，设置loaded并删除raw缓存，然后返回填充实例。故修复应使用公开getter读取，再取map/array；当前不需要用户进入牧场、业务登录/访问RPC或新模块导入。

root并行修复后观察：MCAnimalConfig loaded/map28、MCGoods loaded/map194；WorldManager仍farm，证明本地getter可独立恢复。此诊断没有执行该解析getter。

MCItemInfo当前原始副本1176条，与已加载ItemInfo1176条逐项比较id/name/type差异为0。1007金券type102、1008松果type2、7001牧草type6、60001/60002/60003幼崽type105均匹配。建议牧场优先MCItemInfo，ItemInfo为兼容fallback；本次相等不保证未来版本永久相等。

## AddFeed 自家host确证

root使用selfGid1229136306作为host_gid收到1045108。已从当前原生客户端闭包和字符串表解出：

```js
// GrassMachineSyncHelper.addGrass
const epoch = GrassMachineDataHelper.getEpoch();
const host = GrassMachineDataHelper.getCurrentHostGid();
const reply = await AddFeed({instance_id, add_count, use_gold, host_gid:host});
GrassMachineDataHelper.applyDetail(instance_id, reply.detail, capacity, host, epoch);

// GrassMachineDataHelper.getCurrentHostGid
const scene = WorldManager.getCurrentScene();
const comp = scene?.isValid ? scene.get(MCWorldEnterComp) : null;
return comp ? Math.max(0, comp.watchGid) : 0;

// MCWorldEnterComp.reset
this.watchGid = 0;
this.enterReason = MC_UNKNOWN;
this.applied = false;

// MCWorldEnterHelper.isAtSelfHome
return !!scene.get(MCWorldEnterComp) && scene.get(MCWorldEnterComp).watchGid <= 0;

// MCWorldEnterHelper.enterMcWorld
(param.watchGid ?? 0) > 0 ? enterVisit(...) : enterSelf(...);
```

当前只读调用getCurrentHostGid实测0，WorldManager._curType为farm。自家AddFeed应发送host_gid:0/省略零字段，而不是selfGid。原生helper只做_pending/epoch同步，未在AddFeed前调用PlayerSceneLogin或EnterHomestead；不要为修复owner错误额外切场景。回包草料详情名为`detail`。

这只是原生调用证据，host0真正成功及资源差量需root正常API验收。root已另外报告真实购买一鸡金券-2、全部好友清理15项、摘取3个货架成功；这些不是本诊断发出的请求。

更完整的快照和函数证据见[详细诊断](runtime-config-feed-diagnosis.md)。

## 追加：TriggerProduce 是独立“开始生产/开轮”动作

同一ctx7继续只读查看现有原生函数，没有发RPC或改模块。

MCPastureTriggerProduceOp.canTriggerProduce 的真实条件：

```js
animal.stage === ANIMAL_STAGE_PRODUCING // 枚举值3
  && !animal.producing
  && animal.canDeliver;
```

resolveTargets 在基础目标筛选后还排除 `animal.grassBlocked`。原生TriggerProduce UI与HarvestAnimal、CollectProduce是三个独立操作；本轮没有通过写入证实服务器是否会在无限等待后自动兜底生产，所以不能宣称不接此操作也能完成多轮生命周期。客户端文案明确为“开始生产”，一键请求日志称“单只开轮”。

AnimalSyncHelper.triggerProduce 调用链：

```js
const host = resolveHostGid(input.hostGid);
const targets = prepare('trigger', input.targets);
const reply = await TriggerProduce({host_gid:host, targets});
applyReply('TriggerProduce', reply.ranches, reply.op_results, targets, host, epoch);
```

resolveHostGid 的解混淆源码：`arg === undefined ? PastureDataHelper.getCurrentHostGid() : Math.max(0,arg)`。因此自家仍使用watchGid语义0，不填账号selfGid。

注意protobuf构造函数仅把repeated targets初始化为own property，不能据Object.keys(new Request())判定无标量host字段；其prototype明确包含host_gid、targets，encoder明确host_gid field1/tag8，targets field2/tag18。

AnimalModelComp.applyAnimalDetail 映射：

- producing = !!detail.producing
- canDeliver = !!detail.can_deliver
- grassBlocked = !!detail.grass_blocked
- produceCount = detail.produce_count
- produceReadyAtMs = detail.produce_ready_at_ms
- deliveringUntilMs = detail.delivering_until_ms

建议自家接生筛选 raw `stage===3 && producing!==true && can_deliver===true && grass_blocked!==true`，目标为 `{ranch_inst_id,animal_inst_id}`。写后核对同一实例producing由false变true、can_deliver由true变false或明确生产计数/就绪时间变化；请求长度本身不是成功证据。root决定是否实现与验收，本诊断不自行调用生产或好友生产。
