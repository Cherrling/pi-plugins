# session-messaging

让多个 pi 会话之间互相发消息（agent 间协作）。

- 会话自动注册到 `~/.pi/agent/mailbox/`，带心跳（5s 心跳 mtime touch，20s 判定离线）
- `/msg-name <name>` — 给当前会话起名（agent 间通信用名字互相找，保持唯一）
- `/msg-sessions` — 列出在线会话
- 工具 `send_session_message` — agent 发消息/回信（收件人用名字或 id 前缀）
- 工具 `list_sessions` — 列出其他在线会话（名字、id、工作目录）

收到的消息作为 user message 注入对话（agent 忙时排队为 followUp）。

> 没有 `/msg` 人类发消息命令——想对另一个会话说话直接切窗口，
> agent 间通信才是这个插件的用途。

架构：纯文件系统邮箱（无服务器），`sessions/` 注册表 + `inboxes/<id>/` 收件箱，
写入即送达，读前先 unlink 防重复投递。仅限同一台机器。

## 安装

```bash
cp session-messaging.ts ~/.pi/agent/extensions/
```

来源：ai（root@ai -J pve）`~/.pi/agent/extensions/session-messaging.ts`
