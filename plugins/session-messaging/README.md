# session-messaging

让多个 pi 会话之间互相发消息。

- 会话自动注册到 `~/.pi/agent/mailbox/`，带心跳（5s 心跳，20s 判定离线）
- `/msg <name|id-prefix> <text>` — 给另一个会话发消息
- `/msg-name <name>` — 给当前会话起名
- `/msg-sessions` — 列出在线会话
- 工具 `send_session_message` — agent 自己也能回复/主动发消息

收到的消息作为 user message 注入对话。

## 安装

```bash
cp session-messaging.ts ~/.pi/agent/extensions/
```

来源：ai（root@ai -J pve）`~/.pi/agent/extensions/session-messaging.ts`
