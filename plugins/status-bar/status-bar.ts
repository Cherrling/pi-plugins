/**
 * Codex / Claude Code style status bar for pi.
 *
 * Replaces the built-in footer with:
 *
 *   ~/project (main✗) · my-session                        ← cwd (yellow) + git branch (✗ if dirty) + session name
 *   ↑1.2k ↓30k R89% $0.42 ██░░░░░░░░ 27%/900k    🧠 high · glm-5.3 (tai)
 *   <other extensions' ctx.ui.setStatus() texts preserved>  ← only if any
 *
 * - git branch shows a ✗ warning marker when the worktree is dirty
 *   (merged from cc-status).
 *
 * - 🧠 thinking level uses the theme's per-level color (thinkingLow /
 *   thinkingHigh / thinkingMax ...) and updates live: shift+tab cycling,
 *   /model switches, session restore.
 * - Context meter turns warning above 70% and error above 90%.
 * - Token stats count assistant + toolResult + compaction usage.
 * - Toggle with /statusbar.
 */

import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";

type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

const LEVEL_COLOR = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const;

type FooterColor =
	| "dim"
	| "success"
	| "warning"
	| "error"
	| (typeof LEVEL_COLOR)[ThinkingLevel];

/** Minimal structural view of the theme the footer needs. */
interface ThemeLike {
	fg(color: FooterColor, text: string): string;
}

/** Minimal structural view of the footer data provider. */
interface FooterDataLike {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
}

/** Minimal structural view of session entries the footer reads. */
interface SessionEntryLike {
	type: string;
	message?: { role?: string; usage?: UsageLike };
	usage?: UsageLike;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

const BAR_WIDTH = 10;

// ── formatting helpers ────────────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Check if the git worktree at `cwd` is dirty.
 * Cached briefly so a footer render never shells out more than once per
 * few seconds (merged from cc-status).
 */
const DIRTY_CACHE_MS = 3000;
let dirtyCache: { cwd: string; dirty: boolean; at: number } | undefined;

function isGitDirty(cwd: string): boolean {
	const now = Date.now();
	if (
		dirtyCache &&
		dirtyCache.cwd === cwd &&
		now - dirtyCache.at < DIRTY_CACHE_MS
	) {
		return dirtyCache.dirty;
	}
	let dirty = false;
	try {
		const out = execSync("git status --porcelain", {
			cwd,
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		dirty = out.trim().length > 0;
	} catch {
		dirty = false;
	}
	dirtyCache = { cwd, dirty, at: now };
	return dirty;
}

function usageColor(percent: number): FooterColor {
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "success";
}

// ── data helpers ──────────────────────────────────────────────────────────────

/** Usage carried by a session entry, if any (assistant, toolResult, compaction). */
function entryUsage(entry: SessionEntryLike): UsageLike | undefined {
	if (entry.type === "message") {
		const role = entry.message?.role;
		if (role === "assistant" || role === "toolResult")
			return entry.message?.usage;
		return undefined;
	}
	if (entry.type === "branch_summary" || entry.type === "compaction")
		return entry.usage;
	return undefined;
}

/** Sum usage across all session entries. */
function computeUsageTotals(entries: Iterable<SessionEntryLike>): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cost: 0 };
	for (const entry of entries) {
		const usage = entryUsage(entry);
		if (!usage) continue;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cost += usage.cost?.total ?? 0;
	}
	return totals;
}

// ── footer segments ───────────────────────────────────────────────────────────

function pwdLine(
	ctx: ExtensionContext,
	footerData: FooterDataLike,
	theme: ThemeLike,
	width: number,
): string {
	let pwd = theme.fg("warning", formatCwd(ctx.cwd));
	const branch = footerData.getGitBranch();
	if (branch) {
		const dirty = isGitDirty(ctx.cwd);
		let branchPart = ` (${branch})`;
		if (dirty) branchPart += "✗";
		pwd +=
			theme.fg("dim", branchPart.slice(0, 1)) +
			theme.fg(dirty ? "warning" : "dim", branchPart.slice(1));
	}
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) pwd += theme.fg("dim", ` · ${sessionName}`);
	return truncateToWidth(pwd, width, theme.fg("dim", "…"));
}

function contextMeter(
	theme: ThemeLike,
	context: ContextUsage | undefined,
	windowTokens: number,
): string {
	const percent = context?.percent ?? null;
	if (percent === null) {
		// Right after compaction, before the next LLM response.
		return theme.fg(
			"dim",
			`${"·".repeat(BAR_WIDTH)} ?/${formatTokens(windowTokens)}`,
		);
	}
	const filled = Math.max(
		1,
		Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)),
	);
	const color = usageColor(percent);
	return (
		theme.fg(color, "█".repeat(filled)) +
		theme.fg("dim", "░".repeat(BAR_WIDTH - filled)) +
		" " +
		theme.fg(color, `${percent.toFixed(0)}%`) +
		theme.fg("dim", `/${formatTokens(windowTokens)}`)
	);
}

function statsSegment(theme: ThemeLike, totals: UsageTotals): string[] {
	const parts: string[] = [];
	if (totals.input)
		parts.push(theme.fg("dim", `↑${formatTokens(totals.input)}`));
	if (totals.output)
		parts.push(theme.fg("dim", `↓${formatTokens(totals.output)}`));
	if (totals.cacheRead)
		parts.push(theme.fg("dim", `R${formatTokens(totals.cacheRead)}`));
	if (totals.cost) parts.push(theme.fg("dim", `$${totals.cost.toFixed(2)}`));
	return parts;
}

function thinkingSegment(
	theme: ThemeLike,
	model: { reasoning?: boolean } | undefined,
	level: ThinkingLevel,
): string | null {
	if (!model?.reasoning) return null;
	const icon = level === "off" ? "◇" : "🧠";
	return theme.fg(LEVEL_COLOR[level], `${icon} ${level}`);
}

function modelSegment(
	theme: ThemeLike,
	model:
		| { id: string; name?: string; provider?: string; reasoning?: boolean }
		| undefined,
	level: ThinkingLevel,
): string {
	const modelName = model?.name ?? model?.id ?? "no-model";
	const thinking = thinkingSegment(theme, model, level);
	if (!thinking) return modelName;
	return `${thinking} ${theme.fg("dim", "·")} ${modelName}`;
}

function extensionStatusLine(
	theme: ThemeLike,
	footerData: FooterDataLike,
	width: number,
): string | null {
	const statuses = footerData.getExtensionStatuses();
	if (statuses.size === 0) return null;
	const joined = Array.from(statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.join(" ");
	return truncateToWidth(joined, width, theme.fg("dim", "…"));
}

/** Right-align `right` against `left` on a single `width`-wide line. */
function composeLine(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + 2 + rightWidth <= width) {
		return left + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + right;
	}
	const availableForRight = width - leftWidth - 2;
	if (availableForRight <= 0) {
		return truncateToWidth(left, width, "…");
	}
	const truncated = truncateToWidth(right, availableForRight, "");
	const padding = Math.max(0, width - leftWidth - visibleWidth(truncated));
	return left + " ".repeat(padding) + truncated;
}

function renderFooterLines(
	ctx: ExtensionContext,
	theme: ThemeLike,
	footerData: FooterDataLike,
	width: number,
): string[] {
	const model = ctx.model;
	const context = ctx.getContextUsage();
	const windowTokens = context?.contextWindow ?? model?.contextWindow ?? 0;
	const level = (ctx.thinkingLevel ?? "off") as ThinkingLevel;

	const left = [
		...statsSegment(theme, computeUsageTotals(ctx.sessionManager.getEntries())),
		contextMeter(theme, context, windowTokens),
	].join(" ");

	let right = modelSegment(theme, model, level);
	if (model && footerData.getAvailableProviderCount() > 1) {
		const withProvider = `${theme.fg("dim", `(${model.provider})`)} ${right}`;
		if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) {
			right = withProvider;
		}
	}

	const lines = [
		pwdLine(ctx, footerData, theme, width),
		composeLine(left, right, width),
	];
	const statusLine = extensionStatusLine(theme, footerData, width);
	if (statusLine) lines.push(statusLine);
	return lines;
}

// ── extension wiring ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let requestRerender: (() => void) | undefined;

	function install(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRerender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render: (width: number) => renderFooterLines(ctx, theme, footerData, width),
			};
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui" && enabled) install(ctx);
	});

	// Request a repaint when state changes while otherwise idle.
	pi.on("model_select", () => requestRerender?.());
	pi.on("thinking_level_select", () => requestRerender?.());
	pi.on("session_info_changed", () => requestRerender?.());
	pi.on("message_end", (_event, ctx) => {
		if (ctx.mode === "tui") requestRerender?.();
	});
	pi.registerCommand("statusbar", {
		description: "Toggle the Codex-style status bar footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (ctx.mode !== "tui") return;
			if (enabled) {
				install(ctx);
				ctx.ui.notify("Status bar enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
