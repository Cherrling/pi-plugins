#!/usr/bin/env node
/**
 * mailbox-migrate.mjs — one-shot migration: legacy inbox format → SAMP logs.
 *
 * Legacy layout (session-messaging ≤ old plugin):
 *   <dir>/sessions/<uuid>.json     Registration {id, name, pid, ...}
 *   <dir>/inboxes/<uuid>/*.json    Message {fromId, fromName, type, taskId?, text, ts}
 *
 * Target layout (mailbox-core v6.2):
 *   <dir>/log-<alias>.jsonl        append-only records
 *
 * - Recipient alias comes from the inbox directory's registration name.
 * - Sender alias comes from the message's fromName (registered at the time).
 * - All migrated messages are UNREAD (legacy inbox only ever held unread).
 * - Old-format registrations are removed; sessions re-register on restart.
 *   New-format registrations (log era, have `kind`) are left untouched.
 * - Refuses to run if any log-*.jsonl already exists (unless --force).
 * - Backs up the mailbox dir to <dir>.bak-<ts> before touching anything.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Mailbox, ALIAS_RE } from "../shared/mailbox/core.mjs";
import { buildMessage } from "../shared/mailbox/protocol.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const dir = args.find((a) => !a.startsWith("--")) || process.env.MAILBOX_DIR ||
	path.join(os.homedir(), ".pi", "agent", "mailbox");

if (!fs.existsSync(dir)) {
	console.error(`mailbox dir not found: ${dir}`);
	process.exit(1);
}
const existingLogs = fs.readdirSync(dir).filter((f) => /^log-.*\.jsonl$/.test(f));
if (existingLogs.length > 0 && !force) {
	console.error(`refusing: log files already exist (${existingLogs.join(", ")}). Pass --force to append anyway.`);
	process.exit(1);
}

// backup
const backup = `${dir}.bak-${Date.now()}`;
fs.cpSync(dir, backup, { recursive: true });
console.log(`backup: ${backup}`);

const mb = new Mailbox(dir);
const sessionsDir = path.join(dir, "sessions");
const inboxesDir = path.join(dir, "inboxes");

// old registrations: uuid-named files WITHOUT `kind` field
const regs = new Map(); // id -> reg
const legacyFiles = [];
for (const f of fs.readdirSync(sessionsDir)) {
	if (!f.endsWith(".json")) continue;
	const p = path.join(sessionsDir, f);
	let reg;
	try {
		reg = JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		continue;
	}
	if (reg.kind) continue; // new format, leave it
	regs.set(reg.id, reg);
	legacyFiles.push(p);
}

const aliasOf = (id) => {
	const reg = regs.get(id);
	const name = reg?.name || (typeof id === "string" ? id.slice(0, 8) : "unknown");
	return ALIAS_RE.test(name) ? name : null;
};

let migrated = 0,
	skipped = 0;
if (fs.existsSync(inboxesDir)) {
	for (const id of fs.readdirSync(inboxesDir)) {
		const inbox = path.join(inboxesDir, id);
		if (!fs.statSync(inbox).isDirectory()) continue;
		const to = aliasOf(id);
		const files = fs.readdirSync(inbox).filter((f) => f.endsWith(".json")).sort();
		for (const f of files) {
			let msg;
			try {
				msg = JSON.parse(fs.readFileSync(path.join(inbox, f), "utf8"));
			} catch {
				skipped++;
				continue;
			}
			const from = msg.fromName && ALIAS_RE.test(msg.fromName) ? msg.fromName : aliasOf(msg.fromId);
			if (!from || !to) {
				skipped++;
				continue;
			}
			// rebuild as a SAMP record; recompute id (content-addressed)
			const rec = buildMessage({
				from,
				to,
				body: msg.text ?? "",
				type: msg.type === "task" || msg.type === "result" ? msg.type : "chat",
				taskId: msg.taskId,
			});
			rec.ts = msg.ts ? Math.floor(msg.ts / 1000) : rec.ts; // legacy ms → s
			// append directly (bypass send(): no locks needed for a fresh log,
			// and body cap does not apply to historical content)
			const line = JSON.stringify(rec) + "\n";
			fs.appendFileSync(path.join(dir, `log-${from}.jsonl`), line);
			migrated++;
		}
	}
}

// remove legacy registrations (message logs and state stay untouched)
for (const p of legacyFiles) fs.unlinkSync(p);

console.log(`migrated ${migrated} message(s), skipped ${skipped}, removed ${legacyFiles.length} legacy registration(s)`);
console.log(`done. old inboxes/ left in place (empty them manually if desired); backup at ${backup}`);
