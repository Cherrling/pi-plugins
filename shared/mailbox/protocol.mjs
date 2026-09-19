/**
 * protocol.mjs — SAMP-compatible message helpers + render templates.
 *
 * SAMP v1 compatibility:
 *   - id = sha256(canonical_json({body,from,thread,to,ts}))[:16], canonical
 *     json = compact separators, sorted keys, raw UTF-8 (no \uXXXX escaping)
 *   - unknown fields (type/taskId) are ignored by SAMP readers
 *   - thread: explicit `[thread:xxx]` prefix or auto-derived date-from-slug
 */

import { createHash } from "node:crypto";

export const MAX_BODY = 4096;

/** SAMP canonical JSON for the id input. Keys alphabetical: body,from,thread,to,ts. */
export function canonicalForId({ body, from, thread, to, ts }) {
	const o = { body, from, thread, to, ts };
	return JSON.stringify(o); // insertion order = alphabetical above, no spaces, raw UTF-8
}

export function sampId(rec) {
	return createHash("sha256").update(canonicalForId(rec), "utf8").digest("hex").slice(0, 16);
}

/** SAMP §4.2 auto thread derivation. */
export function deriveThread({ body, from, ts }) {
	const d = new Date(ts * 1000);
	const date = d.toISOString().slice(0, 10);
	const firstLine = body.split("\n", 1)[0].toLowerCase();
	const slug =
		firstLine.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "msg";
	return `${date}-${from}-${slug}`;
}

/** SAMP §4: strip explicit [thread:...] prefix, returns {body, thread?}. */
export function splitThread(body) {
	const m = body.match(/^\s*\[thread:([^\]]+)\]\s*/);
	if (!m) return { body };
	const thread = m[1].replace(/[\x00-\x1f\x7f]/g, "").trim();
	return { body: body.slice(m[0].length), thread: thread || undefined };
}

/** Build a full outbound message record. type/taskId are our extensions. */
export function buildMessage({ from, to, body, type = "chat", taskId }) {
	const now = Math.floor(Date.now() / 1000);
	const split = splitThread(body);
	const thread = split.thread ?? deriveThread({ body: split.body, from, ts: now });
	const base = { body: split.body, from, thread, to, ts: now };
	return { id: sampId(base), ...base, type, ...(taskId ? { taskId } : {}) };
}

export function newTaskId() {
	return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Render messages for injection. Reply guidance follows the RECEIVER's
 * capability (v6.2 §6): pi → native tools; external → CLI commands.
 * `me` is the receiving alias; receiverKind is looked up by the caller.
 */
export function renderIncoming(msgs, receiverKind) {
	const external = receiverKind === "external";
	const replyChat = external
		? `（回复：运行 mailbox send <对端别名> <文本>）`
		: `（回复：调用 send_session_message 工具，收件人用消息里的 from 别名）`;
	const replyTask = external
		? `（完成后必须运行：mailbox report <from> <taskId> <结果>）`
		: `（完成后必须调用 report_task_result(to, taskId, result) 工具回报）`;
	return msgs
		.map((m) => {
			if (m.type === "task")
				return `📋 [任务派发，来自 ${m.from}] taskId=${m.taskId}\n${m.body}\n${replyTask}`;
			if (m.type === "result")
				return `✅ [任务回报，来自 ${m.from}] taskId=${m.taskId}\n${m.body}\n（记录结果并继续编排；如需追问按 chat 回复 ${m.from}。）`;
			return `📨 [来自 ${m.from}] ${m.body}\n${replyChat}`;
		})
		.join("\n\n---\n\n");
}
