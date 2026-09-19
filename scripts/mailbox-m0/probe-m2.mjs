#!/usr/bin/env node
/**
 * probe-m2.mjs — M2 end-to-end: installed codex wiring × real pi, one mailbox.
 *
 * Flow:
 *   1. run bridge/codex/install.mjs into an ISOLATED CODEX_HOME/MAILBOX_DIR
 *      (merge path exercised exactly as a real install)
 *   2. append a mock model provider to the installed config.toml
 *   3. spawn TWO codex app-servers (CODEX_SESSION_NAME=bob / carol)
 *      — each with its own mock server that knows the session's alias and
 *        can emit mailbox tool calls (report/send) with dynamic taskId
 *   4. spawn ONE real pi (repo extension, PI_SESSION_NAME=alice) that
 *      chats + dispatches a task, then sleeps to receive reports
 *
 * Scenarios / assertions:
 *   S1  pi→codex chat delivered end-to-end (bob's model sees it)
 *   S2  dispatch→report closed loop via the codex shell tool
 *       (also re-verifies writable_roots through the installed config)
 *   S3  codex→pi chat (carol sends; alice receives via followUp)
 *   S4  dual-codex identity isolation (bob gets bob's mail only)
 *   S5  idle retention + catch-up on next turn
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const INSTALL = path.join(ROOT, "bridge", "codex", "install.mjs");
const EXT = path.join(ROOT, "plugins", "session-messaging", "index.ts");

const T = fs.mkdtempSync(path.join(os.tmpdir(), "m2-e2e-"));
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
function cli(args, env = {}) {
	const r = spawnSync(process.execPath, [path.join(BRIDGE, "bin", "mailbox-cli.mjs"), ...args], {
		env: { ...process.env, MAILBOX_DIR: BOX, ...env },
		encoding: "utf8",
	});
	if (r.status !== 0) throw new Error(`cli ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

// ── 1. real install into isolated dirs ─────────────────────────
const inst = spawnSync(process.execPath, [INSTALL, "--no-bin"], {
	env: { ...process.env, CODEX_HOME, MAILBOX_DIR: BOX, MAILBOX_BRIDGE: BRIDGE },
	encoding: "utf8",
});
if (inst.status !== 0) {
	fail("install", inst.stderr);
	console.log(JSON.stringify(report, null, 2));
	process.exit(1);
}
pass("install", { note: "merged into isolated CODEX_HOME" });

// ── 2. mock model servers (one per codex alias) ────────────────
function makeMock(alias, port0) {
	const reqLog = path.join(LOGS, `model-${alias}.jsonl`);
	const srv = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let j = {};
			try {
				j = JSON.parse(body);
			} catch {}
			fs.appendFileSync(reqLog, JSON.stringify({ t: Date.now(), body: j }) + "\n");
			const input = j.input || [];
			const text = JSON.stringify(input);
			const hasToolResult = input.some(
				(i) => i.type === "function_call_output" || i.role === "tool",
			);
			const taskMatch = text.match(/taskId[=:]\s*"?((?:t-)[A-Za-z0-9-]+)/);
			const reported = text.includes("M2-REPORTED");
			const tool = (name, args) => [
				{ type: "function_call", id: `fc_${Date.now()}`, call_id: `call_${Date.now()}`, name, arguments: JSON.stringify(args) },
			];
			let output;
			if (taskMatch && !reported) {
				output = tool("exec_command", {
					cmd: `MAILBOX_DIR=${BOX} ${process.execPath} ${path.join(BRIDGE, "bin", "mailbox-cli.mjs")} report alice ${taskMatch[1]} 42 && echo M2-REPORTED`,
				});
			} else if (alias === "carol" && text.includes("say hi to alice") && !text.includes("hi from carol")) {
				output = tool("exec_command", {
					cmd: `MAILBOX_DIR=${BOX} ${process.execPath} ${path.join(BRIDGE, "bin", "mailbox-cli.mjs")} send alice "hi from carol"`,
				});
			} else if (!hasToolResult) {
				output = tool("exec_command", { cmd: "echo m2-probe" });
			} else {
				output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "M2-DONE" }] }];
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
	return new Promise((r) => srv.listen(port0, "127.0.0.1", () => r({ srv, port: srv.address().port, reqLog })));
}
const bobMock = await makeMock("bob", 0);
const carolMock = await makeMock("carol", 0);

// ── 3. inject mock provider into the INSTALLED config.toml ─────
// NOTE: top-level keys (model/model_provider) MUST precede any [table]
// header in TOML — appending after [sandbox_workspace_write] would scope
// them INTO that table and silently break provider resolution.
{
	const cfgPath = path.join(CODEX_HOME, "config.toml");
	const head = `model = "mock-model"
model_provider = "m2mock"

[model_providers.m2mock]
name = "m2mock"
base_url = "http://127.0.0.1:${bobMock.port}/v1"
env_key = "MOCK_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

`;
	fs.writeFileSync(cfgPath, head + fs.readFileSync(cfgPath, "utf8"));
}

// ── 4. two codex app-servers ────────────────────────────────────
function spawnCodex(alias, mockPort) {
	const child = spawn("codex", ["app-server"], {
		cwd: T,
		env: {
			...process.env,
			CODEX_HOME,
			CODEX_SESSION_NAME: alias,
			MAILBOX_DIR: BOX,
			M2_MOCK_PORT: String(mockPort),
			MOCK_KEY: "x",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stderr.pipe(fs.createWriteStream(path.join(LOGS, `codex-${alias}.stderr.log`), { flags: "a" }));
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
	return {
		alias,
		child,
		request(method, params, timeoutMs = 60_000) {
			const id = ++seq;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`${alias} timeout: ${method}`)), timeoutMs);
				pending.set(id, (m) => {
					clearTimeout(timer);
					if (m.error) reject(new Error(`${alias} ${method}: ${JSON.stringify(m.error)}`));
					else resolve(m.result);
				});
				child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
			});
		},
	};
}
const bob = spawnCodex("bob", bobMock.port);
const carol = spawnCodex("carol", carolMock.port);

// carol's config needs ITS mock port — rewrite provider base_url per server is
// global in config.toml… trick: route by alias via a tiny proxy? Simpler: give
// each app-server its own CODEX_HOME copy with the right port.
// (handled below — see note)

// ── helpers ─────────────────────────────────────────────────────
const readReqs = (alias) =>
	fs.existsSync(path.join(LOGS, `model-${alias}.jsonl`))
		? fs.readFileSync(path.join(LOGS, `model-${alias}.jsonl`), "utf8").split("\n").filter((l) => l).map((l) => JSON.parse(l))
		: [];
const stateOf = (alias) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(BOX, ".state", `${alias}.json`), "utf8"));
	} catch {
		return { seen: [] };
	}
};
async function turn(sess, text, timeoutMs = 120_000) {
	const before = readReqs(sess.alias).length;
	await sess.request("turn/start", {
		threadId: sess.threadId,
		input: [{ type: "text", text }],
	});
	// settle: at least one NEW model request must appear, then the log
	// stops growing for 1.5s (guards against turn-startup latency)
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		await sleep(500);
		const n = readReqs(sess.alias).length;
		if (n > before) {
			await sleep(1500);
			if (readReqs(sess.alias).length === n) return;
		}
	}
	throw new Error(`${sess.alias}: turn did not settle`);
}

try {
	// per-session mock port: override via request-level base_url is not
	// supported; instead spawn each app-server with its own CODEX_HOME
	// (config identical except provider port). We already spawned with a
	// shared home — redo properly:
	for (const s of [bob, carol]) s.child.kill("SIGKILL");
	const homes = {};
	async function spawnWithHome(alias, mockPort) {
		const home = path.join(T, `codex-${alias}`);
		fs.cpSync(CODEX_HOME, home, { recursive: true });
		let cfg = fs.readFileSync(path.join(home, "config.toml"), "utf8");
		cfg = cfg.replace(/base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/, `base_url = "http://127.0.0.1:${mockPort}/v1"`);
		fs.writeFileSync(path.join(home, "config.toml"), cfg);
		homes[alias] = home;
		const child = spawn("codex", ["app-server"], {
			cwd: T,
			env: { ...process.env, CODEX_HOME: home, CODEX_SESSION_NAME: alias, MAILBOX_DIR: BOX, MOCK_KEY: "x" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stderr.pipe(fs.createWriteStream(path.join(LOGS, `codex-${alias}.stderr.log`), { flags: "a" }));
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
		return {
			alias,
			child,
			home,
			request(method, params, timeoutMs = 60_000) {
				const id = ++seq;
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error(`${alias} timeout: ${method}`)), timeoutMs);
					pending.set(id, (m) => {
						clearTimeout(timer);
						if (m.error) reject(new Error(`${alias} ${method}: ${JSON.stringify(m.error)}`));
						else resolve(m.result);
					});
					child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
				});
			},
		};
	}
	const bobS = await spawnWithHome("bob", bobMock.port);
	const carolS = await spawnWithHome("carol", carolMock.port);

	for (const s of [bobS, carolS]) {
		await s.request("initialize", {
			clientInfo: { name: "m2", version: "0.1" },
			capabilities: { experimentalApi: true },
		});
		s.child.stdin.write('{"method":"initialized"}\n');
		const started = await s.request("thread/start", {
			cwd: T,
			approvalPolicy: "never",
			sandbox: "workspace-write",
			sessionStartSource: "startup",
			config: { bypass_hook_trust: true },
		});
		s.threadId = started.thread.id;
	}
	// intro turns: fire SessionStart (registration) and warm the thread
	await turn(bobS, "introduce");
	await turn(carolS, "introduce");
	// registration files (SessionStart may land slightly after the turn)
	for (const alias of ["bob", "carol"]) {
		const t0 = Date.now();
		while (!fs.existsSync(path.join(BOX, "sessions", `${alias}.json`))) {
			if (Date.now() - t0 > 15_000) break;
			await sleep(500);
		}
	}
	const regs = fs.readdirSync(path.join(BOX, "sessions")).map((f) => f.replace(/\.json$/, "")).sort();
	if (regs.includes("bob") && regs.includes("carol"))
		pass("dual-registration", { registrations: regs });
	else fail("dual-registration", `sessions: ${regs.join(",")}`);

	// ── real pi as alice ────────────────────────────────────────
	const aliceOut = fs.openSync(path.join(LOGS, "alice.stdout"), "w");
	const alice = spawn("pi", ["-ne", "-e", EXT, "-p",
		"按顺序执行：1) 立刻调用 send_session_message 工具，收件人 bob，文本 hello from alice。2) 立刻调用 dispatch_task 工具，收件人 bob，任务=计算 7*6 并用 report_task_result 回报结果。3) 用 bash 工具运行 sleep 90。4) 醒来后把收到的所有跨会话消息与任务回报原样汇总输出。"],
		{
			cwd: ROOT,
			env: { ...process.env, MAILBOX_DIR: BOX, PI_SESSION_NAME: "alice" },
			stdio: ["ignore", aliceOut, "pipe"],
		});
	alice.stderr.pipe(fs.createWriteStream(path.join(LOGS, "alice.stderr"), { flags: "a" }));

	// wait for alice to send (log-alice.jsonl appears with 2 records)
	let t0 = Date.now();
	while (Date.now() - t0 < 60_000) {
		if (fs.existsSync(path.join(BOX, "log-alice.jsonl"))) {
			const n = fs.readFileSync(path.join(BOX, "log-alice.jsonl"), "utf8").split("\n").filter((l) => l).length;
			if (n >= 2) break;
		}
		await sleep(1000);
	}
	await sleep(2000);

	// ── S1+S2: bob turn → chat delivered + task reported ────────
	await turn(bobS, "check inbox");
	const bobText = JSON.stringify(readReqs("bob").map((r) => r.body.input));
	if (bobText.includes("hello from alice")) pass("S1-pi-to-codex-chat");
	else fail("S1-pi-to-codex-chat", "bob model never saw the chat");
	let t1 = Date.now();
	while (Date.now() - t1 < 30_000) {
		if (fs.existsSync(path.join(BOX, "log-bob.jsonl"))) break;
		await sleep(1000);
	}
	const bobLog = fs.existsSync(path.join(BOX, "log-bob.jsonl"))
		? fs.readFileSync(path.join(BOX, "log-bob.jsonl"), "utf8")
		: "";
	const m = bobLog.match(/"type":"result".*?"taskId":"(t-[A-Za-z0-9-]+)"/s);
	if (m) pass("S2-dispatch-report-loop", { taskId: m[1] });
	else fail("S2-dispatch-report-loop", "no result record in log-bob");

	// ── S3: carol sends to alice ────────────────────────────────
	await turn(carolS, "say hi to alice");
	const carolLog = fs.existsSync(path.join(BOX, "log-carol.jsonl"))
		? fs.readFileSync(path.join(BOX, "log-carol.jsonl"), "utf8")
		: "";
	if (carolLog.includes("hi from carol")) pass("S3-codex-to-pi-send");
	else fail("S3-codex-to-pi-send", "carol did not send (check sandbox/writable_roots)");

	// ── S4: identity isolation ──────────────────────────────────
	cli(["send", "--as", "alice", "bob", "only for bob"]);
	const carolSeenBefore = stateOf("carol").seen.length;
	await turn(bobS, "check mail");
	await turn(carolS, "check mail");
	const bobText2 = JSON.stringify(readReqs("bob").map((r) => r.body.input));
	const carolText = JSON.stringify(readReqs("carol").map((r) => r.body.input));
	const bobGot = bobText2.includes("only for bob");
	const carolGot = carolText.includes("only for bob");
	const carolSeenAfter = stateOf("carol").seen.length;
	if (bobGot && !carolGot && carolSeenAfter === carolSeenBefore)
		pass("S4-identity-isolation");
	else fail("S4-identity-isolation", `bobGot=${bobGot} carolGot=${carolGot} carolSeen ${carolSeenBefore}→${carolSeenAfter}`);

	// ── S5: idle retention + catch-up ───────────────────────────
	const bobReqsBefore = readReqs("bob").length;
	cli(["send", "--as", "alice", "bob", "idle probe message"]);
	await sleep(4500);
	const duringIdle = readReqs("bob").length;
	await turn(bobS, "wake up");
	const afterTurn = JSON.stringify(readReqs("bob").map((r) => r.body.input));
	if (duringIdle === bobReqsBefore && afterTurn.includes("idle probe message"))
		pass("S5-idle-retention-catchup");
	else fail("S5-idle-retention-catchup", `idleReqs ${bobReqsBefore}→${duringIdle}, delivered=${afterTurn.includes("idle probe message")}`);

	// ── alice's final output ────────────────────────────────────
	t0 = Date.now();
	while (Date.now() - t0 < 240_000) {
		if (alice.exitCode !== null) break;
		await sleep(2000);
	}
	const aliceKilled = alice.exitCode === null;
	if (aliceKilled) alice.kill("SIGKILL");
	const aliceFinal = fs.existsSync(path.join(LOGS, "alice.stdout"))
		? fs.readFileSync(path.join(LOGS, "alice.stdout"), "utf8")
		: "";
	const aliceErr = fs.existsSync(path.join(LOGS, "alice.stderr"))
		? fs.readFileSync(path.join(LOGS, "alice.stderr"), "utf8")
		: "";
	if (aliceKilled) fail("alice-lifecycle", `alice still running at timeout; stderr tail: ${aliceErr.slice(-300)}`);
	if (aliceFinal.includes("42")) pass("S2b-alice-received-report");
	else fail("S2b-alice-received-report", `alice output lacks 42; tail: ${aliceFinal.slice(-300)}`);
	if (aliceFinal.includes("hi from carol")) pass("S3b-alice-received-chat");
	else fail("S3b-alice-received-chat", `alice output lacks carol chat; tail: ${aliceFinal.slice(-300)}`);
} catch (e) {
	fail("scenario", String(e.message || e));
} finally {
	for (const p of [bob?.child, carol?.child]) p?.kill?.("SIGKILL");
	bobMock.srv.close();
	carolMock.srv.close();
	try { alice?.kill?.("SIGKILL"); } catch {}
	report.codexVersion = spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim();
	fs.writeFileSync(path.join(T, "report.json"), JSON.stringify(report, null, 2));
	const failed = Object.values(report.checks).filter((c) => c.status === "fail").length;
	console.log(`\nresults: ${T}`);
	console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
	process.exit(failed === 0 ? 0 : 1);
}
