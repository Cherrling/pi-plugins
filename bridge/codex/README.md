# codex 接入包

把 mailbox 接线进 Codex CLI：hooks（自动收消息）、AGENTS.md（使用指引）、
sandbox writable_roots（水位线可写）。**合并安装，绝不覆盖用户已有配置。**

## 安装

```bash
node bridge/codex/install.mjs            # 默认装到 ~/.codex + ~/.pi/agent/mailbox-bridge
node bridge/codex/install.mjs --no-bin   # 不装 ~/.local/bin/mailbox shim
```

安装内容：

| 目标 | 动作 |
|---|---|
| `~/.codex/hooks.json` | 追加 SessionStart/PostToolUse/Stop 三条 hook（已有用户 hooks 保留；重复安装去重） |
| `~/.codex/AGENTS.md` | 追加 `<!-- >>> mailbox >>> -->` 标记块（幂等替换，用户指令不动） |
| `~/.codex/config.toml` | 把 mailbox 目录加进 `[sandbox_workspace_write].writable_roots`（已存在则原位扩展；**绝不重复声明表**） |
| `~/.pi/agent/mailbox-bridge/` | CLI + shared 自包含拷贝（hooks 引用其绝对路径） |
| `~/.local/bin/mailbox` | 便捷 shim（被占用则跳过） |

每个被改文件先备份为 `<file>.mailboxbak-<时间戳>`。

## 会话命名

hooks 的身份来自 codex 进程环境（**不经 shell 展开**，hooks.json 里没有 `$VAR`）：

```bash
CODEX_SESSION_NAME=kernel-worker codex   # 别名 kernel-worker
codex                                    # 默认别名 "codex"
```

多 codex 会话并跑必须起不同名字；别名冲突时 register 报错（fail-open，不阻塞 codex）。

## 卸载 / 回滚

```bash
node bridge/codex/uninstall.mjs    # 精确移除我们的 hooks/标记块/writable_root/shim/bridge
cp <file>.mailboxbak-<ts> <file>   # 或整体恢复备份
```

mailbox 数据目录（`~/.pi/agent/mailbox`）永不删除。

## 注意

- hooks 由 codex 直接 exec（**不是 shell**），所以 hook 命令里不能有 `VAR=x cmd` 前缀；
  环境靠进程继承（MAILBOX_DIR 默认值即真实路径，一般无需设置）
- SessionStart 在**第一个 turn** 才触发（0.153 实测），启动后先说句话完成注册
- codex 会话的注册 pid 是短命 hook 进程，`list` 里的在线状态仅供参考，
  判活看 lastSeen
- 已知边界（方案 v6.2 §2.1）：空闲 codex 收不到消息，下个事件补投
