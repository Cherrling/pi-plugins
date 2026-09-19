#!/usr/bin/env node
/**
 * test-m2-install.mjs — installer merge-safety unit tests (isolated dirs).
 * Verifies: never clobbers existing hooks/instructions/config; idempotent
 * re-install; uninstall removes exactly our additions.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const INSTALL = path.join(ROOT, "bridge", "codex", "install.mjs");
const UNINSTALL = path.join(ROOT, "bridge", "codex", "uninstall.mjs");

const results = [];
function run(name, fn) {
	results.push([name, fn]);
}
function sh(script, args, env) {
	return spawnSync(process.execPath, [script, ...args], {
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
}
const j = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

function freshEnv() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `m2inst-`));
	return {
		tmp,
		env: {
			CODEX_HOME: path.join(tmp, "codex"),
			MAILBOX_DIR: path.join(tmp, "mailbox"),
			MAILBOX_BRIDGE: path.join(tmp, "bridge"),
		},
	};
}

run("fresh-install", () => {
	const { env } = freshEnv();
	const r = sh(INSTALL, ["--no-bin"], env);
	if (r.status !== 0) throw new Error(r.stderr);
	const hooks = j(path.join(env.CODEX_HOME, "hooks.json"));
	for (const ev of ["SessionStart", "PostToolUse", "Stop"])
		if (!hooks.hooks[ev]?.[0]?.hooks?.[0]?.command?.includes("mailbox-cli"))
			throw new Error(`missing ${ev} hook`);
	const agents = fs.readFileSync(path.join(env.CODEX_HOME, "AGENTS.md"), "utf8");
	if (!agents.includes(">>> mailbox >>>")) throw new Error("missing AGENTS block");
	const cfg = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
	if (!cfg.includes(`writable_roots = ["${env.MAILBOX_DIR}"]`)) throw new Error("missing writable_root");
});

run("merge-existing-hooks", () => {
	const { tmp, env } = freshEnv();
	fs.mkdirSync(env.CODEX_HOME, { recursive: true });
	fs.writeFileSync(
		path.join(env.CODEX_HOME, "hooks.json"),
		JSON.stringify({
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "echo user-hook" }] }],
				UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo other" }] }],
			},
		}),
	);
	const r = sh(INSTALL, ["--no-bin"], env);
	if (r.status !== 0) throw new Error(r.stderr);
	const hooks = j(path.join(env.CODEX_HOME, "hooks.json"));
	if (hooks.hooks.SessionStart.length !== 2) throw new Error("user SessionStart hook lost");
	if (hooks.hooks.SessionStart[0].hooks[0].command !== "echo user-hook") throw new Error("user hook reordered/clobbered");
	if (!hooks.hooks.UserPromptSubmit) throw new Error("unrelated event lost");
	if (!fs.existsSync(path.join(env.CODEX_HOME, "hooks.json.mailboxbak-"))) {
		// backup naming has ts suffix; just check any backup exists
		const baks = fs.readdirSync(env.CODEX_HOME).filter((f) => f.includes("mailboxbak"));
		if (baks.length === 0) throw new Error("no backup created");
	}
});

run("merge-existing-agents", () => {
	const { env } = freshEnv();
	fs.mkdirSync(env.CODEX_HOME, { recursive: true });
	fs.writeFileSync(path.join(env.CODEX_HOME, "AGENTS.md"), "# My rules\n\n- always use conventional commits\n");
	const r = sh(INSTALL, ["--no-bin"], env);
	if (r.status !== 0) throw new Error(r.stderr);
	const s = fs.readFileSync(path.join(env.CODEX_HOME, "AGENTS.md"), "utf8");
	if (!s.includes("# My rules") || !s.includes("conventional commits")) throw new Error("user instructions lost");
	if (!s.includes(">>> mailbox >>>")) throw new Error("mailbox block missing");
	// re-install: refresh block, no duplication
	const r2 = sh(INSTALL, ["--no-bin"], env);
	if (r2.status !== 0) throw new Error(r2.stderr);
	const s2 = fs.readFileSync(path.join(env.CODEX_HOME, "AGENTS.md"), "utf8");
	if ((s2.match(/>>> mailbox >>>/g) || []).length !== 1) throw new Error("block duplicated on re-install");
});

run("merge-config-variants", () => {
	// variant A: existing table with existing writable_roots
	{
		const { env } = freshEnv();
		fs.mkdirSync(env.CODEX_HOME, { recursive: true });
		fs.writeFileSync(
			path.join(env.CODEX_HOME, "config.toml"),
			`model = "gpt-5"\n\n[sandbox_workspace_write]\nwritable_roots = ["/tmp/other"]\n\n[other_section]\nkey = 1\n`,
		);
		const r = sh(INSTALL, ["--no-bin"], env);
		if (r.status !== 0) throw new Error(r.stderr);
		const cfg = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
		if (!cfg.includes('"/tmp/other"')) throw new Error("existing root lost");
		if (!cfg.includes(`"${env.MAILBOX_DIR}"`)) throw new Error("mailbox root not added");
		if ((cfg.match(/\[sandbox_workspace_write\]/g) || []).length !== 1) throw new Error("duplicate table!");
		if (!cfg.includes("[other_section]")) throw new Error("other section lost");
	}
	// variant B: table present, no writable_roots key
	{
		const { env } = freshEnv();
		fs.mkdirSync(env.CODEX_HOME, { recursive: true });
		fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), `[sandbox_workspace_write]\nnetwork_access = false\n`);
		const r = sh(INSTALL, ["--no-bin"], env);
		if (r.status !== 0) throw new Error(r.stderr);
		const cfg = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
		if (!cfg.includes("network_access = false")) throw new Error("existing key lost");
		if (!cfg.includes(`"${env.MAILBOX_DIR}"`)) throw new Error("mailbox root not inserted");
	}
	// validate TOML actually parses (python tomllib)
	{
		const { env } = freshEnv();
		fs.mkdirSync(env.CODEX_HOME, { recursive: true });
		fs.writeFileSync(
			path.join(env.CODEX_HOME, "config.toml"),
			`[sandbox_workspace_write]\nwritable_roots = ["/a", "/b"]\n`,
		);
		sh(INSTALL, ["--no-bin"], env);
		const py = spawnSync(
			"python3",
			["-c", `import tomllib,sys;d=tomllib.load(open(sys.argv[1],'rb'));print(d["sandbox_workspace_write"]["writable_roots"])`, path.join(env.CODEX_HOME, "config.toml")],
			{ encoding: "utf8" },
		);
		if (py.status !== 0) throw new Error(`generated TOML invalid: ${py.stderr}`);
		const roots = JSON.parse(py.stdout.replace(/'/g, '"'));
		if (!roots.includes("/a") || !roots.includes("/b") || !roots.includes(env.MAILBOX_DIR))
			throw new Error(`roots wrong: ${py.stdout.trim()}`);
	}
});

run("uninstall-surgical", () => {
	const { env } = freshEnv();
	fs.mkdirSync(env.CODEX_HOME, { recursive: true });
	fs.writeFileSync(
		path.join(env.CODEX_HOME, "hooks.json"),
		JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] } }),
	);
	fs.writeFileSync(path.join(env.CODEX_HOME, "AGENTS.md"), "# mine\n\nbody\n");
	fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), `[sandbox_workspace_write]\nwritable_roots = ["/keep"]\n`);
	sh(INSTALL, ["--no-bin"], env);
	const r = sh(UNINSTALL, [], env);
	if (r.status !== 0) throw new Error(r.stderr);
	const hooks = j(path.join(env.CODEX_HOME, "hooks.json"));
	if (hooks.hooks.Stop?.[0]?.hooks?.[0]?.command !== "echo keep-me") throw new Error("user Stop hook lost");
	if (hooks.hooks.SessionStart || hooks.hooks.PostToolUse) throw new Error("mailbox hooks not removed");
	const agents = fs.readFileSync(path.join(env.CODEX_HOME, "AGENTS.md"), "utf8");
	if (!agents.includes("# mine") || agents.includes(">>> mailbox >>>")) throw new Error("AGENTS rollback wrong");
	const cfg = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
	if (!cfg.includes('"/keep"') || cfg.includes(env.MAILBOX_DIR)) throw new Error("config rollback wrong");
	if (fs.existsSync(env.MAILBOX_BRIDGE)) throw new Error("bridge dir not removed");
	if (fs.existsSync(env.MAILBOX_DIR)) throw new Error("mailbox DATA dir must never be removed");
});

let failed = 0;
for (const [name, fn] of results) {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (e) {
		failed++;
		console.log(`FAIL ${name}: ${e.message}`);
	}
}
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
