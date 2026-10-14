// Checks in code around the model's pick (#19). What code can decide, code
// decides; what the model picks is turned down when it would plainly break
// the file. Both run before anything is settled automatically.

import type { Hold, Pick } from "./jev.ts";

const solid = (lines: readonly string[]) => lines.map((l) => l.trim()).filter((l) => /[A-Za-z0-9]/.test(l));

/** A pick code can make without the model, with why; undefined when it takes judgment. */
export function ruled(h: Hold): { pick: Pick; reason: string } | undefined {
	const yours = solid(h.yours);
	const theirs = solid(h.theirs);
	if (yours.join("\n") === theirs.join("\n")) return { pick: "theirs", reason: "both sides wrote the same lines" };
	if (yours.length > 0 && yours.every((l) => theirs.includes(l)))
		return { pick: "theirs", reason: "every line of yours is already in theirs" };
	if (theirs.length > 0 && theirs.every((l) => yours.includes(l)))
		return { pick: "yours", reason: "every line of theirs is already in yours" };
	return undefined;
}

/** Why a model's pick can't be applied as it is, or undefined when it can. */
export function refused(h: Hold, pick: Pick): string | undefined {
	if (pick !== "both") return undefined;
	const theirs = new Set(solid(h.theirs));
	const twice = solid(h.yours).filter((l) => theirs.has(l));
	if (twice.length > 0)
		return `keeping both would repeat ${twice.length === 1 ? "a line" : `${twice.length} lines`}: ${twice[0]}`;
	// The same key or name set on both sides: `timeoutMs:`, `limit =`.
	const key = (l: string) => /^([A-Za-z_$"'][\w$"'-]*)\s*[:=]/.exec(l)?.[1];
	const theirKeys = new Set(solid(h.theirs).map(key).filter(Boolean));
	const clash = solid(h.yours)
		.map(key)
		.find((k) => k && theirKeys.has(k));
	if (clash) return `keeping both would set ${clash} twice`;
	// Two versions of one statement, such as an import from the same module with a different list of names:
	// most of the names on one side are on the other too.
	const names = (lines: readonly string[]) => new Set(lines.join(" ").match(/[A-Za-z_$][\w$]{2,}/g) ?? []);
	const a = names(h.yours);
	const b = names(h.theirs);
	const shared = [...a].filter((n) => b.has(n)).length;
	const share = shared / Math.max(1, Math.min(a.size, b.size));
	return share >= 0.5
		? `keeping both would repeat one statement in two versions (${shared} names on both sides)`
		: undefined;
}
