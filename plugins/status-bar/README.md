# status-bar

Codex / Claude Code 风格状态栏（统一版，由 status-bar 与 cc-status 合并），替换 pi 内置 footer：

```
# wsz @ cn096 in ~/project on git:main✗ x ctx:12% [22:51:13]
↑1.2k ↓30k R89% W2k CH95.0% $0.42 ██░░░░░░░░ 27%/900k (auto)    🧠 high · glm-5.3 (tai)
```

## Prompt 行（高亮）

`# 用户 @ 主机 in 路径 on git:分支 x ctx:上下文% [时间]`

- 用户名：亮青色
- 主机名：亮绿色
- 路径（~ 缩写）：亮黄色
- git 分支：亮蓝色，工作区 dirty 时追加 ✗（警告色）
- ctx 百分比：按用量 绿/黄/红
- 时间：每秒刷新；有会话名时追加在行尾

## 统计行（内置 footer 的完全超集）

- ↑输入 ↓输出 R缓存读 **W缓存写 CH缓存命中率**（新补齐）
- 费用 `$0.420`，订阅型 provider（kimi-coding）显示 **(sub)**
- 上下文用量条 + **(auto)** 自动压缩指示器（新补齐）
- **xp** 实验特性指示（PI_EXPERIMENTAL=1 时，新补齐）
- 🧠 thinking level 跟随主题色，shift+tab / `/model` 实时更新
- 多 provider 时右侧显示 provider 名
- 保留其他扩展通过 `ctx.ui.setStatus()` 设置的文本

## 其他

- `/statusbar` 命令随时切换回默认 footer
- git dirty 检查带 3 秒缓存，不会拖慢渲染

合并来源：
- cpudev（cn096）`~/.pi/agent/extensions/status-bar.ts`（完整版主体）
- ai（root@ai -J pve）`~/.pi/agent/extensions/cc-status.ts`（贡献 git dirty 标记）

## 安装

```bash
cp status-bar.ts ~/.pi/agent/extensions/
```

安装后无需 cc-status，两台机器统一用这一个即可。

## 已知限制

- `(sub)` 目前只识别 kimi-coding（订阅检测不开放给扩展 API）
- `(auto)` 读取 `~/.pi/settings.json` / `.pi/settings.json` 的 `autoCompaction` 字段（默认开启），运行期切换即时性略逊内置 footer
