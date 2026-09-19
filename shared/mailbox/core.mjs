/**
 * core.mjs — formal mailbox-core (v6.2 plan §2–§6).
 *
 * Storage (SAMP-compatible):
 *   <dir>/log-<alias>.jsonl        append-only, one file per sender, never deleted
 *   <dir>/.state/<reader>.json     {seen[], backlog, cache, block} — one bundle,
 *                                  committed atomically under the reader lock
 *   <dir>/files/<sha>.txt          persistent attachments (long bodies)
 *   <dir>/sessions/<alias>.json    registry (name/kind/pid/cwd), no auto-cleanup
 *   <dir>/.locks/                  mkdir-locks with pid owner; dead owner is stolen
 *
 * Write rules (v6.2 report, all enforced here):
 *   1. per-sender lock covers tail check + isolation + the WHOLE retry loop
 *   2. no trailing newline → isolate with one '\n' before appending, keep fragment
 *   3. write failure mid-record → send fails, fragment stays, nothing appended after it
 *   4. success only after full record + '\n' is on disk
 *
 * Fault-injection hooks (TEST ONLY, env-gated):
 *   MAILBOX_WRITE_CHUNK=N     limit bytes per write(2) call (short-write simulation)
 *   MAILBOX_FAULT_ENOSPC_AT=N throw after N bytes written for the record
 *   MAILBOX_CRASH_STAGE       after-emit | after-commit → SIGKILL self
 *   MAILBOX_HOLD_LOCK_MS=N    hold a state lock N ms after acquiring
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { buildMessage, MAX_BODY } from "./protocol.mjs";

export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCK_POLL_MS = 10;
const LOCK_TIMEOUT_MS = 30_000;

export function defaultDir() {
	return process.env.MAILBOX_DIR || path.join(os.homedir(), ".pi", "agent", "mailbox");
}

export class Mailbox {
	constructor(dir = defaultDir()) {
		this.dir = dir;
		this.stateDir = path.join(dir, ".state");
		this.locksDir = path.join(dir, ".locks");
		this.sessionsDir = path.join(dir, "sessions");
		this.filesDir = path.join(dir, "files");
		for (const d of [dir, this.stateDir, this.locksDir, this.sessionsDir, this.filesDir])
			fs.mkdirSync(d, { recursive: true });
	}

	// ── locks ─────────────────────────────────────────────────────
	// mkdir is atomic; the lock dir holds the owner pid. A SIGKILLed owner
	// leaves a stale dir whose pid is dead → next acquirer steals it.
	// (Node has no builtin flock; this is the stand-in with equal semantics
	// for our use: exclusive, released-on-death via steal, bounded wait.)

	#pidAlive(pid) {
		if (!pid || Number.isNaN(pid)) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			return e.code === "EPERM"; // exists, just not ours
		}
	}

	async #acquireLock(name) {
		const lockDir = path.join(this.locksDir, name);
		const start = Date.now();
		const GRACE_MS = 1500; // owner writes pid right after mkdir; a dir this
		// young without a readable pid is a live owner mid-creation, not stale.
		for (;;) {
			try {
				fs.mkdirSync(lockDir);
				fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
				return async () => {
					// release only if we still own it (a stolen/rebuilt lock is
					// someone else's — never delete their dir)
					try {
						const owner = Number(fs.readFileSync(path.join(lockDir, "pid"), "utf8"));
						if (owner === process.pid) fs.rmSync(lockDir, { recursive: true, force: true });
					} catch {}
				};
			} catch (e) {
				if (e.code !== "EEXIST") throw e;
				let owner = 0;
				let readable = true;
				let dirAge = 0;
				try {
					owner = Number(fs.readFileSync(path.join(lockDir, "pid"), "utf8"));
					dirAge = Date.now() - fs.statSync(lockDir).mtimeMs;
				} catch (e2) {
					if (e2.code === "ENOENT") continue; // owner released mid-inspection → retry
					readable = false; // pid missing: maybe mid-creation, fall to grace check
					try {
						dirAge = Date.now() - fs.statSync(lockDir).mtimeMs;
					} catch (e3) {
						if (e3.code === "ENOENT") continue;
						throw e3;
					}
				}
				const stale = readable ? !this.#pidAlive(owner) : dirAge > GRACE_MS;
				if (stale) {
					// steal stale lock (owner died holding it, or abandoned mid-create)
					const staleDir = path.join(
						this.locksDir,
						`.stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					);
					try {
						fs.renameSync(lockDir, staleDir);
						fs.rmSync(staleDir, { recursive: true, force: true });
					} catch {}
					continue;
				}
				if (Date.now() - start > LOCK_TIMEOUT_MS)
					throw new Error(`lock ${name} timeout (owner pid ${owner} alive)`);
				await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
			}
		}
	}

	// ── send path ────────────────────────────────────────────────

	async send({ from, to, body, type = "chat", taskId }) {
		if (!ALIAS_RE.test(from)) throw new Error(`bad alias: ${from}`);
		if (!ALIAS_RE.test(to)) throw new Error(`bad alias: ${to}`);
		if (typeof body !== "string" || body.length === 0) throw new Error("empty body");

		// attachment first (v6.1: persisted inside mailbox, saved BEFORE the record)
		if (body.length > MAX_BODY) {
			const sha = createHash("sha256").update(body, "utf8").digest("hex");
			const file = path.join(this.filesDir, `${sha}.txt`);
			if (!fs.existsSync(file)) {
				const tmp = `${file}.tmp-${process.pid}`;
				fs.writeFileSync(tmp, body);
				fs.renameSync(tmp, file);
			}
			body = `[attachment ${body.length} chars] path=files/${sha}.txt\n\n${body.slice(0, 200)}…`;
		}

		const msg = buildMessage({ from, to, body, type, taskId });
		const line = Buffer.from(JSON.stringify(msg) + "\n", "utf8");
		const release = await this.#acquireLock(`write-${from}`);
		try {
			const logPath = path.join(this.dir, `log-${from}.jsonl`);
			const fd = fs.openSync(logPath, "a"); // O_APPEND
			try {
				// rule 2: isolate a residual partial tail BEFORE appending
				const size = fs.fstatSync(fd).size;
				let isolated = false;
				if (size > 0) {
					const rfd = fs.openSync(logPath, "r");
					const last = Buffer.alloc(1);
					fs.readSync(rfd, last, 0, 1, size - 1);
					fs.closeSync(rfd);
					if (last[0] !== 0x0a) {
						fs.writeSync(fd, "\n");
						isolated = true;
					}
				}
				// rules 1+3+4: the whole retry loop runs under this lock;
				// failure leaves the fragment and returns an error
				const chunk = Number(process.env.MAILBOX_WRITE_CHUNK) || line.length;
				const failAt = Number(process.env.MAILBOX_FAULT_ENOSPC_AT) || Infinity;
				let off = 0;
				while (off < line.length) {
					if (off >= failAt)
						throw Object.assign(new Error(`injected write failure at byte ${off}`), {
							code: "ENOSPC",
						});
					const n = fs.writeSync(fd, line, off, Math.min(chunk, line.length - off));
					if (n <= 0) throw new Error("write made no progress");
					off += n;
				}
				return isolated ? { ...msg, isolatedBadTail: true } : msg;
			} finally {
				fs.closeSync(fd);
			}
		} finally {
			await release();
		}
	}

	// ── scan (pure) ──────────────────────────────────────────────

	logFiles() {
		return fs
			.readdirSync(this.dir)
			.filter((f) => /^log-.*\.jsonl$/.test(f) && ALIAS_RE.test(f.slice(4, -6)))
			.sort();
	}

	#fingerprint() {
		let maxM = 0n,
			count = 0,
			size = 0;
		for (const f of this.logFiles()) {
			const st = fs.statSync(path.join(this.dir, f), { bigint: true });
			if (maxM < st.mtimeNs) maxM = st.mtimeNs;
			count++;
			size += Number(st.size);
		}
		return [maxM.toString(), count, size];
	}

	scanAll() {
		const msgs = [],
			bad = [];
		let fi = 0;
		for (const f of this.logFiles()) {
			const text = fs.readFileSync(path.join(this.dir, f), "utf8");
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const l = lines[i];
				if (l === "") continue;
				try {
					const m = JSON.parse(l);
					msgs.push({ ...m, _ord: [m.ts, fi, i] });
				} catch {
					bad.push({ file: f, line: i + 1 });
				}
			}
			fi++;
		}
		// per-writer insertion order within the same second (not id order)
		msgs.sort((a, b) => a._ord[0] - b._ord[0] || a._ord[1] - b._ord[1] || a._ord[2] - b._ord[2]);
		msgs.forEach((m) => delete m._ord);
		return { msgs, bad };
	}

	// ── state bundle (seen + backlog + cache + block counters) ────

	statePath(reader) {
		return path.join(this.stateDir, `${reader}.json`);
	}

	#readState(reader) {
		try {
			return JSON.parse(fs.readFileSync(this.statePath(reader), "utf8"));
		} catch {
			return { seen: [], backlog: false, cache: null, block: {} };
		}
	}

	#commitState(reader, state) {
		const p = this.statePath(reader);
		const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
		fs.writeFileSync(tmp, JSON.stringify(state));
		fs.renameSync(tmp, p);
	}

	/**
	 * Delivery sequence (prototype-equivalent): reader lock held across
	 * read-state → short-circuit → scan → emit → commit. `emit` must complete
	 * BEFORE the state commit. Crash hooks fire between the two.
	 */
	async deliver(reader, { limit = 2, emit } = {}) {
		const release = await this.#acquireLock(`state-${reader}`);
		try {
			return await this.#deliverLocked(reader, { limit, emit });
		} finally {
			await release();
		}
	}

	/** Lock-free core of the sequence; caller must hold state-<reader>. */
	async #deliverLocked(reader, { limit = 2, emit } = {}) {
		if (Number(process.env.MAILBOX_HOLD_LOCK_MS))
			await new Promise((r) => setTimeout(r, Number(process.env.MAILBOX_HOLD_LOCK_MS)));
		const state = this.#readState(reader);
		const seen = new Set(state.seen);
		const fp = this.#fingerprint();
		const shortcut = state.cache && state.cache.join() === fp.join() && !state.backlog;
		if (shortcut) return { messages: [], remaining: 0, shortcut: true };
		const { msgs } = this.scanAll();
		const key = (m) => `${m.from}:${m.id}`;
		const pending = msgs.filter((m) => m.to === reader && !seen.has(key(m)));
		const selected = pending.slice(0, limit);
		if (selected.length > 0 && emit) {
			await emit(selected);
			if (process.env.MAILBOX_CRASH_STAGE === "after-emit")
				process.kill(process.pid, "SIGKILL");
		}
		selected.forEach((m) => seen.add(key(m)));
		state.seen = [...seen];
		state.backlog = pending.length > selected.length;
		state.cache = fp;
		this.#commitState(reader, state);
		if (process.env.MAILBOX_CRASH_STAGE === "after-commit")
			process.kill(process.pid, "SIGKILL");
		return { messages: selected, remaining: pending.length - selected.length, shortcut: false };
	}

	/**
	 * replay: remove ids from seen (or all) AND set backlog — the backlog flag
	 * is what defeats the mtime short-circuit (v6.2 fix #1).
	 */
	async replay(reader, { all = false, ids = [] }) {
		const release = await this.#acquireLock(`state-${reader}`);
		try {
			const state = this.#readState(reader);
			if (all) {
				state.seen = [];
			} else {
				const drop = new Set(ids);
				state.seen = state.seen.filter((k) => !drop.has(k.split(":").slice(1).join(":")));
			}
			state.backlog = true;
			this.#commitState(reader, state);
			return { replayed: all ? "all" : ids };
		} finally {
			await release();
		}
	}

	/**
	 * Codex hooks entry. Fail-open: unreadable stdin must never wedge the host.
	 * Identity (v6.2): the mailbox reader is the ALIAS — session_id is codex's
	 * internal thread id, NOT a mailbox alias; it is used only for block-key
	 * isolation. Priority: explicit alias param > MAILBOX_ALIAS > session_id
	 * (last resort, SAMP-alias-shaped session ids only).
	 * stop: cap 2 blocks per (session, turn) incl. the first.
	 */
	async checkHook(mode, input, render, alias) {
		let inp = {};
		try {
			inp = typeof input === "string" ? JSON.parse(input) : input || {};
		} catch {
			return "{}";
		}
		const reader = alias || process.env.MAILBOX_ALIAS || inp.session_id;
		if (!reader || !ALIAS_RE.test(reader)) return "{}";
		const turnKey = `${inp.session_id || reader}:${inp.turn_id || "no-turn"}`;

		const release = await this.#acquireLock(`state-${reader}`);
		try {
			if (mode === "stop") {
				const st = this.#readState(reader);
				if ((st.block[turnKey] || 0) >= 2) return "{}"; // cap → allow stop
			}
			// #deliverLocked commits seen/backlog/cache; the returned JSON is the
			// "emit". A crash after commit but before the host consumes the output
			// is the documented best-effort window; replay recovers.
			const res = await this.#deliverLocked(reader, { limit: 2 });
			if (res.messages.length === 0) return "{}";
			if (mode === "stop") {
				const st2 = this.#readState(reader);
				const keys = Object.keys(st2.block);
				if (keys.length > 8) for (const k of keys.slice(0, keys.length - 8)) delete st2.block[k];
				st2.block[turnKey] = (st2.block[turnKey] || 0) + 1;
				this.#commitState(reader, st2);
				return JSON.stringify({ decision: "block", reason: render(res.messages) });
			}
			return JSON.stringify({
				hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: render(res.messages),
			},
			});
		} finally {
			await release();
		}
	}

	// ── registry (display + best-effort liveness; NO auto-cleanup) ─

	register({ name, kind = "external", pid = process.pid, cwd = process.cwd() }) {
		if (!ALIAS_RE.test(name)) throw new Error(`bad alias: ${name}`);
		const p = path.join(this.sessionsDir, `${name}.json`);
		if (fs.existsSync(p)) {
			const prev = JSON.parse(fs.readFileSync(p, "utf8"));
			if (prev.pid !== pid && this.#pidAlive(prev.pid))
				throw new Error(
					`alias "${name}" is held by live pid ${prev.pid} (aliases must be unique)`,
				);
		}
		const reg = { name, kind, pid, cwd, startedAt: Date.now() };
		fs.writeFileSync(p, JSON.stringify(reg, null, 2));
		return reg;
	}

	receiverKind(alias) {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.sessionsDir, `${alias}.json`), "utf8"))
				.kind;
		} catch {
			return undefined;
		}
	}

	resolveTarget(query) {
		const names = fs
			.readdirSync(this.sessionsDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -5));
		const exact = names.filter((n) => n === query);
		if (exact.length === 1) return exact[0];
		const prefix = names.filter((n) => n.startsWith(query));
		if (prefix.length === 1) return prefix[0];
		if (prefix.length > 1)
			throw new Error(`ambiguous prefix "${query}": matches ${prefix.join(", ")}`);
		throw new Error(`no session "${query}" (mailbox list to see them)`);
	}

	listSessions() {
		const out = [];
		for (const f of fs.readdirSync(this.sessionsDir)) {
			if (!f.endsWith(".json")) continue;
			try {
				const reg = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), "utf8"));
				out.push({
					...reg,
					alive: this.#pidAlive(reg.pid),
					lastSeen: fs.statSync(path.join(this.sessionsDir, f)).mtimeMs,
				});
			} catch {}
		}
		return out;
	}
}
