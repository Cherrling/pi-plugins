#!/usr/bin/env node
/**
 * probe-rename.mjs — interactive rename e2e against a real codex app-server.
 *
 * Scenario (single codex, alias starts as default "codex"):
 *   1. intro turn        → SessionStart registers "codex", writes .names map
 *   2. send msg A to "codex" (unread)
 *   3. turn "rename"     → model runs `mailbox rename beta-worker`
 *                          → PostToolUse resolves alias VIA MAP → beta-worker
 *                          → msg A delivered through alias history (to=="codex")
 *   4. send msg B to "beta-worker"
 *   5. turn "who are you"→ model runs `mailbox whoami` → beta-worker;
 *                          Stop delivers msg B to beta-worker
 *
 * Asserts: map updated, old registration swapped, new registration carries the
 * LIVE codex host pid, both messages reached the model, whoami returned the
 * new name — all through the ancestor-chain identity resolution.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const INSTALL = path.join(ROOT, "bridge", "codex", "install.mjs");

const T = fs.mkdtempSync(path.join(os.tmpdir(), "rn-e2e-"));
const BOX = path.join(T, "mailbox");
const BRIDGE = path.join(T, "bridge");
const CODEX_HOME = path.join(T, "codex-home");
const LOGS = path.join(T, "logs");
fs.mkdirSync(LOGS, { recursive: true });

const report = { root: T, checks: {} };
const pass = (k, extra = {}) => {
	report.checks[k] = { status: "pass", ...extra };
	console.log(`PASS ${k}`);
};
const fail = (k, msg) => {
	report.checks[k] = { status: "fail", error: msg };
	console.log(`FAIL ${k}: ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLI = path.join(BRIDGE, "bin", "mailbox-cli.mjs");
function cli(args) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		env: { ...process.env, MAILBOX_DIR: BOX },
		encoding: "utf8",
	});
	if (r.status !== 0) throw new Error(`cli ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}
const readReqs = () =>
	fs.existsSync(path.join(LOGS, "model.jsonl"))
		? fs.readFileSync(path.join(LOGS, "model.jsonl"), "utf8").split("\n").filter((l) => l).map((l) => JSON.parse(l))
		: [];

// install (isolated)
const inst = spawnSync(process.execPath, [INSTALL, "--no-bin"], {
	env: { ...process.env, CODEX_HOME, MAILBOX_DIR: BOX, MAILBOX_BRIDGE: BRIDGE },
	encoding: "utf8",
});
if (inst.status !== 0) {
	fail("install", inst.stderr);
	process.exit(1);
}
pass("install");

// mock model
const srv = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		let j = {};
		try {
			j = JSON.parse(body);
		} catch {}
		fs.appendFileSync(path.join(LOGS, "model.jsonl"), JSON.stringify({ t: Date.now(), body: j }) + "\n");
		const input = j.input || [];
		const text = JSON.stringify(input);
		const hasToolResult = input.some((i) => i.type === "function_call_output");
		const tool = (args) => [
			{
				type: "function_call",
				id: `fc_${Date.now()}`,
				call_id: `call_${Date.now()}`,
				name: "exec_command",
				arguments: JSON.stringify(args),
			},
		];
		let output;
		// marker-guarded (history contains tool results from earlier turns)
		if (text.includes("rename yourself") && !text.includes("RN-RENAMED")) {
			output = tool({ cmd: `MAILBOX_DIR=${BOX} ${process.execPath} ${CLI} rename beta-worker && echo RN-RENAMED` });
		} else if (text.includes("who are you") && !text.includes("RN-WHOAMI")) {
			output = tool({ cmd: `MAILBOX_DIR=${BOX} ${process.execPath} ${CLI} whoami && MAILBOX_DIR=${BOX} ${process.execPath} ${CLI} send alice "post-rename reply from the renamed session" && echo RN-WHOAMI` });
		} else if (!hasToolResult) {
			output = tool({ cmd: "echo rn-probe" });
		} else {
			output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "RN-DONE" }] }];
		}
		const resp = {
			id: `resp_${Date.now()}`,
			object: "response",
			created_at: Math.floor(Date.now() / 1000),
			status: "completed",
			model: j.model || "mock",
			output,
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		};
		if (j.stream) {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const ev = (n, d) => res.write(`event: ${n}\ndata: ${JSON.stringify(d)}\n\n`);
			ev("response.created", { type: "response.created", response: { ...resp, status: "in_progress", output: [] } });
			for (const item of output) ev("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
			ev("response.completed", { type: "response.completed", response: resp });
			res.write("data: [DONE]\n\n");
			res.end();
		} else {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(resp));
		}
	});
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
fs.writeFileSync(
	path.join(CODEX_HOME, "config.toml"),
	`model = "mock-model"
model_provider = "m"

[model_providers.m]
name = "m"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "MK"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[sandbox_workspace_write]
writable_roots = ["${BOX}"]
`,
);

// codex app-server — NO CODEX_SESSION_NAME: alias must default to "codex"
const child = spawn("codex", ["app-server"], {
	cwd: T,
	env: { ...process.env, CODEX_HOME, MAILBOX_DIR: BOX, MK: "x" },
	stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.pipe(fs.createWriteStream(path.join(LOGS, "codex.stderr"), { flags: "a" }));
const pending = new Map();
let seq = 0;
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const l = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!l) continue;
		let m;
		try {
			m = JSON.parse(l);
		} catch {
			continue;
		}
		if (m.id && pending.has(m.id)) {
			pending.get(m.id)(m);
			pending.delete(m.id);
		}
	}
});
function request(method, params, timeoutMs = 60_000) {
	const id = ++seq;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
		pending.set(id, (m) => {
			clearTimeout(timer);
			if (m.error) reject(new Error(JSON.stringify(m.error)));
			else resolve(m.result);
		});
		child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
	});
}
async function turn(threadId, text, timeoutMs = 120_000) {
	const before = readReqs().length;
	await request("turn/start", { threadId, input: [{ type: "text", text }] });
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		await sleep(500);
		const n = readReqs().length;
		if (n > before) {
			await sleep(1500);
			if (readReqs().length === n) return;
		}
	}
	throw new Error(`turn did not settle: ${text}`);
}

try {
	await request("initialize", {
		clientInfo: { name: "rn", version: "0.1" },
		capabilities: { experimentalApi: true },
	});
	child.stdin.write('{"method":"initialized"}\n');
	const started = await request("thread/start", {
		cwd: T,
		approvalPolicy: "never",
		sandbox: "workspace-write",
		sessionStartSource: "startup",
		config: { bypass_hook_trust: true },
	});
	const threadId = started.thread.id;
	const sessionId = started.thread.sessionId || threadId;
	report.sessionId = sessionId;

	await turn(threadId, "introduce");
	// registration + map written under default alias
	if (fs.existsSync(path.join(BOX, "sessions", "codex.json"))) pass("initial-registration");
	else fail("initial-registration", "sessions/codex.json missing");
	const maps = fs.readdirSync(path.join(BOX, ".names"));
	const map = JSON.parse(fs.readFileSync(path.join(BOX, ".names", maps[0]), "utf8"));
	if (map.alias === "codex" && map.hostPid) pass("name-map-written", { hostPid: map.hostPid });
	else fail("name-map-written", JSON.stringify(map));

	// unread message to the OLD name
	cli(["send", "--as", "alice", "codex", "msg A before rename"]);

	// rename turn
	await turn(threadId, "rename yourself");
	const modelText = JSON.stringify(readReqs().map((r) => r.body.input));
	if (modelText.includes("msg A before rename"))
		pass("unread-followed-rename", { note: "delivered via alias history after map switch" });
	else fail("unread-followed-rename", "model never saw msg A");
	const map2 = JSON.parse(fs.readFileSync(path.join(BOX, ".names", maps[0]), "utf8"));
	if (map2.alias === "beta-worker") pass("map-updated");
	else fail("map-updated", JSON.stringify(map2));
	if (!fs.existsSync(path.join(BOX, "sessions", "beta-worker.json")))
		fail("new-registration", "sessions/beta-worker.json missing");
	else {
		const reg = JSON.parse(fs.readFileSync(path.join(BOX, "sessions", "beta-worker.json"), "utf8"));
		const hostAlive = spawnSync("kill", ["-0", String(reg.pid)]).status === 0;
		if (reg.pid === map.hostPid && hostAlive)
			pass("new-registration", { pid: reg.pid, note: "live codex host pid" });
		else fail("new-registration", `pid=${reg.pid} mapHost=${map.hostPid} alive=${hostAlive}`);
	}
	// old name released as a tombstone: present on disk (era boundary for the
	// next taker) but NOT a live registration
	const tombPath = path.join(BOX, "sessions", "codex.json");
	let tombOk = false;
	try {
		const t = JSON.parse(fs.readFileSync(tombPath, "utf8"));
		tombOk = t.released === true && t.pid === 0;
	} catch {}
	const listed = spawnSync(process.execPath, [CLI, "list"], {
		env: { ...process.env, MAILBOX_DIR: BOX },
		encoding: "utf8",
	}).stdout;
	if (tombOk && !listed.includes('"codex"'))
		pass("old-registration-tombstoned", { note: "released on disk, hidden from list" });
	else fail("old-registration-tombstoned", `tombOk=${tombOk} listed=${listed.slice(0, 200)}`);

	// message to the NEW name + whoami turn (alice must be addressable too)
	cli(["register", "--kind", "pi", "--name", "alice"]);
	cli(["send", "--as", "alice", "beta-worker", "msg B after rename"]);
	await turn(threadId, "who are you");
	const modelText2 = JSON.stringify(readReqs().map((r) => r.body.input));
	if (modelText2.includes("msg B after rename")) pass("new-name-delivery");
	else fail("new-name-delivery", "model never saw msg B");
	// whoami tool result in the conversation must say beta-worker
	if (modelText2.includes('"alias":"beta-worker"') || modelText2.includes('\\"alias\\":\\"beta-worker\\"'))
		pass("whoami-new-alias");
	else fail("whoami-new-alias", "whoami result not found in model input");
	// post-rename SEND must use the new identity (review R1)
	const betaLog = fs.existsSync(path.join(BOX, "log-beta-worker.jsonl"))
		? fs.readFileSync(path.join(BOX, "log-beta-worker.jsonl"), "utf8")
		: "";
	if (betaLog.includes('"from":"beta-worker"') && betaLog.includes("post-rename reply"))
		pass("post-rename-send-identity");
	else fail("post-rename-send-identity", `log-beta-worker: ${betaLog.slice(0, 200)}`);
} catch (e) {
	fail("scenario", String(e.message || e));
} finally {
	child.kill("SIGKILL");
	srv.close();
	report.codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim();
	fs.writeFileSync(path.join(T, "report.json"), JSON.stringify(report, null, 2));
	const failed = Object.values(report.checks).filter((c) => c.status === "fail").length;
	console.log(`\nresults: ${T}`);
	console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
}
