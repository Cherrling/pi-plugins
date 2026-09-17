/**
 * view.ts — /agents panel: a Claude Code style agent view.
 *
 * A focusable overlay listing all online sessions (name, state, cwd,
 * busy task). Enter opens a detail page with the session's recent
 * transcript (reuse of peek logic) and registration info.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Registration, listSessions } from "./mailbox.js";
import { peekSession } from "./peek.js";

interface ViewResult {
	action: "close";
}

function pad(s: string, n: number): string {
	return s + " ".repeat(Math.max(0, n - [...s].length));
}

function stateBadge(s: Registration, currentId: string): string {
	if (s.id === currentId) return "[本会话]";
	return s.state === "busy" ? "[忙]" : "[闲]";
}

export class AgentsPanel implements Component, Focusable {
	focused = false;
	readonly width = 72;

	private listIndex = 0;
	private detailOf: Registration | null = null;
	private detailLines: string[] = [];
	private sessions: Registration[] = [];
	private done: (r: ViewResult | undefined) => void;
	private theme: Theme;
	private currentId: string;

	constructor(
		theme: Theme,
		done: (r: ViewResult | undefined) => void,
		currentId: string,
	) {
		this.theme = theme;
		this.done = done;
		this.currentId = currentId;
		this.refresh();
	}

	private refresh() {
		this.sessions = listSessions().sort((a, b) => a.name.localeCompare(b.name));
		if (this.listIndex >= this.sessions.length) this.listIndex = 0;
	}

	handleInput(data: string): void {
		// Detail view: Esc back to list, q closes the panel.
		if (this.detailOf) {
			if (matchesKey(data, "escape")) {
				this.detailOf = null;
			} else if (data === "q") {
				this.done(undefined);
			}
			return;
		}

		if (matchesKey(data, "escape") || data === "q") {
			this.done(undefined);
		} else if (matchesKey(data, "up")) {
			this.listIndex = Math.max(0, this.listIndex - 1);
		} else if (matchesKey(data, "down")) {
			this.listIndex = Math.min(this.sessions.length - 1, this.listIndex + 1);
		} else if (matchesKey(data, "return") && this.sessions.length > 0) {
			const s = this.sessions[this.listIndex]!;
			this.detailOf = s;
			this.detailLines = peekSession(s, 30).split("\n");
		} else if (data === "r") {
			this.refresh();
		}
	}

	render(width: number): string[] {
		const w = Math.min(this.width, width);
		const fg = (c: string, t: string) => this.theme.fg(c as never, t);
		const lines: string[] = [];

		if (this.detailOf) {
			const s = this.detailOf;
			lines.push(fg("accent", `● ${s.name}`) + fg("dim", `  ${stateBadge(s, this.currentId)}  ${s.id.slice(0, 8)}`));
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
			const s = this.sessions[i]!;
			const dot = s.state === "busy" ? fg("warning", "◐") : fg("success", "●");
			const name = pad(s.name, 12);
			const state = pad(stateBadge(s, this.currentId), 6);
			const busy = s.busyTaskId ? ` ${s.busyTaskId.slice(0, 10)}` : "";
			const row = `  ${dot} ${name} ${state} ${s.cwd}${busy}`;
			lines.push(i === this.listIndex ? fg("accent", row) : row);
		}
		return lines;
	}

	invalidate() {}
}
