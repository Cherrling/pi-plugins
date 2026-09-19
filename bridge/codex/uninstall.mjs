#!/usr/bin/env node
/**
 * bridge/codex/uninstall.mjs — remove exactly what install.mjs added.
 * User hooks/instructions/config entries that were not ours are untouched.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const MAILBOX_DIR = process.env.MAILBOX_DIR || path.join(os.homedir(), ".pi", "agent", "mailbox");
const BRIDGE = process.env.MAILBOX_BRIDGE || path.join(os.homedir(), ".pi", "agent", "mailbox-bridge");
const CLI = path.join(BRIDGE, "bin", "mailbox-cli.mjs");
const BIN_DIR = path.join(os.homedir(), ".local", "bin");

// 1. hooks.json: drop entries whose command references our CLI
const hooksPath = path.join(CODEX_HOME, "hooks.json");
if (fs.existsSync(hooksPath)) {
	try {
		const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
		let removed = 0;
		for (const ev of Object.keys(hooks.hooks || {})) {
			const before = hooks.hooks[ev].length;
			hooks.hooks[ev] = hooks.hooks[ev].filter(
				(g) => !(g.hooks || []).some((h) => typeof h.command === "string" && h.command.includes(CLI)),
			);
			if (hooks.hooks[ev].length === 0) delete hooks.hooks[ev];
			removed += before - hooks.hooks[ev]?.length ?? 0;
		}
		if (Object.keys(hooks.hooks || {}).length === 0) {
			fs.rmSync(hooksPath);
			console.log("hooks.json removed (was mailbox-only)");
		} else {
			fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + "\n");
			console.log(`hooks.json: removed ${removed} mailbox entrie(s), user hooks kept`);
		}
	} catch (e) {
		console.error(`hooks.json not touched (parse error: ${e.message})`);
	}
}

// 2. AGENTS.md: strip the marker block
const agentsPath = path.join(CODEX_HOME, "AGENTS.md");
if (fs.existsSync(agentsPath)) {
	let s = fs.readFileSync(agentsPath, "utf8");
	const before = s.length;
	s = s
		.replace(/<!-- >>> mailbox >>> -->[\s\S]*?<!-- <<< mailbox <<< -->\n?/g, "")
		.replace(/\n{3,}/g, "\n\n");
	if (s.length !== before) {
		fs.writeFileSync(agentsPath, s);
		console.log("AGENTS.md: mailbox block removed");
	}
}

// 3. config.toml: drop the mailbox path from writable_roots
const cfgPath = path.join(CODEX_HOME, "config.toml");
if (fs.existsSync(cfgPath)) {
	let cfg = fs.readFileSync(cfgPath, "utf8");
	const re = new RegExp(`,?\\s*"${MAILBOX_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
	const next = cfg.replace(re, "");
	if (next !== cfg) {
		fs.writeFileSync(cfgPath, next);
		console.log("config.toml: mailbox writable_root removed");
	}
}

// 4. shim (only if it is ours)
const shim = path.join(BIN_DIR, "mailbox");
if (fs.existsSync(shim)) {
	const cur = fs.readFileSync(shim, "utf8");
	if (cur.includes(CLI) || cur.includes(BRIDGE)) {
		fs.rmSync(shim);
		console.log("shim removed");
	}
}

// 5. bridge dir (mailbox DATA dir is never touched)
fs.rmSync(BRIDGE, { recursive: true, force: true });
console.log(`bridge removed: ${BRIDGE}`);
console.log("mailbox data preserved:", MAILBOX_DIR);
