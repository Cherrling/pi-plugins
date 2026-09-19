# session-messaging

多会话编排（boss/worker 工作流），跨 agent 通信（pi × codex），纯文件系统邮箱，无服务器。

## 架构（M1 起）

```
plugins/session-messaging/
├── index.ts            # pi 扩展装配：命令 + 工具 + 轮询/followUp 投递
└── src/
    ├── peek.ts         # 只读监控：解析 pi session jsonl + 压缩 + 卡死检测
    └── shared/         # GENERATED — 由 scripts/sync-shared.sh 从 shared/mailbox/ 同步
                        # （core.mjs + protocol.mjs，与 codex 侧共用同一协议）
```

数据层是 **SAMP 兼容的 append-only 日志**（v6.2 方案，见 `docs/mailbox-cross-agent-plan.md`）：

```
~/.pi/agent/mailbox/            （env MAILBOX_DIR 可覆盖）
  log-<别名>.jsonl              # 每个发送者一个，只追加，永不删除
  .state/<别名>.json            # 水位线 + 积压标记 + block 计数 + 别名历史
  sessions/<别名>.json          # 注册表（kind=pi，含 pid/sessionFile/state）
  files/                        # 超长消息的持久附件
```

可靠性：**尽力注入 + 原文永久保留 + 可重放**（`mailbox replay`）；重复投递按消息 id 去重；投递顺序按 (ts, 写者, 行号) 保持插入序。

## 命令（人类）

| 命令 | 作用 |
|---|---|
| `/msg-name <name>` | 改名（水位线与未读消息随别名迁移；历史别名收件继续投递） |
| `/msg-sessions` | 列出在线会话（忙闲、离线标记、cwd） |

## 工具（agent）

| 工具 | 参数 | 作用 |
|---|---|---|
| `send_session_message` | to, text | 闲聊/自由通信 |
| `list_sessions` | — | 在线会话 + 忙闲/离线状态 |
| `dispatch_task` | to, task | 派发带 taskId 的任务；worker 端 prompt 强约束完成后回报 |
| `report_task_result` | to, taskId, result | worker 回报结果（自动把状态翻回 idle） |
| `peek_session` | to, lines? | 只读查看对方最近对话（仅 pi 对端，需 sessionFile） |

收件人寻址：精确名或唯一前缀；**歧义前缀报错列候选，绝不自动挑选**。

## 安装

```bash
cp -r . ~/.pi/agent/extensions/session-messaging
```

目录自包含（shared 产物已内置，node_modules 含 typebox）。修改 `shared/mailbox/` 后运行
`scripts/sync-shared.sh` 重新同步并重新安装。

## 升级（从旧 inbox 版本）

1. 停止所有正在运行的 pi 会话
2. `node scripts/mailbox-migrate.mjs`（自动备份 `mailbox.bak-<ts>`，旧 inbox 消息转入日志，未读保留）
3. 替换 `~/.pi/agent/extensions/session-messaging`（旧目录备份请移出 extensions/，否则会被自动发现并工具名冲突）
4. 重启会话

> 旧插件与新插件**不可混跑**：旧版 `listSessions()` 会清理所有过期注册；
> 旧会话发的消息走旧 inbox，新会话读不到。升级窗口内请勿跨会话通信。

## 工作流（内核审计示例）

1. 各 worker 会话起名：`/msg-name syscall-audit`（或用 `PI_SESSION_NAME=<名字>` 派出 `pi -p`）
2. boss 会话起名 `boss`，对它说「扫一遍 net/ 子系统」
3. boss：`list_sessions` → 给空闲 worker `dispatch_task`
4. boss 随时 `peek_session` 看进度（不打扰 worker）
5. worker 完成后 `report_task_result`（带 taskId）→ boss 汇总
6. worker 卡住：peek 的卡死提示 + boss 发消息纠偏或人工切窗口干预
