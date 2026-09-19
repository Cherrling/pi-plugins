#!/usr/bin/env node
/**
 * probe-codex.mjs — M0 ①②③④⑤ against the REAL codex app-server (0.153.x).
 *
 * Isolation: private CODEX_HOME, temp mailbox, mock model endpoint on
 * loopback. No credentials, no external service, no real mailbox writes.
 * Hooks trust is granted only for the wrapper generated in this temp dir.
 *
 * What it verifies:
 *  ① PostToolUse/Stop hook stdin fields (session_id, turn_id, stop_hook_active)
 *  ② idle retention: messages sent while no turn is running are NOT delivered
 *     until the next event (turn 2) — codex cannot be woken while idle
 *  ③ real consecutive Stop block behavior: cap 2 blocks per turn, remaining
 *     messages stay in the log, delivered on the next turn
 *  ④ hook invocation cost (wall time of our wrapper, incl. node startup)
 *  ⑤ sandbox writable_roots: the state watermark persists (no duplicate
 *     deliveries across hook invocations)
 *
 * Model mock: OpenAI-compatible chat completions (stream + non-stream).
 * Behavior: first request of a turn → one shell tool call; any request that
 * already carries a tool result or a hook continuation → final answer.
 * Every request body is logged so assertions can see exactly what the model
 * was shown (additionalContext / continuation prompts included).
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-m0-codex-"));
const BOX = path.join(ROOT, "box");
const LOGDIR = path.join(ROOT, "logs");
fs.mkdirSync(BOX, { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "bridge", "mailbox-cli.mjs");
const WRAP = path.join(path.dirname(new URL(import.meta.url).pathname), "codex-hookwrap.mjs");

const report = { root: ROOT, checks: {}, notes: [] };
const fail = (k, msg) => {
	report.checks[k] = { status: "fail", error: msg };
	console.log(`FAIL ${k}: ${msg}`);
};
const pass = (k, extra = {}) => {
	report.checks[k] = { status: "pass", ...extra };
	console.log(`PASS ${k}`);
};

// ── mock model server (Responses API — codex 0.153 only supports wire_api="responses") ──
const reqLog = path.join(LOGDIR, "model-requests.jsonl");
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		let j = {};
		try {
			j = JSON.parse(body);
		} catch {}
		fs.appendFileSync(reqLog, JSON.stringify({ url: req.url, body: j }) + "\n");
		const input = j.input || [];
		const hasToolResult = input.some(
			(i) => i.type === "function_call_output" || i.type === "tool_call_output" ||
				i.role === "tool" || i.role === "function",
		);
		const tools = j.tools || [];
		const toolName = (tools[0] && (tools[0].name || tools[0].function?.name)) || "shell";
		const output =
			!hasToolResult && tools.length > 0
				? [
						{
							type: "function_call",
							id: "fc_1",
							call_id: "call_1",
							name: toolName,
							arguments: JSON.stringify({ cmd: "echo mailbox-m0" }),
						},
					]
				: [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "M0-DONE" }],
						},
					];
		const resp = {
			id: `resp_${Date.now()}`,
			object: "response",
			created_at: Math.floor(Date.now() / 1000),
			status: "completed",
			model: j.model || "mock-model",
			output,
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		};
		if (j.stream) {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
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
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ── codex home ─────────────────────────────────────────────────
const codexHome = path.join(ROOT, "codex-home");
fs.mkdirSync(codexHome);
const hookCmd = (mode) =>
	JSON.stringify([process.execPath, WRAP, BOX, LOGDIR, mode].join(" ")).slice(1, -1).replace(/"/g, '\\"');
// simpler: single string command
const hookLine = (mode) => `${process.execPath} ${WRAP} ${BOX} ${LOGDIR} ${mode}`;
fs.writeFileSync(
	path.join(codexHome, "hooks.json"),
	JSON.stringify(
		{
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: hookLine("register") }] }],
				PostToolUse: [{ hooks: [{ type: "command", command: hookLine("posttooluse") }] }],
				Stop: [{ hooks: [{ type: "command", command: hookLine("stop") }] }],
			},
		},
		null,
		2,
	),
);
fs.writeFileSync(
	path.join(codexHome, "config.toml"),
	`model = "mock-model"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "workspace-write"

[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "MOCK_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[sandbox_workspace_write]
writable_roots = ["${BOX}"]
`,
);

// ── helpers ────────────────────────────────────────────────────
const sh = (args, env = {}) => {
	const r = spawnSyncNode(args, env);
	return r;
};
import { spawnSync as spawnSyncNode } from "node:child_process";
function cli(args, env = {}) {
	const r = spawnSyncNode(process.execPath, [CLI, ...args], {
		env: { ...process.env, MAILBOX_DIR: BOX, ...env },
		encoding: "utf8",
	});
	if (r.status !== 0) throw new Error(`cli: ${r.stderr}`);
	return r.stdout;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// app-server JSON-RPC
const child = spawn("codex", ["app-server"], {
	cwd: ROOT,
	env: {
		...process.env,
		CODEX_HOME: codexHome,
		MOCK_API_KEY: "mock",
		MAILBOX_DIR: BOX,
		MAILBOX_ALIAS: "codex-test",
	},
	stdio: ["pipe", "pipe", "pipe"],
});
const errW = fs.openSync(path.join(LOGDIR, "codex-stderr.log"), "w");
child.stderr.pipe(fs.createWriteStream(path.join(LOGDIR, "codex-stderr.log"), { flags: "a" }));
const pending = new Map();
let seq = 0;
const lines = [];
child.stdout.setEncoding("utf8");
let buf = "";
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
		lines.push(m);
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
async function waitTurnComplete(threadId, timeoutMs = 120_000) {
	// Robust settle detection: poll thread/read; the turn is done when the
	// serialized thread stops changing for 3 consecutive polls AND at least
	// one Stop hook has fired since this call started (Stop fires at turn
	// end; with blocks it fires repeatedly until the cap allows the stop).
	const stopCount0 = countHookLog("stop");
	let prev = "";
	let stable = 0;
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const r = await request("thread/read", { threadId }, 10_000).catch(() => null);
		const cur = JSON.stringify(r);
		if (cur === prev && cur.length > 100 && countHookLog("stop") > stopCount0) {
			stable++;
			if (stable >= 3) return "settled";
		} else stable = 0;
		prev = cur;
		await sleep(400);
	}
	throw new Error("turn did not complete in time");
}
function countHookLog(mode) {
	const p = path.join(LOGDIR, "hooks-log.jsonl");
	if (!fs.existsSync(p)) return 0;
	return fs
		.readFileSync(p, "utf8")
		.split("\n")
		.filter((l) => l && JSON.parse(l).mode === mode).length;
}

// ── scenario ───────────────────────────────────────────────────
try {
	await request("initialize", {
		clientInfo: { name: "mailbox_m0_codex", version: "0.1.0" },
		capabilities: { experimentalApi: true },
	});
	child.stdin.write('{"method":"initialized"}\n');

	const started = await request("thread/start", {
		cwd: ROOT,
		approvalPolicy: "never",
		sandbox: "workspace-write",
		sessionStartSource: "startup",
		config: { bypass_hook_trust: true },
	});
	const threadId = started.thread.id;
	report.threadId = threadId;

	// SessionStart fires on the first TURN in this codex version, so the
	// harness pre-registers the alias (short-lived pid; the SessionStart hook
	// re-registers later — dead-pid names are free by design).
	cli(["register", "--name", "codex-test", "--kind", "external"]);

	// seed 6 messages BEFORE the first turn: PostToolUse + Stop(+cap) must
	// deliver them during turn 1; anything past the cap stays for turn 2.
	for (let i = 1; i <= 6; i++)
		cli(["send", "--as", "boss", "codex-test", `turn1 message ${i}`]);

	await request("turn/start", {
		threadId,
		input: [{ type: "text", text: "run the probe" }],
	});
	await waitTurnComplete(threadId);
	await sleep(1500); // let trailing Stop hooks finish writing logs

	// ── ① stdin fields ──
	const hookInputs = fs
		.readFileSync(path.join(LOGDIR, "hooks-log.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l)
		.map((l) => JSON.parse(l));
	const stopInputs = hookInputs.filter((h) => h.mode === "stop" && h.input);
	const ptInputs = hookInputs.filter((h) => h.mode === "posttooluse" && h.input);
	if (stopInputs.length === 0 || ptInputs.length === 0) {
		fail("1-stdin-fields", `stop=${stopInputs.length} posttooluse=${ptInputs.length} hook logs: ${hookInputs.map((h) => h.mode).join(",")}`);
	} else {
		const stopOk = stopInputs.every((h) => "session_id" in h.input && "turn_id" in h.input);
		const stopFlag = stopInputs.some((h) => "stop_hook_active" in h.input);
		const ptOk = ptInputs.every((h) => "session_id" in h.input);
		stopOk && ptOk
			? pass("1-stdin-fields", { stopCount: stopInputs.length, ptCount: ptInputs.length, stopFlag })
			: fail("1-stdin-fields", `stopOk=${stopOk} ptOk=${ptOk}`);
	}

	// ── model saw injected content (delivery is end-to-end) ──
	const reqs = fs.existsSync(reqLog)
		? fs.readFileSync(reqLog, "utf8").split("\n").filter((l) => l).map((l) => JSON.parse(l))
		: [];
	const allText = JSON.stringify(reqs.map((r) => r.body.messages?.map((m) => m.content)?.flat()));
	const deliveredT1 = [...Array(6)].filter((_, i) => allText.includes(`turn1 message ${i + 1}`)).length;
	report.turn1DeliveredToModel = deliveredT1;

	// ── ③ Stop block behavior + backlog semantics ──
	const state = JSON.parse(fs.readFileSync(path.join(BOX, ".state", "codex-test.json"), "utf8"));
	const stopBlocks = Object.values(state.block || {}).reduce((a, b) => a + b, 0);
	const seenT1 = state.seen.length;
	// cap: at most 2 blocks per turn; deliveries via posttooluse(2) + stop blocks(2×2)=6 max
	if (seenT1 >= 4 && seenT1 <= 6 && stopBlocks >= 1 && stopBlocks <= 2) {
		pass("3-stop-block-cap", { seenT1, stopBlocks, backlogAfterT1: state.backlog });
	} else {
		fail("3-stop-block-cap", `seen=${seenT1} blocks=${stopBlocks} backlog=${state.backlog}`);
	}

	// ── ④ hook cost ──
	const perf = fs
		.readFileSync(path.join(LOGDIR, "hook-perf.jsonl"), "utf8")
		.split("\n")
		.filter((l) => l)
		.map((l) => JSON.parse(l));
	const times = perf.map((p) => p.ms).sort((a, b) => a - b);
	if (times.length) {
		const med = times[Math.floor(times.length / 2)];
		med < 500
			? pass("4-hook-cost", { samples: times.length, medianMs: med, p95: times[Math.floor(times.length * 0.95)] })
			: fail("4-hook-cost", `median ${med}ms too high`);
	} else fail("4-hook-cost", "no perf samples");

	// ── ② idle retention: fresh messages while no turn runs ──
	fs.rmSync(reqLog);
	for (let i = 1; i <= 2; i++) cli(["send", "--as", "boss", "codex-test", `idle message ${i}`]);
	await sleep(3500);
	const reqsIdle = fs.existsSync(reqLog) ? fs.readFileSync(reqLog, "utf8") : "";
	const readBack = await request("thread/read", { threadId });
	const threadText = JSON.stringify(readBack);
	const idleDelivered =
		reqsIdle.includes("idle message 1") || threadText.includes("idle message 1") ||
		reqsIdle.includes("idle message 2") || threadText.includes("idle message 2");
	if (idleDelivered) {
		fail("2-idle-retention", "messages were delivered while idle (unexpected — would imply wake)");
	} else {
		// next turn must deliver them (event-driven)
		await request("turn/start", { threadId, input: [{ type: "text", text: "next turn" }] });
		await waitTurnComplete(threadId);
		await sleep(1500);
		const reqs2 = fs.existsSync(reqLog)
			? fs.readFileSync(reqLog, "utf8")
			: "";
		const st2 = JSON.parse(fs.readFileSync(path.join(BOX, ".state", "codex-test.json"), "utf8"));
		const idleThen = st2.seen.filter((k) => k.includes("boss:")).length;
		if (reqs2.includes("idle message") || st2.seen.length > seenT1)
			pass("2-idle-retention", { note: "not delivered while idle; delivered on next turn event" });
		else fail("2-idle-retention", "idle messages were not delivered on the next turn either");
	}

	// ── ⑤ writable_roots: watermark persisted (no duplicate delivery) ──
	const allModelText = JSON.stringify(
		(fs.existsSync(reqLog) ? fs.readFileSync(reqLog, "utf8") : "") +
			JSON.stringify(reqs.map((r) => r.body.messages?.map((m) => m.content)?.flat() ?? "")),
	);
	const countOccurrences = (s, sub) => s.split(sub).length - 1;
	const dup =
		countOccurrences(allModelText, "turn1 message 1") > 2 || // delivered once via hook, maybe echoed
		false;
	const stFinal = JSON.parse(fs.readFileSync(path.join(BOX, ".state", "codex-test.json"), "utf8"));
	const seenIds = stFinal.seen;
	const unique = new Set(seenIds).size === seenIds.length;
	// strongest signal: turn1 messages appear in model requests at most twice
	// (once from posttooluse additionalContext, once from stop continuation is
	// impossible for the same id — ids are marked seen at first delivery)
	if (unique && !dup) pass("5-writable-roots", { seenTotal: seenIds.length, note: "watermark persisted; no duplicate delivery" });
	else fail("5-writable-roots", `unique=${unique} dup=${dup}`);

	pass("scenario-complete", { threadId });
} catch (e) {
	fail("scenario", String(e.message || e));
} finally {
	child.kill("SIGKILL");
	server.close();
	report.codexVersion = spawnSyncNode("codex", ["--version"], { encoding: "utf8" }).stdout.trim();
	fs.writeFileSync(path.join(ROOT, "report.json"), JSON.stringify(report, null, 2));
	console.log(`\nresults dir: ${ROOT}`);
	const failed = Object.values(report.checks).filter((c) => c.status === "fail").length;
	console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
}
