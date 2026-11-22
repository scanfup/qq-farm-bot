# QQ 农场 Web 迁移架构（历史备选）

> **2026-11-19 路线修正：用户已明确保留 CDP，将现有控制工具 Web 化。本文的自建游戏后端/导入路线不用于当前实现。当前架构为浏览器 → 本地 Node HTTP/SSE → 单账号队列 → CDP → 原小游戏 → 原服务器。启动与功能说明见 [Web 控制台](../web/README.md)。**

> 本方案基于当前工作区的抓包、运行时注入和参考实现整理。目标是把“农场玩法”迁移为可维护的 Web 产品，而不是把浏览器变成 QQ/微信私有协议客户端。

## 0. 先定边界：两条路线

### 推荐路线：Web 原生后端（生产路线）

浏览器只访问自有 HTTPS/WSS API；农场状态、操作校验、定时任务和资源索引由自有后端负责。原 QQ/微信服务只作为**可选的数据导入源**，不作为浏览器的在线依赖。

优点：

- 不把一次性登录 code、TSDK/ACE、私有 WSS 暴露给浏览器。
- 不依赖第三方页面注入、CDP 端口或客户端常驻。
- 可做多账号、审计、限流、回放和版本化迁移。
- 前端可以逐步替换 Cocos 资源和交互，不必一次复刻原客户端。

### 过渡路线：Legacy Bridge（迁移/核对路线）

保留一个受控的 Node.js Worker，通过 CDP 连接已登录的小游戏运行时，调用 `__netInst.send()` 获取明文 protobuf 响应，再转换成内部领域模型。它只用于：

1. 读取旧账号快照；
2. 对比 Web 版规则和数值；
3. 在迁移期间做人工核对。

它不应成为浏览器的直接代理，也不应把第三方私有 token/code 存入前端或公共 API。

## 1. 总体拓扑

```text
                         ┌─────────────────────────────┐
                         │ Web Client                   │
                         │ React/Vue + Canvas/WebGL     │
                         │ Query cache + command UI     │
                         └──────────────┬──────────────┘
                                        │ HTTPS / WSS
                         ┌──────────────▼──────────────┐
                         │ BFF / API Gateway            │
                         │ JWT/session · rate limit     │
                         │ command idempotency          │
                         └───────┬───────────┬──────────┘
                                 │           │
             ┌───────────────────▼───┐   ┌──▼────────────────────┐
             │ Domain API             │   │ Realtime Gateway       │
             │ farm/friend/inventory  │   │ snapshot + events      │
             │ task/admin              │   │ per-user channels      │
             └──────────────┬──────────┘   └──────────┬─────────────┘
                            │                         │
                   ┌────────▼─────────────────────────▼───────┐
                   │ Domain Services / Command Workers        │
                   │ Farm · Friend · Inventory · Scheduler     │
                   │ rule validation · cooldown · outbox       │
                   └──────────┬─────────────┬──────────────────┘
                              │             │
                 ┌────────────▼───┐   ┌────▼──────────────────┐
                 │ PostgreSQL      │   │ Redis / Queue         │
                 │ source of truth │   │ locks · jobs · pubsub │
                 └───────────────┘   └────────────────────────┘

  optional, isolated:
  ┌──────────────────────┐      ┌─────────────────────────────┐
  │ Legacy Bridge Worker │─────▶│ Import Adapter               │
  │ CDP + __netInst      │      │ protobuf → domain snapshot   │
  └──────────────────────┘      └─────────────────────────────┘
```

## 2. 领域拆分

### 2.1 Farm Domain

- `Land`：地块编号、解锁状态、作物、成长阶段、成熟时间、干旱/虫/草状态。
- `CropCatalog`：种子、成长时长、产量、售价、资源引用。
- Commands：`Harvest`, `Plant`, `Water`, `Fertilize`, `RemovePlant`, `UnlockLand`。
- 所有写操作以 `commandId` 幂等；超时后先重新读取快照，不自动重发。

当前参考实现已经验证 `AllLands` 是土地和 `operation_limits` 的主要来源；Web 版应把它抽象为内部 `FarmSnapshot`，不要让 UI 依赖 protobuf 字段名。

### 2.2 Friend / Visit Domain

- `Friend`, `VisitSession`, `SocialAction`。
- 访问、偷菜、放虫、放草、帮助务农分别建审计记录。
- 先根据好友摘要筛选目标，再创建访问任务，避免逐个好友无条件进入。
- 删除好友默认 `dryRun`，前端二次确认后才提交。

### 2.3 Inventory / Economy Domain

- 种子、肥料、道具、金币、经验、任务奖励。
- 余额和道具变更只允许通过领域命令产生；禁止前端直接提交“新余额”。
- 所有经济变更写入 append-only `economy_ledger`，便于回滚和异常审计。

### 2.4 Scheduler Domain

- 预测式调度：根据 `ripeAt / dryAt / weedAt / insectAt` 计算下一次触发时间。
- 每个账号一把分布式锁；任务可取消、可暂停、可重试。
- 前台点击、农场巡检、好友同步、系统保活分不同队列；不要让后台巡检饿死用户操作。
- 日限额在服务端强制执行；达到上限后当天熔断，不能只依赖前端按钮禁用。

## 3. API 契约（Web 版，不暴露私有协议）

### 查询

```text
GET  /api/v1/farms/:farmId/snapshot
GET  /api/v1/farms/:farmId/lands
GET  /api/v1/farms/:farmId/friends
GET  /api/v1/catalog/crops
GET  /api/v1/tasks?farmId=...
```

### 命令

```text
POST /api/v1/farms/:farmId/commands/harvest
POST /api/v1/farms/:farmId/commands/plant
POST /api/v1/farms/:farmId/commands/water
POST /api/v1/farms/:farmId/commands/visit
POST /api/v1/farms/:farmId/commands/raid
POST /api/v1/farms/:farmId/commands/cleanup
```

命令请求统一格式：

```json
{
  "commandId": "uuid",
  "expectedVersion": 42,
  "dryRun": false,
  "payload": {}
}
```

响应统一返回：

```json
{
  "commandId": "uuid",
  "accepted": true,
  "snapshotVersion": 43,
  "result": {},
  "warnings": []
}
```

### 实时通道

`WSS /api/v1/realtime` 只推送内部事件：

```json
{"type":"farm.snapshot.changed","farmId":"...","version":43,"patch":{}}
{"type":"task.progress","taskId":"...","status":"running","done":3,"total":13}
{"type":"notification","level":"warning","code":"DAILY_LIMIT_REACHED"}
```

浏览器不接触 `gatepb.Message`、`token`、`client_seq`、TSDK/ACE 或第三方 WSS URL。

## 4. 数据模型最小集

```text
users
farms(id, user_id, version, timezone, status)
lands(farm_id, land_id, unlocked, crop_id, planted_at, ripe_at, dry_at, weed_at, insect_at)
crop_catalog(crop_id, version, grow_seconds, yield, sell_price, asset_key)
inventory(farm_id, item_id, quantity, version)
friends(farm_id, friend_gid, display_name, last_sync_at, summary_json)
commands(id, farm_id, type, payload_json, status, idempotency_key, created_at)
tasks(id, farm_id, type, schedule_json, status, next_run_at)
economy_ledger(id, farm_id, event_type, delta_json, command_id, created_at)
events(id, aggregate_id, aggregate_version, type, payload_json, created_at)
imports(id, farm_id, source, source_version, checksum, status, raw_ref)
```

状态更新建议采用：事务写领域表 + outbox 事件 + 异步发布；不直接在 WebSocket handler 中修改多个表。

## 5. 前端分层

```text
app-shell
├─ auth/session
├─ farm-scene             # Canvas/WebGL，先做 2D 网格，不急于复刻 Cocos
├─ farm-panels            # 地块、背包、好友、任务
├─ command-client         # REST 命令、幂等键、错误映射
├─ realtime-client        # WSS 重连、版本检查、patch 合并
└─ offline-cache          # 只缓存只读快照，不缓存敏感凭据
```

首版优先做“可操作、可观测”的 2D 场景：地块状态颜色、成熟倒计时、批量收获/种植、操作结果和日志。动画、Spine、全量资源替换放到第二阶段。

现有 HAR 中 787/807 条是 CDN 静态资源，说明资源可以另行做清单和版权审查；不能把这份 HAR 当作业务 API 规范，也不能直接把第三方 CDN 作为 Web 版生产依赖。

## 6. Legacy Bridge 设计

```text
CDP Controller
  └─ Runtime.evaluate(__bot.call(service, method, bodyHex))
       └─ protobuf decoder
            └─ ImportNormalizer
                 └─ Import API（签名、审计、人工确认）
```

约束：

- Bridge 只运行在受控机器/容器，账号级隔离，一账号一 Worker。
- 不保存一次性 `code`、token 或完整第三方会话帧；只落地最小业务快照。
- 导入必须带 `sourceVersion`、抓取时间、checksum 和字段映射版本。
- 导入结果先进入 `staging`，经差异报告确认后再合并生产库。
- Bridge 掉线不影响 Web 版自有状态机。

## 7. 迁移阶段与验收

| 阶段 | 交付 | 验收 |
|---|---|---|
| M0 证据冻结 | 字段字典、资源清单、协议缺口清单 | 明确哪些来自运行时、哪些是假设 |
| M1 Web 壳 | 登录、农场快照、地块网格、REST/WSS | 可查看模拟账号，不依赖 QQ/微信 |
| M2 核心玩法 | 收获、种植、浇水、背包、经济流水 | 命令幂等、并发冲突可复现且可恢复 |
| M3 社交玩法 | 好友、拜访、帮助、偷菜/虫/草 | 日限额、审计、dry-run 和任务进度完整 |
| M4 导入桥 | Legacy Bridge + staging diff | 导入前后地块/库存差异可解释 |
| M5 资源和体验 | 资源 CDN、自有对象存储、动画、移动端适配 | 断网恢复、版本回滚、性能预算达标 |
| M6 灰度上线 | 小范围账号、监控、备份、回滚 | 错误率、延迟、任务积压和经济异常均有告警 |

## 8. 当前抓包/运行时结论对架构的影响

- `servicewechat.com.har` 是冷启动静态资源阶段：807 entries 中 787 条 CDN，0 条 WebSocket/业务 RPC；因此不能据此设计浏览器接口。
- 运行时已验证 `__netInst.send(明文 protobuf, method, callback, service)` 能由游戏内部完成加密、token、seq 和 WSS 发送；这适合 Legacy Bridge，不适合把私有链路搬进浏览器。
- 登录 code 一次性且只存在运行时；Web 版不应把它当长期凭据，也不应由前端保存。
- 心跳约 25 秒、ACE/反作弊保活和第三方版本变化属于旧客户端适配责任；Web 原生后端应使用自己的会话、任务和风控机制。

## 9. 下一步（建议按顺序）

1. 先确认产品边界：是“自有规则重建”还是“必须与原 QQ 农场实时双向同步”。
2. 建立 `FarmSnapshot`、`Command`、`ImportSnapshot` 三份内部契约和字段映射表。
3. 用模拟数据完成 M1/M2，先不接第三方登录和私有 WSS。
4. 对当前运行时做一次最小导入：`AllLands`、好友摘要、背包/账户摘要，生成 staging 差异报告。
5. 只有在字段和授权边界明确后，才决定是否保留 Legacy Bridge；不要先做 mmtls/TSDK 浏览器化。
6. 补抓业务操作阶段的 WSS 帧，仅用于校验版本差异和字段映射，不把现有 HAR 当成完整协议。

## 10. 风险清单

- **协议/版本风险**：客户端版本变化会改变字段、登录和运行时对象；适配器必须带版本号。
- **账号与合规风险**：第三方账号、私有接口、反作弊和自动化操作需要获得明确授权；Web 版默认不绕过这些控制。
- **经济一致性风险**：批量命令、重复提交和超时重试可能造成重复奖励；必须使用幂等键、版本号和流水账。
- **资源风险**：当前资源来自第三方 CDN，需确认授权、缓存策略和替代资源方案。
- **实时性风险**：WSS 断线、浏览器后台节流、移动网络切换；服务端调度不能依赖浏览器定时器。

结论：**先做 Web 原生领域服务和模拟玩法，再用隔离的 Legacy Bridge 做数据导入/对账。不要把 QQ/微信私有 WSS、TSDK、ACE 和一次性登录 code 直接暴露给浏览器。**
