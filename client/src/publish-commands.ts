// The commands that move work between the folder and the server: publish and sync.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, ApiError, type Collision, type Settled } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { boxOf, knownPrep, runRun, shellWord } from "./box-commands.ts";
import { collisionsHeading, collisionText, mergedLinesText, mergedText } from "./collision-text.ts";
import { type Env, EXIT, heard, type Output, open, plural } from "./command-env.ts";
import {
	changedFilesText,
	FOLDER_LOG_LIMIT,
	LISTED,
	meantBinary,
	READER_REFUSES,
	recordedFirst,
	recordFolder,
	syncFolder,
	turnedBinaryText,
	unwrittenText,
	withLeftOut,
} from "./commands.ts";
import { type Config, isReader } from "./config.ts";
import { fromEnv } from "./env-names.ts";
import { ignoredHere } from "./fetch.ts";
import { absolute, forgetKnown, isLocalOnly, type LeftOut, loadIgnore, readText, writeFileAtomic } from "./folder.ts";
import { PROJECT_FILE, readProjectFile } from "./project-file.ts";
import { pulledText, STILL_QUEUED, standing, WAIT_SECONDS, waitForQueued } from "./queue.ts";
import { type Refused, refusedText, unsafePath } from "./safety.ts";
import { blocksIn, settleText } from "./settle.ts";
import { stateDir } from "./state-dir.ts";

/**
 * Files new in the draft that this folder's ignore rules leave out. An edit
 * mod loaded before nested ignore files existed sends them (#37, Reporter:
 * a chat's process keeps the mod it started with). They leave the draft and
 * stay on disk. A file shared already has stays: as in git, ignoring a file
 * doesn't take it out of the project.
 */
async function dropIgnoredFromDraft(root: string, api: Api): Promise<string[]> {
	if (isReader(root)) return [];
	const diff = await api.diff();
	const ignore = loadIgnore(root);
	const drop = diff.files
		.filter(
			(f) =>
				f.before === null &&
				(f.blob?.before ?? null) === null &&
				unsafePath(f.path) === undefined &&
				!isLocalOnly(f.path) &&
				ignoredHere(ignore, f.path),
		)
		.map((f) => f.path);
	if (drop.length === 0) return [];
	heard(root, (await api.record(Object.fromEntries(drop.map((rel) => [rel, null])))).news);
	for (const rel of drop) forgetKnown(root, rel);
	return drop.sort();
}

function droppedIgnoredText(dropped: readonly string[]): string[] {
	if (dropped.length === 0) return [];
	return [
		`Dropped from your draft, kept on disk (your ignore rules leave ${dropped.length === 1 ? "it" : "them"} out; abso check-ignore says which line): ${dropped.join(", ")}`,
	];
}

export async function runPublish(args: Parsed, env: Env): Promise<Output> {
	const message = str(args, "message");
	if (!message) throw new UsageError('say why with -m "<message>"');
	const { root, config, api } = open(env);
	if (config.reader) throw new UsageError(READER_REFUSES);
	let check = str(args, "check");
	const rawWait = str(args, "wait");
	if (rawWait !== undefined && !/^\d{1,4}$/.test(rawWait))
		throw new UsageError(
			`--wait is how many seconds to wait for a queued publish to land, like 100 (got ${JSON.stringify(rawWait)})`,
		);
	const waitSeconds = bool(args, "no-wait") ? 0 : rawWait === undefined ? WAIT_SECONDS : Number(rawWait);
	let skippedCheck = false;
	if (check === "") {
		// With the merge queue on, the queue runs the project's check on what actually lands (#39): --check alone adds nothing.
		const pf = readProjectFile(root);
		if (pf !== null && !("error" in pf) && pf.file.queue) {
			check = undefined;
			skippedCheck = true;
		}
	}
	if (check === "") {
		// --check alone: the build and check in the draft's own avcs.json, as the server's job runs them on
		// each version, so a draft that changes them runs the new ones (#39).
		const pf = readProjectFile(root);
		if (pf === null || "error" in pf || pf.file.check === "") {
			const why =
				pf === null ? `there is no ${PROJECT_FILE}` : "error" in pf ? pf.error : `${PROJECT_FILE} has no "check"`;
			throw new UsageError(
				`--check alone runs the project's check, but ${why}. Set "check" in ${PROJECT_FILE} (e.g. {"check": "npm test"}), or give the command: --check "npm test"`,
			);
		}
		check = pf.file.build === "" ? pf.file.check : `${pf.file.build} && ${pf.file.check}`;
	}
	if (check !== undefined) {
		// Your draft on newest shared, as it would land, must pass the check (#37, Builder 1):
		// two changes that each passed alone turned shared red twice. Sync first, then run it in the box.
		const say = env.writeErr ?? env.write;
		// Known to have no prep: refuse before syncing and running (#37, Artist 1). Unknown: the run below tells.
		const noPrep =
			"your box has no prep, so a check would run without node_modules and its result couldn't be trusted. Run abso prep 'npm ci --ignore-scripts' once (every fresh box then starts from it), then publish --check again.";
		if (knownPrep(root, boxOf(args, env)) === null && existsSync(join(root, "package-lock.json"))) {
			return {
				exit: EXIT.refused,
				text: `Not published: ${noPrep} (Nothing was run: this folder's last run in that box said it had no prep.)`,
				json: { check: { command: check, ran: false, prep: null } },
			};
		}
		const synced = await unreached(
			runSync({ positionals: [], flags: new Map() }, env),
			"Nothing was published, and the check didn't run.",
		);
		const sj = synced.json as { collisions?: readonly unknown[]; refused?: readonly Refused[] };
		if ((sj.collisions?.length ?? 0) > 0) {
			return {
				exit: EXIT.refused,
				text: `${synced.text}\nNot published: the sync before the check left collisions. Settle them, then publish --check again.`,
				json: { check: null, sync: synced.json },
			};
		}
		if (synced.text) say(`${synced.text}\n`);
		// Paths the sync wouldn't write (safety.ts) don't block: the check just ran without them (Cloud).
		if ((sj.refused?.length ?? 0) > 0)
			say(
				`abso: the sync didn't write these: ${sj.refused!.map((r) => r.path).join(", ")}; the check runs without them.\n`,
			);
		say(`abso: checking your draft on newest shared in the box: ${check}\n`);
		const flags = new Map<string, string | boolean>();
		const box = str(args, "box");
		if (box !== undefined) flags.set("box", box);
		const ran = await runRun({ positionals: [check], flags }, { ...env, runKind: "publish-check" });
		// No prep and a package-lock: the box had no node_modules, so the check can't be trusted either way
		// (#37, Builder 1: npx tsc fetched an unrelated, deprecated tsc package).
		if ((ran.json as { prep?: string | null }).prep === null && existsSync(join(root, "package-lock.json"))) {
			return {
				exit: EXIT.refused,
				text: "Not published: your box has no prep, so the check ran without node_modules and its result can't be trusted. Run abso prep 'npm ci --ignore-scripts' once (every fresh box then starts from it), then publish --check again.",
				json: { check: { command: check, exit: ran.exit ?? 0, prep: null } },
			};
		}
		if ((ran.exit ?? 0) !== 0) {
			// Whose is it? Run the check once more on shared alone, at the version just synced to (#36, Builder 6:
			// stopped by someone else's red test, nothing said whose). One extra run, only when the check fails.
			const recent = (await api.log({ agent: config.agent }, 5)).versions;
			const newest = recent[0]?.version;
			let verdict: string[] = [];
			let sharedExit: number | undefined;
			if (newest !== undefined) {
				say(`abso: the check failed; running it on shared alone (version ${newest}) to see whose it is.\n`);
				const atFlags = new Map(flags);
				atFlags.set("at", String(newest));
				sharedExit =
					(
						await runRun(
							{ positionals: [check], flags: atFlags },
							{ ...env, write: () => {}, writeErr: () => {}, runKind: "publish-check" },
						)
					).exit ?? 0;
				const who = recent.map((v) => `${v.version} by ${v.agent} ("${v.message}")`).join("; ");
				verdict =
					sharedExit === 0
						? [`It passes on shared alone (version ${newest}), so your draft is what breaks it.`]
						: [
								`It fails on shared alone too (version ${newest}, exit ${sharedExit}), so it isn't your draft. The latest versions: ${who}.`,
								`abso bisect -- ${check} finds the one that broke it; abso announce --to <agent> "..." reaches its author.`,
							];
			}
			return {
				exit: EXIT.refused,
				text: [
					`Not published: the check failed (exit ${ran.exit}) on your draft with newest shared. Its output is above.`,
					...verdict,
				].join("\n"),
				json: {
					check: {
						command: check,
						exit: ran.exit,
						...(sharedExit === undefined ? {} : { sharedAlone: { version: newest, exit: sharedExit } }),
					},
				},
			};
		}
		say("abso: the check passed; publishing.\n");
	}
	const checked = check !== undefined;
	const leftOut: LeftOut[] = [];
	const steps = publishSteps(args, env, root, config, api, message, checked, waitSeconds, skippedCheck, leftOut);
	// Say how far it got when the server can't be reached (#37, GAME - UI/UX: did the check run? did the draft go up?).
	const reached = await unreached(
		steps,
		checked
			? "The check passed, but the publish never reached the server: nothing was published."
			: "Nothing was published.",
		`${checked ? "The check passed; " : ""}the publish may have reached the server before its answer was lost: abso status shows whether your draft was published.`,
	);
	const out = withLeftOut(reached, leftOut);
	// --done: this publish finishes the work the start note named (#44): take the note back once it's published or queued.
	const went =
		(out.json as { version?: unknown; queued?: unknown }).version !== undefined ||
		(out.json as { queued?: unknown }).queued !== undefined;
	if (!bool(args, "done") || !went) return out;
	// done (#54): the work is finished, so an issue the note named is closed with this change.
	await api.starting(null, undefined, { done: true });
	return {
		...out,
		text: `${out.text}\nYour start note is taken back (--done): this work is finished.`,
		json: { ...out.json, startNote: null },
	};
}

/**
 * When a publish's answer was lost (a 5xx, or the connection dropped after the
 * request went out), whether it landed: shared's newest versions, or the merge
 * queue, hold this agent's publish with this message from this attempt. Undefined
 * when the error isn't that kind, or when looking fails too.
 */
async function afterLostPublish(
	api: Api,
	agent: string,
	message: string,
	started: number,
	err: unknown,
): Promise<Output | undefined> {
	if (!(err instanceof ApiError) || err.notSent || (err.status !== undefined && err.status < 500)) return undefined;
	const why = err.message;
	try {
		// A server clock a little apart from this one still counts; an older publish with the same message doesn't.
		const recent = (v: { time: number }) => v.time >= started - 120_000;
		const landed = (await api.log({ draft: null }, 10)).versions.find(
			(v) => v.agent === agent && v.message === message.trim() && recent(v),
		);
		if (landed) {
			return {
				text: `Published version ${landed.version}. The server's answer was lost (${why}), but shared's log shows your publish landed.`,
				json: { version: landed.version, lostAnswer: why },
			};
		}
		const queued = ((await api.queueState().catch(() => undefined))?.items ?? []).find(
			(q) => q.agent === agent && q.message === message.trim() && recent(q),
		);
		if (queued) {
			return {
				exit: STILL_QUEUED,
				text: `Queued as publish ${queued.id}. The server's answer was lost (${why}), but the merge queue holds your publish; the outcome comes as news on your next edit, and abso status shows the queue.`,
				json: { queued: queued.id, outcome: "queued", lostAnswer: why },
			};
		}
		return {
			exit: EXIT.error,
			text: `Not published: ${why}. Shared's newest versions and the merge queue don't have it, so it's safe to publish again.`,
			json: { published: false, lostAnswer: why },
		};
	} catch {
		return undefined;
	}
}

/**
 * A network failure, said with how far the command got: when nothing reached the
 * server, `notSent` and "run it again"; when a request went out and its answer
 * was lost, `sent` (or the error as it was).
 */
async function unreached<T>(work: Promise<T>, notSent: string, sent?: string): Promise<T> {
	try {
		return await work;
	} catch (err) {
		if (!(err instanceof ApiError) || err.status !== undefined) throw err;
		if (err.notSent) throw new ApiError(`${err.message}. ${notSent} Run the same command again.`, undefined, true);
		if (sent === undefined) throw err;
		throw new ApiError(`${err.message}. ${sent}`);
	}
}

async function publishSteps(
	args: Parsed,
	env: Env,
	root: string,
	config: Config,
	api: Api,
	message: string,
	checked: boolean,
	waitSeconds: number,
	skippedCheck: boolean,
	leftOut: LeftOut[],
): Promise<Output> {
	const recorded = await recordFolder(root, api, false, meantBinary(args));
	leftOut.push(...recorded.leftOut);
	const pre = [...recordedFirst(recorded), ...droppedIgnoredText(await dropIgnoredFromDraft(root, api))];
	if (recorded.turnedBinary.length > 0) {
		// Publishing now would leave the others on the file's old text without anyone noticing (#25).
		return {
			exit: EXIT.refused,
			text: [...pre, ...turnedBinaryText(recorded.turnedBinary), "Not published."].join("\n"),
			json: { turnedBinary: recorded.turnedBinary, recorded: recorded.sent },
		};
	}
	const asIs = bool(args, "as-is");
	if (asIs) {
		const me = (await api.status()).agents.find((a) => a.agent === config.agent);
		const marked = [...new Set((me?.collisions ?? []).map((c) => c.file))].filter(
			(rel) => blocksIn(absolute(root, rel)) > 0,
		);
		for (const rel of marked)
			writeFileAtomic(absolute(root, rel), settleText(readText(absolute(root, rel))!, "both").text);
		if (marked.length > 0) await recordFolder(root, api);
	}
	const started = Date.now();
	let answer: Awaited<ReturnType<Api["publish"]>>;
	try {
		answer = await api.publish(message, asIs);
	} catch (err) {
		// The answer can be lost after the publish committed (Cloud: a storage reset killed the reply to
		// two publishes that had landed). Look before saying it failed; never publish again by itself.
		const found = await afterLostPublish(api, config.agent, message, started, err);
		if (found) return { ...found, text: [...pre, found.text].join("\n") };
		throw err;
	}
	if (answer.ok && "queued" in answer) {
		// The merge queue (#39): it lands once a batch with it passes the project's check.
		const say = env.writeErr ?? env.write;
		const head = `Queued as publish ${answer.queued}${answer.ahead === 0 ? "" : `, ${answer.ahead} ${answer.ahead === 1 ? "publish" : "publishes"} ahead of it`}: it lands once the project's check passes on it in the merge queue.`;
		const notes = [
			...pre,
			...(skippedCheck
				? ["The merge queue runs the project's check on what lands, so --check alone was skipped."]
				: []),
			...settledText(answer.settled ?? [], undefined),
		];
		const json = {
			queued: answer.queued,
			position: answer.position,
			ahead: answer.ahead,
			changes: answer.changes,
			settled: answer.settled ?? [],
			recorded: recorded.sent,
		};
		const later =
			"The outcome comes as news on your next edit; abso status shows the queue, and abso unqueue takes it back.";
		if (waitSeconds === 0)
			return {
				text: [...notes, head, `Not waiting (--no-wait). ${later}`].join("\n"),
				json: { ...json, outcome: "queued" },
			};
		say(`abso: ${head} Waiting up to ${waitSeconds} s for it (--no-wait returns at once).\n`);
		const out = await waitForQueued(
			api,
			answer.queued,
			waitSeconds * 1000,
			say,
			Number(fromEnv(env.env, "QUEUE_POLL_MS")) || 3000,
		);
		if (out.kind !== "waiting") heard(root, out.news);
		if (out.kind === "landed")
			return {
				text: [...notes, `Published version ${out.version}: it passed the project's check in the merge queue.`].join(
					"\n",
				),
				json: { ...json, version: out.version, outcome: "landed" },
			};
		if (out.kind === "pulled")
			return {
				exit: EXIT.refused,
				text: [...notes, pulledText(out.text)].join("\n"),
				json: { ...json, outcome: "pulled", reason: out.text },
			};
		if (out.kind === "gone") {
			return {
				exit: STILL_QUEUED,
				text: [
					...notes,
					`Publish ${answer.queued} left the merge queue, but nothing said whether it landed: abso log -n 3 shows it if it did.`,
				].join("\n"),
				json: { ...json, outcome: "unknown" },
			};
		}
		const where = out.state
			? standing(out.state.items, answer.queued)
			: "still in the queue (the queue could not be read)";
		return {
			exit: STILL_QUEUED,
			text: [...notes, `Still queued after ${waitSeconds} s: publish ${answer.queued} is ${where}. ${later}`].join(
				"\n",
			),
			json: { ...json, outcome: "queued" },
		};
	}
	if (answer.ok) {
		const merged = answer.mergedWith ?? [];
		const what =
			answer.changes === 0
				? await alreadyInShared(root, api, config.agent, recorded.paths, answer.version)
				: `Published version ${answer.version}.${merged.length > 0 ? ` ${mergedText(merged)}` : ""}`;
		// The check ran on shared as it was; what landed since went in unchecked (Cloud).
		const moved =
			checked && merged.length > 0
				? [
						`Shared moved during the check: ${merged.length === 1 ? "version" : "versions"} ${merged.map((m) => m.version).join(", ")} merged in without being checked.`,
					]
				: [];
		return {
			text: [
				...pre,
				what,
				...moved,
				// --check alone was skipped for a queue that turned out not to be on: the answer, not the draft's avcs.json, says (Cloud).
				...(skippedCheck
					? [
							`It landed directly, with no check: your avcs.json says "queue": true, but shared's doesn't yet, so the merge queue isn't on and --check alone was skipped. abso ci ${answer.version} shows CI's result once it has run.`,
						]
					: []),
				...settledText(answer.settled ?? [], answer.version),
			].join("\n"),
			json: {
				version: answer.version,
				changes: answer.changes ?? null,
				mergedWith: answer.mergedWith ?? [],
				settled: answer.settled ?? [],
				recorded: recorded.sent,
			},
		};
	}
	const collisions = answer.collisions ?? [];
	// Marker blocks still in the draft (#11): settle them, or --as-is keeps both everywhere.
	if (collisions.length > 0 && collisions.every((c) => c.marked)) {
		const files = [...new Set(collisions.map((c) => c.file))];
		return {
			exit: EXIT.refused,
			text: [
				...pre,
				`Not published: ${files.join(", ")} still ${files.length === 1 ? "has" : "have"} collision markers (${plural(collisions.length, "block")}).`,
				...collisions.map(collisionText),
				`Settle each: keep yours, theirs or a mix and delete the marker lines, or abso settle <file> --yours|--theirs|--both. Then publish again. abso publish --as-is keeps both sides everywhere; the other authors hear it.`,
			].join("\n"),
			json: { collisions, recorded: recorded.sent },
		};
	}
	// Lines both sides changed, still as the sync left them (#37, Builder 1): publishing would put both in shared.
	if (collisions.length > 0 && collisions.every((c) => c.untouched)) {
		return {
			exit: EXIT.refused,
			text: [
				...pre,
				`Not published: ${plural(collisions.length, "collision")} you synced into and haven't edited since. Both sides' lines are still in the file, so publishing now would put them in shared twice.`,
				...collisions.map(collisionText),
				"Edit each to what it should be (keep yours, theirs, or a mix), then publish again. If both really belong, abso publish --as-is keeps both.",
			].join("\n"),
			json: { collisions, recorded: recorded.sent },
		};
	}
	const local = collisions.filter((c) => isLocalOnly(c.file));
	const real = collisions.filter((c) => !isLocalOnly(c.file));
	const twice = real.filter((c) => c.kind === "duplicate");
	const newer = real.filter((c) => c.kind !== "duplicate");
	return {
		exit: EXIT.refused,
		text: [
			...pre,
			// A name defined twice is already in your folder (sync listed it); the rest is newer work.
			`Not published: ${plural(collisions.length, "collision")}${newer.length > 0 ? " with work published since your last sync" : ""}.${answer.reason ? ` (${answer.reason})` : ""}`,
			...real.map(collisionText),
			...(local.length > 0
				? [
						`  ${local.map((c) => c.file).join(", ")}: local files that should never have been shared. abso sync drops them from your draft and leaves your copy on disk.`,
					]
				: []),
			...(real.some((c) => c.theirs.queued !== undefined)
				? [
						"Some of theirs are still in the merge queue, not in shared: once they land (abso status shows the queue), abso sync brings them in to settle; if they're pulled, publish again as you are.",
					]
				: []),
			newer.length > 0
				? `Run abso sync: each of those files comes back holding both sides' lines, with no markers. Edit it to what it should be${twice.length > 0 ? ", keep one definition of each name defined twice" : ""}, then publish again.`
				: twice.length > 0
					? "Keep one definition of each name defined twice (delete yours, or theirs), then publish again."
					: "Run abso sync, then publish again.",
		].join("\n"),
		json: { collisions, recorded: recorded.sent, ...(answer.reason ? { reason: answer.reason } : {}) },
	};
}

export async function runSync(args: Parsed, env: Env): Promise<Output> {
	const { root, api } = open(env);
	const recorded = await recordFolder(root, api);
	const ignoredDropped = await dropIgnoredFromDraft(root, api);
	const s = await syncFolder(root, api, bool(args, "full"));
	const changes = s.written.length + s.deleted.length;
	// A renamed file is one line, not an update and a delete.
	const updated = s.written.filter((f) => !s.renamed.some((r) => r.to === f));
	const removed = s.deleted.filter((f) => !s.renamed.some((r) => r.from === f));
	const lines = [
		...turnedBinaryText(recorded.turnedBinary),
		...recordedFirst(recorded),
		...droppedIgnoredText(ignoredDropped),
		`Synced to version ${s.version}: ${changes === 0 ? "no files changed" : `${plural(updated.length, "file")} updated, ${removed.length} deleted${s.renamed.length > 0 ? `, ${s.renamed.length} renamed` : ""}`}.`,
		...changedFilesText("sync", updated, removed, s.renamed, bool(args, "verbose")),
		...refusedText(s.refused),
		// Ones an earlier sync couldn't write; this sync's are named just above.
		...unwrittenText(s.unwritten, new Set(s.refused.map((r) => r.path))),
		...mergedLinesText(s.merged),
		...(s.kept.length > 0
			? [`Left alone because they changed while syncing (run abso sync again): ${s.kept.join(", ")}`]
			: []),
		...(s.dropped.length > 0
			? [`Dropped from your draft, kept on disk (these stay local): ${s.dropped.join(", ")}`]
			: []),
		...(s.collisions.length > 0
			? [collisionsHeading(s.collisions), ...s.collisions.map(collisionText), ...sameVersionHint(s.collisions)]
			: []),
	];
	return {
		text: lines.join("\n"),
		json: {
			version: s.version,
			written: s.written,
			deleted: s.deleted,
			renamed: s.renamed,
			kept: s.kept,
			dropped: s.dropped,
			collisions: s.collisions,
			merged: s.merged,
			refused: s.refused,
			recorded: recorded.sent,
			ignoredDropped,
		},
	};
}

/** What a publish settled, and that each other author hears it (#11). */
function settledText(settled: readonly Settled[], version: number | undefined): string[] {
	if (settled.length === 0) return [];
	const said = { yours: "kept yours", theirs: "kept theirs", both: "kept both", rewrote: "rewrote them" } as const;
	// Lines both sides still had that the settled file no longer has (#37, Playtester 1): the settler should look.
	const quote = (l: string) => `"${l.trim().length > 60 ? `${l.trim().slice(0, 57)}...` : l.trim()}"`;
	return [
		`Settled ${plural(settled.length, "collision")}: ${settled.map((s) => `${s.file} (${said[s.kept]}, against ${s.theirs.agent}'s version ${s.theirs.version})`).join("; ")}. ${[...new Set(settled.map((s) => s.theirs.agent))].join(", ")} will hear what you kept.`,
		...settled
			.filter((s) => (s.lost?.length ?? 0) > 0)
			.map(
				(s) =>
					`  ${s.file}: lost ${plural(s.lost!.length, "line")} you both had: ${s.lost!.slice(0, 3).map(quote).join(", ")}${s.lost!.length > 3 ? `, and ${s.lost!.length - 3} more` : ""}; check ${version === undefined ? s.file : `abso show ${version}:${s.file}`}`,
			),
	];
}

/**
 * What an empty publish says (#37, Artist 1: "Nothing to publish: your draft
 * is empty" read as lost work). The files this folder edited since its last
 * publish (this record's, and the edit hook's sends in .avcs/hook.log) that
 * someone else changed in shared since then: shared already has them as you
 * do, so nothing of yours is lost.
 */
async function alreadyInShared(
	root: string,
	api: Api,
	agent: string,
	recordedPaths: readonly string[],
	version: number,
): Promise<string> {
	const empty = `Nothing to publish: your draft is empty. Shared is at version ${version}.`;
	const log = await api.log({ agent }, FOLDER_LOG_LIMIT);
	const since = log.versions.find((v) => v.agent === agent)?.time ?? 0;
	const edited = new Set(recordedPaths);
	try {
		for (const line of readFileSync(join(stateDir(root), "hook.log"), "utf8").split("\n")) {
			const [at, , rel, outcome] = line.split("\t");
			if (rel && outcome?.startsWith("sent") && Date.parse(at ?? "") >= since) edited.add(rel);
		}
	} catch {
		// No hook log: only this record's files.
	}
	const found: string[] = [];
	for (const rel of [...edited].sort().slice(0, LISTED)) {
		const last = (await api.log({ agent }, 1, rel)).versions[0];
		if (last && last.agent !== agent && last.time >= since)
			found.push(`${rel} (version ${last.version}, ${last.agent}: "${last.message}")`);
	}
	if (found.length === 0) return empty;
	return `Nothing published: shared already has ${found.length === 1 ? "the file you changed" : "the files you changed"} as you have ${found.length === 1 ? "it" : "them"}, so nothing of yours is lost. Last changed in ${found.join("; ")}. Shared is at version ${version}.`;
}

/**
 * Several files marked against one version (#37, Builder 6: twenty tool
 * scripts muted twice at once): if that version already does what yours do,
 * one settle takes theirs in all of them.
 */
export function sameVersionHint(collisions: readonly Collision[]): string[] {
	const groups = new Map<number, { agent: string; message: string; files: Set<string> }>();
	for (const c of collisions) {
		if (!c.marked || c.theirs.agent === "") continue;
		const g = groups.get(c.theirs.version) ?? {
			agent: c.theirs.agent,
			message: c.theirs.message,
			files: new Set<string>(),
		};
		g.files.add(c.file);
		groups.set(c.theirs.version, g);
	}
	return [...groups]
		.filter(([, g]) => g.files.size >= 2)
		.map(([version, g]) => {
			const files = [...g.files].sort();
			return `${files.length} files collide with ${g.agent}'s version ${version} ("${g.message}"). If it already does what yours does, abso settle ${files.map(shellWord).join(" ")} --theirs takes theirs in all of them.`;
		});
}
