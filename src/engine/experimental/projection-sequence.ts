import type { GraphStateStorage } from "../state-source.ts";
import { ProjectionLocator } from "./projection-locator.ts";

type Page = number | null;
interface SequenceNode {
	id: number;
	parent: Page;
	left: Page;
	right: Page;
	text: string;
	deletions: number;
	height: number;
	count: number;
	visible: number;
	fileStarts: number;
}
export interface SequenceState {
	readonly map: Page;
	readonly root: Page;
	readonly next: number;
}
export type SequenceOperation =
	| { kind: "insert"; rank: number; text: string }
	| { kind: "visibility"; id: number; delta: number }
	| { kind: "move"; from: number; length: number; to: number };
const safe = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function decode(value: unknown): SequenceNode {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid sequence node");
	const row = value as Record<string, unknown>;
	if (Object.keys(row).length !== 10 || !safe(row.id) || row.id >= 2 ** 32 || typeof row.text !== "string")
		throw Error("invalid sequence node fields");
	for (const name of ["parent", "left", "right"])
		if (row[name] !== null && (!safe(row[name]) || Number(row[name]) >= 2 ** 32 || row[name] === row.id))
			throw Error("invalid sequence edge");
	for (const name of ["deletions", "height", "count", "visible", "fileStarts"])
		if (!safe(row[name])) throw Error("invalid sequence aggregate");
	if (
		Number(row.height) < 1 ||
		Number(row.height) > 64 ||
		Number(row.count) < 1 ||
		Number(row.visible) > Number(row.count) ||
		Number(row.fileStarts) > Number(row.count)
	)
		throw Error("invalid sequence aggregate bounds");
	return row as unknown as SequenceNode;
}
export class ProjectionSequence {
	readonly storage: GraphStateStorage;
	readonly #locator: ProjectionLocator<SequenceNode>;
	constructor(storage: GraphStateStorage, namespace: string) {
		this.storage = storage;
		this.#locator = new ProjectionLocator(storage, namespace, decode);
	}
	empty(): SequenceState {
		return { map: null, root: null, next: 0 };
	}
	get(map: Page, id: number): SequenceNode {
		const node = this.#locator.get(map, id);
		if (!node || node.id !== id) throw Error("missing sequence node");
		const child = (key: Page): SequenceNode | undefined => {
			if (key === null) return undefined;
			const value = this.#locator.get(map, key);
			if (!value || value.id !== key || value.parent !== id) throw Error("invalid sequence child identity");
			return value;
		};
		const left = child(node.left),
			right = child(node.right);
		if (
			node.height !== 1 + Math.max(left?.height ?? 0, right?.height ?? 0) ||
			Math.abs((left?.height ?? 0) - (right?.height ?? 0)) > 1 ||
			node.count !== 1 + (left?.count ?? 0) + (right?.count ?? 0) ||
			node.visible !== (node.deletions === 0 ? 1 : 0) + (left?.visible ?? 0) + (right?.visible ?? 0) ||
			node.fileStarts !== (node.text.startsWith("root:") ? 1 : 0) + (left?.fileStarts ?? 0) + (right?.fileStarts ?? 0)
		)
			throw Error("inconsistent sequence aggregate");
		return node;
	}
	#state(state: SequenceState): void {
		if (
			!state ||
			!safe(state.next) ||
			state.next > 2 ** 32 ||
			(state.map !== null && !safe(state.map)) ||
			(state.root !== null && (!safe(state.root) || state.root >= state.next)) ||
			(state.root === null) !== (state.next === 0) ||
			(state.map === null) !== (state.root === null)
		)
			throw Error("invalid sequence state");
		if (state.root !== null && this.get(state.map, state.root).parent !== null)
			throw Error("invalid sequence root parent");
	}
	set(map: Page, id: number, node: SequenceNode): number {
		if (node.id !== id) throw Error("sequence node identity mismatch");
		return this.#locator.set(map, id, node);
	}
	rank(state: SequenceState, id: number): number {
		this.#state(state);
		let node = this.get(state.map, id);
		if (!node) throw Error("unknown marker");
		const count = (id: Page): number => (id === null ? 0 : this.get(state.map, id).count);
		let rank = count(node.left),
			steps = 0;
		while (node.parent !== null) {
			if (++steps > 64) throw Error("invalid parent chain");
			const parent = this.get(state.map, node.parent);
			if (parent.right === node.id) rank += count(parent.left) + 1;
			else if (parent.left !== node.id) throw Error("broken parent edge");
			node = parent;
		}
		if (node.id !== state.root) throw Error("wrong root");
		return rank;
	}
	/** Nearest file start before a marker, using subtree counts instead of line ancestry. */
	fileAt(state: SequenceState, id: number): string {
		const target = this.rank(state, id);
		const seek = (id: Page, offset: number, depth: number): string | undefined => {
			if (id === null || offset > target) return undefined;
			if (depth > 64) throw Error("invalid file lookup depth");
			const node = this.get(state.map, id);
			if (!node.fileStarts) return undefined;
			const leftCount = node.left === null ? 0 : this.get(state.map, node.left).count;
			const at = offset + leftCount;
			if (at <= target) {
				const right = seek(node.right, at + 1, depth + 1);
				if (right !== undefined) return right;
				if (node.text.startsWith("root:")) return node.text.slice(5);
			}
			return seek(node.left, offset, depth + 1);
		};
		const file = seek(state.root, 0, 0);
		if (file === undefined) throw Error("missing projected file start");
		return file;
	}
	update(state: SequenceState, operation: SequenceOperation): SequenceState {
		this.#state(state);
		return this.storage.transaction(() => {
			let map = state.map;
			// One operation changes an AVL path plus rotation neighbors, not history.
			// Keep only those decoded records and persist each final record once.
			const changed = new Map<number, SequenceNode>();
			const get = (id: number): SequenceNode => changed.get(id) ?? this.get(map, id);
			const put = (node: SequenceNode): number => {
				changed.set(node.id, node);
				return node.id;
			};
			const height = (id: Page): number => (id === null ? 0 : get(id).height);
			const count = (id: Page): number => (id === null ? 0 : get(id).count);
			const visible = (id: Page): number => (id === null ? 0 : get(id).visible);
			const fileStarts = (id: Page): number => (id === null ? 0 : get(id).fileStarts);
			const parent = (id: Page, p: Page): void => {
				if (id !== null) {
					const node = get(id);
					if (node.parent !== p) put({ ...node, parent: p });
				}
			};
			const save = (node: SequenceNode): number => {
				parent(node.left, node.id);
				parent(node.right, node.id);
				return put({
					...node,
					height: 1 + Math.max(height(node.left), height(node.right)),
					count: 1 + count(node.left) + count(node.right),
					visible: (node.deletions === 0 ? 1 : 0) + visible(node.left) + visible(node.right),
					fileStarts: (node.text.startsWith("root:") ? 1 : 0) + fileStarts(node.left) + fileStarts(node.right),
				});
			};
			const rotateLeft = (id: number): number => {
				const a = get(id),
					b = get(a.right!);
				save({ ...a, right: b.left, parent: b.id });
				return save({ ...b, left: a.id, parent: a.parent });
			};
			const rotateRight = (id: number): number => {
				const a = get(id),
					b = get(a.left!);
				save({ ...a, left: b.right, parent: b.id });
				return save({ ...b, right: a.id, parent: a.parent });
			};
			const balance = (id: number): number => {
				const node = get(id);
				if (height(node.left) - height(node.right) > 1) {
					const left = get(node.left!);
					if (height(left.left) < height(left.right)) save({ ...node, left: rotateLeft(left.id) });
					return rotateRight(id);
				}
				if (height(node.right) - height(node.left) > 1) {
					const right = get(node.right!);
					if (height(right.right) < height(right.left)) save({ ...node, right: rotateRight(right.id) });
					return rotateLeft(id);
				}
				return id;
			};
			let root = state.root,
				next = state.next;
			if (operation.kind === "insert") {
				const { rank, text } = operation;
				if (!Number.isInteger(rank) || rank < 0 || rank > count(root) || next >= 2 ** 32) throw Error("invalid insert");
				const added = next++;
				const insert = (id: Page, at: number, p: Page): number => {
					if (id === null)
						return put({
							id: added,
							parent: p,
							left: null,
							right: null,
							text,
							deletions: 0,
							height: 1,
							count: 1,
							visible: 1,
							fileStarts: text.startsWith("root:") ? 1 : 0,
						});
					const node = get(id),
						leftCount = count(node.left);
					if (at <= leftCount) save({ ...node, left: insert(node.left, at, id) });
					else save({ ...node, right: insert(node.right, at - leftCount - 1, id) });
					return balance(id);
				};
				root = insert(root, rank, null);
				parent(root, null);
			} else if (operation.kind === "move") {
				const { from, length, to } = operation;
				const total = count(root);
				if (
					![from, length, to].every(Number.isSafeInteger) ||
					from < 0 ||
					length < 0 ||
					from + length > total ||
					to < 0 ||
					to > total - length
				)
					throw Error("invalid move range");
				// Join two AVL trees around one existing stable marker.
				const join = (left: Page, pivot: number, right: Page): number => {
					if (height(left) > height(right) + 1) {
						const node = get(left!);
						save({ ...node, right: join(node.right, pivot, right) });
						const result = balance(left!);
						parent(result, null);
						return result;
					}
					if (height(right) > height(left) + 1) {
						const node = get(right!);
						save({ ...node, left: join(left, pivot, node.left) });
						const result = balance(right!);
						parent(result, null);
						return result;
					}
					return save({ ...get(pivot), left, right, parent: null });
				};
				const split = (id: Page, at: number): [Page, Page] => {
					if (id === null) return [null, null];
					const node = get(id),
						size = count(node.left);
					if (at <= size) {
						const [left, middle] = split(node.left, at);
						const right = join(middle, id, node.right);
						parent(left, null);
						parent(right, null);
						return [left, right];
					}
					const [middle, right] = split(node.right, at - size - 1);
					const left = join(node.left, id, middle);
					parent(left, null);
					parent(right, null);
					return [left, right];
				};
				const merge = (left: Page, right: Page): Page => {
					if (left === null) {
						parent(right, null);
						return right;
					}
					if (right === null) {
						parent(left, null);
						return left;
					}
					const [pivot, rest] = split(right, 1);
					return join(left, pivot!, rest);
				};
				if (length && from !== to) {
					const [left, tail] = split(root, from);
					const [moved, right] = split(tail, length);
					const remaining = merge(left, right);
					const [before, after] = split(remaining, to);
					root = merge(merge(before, moved), after);
					parent(root, null);
				}
			} else if (operation.kind === "visibility") {
				let node = get(operation.id);
				if (
					!node ||
					!Number.isInteger(operation.delta) ||
					Math.abs(operation.delta) !== 1 ||
					node.deletions + operation.delta < 0
				)
					throw Error("invalid visibility");
				save({ ...node, deletions: node.deletions + operation.delta });
				while (node.parent !== null) {
					node = get(node.parent);
					save(node);
				}
			} else throw Error("unknown operation");
			// Keep locator staging bounded even if a valid split/merge changes more
			// than one batch. The enclosing transaction commits all batches together.
			let batch: Array<readonly [number, SequenceNode]> = [];
			for (const entry of changed) {
				batch.push(entry);
				if (batch.length === 256) {
					map = this.#locator.setMany(map, batch);
					batch = [];
				}
			}
			map = this.#locator.setMany(map, batch);
			return { map, root, next };
		});
	}
	*range(
		state: SequenceState,
		from: number,
		to: number,
		visibleOnly = true,
	): IterableIterator<{ id: number; text: string }> {
		this.#state(state);
		if (!safe(from) || !safe(to) || from > to) throw Error("invalid sequence range");
		const visit = function* (
			seq: ProjectionSequence,
			id: Page,
			offset: number,
		): IterableIterator<{ id: number; text: string }> {
			if (id === null) return;
			const node = seq.get(state.map, id);
			if ((visibleOnly && !node.visible) || offset >= to || offset + node.count <= from) return;
			const leftCount = node.left === null ? 0 : seq.get(state.map, node.left).count;
			yield* visit(seq, node.left, offset);
			const at = offset + leftCount;
			if (at >= from && at < to && (!visibleOnly || node.deletions === 0)) yield { id: node.id, text: node.text };
			yield* visit(seq, node.right, at + 1);
		};
		yield* visit(this, state.root, 0);
	}
	*values(state: SequenceState, visibleOnly = true): IterableIterator<{ id: number; text: string }> {
		this.#state(state);
		const visit = function* (seq: ProjectionSequence, id: Page): IterableIterator<{ id: number; text: string }> {
			if (id === null) return;
			const node = seq.get(state.map, id);
			if (visibleOnly && node.visible === 0) return;
			yield* visit(seq, node.left);
			if (!visibleOnly || node.deletions === 0) yield { id: node.id, text: node.text };
			yield* visit(seq, node.right);
		};
		yield* visit(this, state.root);
	}
}
