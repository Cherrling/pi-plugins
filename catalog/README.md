# 第三方插件目录

安装方式：加入 `~/.pi/agent/settings.json` 的 `packages` 数组，或 `pi extensions add npm:<包名>`。

## 子代理 / 工作流

| 包 | 用途 | 备注 |
|---|---|---|
| `pi-subagents` | 子代理编排、并行任务、工作流脚本 | 主力，几乎必装 |
| `@quintinshaw/pi-dynamic-workflows` | 动态工作流 | cpudev 在用 |
| `@tintinweb/pi-subagents` | tintinweb 版子代理 | 与 pi-subagents 功能有重叠 |

## 交互增强

| 包 | 用途 | 备注 |
|---|---|---|
| `@juicesharp/rpiv-ask-user-question` | 结构化用户提问 | cpudev 在用 |
| `@juicesharp/rpiv-todo` | 任务清单管理 | cpudev 在用 |
| `@pi-plugins/speed` | 速度/优先级 | |

## 远程控制 / 通信

| 包 | 用途 | 备注 |
|---|---|---|
| `@llblab/pi-telegram` | Telegram 桥接，远程和 pi 对话 | ai 机器在用，配置放 `~/.pi/agent/telegram.json`（botToken + allowedUserId） |

## 工具桥接 / 网页

| 包 | 用途 | 备注 |
|---|---|---|
| `pi-mcp-adapter` | 接入 MCP 工具 | 必装 |
| `pi-web-access` | 网页访问/搜索 | |

## 代码审查 / 目标管理

| 包 | 用途 | 备注 |
|---|---|---|
| `@plannotator/pi-extension` | Guided Review、代码标注 | |
| `pi-goal-x` | 目标管理 | |
| `pi-lens` | lens 扩展 | cpudev 装了但未在 settings.json 启用 |
| `pi-auto-review` | 自动 review（ai 机器，本地目录形式） | 待整理来源 |
