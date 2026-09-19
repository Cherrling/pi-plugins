#!/usr/bin/env node
/**
 * test-core.mjs — M0 cases ⑥⑦⑧⑨ migrated onto the FORMAL Node mailbox-core.
 *
 * Mirrors scripts/mailbox-m0/probe-v62.py (Python strategy prototype) so the
 * two can be compared line by line. This is the acceptance run for the write
 * rules adopted in plan v6.2 §2:
 *   1. per-sender lock covers tail check + isolation + whole retry loop
 *   2. residual partial tail isolated with '\n' BEFORE appending
 *   3. mid-record failure → send fails, fragment stays
 *   4. success only after full record + '\n'
 *
 * Also covers: SAMP id cross-language determinism (vs python3 json),
 * check-hook stop/posttooluse semantics, alias uniqueness.
 *
 * Exit 0 = all assertions hold. Writes JSON results to stdout tail.
 */

import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = repoRoot();
const CLI = path.join(ROOT, "bridge", "mailbox-cli.mjs");
const results = [];
let tmpRoot;

function repoRoot() {
	// scripts/mailbox-m0/test-core.mjs → repo root
	return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
}

function t(name) {
	return path.join(tmpRoot, name);
}
function mk(name) {
	const p = t(name);
	fs.mkdirSync(p, { recursive: true });
	return p;
}
function cli(box, args, env = {}, opts = {}) {
	const r = spawnSync(
		process.execPath,
		[CLI, ...args],
		Object.assign(
			{
				env: { ...process.env, MAILBOX_DIR: box, ...env },
				encoding: "utf8",
				timeout: 60_000,
			},
			opts,
		),
	);
	return r;
}
function ok(r) {
	if (r.status !== 0)
		throw new Error(`cli failed (${r.status}): ${r.stderr || r.stdout}`);
	return r.stdout;
}
function scan(box) {
	const msgs = [],
		bad = [];
	const dir = fs.readdirSync(box).sort();
	for (const f of dir) {
		if (!/^log-.*\.jsonl$/.test(f)) continue;
		const lines = fs.readFileSync(path.join(box, f), "utf8").split("\n");
		lines.forEach((l, i) => {
			if (l === "") return;
			try {
				msgs.push(JSON.parse(l));
			} catch {
				bad.push({ file: f, line: i + 1 });
			}
		});
	}
	return { msgs, bad };
}
function fingerprint(box) {
	let maxM = 0n,
		count = 0,
		size = 0;
	for (const f of fs.readdirSync(box).sort()) {
		if (!/^log-.*\.jsonl$/.test(f)) continue;
		const st = fs.statSync(path.join(box, f), { bigint: true });
		if (maxM < st.mtimeNs) maxM = st.mtimeNs;
		count++;
		size += Number(st.size);
	}
	return [maxM.toString(), count, size];
}
function readState(box, reader) {
	try {
		return JSON.parse(fs.readFileSync(path.join(box, ".state", `${reader}.json`), "utf8"));
	} catch {
		return { seen: [], backlog: false, cache: null, block: {} };
	}
}
function emitted(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l && !l.startsWith('{"meta"'))
		.map((l) => JSON.parse(l));
}
function emitMeta(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.startsWith('{"meta"'))
		.map((l) => JSON.parse(l));
}
function seed(box, n) {
	for (let i = 0; i < n; i++)
		ok(cli(box, ["send", "--as", "boss", "worker", `message ${i} 中文内容`]));
}

async function run(name, fn) {
	const box = mk(name);
	try {
		await fn(box);
		results.push({ name, status: "pass" });
		console.log(`PASS ${name}`);
	} catch (e) {
		results.push({ name, status: "fail", error: String(e.message || e) });
		console.log(`FAIL ${name}: ${e.message}`);
	}
}

const tests = [];

// ── ⑥ ten-message backlog, no new writes, drained 2 per round ──
tests.push(["t6-backlog-drain", async (box) => {
	ok(cli(box, ["register", "--name", "worker"]));
	seed(box, 10);
	const fp0 = fingerprint(box);
	const emit = t("t6.emit");
	let total = 0;
	for (let round = 1; round <= 5; round++) {
		ok(cli(box, ["inbox", "--as", "worker", "--limit", "2"], { MAILBOX_EMIT_FILE: emit }));
		const nowTotal = emitted(emit).length; // cumulative file length
		const delta = nowTotal - total;
		total = nowTotal;
		if (delta !== 2) throw new Error(`round ${round}: delivered ${delta}, want 2`);
		const st = readState(box, "worker");
		if (round < 5 && !st.backlog) throw new Error(`round ${round}: backlog should be true`);
	}
	if (total !== 10) throw new Error(`delivered ${total}, want 10`);
	const st = readState(box, "worker");
	if (st.backlog) throw new Error("backlog should be false after drain");
	if (fingerprint(box).join() !== fp0.join()) throw new Error("log fingerprint changed");
	// 6th check: short-circuit, nothing new
	const before = emitted(emit).length;
	ok(cli(box, ["inbox", "--as", "worker"], { MAILBOX_EMIT_FILE: emit }));
	if (emitted(emit).length !== before) throw new Error("shortcut path emitted messages");
}]);

// ── ⑦a crash AFTER emit BEFORE state commit (SIGKILL while holding lock) ──
tests.push(["t7a-crash-after-emit", async (box) => {
	ok(cli(box, ["register", "--name", "worker"]));
	seed(box, 6);
	const emit = t("t7a.emit");
	const r = cli(
		box,
		["inbox", "--as", "worker", "--limit", "2"],
		{ MAILBOX_EMIT_FILE: emit, MAILBOX_CRASH_STAGE: "after-emit" },
	);
	if (!(r.status === null && r.signal === "SIGKILL"))
		throw new Error(`expected SIGKILL, got status=${r.status} signal=${r.signal}`);
	if (emitted(emit).length !== 2) throw new Error("emit before crash should have 2");
	// the killed child held state-worker lock; next inbox must steal stale lock
	ok(cli(box, ["inbox", "--as", "worker", "--limit", "2"], { MAILBOX_EMIT_FILE: emit }));
	const all = emitted(emit);
	if (all.length !== 4) throw new Error(`after steal: ${all.length} emitted, want 4 (2 dup)`);
	const ids = all.map((m) => m.id);
	if (ids[0] !== ids[2] || ids[1] !== ids[3])
		throw new Error("second delivery should repeat the same two ids");
	// third run: continues with next 2 (no dup)
	ok(cli(box, ["inbox", "--as", "worker", "--limit", "2"], { MAILBOX_EMIT_FILE: emit }));
	if (emitted(emit).length !== 6) throw new Error("third delivery should add 2 new");
}]);

// ── ⑦b commit, then no-new, then replay recovers ──
tests.push(["t7b-replay-recovers", async (box) => {
	ok(cli(box, ["register", "--name", "worker"]));
	seed(box, 2);
	const emit = t("t7b.emit");
	ok(cli(box, ["inbox", "--as", "worker", "--limit", "2"], { MAILBOX_EMIT_FILE: emit }));
	ok(cli(box, ["inbox", "--as", "worker", "--limit", "2"], { MAILBOX_EMIT_FILE: emit }));
	if (emitted(emit).length !== 2) throw new Error("second run should be silent");
	ok(cli(box, ["replay", "--as", "worker", "--all"]));
	ok(cli(box, ["inbox", "--as", "worker", "--limit", "2"], { MAILBOX_EMIT_FILE: emit }));
	if (emitted(emit).length !== 4) throw new Error("replay should redeliver both");
	const st = readState(box, "worker");
	if (st.backlog) throw new Error("backlog should clear after full redelivery");
}]);

// ── ⑧ replay: single id; must defeat the mtime short-circuit ──
tests.push(["t8a-replay-single-beats-shortcut", async (box) => {
	ok(cli(box, ["register", "--name", "worker"]));
	seed(box, 4);
	const emit = t("t8a.emit");
	ok(cli(box, ["inbox", "--as", "worker", "--limit", "4"], { MAILBOX_EMIT_FILE: emit }));
	if (emitted(emit).length !== 4) throw new Error("baseline drain");
	const fp0 = fingerprint(box);
	const target = emitted(emit)[2].id; // third message
	ok(cli(box, ["replay", "--as", "worker", target]));
	ok(cli(box, ["inbox", "--as", "worker", "--limit", "4"], { MAILBOX_EMIT_FILE: emit }));
	const redelivered = emitted(emit).slice(4);
	if (redelivered.length !== 1 || redelivered[0].id !== target)
		throw new Error(`single replay delivered: ${JSON.stringify(redelivered)}`);
	if (fingerprint(box).join() !== fp0.join()) throw new Error("log changed during replay");
}]);

// ── ⑧ concurrent check (holds lock) + replay → no lost replay intent ──
tests.push(["t8b-concurrent-replay-not-lost", async (box) => {
	ok(cli(box, ["register", "--name", "worker"]));
	seed(box, 4);
	const emit = t("t8b.emit");
	// check holds the state lock for 1.2s (after acquire, during read phase)
	const slow = spawn(process.execPath, [CLI, "inbox", "--as", "worker", "--limit", "2"], {
		env: { ...process.env, MAILBOX_DIR: box, MAILBOX_EMIT_FILE: emit, MAILBOX_HOLD_LOCK_MS: "1200" },
		stdio: "ignore",
	});
	await new Promise((r) => setTimeout(r, 300)); // let it take the lock
	if (!fs.existsSync(path.join(box, ".locks", "state-worker"))) throw new Error("lock not held");
	const rp = cli(box, ["replay", "--as", "worker", "--all"]);
	ok(rp);
	const slowExit = await new Promise((res) => slow.on("exit", res));
	if (slowExit !== 0) throw new Error(`slow inbox exit ${slowExit}`);
	// replay must have survived the concurrent check: next inbox redelivers
	ok(cli(box, ["inbox", "--as", "worker", "--limit", "4"], { MAILBOX_EMIT_FILE: emit }));
	const total = emitted(emit).length;
	if (total < 6) throw new Error(`expected ≥6 emitted (2 slow + ≥4 replayed), got ${total}`);
}]);

// ── ⑨a mid-record failure → fragment stays, next send isolates it ──
tests.push(["t9a-fragment-isolation", async (box) => {
	ok(cli(box, ["register", "--name", "worker"]));
	// short write then injected ENOSPC: partial JSON stays in the log
	const bad = cli(box, ["send", "--as", "boss", "worker", "doomed message"], {
		MAILBOX_FAULT_ENOSPC_AT: "20",
		MAILBOX_WRITE_CHUNK: "7",
	});
	if (bad.status === 0) throw new Error("send should have failed");
	const log = path.join(box, "log-boss.jsonl");
	const raw = fs.readFileSync(log, "utf8");
	if (!raw.startsWith("{") || raw.includes("\n")) throw new Error("fragment should be a partial line");
	// next send isolates the tail and succeeds
	const r = ok(cli(box, ["send", "--as", "boss", "worker", "good message one"], { MAILBOX_WRITE_CHUNK: "7" }));
	const m = JSON.parse(r);
	if (!m.isolatedBadTail) throw new Error("isolation flag missing");
	ok(cli(box, ["send", "--as", "boss", "worker", "good message two"], { MAILBOX_WRITE_CHUNK: "7" }));
	const { msgs, bad: badLines } = scan(box);
	if (msgs.length !== 2) throw new Error(`want 2 parseable messages, got ${msgs.length}`);
	if (badLines.length !== 1) throw new Error(`want exactly 1 isolated bad line, got ${badLines.length}`);
	if (msgs.some((m) => m.body === "doomed message")) throw new Error("doomed message must not parse");
	// reader skips the bad line, sees the good ones
	ok(cli(box, ["register", "--name", "reader"]));
	// worker is the recipient; deliver to worker
	ok(cli(box, ["inbox", "--as", "worker", "--limit", "5"]));
	const st = readState(box, "worker");
	if (st.seen.length !== 2) throw new Error(`worker should have seen 2, got ${st.seen.length}`);
}]);

// ── ⑨b four concurrent SAME-alias senders, 7-byte chunks, 100 records ──
tests.push(["t9b-concurrent-same-alias-writers", async (box) => {
	ok(cli(box, ["register", "--name", "worker"]));
	const procs = [];
	for (let p = 0; p < 4; p++) {
		procs.push(
			spawn(
				process.execPath,
				[CLI, "send", "--as", "stress", "worker", `batch-${p}`],
				{
					env: {
						...process.env,
						MAILBOX_DIR: box,
						MAILBOX_WRITE_CHUNK: "7",
						MAILBOX_SEND_LOOP: "25", // test hook: repeat the send 25×
					},
					stdio: "ignore",
				},
			),
		);
	}
	const exits = await Promise.all(procs.map((pr) => new Promise((res) => pr.on("exit", res))));
	if (exits.some((c) => c !== 0)) throw new Error(`sender exit codes: ${exits.join(",")}`);
	const { msgs, bad } = scan(box);
	if (msgs.length !== 100) throw new Error(`want 100 records, got ${msgs.length}`);
	if (bad.length !== 0) throw new Error(`want 0 bad lines, got ${bad.length}`);
	const ids = new Set(msgs.map((m) => m.id));
	if (ids.size !== 100) throw new Error(`duplicate ids: ${ids.size}`);
}]);

// ── SAMP id cross-language determinism (node vs python3 json) ──
tests.push(["samp-id-cross-language", async () => {
	const rec = {
		body: "hello 中文 ✅ multi\nline",
		from: "boss",
		thread: "2026-09-20-boss-x",
		to: "worker",
		s: undefined,
		ts: 1789850343,
	};
	delete rec.s;
	const py = spawnSync(
		"python3",
		["-c", "import json,hashlib,sys;rec=json.loads(sys.argv[1]);c=json.dumps(rec,ensure_ascii=False,sort_keys=True,separators=(',',':'));print(hashlib.sha256(c.encode('utf-8')).hexdigest()[:16])", JSON.stringify(rec)],
		{ encoding: "utf8" },
	);
	if (py.status !== 0) throw new Error(`python failed: ${py.stderr}`);
	const expected = py.stdout.trim();
	const { sampId } = await import(path.join(ROOT, "shared", "mailbox", "protocol.mjs"));
	const got = sampId(rec);
	if (got !== expected) throw new Error(`id mismatch: node=${got} python=${expected}`);
}]);

// ── check hook: stop cap 2/turn incl. first; posttooluse context; fail-open ──
tests.push(["check-hook-semantics", async (box) => {
	ok(cli(box, ["register", "--name", "hooked"]));
	for (let i = 0; i < 8; i++)
		ok(cli(box, ["send", "--as", "boss", "hooked", `hook message ${i}`]));
	// posttooluse first: injects additionalContext (2 delivered)
	const pt = JSON.parse(
		ok(
			cli(box, ["check", "--mode", "posttooluse", "--as", "hooked"], undefined, {
				input: JSON.stringify({ session_id: "hooked", turn_id: "turn-0" }),
			}),
		),
	);
	if (!pt.hookSpecificOutput || !pt.hookSpecificOutput.additionalContext)
		throw new Error("posttooluse should inject additionalContext when pending");
	const stop = (turn, active) =>
		JSON.parse(
			ok(
				cli(box, ["check", "--mode", "stop", "--as", "hooked"], undefined, {
					input: JSON.stringify({ session_id: "hooked", turn_id: turn, stop_hook_active: active }),
				}),
			),
		);
	let r1 = stop("turn-1", false);
	if (r1.decision !== "block") throw new Error("first stop should block");
	let r2 = stop("turn-1", true);
	if (r2.decision !== "block") throw new Error("second stop same turn should block");
	let r3 = stop("turn-1", true);
	if (r3.decision === "block") throw new Error("third stop same turn must allow (cap 2)");
	let r4 = stop("turn-2", false);
	if (r4.decision !== "block") throw new Error("new turn should reset cap");
	// posttooluse with nothing pending → {}
	const pt2 = JSON.parse(
		ok(
			cli(box, ["check", "--mode", "posttooluse", "--as", "hooked"], undefined, {
				input: JSON.stringify({ session_id: "hooked", turn_id: "turn-2" }),
			}),
		),
	);
	if (pt2.decision || pt2.hookSpecificOutput) throw new Error("no pending → {} expected");
	// fail-open on garbage stdin
	const garb = ok(
		cli(box, ["check", "--mode", "stop", "--as", "hooked"], undefined, { input: "not json{{{" }),
	);
	if (garb.trim() !== "{}") throw new Error(`garbage stdin must fail-open, got: ${garb}`);
	// 2 (posttooluse) + 2 + 2 + 0 + 2 = 8 seen
	const st = readState(box, "hooked");
	if (st.seen.length !== 8) throw new Error(`expected 8 seen, got ${st.seen.length}`);
}]);

// ── alias uniqueness + ambiguous prefix rejection ──
tests.push(["alias-rules", async (box) => {
	ok(cli(box, ["register", "--name", "worker-a"]));
	ok(cli(box, ["register", "--name", "worker-b"]));
	const amb = cli(box, ["send", "--as", "boss", "worker", "hi"]);
	if (amb.status === 0 || !/ambiguous/i.test(amb.stderr))
		throw new Error(`ambiguous prefix must error: ${amb.stderr}`);
	const none = cli(box, ["send", "--as", "boss", "ghost", "hi"]);
	if (none.status === 0) throw new Error("unknown recipient must error");
	// exact match still works
	ok(cli(box, ["send", "--as", "boss", "worker-a", "hi"]));
	// a name whose owner pid is ALIVE must not be re-registered by another pid
	const holder = spawn("sleep", ["30"]);
	await new Promise((r) => setTimeout(r, 200));
	try {
		ok(cli(box, ["register", "--name", "held", "--pid", String(holder.pid)]));
		const reg = cli(box, ["register", "--name", "held"]);
		if (reg.status === 0) throw new Error("re-register under live foreign pid must fail");
	} finally {
		holder.kill();
	}
	await new Promise((r) => setTimeout(r, 200));
	// once the holder dies, the name is free again
	ok(cli(box, ["register", "--name", "held"]));
}]);

// ── perf: full inbox path, cold + shortcut, empty and 100-record logs ──
tests.push(["perf-inbox", async (box) => {
	ok(cli(box, ["register", "--name", "worker"]));
	const emptyCold = timed(() => cli(box, ["inbox", "--as", "worker"]));
	seed(box, 100);
	ok(cli(box, ["inbox", "--as", "worker", "--limit", "100"]));
	const fullShortcut = timed(() => cli(box, ["inbox", "--as", "worker"]));
	ok(cli(box, ["replay", "--as", "worker", "--all"]));
	const fullRescan = timed(() => cli(box, ["inbox", "--as", "worker", "--limit", "100"]));
	console.log(
		`  perf: empty-cold=${emptyCold}ms full-shortcut=${fullShortcut}ms full-rescan=${fullRescan}ms`,
	);
	results.push({
		name: "perf-inbox",
		status: "pass",
		numbers: { emptyCold, fullShortcut, fullRescan },
	});
}]);

function timed(fn) {
	const t0 = process.hrtime.bigint();
	fn();
	return Number(process.hrtime.bigint() - t0) / 1e6;
}

// ── runner ─────────────────────────────────────────────────────
tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-m0-node-"));
process.env.MAILBOX_SEND_LOOP = "1"; // default: single send per invocation
for (const [name, fn] of tests) await run(name, fn);
const failed = results.filter((r) => r.status === "fail").length;
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`} — results dir: ${tmpRoot}`);
console.log(JSON.stringify({ root: tmpRoot, passed: !failed, results }, null, 2));
process.exit(failed === 0 ? 0 : 1);
