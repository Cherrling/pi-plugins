#!/usr/bin/env node
/**
 * test-rename.mjs — interactive rename (session-name map) tests.
 *
 * Core-level: map write/read, checkHook resolves alias via map,
 * renameSession carries unread messages + updates map + swaps registration.
 * CLI-level: register with piped stdin writes the map; rename --as works.
 * The full ancestor-walk path (real codex host) is covered by probe-rename.mjs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Mailbox } from "../../shared/mailbox/core.mjs";
import { renderIncoming } from "../../shared/mailbox/protocol.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const CLI = path.join(ROOT, "bridge", "mailbox-cli.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function run(name, fn) {
	const box = fs.mkdtempSync(path.join(os.tmpdir(), `rn-${name}-`));
	return Promise.resolve()
		.then(() => fn(box))
		.then(() => {
			results.push({ name, status: "pass" });
			console.log(`PASS ${name}`);
		})
		.catch((e) => {
			results.push({ name, status: "fail", error: String(e.message || e) });
			console.log(`FAIL ${name}: ${e.message}`);
		});
}
function cli(box, args, env = {}, input = null) {
	return spawnSync(process.execPath, [CLI, ...args], {
		env: { ...process.env, MAILBOX_DIR: box, ...env },
		encoding: "utf8",
		input: input ?? undefined,
	});
}

await run("map-lifecycle", async (box) => {
	const mb = new Mailbox(box);
	const sid = "01a0aa-1111-2222-3333-444444444444";
	if (mb.readNameMap(sid) !== null) throw new Error("empty map must read null");
	mb.writeNameMap(sid, { alias: "codex", hostPid: 4242 });
	const m = mb.readNameMap(sid);
	if (!m || m.alias !== "codex" || m.hostPid !== 4242) throw new Error("map roundtrip failed");
	// ancestor lookup: fake ancestor set containing hostPid
	const found = mb.findNameMapByAncestors([1, 99, 4242, 7]);
	if (!found || found.alias !== "codex" || found.sessionId !== sid)
		throw new Error("ancestor lookup failed");
	if (mb.findNameMapByAncestors([1, 2, 3])) throw new Error("unrelated ancestors must not match");
});

await run("checkhook-resolves-via-map", async (box) => {
	const mb = new Mailbox(box);
	const sid = "sid-aaa";
	mb.register({ name: "codex", kind: "external" });
	mb.writeNameMap(sid, { alias: "beta", hostPid: null });
	await mb.send({ from: "alice", to: "beta", body: "hello beta" });
	// check with session_id whose map says "beta" — must deliver to beta's reader
	const out = JSON.parse(
		await mb.checkHook(
			"posttooluse",
			JSON.stringify({ session_id: sid, turn_id: "t1" }),
			(msgs) => renderIncoming(msgs, "external"),
		),
	);
	if (!out.hookSpecificOutput?.additionalContext?.includes("hello beta"))
		throw new Error(`map-resolved delivery failed: ${JSON.stringify(out)}`);
	const st = JSON.parse(fs.readFileSync(path.join(box, ".state", "beta.json"), "utf8"));
	if (st.seen.length !== 1) throw new Error("watermark written under map alias");
});

await run("rename-session-carries-unread", async (box) => {
	const mb = new Mailbox(box);
	const sid = "sid-bbb";
	mb.register({ name: "codex", kind: "external", pid: 55555 }); // dead pid ok
	mb.writeNameMap(sid, { alias: "codex", hostPid: 55555 });
	// unread message addressed to the OLD name, no state yet
	await mb.send({ from: "alice", to: "codex", body: "msg before rename" });
	// rename with the codex host pid (alive in test = this process)
	const r = mb.renameSession({ from: "codex", to: "beta", hostPid: process.pid, sessionId: sid });
	if (!r.moved) throw new Error("renameReader failed");
	const map = mb.readNameMap(sid);
	if (map.alias !== "beta") throw new Error("map not updated");
	// old name released as a TOMBSTONE (era boundary for the next taker)
	const tomb = JSON.parse(fs.readFileSync(path.join(box, "sessions", "codex.json"), "utf8"));
	if (!tomb.released || tomb.pid !== 0) throw new Error(`bad tombstone: ${JSON.stringify(tomb)}`);
	if (mb.listSessions().some((x) => x.name === "codex")) throw new Error("tombstone leaked into listSessions");
	const reg = JSON.parse(fs.readFileSync(path.join(box, "sessions", "beta.json"), "utf8"));
	if (reg.pid !== process.pid) throw new Error("new registration should carry host pid");
	// unread still delivers under the NEW reader via alias history
	let got;
	await mb.deliver("beta", { limit: 5, emit: async (m) => (got = m) });
	if (!got || got[0].body !== "msg before rename")
		throw new Error("unread message did not follow the rename");
	// and messages to the new name deliver directly
	await mb.send({ from: "alice", to: "beta", body: "msg after rename" });
	let got2;
	await mb.deliver("beta", { limit: 5, emit: async (m) => (got2 = m) });
	if (!got2 || got2[0].body !== "msg after rename") throw new Error("post-rename delivery failed");
});

await run("cli-register-writes-map", async (box) => {
	// register via piped stdin (hook-style)
	const sid = "sid-ccc";
	const r = cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sid }));
	if (r.status !== 0) throw new Error(r.stderr);
	if (!fs.existsSync(path.join(box, ".names", `${sid}.json`))) throw new Error("map file missing");
	const m = JSON.parse(fs.readFileSync(path.join(box, ".names", `${sid}.json`), "utf8"));
	if (m.alias !== "codex") throw new Error(`default alias wrong: ${m.alias}`);
	// re-register with the same session (SessionStart refire): map alias wins
	const r2 = cli(
		box,
		["register", "--kind", "external", "--quiet"],
		{ CODEX_SESSION_NAME: "env-name" },
		JSON.stringify({ session_id: sid }),
	);
	if (r2.status !== 0) throw new Error(r2.stderr);
	const m2 = JSON.parse(fs.readFileSync(path.join(box, ".names", `${sid}.json`), "utf8"));
	if (m2.alias !== "codex") throw new Error("existing map must win over env");
});

await run("cli-rename-as", async (box) => {
	cli(box, ["register", "--kind", "external", "--name", "old-name"], {}, "{}");
	cli(box, ["send", "--as", "alice", "old-name", "unread before cli rename"]);
	const r = cli(box, ["rename", "--as", "old-name", "new-name"]);
	if (r.status !== 0) throw new Error(r.stderr);
	const tomb = JSON.parse(fs.readFileSync(path.join(box, "sessions", "old-name.json"), "utf8"));
	if (!tomb.released) throw new Error(`old name not tombstoned: ${JSON.stringify(tomb)}`);
	if (!fs.existsSync(path.join(box, "sessions", "new-name.json"))) throw new Error("new registration missing");
	// unread follows
	const out = cli(box, ["inbox", "--as", "new-name", "--limit", "5"]);
	if (!out.stdout.includes("unread before cli rename")) throw new Error("unread did not follow rename");
});

// ── review round 1 regressions ─────────────────────────────────

// R1: after rename, send/inbox follow the NEW identity (no --as, via CODEX_SESSION_ID)
await run("r1-unified-identity", async (box) => {
	const sid = "sid-r1";
	cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sid }));
	cli(box, ["register", "--kind", "pi", "--name", "alice-is-me"], {}, null);
	cli(box, ["rename", "--as", "codex", "beta"], { CODEX_SESSION_ID: sid });
	// send WITHOUT --as: from must be beta (map), not codex (env)
	const r = cli(box, ["send", "alice-is-me", "hi"], { CODEX_SESSION_ID: sid });
	if (r.status !== 0) throw new Error(r.stderr);
	if (!fs.readFileSync(path.join(box, "log-beta.jsonl"), "utf8").includes('"from":"beta"'))
		throw new Error("send used old identity");
	// reply-check inbox reader follows the map
	cli(box, ["send", "--as", "alice-is-me", "beta", "reply"]);
	const out = cli(box, ["inbox"], { CODEX_SESSION_ID: sid });
	if (!out.stdout.includes("reply")) throw new Error(`inbox read old mailbox: ${out.stdout}`);
	// kind lookup: beta registered external → render shows CLI guidance, not pi tools
	if (out.stdout.includes("send_session_message")) throw new Error("render gave pi guidance to a codex alias");
});

// R2: rename to the SAME name is a no-op (registration + watermark intact)
await run("r2-same-name-noop", async (box) => {
	const sid = "sid-r2";
	cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sid }));
	cli(box, ["register", "--kind", "pi", "--name", "alice-is-me"], {}, null);
	cli(box, ["send", "--as", "alice-is-me", "codex", "one"]);
	const out1 = cli(box, ["inbox"], { CODEX_SESSION_ID: sid });
	if (!out1.stdout.includes("one")) throw new Error("preread failed");
	const r = cli(box, ["rename", "codex"], { CODEX_SESSION_ID: sid });
	if (r.status !== 0) throw new Error(r.stderr);
	if (!JSON.parse(r.stdout).noop) throw new Error("same-name rename must be noop");
	if (!fs.existsSync(path.join(box, "sessions", "codex.json"))) throw new Error("registration deleted!");
	if (!fs.existsSync(path.join(box, ".state", "codex.json"))) throw new Error("watermark deleted!");
	const out2 = cli(box, ["inbox"], { CODEX_SESSION_ID: sid });
	if (out2.stdout.includes("one")) throw new Error("seen messages redelivered after noop rename");
});

// R3: a NEW session on the same host never inherits another session's name
await run("r3-no-cross-session-inheritance", async (box) => {
	const sid1 = "sid-r3a";
	const sid2 = "sid-r3b";
	// session 1 named alpha (explicit --name)
	cli(box, ["register", "--kind", "external", "--quiet", "--name", "alpha"], {}, JSON.stringify({ session_id: sid1 }));
	// session 2, SAME ancestors, explicit --name beta → must stay beta
	cli(box, ["register", "--kind", "external", "--quiet", "--name", "beta"], {}, JSON.stringify({ session_id: sid2 }));
	const m2 = JSON.parse(fs.readFileSync(path.join(box, ".names", `${sid2}.json`), "utf8"));
	if (m2.alias !== "beta") throw new Error(`session2 inherited ${m2.alias}`);
	// session 3, no name → default codex, not alpha
	const sid3 = "sid-r3c";
	cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sid3 }));
	const m3 = JSON.parse(fs.readFileSync(path.join(box, ".names", `${sid3}.json`), "utf8"));
	if (m3.alias !== "codex") throw new Error(`session3 got ${m3.alias}`);
	// but a REFIRE of session 1 (same sid) keeps its (possibly renamed) name
	cli(box, ["rename", "--as", "alpha", "alpha2"], { CODEX_SESSION_ID: sid1 }, null);
	cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sid1 }));
	const m1 = JSON.parse(fs.readFileSync(path.join(box, ".names", `${sid1}.json`), "utf8"));
	if (m1.alias !== "alpha2") throw new Error(`refire lost renamed alias: ${m1.alias}`);
});

// R4 (era semantics): a reused old name's mail NEVER transfers to the
// predecessor — not while the new owner lives, and NOT after its death either
await run("r4-old-name-reuse-isolated", async (box) => {
	const sidA = "sid-r4a";
	cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sidA }));
	cli(box, ["register", "--kind", "pi", "--name", "alice-is-me"], {}, null);
	// A-era in-flight (sent BEFORE the rename) still delivers to audit
	cli(box, ["send", "--as", "alice-is-me", "codex", "A-era in-flight"], { });
	cli(box, ["rename", "--as", "codex", "audit"], { CODEX_SESSION_ID: sidA }); // era [T0,Tr]
	let out = cli(box, ["inbox"], { CODEX_SESSION_ID: sidA });
	if (!out.stdout.includes("A-era in-flight")) throw new Error("A-era in-flight lost");
	await sleep(1100); // era boundary: second-granular — separate A's era from B's
	// a NEW session takes the freed name
	const sidB = "sid-r4b";
	cli(box, ["register", "--kind", "external", "--quiet", "--name", "codex"], {}, JSON.stringify({ session_id: sidB }));
	cli(box, ["send", "--as", "alice-is-me", "codex", "for the new codex"]);
	const outB = cli(box, ["inbox"], { CODEX_SESSION_ID: sidB });
	if (!outB.stdout.includes("for the new codex")) throw new Error("new owner did not receive");
	// audit must not see B-era mail — while B is alive…
	out = cli(box, ["inbox"], { CODEX_SESSION_ID: sidA });
	if (out.stdout.includes("for the new codex")) throw new Error("renamed session stole live owner's mail");
	// …and after B's death too (owner death NEVER transfers era-scoped mail)
	const reg = JSON.parse(fs.readFileSync(path.join(box, "sessions", "codex.json"), "utf8"));
	fs.writeFileSync(path.join(box, "sessions", "codex.json"), JSON.stringify({ ...reg, pid: 999999 }));
	fs.writeFileSync(
		path.join(box, ".names", `${sidB}.json`),
		JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(box, ".names", `${sidB}.json`), "utf8")), hostPid: 999999 }),
	);
	cli(box, ["send", "--as", "alice-is-me", "codex", "post-death for dead B"]);
	out = cli(box, ["inbox"], { CODEX_SESSION_ID: sidA });
	if (out.stdout.includes("for the new codex") || out.stdout.includes("post-death"))
		throw new Error("owner death transferred B-era mail to the predecessor");
});

// R5: concurrent renames serialize; history is never lost
await run("r5-concurrent-rename-keeps-history", async (box) => {
	const sid = "sid-r5";
	cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sid }));
	cli(box, ["register", "--kind", "pi", "--name", "alice-is-me"], {}, null);
	// IN-FLIGHT message to the ORIGINAL name, sent before any rename
	cli(box, ["send", "--as", "alice-is-me", "codex", "in-flight before renames"]);
	cli(box, ["rename", "--as", "codex", "left"], { CODEX_SESSION_ID: sid });
	// two CONCURRENT renames via the same session id (no --as): both must
	// serialize on session-<sid>; the second re-resolves and renames left→right
	const { spawn } = await import("node:child_process");
	const runRename = (to) =>
		new Promise((res) => {
			const c = spawn(process.execPath, [CLI, "rename", to], {
				env: { ...process.env, MAILBOX_DIR: box, CODEX_SESSION_ID: sid },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			c.stdout.on("data", (d) => (out += d));
			c.on("exit", (code) => res({ code, out }));
		});
	const [a, b] = await Promise.all([runRename("mid"), runRename("right")]);
	if (a.code !== 0 || b.code !== 0) throw new Error(`rename exits: ${a.code},${b.code}`);
	const finalMap = JSON.parse(fs.readFileSync(path.join(box, ".names", `${sid}.json`), "utf8"));
	if (!["mid", "right"].includes(finalMap.alias)) throw new Error(`final alias: ${finalMap.alias}`);
	// history must contain the full chain incl. the first rename's result
	const st = JSON.parse(fs.readFileSync(path.join(box, ".state", `${finalMap.alias}.json`), "utf8"));
	const chain = new Set([...Object.keys(st.eras || {}), ...(st.aliases || []), finalMap.alias]);
	for (const need of ["codex", "left", "mid", "right"])
		if (!chain.has(need)) throw new Error(`history lost ${need}: ${JSON.stringify(st.aliases)}`);
	// a historical alias renamed AWAY is no longer addressable by NEW sends
	const deadSend = cli(box, ["send", "--as", "alice-is-me", "left", "should fail"]);
	if (deadSend.status === 0) throw new Error("send to unregistered historical alias must fail");
	// the in-flight message must arrive through the full rename chain
	const out = cli(box, ["inbox"], { CODEX_SESSION_ID: sid });
	if (!out.stdout.includes("in-flight before renames"))
		throw new Error(
			`in-flight mail not delivered through chain; state=${fs.readFileSync(path.join(box, ".state", `${finalMap.alias}.json`), "utf8").slice(0, 300)}`,
		);
});

// R6 (review2 #1): B's already-consumed task is NOT re-delivered to A after
// B exits — era bounds, not owner liveness, decide ownership of messages
await run("r6-no-transfer-on-owner-death", async (box) => {
	const sidA = "sid-r6a";
	cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sidA }));
	cli(box, ["register", "--kind", "pi", "--name", "alice-is-me"], {}, null);
	cli(box, ["rename", "--as", "codex", "audit"], { CODEX_SESSION_ID: sidA });
	await sleep(1100); // era boundary separation
	const sidB = "sid-r6b";
	cli(box, ["register", "--kind", "external", "--quiet", "--name", "codex"], {}, JSON.stringify({ session_id: sidB }));
	cli(box, ["dispatch", "--as", "alice-is-me", "codex", "task for B"]);
	// B consumes the task
	let outB = cli(box, ["inbox"], { CODEX_SESSION_ID: sidB });
	if (!outB.stdout.includes("task for B")) throw new Error("B did not receive its task");
	// B exits (registration + map dead)
	const reg = JSON.parse(fs.readFileSync(path.join(box, "sessions", "codex.json"), "utf8"));
	fs.writeFileSync(path.join(box, "sessions", "codex.json"), JSON.stringify({ ...reg, pid: 999999 }));
	fs.writeFileSync(
		path.join(box, ".names", `${sidB}.json`),
		JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(box, ".names", `${sidB}.json`), "utf8")), hostPid: 999999 }),
	);
	// A scans: must NOT receive B's consumed task (deterministic, not a race)
	const outA = cli(box, ["inbox"], { CODEX_SESSION_ID: sidA });
	if (outA.stdout.includes("task for B")) throw new Error("B's consumed task re-delivered to A");
});

// R7 (review2 #2): same-host sessions cannot steal each other's names
await run("r7-no-cross-session-name-steal", async (box) => {
	const sidA = "sid-r7a";
	const sidB = "sid-r7b";
	// session A named alpha, map hostPid = THIS live test process
	cli(box, ["register", "--kind", "external", "--quiet", "--name", "alpha"], {}, JSON.stringify({ session_id: sidA }));
	cli(box, ["register", "--kind", "external", "--quiet", "--name", "beta"], {}, JSON.stringify({ session_id: sidB }));
	// simulate live codex hosts for both sessions (test env has none)
	for (const sid of [sidA, sidB]) {
		const mp = path.join(box, ".names", `${sid}.json`);
		fs.writeFileSync(mp, JSON.stringify({ ...JSON.parse(fs.readFileSync(mp, "utf8")), hostPid: process.pid }));
	}
	const bad = cli(box, ["rename", "alpha"], { CODEX_SESSION_ID: sidB });
	if (bad.status === 0) throw new Error("session B stole session A's name via rename");
	// and direct register --name alpha from session B also fails
	const bad2 = cli(box, ["register", "--kind", "external", "--name", "alpha"], {}, JSON.stringify({ session_id: sidB }));
	if (bad2.status === 0) throw new Error("session B stole session A's name via register");
	// maps unchanged: A still alpha, B still beta
	const mA = JSON.parse(fs.readFileSync(path.join(box, ".names", `${sidA}.json`), "utf8"));
	const mB = JSON.parse(fs.readFileSync(path.join(box, ".names", `${sidB}.json`), "utf8"));
	if (mA.alias !== "alpha" || mB.alias !== "beta")
		throw new Error(`maps corrupted: ${JSON.stringify([mA, mB])}`);
	// same-session refire stays idempotent
	cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sidA }));
	const mA2 = JSON.parse(fs.readFileSync(path.join(box, ".names", `${sidA}.json`), "utf8"));
	if (mA2.alias !== "alpha") throw new Error("idempotent refire broke the map");
});

// R8 (review2 #3): B-era in-flight follows B's rename with NO new log writes —
// cache cannot hide it; and it never leaks to A
await run("r8-era-follows-rename-no-cache-dependency", async (box) => {
	const sidA = "sid-r8a";
	cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sidA }));
	cli(box, ["register", "--kind", "pi", "--name", "alice-is-me"], {}, null);
	cli(box, ["rename", "--as", "codex", "audit"], { CODEX_SESSION_ID: sidA });
	await sleep(1100); // era boundary separation
	const sidB = "sid-r8b";
	cli(box, ["register", "--kind", "external", "--quiet", "--name", "codex"], {}, JSON.stringify({ session_id: sidB }));
	// prime A's cache with an empty scan
	let outA = cli(box, ["inbox"], { CODEX_SESSION_ID: sidA });
	// B-era message arrives
	cli(box, ["send", "--as", "alice-is-me", "codex", "B-era in-flight"]);
	// B renames away — NO further log writes happen afterwards
	cli(box, ["rename", "carol"], { CODEX_SESSION_ID: sidB });
	// A (whose cache matches: same logs) must not get B-era mail
	outA = cli(box, ["inbox"], { CODEX_SESSION_ID: sidA });
	if (outA.stdout.includes("B-era in-flight")) throw new Error("B-era mail leaked to A");
	// carol receives it through her own era — without any new log writes
	const outC = cli(box, ["inbox"], { CODEX_SESSION_ID: sidB });
	if (!outC.stdout.includes("B-era in-flight")) throw new Error("era handover lost B's in-flight mail");
});

// R9 (review2 #4): stdin-only identity (no CODEX_SESSION_ID env) renders the
// map reader's capability, not the env fallback's
await run("r9-stdin-identity-render", async (box) => {
	const sid = "sid-r9";
	cli(box, ["register", "--kind", "external", "--quiet"], {}, JSON.stringify({ session_id: sid }));
	cli(box, ["rename", "--as", "codex", "beta"], { CODEX_SESSION_ID: sid });
	cli(box, ["register", "--kind", "pi", "--name", "alice-is-me"], {}, null);
	cli(box, ["send", "--as", "alice-is-me", "beta", "render check"]);
	// NO CODEX_SESSION_ID in env — identity comes from stdin session_id only
	const r = cli(
		box,
		["check", "--mode", "posttooluse"],
		{ MAILBOX_ALIAS: "" }, // ensure env chain does NOT know the map alias
		JSON.stringify({ session_id: sid, turn_id: "t1" }),
	);
	if (r.status !== 0) throw new Error(r.stderr);
	const out = JSON.parse(r.stdout);
	const ctx = out.hookSpecificOutput?.additionalContext ?? "";
	if (!ctx.includes("render check")) throw new Error("message not delivered via stdin identity");
	if (ctx.includes("report_task_result") || ctx.includes("send_session_message"))
		throw new Error(`pi-tool guidance rendered for an external reader: ${ctx.slice(0, 200)}`);
	if (!ctx.includes("mailbox")) throw new Error("expected CLI guidance for external reader");
});

const failed = results.filter((r) => r.status === "fail").length;
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
console.log(JSON.stringify({ results }, null, 2));
process.exit(failed === 0 ? 0 : 1);
