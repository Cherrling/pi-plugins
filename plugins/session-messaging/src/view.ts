/**
 * view.ts — /agents panel: a Claude Code style agent view.
 *
 * A focusable overlay listing all online sessions (name, state, cwd,
 * busy task). Enter opens a detail page with the session's recent
 * transcript (reuse of peek logic) and registration info.
 */

import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Registration } from "./mailbox.js";
import { peekSession } from "./peek.js";

interface ViewResult {
	action: "close";
}

const KEY_LEFT = "\x1b[D";
const KEY_RIGHT = "\x1b[C";
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_ESC = "\x1b";
const KEY_R = "r";
const KEY_Q = "q";

function pad(s: string, n: number): string {
	const w = [...s].length;
	return s + " ".repeat(Math.max(0, n - w));
}

function stateBadge(s: Registration): string {
	if (s.id === CURRENT_ID) return "[本会话]";
	return s.state === "busy" ? "[忙]" : "[闲]";
}

/** Set by the extension before opening the panel. */
export let CURRENT_ID = "";
export function setCurrentId(id: string) {
	CURRENT_ID = id;
}

export class AgentsPanel implements Component, Focusable {
	focused = false;
	readonly width = 72;

	private listIndex = 0;
	private detailOf: Registration | null = null;
	private detailLines: string[] = [];
	private sessions: Registration[] = [];
	private done: (r: ViewResult) => void;
	private theme: Theme;
	private clock = 0; // forces periodic refresh while open

	constructor(theme: Theme, done: (r: ViewResult) => void) {
		this.theme = theme;
		this.done = done;
		this.refresh();
	}

	private refresh() {
		// Imported lazily to avoid a cycle at module load; mailbox has no
		// dependency on this file, but keep it clean anyway.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { listSessions } = require("./mailbox.js") as typeof import("./mailbox.js");
		this.sessions = listSessions().sort((a, b) => a.name.localeCompare(b.name));
		if (this.listIndex >= this.sessions.length) this.listIndex = 0;
	}

	onKey(key: string): boolean {
		if (this.detailOf) {
			if (key === KEY_ESC) {
				this.detailOf = null;
				return true;
			}
			if (key === KEY_Q) {
				this.done({ action: "close" });
				return true;
			}
			return true; // swallow other keys in detail view
		}
		if (key === KEY_Q || key === KEY_ESC) {
			this.done({ action: "close" });
			return true;
		}
		if (key === KEY_UP) {
			this.listIndex = Math.max(0, this.listIndex - 1);
			return true;
		}
		if (key === KEY_DOWN) {
			this.listIndex = Math.min(this.sessions.length - 1, this.listIndex + 1);
			return true;
		}
		if (key === KEY_ENTER && this.sessions.length > 0) {
			const s = this.sessions[this.listIndex];
			this.detailOf = s;
			this.detailLines = peekSession(s, 30).split("\n");
			return true;
		}
		if (key === KEY_R) {
			this.refresh();
			return true;
		}
		return true; // swallow everything else: we own the keyboard
	}

	render(width: number): string[] {
		const w = Math.min(this.width, width);
		const fg = (c: string, t: string) => this.theme.fg(c as never, t);
		const lines: string[] = [];

		if (this.detailOf) {
			const s = this.detailOf;
			lines.push(fg("accent", `● ${s.name}`) + fg("dim", `  ${stateBadge(s)}  ${s.id.slice(0, 8)}`));
			lines.push(fg("dim", `目录: ${s.cwd}`));
			lines.push(fg("dim", `启动于: ${new Date(s.startedAt).toLocaleString()}`));
			if (s.busyTaskId) lines.push(fg("warning", `进行中任务: ${s.busyTaskId}`));
			lines.push(fg("dim", "─".repeat(Math.max(0, w - 4))));
			lines.push(...this.detailLines);
			lines.push("");
			lines.push(fg("dim", "Esc 返回列表 · q 退出"));
			return lines;
		}

		lines.push(fg("accent", "pi sessions") + fg("dim", "  (r 刷新 · ↑↓ 选择 · Enter 详情 · q 退出)"));
		if (this.sessions.length === 0) {
			lines.push(fg("dim", "  没有在线的 session"));
		}
		for (let i = 0; i < this.sessions.length; i++) {
			const s = this.sessions[i];
			const dot = s.state === "busy" ? fg("warning", "◐") : fg("success", "●");
			const name = pad(s.name, 12);
			const state = pad(stateBadge(s), 6);
			const busy = s.busyTaskId ? ` ${s.busyTaskId.slice(0, 10)}` : "";
			const row = `  ${dot} ${name} ${state} ${s.cwd}${busy}`;
			const content = i === this.listIndex ? fg("accent", row) : row;
			lines.push(content);
		}
		return lines;
	}

	invalidate() {}
}
