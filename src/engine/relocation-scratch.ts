import type { Graph, RelocationInfo } from "./graph.ts";
import { isStartNode } from "./keys.ts";
import { OrderedIndex, orderedChildKey } from "./ordered-index.ts";
import type { GraphStateStorage } from "./state-source.ts";
import type { AtomId, LineId, NodeId } from "./types.ts";

/** Scope-local relocation state. The caller must consume this handle inside
 * withProjectionScratch; selected moves and cycle bookkeeping live on disk. */
export function resolveScratchMoves(
	graph: Graph,
	has: (id: AtomId) => boolean,
	scratch: GraphStateStorage,
): { selected(line: LineId): RelocationInfo | undefined; parent(line: LineId): NodeId } {
	const selected = (line: LineId) => scratch.read("selected", line) as RelocationInfo | undefined;
	const identity = (move: RelocationInfo) => JSON.stringify([move.atom, move.k]);
	const stronger = (a: RelocationInfo, b: RelocationInfo) => graph.comparePriority(a.atom, b.atom) > 0;
	const pick = (line: LineId): RelocationInfo | undefined => {
		let best: RelocationInfo | undefined;
		for (const move of graph.eachRelocationOf(line)) {
			if (has(move.atom) && !scratch.read("ignored", identity(move)) && (!best || stronger(move, best))) best = move;
		}
		return best;
	};
	let work = 0;
	for (const id of graph.movers()) {
		if (!has(id)) continue;
		for (const move of graph.atom(id).moves!) {
			if (scratch.read("seen", move.line)) continue;
			scratch.write("seen", move.line, true);
			scratch.write("work", String(work++), move.line);
			const best = pick(move.line);
			if (best) scratch.write("selected", move.line, best);
		}
	}
	const parent = (line: LineId): NodeId => {
		const node = selected(line)?.parent ?? graph.lineParent(line);
		if (node === undefined) throw new Error(`missing relocation ancestry for ${line}`);
		return node;
	};
	const terminal = (node: NodeId | null): boolean =>
		node === null || isStartNode(node) || !!scratch.read("reached", node);
	const step = (node: NodeId | null): NodeId | null => (terminal(node) ? null : parent(node!));
	for (let item = 0; item < work; item++) {
		const line = scratch.read("work", String(item)) as LineId;
		for (;;) {
			// Floyd's walk finds the exact cycle entry without a retained path.
			let slow: NodeId | null = line;
			let fast: NodeId | null = line;
			let meeting: NodeId | null = null;
			for (;;) {
				slow = step(slow);
				fast = step(step(fast));
				if (terminal(slow) || terminal(fast)) break;
				if (slow === fast) {
					meeting = slow;
					break;
				}
			}
			if (meeting === null) {
				let current: NodeId = line;
				while (!terminal(current)) {
					const next = parent(current);
					scratch.write("reached", current, true);
					current = next;
				}
				break;
			}
			let entry: NodeId | null = line;
			while (entry !== meeting) {
				entry = step(entry);
				meeting = step(meeting);
			}
			let current = entry!;
			let weakest: RelocationInfo | undefined;
			do {
				const move = selected(current);
				if (move && (!weakest || stronger(weakest, move))) weakest = move;
				current = parent(current);
			} while (current !== entry);
			if (!weakest) throw new Error("canonical ancestry unexpectedly cycles");
			scratch.write("ignored", identity(weakest), true);
			const next = pick(weakest.line);
			if (next) scratch.write("selected", weakest.line, next);
			else scratch.remove("selected", weakest.line);
		}
	}
	return { selected, parent };
}

/** Consume entirely within the projection scope. Traversal retains one line;
 * both priority ordering and parent links are held in rollback-only storage. */
export function* scratchLayoutNodes(
	graph: Graph,
	has: (id: AtomId) => boolean,
	scratch: GraphStateStorage,
	start: NodeId,
): IterableIterator<number> {
	const moves = resolveScratchMoves(graph, has, scratch);
	for (let n = 0; n < graph.lineCount; n++) {
		if (!has(graph.idOfSeq(graph.writerSeqOf(n)))) continue;
		const line = graph.nodeOf(n);
		const move = moves.selected(line);
		const seq = move ? graph.atom(move.atom).seq : graph.writerSeqOf(n);
		const key = orderedChildKey({
			n,
			replaces: move ? 0 : Number(graph.replacesN(n)),
			lamport: graph.lamportOfSeq(seq),
			seq,
			k: move ? move.k : graph.kOf(n),
		});
		const parent = moves.parent(line);
		scratch.write("layout-parent", line, { parent, key });
		new OrderedIndex(scratch, "layout-children", parent).insert(key, n);
	}
	const first = (parent: NodeId, after?: string): number | undefined => {
		for (const n of new OrderedIndex(scratch, "layout-children", parent).values(after)) return n;
		return undefined;
	};
	let n = first(start);
	while (n !== undefined) {
		yield n;
		const line = graph.nodeOf(n);
		const child = first(line);
		if (child !== undefined) {
			n = child;
			continue;
		}
		let previous = line;
		for (;;) {
			const row = scratch.read("layout-parent", previous) as { parent: NodeId; key: string } | undefined;
			if (!row) throw new Error("missing scratch layout ancestry");
			const sibling = first(row.parent, row.key);
			if (sibling !== undefined) {
				n = sibling;
				break;
			}
			if (row.parent === start) {
				n = undefined;
				break;
			}
			previous = row.parent;
		}
	}
}
