# 主题

自研 pi 主题，放 `~/.pi/agent/themes/` 即可加载（热重载）。

| 主题 | 说明 |
|---|---|
| [dark-tint](dark-tint.json) | pi 原版 dark 的完整拷贝，仅调整三个工具框底色为低饱和中性色：pending `#222226`、成功 `#212922`（极淡绿）、失败 `#3C170F`（极淡红，Codex 同款）。降低原版蓝绿色块的突兀感，保留成败的视觉信号。 |

## 安装

```bash
cp dark-tint.json ~/.pi/agent/themes/
# /settings 里选 "dark-tint"，或设置 settings.json 的 "theme": "dark-tint"
```

当前部署：本机、cpudev、ai 三台统一使用。
