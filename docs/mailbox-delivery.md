# Mailbox 交付记录：pi × codex 跨 agent 通信

日期：2026-09-20。方案 v6.2（五轮评审收敛）；M0/M1/M2 验收见各报告。本文是最终交付清单。

## 1. 已部署组件与位置

| 组件 | 位置 | 版本/状态 |
|---|---|---|
| pi 扩展（新数据层） | `~/.pi/agent/extensions/session-messaging/` | M1 部署，仓库 commit 同步 |
| mailbox 数据目录 | `~/.pi/agent/mailbox/` | SAMP 日志格式；旧 inbox 已迁移（0 条存量） |
| codex bridge（CLI + shared） | `~/.pi/agent/mailbox-bridge/` | install.mjs 安装（bin/ + shared/ 镜像结构） |
| codex hooks | `~/.codex/hooks.json` | SessionStart(register --quiet)/PostToolUse/Stop 三条，**hooks 信任已授予** |
| codex 指令 | `~/.codex/AGENTS.md` | `<!-- >>> mailbox >>> -->` 标记块 |
| codex sandbox | `~/.codex/config.toml` | `[sandbox_workspace_write].writable_roots` 含 mailbox 目录；model 等其余配置未动 |
| PATH shim | `~/.local/bin/mailbox` | → bridge CLI |

## 2. 版本

- Codex CLI 0.153.3（hooks 语义按此版本验证）
- pi 扩展 = pi-plugins 仓库 M2 提交（session-messaging + shared/mailbox core v6.2）
- Node ≥18（bridge 零依赖）

## 3. 真实环境测试结果（无 mock）

| 项 | 结果 | 证据 |
|---|---|---|
| hook 信任授予（交互） | ✅ | tmux 真实会话 "Trust all and continue" |
| mailbox whoami（真实模型） | ✅ | `CODEX_SESSION_NAME=m2-final-whoami codex exec` → `{"alias":"m2-final-whoami"}` |
| **pi↔codex 派任务闭环（真实模型双方）** | ✅ | alice(dispatch 19*23) → worker sleep 60 中 PostToolUse 注入 → **gpt-6-astra 自主执行 `mailbox report ... '19*23 = 437'`**（AGENTS.md 指引遵循）→ alice 醒后输出「任务闭环完成」；日志 task/result taskId 严格配对（`log-01a0bbbf.jsonl` / `log-m2-final-worker.jsonl` 存档） |
| /msg-name TUI 改名 | ✅ | tmux 真实 pi：notify「本 session 已命名为 "m2-tui-test"」+ `sessions/m2-tui-test.json` + 旧名释放 |
| 改名后外部投递 | ✅ | CLI → m2-tui-test：`📨 新消息来自 checker` notify + 消息注入对话 |
| /msg-sessions 列表 | ✅ | `(本会话)` 标注正确 |
| 错误路径 | ✅ | 未知收件人 → 友好报错（模型尝试回复未注册的 checker 时触发） |
| 旧会话退出前补迁移 | ✅ | `mailbox-migrate.mjs --force`：0 条（窗口内无新增旧格式消息，旧 inbox 为空且唯一旧 pi 会话即工作会话未再使用旧工具） |

此前 mock 层验证（M0/M1/M2 报告）：⑥⑦⑧⑨ 写入规则、双 codex 身份隔离、空闲滞留+补投、安装器合并安全（5 用例）、迁移幂等——均两连跑以上通过。

## 4. 过程中修的最后一个 bug

SessionStart 的 `register` 向 stdout 打印注册 JSON，被 codex 判为 "invalid session
start JSON output"（fail-open 不影响功能）。修复：`register --quiet`（信息走
stderr），hooks.json 与 install.mjs 已同步更新。

## 5. 回滚路径

```bash
# codex 侧（三选一）
node ~/code/pi-plugins/bridge/codex/uninstall.mjs        # 精确移除（推荐）
cp ~/.codex/config.toml.mailboxbak-1789856023412 ~/.codex/config.toml
rm ~/.codex/hooks.json ~/.codex/AGENTS.md                # 两者为本安装新建，无用户内容

# pi 扩展
rm -rf ~/.pi/agent/extensions/session-messaging
mv ~/.pi/agent/session-messaging.bak-20260920-052855 ~/.pi/agent/extensions/session-messaging
# （旧版与 SAMP 日志数据不兼容；mailbox 数据目录可整体保留或删除）

# mailbox 数据备份（迁移时生成）
~/.pi/agent/mailbox.bak-1789853353270  ~/.pi/agent/mailbox.bak-1789856009537
```

## 6. 使用速查

```bash
CODEX_SESSION_NAME=<唯一别名> codex   # codex 会话（首次说句话完成注册）
# pi 会话：/msg-name <名>；或 PI_SESSION_NAME=<名> pi
mailbox list                          # 在线会话（shim；或完整路径 ~/.pi/agent/mailbox-bridge/bin/mailbox-cli.mjs）
```

- 派任务：pi 侧 `dispatch_task` 工具 / codex 侧 `mailbox dispatch <别名> <任务>`
- 已知边界：空闲 codex 不被唤醒（下个事件补投）；codex 在线状态看 lastSeen

## 7. 遗留与后续

- **旧会话**：本交付会话（pi 33405）与两个 codex（24868/30685）仍在运行旧代码/无 hooks；
  它们退出后新会话自动全量切换。升级窗口内它们不产生 mailbox 消息
- M3（mailbox-mcp、TIOCSTI 空闲唤醒、SAMP 互通）**暂不扩展**（按用户指示）
- 测试残留日志（log-01a0bbbf / log-m2-final-worker / log-checker 各 1 条）保留作交付证据，
  不影响任何会话（list 只读 sessions/）
