/**
 * Codex / Claude Code style status bar for pi.
 *
 * Replaces the built-in footer with:
 *
 *   # wsz @ cn096 in ~/project on git:main✗                            ← prompt-style line (bright colors)
 *   ↑1.2k ↓30k R89% W2k CH95.0% ██░░░░░░░░ 27%/900k    high · glm-5.3 (tai)
 *   <other extensions' ctx.ui.setStatus() texts preserved>          ← only if any
 *
 * Prompt line colors (bright, for readability):
 *   user = bright cyan, host = bright green, path = bright yellow,
 *   git branch = #00ffff (xterm-256 color 51).
 *
 * - git branch shows ✗ (warning color) when the worktree is dirty.
 * - Stats line is a superset of the built-in footer: input/output,
 *   cache read (R), cache write (W), cache hit rate (CH), context meter
 *   with "(auto)" auto-compaction indicator, and "xp" when
 *   PI_EXPERIMENTAL=1. (Cost display intentionally omitted.)
 * - Thinking level (plain text, no emoji) uses the theme's per-level color
 *   and updates live: shift+tab cycling, /model switches, session restore.
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
	cacheWrite: number;
}

const BAR_WIDTH = 10;

// ── bright ANSI colors for the prompt line ───────────────────────────────────

const ANSI = {
	cyan: "\x1b[96m",
	green: "\x1b[92m",
	yellow: "\x1b[93m",
	// xterm-256 color 51 is exactly #00ffff; works on truecolor terminals too.
	blue: "\x1b[38;5;51m",
	reset: "\x1b[0m",
};
const bright = (code: string, text: string) => code + text + ANSI.reset;

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

function usageColor(percent: number): FooterColor {
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "success";
}

// ── git dirty check (from cc-status, cached) ──────────────────────────────────

const DIRTY_CACHE_MS = 3000;
let dirtyCache: { cwd: string; dirty: boolean; at: number } | undefined;

function isGitDirty(cwd: string): boolean {
	const now = Date.now();
	if (dirtyCache && dirtyCache.cwd === cwd && now - dirtyCache.at < DIRTY_CACHE_MS) {
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

// ── settings probes (best-effort, read once) ─────────────────────────────────

function readAutoCompactionEnabled(): boolean {
	// Same source the built-in footer uses (settingsManager); extensions
	// cannot reach it directly, so read the settings files. Default: on.
	const candidates = [
		path.join(os.homedir(), ".pi", "settings.json"),
		path.join(process.cwd(), ".pi", "settings.json"),
	];
	for (const file of candidates) {
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			if (typeof raw.autoCompaction === "boolean") return raw.autoCompaction;
		} catch {
			// missing or invalid — try the next candidate
		}
	}
	return true;
}

// ── data helpers ──────────────────────────────────────────────────────────────

/** Usage carried by a session entry, if any (assistant, toolResult, compaction). */
function entryUsage(entry: SessionEntryLike): UsageLike | undefined {
	if (entry.type === "message") {
		const role = entry.message?.role;
		if (role === "assistant" || role === "toolResult") return entry.message?.usage;
		return undefined;
	}
	if (entry.type === "branch_summary" || entry.type === "compaction")
		return entry.usage;
	return undefined;
}

/** Sum usage + latest cache hit rate across all session entries. */
function computeUsage(
	entries: Iterable<SessionEntryLike>,
): { totals: UsageTotals; cacheHitRate: number | undefined } {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	let cacheHitRate: number | undefined;
	for (const entry of entries) {
		const usage = entryUsage(entry);
		if (!usage) continue;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const prompt =
				(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			if (prompt > 0) cacheHitRate = ((usage.cacheRead ?? 0) / prompt) * 100;
		}
	}
	return { totals, cacheHitRate };
}

// ── footer segments ───────────────────────────────────────────────────────────

function promptLine(
	ctx: ExtensionContext,
	footerData: FooterDataLike,
	theme: ThemeLike,
	width: number,
): string {
	let line =
		theme.fg("dim", "# ") +
		bright(ANSI.cyan, os.userInfo().username) +
		theme.fg("dim", " @ ") +
		bright(ANSI.green, os.hostname()) +
		theme.fg("dim", " in ") +
		bright(ANSI.yellow, formatCwd(ctx.cwd));

	const branch = footerData.getGitBranch();
	if (branch) {
		const dirty = isGitDirty(ctx.cwd);
		line +=
			theme.fg("dim", " on git:") +
			bright(ANSI.blue, branch) +
			(dirty ? theme.fg("warning", "✗") : "");
	}

	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) line += theme.fg("dim", ` · ${sessionName}`);

	return truncateToWidth(line, width, theme.fg("dim", "…"));
}

function contextMeter(
	theme: ThemeLike,
	context: ContextUsage | undefined,
	windowTokens: number,
	autoCompact: boolean,
): string {
	const autoIndicator = autoCompact ? " (auto)" : "";
	const percent = context?.percent ?? null;
	if (percent === null) {
		// Right after compaction, before the next LLM response.
		return theme.fg(
			"dim",
			`${"·".repeat(BAR_WIDTH)} ?/${formatTokens(windowTokens)}${autoIndicator}`,
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
		theme.fg("dim", `/${formatTokens(windowTokens)}${autoIndicator}`)
	);
}

function statsSegment(
	theme: ThemeLike,
	totals: UsageTotals,
	cacheHitRate: number | undefined,
): string[] {
	const parts: string[] = [];
	if (totals.input) parts.push(theme.fg("dim", `↑${formatTokens(totals.input)}`));
	if (totals.output) parts.push(theme.fg("dim", `↓${formatTokens(totals.output)}`));
	if (totals.cacheRead) parts.push(theme.fg("dim", `R${formatTokens(totals.cacheRead)}`));
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && cacheHitRate !== undefined) {
		parts.push(theme.fg("dim", `CH${cacheHitRate.toFixed(1)}%`));
	}
	return parts;
}

function thinkingSegment(
	theme: ThemeLike,
	model: { reasoning?: boolean } | undefined,
	level: ThinkingLevel,
): string | null {
	if (!model?.reasoning) return null;
	return theme.fg(LEVEL_COLOR[level], level);
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

	const { totals, cacheHitRate } = computeUsage(
		ctx.sessionManager.getEntries(),
	);

	const left = [
		...statsSegment(theme, totals, cacheHitRate),
		contextMeter(theme, context, windowTokens, autoCompactEnabled),
	].join(" ");

	let right = modelSegment(theme, model, level);
	if (model && footerData.getAvailableProviderCount() > 1) {
		const withProvider = `${theme.fg("dim", `(${model.provider})`)} ${right}`;
		if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) {
			right = withProvider;
		}
	}

	const lines = [
		promptLine(ctx, footerData, theme, width),
		composeLine(left, right, width),
	];
	if (process.env.PI_EXPERIMENTAL === "1") {
		lines.push(theme.bold(theme.fg("warning", "xp")));
	}
	const statusLine = extensionStatusLine(theme, footerData, width);
	if (statusLine) lines.push(statusLine);
	return lines;
}

// ── extension wiring ──────────────────────────────────────────────────────────

let autoCompactEnabled = true;

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let requestRerender: (() => void) | undefined;

	function install(ctx: ExtensionContext) {
		autoCompactEnabled = readAutoCompactionEnabled();
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRerender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => requestRerender?.());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render: (width: number) =>
					renderFooterLines(ctx, theme, footerData, width),
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
	pi.on("message_start", (_event, ctx) => {
		if (ctx.mode === "tui") requestRerender?.();
	});
	pi.on("message_end", (_event, ctx) => {
		if (ctx.mode === "tui") requestRerender?.();
	});
	pi.on("turn_end", (_event, ctx) => {
		if (ctx.mode === "tui") requestRerender?.();
	});
	pi.on("tool_call_end", (_event, ctx) => {
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
