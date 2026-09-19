# mailbox 跨 agent 通信方案（pi × codex）

> 状态：设计稿 **v6.2**（简化重构版；五轮评审收敛：v6.1 修投递承诺/积压/并发/附件，v6.2 修 replay 缓存失效/状态锁/短写）。
> v1–v5 经过三轮 codex 评审 + 一轮 M0 验证，收敛出一套可靠但偏重的模型；
> v6 借鉴 agent-message（SAMP 协议）的存储设计，把复杂度砍掉一半，
> 可靠性承诺反而更强。历史修订记录见附 1–4，附 5 是 v6 决策依据。
> 目标：让 codex 会话与 pi 会话互相通信、互相派任务。

> M0 本地验证（2026-09-20）：⑥⑦⑧ 的策略原型通过；⑨ 复现补写交错及
> 残尾污染下一条消息，短写约束仍待修正。候选发送者锁/尾行隔离已在原型验证；
> 这不是生产 core 或真实 hooks 的验收。见 [v6.2 M0 报告](mailbox-m0-v62-report.md)。

---

## 0. 一句话总结

**发送侧一份实现（追加 JSONL 日志），接收侧各 agent 本地注入
（pi 扩展轮询 / codex hooks），消息永不删除。**
task 闭环、忙闲提示、按接收端能力渲染回复指引，全部保留。

## 1. 设计原则（v6）

用户需求是"agent 之间可以互相通信"，不是构建一个分布式消息中间件。
v6 的取舍基准：

- **简单压倒完备**：每加一个机制都要问"agent-message 没有它不也活得很好？"
- **消息永不删除**：append-only 让"丢失"在存储层不可能发生
- **重复无害**：内容寻址 id + 接收端去重；重投是兜底手段，不是被替代的确认机制
  【v6.2 修正原表述"替代一切投递确认机制"——重放与去重覆盖不了宿主侧窗口，
  投递承诺仍是尽力注入，见 §4】
- **不自动猜测身份**：别名冲突报错，绝不静默挑选

## 2. 存储（对齐 SAMP v1 格式）

```
~/.pi/agent/mailbox/
  log-<from>.jsonl      # 每个发送者一个 append-only 日志，永不修改
  .state/<reader>.seen  # 读者水位线 {"ts": <int>, "ids": ["<from>:<id>", ...]}
```

消息 = 一行 JSON（SAMP 兼容）：

```json
{"id":"a1b2c3d4e5f60718","ts":1730000000,"from":"boss","to":"kernel-worker",
 "type":"task","taskId":"t-xxx","body":"审计 net/ 子系统"}
```

- `id`：SAMP 规范算法 `sha256(canonical_json)[:16]`（跨机/跨实现一致）
- `type`/`taskId`：SAMP 允许的扩展字段，SAMP 实现会忽略未知字段
  → **我们的目录天然是合法 SAMP 存储，未来互通零成本**
- body 上限 4k 字符：超长内容先存 **mailbox 内持久附件目录**
  `files/<id>.txt`（v6.1 修正：不用临时目录——临时文件被系统清理后，
  日志只剩失效路径，破坏"原文永久保留"），保存成功后才追加引用消息
  （"传引用不传内容"，替代 v5 的 overflow 机制）

**并发策略（v6.1 补齐：一个别名 ≠ 一个写进程）**：

- **日志追加**：每条消息一次 `write()` + `O_APPEND`，**并检查实际写入
  长度**（v6.2 补齐：O_APPEND 只保证定位+写入的原子性，write(2) 仍可能
  短写，部分字节落盘后下一条追加会接在残缺 JSON 后面）。单行 ≤4k，
  常规文件短写罕见但必须处理：write 循环补写；仍失败则丢弃并报错，
  绝不在残行后继续追加。残缺尾行的恢复：读取方跳过无法解析的尾行
  （SAMP 规范行为，中间坏行不中断扫描），下次正常追加自行隔离
  【M0 新增故障注入项】
- **水位线 `.seen` / backlog / mtime 缓存：每读者锁 + 一致提交**
  （v6.2 修正：原子 rename 只避免读到半个文件，不解决丢更新——
  hook 读旧 .seen → replay 清除某 id → hook 用旧快照覆盖回来，
  重放请求就消失了，这不是"无害重复"而是丢失重放意图）。
  串行化同一读者进程组对 inbox/check/replay 的状态操作（flock 同一
  锁文件）；seen、backlog、mtime 缓存作为一个状态包，锁内读-改-写后
  一次性原子提交。跨读者不串行，最坏仍只是重复投递

## 3. 发送

`send / dispatch / report` 三个动作 = 构造消息 + 追加到自己日志的一行。
无收件箱、无投递路由——读方自己过滤 `to == me`。

## 4. 接收（三层，全部只是"扫描 + 水位线"）

共同的读逻辑（mailbox-core 一份实现）：

```
积压标记：.state/<reader>.backlog = true（上次投递被截断/达上限时置位）

mtime 短路：stat 所有 log-*.jsonl，三元组 (max_mtime, 文件数, 总大小)
            与缓存一致 且 无积压标记 → 返回"无新消息"
            【v6.1 修正：有积压时必须绕过短路——否则一次只投 2 条、
             日志无新写入时剩余消息被饿死】
否则扫描：  to == me 且 id 不在 .seen 水位线的消息
投递后：   仍有未投 → 置 backlog；投完 → 清除，恢复正常短路
```

| 接收端 | 通道 | 行为 |
|---|---|---|
| **pi** | 扩展（现状保留） | 3s 轮询 + `followUp` 注入 + 更新水位线；忙时排队不打断 |
| **codex（活跃）** | PostToolUse hook | 同上，注入 `additionalContext`，每 turn ≤2 次 |
| **codex（收工）** | Stop hook | drain 后有消息 → `{"decision":"block","reason":<渲染>}` 注入；每 turn 最多 block 2 次（含首次，按 turn_id 隔离计数），超限放行——**消息留在日志里，下个事件继续**，无丢失 |
| **codex（兜底）** | AGENTS.md 约定 | "空闲/任务节点后运行 `mailbox inbox`" |

- 渲染注入文本 ≤2 条 / ~1500 字符，超出部分注明"另有 N 条"
- **可靠性承诺（v6.1 修正措辞）：尽力注入 + 原文永久保留 + 可重放**。
  日志永不删只保证存储层不丢；"注入成功 ≠ 对端消费"的宿主侧窗口
  依然存在（注入后水位线已推进 → 宿主退出未消费 → 下次扫描跳过）。
  缓解：`mailbox replay [--all|<id>]`——**必须同时置 backlog 标记**
  （v6.2 修正：只清水位线不够，日志 mtime/大小未变，若 backlog 已清，
  下次检查仍会短路返回"无新消息"，重放永远不生效）；下个事件重投；
  AGENTS.md 约定按 id 去重（重投无害）。
  【撤销 v6 的"天然 at-least-once"表述——日志保留不能替代接收确认】

### 4.1 codex 接入包

- `hooks.json`：SessionStart（注册）/ PostToolUse / Stop（见上）
- AGENTS.md 片段：inbox 命令、task 回报格式、去重约定
- **writable_roots**：把 mailbox 目录加进 `~/.codex/config.toml` 的
  `[sandbox_workspace_write]`，否则已读水位线写不进去、消息反复弹出
  （agent-message 踩过的坑，接线方案直接搬）

## 5. 身份与生命周期（v6 大幅简化）

- **别名即身份**：pi = `/msg-name` 或 session id 前缀；codex =
  `CODEX_SESSION_NAME` 或注册时指定。**别名必须唯一，冲突报错**，绝不猜
- 多 codex 会话：起不同名字即可；CLI 用 `--as <别名>` 或环境变量声明身份，
  解析失败报错退出，绝不落错邮箱
- 注册文件（`sessions/<别名>.json`）只记 name/kind/pid/cwd/lastSeen，
  用于 `list_sessions` 展示与**尽力判活**（pid 死 → 标记 offline；
  但不做任何自动清理——消息在日志里，与注册无关）
- 已结束会话的消息无人收：接受。发送方靠 lastSeen 自行判断，
  dispatch 前可 peek
- ~~anchors / bootTime / boot id / 锚点覆盖~~：整个删除
  （M0 实测证明同宿主多会话常见，但 v6 模型下"多注册"无害，无需裁决）

## 6. task 闭环（保留，从协议层薄化）

```
boss: dispatch  → {type:"task", taskId:"t-xxx", to:worker}
worker 收到注入：渲染文本按接收端能力给出回报指引
  pi 接收端 → report_task_result(to, taskId, result)（原生工具）
  codex（有 MCP）→ report_task_result（MCP 工具）
  codex（无 MCP）→ mailbox report <to> <taskId> <result>
worker: report → {type:"result", taskId, to:boss}
接收端按 taskId 关联；忙闲状态 = 注册文件可选字段，仅用于展示
```

task 模板 bug（v2 发现的原版指引 send_session_message）在此一并修正。
回复指引用完整 `from` 别名（唯一），不用显示名。

## 7. 里程碑（v6：M0 缩水）

| 阶段 | 内容 | 门槛 |
|---|---|---|
| M0 | ① Stop/PostToolUse stdin 字段实测；② 空闲滞留确认；③ 真实连续 Stop block 行为；④ `mailbox check` 完整基准（v6.1：撤销 <5ms 预估——已实测空路径中位数 22.53ms，mtime 短路只减解析不减 Node 启动，基准目标改为"无回归 + 可接受"）；⑤ writable_roots 接线验证；⑥ **十条积压、无新增写入仍能读完**（短路饿死修复的验收）；⑦ **水位线提交前后故障注入**（注入后杀进程，验证 replay 恢复）；⑧ **replay 后短路确实失效**（全部读完 → replay → 无新增写入 → 重投发生）；⑨ **短写注入**（模拟 write 部分落盘，验证补写/丢弃策略与尾行隔离） | ①③④⑥⑦⑧⑨ 有结论 |
| M1 | mailbox-core（SAMP 日志 + 水位线，~200 行）；pi 扩展切换数据层 | pi↔pi 现有工作流无感；旧 inbox 数据一次性迁移或放弃 |
| M2 | mailbox-cli + codex hooks + AGENTS.md | pi dispatch → codex 收到并 report 闭环；双 codex 会话互不串名；并发 send 压测无交错 |
| M3（可选） | mailbox-mcp；TIOCSTI 空闲唤醒调研（AMQ 已验证可行，实验性）；SAMP 互通 | — |

旧 inbox（`inboxes/<id>/*.json`）迁移：写一次性脚本转成日志行；
量小的话也可以直接放弃（存量消息本来就是即时的）。

## 8. 风险与开放问题

- **接收确认缺失（v6.1 重申）**：注入后水位线推进、宿主退出未消费 → 消息
  被跳过但原文可 replay。这是日志架构下的固有窗口，承诺上限就是
  "尽力注入 + 可重放"，不虚标 at-least-once
- **codex 空闲收不到**：硬边界（hooks 全事件驱动）。缓解：lastSeen 提示 +
  M3 调研 TIOCSTI wake（AMQ 路线）
- **codex hooks 语义演进**：stdin 解析 fail-open，绝不卡死宿主
- **日志增长**：append-only 永不清理。body ≤4k + agent 间消息量小，
  预计年增长 MB 级；`mailbox compact`（归并旧日志到冷文件）留作需要时再加
- **pi 扩展切换数据层**：M1 唯一的行为变更点，需要回归现有工作流
- **SAMP 字段演进**：只依赖 v1 规范的 id/ts/from/to/body，
  扩展字段被忽略，演进风险低

---

## 附 7：v6.2 修订记录（第五轮评审）

| # | 评审意见 | 处置 |
|---|---|---|
| 1 | replay 只清水位线不失效缓存，下次仍短路，重放永不生效 | ✅ replay 必须同时置 backlog；M0 新增 ⑧（读完→replay→无新增→验证重投） |
| 2 | 原子 rename 不保证读改写一致性，replay 意图可能被旧快照覆盖丢失 | ✅ 每读者 flock 串行化状态操作；seen/backlog/缓存作为状态包一致提交；不再宣称"最坏只是重复" |
| 3 | write(2) 可能短写，残缺 JSON 后继续追加会污染日志 | ✅ write 循环补写 + 失败丢弃报错；读方跳过坏尾行（SAMP 行为）；M0 新增 ⑨ 故障注入 |
| 附 | 附 5 与 §1 残留"at-least-once / 替代一切确认机制"冲突表述 | ✅ 两处修正为尽力注入 + 可重放 |

## 附 6：v6.1 修订记录（第四轮评审）

| # | 评审意见 | 处置 |
|---|---|---|
| 1 | 日志保留不能替代接收确认，"天然 at-least-once"不成立 | ✅ 承诺改为"尽力注入 + 原文永久保留 + 可重放"；新增 `mailbox replay`；风险首位重申固有窗口 |
| 2 | mtime 短路会饿死剩余消息 | ✅ backlog 标记：有积压必绕过短路；M0 新增 ⑥（十条积压无新增写入读完） |
| 3 | 一个别名 ≠ 一个写进程，需明确并发策略 | ✅ §2 并发策略：O_APPEND 单 write 原子追加；.seen 临时文件+rename，最坏重复无害 |
| 4 | 临时文件破坏"原文永久保留" | ✅ 附件改存 mailbox 内 `files/<id>.txt`，先存附件后追加引用 |
| 附 | "完整 check <5ms"无依据 | ✅ 撤销预估值，基准目标改为"无回归+可接受"（空路径实测 22.53ms） |

## 附 5：v6 决策记录（借鉴 agent-message / SAMP）

| 借鉴点 | v5 对应物 | v6 处置 |
|---|---|---|
| 单写者 append-only 日志 + 水位线 | inbox + 删除式消费 + delivered.log + archive/retired + gc + 清理与归档分离（§4.4 整章） | **整体替换**。消息永不删 → 无丢失窗口、无底稿问题（投递承诺见 §4 v6.1 修正） |
| 内容寻址 id（sha256 canonical） | 消息可选 id 字段 | 采用 SAMP 精确算法，跨实现一致 |
| mtime 短路 | 无（轮询全量扫） | 采用，check 性能风险大降 |
| body 上限 + 传引用 | overflow 文件机制 | 简化为 4k 截断 + 落盘引用 |
| codex writable_roots 接线 | 未考虑 | M2 采纳 |
| SAMP 格式兼容 | 私有格式 | 存储布局对齐，type/taskId 为合法扩展字段 |
| 不借鉴：纯 pull 收消息 / 无任务语义 / 跨机 sync / thread 自动推导 | — | hooks 投递与 task 闭环是我们的差异化，保留 |

可靠性承诺对比：v5「尽力注入；未发送项保留；已发送项保留可恢复原文」
→ v6「尽力注入 + 原文永久保留 + 可重放」。机制更少；承诺如实
（v6.2 修正：不再是"at-least-once、保证更强"的表述，见 §4）。

## 附 4：v5 修订记录（第三轮评审）

| # | 评审意见 | v5 处置 | v6 去向 |
|---|---|---|---|
| 1 | 宿主活 ≠ 会话可接收 | 生命周期段（注销/恢复/lastSeen 兜底） | 简化：无自动清理，lastSeen 尽力展示 |
| 2 | MAILBOX_SESSION_ID 缺传递步骤 | 注入完整 id 命令前缀 + whoami | 简化：别名唯一 + `--as`，无环境变量链 |
| 3 | 旧插件 listSessions 扫全部会误删 | 升级顺序「停旧会话→换文件→重启」 | 保留（M1 仍适用，旧 inbox 迁移期） |
| 附 | "删除后 pending 区确认"无定义 | 删除 | 整个删除模型不复存在 |

## 附 3：v4 修订记录（M0 报告驱动）

| 发现 | v4 处置 | v6 去向 |
|---|---|---|
| 同宿主 PID 多会话，锚点覆盖误伤 | session_id 主键 + 锚点数组 | 锚点机制整体删除 |
| 清理 rm -rf 连坐底稿 | archive 物理分离 + 移动式清理 | 日志永不删，问题消失 |
| /proc field 22 是 tick 非系统时间 | 加 boot id | 随锚点删除 |
| 措辞残留（不漏/不丢失） | 统一四句承诺 | 升级为 at-least-once |
| block 计数语义 | 按 (session_id, turn_id) 隔离 | 保留 |
| 性能基线不等价 | 列入待办 | mtime 短路 + M0 ④ |

## 附 2：v3 修订记录（第二轮评审）

| # | 评审意见 | v3 处置 | v6 去向 |
|---|---|---|---|
| 1 | stdout 成功 ≠ 投递成功 | 降级尽力投递 + delivered.log | 日志不删，升级 at-least-once |
| 2 | 锚点单会话覆盖 + PID 复用 | bootTime 校验 | 随锚点删除 |
| 3 | resolveTarget 静默选一 | 歧义报错列候选 | 保留（§5） |
| 4 | Stop 上限与不漏矛盾 | 积压保留 + 延迟语义 | 天然满足（消息永不删） |

## 附 1：v2 修订记录（第一轮评审）

| # | 评审意见 | v2 处置 | v6 去向 |
|---|---|---|---|
| 1 | hooks 无法唤醒空闲 codex | 明确硬边界 | 保留；M3 调研 TIOCSTI |
| 2 | Stop 先 drain 后判断丢消息 | peek→决定→ack | 日志不删，问题消失 |
| 3 | 缺跨进程身份绑定 | 锚点方案 | 简化为别名唯一 |
| 4 | 回复工具按接收端能力；task 模板 bug | §3.1 表格修正 | 保留（§6） |
| 5 | 临时 PID 兜底被清理连坐 | 注册失败显式告警 | 随清理模型删除 |
| 6 | shared 发布方式影响 cp -r 安装 | sync 脚本 + 干净目录验收 | 保留（M1） |
