# cc-status

Claude Code 风格状态栏（精简版）：

- cwd（`~` 缩写）+ git 分支（含 dirty 标记）
- thinking level + 模型名

与 [status-bar](../status-bar/) 相比功能更简单：没有 token 统计、上下文用量条和费用显示。

## 安装

```bash
cp cc-status.ts ~/.pi/agent/extensions/
```

来源：ai（root@ai -J pve）`~/.pi/agent/extensions/cc-status.ts`
