# pi-plugins

我平时使用的 pi agent 插件收藏 + 自研插件仓库。

新装机器时，让 pi agent 读这个仓库，即可了解有哪些插件可选装。

## 目录结构

- `plugins/` — 我自己写的插件（源码）
- `themes/` — 自研主题 
- `catalog/` — 好用的第三方插件目录（按用途分类，含安装方式和简评）
- `themes/` — 自研主题 

## 自研插件

| 插件 | 说明 |
|---|---|
| [status-bar](plugins/status-bar/) | 统一状态栏（status-bar + cc-status 合并）：cwd + git 分支（dirty 显示 ✗）、token/上下文用量条、费用、模型与 thinking level。`/statusbar` 切换。 |
| [session-messaging](plugins/session-messaging/) | 多个 pi 会话之间互相通信：mailbox + 心跳注册，`/msg` 发消息，agent 侧有 `send_session_message` 工具。 |

安装方式（以 status-bar 为例）：

```bash
cp plugins/status-bar/status-bar.ts ~/.pi/agent/extensions/
```

## 第三方插件目录

见 [catalog/README.md](catalog/README.md)。

## 约定

- 自研插件每个一个子目录，含源码和 README。
- 第三方插件只记录元信息（npm 包名、版本、用途、简评），不放源码。
