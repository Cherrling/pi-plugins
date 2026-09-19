# 交互式会话命名（mailbox rename）设计与实现

> 状态：已实现并验证，待 review
> 需求来源：用户不希望用环境变量命名 codex 会话，要求交互式改名。
> 本文供 codex review：§2 机制、§4 边界与已知取舍是重点审查对象。

## 0. TL;DR

codex 会话现在可以随时 `mailbox rename <新别名>`：立即生效、未读消息跟随、
hooks 投递/whoami/list 全部切到新名。环境变量 `CODEX_SESSION_NAME` 降级为
**可选的启动时预命名**，不再是会话中途改名的唯一途径（env 在进程启动后不可变）。

pi 侧早有 `/msg-name`，本文全部针对 codex 侧。

## 1. 问题

v6.2 的身份模型是"别名即身份"。codex 侧的身份来源是 hooks 的 env 继承
（`CODEX_SESSION_NAME`），这有两个限制：

1. env 在 codex 启动时冻结，会话中途无法改名
2. 用户明确不希望依赖环境变量（体验问题）

难点：hooks（SessionStart/PostToolUse/Stop）与 agent 的 shell 工具运行在
**不同的进程上下文**，rename 由 shell 执行，而后续投递由 hooks 执行——
两者必须对"当前别名"达成一致，且 rename 之后 hooks 要立刻看到新值。

## 2. 机制：session-name map

```
mailbox/.names/<session_id>.json = { "alias": "beta-worker", "hostPid": 12345 }
```

**写入（SessionStart hook）**：hook 从 stdin 拿 `session_id`（M0 已实测存在），
从 env 链拿初始别名（`CODEX_SESSION_NAME` 或缺省 `codex`），沿 /proc 祖先链
找到 codex 宿主 pid，写映射。

**读取（check hooks）**：checkHook 解析 stdin 的 `session_id`，查映射得到
当前别名。优先级：**map > --as 参数 > MAILBOX_ALIAS > CODEX_SESSION_NAME >
session_id**。map 命中即用——这就是"改名立即生效"的机制：rename 只改映射，
下次任何 hook 触发自然读到新名。

**rename（agent shell 执行）**：身份解析优先级——
1. `CODEX_SESSION_ID` **环境变量**：实测 codex 0.153 会把它导出给工具
   shell 的子进程（这是本设计的关键依据，见 §3 发现 2）
2. 祖先进程链匹配映射（兜底，见 §3 发现 1 的教训）
3. `--as` 显式指定（测试/脚本用）

然后执行 `renameSession`：注册新名（**带 codex 宿主 pid**，比 hook 进程 pid
的活性展示更真实）→ `renameReader` 迁移水位线 + 记录别名历史（旧名在途
消息继续投递，append-only 不改写 `to` 字段的既有设计）→ 删除旧注册（仅当
旧注册 pid 死亡或等于本宿主）→ 更新映射。

**幂等与冲突**：新名被活进程占用 → register 抛错，rename 失败，旧身份
不动。重复 rename 到同名 → register 覆盖（pid 相同），renameReader 对
已迁移状态是 no-op-ish（aliases 集合去重）。

## 3. 过程发现（review 时值得知道的两个坑）

1. **祖先链在 sandbox 内断裂**：最初设计 rename 从工具 shell 沿 /proc
   祖先链上溯找 codex 宿主。实测（隔离 CODEX_HOME + mock 模型 + 真实
   app-server）exec_command 的 shell 进程链**到不了 codex 宿主**（被
   sandbox 重定向父进程），映射查找失败。祖先链保留为兜底，主路径改用
   下一条。
2. **`CODEX_SESSION_ID` env**：调试时发现 codex 导出给工具 shell 的环境
   包含 `CODEX_SESSION_ID` / `CODEX_THREAD_ID`（值 = hook stdin 里的
   session_id）。这是 shell 侧定位映射的可靠通道——env 继承不受 sandbox
   进程隔离影响。**注意**：这是 0.153 的实测行为，非官方文档承诺；如果
   上游改名，兜底链（祖先 walk → env 别名链 → 报错）仍可用，rename 会
   退化为需要 `--as`。

## 4. 边界与已知取舍（review 重点）

| 边界 | 行为 | 取舍理由 |
|---|---|---|
| map 文件永久留存 | 会话退出后 `.names/<session_id>.json` 不清理 | 无自动清理是 v6.2 既定原则；死 session_id 不会被再次查询，文件只增不减（每会话一个，量级可忽略）。`mailbox gc` 留作需要时再加 |
| hostPid 复用 | 映射里的 hostPid 仅用于：rename 的祖先兜底匹配 + 新注册的活性展示。pid 复用导致错误匹配的最坏结果：rename 兜底路径找错会话（有 `CODEX_SESSION_ID` 主路径在，实际难触发） | 不引入 boot-time 校验（v4 锚点教训：复杂度不值） |
| `/new` 后身份 | 新 session_id → SessionStart 写新映射；祖先兜底可能复用旧映射的别名（同一宿主） | 视为特性：`/new` 保持名字连续。若 review 认为应重置，改一行（不复用旧 map） |
| map 与 env 冲突 | 启动时 `CODEX_SESSION_NAME=x`，会话内 rename 到 y → 之后 map（y）赢 | rename 是更晚的用户意图 |
| pi 会话 | 不写 map（pi 用 `/msg-name`，扩展直接管理别名） | 两套机制独立，互不干扰 |
| 并发 rename | 同会话两个 shell 并发 rename → 后写者赢（register 覆盖），水位线经 renameReader 各自迁移，最坏丢一次已读标记（重复投递，无害） | 未加锁；量级为人工操作，竞态窗口极小。若 review 认为必要，可复用 state 锁 |

## 5. 实现

```
shared/mailbox/core.mjs    +ancestorPids/findCodexHostPid（导出）
                           +Mailbox.renameSession / readNameMap / writeNameMap /
                            findNameMapByAncestors / namesPath
                           checkHook reader 解析加 map 优先
bridge/mailbox-cli.mjs     register：stdin session_id + map + 宿主 pid 注册
                           rename <new>：CODEX_SESSION_ID → map → 祖先兜底 → --as
                           whoami：同上解析
bridge/codex/install.mjs   AGENTS.md 片段加 rename 指引；README 更新命名章节
```

hooks.json 的命令**未变**（register/check 原样）——身份解析全部在 CLI 内部
完成，已安装环境重跑 install 即可升级。

## 6. 验证

| 层 | 用例 | 结果 |
|---|---|---|
| 核心级 test-rename.mjs | map 读写/祖先匹配；checkHook 经 map 解析投递；renameSession 未读跟随 + map 更新 + 注册互换 + 宿主 pid；CLI register（stdin pipe）写 map 且 map 优先于 env；CLI rename --as 未读跟随 | 5/5 PASS |
| 端到端 probe-rename.mjs（真实 codex app-server + mock 模型，无 CODEX_SESSION_NAME） | 初始注册 "codex" + map；改名 turn 中模型执行 `mailbox rename beta-worker`；**旧名未读消息经 alias history 送达**；map/注册互换（新注册带活宿主 pid）；新名直接投递；whoami 返回新名 | 9/9 PASS |
| 真实模型 | `codex exec`：`mailbox rename rn-real-renamed` → `mailbox whoami` → `{"alias":"rn-real-renamed"}` | PASS |
| 回归 | test-core / test-m1 / test-m2-install / test-rename 全绿 | PASS |

复现：
```sh
node scripts/mailbox-m0/test-rename.mjs
node scripts/mailbox-m0/probe-rename.mjs
```

## 7. 部署状态

已重跑 `install.mjs`（bridge 刷新 + AGENTS.md 片段更新，hooks 命令不变），
真实 `~/.codex` 即时生效。

## 8. Review 关注点建议

1. `CODEX_SESSION_ID` env 依赖的版本耦合风险（§3.2）——兜底链是否足够？
2. map 不清理的长期影响（§4 第 1 行）
3. `/new` 身份连续是特性还是 bug（§4 第 3 行）
4. 并发 rename 不加锁的取舍（§4 最后一行）
5. renameSession 删除旧注册的条件（pid 死亡或等于宿主）是否有漏网场景
