// --without <version,...> on abso show and abso export: a version of shared with some earlier versions left out.
// The server reads it; shared doesn't change. When a version kept builds on one left out, it is refused with
// that chain and the wider set that works, which is never taken without being asked.

import type { VersionRef, WithoutAnswer } from "./api.ts";
import { type Parsed, str, UsageError } from "./args.ts";

/** The versions --without names, sorted, or undefined without it. */
export function withoutArg(args: Parsed): number[] | undefined {
	const raw = str(args, "without");
	if (raw === undefined) return undefined;
	const words = raw
		.split(",")
		.map((w) => w.trim())
		.filter((w) => w !== "");
	if (words.length === 0 || words.some((w) => !/^\d+$/.test(w)))
		throw new UsageError(`--without takes version numbers, like --without 37,38 (got ${JSON.stringify(raw)})`);
	return [...new Set(words.map(Number))].toSorted((a, b) => a - b);
}

/** "version 37", "versions 37 and 38", "versions 37, 38 and 40". */
export function versionsText(versions: readonly number[]): string {
	if (versions.length === 1) return `version ${versions[0]}`;
	return `versions ${versions.slice(0, -1).join(", ")} and ${versions[versions.length - 1]}`;
}

function ref(v: VersionRef): string {
	return `  version ${v.version} by ${v.agent}: ${v.message}`;
}

/** The heading of an answer: the version and what it leaves out, one line each. */
export function withoutHeading(answer: WithoutAnswer): string[] {
	return [
		`Version ${answer.version} of shared without ${versionsText(answer.without.map((w) => w.version))}:`,
		...answer.without.map(ref),
	];
}

/** A refusal: which kept versions build on what is left out, and the ask that would work (`retry` writes it). */
export function refusalText(
	answer: Extract<WithoutAnswer, { ok: false }>,
	retry: (versions: readonly number[]) => string,
): string {
	const asked = answer.without.map((w) => w.version);
	return [
		`Version ${answer.version} of shared can't leave out ${versionsText(asked)}: versions it keeps build on ${asked.length === 1 ? "it" : "them"}.`,
		...answer.dependents.flatMap((d) => [
			ref(d),
			`    builds on ${d.needs.map((n) => `version ${n.version} (${n.files.join(", ") || "no file of its own"})`).join(", ")}`,
		]),
		`Leaving those out too works: ${retry(answer.suggestion)}`,
	].join("\n");
}
