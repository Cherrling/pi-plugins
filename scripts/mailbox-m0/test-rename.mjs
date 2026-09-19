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
	if (fs.existsSync(path.join(box, "sessions", "codex.json")))
		throw new Error("old registration not removed (hostPid match)");
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
	if (fs.existsSync(path.join(box, "sessions", "old-name.json"))) throw new Error("old registration left");
	if (!fs.existsSync(path.join(box, "sessions", "new-name.json"))) throw new Error("new registration missing");
	// unread follows
	const out = cli(box, ["inbox", "--as", "new-name", "--limit", "5"]);
	if (!out.stdout.includes("unread before cli rename")) throw new Error("unread did not follow rename");
});

const failed = results.filter((r) => r.status === "fail").length;
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
console.log(JSON.stringify({ results }, null, 2));
process.exit(failed === 0 ? 0 : 1);
