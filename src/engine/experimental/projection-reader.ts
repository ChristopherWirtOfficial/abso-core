import { startNode } from "../keys.ts";
import { StableSet } from "../state-source.ts";
import type { FileAttrs, ReadView, SeqLine, VisibleLine } from "../view.ts";
import type { ExperimentalMarkerProjection, MarkerState } from "./projection-marker.ts";

/** Private reader for a host-verified immutable projection. Not a production View replacement. */
export class ProjectionReader implements ReadView {
	readonly #adapter: ExperimentalMarkerProjection;
	readonly #state: MarkerState;
	readonly #assertLive: () => void;
	constructor(adapter: ExperimentalMarkerProjection, state: MarkerState, assertLive: () => void) {
		assertLive();
		this.#assertLive = assertLive;
		adapter.assertContext(state);
		this.#adapter = adapter;
		this.#state = structuredClone(state);
	}
	get graph() {
		this.#assertLive();
		return this.#adapter.graph;
	}
	get set(): ReadonlySet<string> {
		this.#assertLive();
		const has = (id: string) =>
			this.graph.has(id) && (this.#adapter.members.get(this.#state.membership, Number(id.slice(1)))?.present ?? false);
		const assertLive = this.#assertLive;
		const members = this.#adapter.members;
		const root = this.#state.membership;
		const graph = this.graph;
		return new (class extends StableSet<string> {
			readonly retainedBytes = 64;
			has(id: string): boolean {
				assertLive();
				return has(id);
			}
			*values(): SetIterator<string> {
				assertLive();
				const iterator = members.entries(root);
				try {
					for (;;) {
						assertLive();
						const item = iterator.next();
						if (item.done) return;
						const [seq, member] = item.value;
						if (member.present) yield graph.idOfSeq(seq);
					}
				} finally {
					iterator.return?.();
				}
			}
		})();
	}
	paths(): string[] {
		this.#assertLive();
		return this.knownPaths().filter((path) => this.hasFile(path));
	}
	files(): Record<string, string> {
		this.#assertLive();
		return Object.fromEntries(
			this.paths()
				.filter((path) => this.attrs(path).blob === null)
				.map((path) => [path, this.text(path)]),
		);
	}
	blobs(): Record<string, string> {
		this.#assertLive();
		const result: Record<string, string> = {};
		for (const path of this.paths()) {
			const blob = this.attrs(path).blob;
			if (blob !== null) result[path] = blob;
		}
		return result;
	}
	lineNumber(path: string, line: string): number {
		this.#assertLive();
		let index = 0;
		for (const id of this.#adapter.lineIds(this.#state, path)) {
			this.#assertLive();
			if (id === line) return index;
			index++;
		}
		this.#assertLive();
		return -1;
	}
	sameText(path: string, other: ReadView): boolean {
		this.#assertLive();
		const a = this.lines(path),
			b = other.lines(path);
		return a.length === b.length && a.every((line, index) => line.text === b[index]!.text);
	}
	visibleNeighbours(_path: string, _line: string): string[] {
		this.#assertLive();
		throw Error("unsupported projected visibleNeighbours");
	}
	weight(): number {
		this.#assertLive();
		throw Error("transaction projections cannot enter historical View cache");
	}

	attrs(path: string): FileAttrs {
		this.#assertLive();
		return this.#adapter.attrs(this.#state, path);
	}
	knownPaths(): string[] {
		this.#assertLive();
		return this.#adapter.knownPaths(this.#state);
	}
	hasMoves(): boolean {
		this.#assertLive();
		for (const id of this.graph.movers()) if (this.set.has(id)) return true;
		return false;
	}
	*visibleLines(path: string): IterableIterator<VisibleLine> {
		this.#assertLive();
		const graph = this.#adapter.graph;
		const iterator = this.#adapter.lineIds(this.#state, path);
		while (true) {
			this.#assertLive();
			const next = iterator.next();
			this.#assertLive();
			if (next.done) return;
			const id = next.value;
			const n = graph.lineN(id);
			yield { id, text: graph.textOf(n), atom: graph.idOfSeq(graph.writerSeqOf(n)) };
		}
	}
	lines(path: string): readonly VisibleLine[] {
		this.#assertLive();
		return [...this.visibleLines(path)];
	}
	sequence(path: string): readonly SeqLine[] {
		this.#assertLive();
		const adapter = this.#adapter,
			state = this.#state,
			graph = adapter.graph;
		const key = adapter.fileKey(path);
		const file = key === undefined ? undefined : adapter.markers.get(state.locator, key);
		if (!file) return [];
		const result: SeqLine[] = [];
		for (const node of adapter.sequence.range(
			state.sequence,
			adapter.sequence.rank(state.sequence, file.enter) + 1,
			adapter.sequence.rank(state.sequence, file.exit),
			false,
		)) {
			if (node.text.endsWith(":end")) continue;
			const n = graph.lineN(node.text),
				writer = graph.writerSeqOf(n);
			if (!adapter.members.get(state.membership, writer)?.present) continue;
			const deletedBy = [...graph.eachDeleterSeqOf(n)]
				.filter((seq) => adapter.members.get(state.membership, seq)?.present)
				.sort((a, b) => graph.lamportOfSeq(a) - graph.lamportOfSeq(b) || a - b)
				.map((seq) => graph.idOfSeq(seq));
			result.push({
				id: node.text,
				text: graph.textOf(n),
				atom: graph.idOfSeq(writer),
				deletedBy,
				visible: deletedBy.length === 0,
			});
		}
		return result;
	}
	sequenceIndex(path: string, line: string): number {
		this.#assertLive();
		return this.sequence(path).findIndex((item) => item.id === line);
	}
	parentOf(line: string): string {
		this.#assertLive();
		const adapter = this.#adapter,
			state = this.#state;
		const marker = adapter.markers.get(state.locator, adapter.graph.lineN(line) + 1);
		if (marker?.kind !== "line") throw Error("missing projected line");
		if (marker.parentKey > 0 && marker.parentKey < 0x80000000) return adapter.graph.lineIdOf(marker.parentKey - 1);
		const parent = adapter.markers.get(state.locator, marker.parentKey);
		if (parent?.kind !== "file") throw Error("missing projected file parent");
		const text = adapter.sequence.get(state.sequence.map, parent.enter).text;
		if (!text.startsWith("root:")) throw Error("invalid projected file parent");
		return startNode(text.slice(5));
	}
	fileOf(line: string): string {
		this.#assertLive();
		if (line.startsWith("^")) return line.slice(1);
		let current = line;
		while (!current.startsWith("^")) {
			const n = this.graph.lineN(current);
			if (n < 0) throw Error("unknown projected line");
			const marker = this.#adapter.markers.get(this.#state.locator, n + 1);
			if (marker?.kind === "line") return this.#adapter.sequence.fileAt(this.#state.sequence, marker.enter);
			// A line written outside this view has no marker. Follow canonical ancestry
			// until it reaches a line whose placement this view actually contains.
			if (marker || this.#adapter.members.get(this.#state.membership, this.graph.writerSeqOf(n))?.present)
				throw Error("missing projected line");
			const parent = this.graph.lineParent(current);
			if (parent === undefined) throw Error("missing projected line parent");
			current = parent;
		}
		return current.slice(1);
	}
	text(path: string): string {
		this.#assertLive();
		let text = "",
			part = "";
		for (const line of this.visibleLines(path)) {
			part += `${line.text}\n`;
			if (part.length >= 16384) {
				text += part;
				part = "";
			}
		}
		return text + part;
	}
	hasFile(path: string): boolean {
		this.#assertLive();
		const attrs = this.attrs(path);
		return (
			attrs.exists ||
			attrs.link !== null ||
			attrs.blob !== null ||
			!this.#adapter.lineIds(this.#state, path).next().done
		);
	}
}
