# Mailbox M0：正式 Node core 验收 + 真实 Codex hooks 验证

日期：2026-09-20。基线：方案 v6.2；Codex CLI **0.153.3**（真实 `codex app-server`，隔离 CODEX_HOME + 回环 mock 模型端点，无凭据、无外部服务）；Linux x64、Node v22.23.2。

**结论：M0 全部通过，建议放行 M1/M2。**

- ⑥⑦⑧⑨ 已从 Python 策略原型迁移到**正式 Node mailbox-core**（`shared/mailbox/core.mjs` + `protocol.mjs` + `bridge/mailbox-cli.mjs`，零依赖），全部通过，三连跑稳定。
- 真实 Codex hooks ①②③④⑤ 通过，且发现并修复了三个**只有真实宿主测试才能暴露**的实现缺陷（见 §3）。
- 过程中在 core 里修掉两个并发反例（锁创建竞态、检查期释放竞态），与 v6.2 报告候选修正互补。

## 1. 正式实现

```
shared/mailbox/core.mjs      ~380 行：SAMP 日志、水位线、积压标记、replay、
                             mkdir 锁（pid 持有者 + 死亡抢占 + 归属校验释放）、
                             发送者锁覆盖完整补写、残尾隔离、check hooks
shared/mailbox/protocol.mjs  SAMP id/thread 规范实现 + 按接收端能力渲染
bridge/mailbox-cli.mjs       CLI：register/list/send/dispatch/report/inbox/check/replay
```

写入规则（v6.2 报告四条）全部落地：发送者锁覆盖「尾行检查 → 隔离 → 整个补写循环」；残尾先补 `\n` 再追加正文；失败保留残片报错；完整记录+换行落盘才算成功。故障注入钩子（`MAILBOX_WRITE_CHUNK` / `MAILBOX_FAULT_ENOSPC_AT` / `MAILBOX_CRASH_STAGE` / `MAILBOX_HOLD_LOCK_MS`）为 env 门控的测试专用路径。

**与 Python 原型的对应差异**：Node 无内建 flock，锁用 mkdir + pid 文件实现，语义等价（互斥、死亡自动可抢占、有界等待 30s）。抢占策略见 §3 修复 2。

## 2. ⑥⑦⑧⑨ 正式 core 验收（scripts/mailbox-m0/test-core.mjs）

| 用例 | 断言 | 结果 |
|---|---|---|
| ⑥ 积压读完 | 10 条、每轮 2 条、5 轮投完；期间 backlog=true；日志 fingerprint 不变；第 6 次短路无输出 | PASS ×3 连跑 |
| ⑦a emit 后杀进程 | SIGKILL 于输出后、状态提交前；残留读者锁被下一进程抢占；同 2 条重投（预期重复）；第 3 次继续新 2 条 | PASS |
| ⑦b 提交后恢复 | 正常消费→静默；replay --all → 重投 2 条；backlog 清零 | PASS |
| ⑧a 单条 replay 打败短路 | 读完全部后 replay 单条；日志不变；仅该条重投 | PASS |
| ⑧b 并发 check+replay | check 持锁 1.2s 期间 replay 阻塞等待；重放意图不丢失；后续 check 完成重投 | PASS |
| ⑨a 残尾隔离 | 注入 ENOSPC 于 20 字节 → 发送失败、残片保留；下一次发送先隔离（标志+stderr 告警）再成功；扫描恰 1 坏行、2 好行；坏行不影响读取 | PASS |
| ⑨b 并发同别名写 | 4 进程 × 25 条、每次 write 7 字节 → 100 条唯一记录、**0 坏行** | PASS |
| SAMP id 跨语言 | node `JSON.stringify` 与 python `json.dumps(ensure_ascii=False, sort_keys, separators)` 对同一记录（含中文/emoji/换行）产出相同 sha256[:16] | PASS |
| check 语义 | stop 每 turn ≤2 次 block（含首次）跨 turn 重置；posttooluse 注入 additionalContext；垃圾 stdin fail-open `{}` | PASS |
| 别名规则 | 歧义前缀报错列候选；未知收件人报错；活 pid 占用拒绝注册、死后释放 | PASS |

性能（进程级，含 Node 启动）：空目录冷路径 25.8ms / 100 条短路 25.7ms / 100 条重扫 25.2ms——**Node 启动主导，扫描成本可忽略**；与 v6.1 基线 22.53ms 一致，无回归。

## 3. 真实 Codex hooks 验证（scripts/mailbox-m0/probe-codex.mjs）

隔离环境：临时 CODEX_HOME；hooks.json 指向 `codex-hookwrap.mjs`（记录 stdin + 计时 + 调真实 mailbox-cli）；`wire_api="responses"` 回环 mock（0.153 已移除 `"chat"`）；`bypass_hook_trust` 仅对本目录生成的 hooks；`[sandbox_workspace_write] writable_roots=[mailbox]`；真实 turn 完成（exec_command 工具调用 + 最终回复 + Stop）。

| 项 | 验证内容 | 结果 |
|---|---|---|
| ① stdin 字段 | PostToolUse 含 session_id/turn_id；Stop 含 session_id/turn_id/**stop_hook_active**/last_assistant_message | PASS |
| ② 空闲滞留 | turn 结束后发 2 条，3.5s 观察 + thread/read 均无投递；下一 turn 事件送达 | PASS（确认无唤醒，符合设计边界） |
| ③ 连续 Stop block | 6 条待投：posttooluse 2 → stop block①2 → stop block②2 → cap 放行；跨 turn 重置；全部进入对话 | PASS |
| ④ hook 开销 | 7 次调用中位 **26ms**、p95 29ms（含 node 启动），无回归 | PASS |
| ⑤ writable_roots | 水位线持久化：无重复投递，seen 单调 | PASS |

**端到端证据**（rollout transcript）：PostToolUse 消息以 **developer message** 入对话；Stop block reason 以 `<hook_prompt>` **user message** 入对话并触发模型续跑；两通道内容均在后续模型请求中出现。

### 3.1 真实宿主暴露的三个缺陷（已修，均已回归验证）

1. **reader 身份错误**：checkHook 曾以 stdin `session_id`（codex 内部 thread id）为邮箱读者，与别名体系脱节，消息永远匹配不上。修正：读者 = 显式别名 / `MAILBOX_ALIAS`，session_id 仅用于 block 计数键隔离。
2. **PostToolUse additionalContext 静默丢失**：不带 `hookEventName` 的输出被 codex 忽略——hook 照常标记 seen，内容却永不入对话（**静默丢失路径**）。修正：输出补 `hookSpecificOutput.hookEventName="PostToolUse"` 后确认入对话。Stop 的 `decision/block/reason` 无此要求（已验证）。
3. **同秒消息乱序**：scan 曾按内容寻址 id 排序，同一秒内消息按哈希序投递（实测 3,5 先于 1,2）。修正：按 (ts, 写者文件序, 行号) 排序，实测 1,2 → 3,4 → 5,6 依插入序投递。

### 3.2 core 并发反例（⑥-⑨ 迁移过程中暴露，已修）

- **锁创建竞态**：contender 在 owner `mkdir` 后、写 pid 前读取 → ENOENT 被当死锁抢占 → 双持锁并发写（t9b 首跑 98/100 触发）。修正：无 pid 文件且目录年龄 <1.5s 视为活owner等待；释放前校验归属（pid 相同才删锁目录）。
- **检查期释放竞态**：contender inspect 时 owner 恰好释放，`statSync` ENOENT 直接抛出。修正：inspect 遇 ENOENT 重试循环。

## 4. 验收边界（本报告不覆盖）

- 断电/磁盘满的持久性边界：delivered 语义仍是「输出写入后标记」，未做 fsync 故障注入；尽力投递承诺不变。
- 未测：`codex exec`/TUI 交互模式（仅 app-server 协议路径）、macOS、AGENTS.md 兜底通道、attachment 长消息路径、pi 扩展切换（M1 范围）。
- mock 模型不验证 agent 对注入内容的**遵循**（ack/report 行为），只验证投递链路。
- ⑦a 的重复投递是 at-least-once 预期行为；去重依赖接收端按 id（AGENTS.md 约定，M2 范围）。

## 5. M1/M2 放行判断

**放行。**依据：

- v6.2 四条写入规则在正式实现上通过全部迁移用例，含两个并发反例修复；
- 真实 codex 三层投递链路（SessionStart 注册 / PostToolUse dev message / Stop user message + cap）端到端验证成立；
- 空闲滞留、writable_roots、hook 开销（26ms 中位）均符合设计预期；
- 发现的三个宿主级缺陷已修复并回归，其修复已沉淀为方案实现约束（hookEventName 字段、别名读者、插入序投递）。

M1 注意事项：pi 扩展切换数据层时按 v6.2 §4.4 的升级顺序（停旧会话→换文件→重启）；旧 inbox 存量可放弃。M2 注意事项：AGENTS.md 兜底 + writable_roots 接线脚本 + report 指引按接收端能力渲染（已实现）。

## 6. 复现

```sh
node scripts/mailbox-m0/test-core.mjs      # ⑥⑦⑧⑨ + SAMP id + check 语义 + 别名（需 node≥18）
node scripts/mailbox-m0/probe-codex.mjs    # 真实 codex ①②③④⑤（需 codex≥0.153、linux、python3 不需要）
```

两者均只写新建 `/tmp/mailbox-m0-*` 目录；退出码 0 = 全部断言成立。历史快照：本轮 `test-core` `/tmp/mailbox-m0-node-tT2JN8`、`probe-codex` `/tmp/mailbox-m0-codex-CYBK3p`。
