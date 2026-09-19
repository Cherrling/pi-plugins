#!/usr/bin/env node
/**
 * bridge/codex/install.mjs — wire mailbox into Codex CLI.
 *
 * MERGES into existing user config — never clobbers:
 *   1. ~/.codex/hooks.json      → append our SessionStart/PostToolUse/Stop
 *                                 entries (dedup by command marker; existing
 *                                 user hooks for the same events are kept)
 *   2. ~/.codex/AGENTS.md       → marker block (idempotent replace)
 *   3. ~/.codex/config.toml     → add mailbox dir to
 *                                 [sandbox_workspace_write].writable_roots
 *                                 (handles: table missing / present without
 *                                 the key / key present without our path;
 *                                 NEVER declares a duplicate TOML table)
 *   4. ~/.local/bin/mailbox     → shim to the CLI (skipped if occupied by
 *                                 something else; --no-bin to skip)
 *
 * Backups: every touched file is copied to <file>.mailboxbak-<ts> first.
 * Rollback: uninstall.mjs removes exactly our additions; or restore backups.
 *
 * Env overrides (for isolated testing):
 *   CODEX_HOME   (default ~/.codex)
 *   MAILBOX_DIR  (default ~/.pi/agent/mailbox)
 *   MAILBOX_BRIDGE (default ~/.pi/agent/mailbox-bridge) — where CLI+shared are copied
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const opts = {
	noBin: args.includes("--no-bin"),
	force: args.includes("--force"),
};
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const MAILBOX_DIR = process.env.MAILBOX_DIR || path.join(os.homedir(), ".pi", "agent", "mailbox");
const BRIDGE = process.env.MAILBOX_BRIDGE || path.join(os.homedir(), ".pi", "agent", "mailbox-bridge");
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const BIN_DIR = path.join(os.homedir(), ".local", "bin");
const NODE = process.execPath;

const ts = Date.now();
const log = (m) => console.log(m);
const backup = (p) => {
	if (!fs.existsSync(p)) return null;
	const b = `${p}.mailboxbak-${ts}`;
	fs.copyFileSync(p, b);
	return b;
};

// ── 0. copy the bridge (self-contained: cli + shared) ──────────
fs.rmSync(BRIDGE, { recursive: true, force: true });
// layout mirrors the repo: bin/mailbox-cli.mjs + shared/mailbox/*.mjs,
// so the CLI's "../shared/mailbox/core.mjs" import resolves identically
fs.mkdirSync(path.join(BRIDGE, "bin"), { recursive: true });
fs.mkdirSync(path.join(BRIDGE, "shared", "mailbox"), { recursive: true });
fs.copyFileSync(path.join(REPO, "bridge", "mailbox-cli.mjs"), path.join(BRIDGE, "bin", "mailbox-cli.mjs"));
for (const f of fs.readdirSync(path.join(REPO, "shared", "mailbox"))) {
	if (f.endsWith(".mjs"))
		fs.copyFileSync(path.join(REPO, "shared", "mailbox", f), path.join(BRIDGE, "shared", "mailbox", f));
}
log(`[1/4] bridge installed: ${BRIDGE}`);

const CLI = path.join(BRIDGE, "bin", "mailbox-cli.mjs");

// ── 1. hooks.json (merge, dedup by our command marker) ─────────
fs.mkdirSync(CODEX_HOME, { recursive: true });
const hooksPath = path.join(CODEX_HOME, "hooks.json");
let hooks = {};
if (fs.existsSync(hooksPath)) {
	try {
		hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
	} catch (e) {
		console.error(`refusing: ${hooksPath} is not valid JSON (${e.message}) — fix it manually first`);
		process.exit(1);
	}
}
hooks.hooks = hooks.hooks || {};
const ours = {
	SessionStart: `${NODE} ${CLI} register --kind external --quiet`,
	PostToolUse: `${NODE} ${CLI} check --mode posttooluse`,
	Stop: `${NODE} ${CLI} check --mode stop`,
};
const hooksBak = backup(hooksPath);
for (const [event, command] of Object.entries(ours)) {
	const list = (hooks.hooks[event] = hooks.hooks[event] || []);
	const already = list.some(
		(g) => (g.hooks || []).some((h) => typeof h.command === "string" && h.command.includes(CLI)),
	);
	if (already && !opts.force) {
		log(`  hooks.${event}: already wired (kept)`);
		continue;
	}
	list.push({ hooks: [{ type: "command", command, timeout: 30 }] });
	log(`  hooks.${event}: wired`);
}
fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + "\n");
log(`[2/4] hooks.json merged${hooksBak ? ` (backup: ${path.basename(hooksBak)})` : " (new file)"}`);

// ── 2. AGENTS.md marker block ──────────────────────────────────
const agentsPath = path.join(CODEX_HOME, "AGENTS.md");
const BEGIN = "<!-- >>> mailbox >>> -->";
const END = "<!-- <<< mailbox <<< -->";
const block = `${BEGIN}
## 跨会话消息（mailbox）

其他 AI 会话（pi / codex）可以通过 mailbox 给你发消息或派任务。hooks 会在你干活时
自动注入消息，但空闲时不会唤醒你。使用规则：

- 查看收件箱：\`mailbox inbox\`
- 列在线会话：\`mailbox list\`（收件人用完整别名；歧义前缀会报错并列出候选）
- 发消息：\`mailbox send <别名> <文本>\`
- 派任务：\`mailbox dispatch <别名> <任务>\`（会得到 taskId）
- 回报任务：\`mailbox report <别名> <taskId> <结果>\`——收到 📋 任务消息后完成后必须回报
- 你的别名：\`mailbox whoami\`（默认 codex）
- 交互式改名：\`mailbox rename <新别名>\`——立即生效，未读消息跟随；多会话并跑时各自起不同名字
- 注入的消息带唯一 id，同 id 重复出现直接忽略（尽力投递可能重放）
- 长内容会被截断为附件引用，按消息里的路径读取全文
${END}`;
let agents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
const agentsBak = backup(agentsPath);
if (agents.includes(BEGIN)) {
	agents = agents.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`), block);
	log("  AGENTS.md: marker block refreshed");
} else {
	agents = agents.trimEnd() + (agents.trim() ? "\n\n" : "") + block + "\n";
	log("  AGENTS.md: marker block appended");
}
fs.writeFileSync(agentsPath, agents);
log(`[3/4] AGENTS.md updated${agentsBak ? ` (backup: ${path.basename(agentsBak)})` : " (new file)"}`);

// ── 3. config.toml writable_roots (merge, no duplicate tables) ─
const cfgPath = path.join(CODEX_HOME, "config.toml");
const cfgBak = backup(cfgPath);
let cfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "";
const TABLE = "[sandbox_workspace_write]";
const esc = q(MAILBOX_DIR);
if (cfg.includes(esc)) {
	log("  config.toml: writable_roots already contains mailbox");
} else {
	const hasTable = cfg
		.split("\n")
		.some((l) => l.trim() === TABLE || l.trim().startsWith(`${TABLE}#`));
	if (!hasTable) {
		cfg = cfg.trimEnd() + (cfg.trim() ? "\n\n" : "") + `${TABLE}\nwritable_roots = ["${MAILBOX_DIR}"]\n`;
		log("  config.toml: table added");
	} else {
		const lines = cfg.split("\n");
		let done = false;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() !== TABLE && !lines[i].trim().startsWith(`${TABLE}#`)) continue;
			// scan the table body until the next [section] or EOF
			for (let j = i + 1; j <= lines.length; j++) {
				const l = lines[j] ?? "";
				if (l.trim().startsWith("[") && !l.trim().startsWith("[[")) break; // wait: [[ is array-of-tables, also a boundary
				const m = l.match(/^(\s*writable_roots\s*=\s*)\[([^\]]*)\](.*)$/);
				if (m && !done) {
					const inner = m[2].trim();
					lines[j] = `${m[1]}[${inner ? inner + ", " : ""}"${MAILBOX_DIR}"]${m[3]}`;
					done = true;
				}
			}
			if (!done) {
				// table exists without writable_roots: insert right after the table line
				lines.splice(i + 1, 0, `writable_roots = ["${MAILBOX_DIR}"]`);
				done = true;
			}
			break;
		}
		cfg = lines.join("\n");
		log("  config.toml: writable_roots extended");
	}
	fs.writeFileSync(cfgPath, cfg);
}
log(`[4/4] config.toml done${cfgBak ? ` (backup: ${path.basename(cfgBak)})` : ""}`);

// ── 4. PATH shim ───────────────────────────────────────────────
if (!opts.noBin) {
	fs.mkdirSync(BIN_DIR, { recursive: true });
	const shim = path.join(BIN_DIR, "mailbox");
	if (fs.existsSync(shim)) {
		const cur = fs.readFileSync(shim, "utf8");
		if (!cur.includes(CLI)) log(`  skip shim: ${shim} exists and is not ours`);
		else {
			fs.writeFileSync(shim, shimSrc());
			log("  shim refreshed");
		}
	} else {
		fs.writeFileSync(shim, shimSrc());
		fs.chmodSync(shim, 0o755);
		log(`  shim: ${shim}`);
	}
}

function shimSrc() {
	return `#!/bin/sh
exec ${NODE} ${CLI} "$@"
`;
}
function q(s) {
	return /[^\w./-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

log("\ninstall complete. verify with:");
log(`  CODEX_SESSION_NAME=<别名> codex   # 启动后问它 "mailbox whoami"`);
log("rollback: node bridge/codex/uninstall.mjs  (or restore *.mailboxbak-* files)");
