# BIG_FARM 新场景种植只读核对

核对时间：2026-11-19；当前游戏CDP62000，Bridge动态ensure定位ctx3。本调查未执行任何业务RPC（查询也优先使用已有实测artifact），未执行Enter、PlayerSceneLogin或写操作；仅查看SystemJS原生模块、protobuf定义/同步本地encode探针和已有只读回包。

## 结论（交付实现者）

**当前版本没有发现可作为服务端真实新场景农田使用的独立种植接口。BIG_FARM=2目前能实证的是家园设施+牧场，不可把旧PlantService伪装成新场景Plant/Harvest/Clean。**

- 完整已加载serviceIndex仅`gamepb.plantpb.PlantService`具有`Plant/Harvest/Farming/RemovePlant`；没有BigFarmPlant、MCCrop、NewLand等独立服务。
- `homesteadpb.HomesteadService`16个方法均为格子/设施/区域/建筑管理，另有FeedMachine.AddFeed、MainCity.BuyBuilding等，没有种子/种植/农田收获方法。
- 原生`homesteadpb.FacilityInfo`字段为instance_id/facility_id/module_type/position/rotation/level/width/height/capacity/occupied_cell_ids/**ranch/feed_machine/order_board**/state/upgrade；没有land、plant、seed字段。
- 原生ModuleType枚举：UNKNOWN0、MAIN_CITY1、HOUSE2、ORDER_BOARD3、ROAD4、DECORATION5、RANCH_COOP6、RANCH_SHED7、FEED_MACHINE8、RANCH_LAB10，没有农田类型。
- 已保存AllCells回包实际设施：instance10001/type6/窝/带ranch4只鹅；instance10002/type8/牧草机；instance10000/type11/其它设施（此值比当前pb枚举新，不可强行命名）；instance3/type7/棚/state2虚拟。没有任何真实农田或crop字段。

证据边界：这证明**当前加载客户端及本次账号回包中未发现**，不代表未来版本或尚未解锁功能永远没有。实现上应禁用/不显示BIG_FARM种子种植选项，直到有真实协议或回包证据；不能用假数据或旧场景RPC充数。

## 容易误判的客户端模块

当前SystemJS确有`MCFarmMockData.ts`，但明确是mock：

- `MC_MOCK_PLANTS`仅胡萝卜plantId1、小麦2、番茄3。
- 阶段时长为2秒/3秒等展示用假成长；成熟duration=-1。
- `MC_MOCK_FARMLAND_LAYOUT`是固定8格col2..4,row2..4布局。
- 导出函数为buildMockPlantConfig/getMockPlantConfig/randomMockPlantConfig，素材路径`MC_FARM_RES`。
- 这不是Plant/ItemInfo真实物品配置，也没有RPC服务。**不得将plantId1/2/3当商品/种子ID或服务端地块。**

`MCPlantHarvest.ts`是收获汇总篮子UI：prototype有onAdded/onTotalsChanged/onFlyToBasketCompleted/refreshUI等；`MCPlantHarvestModel.MCPlantHarvestType={Own:0,Steal:1}`、标题“收获汇总/偷取收获”。名称含Plant不代表它具有新场景农田服务。

## 旧PlantService真实编码（只能用于旧农场适配器）

以下由当前原生`plantpb.ts`编码器本地fakeWriter探针确认字段号；所有暂时包装均同步finally还原，没有调用客户端transport。

| 请求 | 字段号及类型 |
|---|---|
| AllLandsRequest | 1 host_gid:int64 |
| PlantRequest | 1 land_and_seed:map<int64,int64>（旧兼容字段）；2 items:PlantItem[] |
| PlantItem | 1 seed_id:int64；2 land_ids:packed int64[]；3 auto_slave:bool |
| HarvestRequest | 1 land_ids:packed int64[]；2 host_gid:int64；3 is_all:bool；4 host_type:int32；5 reason:int32 |
| FarmingRequest | 1 land_ids:packed int64[]；2 host_gid:int64；3 host_type:int32；4 reason:int32；5 clear_farm_social_item_ids:packed int64[] |
| RemovePlantRequest | 1 land_ids:packed int64[] |
| CleanSocialItemsRequest | 1 land_ids:packed int64[]；2 item_ids:packed int64[] |
| CleanFarmSocialEventRequest | 空请求 |
| PutWeedsRequest/PutInsectsRequest | 1 host_gid:int64；2 land_ids:packed int64[]；3 host_type:int32；4 reason:int32 |

**以上均无global_scene_id。Farming field4原生名称是reason，不是场景ID；现有tools/farm.mjs注释用“场景字段”描述自家0/帮好友2，不能因此将它当成BIG_FARM=2。host_type同样是REAL/BOT/HUMANOID等目标类型，不是场景ID。**

现有旧场景实测约束仍保留：

- Plant使用field2 items，每块地一个PlantItem，seed_id来自真实种子库存；不可一个item多地误编码。
- 自家Harvest省略host_gid，好友Harvest才提供host_gid及is_all；不要因新场景需求改坏既有行为。
- RemovePlant用于枯株；Farming用于草虫及owners/social；CleanSocialItems/CleanFarmSocialEvent不是新牧场清理接口。
- 不建议在当前场景登录状态未知时仅凭同一RPC名字切换目标。统一SceneContext必须区分旧农场和BIG_FARM。

## 种子优先级与动物优先级应分开

旧农场真实种子仍由现有`Plant`配置`seed_id`与`ItemInfo.type=5`识别，库存取Bag；没有发现独立MCPlant/MCCrop/MCSeed配置。

本次读取例子：

- 旧Plant配置的牧草：plant_id1020040，seed_id20040，fruit.id7001/count20；这说明旧农场生产的牧草能供新牧场使用，但**不是BIG_FARM可种植证据**。
- 当前配置还含活动/测试白萝卜seed29999等，必须依据实际Bag和完整配置，不用名称或ID区间猜默认种子。
- BIG_FARM动物优先级应走MCAnimalConfig/幼崽物品type105和商店/背包映射，执行PlaceAnimal。不要将动物ID填入PlantItem.seed_id。

UI/定时任务建议明确两套配置：`farm.preferredSeedIds`仅旧农场；`pasture.preferredAnimalIds`仅牧场。若用户说“新场景种子”，应说明当前版本未发现真实农田，不要悄悄改用旧农场作业。

## 好友一键摘取/清理是否有牧场外另一套

- 旧农场：PlantService.Harvest/Farming、旧Visit.Enter/Leave，已有实现。
- BIG_FARM牧场：AnimalService.StealProduce（货架目标）、TriggerProduce（接生动物目标）、RanchService.CleanRanch/CleanAllRanch（危害/栏舍）、StrokeAnimal；需要使用host_gid与牧场实例结构，不是land_id。
- 新场景家园：HomesteadService.RefreshCells(host_gid,cell_ids)、GetFacilityInfo/GetFacilityDetail支持查询好友设施，不是清理/摘取写入口。AllCells设施回包没有独立作物目标。
- 原生serviceIndex还存在Dog/Travel/Collection等通用社交服务，但不能因为支持好友就计入“农田摘取”。本次没有发现BIG_FARM牧场之外第二套真实作物Harvest/Clean。
- FriendService.GetAll(global_scene_id=2)返回big_farm_status摘要；不能用旧plant摘要缺失判成自己/不可访问。独立登录身份与场景化缓存必须保留。

## 可复核来源

- `out/protocol/pasture-runtime.json`：serviceIndex、Homestead/Animal/Friend/Visit原生服务与字段。
- `out/protocol/pasture-readonly.json`：AllCells、场景1/2好友、牧场详情只读实测数据。
- `tools/farm.mjs`行216-275：旧场景构造函数及历史成功约束；本次未修改。
- 运行时模块：`plantpb.ts`、`homesteadpb.ts`、`MCFarmMockData.ts`、`MCPlantHarvest.ts`、`MCPlantHarvestModel.ts`、`GlobalEnum.ts`、`Oops.ts`已加载配置。

本调查没有改现有代码、没有创建可触发写操作的工具脚本，只新增本笔记。
界限明确：现版本独立新场景Plant/Harvest/Clean编码**不存在足够证据可提供**；上表是旧场景真实字段，不作为BIG_FARM写方案。
