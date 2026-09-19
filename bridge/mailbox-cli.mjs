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
 * Identity: --as <alias> or MAILBOX_ALIAS. Unresolvable identity or an
 * ambiguous recipient is a hard error — never write to the wrong box.
 */

import fs from "node:fs";
import { Mailbox } from "../shared/mailbox/core.mjs";
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

const alias = flags.as || process.env.MAILBOX_ALIAS;
const mb = new Mailbox();

function requireAlias() {
	if (!alias) fail("no identity: pass --as <alias> or set MAILBOX_ALIAS");
	return alias;
}

async function main() {
	switch (cmd) {
		case "register": {
			const name = flags.name || requireAlias();
			const pid = flags.pid ? Number(flags.pid) : process.pid;
			console.log(
				JSON.stringify(mb.register({ name, kind: flags.kind || "external", pid })),
			);
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
		case "whoami": {
			console.log(JSON.stringify({ alias: alias ?? null }));
			break;
		}
		default:
			fail(`unknown command: ${cmd ?? "(none)"}`);
	}
}

main().catch((e) => fail(e.message));
