# 主题

自研 pi 主题，放 `~/.pi/agent/themes/` 即可加载。

| 主题 | 说明 |
|---|---|
| [codex](codex.json) | 仿 Codex CLI 官方风格指南：主文本用终端默认前景色，cyan 提示/选中、green 成功/新增、red 错误/删除、magenta 品牌色。全部使用 ANSI 8-15 色号，跟随终端调色板自动适配；工具框/消息框背景全透明，融入终端本色。 |

## 安装

```bash
cp codex.json ~/.pi/agent/themes/
# 然后在 /settings 里选 "codex"，或设置 settings.json 的 "theme": "codex"
```

编辑已激活的主题文件会即时热重载，方便微调。
