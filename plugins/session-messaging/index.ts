/**
 * Session Messaging Extension — multi-session orchestration for pi.
 *
 * M1: data layer switched to the formal shared mailbox-core
 * (SAMP append-only logs + watermark, same storage as codex side).
 * Commands, tools, polling/followUp delivery behavior are unchanged.
 *
 * Layout (self-contained; cp -r this dir to ~/.pi/agent/extensions/):
 *   index.ts            this file — pi extension assembly
 *   src/peek.ts         read-only transcript monitor (pi session jsonl)
 *   src/shared/*.mjs    GENERATED from shared/mailbox/ (scripts/sync-shared.sh)
 *
 * Storage (~/.pi/agent/mailbox, env MAILBOX_DIR overrides):
 *   log-<alias>.jsonl       append-only, per sender, never deleted
 *   .state/<alias>.json     watermark + backlog + block counters
 *   sessions/<alias>.json   registry (name/kind/pid/cwd/sessionFile/state)
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Mailbox } from "./src/shared/core.mjs";
import { newTaskId, renderIncoming } from "./src/shared/protocol.mjs";
import { peekSession } from "./src/peek.js";

const POLL_MS = 3000;
const DELIVER_LIMIT = 20;

export default function (pi: ExtensionAPI) {
	let myAlias = "";
	let timer: ReturnType<typeof setInterval> | undefined;
	let mb = new Mailbox();

	const send = (
		type: "chat" | "task" | "result",
		to: string,
		text: string,
		taskId?: string,
	): Promise<string> =>
		mb
			.send({ from: myAlias, to, body: text, type, taskId })
			.then(
				(m) =>
					`已发送给 ${to}（消息 id=${m.id.slice(0, 8)}）。`,
			)
			.catch((e: Error) => `错误：${e.message}`);

	const deliverInbox = (ctx: ExtensionContext) => {
		if (!myAlias) return;
		mb.heartbeat(myAlias);
		void mb
			.deliver(myAlias, {
				limit: DELIVER_LIMIT,
				emit: async (msgs, remaining) => {
					let prompt = renderIncoming(msgs, "pi");
					if (remaining > 0) prompt += `\n\n[另有 ${remaining} 条待投递]`;
					const hasTask = msgs.some((m) => m.type === "task");
					if (hasTask) {
						try {
							mb.updateSession(myAlias, {
								state: "busy",
								busyTaskId: msgs.find((m) => m.type === "task")?.taskId,
							});
						} catch {}
					}
					if (ctx.isIdle()) {
						pi.sendUserMessage(prompt);
					} else {
						// followUp queues until the agent finishes — never interrupts
						pi.sendUserMessage(prompt, { deliverAs: "followUp" });
					}
					const fromNames = [...new Set(msgs.map((m) => m.from))];
					ctx.ui.notify(`📨 新消息来自 ${fromNames.join(", ")}`, "info");
				},
			})
			.catch(() => {});
	};

	pi.on("session_start", async (_event, ctx) => {
		mb = new Mailbox();
		// session_start fires for /new too: drop registrations owned by this
		// same process (safe — we own them), keep the new one, and carry the
		// reader watermark over so unread messages survive /new.
		const prevName = myAlias;
		myAlias =
			process.env.PI_SESSION_NAME?.trim() || ctx.sessionManager.getSessionId().slice(0, 8);
		if (prevName && prevName !== myAlias) {
			mb.unregisterOwnedBy(process.pid, { except: myAlias });
			mb.renameReader(prevName, myAlias);
		}
		try {
			mb.register({
				name: myAlias,
				kind: "pi",
				pid: process.pid,
				cwd: process.cwd(),
				sessionFile: ctx.sessionManager.getSessionFile?.() ?? "",
			});
		} catch (e) {
			// live foreign owner (name collision) — keep polling as reader anyway
			ctx.ui.notify(`mailbox 注册失败：${(e as Error).message}`, "warning");
		}
		if (timer) clearInterval(timer);
		timer = setInterval(() => deliverInbox(ctx), POLL_MS);
		timer.unref?.();
		deliverInbox(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		// registration removal only; logs and state stay (append-only design)
		if (myAlias) mb.unregisterOwnedBy(process.pid);
	});

	// ── human commands ──────────────────────────────────────────

	pi.registerCommand("msg-name", {
		description: "给当前 session 起名字: /msg-name <name>",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name || /\s/.test(name)) {
				ctx.ui.notify("用法: /msg-name <name>（不含空格）", "warning");
				return;
			}
			const old = myAlias;
			try {
				mb.register({
					name,
					kind: "pi",
					pid: process.pid,
					cwd: process.cwd(),
				});
				mb.renameReader(old, name);
				if (old && old !== name) mb.unregisterOwnedBy(process.pid, { except: name });
				myAlias = name;
				ctx.ui.notify(`本 session 已命名为 "${name}"`, "info");
			} catch (e) {
				ctx.ui.notify(`命名失败：${(e as Error).message}`, "warning");
			}
		},
	});

	pi.registerCommand("msg-sessions", {
		description: "列出在线的 pi session",
		handler: async (_args, ctx) => {
			const sessions = mb.listSessions();
			if (sessions.length === 0) {
				ctx.ui.notify("没有在线的 session", "info");
				return;
			}
			const lines = sessions.map((s: any) => {
				const me = s.name === myAlias ? " (本会话)" : "";
				const state = s.state === "busy" ? " [忙]" : "";
				const dead = s.alive ? "" : " [离线]";
				return `${s.name}${state}${dead}  ${s.cwd}${me}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── agent tools ─────────────────────────────────────────────

	pi.registerTool({
		name: "send_session_message",
		label: "Session 消息",
		description:
			"发送消息到另一个 pi session（跨会话通信）。收件人用 session 名字或 id 前缀。",
		parameters: Type.Object({
			to: Type.String({ description: "收件人 session 的名字或 id 前缀" }),
			text: Type.String({ description: "消息内容" }),
		}),
		async execute(_toolCallId, { to, text }: { to: string; text: string }) {
			const target = safeResolve(to);
			if (typeof target !== "string") return target;
			return { details: undefined, content: [{ type: "text", text: await send("chat", target, text) }] };
		},
	});

	pi.registerTool({
		name: "list_sessions",
		label: "列出在线 session",
		description:
			"列出当前在线的其他 pi session（名字、忙闲状态、工作目录），用于跨会话通信或派发任务前查找对象。",
		parameters: Type.Object({}),
		async execute() {
			const sessions = mb.listSessions().filter((s: any) => s.name !== myAlias);
			if (sessions.length === 0)
				return { details: undefined, content: [{ type: "text", text: "没有其他在线 session。" }] };
			const lines = sessions.map(
				(s: any) =>
					`${s.name}  ${s.state === "busy" ? "[忙]" : "[闲]"}${s.alive ? "" : "[离线]"}  ${s.cwd}`,
			);
			return { details: undefined, content: [{ type: "text", text: lines.join("\n") }] };
		},
	});

	pi.registerTool({
		name: "dispatch_task",
		label: "派发任务",
		description:
			"给另一个 pi session 派发任务（boss/worker 编排用）。任务带 taskId，对方完成后会回报结果。" +
			"派发前建议先用 list_sessions 查看谁在线且空闲。",
		parameters: Type.Object({
			to: Type.String({ description: "worker session 的名字或 id 前缀" }),
			task: Type.String({ description: "任务描述，要具体、自包含" }),
		}),
		async execute(_toolCallId, { to, task }: { to: string; task: string }) {
			const target = safeResolve(to);
			if (typeof target !== "string") return target;
			const taskId = newTaskId();
			const r = await send("task", target, task, taskId);
			return {
				details: undefined,
				content: [
					{
						type: "text",
						text: `${r} taskId=${taskId}。等待对方完成并回报；期间可用 peek_session 查看其进度。`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "report_task_result",
		label: "回报任务结果",
		description:
			"回报任务结果给派发方（worker 专用）。完成 dispatch_task 派来的任务后必须调用，附上 taskId。",
		parameters: Type.Object({
			to: Type.String({ description: "派发方 session 的名字或 id 前缀" }),
			taskId: Type.String({ description: "任务派发时附带的 taskId" }),
			result: Type.String({ description: "任务结果、结论或产物路径" }),
		}),
		async execute(
			_toolCallId,
			{ to, taskId, result }: { to: string; taskId: string; result: string },
		) {
			const target = safeResolve(to);
			if (typeof target !== "string") return target;
			const r = await send("result", target, result, taskId);
			// Task closed: flip our own state back to idle.
			try {
				mb.updateSession(myAlias, { state: "idle", busyTaskId: undefined });
			} catch {}
			return { details: undefined, content: [{ type: "text", text: r }] };
		},
	});

	pi.registerTool({
		name: "peek_session",
		label: "查看 session 动态",
		description:
			"只读查看另一个 session 最近的对话记录（最近 N 条，工具输出已压缩）。" +
			"用于监控 worker 进度、发现卡死，不会打扰对方。",
		parameters: Type.Object({
			to: Type.String({ description: "目标 session 的名字或 id 前缀" }),
			lines: Type.Optional(
				Type.Number({
					description: "查看最近多少条（默认 20）",
					minimum: 1,
					maximum: 100,
				}),
			),
		}),
		async execute(
			_toolCallId,
			{ to, lines }: { to: string; lines?: number },
		) {
			const target = safeResolve(to);
			if (typeof target !== "string") return target;
			const reg = mb.listSessions().find((s: any) => s.name === target) as any;
			if (!reg?.sessionFile)
				return {
					details: undefined,
					content: [{ type: "text", text: `错误：${target} 没有 sessionFile（非 pi 会话或未注册）。` }],
				};
			return {
				details: undefined,
				content: [{ type: "text", text: peekSession(reg, lines ?? 20) }],
			};
		},
	});

	// resolveTarget is fallible now (ambiguity errors) — tools must surface
	// the error instead of throwing across the pi tool boundary.
	function safeResolve(to: string) {
		try {
			const name = mb.resolveTarget(to);
			if (name === myAlias) {
				return {
					details: undefined,
					content: [{ type: "text", text: "错误：不能给自己发消息。" }],
				};
			}
			return name;
		} catch (e) {
			return {
				details: undefined,
				content: [{ type: "text", text: `错误：${(e as Error).message}` }],
			};
		}
	}
}
