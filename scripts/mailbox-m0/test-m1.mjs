#!/usr/bin/env node
/**
 * test-m1.mjs — M1 regression: pi-extension-facing behaviors at core level.
 *
 * Covers what pi -p smoke cannot: /msg-name rename with watermark carry,
 * busy/idle registration flips, legacy migration, pi-guidance rendering.
 * The real pi↔pi dispatch/report/busy-queue loop was verified live
 * (see docs/mailbox-m1-report.md); this suite is the repeatable part.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Mailbox } from "../../shared/mailbox/core.mjs";
import { renderIncoming } from "../../shared/mailbox/protocol.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const MIGRATE = path.join(ROOT, "scripts", "mailbox-migrate.mjs");
const results = [];
const tests = [];
function run(name, fn) {
	tests.push([name, fn]);
}
async function main() {
	for (const [name, fn] of tests) {
		const box = fs.mkdtempSync(path.join(os.tmpdir(), `m1-${name}-`));
		try {
			await fn(box);
			results.push({ name, status: "pass" });
			console.log(`PASS ${name}`);
		} catch (e) {
			results.push({ name, status: "fail", error: String(e.message || e) });
			console.log(`FAIL ${name}: ${e.message}`);
		}
	}
	const failed = results.filter((r) => r.status === "fail").length;
	console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
	process.exit(failed === 0 ? 0 : 1);
}

// 1) dispatch → deliver(pi render) → busy flip → report → idle flip → result render
run("pi-flow-dispatch-report", async (box) => {
	const mb = new Mailbox(box);
	mb.register({ name: "boss", kind: "pi", pid: process.pid });
	mb.register({ name: "worker", kind: "pi", pid: process.pid });
	await mb.send({ from: "boss", to: "worker", body: "审计 net/", type: "task", taskId: "t-abc" });
	// worker polls: task arrives
	let got;
	await mb.deliver("worker", {
		limit: 20,
		emit: async (msgs) => {
			got = msgs;
			// extension flips busy on task delivery
			mb.updateSession("worker", { state: "busy", busyTaskId: msgs[0].taskId });
		},
	});
	if (!got || got[0].type !== "task" || got[0].taskId !== "t-abc") throw new Error("task not delivered");
	const reg = JSON.parse(fs.readFileSync(path.join(box, "sessions", "worker.json"), "utf8"));
	if (reg.state !== "busy" || reg.busyTaskId !== "t-abc") throw new Error("busy flip failed");
	// pi render must point at report_task_result (receiver capability = pi)
	const text = renderIncoming(got, "pi");
	if (!text.includes("report_task_result") || !text.includes("t-abc"))
		throw new Error("pi task render missing report guidance");
	// worker reports; extension flips idle
	await mb.send({ from: "worker", to: "boss", body: "done", type: "result", taskId: "t-abc" });
	mb.updateSession("worker", { state: "idle", busyTaskId: undefined });
	const reg2 = JSON.parse(fs.readFileSync(path.join(box, "sessions", "worker.json"), "utf8"));
	if (reg2.state !== "idle" || reg2.busyTaskId !== undefined) throw new Error("idle flip failed");
	// boss receives the result
	let res;
	await mb.deliver("boss", { limit: 20, emit: async (m) => (res = m) });
	if (!res || res[0].type !== "result" || res[0].taskId !== "t-abc") throw new Error("result not delivered");
	const rt = renderIncoming(res, "pi");
	if (!rt.includes("t-abc") || !rt.includes("worker")) throw new Error("result render wrong");
});

// 2) /msg-name rename: watermark carries, unread survives, old name freed
run("rename-carries-watermark", async (box) => {
	const mb = new Mailbox(box);
	mb.register({ name: "worker", kind: "pi", pid: process.pid });
	await mb.send({ from: "boss", to: "worker", body: "msg one" });
	await mb.send({ from: "boss", to: "worker", body: "msg two" });
	// read one as old name
	let got;
	await mb.deliver("worker", { limit: 1, emit: async (m) => (got = m) });
	if (got.length !== 1) throw new Error("first read failed");
	// rename (extension logic): register new + move state + free old
	mb.register({ name: "kernel-worker", kind: "pi", pid: process.pid });
	if (!mb.renameReader("worker", "kernel-worker")) throw new Error("renameReader failed");
	mb.unregisterOwnedBy(process.pid, { except: "kernel-worker" });
	// only the unread message should arrive for the new name
	let got2;
	await mb.deliver("kernel-worker", { limit: 20, emit: async (m) => (got2 = m) });
	if (got2.length !== 1 || got2[0].body !== "msg two") throw new Error(`after rename got ${got2.length}, want 1 unread`);
});

// 3) legacy migration
run("legacy-migration", async (box) => {
	// build a legacy mailbox
	const sess = path.join(box, "sessions");
	const inb = path.join(box, "inboxes", "01a0bb01-7764-7056-8563-d0c8427f538d");
	fs.mkdirSync(sess, { recursive: true });
	fs.mkdirSync(inb, { recursive: true });
	fs.writeFileSync(
		path.join(sess, "01a0bb01-7764-7056-8563-d0c8427f538d.json"),
		JSON.stringify({
			id: "01a0bb01-7764-7056-8563-d0c8427f538d",
			name: "main",
			pid: 1,
			cwd: "/tmp",
			sessionFile: "/tmp/x.jsonl",
			state: "idle",
		}),
	);
	fs.writeFileSync(
		path.join(sess, "02b1cc02-dead-beef.json"),
		JSON.stringify({ id: "02b1cc02-dead-beef", name: "old-worker", pid: 2, cwd: "/tmp" }),
	);
	const msg = (fromId, fromName, type, taskId, text, ts) =>
		JSON.stringify({ fromId, fromName, type, taskId, text, ts }) + "\n";
	fs.writeFileSync(
		path.join(inb, "1690000000000-aaa.json"),
		msg("02b1cc02-dead-beef", "old-worker", "chat", undefined, "hi from legacy 中文", 1690000000000),
	);
	fs.writeFileSync(
		path.join(inb, "1690000001000-bbb.json"),
		msg("02b1cc02-dead-beef", "old-worker", "task", "t-legacy-1", "旧任务", 1690000001000),
	);
	fs.writeFileSync(path.join(inb, "1690000002000-broken.json"), "{not json");
	// a NEW-format registration must survive
	fs.writeFileSync(path.join(sess, "newera.json"), JSON.stringify({ name: "newera", kind: "external", pid: 1 }));

	const r = spawnSync(process.execPath, [MIGRATE, box], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`migrate failed: ${r.stderr}`);
	const log = fs.readFileSync(path.join(box, "log-old-worker.jsonl"), "utf8").split("\n").filter((l) => l);
	if (log.length !== 2) throw new Error(`want 2 migrated records, got ${log.length}`);
	const m1 = JSON.parse(log[0]);
	const m2 = JSON.parse(log[1]);
	if (m1.to !== "main" || m1.from !== "old-worker" || m1.body !== "hi from legacy 中文")
		throw new Error("chat record wrong");
	if (m2.type !== "task" || m2.taskId !== "t-legacy-1" || m2.ts !== 1690000001)
		throw new Error("task record wrong (type/taskId/ts)");
	// unread: no state file for main
	if (fs.existsSync(path.join(box, ".state", "main.json"))) throw new Error("migrated must be unread");
	// legacy registrations removed, new-format kept
	const left = fs.readdirSync(sess);
	if (!left.includes("newera.json") || left.some((f) => f.startsWith("01a0bb01") || f.startsWith("02b1cc02")))
		throw new Error(`registration cleanup wrong: ${left.join(",")}`);
	// backup created
	const backs = fs.readdirSync(path.dirname(box)).filter((f) => f.includes(".bak-"));
	if (backs.length === 0) throw new Error("no backup dir");
	// delivered to main after migration
	const mb = new Mailbox(box);
	let got;
	await mb.deliver("main", { limit: 20, emit: async (m) => (got = m) });
	if (got.length !== 2) throw new Error(`main should read 2 migrated, got ${got.length}`);
});

// 4) self-contained install: extension imports resolve from the plugin dir
run("plugin-self-contained", async () => {
	const ext = path.join(ROOT, "plugins", "session-messaging", "index.ts");
	const src = fs.readFileSync(ext, "utf8");
	if (!src.includes("./src/shared/core.mjs")) throw new Error("index must import bundled shared core");
	for (const f of ["core.mjs", "protocol.mjs"]) {
		if (!fs.existsSync(path.join(ROOT, "plugins", "session-messaging", "src", "shared", f)))
			throw new Error(`missing bundled ${f}`);
	}
	// checksums match the source of truth
	const chk = fs.readFileSync(path.join(ROOT, "plugins", "session-messaging", "src", "shared", ".checksums"), "utf8");
	for (const line of chk.split("\n").filter((l) => l)) {
		const [want] = line.split(" ");
		const f = line.trim().split(/\s+/)[1];
		const got = spawnSync("sha256sum", [path.join(ROOT, "shared", "mailbox", f)], { encoding: "utf8" })
			.stdout.trim().split(/\s+/)[0];
		if (want !== got) throw new Error(`checksum drift for ${f}: run scripts/sync-shared.sh`);
	}
});

void main();
