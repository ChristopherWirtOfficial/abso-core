// One writer at a time for a folder's own records (#51, as git's index.lock).
// Recording and applying a sync rewrite .avcs/ (known copies, modes.json,
// blobs.json); two at once, in different processes, could leave a known copy
// out of step with the folder. They take .avcs/lock. A command waits a moment
// for the lock (a hook holds it for about 100 ms), then fails with a
// sentence; the command hook never waits, and leaves the edit for the next
// record.
//
// The lock is never there without its contents: they're written to a file of
// the taker's own and linked into place, which fails if a lock exists
// (AVCS - Git Lessons). Its holder renews it every RENEW_MS, so a lock not
// renewed for LOCK_STALE_MS was left behind, whatever process now has its
// id; a long record or sync is never taken over while it writes. Taking one
// over goes through a rename aside, which only one process can win.

import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { UsageError } from "./args.ts";
import { LOCK_FILE, LOCK_STALE_MS, type LockInfo } from "./core.ts";
import { fromEnv } from "./env-names.ts";
import { writeFileAtomic } from "./folder.ts";
import { stateDir } from "./state-dir.ts";

/** How long a command waits for the lock before it says who holds it. */
const WAIT_MS = 3000;
/** How often a holder renews its lock. */
const RENEW_MS = 20_000;

/** Locks this process holds, by folder, and how deep: a locked call inside another one doesn't wait for itself. */
const held = new Map<string, { depth: number; renew: ReturnType<typeof setInterval> }>();

const lockPath = (root: string): string => join(stateDir(root), LOCK_FILE);

function readInfo(path: string): LockInfo | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as LockInfo;
	} catch {
		return undefined;
	}
}

/**
 * Whether a lock is still held: renewed lately and its process running. A
 * lock that can't be read (written in place by an older client, caught
 * between creating and writing) is held until its file is LOCK_STALE_MS old.
 */
function live(path: string, info: LockInfo | undefined, now: number): boolean {
	if (!info || typeof info.pid !== "number" || typeof info.time !== "number") {
		try {
			return now - statSync(path).mtimeMs <= LOCK_STALE_MS;
		} catch {
			return false;
		}
	}
	if (now - info.time > LOCK_STALE_MS) return false;
	try {
		process.kill(info.pid, 0);
		return true;
	} catch (e) {
		// EPERM: it runs, as another user.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Put `info` at `path` only if nothing is there: a file of our own, linked into place. */
function create(path: string, info: LockInfo): "taken" | "exists" | "no folder" {
	const mine = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
	try {
		const fd = openSync(mine, "wx");
		writeSync(fd, JSON.stringify(info));
		closeSync(fd);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return "no folder";
		throw e;
	}
	try {
		linkSync(mine, path);
		return "taken";
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists";
		throw e;
	} finally {
		rmSync(mine, { force: true });
	}
}

/** Take the lock if it's free (or left behind): true, false while someone holds it, or 'no folder' before init. */
function take(root: string, what: string): boolean | "no folder" {
	const path = lockPath(root);
	for (let tries = 0; tries < 3; tries++) {
		const made = create(path, { pid: process.pid, time: Date.now(), what });
		if (made !== "exists") return made === "taken" ? true : "no folder";
		const there = readInfo(path);
		if (live(path, there, Date.now())) return false;
		// Left behind: move it aside. Only one taker's rename finds it.
		const aside = `${path}.left.${process.pid}`;
		try {
			renameSync(path, aside);
		} catch {
			continue;
		}
		// A quicker taker may have put a fresh lock there between our read and our rename: give it back.
		const moved = readInfo(aside);
		if (moved && (moved.pid !== there?.pid || moved.time !== there?.time) && live(aside, moved, Date.now())) {
			try {
				linkSync(aside, path);
			} catch {
				// Someone else took it meanwhile; either way it isn't ours.
			}
			rmSync(aside, { force: true });
			return false;
		}
		rmSync(aside, { force: true });
	}
	return false;
}

/** Hold the lock for this process: renewed every RENEW_MS until let go. */
function hold(root: string, what: string): void {
	const renew = setInterval(() => {
		// Only while it's still ours; written aside and renamed in, so a reader never sees half of it.
		if (readInfo(lockPath(root))?.pid !== process.pid) return;
		try {
			writeFileAtomic(lockPath(root), JSON.stringify({ pid: process.pid, time: Date.now(), what } satisfies LockInfo));
		} catch {
			// The next renewal tries again.
		}
	}, RENEW_MS);
	renew.unref();
	held.set(root, { depth: 1, renew });
}

function letGo(root: string): void {
	const h = held.get(root);
	if (!h || --h.depth > 0) return;
	clearInterval(h.renew);
	held.delete(root);
	if (readInfo(lockPath(root))?.pid === process.pid) rmSync(lockPath(root), { force: true });
}

/** Run `fn` holding the folder's lock, waiting a moment for another holder; then a sentence saying who holds it. */
export async function withFolderLock<T>(root: string, what: string, fn: () => Promise<T>): Promise<T> {
	const mine = held.get(root);
	if (mine) mine.depth++;
	else {
		// ABSO_LOCK_WAIT_MS shortens the wait in tests.
		const until = Date.now() + (Number(fromEnv(process.env, "LOCK_WAIT_MS")) || WAIT_MS);
		for (;;) {
			const got = take(root, what);
			if (got === "no folder") return fn(); // no .avcs/ yet (init): nothing to protect
			if (got) break;
			if (Date.now() >= until) {
				const info = readInfo(lockPath(root));
				const since = info ? new Date(info.time).toISOString().slice(11, 19) : "?";
				throw new UsageError(
					`another abso command (${info?.what ?? "one"}, process ${info?.pid ?? "?"}, since ${since} UTC) is changing this folder's records; run this again when it has finished. If none is running, delete ${basename(stateDir(root))}/lock.`,
				);
			}
			await new Promise((ok) => setTimeout(ok, 50));
		}
		hold(root, what);
	}
	try {
		return await fn();
	} finally {
		letGo(root);
	}
}

/** For the command hook, which never waits: the lock and a way to let it go, or undefined while someone else holds it. */
export function tryFolderLock(root: string, what: string): (() => void) | undefined {
	const mine = held.get(root);
	if (mine) {
		mine.depth++;
		return () => letGo(root);
	}
	const got = take(root, what);
	if (got === "no folder") return () => {};
	if (!got) return undefined;
	hold(root, what);
	return () => letGo(root);
}
