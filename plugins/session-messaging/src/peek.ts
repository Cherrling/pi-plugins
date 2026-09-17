/**
 * peek.ts — read-only monitoring of another session's transcript.
 * Parses the tail of a session jsonl file, compresses tool output,
 * and detects staleness.
 */

import fs from "node:fs";
import type { Registration } from "./mailbox.js";

const TOOL_OUTPUT_LIMIT = 200;

interface JsonlEntry {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				if (typeof c === "string") return c;
				if (c && typeof c === "object" && "text" in c)
					return String((c as { text: string }).text);
				if (c && typeof c === "object" && "type" in c) {
					const t = (c as { type: string }).type;
					if (t === "toolCall") {
						const name = (c as { name?: string }).name ?? "tool";
						return `[调用工具 ${name}]`;
					}
				}
				return "";
			})
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

/**
 * Return a compact summary of the last `lines` entries of a session
 * transcript, plus a staleness hint.
 */
export function peekSession(reg: Registration, lines: number): string {
	const file = reg.sessionFile;
	if (!file || !fs.existsSync(file)) {
		return `会话 ${reg.name} 没有可读的 transcript（sessionFile 为空或不存在）。`;
	}

	const stat = fs.statSync(file);
	const idleSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
	const staleHint =
		idleSeconds > 300
			? `\n⚠️ transcript 已 ${Math.floor(idleSeconds / 60)} 分钟没有更新，该会话可能已停止工作。`
			: "";

	// Read only the tail: last ~256KB is plenty for N entries.
	const size = stat.size;
	const tail = Math.min(size, 256 * 1024);
	const fd = fs.openSync(file, "r");
	const buf = Buffer.alloc(tail);
	fs.readSync(fd, buf, 0, tail, size - tail);
	fs.closeSync(fd);

	const raw = buf.toString("utf8");
	// Drop the first (likely partial) line when we sliced mid-line.
	const jsonl = (tail < size ? raw.slice(raw.indexOf("\n") + 1) : raw)
		.split("\n")
		.filter((l) => l.trim());

	const entries: JsonlEntry[] = [];
	for (const line of jsonl) {
		try {
			entries.push(JSON.parse(line));
		} catch {
			/* partial/corrupt line */
		}
	}

	const tailEntries = entries.slice(-lines);
	if (tailEntries.length === 0) return `会话 ${reg.name} transcript 为空。${staleHint}`;

	const out: string[] = [];
	for (const e of tailEntries) {
		if (e.type !== "message" || !e.message?.role) continue;
		const role = e.message.role;
		const text = textFromContent(e.message.content).trim();
		if (!text) continue;
		const clipped =
			text.length > TOOL_OUTPUT_LIMIT
				? `${text.slice(0, TOOL_OUTPUT_LIMIT)}…(${text.length} 字符)`
				: text;
		out.push(`[${role}] ${clipped}`);
	}

	if (out.length === 0) return `会话 ${reg.name} 最近的条目没有可显示的文本。${staleHint}`;
	return `会话 "${reg.name}" 最近 ${out.length} 条：\n${out.join("\n")}${staleHint}`;
}
