# Mailbox M2 报告：codex 接入包

日期：2026-09-20。基线：v6.2 方案 + M1 已部署（pi 侧）。Codex CLI 0.153.3。

**结论：M2 验收通过。** 安装器（合并式）、hooks、AGENTS.md 片段、writable_roots
接线全部实现；隔离环境下 pi↔codex 双向消息、dispatch/report 闭环、双 codex
身份隔离、空闲滞留+补投九项端到端全过（两连跑稳定）。实际接线待用户确认后执行。

## 1. 交付物

```
bridge/codex/install.mjs      合并式安装器（备份 + 幂等 + 不覆盖用户配置）
bridge/codex/uninstall.mjs    精确卸载（只删我们加的，数据目录永不动）
bridge/codex/README.md        安装/命名/卸载/注意事项
bridge/mailbox-cli.mjs        别名回退链：--as > MAILBOX_ALIAS > CODEX_SESSION_NAME > codex
scripts/mailbox-migrate.mjs   幂等化（迁移即删源文件，finalize 重跑不重复）
```

## 2. 安装器合并安全（test-m2-install.mjs，5 用例全过）

| 初始状态 | 行为 |
|---|---|
| 全新 | 创建 hooks.json（三事件）、AGENTS.md 标记块、sandbox 表 |
| 已有用户 hooks | 追加不覆盖、不重排；无关事件不动；备份生成 |
| 已有 AGENTS.md | 标记块追加；重复安装幂等（不重复） |
| 已有 writable_roots / 表无键 / 表不存在 | 原位扩展 / 表内插入 / 追加表——**三种形态均不产生重复表**，python tomllib 验证合法性 |
| 卸载 | 用户 hooks/指令/roots 完整保留；bridge 删除；**mailbox 数据目录永不被删** |

## 3. 端到端（probe-m2.mjs，真实 codex ×2 + 真实 pi ×1，同一隔离 mailbox）

安装器真实落地 → mock 模型（动态提取 taskId 生成 report/send 工具调用）→
双 codex app-server（bob/carol，各自 CODEX_SESSION_NAME）→ 真实 pi（alice，仓库扩展）。

| 场景 | 断言 | 结果 |
|---|---|---|
| 安装 | 隔离 CODEX_HOME 合并成功 | PASS ×2 连跑 |
| 双 codex 注册 | bob/carol 各自注册（kind=external） | PASS |
| S1 pi→codex chat | alice 发 "hello from alice"，bob 的模型请求中可见 | PASS |
| S2 dispatch→report 闭环 | alice 派任务(7*6) → bob Stop/PostToolUse 注入 → mock 提取 taskId → codex shell 执行 `mailbox report` → log-bob 出现 result 记录（taskId 配对） | PASS |
| S2b | alice（followUp 排队中）醒来后输出含 **42** | PASS |
| S3 codex→pi | carol 经 shell 工具 `mailbox send`，alice 输出含 "hi from carol" | PASS |
| S4 身份隔离 | "only for bob" 只有 bob 的模型看到；carol 的 seen 不变 | PASS |
| S5 空闲滞留+补投 | 空闲 4.5s 无投递（无唤醒）；下一 turn 注入送达 | PASS |

S2/S3 同时经由真实安装的 `writable_roots` 完成 shell 工具内的 CLI 写入
（水位线持久化，无重复投递）——⑤ 在安装路径上复验。

## 4. 过程发现（均已修）

1. **hooks 不经 shell 执行**：`MAILBOX_DIR=x node …` 前缀导致 exec 失败。
   修正：hook 命令纯 node 调用；身份/路径靠进程 env 继承 + CLI 别名回退链
   （`--as > MAILBOX_ALIAS > CODEX_SESSION_NAME > codex`）。
2. **bridge 安装布局破坏相对导入**：`mailbox-cli.mjs` 的 `../shared/...`
   在扁平安装目录解析到外面。修正：安装为 `bin/ + shared/` 镜像仓库结构。
3. **TOML 顶层键作用域**（测试脚本自身）：`model`/`model_provider` 追加在
   `[sandbox_workspace_write]` 表后会被吞进表内——注入必须前置。安装器本身
   只追加表/改既有键，无此问题；已把该坑记入测试注释。
4. mock 行为修正：send 触发改为按 turn 提示词而非历史启发式。

## 5. 升级收尾流程（按用户要求补齐）

M1 部署后旧 inbox 若在升级窗口内又收到消息（旧会话仍在跑）：

```bash
# 等所有旧会话退出后：
node scripts/mailbox-migrate.mjs --force   # 只迁窗口内新增，已迁文件已删，不重复
```

`finalize-idempotent` 用例验证：首批 2 条迁移 → 窗口内新增 2 条 → finalize
再跑 → 总计恰 4 条、无重复、inbox 清空。真实 mailbox 当前旧 inbox 为空
（M1 迁移时 0 条），若窗口内无新消息则 finalize 是无操作。

## 6. 待验项与边界

- **/msg-name 真实 TUI 验证**（延续 M1 待验项）：逻辑有核心级测试覆盖
  （rename-carries-watermark），但 TUI 命令路径未实点——用户重启会话后
  `/msg-name <名>` 顺手验证即可
- codex 注册 pid 为短命 hook 进程，`list` 在线状态仅供参考（lastSeen 判活）
- SessionStart 在第一个 turn 才触发；启动即注册的预期要对齐
- 真实接线（用户 ~/.codex）未执行——见 §7

## 7. 实际接线步骤（待用户确认后执行）

```bash
# 1. 确认所有旧 pi 会话已退出（旧插件不可与新协议混跑）
# 2. 安装
node bridge/codex/install.mjs
# 3. 验证
CODEX_SESSION_NAME=test codex   # 起会话说句话，然后问它 mailbox whoami / mailbox list
# 4. pi 侧已随 M1 部署完成
```

回滚：`node bridge/codex/uninstall.mjs` 或恢复 `*.mailboxbak-*` 备份。

## 8. 复现

```sh
node scripts/mailbox-m0/test-m2-install.mjs   # 安装器合并安全
node scripts/mailbox-m0/probe-m2.mjs          # 端到端（真实 codex×2 + 真实 pi）
node scripts/mailbox-m0/test-m1.mjs           # 含 finalize 幂等
node scripts/mailbox-m0/test-core.mjs         # M0 全量回归
```
