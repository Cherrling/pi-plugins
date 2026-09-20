#!/usr/bin/env node
/**
 * mailbox-cli.mjs — single-file CLI over shared/mailbox/core.mjs.
 * Zero npm deps; node >= 18.
 *
 * Commands:
 *   register --name <alias> [--kind pi|external]
 *   list
 *   send     <to> <text...>            chat message
 *   dispatch <to> <task...>            task message, prints taskId
 *   report   <to> <taskId> <result...> result message
 *   inbox    [--limit N] [--json]      deliver pending (rendered or JSONL)
 *   check    --mode stop|posttooluse   codex hooks entry, reads stdin JSON
 *   replay   <id> | --all              force redelivery
 *   whoami
 *
 * Identity: --as <alias> > MAILBOX_ALIAS > CODEX_SESSION_NAME > "codex".
 * Hooks inherit the codex process env, so launching codex with
 * CODEX_SESSION_NAME=<name> names its mailbox without any shell expansion
 * in hooks.json. Unresolvable identity or an ambiguous recipient is a hard
 * error — never write to the wrong box.
 */

import fs from "node:fs";
import { Mailbox, findCodexHostPid } from "../shared/mailbox/core.mjs";
import { newTaskId, renderIncoming } from "../shared/mailbox/protocol.mjs";

const VALUE_FLAGS = new Set(["--as", "--name", "--kind", "--limit", "--mode", "--pid"]);

function parse(argv) {
	const flags = {};
	const pos = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--all") {
			flags.all = true;
		} else if (a === "--json") {
			flags.json = true;
		} else if (a.startsWith("--") && VALUE_FLAGS.has(a)) {
			flags[a.slice(2)] = argv[++i];
		} else if (a.startsWith("--")) {
			flags[a.slice(2)] = true;
		} else {
			pos.push(a);
		}
	}
	return { flags, pos };
}

function fail(msg) {
	process.stderr.write(`mailbox: ${msg}\n`);
	process.exit(1);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const { flags, pos } = parse(argv.slice(1));

const mb = new Mailbox();

/**
 * Unified identity resolution (post-rename consistent across ALL commands):
 *   --as > session-name map[CODEX_SESSION_ID] > MAILBOX_ALIAS > CODEX_SESSION_NAME > "codex"
 * The map is what `mailbox rename` updates, so send/inbox/report/check/whoami
 * all follow a rename immediately. No ancestor-pid inference: the same codex
 * host can run multiple sessions (M0 finding), so pid continuity is unsound.
 */
function resolveIdentity() {
	const sid = process.env.CODEX_SESSION_ID || null;
	const mapEntry = sid ? mb.readNameMap(sid) : null;
	return {
		alias:
			flags.as ||
			mapEntry?.alias ||
			process.env.MAILBOX_ALIAS ||
			process.env.CODEX_SESSION_NAME ||
			"codex",
		sessionId: sid,
		hostPid: findCodexHostPid(),
		mapEntry,
	};
}

function requireAlias() {
	return resolveIdentity().alias;
}

async function main() {
	switch (cmd) {
		case "register": {
			// SessionStart hook context: stdin carries {session_id, ...}.
			// Identity priority: existing session-name map (rename wins over
			// env) > --name > MAILBOX_ALIAS > CODEX_SESSION_NAME > "codex".
			let sessionId = null;
			try {
				if (!process.stdin.isTTY) {
					const s = fs.readFileSync(0, "utf8");
					sessionId = JSON.parse(s)?.session_id ?? null;
				}
			} catch {}
			const hostPid = findCodexHostPid();
			// same-session refire keeps the renamed alias; a NEW session_id
			// never inherits by host pid (multi-session hosts, M0 finding)
			const existing = mb.readNameMap(sessionId);
			const name = flags.name || existing?.alias || process.env.MAILBOX_ALIAS ||
				process.env.CODEX_SESSION_NAME || "codex";
			const pid = flags.pid ? Number(flags.pid) : hostPid || process.pid;
			const reg = mb.register({ name, kind: flags.kind || "external", pid });
			if (sessionId) mb.writeNameMap(sessionId, { alias: name, hostPid });
			// hooks parse stdout as hook-output JSON — keep it empty unless asked
			if (flags.quiet) process.stderr.write(`mailbox: registered ${reg.name}\n`);
			else console.log(JSON.stringify(reg));
			break;
		}
		case "list": {
			console.log(
				JSON.stringify(
					mb.listSessions().map((s) => ({
						name: s.name,
						kind: s.kind,
						alive: s.alive,
						lastSeen: new Date(s.lastSeen).toISOString(),
						cwd: s.cwd,
					})),
					null,
					2,
				),
			);
			break;
		}
		case "send":
		case "dispatch":
		case "report": {
			const me = requireAlias();
			const to = mb.resolveTarget(pos[0]);
			if (cmd === "dispatch") {
				const taskId = newTaskId();
				const msg = await mb.send({
					from: me,
					to,
					body: pos.slice(1).join(" "),
					type: "task",
					taskId,
				});
				console.log(JSON.stringify({ taskId, id: msg.id, to }));
			} else if (cmd === "report") {
				const taskId = pos[1];
				if (!taskId) fail("report requires: <to> <taskId> <result...>");
				const msg = await mb.send({
					from: me,
					to,
					body: pos.slice(2).join(" "),
					type: "result",
					taskId,
				});
				console.log(JSON.stringify({ reported: taskId, id: msg.id, to }));
			} else {
				// MAILBOX_SEND_LOOP (test hook): repeat N sends with indexed bodies
				const loop = Number(process.env.MAILBOX_SEND_LOOP || 1);
				let last;
				for (let i = 0; i < loop; i++) {
					last = await mb.send({
						from: me,
						to,
						body: loop > 1 ? `${pos.slice(1).join(" ")} #${i}` : pos.slice(1).join(" "),
						type: "chat",
					});
					if (last.isolatedBadTail)
						process.stderr.write(`mailbox: isolated a residual bad tail in log-${me}.jsonl\n`);
				}
				console.log(
					JSON.stringify({ id: last.id, to, count: loop, ...(last.isolatedBadTail ? { isolatedBadTail: true } : {}) }),
				);
			}
			break;
		}
		case "inbox": {
			const me = requireAlias();
			const limit = Number(flags.limit || 2);
			const emitFile = process.env.MAILBOX_EMIT_FILE;
			let renderKind = mb.receiverKind(me);
			const res = await mb.deliver(me, {
				limit,
				emit: async (msgs, remaining) => {
					const text = renderIncoming(msgs, renderKind);
					const hint = remaining > 0 ? `\n\n[另有 ${remaining} 条待投递]` : "";
					if (emitFile) {
						fs.appendFileSync(emitFile, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
					} else if (flags.json) {
						console.log(msgs.map((m) => JSON.stringify(m)).join("\n"));
					} else {
						console.log(text + hint);
					}
				},
			});
			if (emitFile)
				fs.appendFileSync(
					emitFile,
					JSON.stringify({ meta: true, remaining: res.remaining, shortcut: res.shortcut }) + "\n",
				);
			else if (res.messages.length === 0) console.log("no new messages");
			break;
		}
		case "check": {
			const mode = flags.mode;
			if (mode !== "stop" && mode !== "posttooluse") fail("--mode stop|posttooluse required");
			let stdin = "";
			try {
				stdin = fs.readFileSync(0, "utf8");
			} catch {} // closed stdin → fail-open inside checkHook
			const me = requireAlias();
			const out = await mb.checkHook(
				mode,
				stdin,
				(msgs) => renderIncoming(msgs, mb.receiverKind(me)),
				me,
			);
			process.stdout.write(out + "\n");
			break;
		}
		case "replay": {
			const me = requireAlias();
			const r = flags.all
				? await mb.replay(me, { all: true })
				: pos[0]
					? await mb.replay(me, { ids: [pos[0]] })
					: fail("replay requires <id> or --all");
			console.log(JSON.stringify(r));
			break;
		}
		case "rename": {
			const to = pos[0];
			if (!to) fail("rename requires: <new-alias>  (或 --as <当前别名> <新别名>)");
			// Serialize per session (or per explicit --as) and RE-RESOLVE the
			// identity inside the lock: a concurrent rename that lands first
			// must be visible, otherwise the second migration loses history.
			const sid = process.env.CODEX_SESSION_ID || null;
			const lockName = sid ? `session-${sid}` : `session-as-${flags.as || "?"}`;
			const r = await mb.withLock(lockName, () => {
				let from = flags.as || null;
				let sessionId = sid;
				let hostPid = findCodexHostPid();
				const found = sid ? mb.readNameMap(sid) : null;
				if (found) {
					hostPid = hostPid || found.hostPid;
					if (!from) from = found.alias;
				}
				if (!from)
					from = process.env.MAILBOX_ALIAS || process.env.CODEX_SESSION_NAME || null;
				if (!from) fail("cannot determine current alias — 在 codex 会话内运行，或用 --as <当前别名>");
				return mb.renameSession({ from, to, hostPid, sessionId });
			});
			if (r.noop) process.stderr.write(`mailbox: already named "${r.to}"\n`);
			else process.stderr.write(`mailbox: renamed ${r.from} -> ${r.to} (未读消息跟随)\n`);
			console.log(JSON.stringify(r));
			break;
		}
		case "whoami": {
			const id = resolveIdentity();
			console.log(JSON.stringify({ alias: id.alias }));
			break;
		}
		default:
			fail(`unknown command: ${cmd ?? "(none)"}`);
	}
}

main().catch((e) => fail(e.message));
