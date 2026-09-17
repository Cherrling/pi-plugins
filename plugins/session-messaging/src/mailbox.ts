/**
 * mailbox.ts — pure data layer: registration directory, heartbeat,
 * liveness, and inbox read/write. No pi API dependency.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Message } from "./protocol.js";

export const MAILBOX_DIR = path.join(os.homedir(), ".pi", "agent", "mailbox");
export const SESSIONS_DIR = path.join(MAILBOX_DIR, "sessions");
export const INBOXES_DIR = path.join(MAILBOX_DIR, "inboxes");
export const HEARTBEAT_MS = 5000;
export const STALE_MS = 20000;
export const POLL_MS = 3000;

/** Session state, maintained by the owner session itself. */
export type SessionState = "idle" | "busy";

export interface Registration {
	id: string;
	name: string;
	pid: number;
	cwd: string;
	sessionFile: string;
	startedAt: number;
	/** current task id while working on one (mutated via updateRegistration) */
	busyTaskId?: string;
	state?: SessionState;
}

export function ensureDirs() {
	fs.mkdirSync(SESSIONS_DIR, { recursive: true });
	fs.mkdirSync(INBOXES_DIR, { recursive: true });
}

export function regPath(id: string) {
	return path.join(SESSIONS_DIR, `${id}.json`);
}

export function inboxDir(id: string) {
	return path.join(INBOXES_DIR, id);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Read all registrations; clean up dead ones (no heartbeat update + pid gone). */
export function listSessions(): Registration[] {
	ensureDirs();
	const out: Registration[] = [];
	for (const f of fs.readdirSync(SESSIONS_DIR)) {
		if (!f.endsWith(".json")) continue;
		const p = path.join(SESSIONS_DIR, f);
		try {
			const reg = JSON.parse(fs.readFileSync(p, "utf8")) as Registration;
			const fresh = Date.now() - fs.statSync(p).mtimeMs < STALE_MS;
			if (fresh || pidAlive(reg.pid)) {
				out.push(reg);
			} else {
				fs.unlinkSync(p);
				fs.rmSync(inboxDir(reg.id), { recursive: true, force: true });
			}
		} catch {
			/* ignore corrupt files */
		}
	}
	return out;
}

/** Find a session by name (exact/prefix) or id prefix. Prefer exact name. */
export function resolveTarget(query: string): Registration | null {
	const sessions = listSessions();
	const q = query.toLowerCase();
	const matches = sessions.filter(
		(s) =>
			s.name.toLowerCase() === q ||
			s.id.toLowerCase().startsWith(q) ||
			s.name.toLowerCase().startsWith(q),
	);
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		const exact = matches.find(
			(s) => s.name.toLowerCase() === q || s.id.toLowerCase() === q,
		);
		return exact ?? matches[0];
	}
	return matches[0];
}

/** Touch registration mtime; metadata-only so renames can't be clobbered. */
export function heartbeat(id: string) {
	if (!id) return;
	try {
		const now = new Date();
		fs.utimesSync(regPath(id), now, now);
	} catch {
		/* not registered yet / already shut down */
	}
}

/** Read-modify-write this session's registration (rename, state change...). */
export function updateRegistration(id: string, patch: Partial<Registration>) {
	const p = regPath(id);
	const reg = JSON.parse(fs.readFileSync(p, "utf8")) as Registration;
	Object.assign(reg, patch);
	fs.writeFileSync(p, JSON.stringify(reg, null, 2));
}

/** Drop a message into a session's inbox. Returns the message with taskId. */
export function deliver(
	target: Registration,
	msg: Omit<Message, "ts">,
): Message {
	const full: Message = { ...msg, ts: Date.now() };
	const dir = inboxDir(target.id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${full.ts}-${Math.random().toString(36).slice(2, 8)}.json`),
		JSON.stringify(full),
	);
	return full;
}

/** Consume and return all pending messages for a session (oldest first). */
export function drainInbox(id: string): Message[] {
	if (!id) return [];
	const dir = inboxDir(id);
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	files.sort();
	const out: Message[] = [];
	for (const f of files) {
		const p = path.join(dir, f);
		try {
			out.push(JSON.parse(fs.readFileSync(p, "utf8")) as Message);
			fs.unlinkSync(p); // consume first; avoid double delivery
		} catch {
			/* skip unreadable files */
		}
	}
	return out;
}

export function unregister(id: string) {
	try {
		fs.unlinkSync(regPath(id));
	} catch {}
	fs.rmSync(inboxDir(id), { recursive: true, force: true });
}
