// Text helpers: line endings, splitting, and a line diff (a longest common
// subsequence, found with Myers' O(ND) algorithm in linear space).

/** Normalize line endings to "\n". */
export function normalizeText(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Split normalized text into lines. "" -> []; a trailing "\n" ends the last line. */
export function splitLines(text: string): string[] {
	if (text === "") return [];
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.split("\n");
}

/** Join lines into file text. A non-empty file always ends with "\n". */
export function joinLines(lines: readonly string[]): string {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Normalize, then make a non-empty text end with "\n" (how files are projected). */
export function canonicalText(text: string): string {
	return joinLines(splitLines(normalizeText(text)));
}

/**
 * One hunk of a line diff: old lines [start, end) become `lines`.
 * start === end is a pure insertion before old line `start`.
 */
export interface Hunk {
	readonly start: number;
	readonly end: number;
	readonly lines: readonly string[];
}

/**
 * Line diff of `a` (old) against `b` (new), as hunks in order. The unchanged
 * lines are a longest common subsequence, so every hunk is as small as it can
 * be, up to a cost: where one stretch needs more than about MAX_COST edits (a
 * file reordered or rewritten through), the search stops there and goes on
 * from the furthest point it reached, as git's xdiff does (abso issue 158).
 * The diff is then close to minimal rather than minimal, and costs about the
 * file's length times MAX_COST instead of its length squared.
 */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
	return hunksFromMatches(a.length, b, commonLines(a, b));
}

/** Diff a single-pass old-line source without retaining its strings. */
export function diffLineStream(a: Iterable<string>, b: readonly string[]): Hunk[] {
	const ids = new Map<string, number>();
	const next = b.map((line) => {
		let id = ids.get(line);
		if (id === undefined) {
			id = ids.size;
			ids.set(line, id);
		}
		return id;
	});
	const previous: number[] = [];
	for (const line of a) previous.push(ids.get(line) ?? -1);
	return hunksFromMatches(previous.length, b, commonLines(previous, next));
}

/** Compare replayable old-line chunks without assembling historical strings. */
export function diffChunkedLines(a: Iterable<() => Iterable<string>>, b: readonly string[]): Hunk[] {
	const keys = new Map<string, number>();
	const buckets = new Map<string, number[]>();
	const next = b.map((line, index) => {
		let id = keys.get(line);
		if (id === undefined) {
			id = index;
			keys.set(line, id);
			const key = chunkKey([line]);
			const bucket = buckets.get(key) ?? [];
			bucket.push(id);
			buckets.set(key, bucket);
		}
		return id;
	});
	const previous: number[] = [];
	for (const chunks of a) {
		const iterator = chunks()[Symbol.iterator]();
		let key: string;
		const aligned = b[previous.length];
		let alignedOffset = 0;
		let alignedEqual = aligned !== undefined;
		try {
			const first = iterator.next();
			if (first.done) {
				previous.push(keys.get("") ?? -1);
				continue;
			}
			const second = iterator.next();
			if (second.done) {
				previous.push(keys.get(first.value) ?? -1);
				continue;
			}
			key = chunkKey(
				(function* () {
					function* remaining() {
						yield first.value;
						yield second.value;
						for (let next = iterator.next(); !next.done; next = iterator.next()) yield next.value;
					}
					for (const chunk of remaining()) {
						if (alignedEqual && !aligned!.startsWith(chunk, alignedOffset)) alignedEqual = false;
						alignedOffset += chunk.length;
						yield chunk;
					}
				})(),
			);
		} finally {
			iterator.return?.();
		}
		// Same-position unchanged lines are common. Confirm them during hashing,
		// retaining exact comparison and the collision-safe fallback for moved lines.
		if (alignedEqual && alignedOffset === aligned!.length) {
			previous.push(next[previous.length]!);
			continue;
		}
		const candidates = buckets.get(key);
		let match = -1;
		for (const candidate of candidates ?? []) {
			let offset = 0;
			let equal = true;
			for (const chunk of chunks()) {
				if (!b[candidate]!.startsWith(chunk, offset)) equal = false;
				offset += chunk.length;
			}
			if (equal && offset === b[candidate]!.length) {
				match = candidate;
				break;
			}
		}
		previous.push(match);
	}
	return hunksFromMatches(previous.length, b, commonLines(previous, next));
}

function chunkKey(chunks: Iterable<string>): string {
	let hash = 2166136261;
	let length = 0;
	for (const chunk of chunks) {
		length += chunk.length;
		for (let i = 0; i < chunk.length; i++) hash = Math.imul(hash ^ chunk.charCodeAt(i), 16777619) >>> 0;
	}
	return `${length}:${hash}`;
}

/** The existing diff algorithm over exact line symbols, without retaining text. */
export function diffLineSymbols(
	a: readonly number[],
	b: readonly number[],
): { start: number; end: number; lines: number[] }[] {
	return hunksFromMatches(a.length, b, commonLines(a, b));
}

function hunksFromMatches<T>(
	length: number,
	b: readonly T[],
	matches: readonly number[],
): { start: number; end: number; lines: T[] }[] {
	const hunks: { start: number; end: number; lines: T[] }[] = [];
	let i = 0;
	let j = 0;
	for (let m = 0; m <= matches.length; m += 2) {
		const mi = m < matches.length ? matches[m]! : length;
		const mj = m < matches.length ? matches[m + 1]! : b.length;
		if (mi > i || mj > j) hunks.push({ start: i, end: mi, lines: b.slice(j, mj) });
		i = mi + 1;
		j = mj + 1;
	}
	return hunks;
}

/**
 * The matched pairs of a longest common subsequence of `a` and `b`, flattened
 * as [i0, j0, i1, j1, ...] in increasing order.
 */
function commonLines<T>(a: readonly T[], b: readonly T[]): number[] {
	// Common prefix and suffix match directly.
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const out: number[] = [];
	for (let k = 0; k < pre; k++) out.push(k, k);

	// A line that occurs on only one side can never be matched; leave it out of
	// the search (this also makes wholly different texts instant).
	const ids = new Map<T, number>();
	const intern = (s: T): number => {
		let id = ids.get(s);
		if (id === undefined) {
			id = ids.size;
			ids.set(s, id);
		}
		return id;
	};
	const inA = new Set<number>();
	const inB = new Set<number>();
	const aIds: number[] = [];
	const bIds: number[] = [];
	for (let i = pre; i < a.length - suf; i++) inA.add((aIds[i - pre] = intern(a[i]!)));
	for (let j = pre; j < b.length - suf; j++) inB.add((bIds[j - pre] = intern(b[j]!)));
	const aPos: number[] = [];
	const bPos: number[] = [];
	const x: number[] = [];
	const y: number[] = [];
	aIds.forEach((id, i) => {
		if (inB.has(id)) {
			aPos.push(pre + i);
			x.push(id);
		}
	});
	bIds.forEach((id, j) => {
		if (inA.has(id)) {
			bPos.push(pre + j);
			y.push(id);
		}
	});
	const pairs: number[] = [];
	myers(Int32Array.from(x), Int32Array.from(y), 0, x.length, 0, y.length, pairs);
	for (let k = 0; k < pairs.length; k += 2) out.push(aPos[pairs[k]!]!, bPos[pairs[k + 1]!]!);

	for (let k = suf; k > 0; k--) out.push(a.length - k, b.length - k);
	return out;
}

/** About how many edits one stretch of a diff searches before settling for close to minimal (git's XDL_MAX_COST_MIN). */
export const MAX_COST = 256;

/**
 * Myers' linear-space diff on a[aLo, aHi) and b[bLo, bHi): pushes the pairs
 * of a longest common subsequence, in order, onto `out`. Each step splits the
 * problem at a point on an optimal edit path and recurses on both halves.
 */
function myers(a: Int32Array, b: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number, out: number[]): void {
	while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) out.push(aLo++, bLo++);
	let suf = 0;
	while (aLo < aHi - suf && bLo < bHi - suf && a[aHi - 1 - suf] === b[bHi - 1 - suf]) suf++;
	const n = aHi - suf - aLo;
	const m = bHi - suf - bLo;
	if (n > 0 && m > 0) {
		const split = bisect(a, aLo, n, b, bLo, m, Math.max(MAX_COST, Math.ceil(Math.sqrt(n + m))));
		if (split) {
			myers(a, b, aLo, aLo + split[0], bLo, bLo + split[1], out);
			myers(a, b, aLo + split[0], aHi - suf, bLo + split[1], bHi - suf, out);
		}
	}
	for (let k = suf; k > 0; k--) out.push(aHi - k, bHi - k);
}

/**
 * Where the furthest-reaching forward and backward paths of a shortest edit
 * script between a[aLo, aLo+n) and b[bLo, bLo+m) meet: a point [x, y] on an
 * optimal path, relative to aLo and bLo. Both inputs are non-empty and differ
 * in their first and last elements, so the point is neither corner and both
 * halves are strictly smaller. Diagonals that run off the edit grid are
 * dropped from the search (as in diff-match-patch's diff_bisect). Past `cap`
 * edits it stops and answers the furthest point a forward path reached, which
 * is on a path of that many edits from the start, so the first half stays
 * exact; that point is never a corner, so both halves are still smaller.
 */
function bisect(
	a: Int32Array,
	aLo: number,
	n: number,
	b: Int32Array,
	bLo: number,
	m: number,
	cap: number,
): [number, number] | undefined {
	const maxD = Math.ceil((n + m) / 2);
	let bestX = -1;
	let bestY = -1;
	const offset = maxD;
	const size = 2 * maxD + 2;
	const v1 = new Int32Array(size).fill(-1);
	const v2 = new Int32Array(size).fill(-1);
	v1[offset + 1] = 0;
	v2[offset + 1] = 0;
	const delta = n - m;
	const front = (delta & 1) !== 0;
	let k1start = 0;
	let k1end = 0;
	let k2start = 0;
	let k2end = 0;
	for (let d = 0; d <= maxD; d++) {
		for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
			const i1 = offset + k1;
			let x1 = k1 === -d || (k1 !== d && v1[i1 - 1]! < v1[i1 + 1]!) ? v1[i1 + 1]! : v1[i1 - 1]! + 1;
			let y1 = x1 - k1;
			while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
				x1++;
				y1++;
			}
			v1[i1] = x1;
			if (x1 <= n && y1 <= m && x1 + y1 > bestX + bestY && x1 + y1 < n + m) {
				bestX = x1;
				bestY = y1;
			}
			if (x1 > n) k1end += 2;
			else if (y1 > m) k1start += 2;
			else if (front) {
				const i2 = offset + delta - k1;
				if (i2 >= 0 && i2 < size && v2[i2] !== -1 && x1 >= n - v2[i2]!) return [x1, y1];
			}
		}
		for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
			const i2 = offset + k2;
			let x2 = k2 === -d || (k2 !== d && v2[i2 - 1]! < v2[i2 + 1]!) ? v2[i2 + 1]! : v2[i2 - 1]! + 1;
			let y2 = x2 - k2;
			while (x2 < n && y2 < m && a[aLo + n - 1 - x2] === b[bLo + m - 1 - y2]) {
				x2++;
				y2++;
			}
			v2[i2] = x2;
			if (x2 > n) k2end += 2;
			else if (y2 > m) k2start += 2;
			else if (!front) {
				const i1 = offset + delta - k2;
				if (i1 >= 0 && i1 < size && v1[i1] !== -1) {
					const x1 = v1[i1]!;
					if (x1 >= n - x2) return [x1, offset + x1 - i1];
				}
			}
		}
		if (d >= cap) {
			if (bestX + bestY > 0) return [bestX, bestY];
			const x = n >> 1;
			const y = m >> 1;
			return x + y > 0 && x + y < n + m ? [x, y] : [n, 0];
		}
	}
	return undefined; // not reached: the paths meet by d = ceil((n + m) / 2)
}

/**
 * Three-way merge of lines, the way git merges a file: `ours` and `theirs`
 * both started from `base`. Changes on one side only are taken; changes both
 * sides made identically are taken once; changes that overlap or touch and
 * differ are a conflict (counted, with ours kept in `lines`), unless
 * `resolve` settles it: given the base span and each side's text for it, it
 * may return the merged text. `resolved` lists where each settled span
 * starts in `lines`.
 */
export function mergeLines(
	base: readonly string[],
	ours: readonly string[],
	theirs: readonly string[],
	resolve?: (
		base: readonly string[],
		ours: readonly string[],
		theirs: readonly string[],
		at: number,
	) => string[] | undefined,
	conflict?: (span: MergeConflict) => string[],
): { lines: string[]; conflicts: number; resolved: number[]; conflictsAt: { at: number; length: number }[] } {
	const resolved: number[] = [];
	const conflictsAt: { at: number; length: number }[] = [];
	// How far each side's line numbers have moved from the base's, by the hunks before the current span.
	let oShift = 0;
	let tShift = 0;
	const oh = diffLines(base, ours);
	const th = diffLines(base, theirs);
	const out: string[] = [];
	let conflicts = 0;
	let pos = 0;
	let i = 0;
	let j = 0;
	const apply = (group: readonly Hunk[], lo: number, hi: number): string[] => {
		const result: string[] = [];
		let p = lo;
		for (const h of group) {
			result.push(...base.slice(p, h.start), ...h.lines);
			p = h.end;
		}
		result.push(...base.slice(p, hi));
		return result;
	};
	while (i < oh.length || j < th.length) {
		const first = j >= th.length || (i < oh.length && oh[i]!.start <= th[j]!.start) ? oh[i++]! : th[j++]!;
		const groupO: Hunk[] = [];
		const groupT: Hunk[] = [];
		(oh.includes(first) ? groupO : groupT).push(first);
		const lo = first.start;
		let hi = first.end;
		// Every hunk that overlaps or touches the span joins the group.
		for (let grew = true; grew; ) {
			grew = false;
			while (i < oh.length && oh[i]!.start <= hi) {
				groupO.push(oh[i]!);
				hi = Math.max(hi, oh[i++]!.end);
				grew = true;
			}
			while (j < th.length && th[j]!.start <= hi) {
				groupT.push(th[j]!);
				hi = Math.max(hi, th[j++]!.end);
				grew = true;
			}
		}
		out.push(...base.slice(pos, lo));
		const o = apply(groupO, lo, hi);
		const t = apply(groupT, lo, hi);
		if (groupO.length === 0) out.push(...t);
		else if (groupT.length === 0 || (o.length === t.length && o.every((l, k) => l === t[k]))) out.push(...o);
		else {
			const settled = resolve?.(base.slice(lo, hi), o, t, lo);
			if (settled) {
				resolved.push(out.length);
				out.push(...settled);
			} else {
				conflicts++;
				const shown = conflict
					? conflict({
							base: base.slice(lo, hi),
							ours: o,
							theirs: t,
							baseAt: lo,
							oursAt: lo + oShift,
							theirsAt: lo + tShift,
						})
					: o;
				conflictsAt.push({ at: out.length, length: shown.length });
				out.push(...shown);
			}
		}
		oShift += o.length - (hi - lo);
		tShift += t.length - (hi - lo);
		pos = hi;
	}
	out.push(...base.slice(pos));
	return { lines: out, conflicts, resolved, conflictsAt };
}

/** A span both sides changed differently: each side's text, and where it starts in base, ours and theirs (0-based). */
export interface MergeConflict {
	readonly base: readonly string[];
	readonly ours: readonly string[];
	readonly theirs: readonly string[];
	readonly baseAt: number;
	readonly oursAt: number;
	readonly theirsAt: number;
}

/**
 * Merge one line both sides changed, word by word (#37): `const SYSTEMS =
 * [a, b, c]` with d added on one side and e on the other becomes
 * `[a, b, c, e, d]`. Words and punctuation are merged like lines. Where both
 * inserted different things at the same point, both are kept (theirs, then
 * ours) only when each is a list item, beginning or ending with a comma, inside
 * `[...]` or `{...}` in the base line; call arguments and anything else are no
 * merge. Any other overlap is no merge either (undefined).
 */
export function mergeWords(base: string, ours: string, theirs: string): string | undefined {
	const words = (s: string): string[] => s.match(/[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g) ?? [];
	const b = words(base);
	const OPEN = "([{";
	const CLOSE = ")]}";
	const listItem = (piece: readonly string[]): boolean => {
		const solid = piece.filter((w) => w.trim() !== "");
		if (solid.length < 2 || (solid[0] !== "," && solid[solid.length - 1] !== ",")) return false;
		let depth = 0;
		for (const w of solid) {
			if (OPEN.includes(w)) depth++;
			else if (CLOSE.includes(w) && --depth < 0) return false;
		}
		return depth === 0;
	};
	// The bracket the insertion point sits in, in the base line.
	const enclosing = (at: number): string | undefined => {
		let depth = 0;
		for (let i = at - 1; i >= 0; i--) {
			if (CLOSE.includes(b[i]!)) depth++;
			else if (OPEN.includes(b[i]!)) {
				if (depth === 0) return b[i];
				depth--;
			}
		}
		return undefined;
	};
	const m = mergeLines(b, words(ours), words(theirs), (span, o, t, at) => {
		const bracket = enclosing(at);
		return span.length === 0 && (bracket === "[" || bracket === "{") && listItem(o) && listItem(t)
			? [...t, ...o]
			: undefined;
	});
	return m.conflicts > 0 ? undefined : m.lines.join("");
}
