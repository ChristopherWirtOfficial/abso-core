import { normalizeText } from "../../src/engine/index.ts";
import type { Pair } from "./collisions.ts";
import { ProjectError } from "./project-error.ts";
import type { PersonSender, Refusal, RefusalCounts } from "./project-types.ts";
import type { Published } from "./spaces.ts";

/** A draft's or an agent's name: letters, digits, '.', '_' and '-', up to 64. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A person's id and name as the Worker passed them (#41): 1-100 characters, no control or invisible characters. */
export function checkPerson(person: { id: unknown; name: unknown }): PersonSender {
	const plain = (v: unknown, what: string): string => {
		if (
			typeof v !== "string" ||
			v.trim() === "" ||
			v.length > 100 ||
			/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(v)
		) {
			throw new ProjectError(
				"bad-request",
				`the person's ${what} must be 1-100 characters, with no control or invisible characters`,
			);
		}
		return v.trim();
	};
	return { person: { id: plain(person?.id, "id"), name: plain(person?.name, "name") }, via: "website" };
}

export function countRefusals(list: readonly Refusal[]): RefusalCounts {
	const counts: RefusalCounts = { total: list.length, lines: 0, definition: 0, attribute: 0, duplicate: 0 };
	for (const r of list) for (const kind of new Set(r.collisions.map((c) => c.kind))) counts[kind]++;
	return counts;
}

/** The project file's names, the one read first first (224): abso.json, then avcs.json from before the rename. */
export const PROJECT_FILES = ["abso.json", "avcs.json"] as const;

/**
 * The project file a set of files holds: abso.json when it has one, else
 * avcs.json. `ignored` names avcs.json when both are there, so status can say
 * which one counts.
 */
export function projectFileIn(files: {
	hasFile(path: string): boolean;
	text(path: string): string;
}): { name: (typeof PROJECT_FILES)[number]; text: string; ignored?: "avcs.json" } | undefined {
	const [name, other] = PROJECT_FILES.filter((n) => files.hasFile(n));
	if (!name) return undefined;
	return { name, text: files.text(name), ...(other ? { ignored: "avcs.json" as const } : {}) };
}

/** projectFileIn for a plain path -> text record (init, git intake). */
export function projectFileOf(files: Readonly<Record<string, unknown>>): ReturnType<typeof projectFileIn> {
	return projectFileIn({ hasFile: (p) => typeof files[p] === "string", text: (p) => files[p] as string });
}

/**
 * What's wrong with a project file (abso.json or avcs.json), or undefined:
 * it must be a JSON object, and the keys abso reads must have their types:
 * "whole" a list of globs, "queue" true or false, "review" a list of
 * {paths, reviewer}, and CI's "setup", "build", "check" and "out" strings.
 */
export function configProblem(text: string): string | undefined {
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch (e) {
		return `isn't valid JSON (${e instanceof Error ? e.message : String(e)})`;
	}
	if (typeof config !== "object" || config === null || Array.isArray(config)) return "must be a JSON object";
	const c = config as Record<string, unknown>;
	if (c.whole !== undefined && (!Array.isArray(c.whole) || !c.whole.every((p) => typeof p === "string")))
		return `has "whole" that isn't a list of path globs`;
	if (c.queue !== undefined && typeof c.queue !== "boolean") return `has "queue" that isn't true or false`;
	if (c.review !== undefined) {
		const ok =
			Array.isArray(c.review) &&
			c.review.every((r) => {
				const { paths, reviewer } = (r ?? {}) as { paths?: unknown; reviewer?: unknown };
				return (
					Array.isArray(paths) &&
					paths.every((p) => typeof p === "string") &&
					typeof reviewer === "string" &&
					reviewer !== ""
				);
			});
		if (!ok) return `has "review" that isn't a list of {"paths": [globs], "reviewer": "<agent>"}`;
	}
	for (const key of ["setup", "build", "check", "out"])
		if (c[key] !== undefined && typeof c[key] !== "string") return `has "${key}" that isn't a string`;
	return undefined;
}

/** What a kept row of a version's files must match (#41): the version as the log holds it. */
export function shapeStamp(p: Published): string {
	return `${p.agent} ${p.time} ${p.atoms.length} ${p.atoms[p.atoms.length - 1] ?? ""} ${p.dropped?.length ?? 0}`;
}

export function checkDraftName(name: unknown): string {
	if (typeof name !== "string" || !NAME.test(name)) {
		throw new ProjectError(
			"bad-request",
			`bad draft name ${JSON.stringify(name)}: letters, digits, '.', '_' and '-', up to 64`,
		);
	}
	return name;
}

/** Replace the one occurrence of `old` in `text`, or undefined when it isn't there exactly once. */
export function replaceOnce(text: string, old: unknown, replacement: unknown): string | undefined {
	if (typeof old !== "string" || typeof replacement !== "string") {
		throw new ProjectError("bad-request", "each edit needs old and new strings");
	}
	const o = normalizeText(old);
	if (o === "") return undefined;
	const at = text.indexOf(o);
	if (at < 0 || text.indexOf(o, at + 1) >= 0) return undefined;
	return text.slice(0, at) + normalizeText(replacement) + text.slice(at + o.length);
}

export function pairKey(p: Pair): string {
	return `${p.yours} ${p.theirs}`;
}

export function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const k of Object.keys(obj).toSorted()) out[k] = obj[k]!;
	return out;
}

/** A string's length in UTF-8 bytes, without encoding it (Sizes in a folder, #41). */
export function utf8Bytes(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}
