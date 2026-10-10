// Shared test helpers: a seeded PRNG and a small harness around graph + shared set.

import {
	type Atom,
	type AtomId,
	type AtomInput,
	buildAtom,
	buildBase,
	checkDraft,
	type DraftReport,
	Graph,
	type LineId,
	View,
} from "../index.ts";

/** mulberry32: a tiny seeded PRNG. Never Math.random in tests. */
export class Rng {
	#state: number;
	constructor(seed: number) {
		this.#state = seed >>> 0;
	}
	next(): number {
		this.#state = (this.#state + 0x6d2b79f5) >>> 0;
		let t = this.#state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	/** Integer in [0, n). */
	int(n: number): number {
		return Math.floor(this.next() * n);
	}
	/** Integer in [lo, hi]. */
	range(lo: number, hi: number): number {
		return lo + this.int(hi - lo + 1);
	}
	chance(p: number): boolean {
		return this.next() < p;
	}
	pick<T>(items: readonly T[]): T {
		if (items.length === 0) throw new Error("pick from empty list");
		return items[this.int(items.length)]!;
	}
	shuffle<T>(items: readonly T[]): T[] {
		const out = [...items];
		for (let i = out.length - 1; i > 0; i--) {
			const j = this.int(i + 1);
			[out[i], out[j]] = [out[j]!, out[i]!];
		}
		return out;
	}
}

/** A graph plus a shared set, the way the CLI will hold them. */
export class Repo {
	readonly graph: Graph;
	shared: Set<AtomId>;
	#clock = 1_000;

	constructor(graph: Graph, shared: Iterable<AtomId>) {
		this.graph = graph;
		this.shared = new Set(shared);
	}

	static init(files: Record<string, string>): Repo {
		const graph = new Graph();
		graph.add(buildBase(files, { author: "import", message: "starting snapshot", time: 0 }));
		return new Repo(graph, ["a0"]);
	}

	view(set: Iterable<AtomId> = this.shared): View {
		return new View(this.graph, set);
	}

	/** Build without accepting. */
	draft(
		input: Omit<AtomInput, "author" | "message"> & { author?: string; message?: string },
		against?: Iterable<AtomId>,
	): Atom {
		return buildAtom(this.view(against ?? this.shared), {
			author: "agent",
			message: "change",
			time: this.#clock++,
			...input,
		});
	}

	/** Check a draft against the shared set. */
	check(draft: Atom): DraftReport {
		return checkDraft(this.graph, this.shared, draft);
	}

	/**
	 * Build against `against` (default: the shared set), accept it into the
	 * graph and add it to the shared set.
	 */
	edit(
		input: Omit<AtomInput, "author" | "message"> & { author?: string; message?: string },
		against?: Iterable<AtomId>,
	): Atom {
		const atom = this.draft(input, against);
		this.graph.add(atom);
		this.shared.add(atom.id);
		return atom;
	}

	files(set: Iterable<AtomId> = this.shared): Record<string, string> {
		return this.view(set).files();
	}

	text(file: string, set: Iterable<AtomId> = this.shared): string {
		return this.view(set).text(file);
	}

	/** The id of the one visible line with this exact text. */
	lineId(file: string, text: string, set: Iterable<AtomId> = this.shared): LineId {
		const hits = this.view(set)
			.lines(file)
			.filter((l) => l.text === text);
		if (hits.length !== 1)
			throw new Error(`expected one line ${JSON.stringify(text)} in ${file}, found ${hits.length}`);
		return hits[0]!.id;
	}

	/** 0-based visible line number of the one line with this text. */
	lineNo(file: string, text: string): number {
		const lines = this.view().lines(file);
		const i = lines.findIndex((l) => l.text === text);
		if (i < 0) throw new Error(`no line ${JSON.stringify(text)} in ${file}`);
		return i;
	}
}

/** Lines of text with a trailing newline. */
export function lines(...items: string[]): string {
	return items.map((s) => `${s}\n`).join("");
}
