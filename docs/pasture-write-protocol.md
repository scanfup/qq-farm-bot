# 牧场写入协议核对（只读证据，供 Web 适配器实施）

本文件只记录当前登录客户端的 protobuf schema、UI 操作类和只读回包证据；本次没有购买、投放、喂养、收取、偷取、清理或拜访写请求。真正写入仍需 root 通过统一队列、journal 和 uncertain 锁验收。

## 1. RPC 与请求模板

所有服务名以当前 native stub 为准：

```js
// 自家详情（只读）
AnimalService.GetRanchDetail({ host_gid: selfGid, ranch_inst_ids: [] })

// 自家全收。只有确认存在可收目标才发送。
AnimalService.HarvestRanch({ ranch_inst_ids, op: 1 /* ALL */, animals: [], shelves: [] })

// 限量验收；op=4 PICKED
AnimalService.HarvestRanch({ ranch_inst_ids: [], op: 4, animals: [AnimalRef], shelves: [ShelfRef] })

AnimalRef  = { ranch_inst_id, animal_inst_id }
ShelfRef   = { ranch_inst_id, slot_index }

// 投放幼崽。普通幼崽不发送 giant_cub_item_id；只有配置明确给出巨兽幼崽时才加该字段。
AnimalService.PlaceAnimal({ items: [{ ranch_inst_id, animal_id, giant_cub_item_id? }] })

// 动物喂养；bucket_type: 1 ORGANIC / 2 INORGANIC
AnimalService.FeedAnimal({ targets: [AnimalRef], bucket_type })

// 生产/接生（request 有 host_gid，可选好友目标）
AnimalService.TriggerProduce({ host_gid, targets: [AnimalRef] })

// 好友货架偷取
AnimalService.StealProduce({ host_gid, targets: [ShelfRef] })

// 自家或好友清理
RanchService.CleanRanch({ host_gid, hazard_ids })
RanchService.CleanAllRanch({ host_gid, ranch_inst_ids })

// 好友危害/照料
RanchService.PutHazard({ ranch_inst_id, host_gid, op_id, count })
RanchService.StrokeAnimal({ host_gid, target: AnimalRef })

// 查询每日/操作额度；应先读取再决定批量上限
RanchService.GetRanchOpTimes({ op_ids: [11003,11004,11005,11006,11007,11008,11009] })

// 普通商店购买。牧场场景商品来自 ShopInfo(shop_id=5/6)。
ShopService.BuyGoods({ goods_id, num: 1, price: currentSinglePrice, auto_add: false })
```

`PlaceAnimalItem` 的三字段分别是栏舍实例、动物配置、巨兽幼崽物品；不能把商店 `goods_id` 当成 `animal_id`，也不能把普通幼崽的 `item_id` 自动当巨兽字段。

## 2. 收取/偷取安全筛选

- `GetRanchDetail` 返回 `RanchDetail[]`。栏舍用 `ranch_inst_id`，动物用 `animal_inst_id`，货架用 `slot_index`。
- 自家 `HarvestRanch op=ALL(1)` 只有在至少存在 `animal.can_harvest === true` 或 `shelf.can_collect === true` 时才发送。无目标不要发送空写。
- `limit` 验收使用 `op=PICKED(4)`，动物和货架目标总数共同受限，不应分别各取 `limit`。
- 好友偷取要求货架 `can_steal === true`，且至少一个 lot 同时满足 `can_steal === true`、`remain_num > 0`。不能只看好友摘要的可偷数量。
- 写后必须再次 `GetRanchDetail`，比较目标状态；收到 HTTP/RPC 正常回包并不等于所有单项成功。

## 3. 单项结果与不确定性

当前 native 解码的 `op_results` 是跨模块嵌套对象，已确认属性：

```text
facility_inst_id, kind, target_id, rewards[], costs[]
```

该对象没有可直接依赖的 `error_code` 字段。适配器只能识别服务器实际 plain 解码中明确出现的 `code/error_code/err_code` 或 `success:false/ok:false`；不能猜测 `kind` 数字的成功/失败含义。若服务实现返回单项业务码，应把它加入 errors 并继续可安全继续的好友批次；若 RPC 传输失败、回包为空、protobuf 解码失败或 Leave/恢复失败，必须停止后续写，保留 `partialResult`，由 root journal 标记 uncertain，禁止自动重试。

农场的 `GameError` 是通用业务码表，但牧场操作码仍要以实际回包/客户端服务端定义核对，不能把 `kind` 当作 GameError。

## 4. 购买动物与自动补栏

- 牧场场景为 `global_scene_id=2`。
- `ShopProfiles(2)` 当前包括幼崽店 `shop_id=5`、饲料店 `shop_id=6`、轮换店 `shop_id=7`。
- 幼崽先通过 `ShopInfo(5)`读取最新 `goods_id/item_id/price/unlocked`。只有 `unlocked === true`、价格是安全非负整数、商品存在时允许购买。
- 默认只使用背包现有幼崽；自动购买必须同时满足 `allowAnimalPurchase === true` 与正的 `maxAnimalSpendPerCycle`，每只 `num=1`、`auto_add=false`，每次扣除预算后再决定是否 Place。购买结果不得自动假定已入栏。
- `MCAnimalConfig` 提供 animal 与 cub item 映射，`ItemInfo.type=105` 表示幼崽。栏舍 `husbandry_type` 必须匹配（COOP=1 / SHED=2），容量按每一只投放递减；请求之间不能重复使用同一库存/容量。
- 普通商品当前已读到：鸡 `goods_id=10002,item_id=60001`，鸭 `10003/60002`，鹅 `10004/60003`，羊 `10008/70001`。价格和解锁状态仍以当前 `ShopInfo`为准。

## 5. 牧草机与 Feed

已确认 `AllCells` 中牧草机：`module_type=8`，有 `instance_id/capacity/feed_machine.feed_count/feed_machine.is_owner/status`。只在 owner、容量和余量均为安全数值且 `capacity > feed_count` 时补充。

```js
FeedMachineService.AddFeed({
  instance_id,
  add_count: Math.min(capacity - feed_count, bag[7001], optionalLimit),
  use_gold: false,
  host_gid: selfGid,
})
```

7001 牧草必须从 `GetBag({global_scene_id:2,tab_id:0})` 的 `physical_items + virtual_items` 合并库存中读取；不可自动购买或使用金币。未确认设施实例/权限/库存时应返回 unsupported/zero-write，而不是猜测。

## 6. 好友场景共用边界

- 好友牧场列表使用 `FriendService.GetAll({global_scene_id:2})`，不能复用农场 scene=1 缓存。`big_farm_status` 只用于候选展示；动作前必须读取 `GetRanchDetail(host_gid)`。
- 只读 `GetRanchDetail(host_gid)` 已被实际验证不需要旧农场 `VisitService.Enter`。
- 写入是否必须先 `EnterHomestead/LeaveHomestead` 尚未执行验证。root 应先核对客户端实际 PastureWorld 调用路径，访问目标、场景和退出必须放入共用串行 `VisitSession`，finally 退出，失败保留 uncertain。
- 好友清理只处理详情中确有 hazards 的栏舍；好友偷取只处理详情中明确可偷且剩余大于零的 lots。批量好友业务拒绝可记录 errors 后继续；传输错误停止并保留部分结果。

## 7. Root 集成检查清单

- native adapter 将 plain request 编码为 `gamepb.*` protobuf，并把 long 保持安全整数或十进制字符串。
- 所有写命令通过现有 serial queue 和 `write:true` journal；不在 PastureService 内重试。
- `pasture-visit` 只更新 `state.preview`，不要把完整 ranch payload 塞进 job result。
- 写后 refresh/差量核对；写回包不完整、单项失败、transport code（包括 `ECONNRESET`）不得当作成功。
- demo 必须只操作内存：购买减少预算/增加库存，投放减少库存增加动物，收取/清理/偷取/补草改变内存状态。
