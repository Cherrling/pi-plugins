# session-messaging

多 pi 会话编排（boss/worker 工作流），纯文件系统邮箱，无服务器。

## 架构

```
plugins/session-messaging/
├── index.ts          # 装配：命令注册 + 工具注册 + 事件接线
└── src/
    ├── mailbox.ts    # 数据层：sessions/ 注册表、心跳 mtime、判活、inboxes/ 收件箱
    ├── protocol.ts   # 消息类型 chat/task/result + taskId + 注入 prompt 模板
    └── peek.ts       # 只读监控：解析 session jsonl 尾部 + 压缩 + 卡死检测
```

数据目录 `~/.pi/agent/mailbox/`：`sessions/<id>.json`（含 name/state/busyTaskId/cwd/sessionFile）、`inboxes/<id>/*.json`。仅限同一台机器。

## 命令（人类）

| 命令 | 作用 |
|---|---|
| `/msg-name <name>` | 给当前会话起名（编排时 worker 用名字互找，保持唯一） |
| `/msg-sessions` | 列出在线会话（名字、忙/闲、cwd） |

## 工具（agent）

| 工具 | 参数 | 作用 |
|---|---|---|
| `send_session_message` | to, text | 闲聊/自由通信 |
| `list_sessions` | — | 在线会话 + 忙闲状态 |
| `dispatch_task` | to, task | 派发带 taskId 的任务；worker 端 prompt 强约束完成后回报 |
| `report_task_result` | to, taskId, result | worker 回报结果（自动把状态翻回 idle） |
| `peek_session` | to, lines? | 只读查看对方最近对话（默认 20 条，工具输出压缩到 200 字符，5 分钟未更新提示卡死） |

## 工作流（内核审计示例）

1. 各 worker 会话 `/msg-name` 起名：`syscall-audit`、`driver-audit`…
2. boss 会话起名 `boss`，你对它说「扫一遍 net/ 子系统」
3. boss：`list_sessions` → 给空闲 worker `dispatch_task`
4. boss 随时 `peek_session` 看进度（不打扰 worker）
5. worker 完成后 `report_task_result`（带 taskId）→ boss 汇总
6. worker 卡住：peek 的卡死提示 + boss 发消息纠偏或你人工切窗口干预

## 安装

```bash
# 目录形式（pi 支持目录扩展，入口 index.ts）
cp -r . ~/.pi/agent/extensions/session-messaging
```

> 单文件时代的历史：原 `session-messaging.ts` 来自 ai（root@ai -J pve）。
