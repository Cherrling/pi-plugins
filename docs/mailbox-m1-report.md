# Mailbox M1 报告：pi 扩展切换正式 core

日期：2026-09-20。基线：方案 v6.2 + M0 放行（`mailbox-m0-node-report.md`）。

**结论：M1 通过并已部署。** pi 扩展数据层切换到正式 shared core（SAMP 日志），
原生命令、工具、轮询/followUp 行为保留；安装产物自包含；真实 pi↔pi 闭环验证通过；
旧数据迁移完成。M2（codex 接入包）可以开始。

## 1. 变更内容

| 项 | 说明 |
|---|---|
| 数据层 | `src/mailbox.ts`+`protocol.ts`（inbox + 删除式消费）→ `src/shared/core.mjs`（GENERATED，append-only 日志 + 水位线） |
| 行为保留 | `/msg-name`、`/msg-sessions`、五个工具同名同义；3s 轮询；idle 直发 / busy followUp；task 投递翻 busy、report 翻 idle；notify 提示 |
| 新增能力 | 歧义寻址报错（原版静默取第一个）；离线标记；`/new` 时水位线随别名迁移；改名后历史别名收件继续投递（见 §3.2） |
| 自包含 | `scripts/sync-shared.sh` 同步产物进插件目录（GENERATED 头 + sha256 校验），`cp -r` 即装 |
| 迁移 | `scripts/mailbox-migrate.mjs`：备份 → 旧 inbox 消息转日志（未读保留、ms→s、taskId 保留）→ 移除旧格式注册 |

## 2. 验证

### 2.1 真实 pi↔pi（`pi -ne -e` 仓库直载，隔离 MAILBOX_DIR）

| 场景 | 结果 |
|---|---|
| 扩展加载 + 工具执行 + 注册生命周期 | PASS（会话期注册、退出注销、state 保留） |
| **任务闭环**：alice `dispatch_task` → bob（bash sleep 45 忙碌中）→ followUp 排队不打断 → 醒后处理 → `report_task_result` → alice（sleep 60 中）followUp 收回报 → 输出「21×2=42，闭环 ✓」 | PASS，日志两条记录 taskId 严格配对 |
| **忙时排队** | mid-flight 实测 `sessions/bob.json` = `{state:"busy", busyTaskId:"t-…"}` |
| 部署产物经默认发现加载（真实安装路径，无 -e） | PASS |

### 2.2 核心级回归（`scripts/mailbox-m0/test-m1.mjs`，可重复）

| 用例 | 覆盖 | 结果 |
|---|---|---|
| pi-flow-dispatch-report | dispatch→deliver→busy 翻转→pi 渲染（指引 report_task_result）→report→idle 翻转→result 渲染 | PASS |
| rename-carries-watermark | 改名后已读水位线保持、未读投递、历史别名收件继续投递、旧名释放 | PASS |
| legacy-migration | 旧消息（chat/task/坏行/中文）转 SAMP 记录、未读保留、新格式注册不动、备份生成 | PASS |
| plugin-self-contained | index 引 bundled core、产物齐全、checksum 与 shared 一致 | PASS |

M0 全量回归（test-core.mjs 11 用例）同时通过——core 本轮改动（emit 传 remaining、
别名历史投递、renameReader 强化）无回归。

### 2.3 真实环境迁移与部署

- 扩展：旧目录备份至 `~/.pi/agent/session-messaging.bak-20260920-052855`（**移出 extensions/**，否则被自动发现导致工具名冲突），新版本已部署
- mailbox：`mailbox.bak-1789853353270` 备份后迁移（0 条存量消息——旧 inbox 本就即读即删；1 个旧格式注册移除）
- 运行中会话（含本次验证会话）内存中仍为旧代码，**重启后**切换到新数据层；升级窗口内旧会话消息新会话收不到（README 已注明）

## 3. 过程发现

### 3.1 测试方法学

- `-p` 模式下 `session_shutdown` 会注销注册——首次冒烟误判为"注册失败"，实为正确的生命周期
- 模型在工具失败后会用 bash 自行翻 mailbox 目录"找会话"，产生误导性输出；隔离测试必须核对文件系统而非仅看模型转述
- shell 陷阱：`B=… && cmd &` 把赋值一起丢进后台子 shell，后续主 shell `$B` 为空 → alice 连到真实 mailbox（已清理误写入的 log-alice.jsonl / worker.json）

### 3.2 真实设计缺口（已修）

**改名后历史消息失联**：rename 只迁移水位线，但日志中 `to=旧名` 的在途消息永远不会投递给新别名（append-only 不可改写 `to`）。修复：state 增加 `aliases` 历史，投递过滤 `to === 当前 || to ∈ 历史`；`renameReader` 在无 state 时也会播种别名历史。测试 rename-carries-watermark 覆盖。

## 4. 边界与遗留

- `/msg-name` 的 TUI 交互路径未在真实 TUI 验证（-p 无法触发命令）；逻辑由核心级测试覆盖，首次 TUI 使用时留意
- `peek_session` 仍只支持 pi 对端（需 sessionFile）；codex 对端返回明确错误
- 升级窗口的"新旧插件不可混跑"已在 README 注明；所有旧会话重启后即消除
- 旧 `inboxes/` 目录留存（空），可手工清理

## 5. 复现

```sh
node scripts/mailbox-m0/test-core.mjs   # M0 全量回归
node scripts/mailbox-m0/test-m1.mjs     # M1 核心级回归
# 真实 pi↔pi：见 §2.1（pi -ne -e plugins/session-messaging/index.ts + MAILBOX_DIR 隔离）
```
