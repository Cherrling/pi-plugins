/**
 * Claude Code-style status line
 *
 * Shows cwd (with ~ abbreviation), git branch (+ dirty indicator),
 * thinking level, and model name in the footer.
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function run(cmd: string, cwd: string): string | null {
	try {
		return execSync(cmd, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

function shortenPath(p: string): string {
	const os = require("node:os");
	if (p === os.homedir()) return "~";
	if (p.startsWith(os.homedir() + "/")) return "~" + p.slice(os.homedir().length);
	return p;
}

export default function (pi: ExtensionAPI) {
	let thinking = "medium";
	let model = "";

	const render = (ctx: any) => {
		const theme = ctx.ui.theme;
		const parts: string[] = [];

		// cwd
		const cwd = process.cwd();
		parts.push(theme.fg("accent", "📂 " + shortenPath(cwd)));

		// git branch + dirty
		const branch = run("git rev-parse --abbrev-ref HEAD", cwd);
		if (branch) {
			const dirty =
				run("git status --porcelain", cwd) !== null &&
				run("git status --porcelain", cwd) !== "";
			const branchPart = theme.fg("mdLink", "⎇ " + branch);
			parts.push(dirty ? branchPart + theme.fg("warning", " ✗") : branchPart);
		}

		// thinking level
		parts.push(theme.fg("dim", "🧠 " + thinking));

		// model
		if (model) parts.push(theme.fg("dim", "✦ " + model));

		ctx.ui.setStatus("cc-status", parts.join(theme.fg("dim", "  │  ")));
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model) model = ctx.model.id ?? String(ctx.model);
		if (ctx.thinkingLevel) thinking = ctx.thinkingLevel;
		render(ctx);
	});

	pi.on("model_select", async (event: any, ctx) => {
		if (event?.model?.id) model = event.model.id;
		render(ctx);
	});

	pi.on("thinking_level_select", async (event: any, ctx) => {
		if (event?.level) thinking = event.level;
		render(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		render(ctx);
	});
}
