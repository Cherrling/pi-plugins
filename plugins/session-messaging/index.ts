/**
 * Session Messaging Extension — multi-session orchestration for pi.
 *
 * Architecture (see src/ for modules):
 *   mailbox.ts   pure data layer: registration dir, heartbeat, inboxes
 *   protocol.ts  message types (chat/task/result) + prompt templates
 *   peek.ts      read-only transcript monitoring for boss sessions
 *
 * Human commands:
 *   /msg-name <name>    name this session (used by peers to find you)
 *   /msg-sessions       list online sessions (name, state, cwd)
 *
 * Agent tools:
 *   send_session_message(to, text)             chat message to a peer
 *   list_sessions()                            enumerate online peers
 *   dispatch_task(to, task)                    send a tracked task,
 *                                               expects a result with taskId
 *   report_task_result(to, taskId, result)     worker: report completion
 *   peek_session(to, lines)                    read another session's
 *                                               recent transcript (read-only)
 */

import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	HEARTBEAT_MS,
	POLL_MS,
	type Registration,
	type SessionState,
	drainInbox,
	deliver,
	ensureDirs,
	heartbeat,
	inboxDir,
	listSessions,
	regPath,
	resolveTarget,
	unregister,
	updateRegistration,
} from "./src/mailbox.js";
import {
	type Message,
	newTaskId,
	renderIncoming,
} from "./src/protocol.js";
import { AgentsPanel } from "./src/view.js";
import { peekSession } from "./src/peek.js";

export default function (pi: ExtensionAPI) {
	let myId = "";
	let myName = "";
	let timer: ReturnType<typeof setInterval> | undefined;

	const send = (type: Message["type"], to: string, text: string, taskId?: string): string => {
		const target = resolveTarget(to);
		if (!target) {
			return `错误：找不到 session "${to}"。用 list_sessions 工具查看在线列表。`;
		}
		if (target.id === myId) {
			return "错误：不能给自己发消息。";
		}
		deliver(target, {
			fromId: myId,
			fromName: myName,
			type,
			taskId,
			text,
		});
		return `已发送给 ${target.name} (${target.id.slice(0, 8)})。`;
	};

	const deliverInbox = (ctx: ExtensionContext) => {
		if (!myId) return;
		const msgs = drainInbox(myId);
		if (msgs.length === 0) return;
		// Merge pending messages into ONE prompt to save agent turns.
		const prompt = msgs.map((m) => renderIncoming(m)).join("\n\n---\n\n");
		const hasTask = msgs.some((m) => m.type === "task");
		if (hasTask) {
			// Mark busy while a task is pending; the worker reports back
			// and we flip to idle when a result is sent.
			updateRegistration(myId, {
				state: "busy" as SessionState,
				busyTaskId: msgs.find((m) => m.type === "task")?.taskId,
			});
		}
		if (ctx.isIdle()) {
			pi.sendUserMessage(prompt);
		} else {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		}
		const fromNames = [...new Set(msgs.map((m) => m.fromName))];
		ctx.ui.notify(`📨 新消息来自 ${fromNames.join(", ")}`, "info");
	};

	pi.on("session_start", async (_event, ctx) => {
		ensureDirs();
		// session_start fires for /new too: drop the old timer and
		// re-register under the new id.
		if (timer) clearInterval(timer);
		const prevId = myId;
		if (prevId) unregister(prevId);

		myId = ctx.sessionManager.getSessionId();
		// Pre-assigned name wins (spawn_session sets PI_SESSION_NAME),
		// else fall back to id prefix.
		myName = process.env.PI_SESSION_NAME?.trim() || myId.slice(0, 8);
		const reg: Registration = {
			id: myId,
			name: myName,
			pid: process.pid,
			cwd: process.cwd(),
			sessionFile: ctx.sessionManager.getSessionFile?.() ?? "",
			startedAt: Date.now(),
			state: "idle",
		};
		fs.mkdirSync(inboxDir(myId), { recursive: true });
		fs.writeFileSync(regPath(myId), JSON.stringify(reg, null, 2));

		timer = setInterval(() => {
			heartbeat(myId);
			deliverInbox(ctx);
		}, POLL_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		unregister(myId);
	});

	// ── human commands ──────────────────────────────────────────────

	pi.registerCommand("agents", {
		description: "打开 agent view 面板：查看所有在线 session 及其动态",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			await ctx.ui.custom(
				(_tui, theme, _keybindings, done) =>
					new AgentsPanel(theme, (r) => done(r), myId),
				{ overlay: true },
			);
		},
	});

	pi.registerCommand("msg-name", {
		description: "给当前 session 起名字: /msg-name <name>",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name || /\s/.test(name)) {
				ctx.ui.notify("用法: /msg-name <name>（不含空格）", "warning");
				return;
			}
			myName = name;
			updateRegistration(myId, { name });
			ctx.ui.notify(`本 session 已命名为 "${name}"`, "info");
		},
	});

	pi.registerCommand("msg-sessions", {
		description: "列出在线的 pi session",
		handler: async (_args, ctx) => {
			const sessions = listSessions();
			if (sessions.length === 0) {
				ctx.ui.notify("没有在线的 session", "info");
				return;
			}
			const lines = sessions.map((s) => {
				const me = s.id === myId ? " (本会话)" : "";
				const state = s.state === "busy" ? " [忙]" : "";
				return `${s.name}${state}  ${s.id.slice(0, 8)}  ${s.cwd}${me}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── background worker spawning ──────────────────────────────

	/**
	 * Spawn a detached, headless `pi -p` process as a background worker.
	 * It loads this same extension (registers in the mailbox, gets the
	 * send_session_message tool), works on `task`, reports the result back
	 * to us, and exits. No terminal window is created.
	 */
	const spawnWorker = (
		name: string,
		cwd: string,
		task: string,
	): { pid: number; sessionId: string } => {
		const sessionId = `sm-${name}`;
		const reportBack =
			`完成后，用 send_session_message 工具向 "${myName}" 回报结果` +
			`(调用前先用 list_sessions 确认我在)；如果任务无法完成也要回报原因。`;
		const prompt = `${task}\n\n(${reportBack})`;
		const argv = [
			"-p",
			"--session-id",
			sessionId,
			"--no-extensions",
			"-e",
			extensionSelfPath(),
			prompt,
		];
		const child = spawn("pi", argv, {
			cwd,
			detached: true,
			stdio: ["ignore", "ignore", "ignore"],
			env: {
				...process.env,
			PI_SESSION_NAME: name,
		},
		});
		child.unref();
		return { pid: child.pid ?? -1, sessionId };
	};

	const extensionSelfPath = (): string => {
		// import.meta.url = .../extensions/session-messaging/index.ts
		const self = new URL(import.meta.url).pathname;
		return self;
	};

	pi.registerTool({
		name: "spawn_session",
		label: "拉起后台 worker",
		description:
			"在指定目录拉起一个无界面的后台 pi worker（不占终端窗口），立即返回。" +
			"worker 会自动加载会话通信能力；给它 task 描述任务，完成后会通过 session 消息回报结果。" +
			"适合并行扫描/批量处理；需要盯着看或人工干预的任务建议让用户手动开会话。",
		parameters: Type.Object({
			name: Type.String({
				description: "worker 名字（字母数字和-_，会成为 session id 的一部分）",
			}),
			cwd: Type.String({ description: "worker 的工作目录（绝对路径）" }),
			task: Type.String({ description: "要执行的任务描述，要自包含、具体" }),
		}),
		async execute(
			_toolCallId,
			{ name, cwd, task }: { name: string; cwd: string; task: string },
		) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
				return {
					details: undefined,
					content: [
						{
						type: "text",
						text: "错误：名字只能包含字母数字和 . _ -，且以字母数字开头。",
					},
				],
				};
			}
			if (!fs.existsSync(cwd)) {
					return {
					details: undefined,
					content: [{ type: "text", text: `错误：目录不存在 ${cwd}` }],
				};
			}
			const { pid, sessionId } = spawnWorker(name, cwd, task);
			return {
					details: undefined,
					content: [
						{
						type: "text",
						text:
							`已拉起后台 worker "${name}"（pid=${pid}，session=${sessionId}，目录 ${cwd}）。` +
							`它正在执行任务，完成后会通过 session 消息回报。可用 /agents 面板或 peek_session 查看进度。`,
					},
				],
			};
		},
	});

	// ── agent tools ─────────────────────────────────────────────────

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
			return { details: undefined, content: [{ type: "text", text: send("chat", to, text) }] };
		},
	});

	pi.registerTool({
		name: "list_sessions",
		label: "列出在线 session",
		description:
			"列出当前在线的其他 pi session（名字、忙/闲状态、工作目录），用于跨会话通信或派发任务前查找对象。",
		parameters: Type.Object({}),
		async execute() {
			const sessions = listSessions().filter((s) => s.id !== myId);
			if (sessions.length === 0)
				return { details: undefined, content: [{ type: "text", text: "没有其他在线 session。" }] };
			const lines = sessions.map(
				(s) =>
					`${s.name}  ${s.state === "busy" ? "[忙]" : "[闲]"}  ${s.id.slice(0, 8)}  ${s.cwd}`,
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
			const target = resolveTarget(to);
			if (!target) {
				return {
					details: undefined,
					content: [
						{
							type: "text",
							text: `错误：找不到 session "${to}"。用 list_sessions 工具查看在线列表。`,
						},
					],
				};
			}
			if (target.id === myId) {
				return { details: undefined, content: [{ type: "text", text: "错误：不能给自己派任务。" }] };
			}
			const taskId = newTaskId();
			const r = send("task", to, task, taskId);
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
			const r = send("result", to, result, taskId);
			// Task closed: flip our own state back to idle.
			updateRegistration(myId, { state: "idle", busyTaskId: undefined });
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
			const target = resolveTarget(to);
			if (!target) {
				return {
					details: undefined,
					content: [
						{ type: "text", text: `错误：找不到 session "${to}"。` },
					],
				};
			}
			if (target.id === myId) {
				return {
					details: undefined,
					content: [{ type: "text", text: "错误：不能 peek 自己。" }],
				};
			}
			return {
				details: undefined,
				content: [
					{ type: "text", text: peekSession(target, lines ?? 20) },
				],
			};
		},
	});
}
