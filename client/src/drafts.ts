// abso switch, land and draft-sync: named drafts (#10, #22).
//
// Each agent has its own unpublished draft in each space (shared, or a named
// draft). Switching parks the draft on the server in the space it leaves and
// brings back what was parked in the space it moves to, so nothing needs
// publishing first. `switch -c <name>` instead takes the current unpublished
// changes into a new named draft.

import { readFileSync } from "node:fs";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import {
	applyAnswer,
	changedFilesText,
	collisionsHeading,
	collisionText,
	type Env,
	EXIT,
	mergedLinesText,
	type Output,
	open,
	plural,
	recordedFirst,
	recordFolder,
} from "./commands.ts";
import { isLocalOnly } from "./core.ts";
import { absolute } from "./folder.ts";
import { refusedText } from "./safety.ts";

/** The name that means shared, not a named draft. */
const SHARED = "shared";

function draftName(raw: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw))
		throw new UsageError(`draft names are letters, digits, dot, dash and underscore (got ${JSON.stringify(raw)})`);
	return raw;
}

export async function runSwitch(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length !== 1)
		throw new UsageError(
			"switch takes one name: abso switch <draft>, abso switch -c <new draft>, or abso switch shared",
		);
	const raw = args.positionals[0]!;
	const carry = bool(args, "carry");
	const name = raw === SHARED ? null : draftName(raw);
	if (carry && name === null)
		throw new UsageError("-c starts a new named draft; shared already exists (use: abso switch shared)");
	const { root, api } = open(env);
	// Folder-only edits must be on the server first, or the new view would overwrite them instead of parking them.
	const recorded = await recordFolder(root, api);
	// What the folder held before, for each file the switch or the sync touches, so only the net change is reported.
	const before = new Map<string, string | null>();
	const note = (files: Readonly<Record<string, unknown>>): void => {
		for (const rel of Object.keys(files)) if (!before.has(rel)) before.set(rel, onDisk(root, rel));
	};
	const answer = await api.switchDraft(name, carry);
	note(answer.files);
	const switched = await applyAnswer(root, api, answer);
	// The switch brings back the space as it was when parked; sync straight away so the folder shows it as it is now (#22).
	const syncAnswer = await api.sync();
	note(syncAnswer.files);
	const synced = await applyAnswer(root, api, syncAnswer);
	const touched = new Set([...switched.written, ...switched.deleted, ...synced.written, ...synced.deleted]);
	const written: string[] = [];
	const deleted: string[] = [];
	for (const rel of [...touched].sort()) {
		const now = onDisk(root, rel);
		if (now === before.get(rel)) continue;
		(now === null ? deleted : written).push(rel);
	}
	const where = answer.draft === null ? "shared" : `draft ${answer.draft}`;
	const kept = [...new Set([...switched.kept, ...synced.kept])];
	const dropped = [...new Set([...switched.dropped, ...synced.dropped])];
	const collisions = [...switched.collisions, ...synced.collisions];
	const lines = [
		...recordedFirst(recorded),
		carry
			? `Started ${where}, carrying your unpublished changes into it.`
			: `Switched to ${where}. Your unpublished changes where you were are parked there, and come back when you switch back.`,
		`It is at version ${synced.version}. ${written.length + deleted.length === 0 ? "No files changed in this folder." : `${plural(written.length, "file")} updated, ${deleted.length} deleted:`}`,
		...changedFilesText("switch", written, deleted, [], bool(args, "verbose")),
		...refusedText([...switched.refused, ...synced.refused]),
		...mergedLinesText([...switched.merged, ...synced.merged]),
		...(kept.length > 0 ? [`Left alone because they changed while switching (run abso sync): ${kept.join(", ")}`] : []),
		...(dropped.length > 0 ? [`Dropped from your draft, kept on disk (these stay local): ${dropped.join(", ")}`] : []),
		...(collisions.length > 0 ? [collisionsHeading(collisions), ...collisions.map(collisionText)] : []),
		...(answer.draft !== null
			? ['Publish into this draft with abso publish; land it in shared with abso land -m "why".']
			: []),
	];
	return {
		text: lines.join("\n"),
		json: {
			draft: answer.draft,
			version: synced.version,
			carried: carry,
			recorded: recorded.sent,
			written,
			deleted,
			kept,
			dropped,
			collisions,
		},
	};
}

/** A file's bytes as text, or null when there is no file. */
function onDisk(root: string, rel: string): string | null {
	try {
		return readFileSync(absolute(root, rel), "latin1");
	} catch {
		return null;
	}
}

export async function runLand(args: Parsed, env: Env): Promise<Output> {
	const message = str(args, "message");
	if (!message) throw new UsageError('say why with -m "<message>"');
	const { root, api } = open(env);
	const recorded = await recordFolder(root, api);
	const answer = await api.land(message);
	const pre = recordedFirst(recorded);
	if (answer.ok) {
		const what =
			answer.changes === 0
				? `Nothing to land: the draft has nothing shared doesn't. Shared is at version ${answer.version}.`
				: `Landed in shared as version ${answer.version}.`;
		return {
			text: [...pre, what].join("\n"),
			json: { version: answer.version, changes: answer.changes ?? null, recorded: recorded.sent },
		};
	}
	const collisions = (answer.collisions ?? []).filter((c) => !isLocalOnly(c.file));
	return {
		exit: EXIT.refused,
		text: [
			...pre,
			`Not landed: ${plural(collisions.length, "collision")} with work that landed in shared since the draft's base.`,
			...collisions.map(collisionText),
			"Run abso draft-sync to move the draft onto shared, settle those lines in the draft, publish, then land again.",
		].join("\n"),
		json: { collisions, recorded: recorded.sent },
	};
}

export async function runDraftSync(_args: Parsed, env: Env): Promise<Output> {
	const { root, api } = open(env);
	const moved = await api.draftSync();
	// Bring the moved draft's new view into this folder straight away.
	const recorded = await recordFolder(root, api);
	const applied = await applyAnswer(root, api, await api.sync());
	const lines = [
		`Moved draft ${moved.draft} onto shared version ${moved.sharedBase} (the draft is at version ${moved.version}).`,
		...recordedFirst(recorded),
		applied.written.length + applied.deleted.length === 0
			? "No files changed in this folder."
			: `${plural(applied.written.length, "file")} updated, ${applied.deleted.length} deleted.`,
		...refusedText(applied.refused),
		...mergedLinesText(applied.merged),
		...(applied.collisions.length > 0
			? [
					`${plural(applied.collisions.length, "collision")} to settle in the draft before it lands:`,
					...applied.collisions.map(collisionText),
				]
			: []),
	];
	return { text: lines.join("\n"), json: { ...applied, ...moved } };
}
