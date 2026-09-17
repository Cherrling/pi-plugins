/**
 * Session Messaging Extension
 *
 * Lets multiple pi sessions send messages to each other.
 *
 * - Sessions auto-register in ~/.pi/agent/mailbox/ with a heartbeat.
 * - /msg <name|id-prefix> <text>   send a message to another session
 * - /msg-name <name>               set a friendly name for this session
 * - /msg-sessions                  list online sessions
 * - Tool `send_session_message`    lets the agent itself reply/initiate messages
 *
 * Received messages are injected as user messages into the conversation.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAILBOX_DIR = path.join(os.homedir(), ".pi", "agent", "mailbox");
const SESSIONS_DIR = path.join(MAILBOX_DIR, "sessions");
const INBOXES_DIR = path.join(MAILBOX_DIR, "inboxes");
const HEARTBEAT_MS = 5000;
const STALE_MS = 20000;
const POLL_MS = 3000;

interface Registration {
	id: string;
	name: string;
	pid: number;
	cwd: string;
	sessionFile: string;
	startedAt: number;
}

interface Message {
	fromId: string;
	fromName: string;
	text: string;
	ts: number;
}

function ensureDirs() {
	fs.mkdirSync(SESSIONS_DIR, { recursive: true });
	fs.mkdirSync(INBOXES_DIR, { recursive: true });
}

function regPath(id: string) {
	return path.join(SESSIONS_DIR, `${id}.json`);
}

function inboxDir(id: string) {
	return path.join(INBOXES_DIR, id);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Read all registrations; clean up dead ones (no heartbeat file update + pid gone). */
function listSessions(): Registration[] {
	ensureDirs();
	const out: Registration[] = [];
	for (const f of fs.readdirSync(SESSIONS_DIR)) {
		if (!f.endsWith(".json")) continue;
		const p = path.join(SESSIONS_DIR, f);
		try {
			const reg = JSON.parse(fs.readFileSync(p, "utf8")) as Registration;
			const fresh = Date.now() - fs.statSync(p).mtimeMs < STALE_MS;
			if (fresh || pidAlive(reg.pid)) {
				out.push(reg);
			} else {
				fs.unlinkSync(p);
				fs.rmSync(inboxDir(reg.id), { recursive: true, force: true });
			}
		} catch {
			/* ignore corrupt files */
		}
	}
	return out;
}

function resolveTarget(query: string): Registration | null {
	const sessions = listSessions();
	const q = query.toLowerCase();
	const matches = sessions.filter(
		(s) =>
			s.name.toLowerCase() === q ||
			s.id.toLowerCase().startsWith(q) ||
			s.name.toLowerCase().startsWith(q),
	);
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		// Prefer exact name match, then exact id
		const exact = matches.find((s) => s.name.toLowerCase() === q || s.id.toLowerCase() === q);
		return exact ?? matches[0];
	}
	return matches[0];
}

export default function (pi: ExtensionAPI) {
	let myId = "";
	let myName = "";

	const heartbeat = () => {
		if (!myId) return;
		try {
			// Touch the registration file's mtime (metadata-only, no content
		// rewrite, so /msg-name renames can never be raced and clobbered).
			const now = new Date();
			fs.utimesSync(regPath(myId), now, now);
		} catch {
			/* session not registered yet / already shut down */
		}
	};

	const deliverInbox = (ctx: any) => {
		if (!myId) return;
		const dir = inboxDir(myId);
		ensureDirs();
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
		} catch {
			return;
		}
		for (const f of files) {
			const p = path.join(dir, f);
			try {
				const msg = JSON.parse(fs.readFileSync(p, "utf8")) as Message;
				fs.unlinkSync(p); // consume first; avoid double delivery
				const prompt =
					`📨 [来自另一个 pi session: ${msg.fromName}] ${msg.text}\n\n` +
					`(这是跨会话消息。如需回复，调用 send_session_message 工具，收件人 "${msg.fromName}"。` +
					`如果不需要回复就忽略或简单处理。)`;
				if (ctx.isIdle()) {
					pi.sendUserMessage(prompt);
				} else {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				}
				ctx.ui.notify(`📨 新消息来自 ${msg.fromName}`, "info");
			} catch {
				/* skip unreadable files */
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		ensureDirs();
		myId = ctx.sessionManager.getSessionId();
		myName = myId.slice(0, 8);
		const reg: Registration = {
			id: myId,
			name: myName,
			pid: process.pid,
			cwd: process.cwd(),
			sessionFile: ctx.sessionManager.getSessionFile?.() ?? "",
			startedAt: Date.now(),
		};
		fs.mkdirSync(inboxDir(myId), { recursive: true });
		fs.writeFileSync(regPath(myId), JSON.stringify(reg, null, 2));

		const timer = setInterval(() => {
			heartbeat();
			deliverInbox(ctx);
		}, POLL_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", async () => {
		try {
			fs.unlinkSync(regPath(myId));
		} catch {}
		fs.rmSync(inboxDir(myId), { recursive: true, force: true });
	});

	const sendMessage = (fromName: string, to: string, text: string): string => {
		const target = resolveTarget(to);
		if (!target) {
			return `错误：找不到 session "${to}"。用 /msg-sessions 查看在线列表。`;
		}
		if (target.id === myId) {
			return "错误：不能给自己发消息。";
		}
		const msg: Message = { fromId: myId, fromName, text, ts: Date.now() };
		const dir = inboxDir(target.id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`), JSON.stringify(msg));
		return `已发送给 ${target.name} (${target.id.slice(0, 8)})。`;
	};

	pi.registerCommand("msg", {
		description: "发送消息到另一个 pi session: /msg <name|id> <text>",
		handler: async (args, ctx) => {
			const m = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!m) {
				ctx.ui.notify("用法: /msg <name|id> <text>", "warning");
				return;
			}
			ctx.ui.notify(sendMessage(myName, m[1], m[2]), "info");
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
			const reg = JSON.parse(fs.readFileSync(regPath(myId), "utf8"));
			reg.name = name;
			fs.writeFileSync(regPath(myId), JSON.stringify(reg, null, 2));
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
				return `${s.name}  ${s.id.slice(0, 8)}  ${s.cwd}${me}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerTool({
		name: "send_session_message",
		description:
			"发送消息到另一个 pi session（跨会话通信）。收件人用 session 名字或 id 前缀。对方 session 的 agent 会收到该消息。",
		parameters: Type.Object({
			to: Type.String({ description: "收件人 session 的名字或 id 前缀" }),
			text: Type.String({ description: "消息内容" }),
		}),
		async execute(_toolCallId, { to, text }: { to: string; text: string }) {
			return { content: [{ type: "text", text: sendMessage(myName, to, text) }] };
		},
	});

	pi.registerTool({
		name: "list_sessions",
		description: "列出当前在线的其他 pi session（名字、id、工作目录），用于跨会话通信前查找收件人。",
		parameters: Type.Object({}),
		async execute() {
			const sessions = listSessions().filter((s) => s.id !== myId);
			if (sessions.length === 0) return { content: [{ type: "text", text: "没有其他在线 session。" }] };
			const lines = sessions.map((s) => `${s.name}  ${s.id.slice(0, 8)}  ${s.cwd}`);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});
}
