# QQ 农场 Web 控制台（CDP 版）

## 启动

需要 Node.js 22+（已在 Node.js 24 验证），无需安装 npm 依赖。在项目根目录执行：

```powershell
node web/server.mjs
```

打开 http://127.0.0.1:3210 。先打开已登录的小游戏、进入自己的农场并启用已有 CDP 调试通道，再点击“连接运行时”。Web 服务启动不会自动收获或种植。

自定义本机端口及务农使用的自身 GID：

```powershell
$env:CDP_PORT = '62000'
$env:WEB_PORT = '3210'
$env:MY_GID = '填写自己的数字GID'
node web/server.mjs
```

`MY_GID` 可省略。好友功能优先读取游戏 GlobalData.selfModel 的当前登录资料，并与本次好友列表核对；资料不可用时才采用 CLI 的唯一无摘要条目识别，仍有歧义则禁止好友写操作。不会用心跳或当前正在访问的农场 GID 猜身份。自家务农使用 CLI 实测的 host_gid=0、reason=0（该字段不是 global_scene_id）。

演示模式：

```powershell
node web/server.mjs --demo
```

打开 http://127.0.0.1:3211 。使用历史抓包的土地快照，演示操作只修改内存，页面明确显示 Demo；不会连接游戏。该样本实际解码为 24 条土地记录、12 条 unlocked，不应把早期文档的“13 块地”当成固定数量。演示不模拟完整游戏生长和经济规则。

## 数据流与边界

```text
浏览器 → 本地 HTTP API → 单账号串行任务队列 → Bridge → CDP
          ↑ SSE 状态                            ↓
          └──────────────────── __bot → __netInst.send → 原游戏服务器
```

- 继续复用 tools/core.mjs 和 tools/farm.mjs。加密、token、心跳和游戏连接由小游戏处理。
- 前端为独立原生 HTML/CSS/JS；无需打包。后端使用 Node 内置 HTTP、WebSocket 客户端、文件系统。
- 所有浏览器共用一条执行队列。查询、手动操作和自动任务不会并发进入 CDP。
- 当前只绑定 127.0.0.1，校验 Host/Origin 和自定义请求头；不提供任意脚本执行 API。
- 当前是本机单账号控制台。手机/远程访问、多账号和施肥尚未加入；牧场幼崽自动购买现已加入，但默认关闭且受显式预算限制，旧农场不会自动购买种子。好友操作已复用 CLI 协议加入同一队列。需要远程使用时应另加认证和本地 Agent 通道，不能直接把 CDP 端口暴露给浏览器。

## 已有功能

- 连接 CDP，动态发现执行上下文，复用/安装 __bot。
- 查看土地、成长阶段、成熟和照料状态、快照时间。
- 收获成熟主地；跳过副产地和枯株；沿用当前工具实测的自家收获编码，不加 host_gid。
- 每次刷新同时读取真实 Bag，按物品 ID 汇总全部堆叠；使用当前游戏 Plant / ItemInfo 配置识别种子，动态补齐本地目录缺失项（例如牧草）。下拉仅显示有库存的种子并标注数量，不固定默认白萝卜。背包读取失败会清空旧库存并禁用种植，显示明确错误；实时配置暂不可用时只显示本地目录识别项，并提示目录不完整。
- 清理枯株；种植空地主地（每地主请求项、auto_slave），按背包现有数量截取，不自动购买。所选种子耗尽时指出具体名称，并列出有库存的其他种子。
- 一键务农：先清理自家，再扫描全部可访问好友，按真实 Enter 土地判定自然草虫和 owners；好友摘要不作为务农硬筛选，每人最多三轮，1001057 视为收敛。
- 好友列表与姓名/GID 搜索；独立缓存的农场预览，读取后自动 Leave；单人或全部好友偷菜；指定好友撒虫/撒草，共享服务端 10003 每日额度。
- 偷菜使用好友摘要的可偷数作门控，带目标 host_gid 与 is_all，排除当前账号已摘地块，将全部符合条件的地块合并为每好友一次请求；MAX_PER_FRIEND 仅限制放虫草；不对副产地单独操作。撒虫草排除已有 owners 的地块，1001046 停止全部，1001036/1001037 跳过当前地块。
- 自动循环：按用户指定周期收获 → 清枯株 → 种植 → 务农（自家+好友）→ 偷菜；最短 60 秒；默认关闭，重启不自动恢复。撒虫/撒草仅在指定好友的手动按钮触发，不进入循环。
- 实时 SSE 推送、任务记录和运行日志。

写请求由游戏返回的业务错误决定失败；成功后重新查询土地。这里的成功表示收到游戏成功应答并刷新，不代表客户端自行推断奖励。

## 一致性与恢复

- POST /api/commands 必须带 commandId；相同 ID 重复提交返回原任务，换 payload 返回 409。
- 任务状态追加保存在 web/data/live-jobs.jsonl（演示使用独立文件），保留重启后的幂等记录；页面仅显示最近 100 条。
- 超时/连接中断后的写操作标记 uncertain，不重发；自动循环停止，后续写操作阻止，需先刷新实际土地核对。
- 未完成任务重启后标记 uncertain，不恢复执行。任务日志损坏时停止启动，不静默丢弃幂等记录。
- 任务 journal 采用同步追加，适合本机少量任务；长期使用应归档或迁至 SQLite。没有承诺磁盘掉电时强一致性。
- 游戏刷新后重探上下文；从已加载的 SystemJS 模块取得 Oops.netWebSocket 当前游戏通道，验证 NetNodeState.Working，再安装桥接。不依赖压缩脚本偏移，不暂停游戏。旧断点路径仅在显式设置 CDP_ALLOW_BREAKPOINT_FALLBACK=1 时作为历史备选启用。
- 游戏重进可能保留表面 OPEN 的旧 CDP 代理 socket。健康检查失败或上下文丢失时，关闭旧 socket，创建新连接并重新接收上下文事件；忽略旧 socket 的迟到事件，同时合并并行恢复请求。上下文识别按 tsdk、cc、System 能力判断，不依赖固定 contextId 或全局 key 数量。
- 游戏退出/未进入农场、会话过期或调试口消失时显示失败；Web 本身不能代替小游戏登录。
- 保留最后一次成功快照并显示错误，不用演示数据填充真实模式。页面显示只代表最后同步时间，不是持续轮询到的服务器状态。

## API

GET /api/state：完整缓存状态。GET /api/events：命名 state 的 SSE 事件。

所有 POST 使用 Content-Type: application/json 和 X-Farm-Request: 1：

```text
POST /api/connect  {}
POST /api/refresh  {}
POST /api/commands {"commandId":"一个唯一ID","type":"harvest"}
POST /api/commands {"commandId":"另一个唯一ID","type":"plant","seedId":20002}
POST /api/commands {"commandId":"另一个唯一ID","type":"care"}
POST /api/commands {"commandId":"另一个唯一ID","type":"remove-dead"}
POST /api/commands {"commandId":"另一个唯一ID","type":"friends-refresh"}
POST /api/commands {"commandId":"另一个唯一ID","type":"friend-visit","gid":123456}
POST /api/commands {"commandId":"另一个唯一ID","type":"friend-steal"}
POST /api/commands {"commandId":"另一个唯一ID","type":"friend-care","gid":123456}
POST /api/commands {"commandId":"另一个唯一ID","type":"friend-insect","gid":123456}
POST /api/commands {"commandId":"另一个唯一ID","type":"friend-weed","gid":123456}
POST /api/monitor  {"enabled":true,"intervalSec":120,"seedId":20002}
```

`friend-steal` / `friend-care` 不传 gid 时扫描全部可访问好友，传 gid 则只处理该好友；查看、撒虫和撒草必须传安全正整数 gid。`friendState` 包含列表、当前账号、额度和预览。Enter 后无论成功或异常均尝试 Leave；Leave 失败保留 activeGid，停止后续操作，下次连接或刷新先恢复离开。写后传输中断（含 ECONNRESET 等字符串 code）不会重发，保留部分结果并要求刷新核对。

任务接口返回 202 和 job；完成/失败结果通过 GET 状态或 SSE 获取。关闭监控不会撤销已发给游戏的请求，当前命令结束后不再继续循环。

## 验证

```powershell
node --test web/*.test.mjs
# 真实好友只读验收（GetAll + Enter/Leave + 返回自家，并与游戏原生解码核对）
node tools/test-friends-live.mjs
```

覆盖：串行与幂等、主副地筛选、自家 Harvest 编码、写超时不重发、显式业务错误、空回包、重启幂等、损坏 protobuf、抓包解析、HTTP/Origin/Host、自定义请求头、SSE、禁止 raw eval、CDP pending 清理。

2026-11-19 22:06（Asia/Shanghai）真实环境验收已通过：CDP 62000 / ctx=3，AllLands 返回 703 字节、24 条土地记录、6 条 unlocked，当前已解锁地块为空地。同一响应同时使用外部解析器和游戏原生 AllLandsReply 解码器核对，数量一致；Web 真模式显示已连接并呈现相同地块，页面刷新按钮成功更新快照。场景名 startup 不代表游戏未登录，之前的失败来自旧断点偏移，不应据此要求重新进入场景。真实写操作未为本次测试执行。

当前自动测试共 42 项（Web 服务集成 21 项、好友协议 21 项），包括好友身份消歧、summary 门控、Enter/Leave 恢复、共享额度、三轮务农收敛、传输失败不重发与 HTTP 目标幂等，以及在线通道发现、离线拒绝、重复连接请求合并、旧 socket 打开但上下文失效后的重新连接、实时种子识别、多个背包堆叠求和、缺货种子替代提示和读取失败时清除库存。可重复执行真实只读验收：

```powershell
node tools/test-web-live.mjs
# 在真实 socket 上模拟旧 contextId 失效、上下文列表丢失，验证重连后读取
node tools/test-web-live.mjs --recovery
```

2026-11-19 22:17 重进恢复验证：旧 Web 连接复现上下文探测失败， fresh CDP 可正常访问。修复后真实故障注入的两种场景均恢复成功，再次 AllLands 返回 4306 字节、24 条已解锁土地和“狗尾草 / 黄金·狗尾草”，与小游戏原生解码一致。Web 服务已更新并重新读取当前实例。

连接状态只有在真实 AllLands 读取成功后才进入 ready。旧失败/未完成任务保留为历史记录，不会在修复连接后自动补执行。

2026-11-19 22:31 种子库存验收：Bag 实时回包由小游戏原生 BagReply 解码器独立核对，4 种共 401 颗（狗尾草 373、牧草 16、紫茉莉 8、艾草 4），Web 下拉与统计一致。未执行种植或购买。可运行 `node tools/test-seeds-live.mjs` 重复只读验收。


## 牧场与优先设置（2026-11-20）

在“种植优先设置”添加种子/动物，并用上移、下移调整顺序后，分别保存。零库存项目仍保留；依次使用列表中的可用库存，只有明确勾选允许其它库存时才使用列表外品种。原农场种子种植与新牧场动物入栏是不同适配器，不会用模拟新场景农田代替真实服务器接口。

- 新场景 global_scene_id=2，好友缓存与原农场场景1分离。所有非本人且GID有效的好友都读取实际栏舍，不因缺摘要跳过。
- 牧场支持自家清理、接生/开始生产、收取、按优先补栏、库存补牧草；支持好友单人预览、清理、摘取及全部好友批量。结果显示扫描、跳过、确认好友和实际变更数量。
- 自动补栏默认仅使用背包幼崽，检查窝/棚兼容、容量和库存。自动购买必须显式开启且设正整数单周期预算，受实时价格、余额和解锁限制。手动购买是独立明确操作，界面展示单价、数量、总价，服务器再次核对。
- 补牧草只用库存7001，use_gold=false，不自动购买。原生自家AddFeed要求host_gid=0；普通GetRanchDetail读取可使用真实自身GID。
- MC配置通过原生configFactory.getConfig正常读取，支持当前游戏缓存资源的惰性解析；不会拿昨天的静态商品表冒充实时配置。
- 定时最短60秒，可选择仅农场、仅牧场、各自好友与库存补草；牧场顺序为清理、接生/开始生产、收取、可选补草、优先补栏、好友清理、好友摘取。无成熟目标/无空位时安全跳过。关闭后当前已发出的操作完成，但不启动下一步；重启默认关闭，不恢复定时。
- 未知写入结果需要刷新对应场景核对；核对完成会追加持久checkpoint，保留原命令幂等和审计。不要重发原写请求。

新增API示例：

```text
POST /api/preferences {"seedPriority":[20002,20040],"seedFallback":false}
POST /api/preferences {"animalPriority":[60003,60001],"animalFallback":false,"allowAnimalPurchase":false,"maxAnimalSpendPerCycle":0}
POST /api/commands {"type":"plant-priority","commandId":"unique-id-001"}
POST /api/commands {"type":"pasture-refresh","commandId":"unique-id-002"}
POST /api/commands {"type":"pasture-visit","gid":123456,"commandId":"unique-id-003"}
POST /api/commands {"type":"pasture-produce","commandId":"unique-id-011"}
POST /api/commands {"type":"pasture-harvest","commandId":"unique-id-004"}
POST /api/commands {"type":"pasture-clean","commandId":"unique-id-005"}
POST /api/commands {"type":"pasture-place","commandId":"unique-id-006"}
POST /api/commands {"type":"pasture-feed","commandId":"unique-id-007"}
POST /api/commands {"type":"pasture-buy","animalId":60001,"count":1,"expectedUnitPrice":2,"commandId":"unique-id-008"}
POST /api/commands {"type":"pasture-friends-clean","commandId":"unique-id-009"}
POST /api/commands {"type":"pasture-friends-steal","commandId":"unique-id-010"}
POST /api/monitor {"enabled":true,"intervalSec":120,"farmEnabled":false,"pastureEnabled":true,"pastureFriendsEnabled":true,"pastureFeedEnabled":false}
POST /api/monitor {"enabled":false}
```

偏好保存于web/data/live-preferences.json，演示使用独立demo-preferences.json；修改时等待当前批量任务结束。演示界面只变更演示内存，不连接CDP。

### 本次真实验收

当前自动测试102项全部通过（包含原有42项）。真实完成购买1只鸡（2金券）、首轮好友清理15项/摘取3个货架、自家库存补草1份；另执行一轮60秒定时周期，成功再清理7项、补草70份，扫描15位好友。定时已关闭且恢复原偏好，自动购买关闭。自家4只鹅当时成长中且满栏，收取和入栏均正确跳过，尚不能声称已对当前账号完成成熟收取/空位入栏真机验证（有状态演示和自动测试已覆盖）。

验收记录见[live-acceptance.json](../out/management/live-acceptance.json)。[真实验收脚本](../tools/test-pasture-live.mjs)的--manual/--timed --write会真实修改游戏库存和好友状态，不应当作只读诊断反复运行。

开始生产筛选严格按原生条件：stage3、can_deliver=true、producing非true且grass_blocked非true；自家host_gid=0。仅同一动物实例出现生产状态/计数/时间变化才确认成功，未知结果停止而不重试。最终七步真实定时周期遇到4只待开始生产的鹅，已成功启动4只生产并逐实例核对变化；同轮好友清理3项。当前仅非零成熟收取和空位入栏尚因无目标而未真机覆盖。

## 分页与常驻日志布局（2026-11-20）

控制台现分为三个可直接访问、刷新及前进后退的哈希路由：

- [农场](http://127.0.0.1:3210/#/farm)：农场概览、收获/种植、快捷农务，以及下方好友列表、预览和批量操作；农田详情默认折叠，点击展开。展开状态保存在浏览器本地。
- [牧场](http://127.0.0.1:3210/#/pasture)：自家动物、补栏/补草/生产/收取以及牧场好友。
- [优先设置](http://127.0.0.1:3210/#/settings)：种子/动物顺序、购买授权与预算；定时托管已移到各自场景页。

桌面宽度1000px及以上采用视口内双栏：主内容独立滚动，右侧“任务与运行日志”共用同一滚动框，任务记录与普通日志按时间倒序混排，带任务名称、状态和结果，不再分开折叠隐藏，不再堆在长页面底部。顶部显示连接与定时运行状态。窄屏改为“查看日志”按钮及右侧抽屉，支持遮罩、关闭按钮、Escape关闭与键盘焦点约束。

页面切换仅改变显示区域，不重新创建表单、不提交游戏操作、不停止正在运行的任务；主内容回到顶部，未保存的设置草稿保留。刷新页面则重新读取已保存设置，未保存草稿不跨刷新保存。日志更新保留已有滚动位置。

此前界面轮次仅调整布局与静态导航资源，未执行收获、购买、种植或开启监控。当时115项自动测试全部通过（含导航、折叠、抽屉、静态资源与布局结构回归）。桌面1280×800实际浏览器验证农田展开后主区域滚动700px，右侧日志栏位置保持不变；农场→牧场→设置页签切换正常，真实面板资源与SSE均200，console未捕获异常。窄屏交互由自动测试覆盖，未在本轮真实移动设备上验收。

农场与农场好友现合并在同一个农场面板内，布局与牧场一致：上方自家管理、下方好友与批量操作。独立好友页签已移除，旧#/friends书签自动转到#/farm，不影响好友缓存或任务执行。右侧合并日志保持不变。

## 各场景一键务农与独立日志

- 农场“农场一键务农”提交`farm-manage`：自家照料，然后对全部可访问好友执行帮忙务农与偷菜。成熟收获、清枯株、指定种植仍可单独操作，不在本次一键照料中隐式执行。
- 牧场“牧场一键务农（含全部好友）”提交`pasture-manage`：自家清理、仅库存补草、开始生产、成熟收取、按已保存偏好补栏，再对全部好友清理和摘取。先补草再检查可生产条件，避免欠草动物需要再点一轮。
- 一键命令不接收指定好友或缩小好友数量的参数；不会按页面搜索结果限定范围。真实可操作目标仍受解锁、服务端配额与库存限制；没有目标的步骤安全跳过。
- 场景之间不复用对方的业务写方法。底层继续使用同一串行队列保护当前小游戏会话，不将两场景写操作并发发送。
- 每轮保留逐步结果，失败时保留先前已完成结果；未知写入立即停止，不自动重试。已有优先设置和动物购买授权/预算继续生效，不会因点一键而打开购买或定时。

右侧仍是一个混合日志框，但内容随页面隔离：农场只显示`farm`任务与日志，牧场只显示`pasture`，设置页显示`system`（连接及系统状态；独立托管设置的日志分别归入其场景）。任务与日志由后端明确标记scope，不按中文消息内容猜测；历史无scope的任务按命令类型兼容，无法确定归属的旧普通日志仅进入系统日志。各场景独立保留日志容量及滚动位置，不会因另一个场景操作多而将本场景记录挤掉。

本次验收：全量132项测试通过，包含两个场景命令、待核对锁、刷新前置、失败步骤部分结果、ALS并行日志隔离、日志/任务独立保留、journal重启恢复、前端过滤与独立滚动。浏览器在3211演示模式实际点击两个一键按钮：农场2步成功（自家照料1、好友照料1、偷菜2项）；牧场7步成功（库存补草5、收取1、补栏1、好友摘取1；无符合生产条件的动物安全跳过；自动购买花费0）。切页日志分别显示农场/牧场，不混入另一场景。

3210真实面板已安全重启并完成只读连接，真实农场/牧场均ready，无待执行任务、无待核对状态、定时关闭；真实账号没有提交本次新增的两个一键写命令，购买授权仍false、预算0。演示操作只改变演示内存，不访问真实账号。


## 独立无人托管与成熟筛选修复（2026-11-20）

用户提供的“确认12项、2条明确业务拒绝”已按实际任务核实：两条错误均为1001021“作物未成熟”。确认的12项未被回滚，属于部分完成，不是网络未知写。原偷菜筛选只有stealable和剩余果实，现额外要求实际成熟时间已到；尚未成熟、成熟时间缺失或未来成熟的地块不发送Harvest。服务器状态仍是最终依据；若访问后状态变化而被明确拒绝，会保留成功结果和具体拒绝，不盲目重试。任务记录现在直接展示“部分完成”、好友名称、错误码和原因。

- 农场页有“农场定时托管”：独立周期、开关、是否包含全部好友。周期为收获→清枯株→按已保存优先级（或明确选择的背包种子）补种→自家照料及全部好友帮忙/偷菜；不包含好友时只照料自家。
- 牧场页有“牧场定时托管”：独立周期、开关、好友范围、是否使用库存补草。周期为清理→可选库存补草→生产→收取→优先补栏→可选全部好友清理/摘取。购买仍受原授权与预算约束。
- 设置页已移除旧统一定时模块，页签更名“优先设置”。新接口为POST /api/monitor/farm、POST /api/monitor/pasture，状态在/api/state的monitors.farm/pasture。旧单一monitor接口仅保留兼容，不允许与新托管同时开启。
- 周期可设60–3600秒，默认300秒，启用后首次到期执行，不在切换开关时立即执行整轮。合法的关闭状态配置可以保存，关闭时的坏草稿不阻止停止。
- 两个场景可同时开启不同周期，共用安全串行队列。如果到期时正忙，每个场景只保留一轮待执行意图，队列空闲后执行，避免相同周期下另一场景长期饥饿；不会无限堆积或并发RPC。
- 停止/改周期会取消旧代际未发送的后续步骤，当前已在执行的批次允许收尾。正常业务失败只暂停所属场景；不确定写入因全局待核对锁而暂停两边，并分别记录原因。
- 关闭控制台网页不影响托管。Node服务、电脑及小游戏/CDP连接必须保持运行；服务停止、电脑休眠或游戏断连不能继续执行。服务重启后两边默认关闭，不擅自恢复写任务。

本轮全量161项测试通过，含真实mock时钟到期、无UI监听仍触发、同周期公平排队、独立句柄/代际、原子校验、停止可用性、部分结果与拒绝明细、成熟筛选。3211演示浏览器实际开启农场180秒、牧场420秒，确认同时独立启用；关闭牧场后农场仍保持启用，再关闭农场。验收结束两边均关闭。3210真实面板只读连接成功，两个真实托管均保持关闭，pending=0、needsReconcile=false；本轮未启用真实托管或执行真实写操作。

## 原生一键偷菜筛选修复（2026-11-22）

用户报告三位好友有成熟作物但Harvest返回1001040。本轮只读预览确认可见成熟作物；原实现漏解PlantInfo.field14 stealers（已摘玩家gid），并错误截断为前六块。已对照最初成功抓包、原生Plant.canSteal()及原生批量收集调用：成熟、stealable且当前selfGid不在stealers的所有有效主地块应作为同一个Harvest请求的land_ids，host_gid为当前好友、is_all=true。未改为逐地块RPC，未新增未验证的host_type/reason值，放虫草的原每好友上限不变。

运行时原生codec已只读核对field14为packed/unpacked repeated int64；native PlantInfo.encode({stealers:[1229136306,123]})生成7206b2c38cca047b。现场证据见out/management/bulk-harvest-native-evidence.json，原生一键源码局部见out/management/native-steal-source-extract-20261122.txt和native-steal-method-extract-20261122.txt。读取stealers前严格校验packed数据，损坏则停止而非猜测。未知写入仍不重试。

同时改进托管开关：仅提交处理中暂时禁用；前提不足时点击会给出明确原因并恢复真实开关状态，而非静默变灰。仍要求保存优先设置或明确选择种子，不自动替用户选种或开启。

本轮165项回归通过，其中24块前6块已由自己摘过的案例确保只发送一次is_all=true请求，包含后18块；全部已摘时不发写请求，packed/unpacked与截断数据均覆盖。修复已部署，未执行新的真实Harvest。诊断期间游戏网络离线，Web重启后只读连接仍报告“游戏网络当前不在线”，因此尚未宣称真实摘取已恢复。原配置已保存到out/management/pre-steal-fix-monitors.json并恢复周期/范围（农场60秒，牧场300秒），启用状态因断线暂不恢复；需重新打开小游戏、连接运行时后由用户开启。诊断前保存时牧场已因GetRanchDetail timeout暂停，并非本轮擅自将有效牧场托管改停。


## 牧场暂停原因与当前限制（2026-11-22）

14:34:59的pasture-friends-steal批次扫描15位好友，2位确认共7项，2位返回1045220已摘过；之后全量refresh中的AllCells超时。当前_verifyAfterWrite与任务写入标记会将这一末尾只读失败升级为uncertain，触发全局核对锁并暂停两边托管。此前已确认的7项不会因此撤销。该保守分类尚未修复，不应将当前实现描述为仅在真正写入未知时才停。牧场摘取候选也尚未补充当前账号stealers过滤，不能与已修复的农场筛选混淆。刷新核对成功不会自动恢复托管开关，需用户按需启用。

优先设置操作：下拉选择→添加到优先列表→保存对应种子/动物设置→开启场景托管，首次到期执行。保存本身不触发补种/补栏；农场无空地、牧场无兼容空位或库存不足时跳过，不覆盖生长中的作物或已有动物。根目录README.md提供当前启动与使用入口。
