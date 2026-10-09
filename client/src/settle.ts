// abso settle <file...> --yours | --theirs | --both: settle a file's
// collisions by rewriting the marker blocks a sync wrote into it (#11, round
// 1). A block is exactly four marker lines, in this order, as the engine
// writes them:
//
//   <<<<<<< yours (unpublished)
//   ...yours
//   ||||||| before (version N)
//   ...the lines both started from
//   =======
//   ...theirs
//   >>>>>>> theirs: <agent>, version N "<message>"
//
// Anything else that merely starts with <<<<<<< (a doc about git, a test
// fixture) is not a block and is left alone. The server works out at publish
// which side survived, and tells the other author.

import { readFileSync } from "node:fs";
import { UsageError } from "./args.ts";

export type Keep = "yours" | "theirs" | "both";

const OPEN = "<<<<<<< yours (unpublished)";
const BASE = /^\|\|\|\|\|\|\| before \(version \d+\)$/;
const MID = "=======";
const CLOSE = /^>>>>>>> theirs: /;

export interface Block {
	/** 0-based index of the opening marker line. */
	readonly start: number;
	/** 0-based index of the closing marker line. */
	readonly end: number;
	readonly yours: readonly string[];
	readonly base: readonly string[];
	readonly theirs: readonly string[];
}

/** The marker blocks in a file's lines. A run of lines that doesn't follow the four markers in order is not a block. */
export function findBlocks(lines: readonly string[]): Block[] {
	const out: Block[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] !== OPEN) continue;
		let base = -1;
		let mid = -1;
		let end = -1;
		for (let j = i + 1; j < lines.length; j++) {
			const l = lines[j]!;
			if (l === OPEN) break;
			if (base === -1 && BASE.test(l)) base = j;
			else if (base !== -1 && mid === -1 && l === MID) mid = j;
			else if (mid !== -1 && CLOSE.test(l)) {
				end = j;
				break;
			}
		}
		if (end === -1) continue;
		out.push({
			start: i,
			end,
			yours: lines.slice(i + 1, base),
			base: lines.slice(base + 1, mid),
			theirs: lines.slice(mid + 1, end),
		});
		i = end;
	}
	return out;
}

/** The text with each block replaced by the side kept (both: yours, then theirs), keeping the file's line endings. */
export function settleText(text: string, keep: Keep): { text: string; blocks: number } {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const blocks = findBlocks(lines);
	if (blocks.length === 0) return { text, blocks: 0 };
	const out: string[] = [];
	let at = 0;
	for (const b of blocks) {
		out.push(...lines.slice(at, b.start));
		if (keep !== "theirs") out.push(...b.yours);
		if (keep !== "yours") out.push(...b.theirs);
		at = b.end + 1;
	}
	out.push(...lines.slice(at));
	return { text: out.join(eol), blocks: blocks.length };
}

/** Which side the flags name: exactly one of --yours, --theirs, --both. */
export function keepFrom(flags: { yours: boolean; theirs: boolean; both: boolean }): Keep {
	const picked = (["yours", "theirs", "both"] as const).filter((k) => flags[k]);
	if (picked.length !== 1)
		throw new UsageError("say which side to keep, once: abso settle <file...> --yours, --theirs or --both");
	return picked[0]!;
}

/** How many blocks a file on disk holds (0 when it can't be read as text). */
export function blocksIn(path: string): number {
	try {
		return findBlocks(readFileSync(path, "utf8").split(/\r?\n/)).length;
	} catch {
		return 0;
	}
}
