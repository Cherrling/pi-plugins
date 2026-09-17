# status-bar

Codex / Claude Code 风格状态栏，替换 pi 内置 footer：

```
~/project (main) · my-session
↑1.2k ↓30k R89% $0.42 ██░░░░░░░░ 27%/900k    🧠 high · glm-5.3 (tai)
```

- cwd（黄色）+ git 分支 + 会话名
- token 统计、上下文用量条（>70% 警告，>90% 报错）
- 🧠 thinking level 跟随主题色，shift+tab 循环 / `/model` 切换实时更新
- 保留其他扩展通过 `ctx.ui.setStatus()` 设置的文本
- `/statusbar` 开关

## 安装

```bash
cp status-bar.ts ~/.pi/agent/extensions/
```

来源：cpudev（cn096）`~/.pi/agent/extensions/status-bar.ts`
