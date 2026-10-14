import type { Graph } from "../../src/engine/graph.ts";
import { PLAIN_LINE } from "./collisions.ts";

/** Exact text symbols backed by graph line IDs, never retained whole strings. */
export class MoveLineText {
	readonly graph: Graph;
	readonly buckets = new Map<string, { symbol: number; line: number }[]>();
	readonly plain: boolean[] = [];
	readonly lines: number[] = [];
	readonly symbolsByLine = new Map<number, number>();
	constructor(graph: Graph) {
		this.graph = graph;
	}
	text(symbol: number): string {
		const line = this.lines[symbol];
		if (line === undefined) throw Error("unknown move text symbol");
		return this.graph.textOf(line);
	}

	intern(id: string): number {
		const line = this.graph.lineN(id);
		const known = this.symbolsByLine.get(line);
		if (known !== undefined) return known;
		let hash = 2166136261,
			length = 0,
			plain = true;
		for (const chunk of this.graph.textChunks(line)) {
			length += chunk.length;
			if (!PLAIN_LINE.test(chunk)) plain = false;
			for (let i = 0; i < chunk.length; i++) hash = Math.imul(hash ^ chunk.charCodeAt(i), 16777619) >>> 0;
		}
		const key = `${length}:${hash}`;
		const bucket = this.buckets.get(key) ?? [];
		for (const candidate of bucket)
			if (sameChunks(this.graph.textChunks(line), this.graph.textChunks(candidate.line))) {
				this.symbolsByLine.set(line, candidate.symbol);
				return candidate.symbol;
			}
		const symbol = this.plain.length;
		this.plain.push(plain);
		this.lines.push(line);
		bucket.push({ symbol, line });
		this.buckets.set(key, bucket);
		this.symbolsByLine.set(line, symbol);
		return symbol;
	}
}

function sameChunks(a: IterableIterator<string>, b: IterableIterator<string>): boolean {
	let x = a.next(),
		y = b.next(),
		i = 0,
		j = 0;
	try {
		for (;;) {
			while (!x.done && i === x.value.length) {
				x = a.next();
				i = 0;
			}
			while (!y.done && j === y.value.length) {
				y = b.next();
				j = 0;
			}
			if (x.done || y.done) return x.done === y.done;
			const length = Math.min(x.value.length - i, y.value.length - j);
			if (x.value.slice(i, i + length) !== y.value.slice(j, j + length)) return false;
			i += length;
			j += length;
		}
	} finally {
		a.return?.();
		b.return?.();
	}
}
