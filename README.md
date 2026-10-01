# pi-plugins

我平时使用的 pi agent 插件收藏 + 自研插件仓库。

新装机器时，让 pi agent 读这个仓库，即可了解有哪些插件可选装。

## 目录结构

- `plugins/` — 我自己写的插件（源码）
- `themes/` — 自研主题 
- `catalog/` — 好用的第三方插件目录（按用途分类，含安装方式和简评）

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

## pi 本体设置（settings.json）

除插件外，`~/.pi/agent/settings.json` 还有两处刻意的选择（2026-10-02 定）：

```json
{
  "tuiMode": "fullscreen",
  "fullscreenWheelScrollLines": 10
}
```

- `tuiMode`: `"regular"` → **`"fullscreen"`**。全屏 TUI，滚轮/回滚走 pi 自己的 transcript 视口，而不是把内容推进终端 scrollback。重启 pi 生效。
- `fullscreenWheelScrollLines`: 新增，`"auto"` → **`10`**（合法范围 1–100）。默认 `"auto"` 在 SSH/非 macOS 终端下最多 6 行/格，滚起来偏慢；固定 10 行更跟手。Alt+滚轮是这个值的 5 倍（即 50 行/格）。

其余设置保持 pi 默认（`fullscreenScrollbar: "auto"`、`hideThinkingBlock: false`）。

部署状态（用 md5sum/远端读回核实）：

| 机器 | 状态 |
|---|---|
| 本机 `~/.pi/agent/settings.json` | ✅ 2026-10-02 落地（pi 1.0.0） |
| ai `/root/.pi/agent/settings.json` | ✅ 同一日同步；备份 `settings.json.bak-before-tui-fullscreen`（pi 1.0.0） |
| cpudev `/home/wsz/.pi/agent/settings.json` | 待同步 |

## 约定

- 自研插件每个一个子目录，含源码和 README。
- 第三方插件只记录元信息（npm 包名、版本、用途、简评），不放源码。
- 非插件类的 pi 本体偏好（settings.json 字段等）记在 README / docs，与插件区分。
