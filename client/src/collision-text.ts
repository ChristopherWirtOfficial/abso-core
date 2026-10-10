// How a collision, and the lines a sync merged, read to an agent.

import type { Collision, MergedLine } from "./api.ts";
import { plural } from "./command-env.ts";

/** `[first, last]`, 1-based; `[n, n-1]` means that side left no lines at line n. */
function describeLines(lines: unknown): string {
	if (Array.isArray(lines) && lines.length === 2 && lines.every((n) => typeof n === "number")) {
		const [first, last] = lines as [number, number];
		if (last < first) return `no lines, at line ${first}`;
		return first === last ? `line ${first}` : `lines ${first}-${last}`;
	}
	return `lines ${JSON.stringify(lines)}`;
}

/** Lines a sync merged item by item: not collisions and no publish waits on them, but the agent should read them (#37). */
export function mergedLinesText(merged: readonly MergedLine[]): string[] {
	if (merged.length === 0) return [];
	const one = (m: MergedLine) =>
		`${m.file} line ${m.line}, with ${m.theirs.agent}'s version ${m.theirs.version} ("${m.theirs.message}"): ${m.text}`;
	const who = new Set(merged.map((m) => m.theirs.agent)).size === 1 ? merged[0]!.theirs.agent : "others";
	return [
		`Merged ${merged.length === 1 ? "1 line" : `${merged.length} lines`} that both you and ${who} changed, item by item. Check ${merged.length === 1 ? "it reads" : "they read"} right, then push:`,
		...merged.map((m) => `  ${one(m)}`),
	];
}

/** The line above a sync's or switch's collisions: what the folder now holds, said only for the kinds that apply. */
export function collisionsHeading(collisions: readonly Collision[]): string {
	// Lines changed on both sides: publish refuses them untouched (#37), so say to edit them, or --as-is to keep both.
	const marked = collisions.some((c) => c.marked);
	const lines = !marked && collisions.some((c) => c.kind === undefined || c.kind === "lines");
	const twice = collisions.some((c) => c.kind === "duplicate");
	return [
		`${plural(collisions.length, "collision")}:`,
		...(marked
			? [
					"where lines changed on both sides, the file now holds a marker block: yours, the lines you both started from, and theirs. Settle each before you push: keep yours, theirs or a mix and delete the marker lines, or run abso settle <file> --yours|--theirs|--both. Box runs fail while markers are in the folder.",
				]
			: []),
		...(lines
			? [
					"where lines changed on both sides, the files now hold both, with no markers. Edit them to what they should be before you push; if both really belong, abso push --as-is keeps both.",
				]
			: []),
		...(twice ? ["a name defined twice needs one definition kept before you push."] : []),
		...(!marked && !lines && !twice ? ["read each one, edit what needs it, then push."] : []),
	].join(" ");
}

/** Others' versions a publish went on top of: said plainly, since "version 4" alone read as overwriting version 3 (#37). */
export function mergedText(
	merged: readonly { readonly version: number; readonly agent: string; readonly message: string }[],
): string {
	const which = merged.map((m) => `version ${m.version} (${m.agent}: "${m.message}")`);
	const list = which.length === 1 ? which[0]! : `${which.slice(0, -1).join(", ")} and ${which[which.length - 1]}`;
	return `It went on top of ${list}, which your folder doesn't have yet. Nothing of theirs was overwritten; run abso pull to see both.`;
}

export function collisionText(c: Collision): string {
	// Theirs may still be waiting in the merge queue (#39): not a version yet.
	const v =
		c.theirs.queued !== undefined ? `queued push ${c.theirs.queued} (not landed yet)` : `version ${c.theirs.version}`;
	const indent = (text: string): string =>
		text
			.replace(/\n$/, "")
			.split("\n")
			.map((l) => `      ${l}`)
			.join("\n");
	if (c.marked) {
		// The block's range in the file (yours.lines, as the engine sends it); a stray marker line has no other author.
		const range = (c.lines ?? c.yours.lines) as readonly [number, number] | undefined;
		const at = Array.isArray(range)
			? range[0] === range[1]
				? `line ${range[0]}`
				: `lines ${range[0]}-${range[1]}`
			: "a marker block";
		if (c.theirs.agent === "") return `  ${c.file} ${at}: a marker line left from a collision; delete it.`;
		return `  ${c.file} ${at}: yours against ${c.theirs.agent}'s ${v} ("${c.theirs.message}").`;
	}
	if (c.kind === "attribute") {
		// The value as text: "1" for executable, a link's target; "" for neither.
		const value = (text: string): string =>
			c.name === "exec"
				? text === ""
					? "not executable"
					: "executable"
				: text === ""
					? "a plain file, not a link"
					: `a link to ${text}`;
		return [
			`  ${c.file}: you and ${c.theirs.agent} both changed ${c.name === "exec" ? "whether it is executable" : "where it links"}.`,
			`    yours: ${value(c.yours.text)}`,
			`    theirs, by ${c.theirs.agent} in ${v} ("${c.theirs.message}"): ${value(c.theirs.text)}`,
		].join("\n");
	}
	if (c.kind === "duplicate") {
		return [
			`  ${c.file}: ${c.name ?? "a name"} is defined twice, yours (${describeLines(c.yours.lines)}) and ${c.theirs.agent}'s from ${v} ("${c.theirs.message}") (${describeLines(c.theirs.lines)}). Keep one, then push.`,
			`    yours:`,
			indent(c.yours.text),
			`    theirs:`,
			indent(c.theirs.text),
		].join("\n");
	}
	if (c.kind === "definition") {
		const where = c.theirs.file ?? c.file;
		return [
			`  ${c.file}: your draft uses ${c.name ?? "a name"}, whose definition ${c.theirs.agent} changed in ${v} ("${c.theirs.message}").`,
			`    where you use it (${describeLines(c.yours.lines)}):`,
			indent(c.yours.text),
			c.theirs.text === ""
				? `    their change removed it from ${where}.`
				: `    the definition now, in ${where} (${describeLines(c.theirs.lines)}):\n${indent(c.theirs.text)}`,
		].join("\n");
	}
	return [
		`  ${c.file}:`,
		`    yours (${describeLines(c.yours.lines)}):`,
		indent(c.yours.text),
		`    theirs, by ${c.theirs.agent} in ${v} ("${c.theirs.message}") (${describeLines(c.theirs.lines)}):`,
		indent(c.theirs.text),
	].join("\n");
}
