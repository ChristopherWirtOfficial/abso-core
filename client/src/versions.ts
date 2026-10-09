// abso drop, pluck, amend, label, labels and follow: changing which published
// versions shared holds, naming versions, and following a named one (#10, #27).

import type { VersionRef } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { applyAnswer, collisionText, type Env, EXIT, type Output, open, plural, recordFolder } from "./commands.ts";
import { writeConfig } from "./config.ts";
import { refusedText } from "./safety.ts";

function versionList(words: readonly string[], what: string): number[] {
	if (words.length === 0) throw new UsageError(`name the ${what} by number`);
	return words.map((w) => {
		if (!/^\d+$/.test(w)) throw new UsageError(`${what} are version numbers (got ${JSON.stringify(w)})`);
		return Number(w);
	});
}

function ref(v: VersionRef): string {
	return `  version ${v.version} by ${v.agent}: ${v.message}`;
}

function labelName(raw: string | undefined): string {
	if (!raw || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw))
		throw new UsageError(
			`label names are letters, digits, dot, dash and underscore (got ${JSON.stringify(raw ?? "")})`,
		);
	return raw;
}

export async function runDrop(args: Parsed, env: Env): Promise<Output> {
	const versions = versionList(args.positionals, "versions to drop");
	const message = str(args, "message");
	if (!message) throw new UsageError('say why with -m "<message>"');
	const { api } = open(env);
	const answer = await api.drop(versions, message, bool(args, "with-dependents"));
	if (answer.ok) {
		return {
			text: [
				`Dropped from shared, as version ${answer.version}:`,
				...answer.dropped.map(ref),
				"Other agents hear it as news; their next sync takes it out of their folders. History keeps it: abso log shows the drop.",
			].join("\n"),
			json: { ...answer },
		};
	}
	const lines = ["Not dropped."];
	if (answer.dependents && answer.dependents.length > 0) {
		lines.push(
			`Later published versions build on ${versions.length === 1 ? "it" : "them"}:`,
			...answer.dependents.map(ref),
			"Pass --with-dependents to drop those too.",
		);
	}
	if (answer.blocked && answer.blocked.length > 0) {
		lines.push(
			"Unpublished work builds on it, and a drop never touches unpublished work:",
			...answer.blocked.map(
				(b) => `  ${b.agent !== undefined ? `agent ${b.agent}` : `draft ${b.draft}`}: ${b.files.join(", ")}`,
			),
		);
	}
	return { exit: EXIT.refused, text: lines.join("\n"), json: { ...answer } };
}

export async function runPluck(args: Parsed, env: Env): Promise<Output> {
	const [draft, ...rest] = args.positionals;
	if (draft === undefined)
		throw new UsageError('pluck takes a draft and its versions: abso pluck <draft> <version...> -m "why"');
	const versions = versionList(rest, `versions of draft ${draft} to pluck`);
	const message = str(args, "message");
	if (!message) throw new UsageError('say why with -m "<message>"');
	const { api } = open(env);
	const answer = await api.pluck(draft, versions, message, bool(args, "with-dependencies"));
	if (answer.ok) {
		return {
			text: `Plucked ${plural(versions.length, "version")} of draft ${draft} into shared as version ${answer.version} (${plural(answer.changes, "change")}). The draft stays as it is; landing it later brings in only the rest.`,
			json: { ...answer },
		};
	}
	const lines = ["Not plucked."];
	if (answer.needs && answer.needs.length > 0)
		lines.push(
			"They build on these versions of the draft:",
			...answer.needs.map(ref),
			"Pass --with-dependencies to take those too.",
		);
	if (answer.collisions && answer.collisions.length > 0)
		lines.push(
			`${plural(answer.collisions.length, "collision")} with work in shared:`,
			...answer.collisions.map(collisionText),
		);
	return { exit: EXIT.refused, text: lines.join("\n"), json: { ...answer } };
}

export async function runAmend(args: Parsed, env: Env): Promise<Output> {
	const message = str(args, "message");
	if (!message) throw new UsageError('give the new message with -m "<message>"');
	const { api } = open(env);
	const a = await api.amend(message);
	const where = a.draft === null ? "shared" : `draft ${a.draft}`;
	return {
		text: `Version ${a.version} of ${where} now says: ${a.message}\n(It said: ${a.was}.) Only the message changed; to change what it did, publish again or abso drop it.`,
		json: { ...a },
	};
}

export async function runLabel(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length !== 1)
		throw new UsageError("label takes one name: abso label <name> [--version <n>] [--remove]");
	const name = labelName(args.positionals[0]);
	const raw = str(args, "version");
	if (raw !== undefined && !/^\d+$/.test(raw))
		throw new UsageError(`--version is a version number (got ${JSON.stringify(raw)})`);
	const remove = bool(args, "remove");
	const { api } = open(env);
	const a = await api.label(name, raw === undefined ? undefined : Number(raw), remove);
	const now =
		a.versions.length === 0 ? "no version now" : `${plural(a.versions.length, "version")}: ${a.versions.join(", ")}`;
	return {
		text: `${remove ? "Took" : "Put"} label ${a.name} ${remove ? "off" : "on"} version ${a.version}. It marks ${now}.`,
		json: { ...a },
	};
}

export async function runLabels(_args: Parsed, env: Env): Promise<Output> {
	const { config, api } = open(env);
	const { labels } = await api.labels();
	const names = Object.keys(labels).sort();
	const lines =
		names.length === 0
			? ["No labels yet. abso label <name> puts one on shared's newest version."]
			: names.map((n) => `  ${n}: ${labels[n]!.join(", ")}${config.follow === n ? "   (this folder follows it)" : ""}`);
	return { text: lines.join("\n"), json: { labels, follow: config.follow ?? null } };
}

export async function runFollow(args: Parsed, env: Env): Promise<Output> {
	const none = bool(args, "none");
	if (none === (args.positionals.length === 1) || args.positionals.length > 1)
		throw new UsageError("follow takes one label, or --none: abso follow <label> | abso follow --none");
	const follow = none ? undefined : labelName(args.positionals[0]);
	const { root, config } = open(env);
	const { token: _token, follow: _old, ...settings } = config;
	writeConfig(root, { ...settings, ...(follow ? { follow } : {}) });
	// Sync now (recording first, as sync does), so the folder is where it now says it is.
	const { api } = open(env);
	await recordFolder(root, api);
	const s = await applyAnswer(root, api, await api.sync());
	const changes = s.written.length + s.deleted.length;
	const head = follow
		? `This folder now follows label ${follow}: every sync takes it to the newest version with that label. It is on version ${s.version}.`
		: `This folder follows no label now: syncs take it to shared's newest version, ${s.version}.`;
	return {
		text: [
			head,
			changes === 0 ? "No files changed." : `${plural(s.written.length, "file")} updated, ${s.deleted.length} deleted.`,
			...refusedText(s.refused),
			...(s.kept.length > 0 ? [`Left alone because they have unrecorded changes: ${s.kept.join(", ")}`] : []),
		].join("\n"),
		json: {
			follow: follow ?? null,
			version: s.version,
			written: s.written,
			deleted: s.deleted,
			kept: s.kept,
			refused: s.refused,
		},
	};
}
