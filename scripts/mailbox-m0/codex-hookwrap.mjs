#!/usr/bin/env node
/**
 * hookwrap.mjs — M0 codex hooks wrapper.
 * Logs the hook stdin JSON (event fields) with timestamps, then execs the
 * real mailbox-cli and forwards its stdout. This is the exact command codex
 * runs, so delivery behavior is the production path.
 *
 * usage: hookwrap.mjs <box> <logdir> <mode: register|posttooluse|stop>
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const [box, logdir, mode] = process.argv.slice(2);
const CLI = path.resolve(
	path.dirname(new URL(import.meta.url).pathname),
	"..",
	"..",
	"bridge",
	"mailbox-cli.mjs",
);

let stdin = "";
try {
	stdin = fs.readFileSync(0, "utf8");
} catch {}

const t0 = Date.now();
let parsed = null;
try {
	parsed = JSON.parse(stdin);
} catch {}

fs.appendFileSync(
	path.join(logdir, "hooks-log.jsonl"),
	JSON.stringify({ ts: t0, mode, input: parsed, rawLen: stdin.length }) + "\n",
);

const args =
	mode === "register"
		? ["register", "--name", "codex-test", "--kind", "external"]
		: ["check", "--mode", mode, "--as", "codex-test"];
const child = spawn(process.execPath, [CLI, ...args], {
	env: { ...process.env, MAILBOX_DIR: box },
	stdio: ["pipe", "pipe", "pipe"],
});
let childErr = "";
child.stderr.on("data", (d) => (childErr += d));
let childOut = "";
child.stdout.on("data", (d) => (childOut += d));
child.stdin.write(stdin || "{}");
child.stdin.end();
child.on("exit", (c) => {
	const ms = Date.now() - t0;
	fs.appendFileSync(
		path.join(logdir, "hook-perf.jsonl"),
		JSON.stringify({ mode, ms, exit: c, stderr: childErr.slice(0, 400) }) + "\n",
	);
	process.stdout.write(childOut);
	process.exit(c ?? 0);
});
