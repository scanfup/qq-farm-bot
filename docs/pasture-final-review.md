# 牧场最终只读 review（2026-11-20）

范围：仅静态阅读 `web/pasture.mjs`、`web/service.mjs`、`tools/test-pasture-live.mjs`；未使用浏览器、未发游戏 RPC、未修改现有代码。90 个既有测试仍是基础证据；以下是未重复 mock 修复后、会影响真实联调的风险。

## 必须在真实写入前修复

### 高：全部好友批处理仍被 `bigFarmStatus` 摘要门控

`web/pasture.mjs:369-373` 的 `_friendTargets()` 过滤条件要求 `friend.bigFarmStatus` truthy。`FriendService.GetAll(scene=2)` 的好友可能没有 `big_farm_status` 摘要；这会让 `pasture-friends-clean` 和 `pasture-friends-steal` 在详情可读、但摘要缺失时直接跳过好友，不符合“所有好友一键清理/摘取”。

最小修复：候选集合只排除 `isSelf`，保留正 GID；逐个 `GetRanchDetail` 后以真实 `hazards`/`shelves` 决定是否写。`bigFarmStatus` 可用于 UI 候选提示，不应作为真实目标资格门槛。若需要保护机器人/特殊 hostType，应显式按 hostType 规则处理并记录跳过原因，不使用摘要存在性代替权限判断。

### 高：好友摘取用“任意奖励”确认，可能把无关奖励算作成功

`web/pasture.mjs:394-410` 先以好友详情前后货架数量、自身 stealer 标记确认；但若这些都没有变化，代码仍把 `operationResults(reply)` 中任意带正 `rewards[].count` 的 op_result 数量作为 `rewarded`，再 `Math.max(confirmed, Math.min(refs.length, rewarded))`。op_result 的真实字段只有 `facility_inst_id/kind/target_id/rewards/costs`，当前没有证据表明 rewards 与本次每个 shelf target 一一对应。一个其他奖励即可令目标被报告为成功。

最小修复：只接受逐目标可关联的 `target_id` 奖励，或要求目标货架 `total_remain/lots.remain_num` 下降、自身 stealer 标记出现；无法关联时返回 `uncertain`，不以全局 reward 数量充当摘取数量。测试应覆盖“有 rewards 但货架无变化且无 target_id 关联” => uncertain/count=0。

## 中风险：真实字段/业务语义需联调确认

### 中：Harvest 的 stage 5/`can_harvest` 变化假设仍需真实确认

`web/pasture.mjs:338-353` 对所有可收取动物使用 `animal.can_harvest === true`，写后仅接受该动物实例消失或 `can_harvest !== true`。这对已读到的 stage=5 目前合理，但服务端可能保留 stage/实例并只清产量、改变 `produce_count` 或 `can_harvest` 的其他组合。若真实回包后实例仍存在且产量已下降，当前逻辑会标 uncertain、阻止后续批次。

最小修复建议：在第一笔真实小范围 `limit=1` 验收中记录 before/after 的实例、`can_harvest`、`produce_count`、货架数量及 rewards；按实际服务语义加入明确的“收取成功变化”判定，不能事先放宽为成功。失败时保守 uncertain 是安全的。

### 中：好友清理的“无写请求”任务会成功，但结果应明确区分 no-op

`_friendsClean()` 在 `web/pasture.mjs:380-389` 对所有候选逐个详情读取，没有危害时不写；之后无论是否有候选/是否有危害都刷新并返回成功消息。安全性没问题，但全好友无摘要时当前高风险门控会使它变成空操作且消息仍像正常完成。修复摘要门控后，建议结果增加 `visitedFriends`、`skippedNoHazard`、`skippedNoSummary`（后者仅在显式策略跳过时），让 UI 不把“0项”误解为已经清理。

### 中：服务端 `pastureCommand()` 每个写命令会先 refresh，PastureService 写方法还会再次读

`web/service.mjs:251-256` 先 `this.pasture.refresh()`，随后 `PastureService.run()` 的 `_place/_buy/_feed/_harvest/_clean...` 又进行自己的详情/背包/商店读取。这不会错误写入，但批量“所有好友”会产生大量重复读取，增加超时和上下文失效概率；未知读取失败会在任何写入前终止该 job。真实联调时应观察请求量和超时，后续可让写命令只使用 PastureService 自己的 fail-closed refresh，保留显式 `pasture-refresh` 作为单独读任务。

## 监控和恢复审查

- `service.mjs:376-400` 的 generation 检查会在 stop/reconfigure 后停止旧周期后续步骤；这部分已有管理测试覆盖。
- `service.mjs:110-115` 的 reconcile checkpoint 会写入 journal，重启不会无限恢复已经核对的旧 uncertain job；已有回归覆盖。
- `service.mjs:360-370` 仅牧场模式不检查农场种子库存；农场模式要求 inventory ready。空优先列表+fallback=true 的后端路径仍应在真实/HTTP回归中确认，避免被前端保存语义覆盖。
- `service.mjs:163-172` 对未知写错误设置 uncertain；PastureService 对业务拒绝通过 `operationFailure` 进入好友批处理。不要把未知 `kind` 或无 code 的 op_result 猜成业务成功/拒绝。
- `tools/test-pasture-live.mjs:24-31` 手动验收会购买鸡、收取、入栏、补草、好友清理和摘取；脚本已要求 `--write`，但它假设鸡商品解锁、价格为2，且 `pasture-harvest --limit 1` 必有可收目标。真实运行前应先 preflight 重新确认这些条件；没有可收目标时脚本会在第一步失败并停止，属于安全失败。
- `tools/test-pasture-live.mjs:34-40` 定时验收等待 110 秒，以出现 `pasture-friends-steal` job 为一轮完成标记。若前一步 no-op 或好友无可偷产物，任务仍应成功但该末步骤可能仍被提交；若监控被业务/uncertain错误停止，脚本会报告失败并执行 restore。运行前确认日志目录和 restore 的原偏好文件可写。

## 结论

当前实现对未知写结果总体偏保守，库存/余额/容量/补草 owner 检查较完整；但在真实联调前必须先去掉好友 `bigFarmStatus` 存在性门控，并收紧 StealProduce 的 reward 关联判定。Harvest 的 stage5实际变化、好友无写 no-op 统计和重复 refresh 可在首轮只做 `limit=1` 的真实验收中确认。按用户要求，本 review 没有改代码、没有浏览器操作、没有调用游戏 RPC。

证据参考：`out/protocol/pasture-readonly.json` 的场景2好友/牧场实测；`docs/牧场接口清单.md`；`docs/pasture-write-protocol.md`；`web/pasture.test.mjs` 的24项有状态 mock 测试。
EOF
