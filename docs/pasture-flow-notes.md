# 牧场客户端接口只读调查（2026-11-19）

这是并行分支调查阶段的笔记；“未确认/未调用”仅指该分支。最终root实测与已核对接口请以[牧场接口清单](牧场接口清单.md)为准。

范围：CDP `62000`、当前游戏上下文 `ctx=3`；只读 SystemJS/函数/原生 protobuf schema；未调用牧场 RPC、未进入好友/牧场、未购买/喂养/收获/偷取，未修改游戏或现有项目文件。

## 1. 当前运行时发现的牧场模块

SystemJS 中已加载：

- `chunks:///_virtual/animal.ts`
  - `AnimalServiceServiceName = gamepb.animalpb.AnimalService`
  - `AnimalServiceClientImpl` methods：`PlaceAnimal`, `TriggerProduce`, `HarvestRanch`, `StealProduce`, `GetRanchDetail`, `FeedAnimal`, `DonateAnimal`
  - `RanchServiceServiceName = gamepb.animalpb.RanchService`
  - `RanchServiceClientImpl` methods：`PutHazard`, `CleanRanch`, `CleanAllRanch`, `GetRanchOpTimes`, `StrokeAnimal`
- `chunks:///_virtual/animalpb.ts` 同时导出上述 service protobuf（旧模块 `animal.ts` 为已确认当前 service/schema 来源）。
- `PastureWorld`：`loadMainScene`, `enter`, `onExit`, `releaseResources`；`FarmPastureUtil` 只有世界切换回调/当前牧场状态工具，不是网络 RPC。
- 牧场操作类已加载：`MCPasturePlaceAnimalOp`, `MCPastureUseFeedBucketOp`, `MCPastureHarvestAnimalOp`, `MCPastureStealProduceOp`, `MCPastureCollectProduceOp`, `MCPasturePutMosquitoOp`, `MCPastureCleanRanchOp`, `MCPastureStrokeAnimalOp`, `MCPastureTriggerProduceOp`, `MCPastureSellAnimalOp` 等。
- `MCPasturePlaceAnimalOp.checkItem` 从配置检查物品；`resolvePlaceCount` 按幼崽/栏舍容量算数量；`guestTip = 好友牧场无法放置动物`。这确认“买幼崽/放动物”是自家牧场操作，好友牧场不允许放置。
- 进一步确认 `MCAddAnimalSelectUI.onItemClicked` 的当前函数源码分支：当选中物品已有 `animalId` 且 `cubItemId` 时，派发牧场放置事件 payload `{ ranchInstId, animalId, cubItemId }`；当不是可直接放置的幼崽时，派发商店打开事件 payload `{ goodsId, closeOnAutoAdd: ... }`。因此 UI 不是点击后直接调用 `PlaceAnimal`，而是先打开幼崽商店或把已持有幼崽交给 `MCPasturePlaceAnimalOp`。
- 当前 `MCAnimalConfig` 与 `ItemInfo` 配置有直接映射：例如鸡 `animal_id=60001`, `cub_item_id=60001`, `ItemInfo.type=105`；羊 `animal_id=70001`, `cub_item_id=70001`, `ItemInfo.type=105`。`MCGoods` 中商店5（幼崽）对应 `item_id`：鸡 60001（goods_id 10002）、鸭 60002（goods_id 10003）、羊 70001（goods_id 10008）；价格字段来自 `price_id/price_count`（上述均为 currency 1007）。这确认物品映射和商店货品映射，但不执行购买。

## 2. 已确认 protobuf request 字段（由当前 encode 默认值和 encode 函数字段标签核对）

| service.method | request 默认字段 | 当前证据/结论 |
|---|---|---|
| AnimalService.PlaceAnimal | `items[]`; `PlaceAnimalItem { ranch_inst_id, animal_id, giant_cub_item_id }` | 放置动物；`MCPasturePlaceAnimalOp` UI 使用 item 的 `ranchInstId`, `animalId`, `cubItemId`。未执行。 |
| AnimalService.GetRanchDetail | `host_gid=0`, `ranch_inst_ids[]` | 只读牧场详情；`host_gid` 表明可支持好友目标。未执行。 |
| AnimalService.FeedAnimal | `targets[]`, `bucket_type=0` | 喂养目标列表 + 饲料桶类型；未执行。 |
| AnimalService.HarvestRanch | `ranch_inst_ids[]`, `op=0`, `animals[]`, `shelves[]` | `HarvestRanchOp`: `ALL=1`, `SHELVES=2`, `ANIMALS=3`, `PICKED=4`；未执行。 |
| AnimalService.StealProduce | `host_gid=0`, `targets[]` | 好友偷取产物的明确候选；UI op `guestOnly=true`, `allowGuest=true`。未执行。 |
| AnimalService.TriggerProduce | `host_gid=0`, `targets[]` | 牧场产物触发/收取相关入口，UI `MCPastureTriggerProduceOp`；语义和奖励需 RPC/代码进一步确认。 |
| AnimalService.DonateAnimal | `targets[]` | 捐赠动物；未执行。 |
| RanchService.PutHazard | `ranch_inst_id=0`, `host_gid=0`, `op_id=0`, `count=0` | 放置牧场害虫/危害；业务 enum 需从当前 `RanchHazardOperationId` 解码后再确认。未执行。 |
| RanchService.CleanRanch | `host_gid=0`, `hazard_ids[]` | 清理单个/指定危害；未执行。 |
| RanchService.CleanAllRanch | 未在本轮展开 defaults（方法已确认） | 全部清理入口；字段待后续只读 schema 展开。 |
| RanchService.GetRanchOpTimes | `op_ids[]` | 读取牧场操作额度；只读，尚未调用。 |
| RanchService.StrokeAnimal | `host_gid=0`, field 2 为可选 `AnimalRef` 目标（不是裸 animal_id） | 抚摸动物；未执行。 |

`animal.ts` schema 的客户端 stub 函数均为“encode request → transport → decode reply”；本轮没有执行任何 stub/RPC。网络 service 名和 method 名已由 protobuf client prototype 明确。

## 3. 买动物/商店关系（已确认到入口，未确认购买方案）

- `shop2.ts` 当前 `ShopType`：`ITEM=1`, `SEED=2`, `PET=3`, `SKIN=4`, **`CUB=5`**, **`FEED=6`**, `ROTATION_SHOP=7`。
- `MCShopConfigHelper.MC_PASTURE_SHOP_IDS = [5, 6]`，说明牧场商店分类至少包含幼崽（Cub）和饲料（Feed）。
- `MCAddAnimalSelectUI.onItemClicked` 的当前函数字符串显示：选中可放置幼崽时派发 `ranchInstId`, `animalId`, `cubItemId` 给牧场放置入口；另一分支派发商店打开事件 `{goodsId, closeOnAutoAdd: ...}`，不是直接调用购买 RPC。
- 当前配置已建立具体映射：`MCAnimalConfig` 的鸡为 `animal_id=60001,cub_item_id=60001`，羊为 `animal_id=70001,cub_item_id=70001`；对应 `ItemInfo.type=105`（幼崽）。`MCGoods` shop_id=5 的鸡货品为 `goods_id=10002,item_id=60001,price_id=1007,price_count=2`，鸭为 `goods_id=10003,item_id=60002,price_count=1080`，羊为 `goods_id=10008,item_id=70001,price_count=5640`。这确认 UI 配置物品映射。
- `MCShopManager.requestBuy(goodsId,num)` 只发布 `MCShopEvent.ShopBuyGoods` 事件；`MCShopManager` 有 `buy/doBuy/onShopBuyGoods`，最终 client stub 尚未直接解压出调用参数，但当前已知 `shop2.ts` 的 `BuyGoodsRequest` 为 `{goods_id,num,price,auto_add}`。因此**购买 UI 明确走统一 ShopService.BuyGoods 链路，但 MCShopManager 到 stub 的第三个参数/price及auto_add最终赋值仍未从压缩闭包直接确认**；不得自行调用。
- `MCShopBuy.applyAutoAddOrCapacityTip` 与 `MCShopAutoAddConfig` 明确解释 auto-add 候选：规则 `cub_to_ranch` 对 `ItemInfo.type=105`，提示“自动放入窝/棚”；规则 `feed_to_grass_machine` 对 item_id `7001`，提示“自动添加到牧草机”。这证明 `auto_add=true` 是购买后的自动归置/入设施选项，不是另一种购买接口；但是否在购买成功回调中立即调用 `PlaceAnimal`，当前压缩代码不可见，不能断言“直接放置”。
- `MCPasturePlaceAnimalOp` 使用 payload 的 `cubItemId` 和 `animalId`，并检查背包物品与容量；配置描述写明幼崽“放进牧场的窝/棚”，故可确认 PlaceAnimal 消耗/转移对应幼崽物品的客户端业务意图；服务端实际扣除时机仍需成功 RPC 后核对，当前未执行。
- 牧场饲料通过 `ShopType.FEED=6` / item_id 7001 及 FeedBucket 规则关联；不能把任意 Item.Bag 物品当作饲料。

## 4. 好友拜访与共用关系

- 现有好友农场使用 `gamepb.visitpb.VisitService.Enter/Leave`，request 为 `EnterRequest { host_gid, reason }` / `LeaveRequest { host_gid }`。牧场网络没有单独的 PastureVisitService；`GetRanchDetailRequest.host_gid` 和 `AnimalService.StealProduceRequest.host_gid` 是牧场侧目标字段。
- 已加载 `visit.ts` exports：`EnterReason`, `EnterRequest`, `EnterReply`, `LeaveRequest`, `LeaveReply`, `EnterHomesteadRequest`, `EnterHomesteadReply`, `LeaveHomesteadRequest`, `LeaveHomesteadReply`, `VisitServiceClientImpl`。
- 这确认 VisitService 是好友/世界进入退出的共用会话层；但**牧场世界是否在进入牧场时使用同一 Enter/Leave，还是通过 `PastureWorld.enter` 后单独 GetRanchDetail(host_gid)，本轮限定只读调查，未调用 Enter**。不能把普通 Farm `Enter` 的 scene/reason 直接复用于牧场。
- 当前 UI op 证据：`MCPastureStealProduceOp.allowGuest=true`, `guestOnly=true`；`MCPasturePlaceAnimalOp.guestTip=好友牧场无法放置动物`；这说明进入好友牧场/好友牧场目标关系共用好友访问语义，但没有证明进入参数。
- 当前 `friend.ts` 的 `GameFriend` 属性包括 `gid`, `open_id`, `name`, `avatar_url`, `remark`, `level`, `gold`, `authorized_status`, `host_type`, `equip_avatar_frames`, `exp`, `is_banned`, `month_cards`, `is_returner`, `last_login_at`, `newbie_privilege`, `main_city_level`, `big_farm_level`, `big_farm_exp`, `world_coin`，以及后续消息属性 `BigFarmStatus`、`PetTreasureHunt` 等。**此处只列属性名，不从 defaults 对象顺序推导字段号。** 当前实际字段号以 root 生成的 `out/protocol/pasture-runtime.json` 为准；root 的原生 encoder 证据已确认 tags 包含 `authorized_status=10`, `host_type=11`, `big_farm_status=23`, `main_city_level=24`，此前按 defaults 顺序列出的编号不可靠。
- `BigFarmStatus` 属性包括 `can_steal`, `can_midwife`, `can_help`, `steal_lot_count`, `midwife_count`, `help_count`。这表示好友摘要**确实含“大农场/牧场相关能力摘要”**，但本轮未调用新版 `friend.ts` GetAll，也未确认当前服务返回是否填充这些字段。旧 CLI `friendpb.ts` parser 只读普通农场 summary 字段，不能据此声称牧场字段已显示。
- `PetTreasureHunt` 字段：`has_plunderable_treasure=1`, `lucky_star_gained_total=2`，与动物牧场并非同一套操作，勿混用。

## 5. 当前安全调用顺序（只读规划，不是已执行证据）

### 自家牧场（推荐后续只读验证）
1. `Bridge.ensure()` 并确认当前 `System`/`animal.ts` 已加载。
2. 读取当前登录身份（当前已知 `GlobalData.selfModel.gid`）和牧场世界状态。
3. 只读 `AnimalService.GetRanchDetail({host_gid: selfGid, ranch_inst_ids: []})`，解析容量、动物、货架、危害；必要时再 `RanchService.GetRanchOpTimes({op_ids:[...]})`。
4. 只读 `ItemService.Bag`，对照 `AnimalDetail`/`PlaceAnimalItem` 所需物品；不提交 Place/Feed/Harvest。
5. 只读商店信息（需先确定 `ShopProfiles`/`ShopInfo` 的 proto 请求和 `ShopType.CUB/FEED` 的实际字段）；不能仅凭 ShopType 确定购买。

### 好友牧场（推荐后续只读验证）
1. 通过好友新版 `friend.ts` GetAll 读取 `BigFarmStatus`（仅列表 RPC）。
2. 使用**当前客户端实际调用路径**确认 PastureWorld/Visit reason，再只读 `GetRanchDetail({host_gid: friend_gid, ranch_inst_ids: []})`；不得先猜 `Enter` reason。
3. 如果后续需要建立访问上下文，应先核对实际入口和 reason，并以 finally 完成对应 Leave；本轮没有执行。
4. 在友方详情只做解析，不调用 `PlaceAnimal/FeedAnimal/HarvestRanch/StealProduce/PutHazard/Clean*`。

## 6. 明确未确认项

- AnimalService/RanchService 的底层 wire method path（stub 字符串中为压缩索引，未从 network descriptor 解出完整路径；服务名和 RPC method 名已确认）。
- `PlaceAnimal` 之前的商店购买：是否 `ShopService.BuyGoods`, `RotationBuyGoods`，还是 MCShop 专用流程；`ShopProfiles`/`ShopInfo` 的实际 `shop_type` request 与商品字段尚未确认。
- PastureWorld 与 `VisitService.Enter/Leave` 的真实 scene/reason 参数、牧场世界是否复用农场访问会话。
- `FriendService.GetAll` 当前服务是否填充 `GameFriend.big_farm_status` / `PetTreasureHunt` 字段（schema 已确认、运行时返回未读取）。
- 牧场操作额度 op_id、牧场危害 enum 与服务端业务码。
- `TriggerProduce` 与 `HarvestRanch` 的语义边界（生产物自动触发/领取/动物收获）及 targets 的具体消息结构。

## 7. 只读证据摘要

- 当前模块注册表发现 `animal.ts`, `friend.ts`, `shop2.ts`, `visit.ts`, `PastureWorld.ts` 与完整牧场 UI/op/helper 集合。
- 原生 schema defaults/encode：`GetRanchDetail(host_gid,ranch_inst_ids)`, `PlaceAnimal(items)`, `FeedAnimal(targets,bucket_type)`, `HarvestRanch(ranch_inst_ids,op,animals,shelves)`, `StealProduce(host_gid,targets)`, `PutHazard(ranch_inst_id,host_gid,op_id,count)`, `CleanRanch(host_gid,hazard_ids)`。
- 原生 enums：AnimalStage (CUB/GROWING/PRODUCING/MATURE/GAIN), HusbandryType (COOP/SHED), HarvestRanchOp (ALL/SHELVES/ANIMALS/PICKED), ShopType (CUB=5,FEED=6)。
- 本轮仅执行 SystemJS 读取/evaluate 和本地笔记写入；没有主动 RPC，未购买、喂养、收获、拜访或改动现有代码。
