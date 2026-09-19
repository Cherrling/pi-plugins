# Mailbox M0 验证报告

日期：2026-09-20。基线：设计稿 v3；Codex CLI **0.153.3**；Linux x64；Node **v22.23.2**。

**结论：M0 尚未通过，暂不推进依赖当前身份模型的 M2/M3。** 已完成一轮隔离验证，发现两个阻塞问题：PID 不是会话唯一键；当前清理路径会删除 v3 承诺保留的底稿。八项验收并未全部完成。

## 1. 真实宿主：一个 PID 下有两个已加载会话

测试在独立临时配置目录启动真实 `codex app-server`，依次调用 `thread/start`，分别传 `sessionStartSource: startup` 和 `clear`。两个会话均启动首个 turn，让真实 SessionStart hook 记录 stdin 和祖先进程。

- 两个 hook 的 `session_id` 不同，但祖先里有同一个 app-server PID 和相同的进程启动 tick。
- 第二个会话创建后，`thread/loaded/list` 仍返回两个 ID，旧会话仍可 `thread/read`。
- 因此，`anchors/<pid>.json` 覆盖不是可靠的会话切换判据；按 v3 注销旧 ID 会让仍加载的会话失去邮箱身份。
- 本次测试在首次 turn 前等待 1 秒未观察到 SessionStart，启动 turn 后才取得两个 hook 输入。不能把“thread 创建成功”当成“邮箱已注册”。

这是 **真实 app-server 协议路径**，不是 TUI `/new` 按键测试；也未验证所有 CLI 启动模式。它足以反驳“任何 Codex 宿主都一进程一活跃会话”的前提，但不能替代 TUI 专项验收。

需要调整：注册以 `session_id` 为主键；PID 加进程启动 tick 只承担活性校验。同 PID 出现不同 ID 时，应保留两个注册或明确拒绝不支持的接入模式，不能自动注销旧者。CLI/MCP 的当前会话身份需要每会话显式绑定；若一个 MCP 进程服务多个会话，还需请求级身份，单个进程环境变量也不够。

hook 祖先遍历在本次 Linux 测试中能找到宿主，但这并不证明模型工具 shell 的 PID namespace、远程环境或不同宿主模式下同样可用。`/proc/<pid>/stat` 第 22 字段是进程启动 tick，不是系统启动时间；跨重启的持久锚点还应结合系统 boot ID。

## 2. 真实 core：注销和过期清理都会删除底稿

测试读取当前 `plugins/session-messaging/src/mailbox.ts`，只把邮箱根目录替换为临时目录，再去除 TypeScript 类型运行。没有改动生产源码或访问真实邮箱。

分别在测试 inbox 放入未读 JSON、`delivered.log`、`overflow-example.txt`：

| 操作 | 实测结果 |
|---|---|
| `unregister(id)` | 注册删除，整个 inbox 删除，三种文件均不保留 |
| 过期且 PID 不存在后调用 `listSessions()` | 同样删除整个 inbox |
| 两个注册使用相同精确名字后 `resolveTarget(name)` | 静默返回其中一个，确认 v3 所述寻址修复确有必要 |

因此，仅在注销时告警不能支持“人工处理未读消息”，也不能保证 `delivered.log` 永久可查。**需要把归档与会话清理分离**：归档放在不会被注销/判死递归删除的位置；未读消息进入可恢复的 retired/pending 区；清理注册和删除消息必须是不同操作。还需明确旧版 pi 插件的清理兼容策略，否则旧插件仍可能删掉共享 inbox。

“不丢底稿”还需要定义故障边界：追加失败时不得删源文件；并发写入、部分日志行、磁盘写满和断电持久性都不能由普通 `append` 自动保证。本轮未进行这些故障注入，不能宣称已验证 crash-safe 日志。

## 3. 积压策略模型与性能基线

策略模型排队 12 条消息，按“每次两条、每 turn 总共最多两次 Stop block”执行：

| 事件 | 本次投递 | 剩余 |
|---|---:|---:|
| Stop，首次 | 2 | 10 |
| Stop，连续 | 2 | 8 |
| Stop，达到上限 | 0 | 8 |
| 后续四次 PostToolUse | 每次 2 | 6 → 4 → 2 → 0 |

模型内日志包含全部 12 个唯一 ID，未重复。**这只是 v3 策略模拟，不是实际 Codex 连续 Stop、并发 hooks 或宿主确认测试。** 文档还应明确“两次”究竟包含首次 block，计数最好按 `(session_id, turn_id)` 隔离。

性能测试预热 5 次、采样 50 次，父进程通过管道提供固定 stdin：

| 基线 | 中位数 | P95 |
|---|---:|---:|
| Node 启动 + JSON 解析 + 空 inbox 扫描 | 22.53ms | 25.56ms |
| Bash 启动 + 读一行 + glob | 1.56ms | 2.57ms |

Bash 基线没有 JSON 解析，二者不是功能等价实现。上述值不包含身份查找、心跳、锁、日志落盘、消息渲染等成本，**不能代替完整 `mailbox check` 基准，也不足以决定改写 Bash**。

## 4. M0 八项验收状态

| 项目 | 状态与证据边界 |
|---|---|
| ① hooks stdin | 部分验证：真实 SessionStart 含 `session_id`、`source`、`cwd` 等；PostToolUse/Stop 输入仍待实测 |
| ② 空闲滞留 | 未完成真实投递测试；本轮未部署真实 mailbox 接收器 |
| ③ 连续 Stop | 只完成策略模拟；真实宿主 block 行为待测 |
| ④ 性能 | 完成启动/空扫描基线；完整 check 与等价 Bash 路径待测 |
| ⑤ 祖先锚点 | 找到真实宿主，但验证出 PID 非唯一身份；工具 shell/MCP 身份链待测 |
| ⑥ 10+ 条积压及日志 | 12 条策略模拟通过；真实 hooks 与日志故障恢复待测 |
| ⑦ 同宿主新会话 | `startup`/`clear` API 路径复现两个已加载会话；v3 自动覆盖规则不成立；TUI `/new` 尚未测试 |
| ⑧ agent ack | 未测，保持尽力投递；不能升级 at-least-once |

本轮没有调用真实模型：首个 turn 指向没有服务的本机端口，目的是触发生命周期 hook。没有完成正常模型 turn，因而不推导 Stop、工具调用、ack 遵循率。模型几次正确执行 ack 也不足以建立可靠性保证；升级前仍要验证 pending 保留、确认幂等性、崩溃恢复和重试条件。

方案正文 §2.1、§4.2 积压段及 §7 仍残留“活跃期间不漏/不丢失”，§5 仍写普通投递后 `ack`。建议统一为“尽力注入；未发送项保留；尝试发送项保留可恢复原文；允许延迟”，并将真正的接收端 ack 与本地出队区分。

## 5. 复现与原始结果

从仓库根目录运行：

```sh
python3 scripts/mailbox-m0/probe-host.py
node scripts/mailbox-m0/probe-local.mjs
python3 scripts/mailbox-m0/benchmark.py
```

要求 Linux `/proc`、Codex、Python 3、Node ≥22.13（本地诊断需 `stripTypeScriptTypes`）、Bash；这不是生产 CLI 的 Node 版本要求。每个程序输出新建 `/tmp/mailbox-m0-*` 目录中的结果。精简实测证据见 [mailbox-m0-results.json](mailbox-m0-results.json)。

宿主探针为测试子进程单独设置临时 `CODEX_HOME`，不复制认证文件、不加载用户插件、不修改现有全局配置。仅对隔离目录内本次生成并审核的 instrumentation hook 启用一次性信任覆盖；它只记录测试输入和进程元数据。没有发送任何跨会话消息。

接口参考：[OpenAI Hooks 文档](https://developers.openai.com/zh-Hans/docs/hooks)。实测结论仅适用于上述版本与路径，不把官方接口说明当作本地行为验收。
