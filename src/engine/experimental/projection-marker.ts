import type { Graph } from "../graph.ts";
import { orderedChildKey } from "../ordered-index.ts";
import { resolveScratchMoves } from "../relocation-scratch.ts";
import type { GraphStateStorage } from "../state-source.ts";
import type { Atom, AtomId } from "../types.ts";
import { ProjectionLocator } from "./projection-locator.ts";
import { ProjectionPriority } from "./projection-priority.ts";
import {
	type ProjectionAttributeName,
	type ProjectionAttributes,
	type ProjectionAttributeValue,
	type ProjectionChildRoot,
	type ProjectionMarker,
	type ProjectionMembership,
	projectionAttributes,
	projectionAttributeValue,
	projectionChildRoot,
	projectionMarker,
	projectionMembership,
} from "./projection-records.ts";
import { ProjectionSequence, type SequenceState } from "./projection-sequence.ts";

type Page = number | null;
export interface MarkerState {
	readonly context: string;
	sequence: SequenceState;
	locator: Page;
	membership: Page;
	children: Page;
	attributeFiles: Page;
}
interface Plan {
	n: number;
	parentKey: number;
	key: string;
}
function relocationPlan(value: unknown): Plan {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid relocation plan");
	const row = value as Record<string, unknown>;
	if (
		Object.keys(row).length !== 3 ||
		!Number.isSafeInteger(row.n) ||
		Number(row.n) < 0 ||
		Number(row.n) >= 0x7fffffff ||
		!Number.isSafeInteger(row.parentKey) ||
		Number(row.parentKey) < 0 ||
		Number(row.parentKey) >= 2 ** 32 ||
		typeof row.key !== "string" ||
		!/^[0-9a-f]{57}$/.test(row.key)
	)
		throw Error("invalid relocation plan");
	return { n: row.n as number, parentKey: row.parentKey as number, key: row.key };
}
const numeric = (value: unknown): number => {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error("invalid projection number");
	return value as number;
};
function required<T>(value: T | undefined): T {
	if (value === undefined) throw Error("missing projection record");
	return value;
}
/** Internal typed experiment; root binding wrapper is still required before integration. */
export class ExperimentalMarkerProjection {
	readonly context: string;
	readonly storage: GraphStateStorage;
	readonly graph: Graph;
	readonly path: string;
	readonly sequence: ProjectionSequence;
	readonly markers: ProjectionLocator<ProjectionMarker>;
	readonly members: ProjectionLocator<ProjectionMembership>;
	readonly childRoots: ProjectionLocator<ProjectionChildRoot>;
	readonly attributeRoots: ProjectionLocator<ProjectionAttributes>;
	readonly priorities: ProjectionPriority<number>;
	readonly attributePriorities: ProjectionPriority<ProjectionAttributeValue>;
	constructor(storage: GraphStateStorage, graph: Graph, path: string, namespace: string) {
		if (!namespace || namespace.length > 4096) throw Error("invalid projection namespace");
		this.context = JSON.stringify([namespace, path]);
		const prefix = `experimental-marker:${JSON.stringify(namespace)}:`;
		this.storage = {
			read: (collection, key) => storage.read(prefix + collection, key),
			write: (collection, key, value) => storage.write(prefix + collection, key, value),
			remove: (collection, key) => storage.remove(prefix + collection, key),
			entries: (collection) => storage.entries(prefix + collection),
			transaction: (body) => storage.transaction(body),
		};
		this.graph = graph;
		this.path = path;
		this.sequence = new ProjectionSequence(storage, namespace + ":sequence");
		this.markers = new ProjectionLocator(storage, namespace + ":markers", projectionMarker);
		this.members = new ProjectionLocator(storage, namespace + ":membership", projectionMembership);
		this.childRoots = new ProjectionLocator(storage, namespace + ":children", projectionChildRoot);
		this.attributeRoots = new ProjectionLocator(storage, namespace + ":attributes", projectionAttributes);
		this.priorities = new ProjectionPriority(storage, namespace + ":priorities", numeric);
		this.attributePriorities = new ProjectionPriority(
			storage,
			namespace + ":attribute-priorities",
			projectionAttributeValue,
		);
	}
	assertContext(state: MarkerState): void {
		if (!state || state.context !== this.context) throw Error("projection constructor context mismatch");
	}
	empty(): MarkerState {
		return {
			context: this.context,
			sequence: this.sequence.empty(),
			locator: null,
			membership: null,
			children: null,
			attributeFiles: null,
		};
	}
	apply(previous: MarkerState, atom: Atom): MarkerState {
		this.assertContext(previous);
		if (JSON.stringify(this.graph.atom(atom.id)) !== JSON.stringify(atom)) throw Error("canonical atom mismatch");
		if (this.members.get(previous.membership, atom.seq)?.present) return previous;
		for (const id of atom.deps)
			if (!this.members.get(previous.membership, this.graph.atom(id).seq)?.present) throw Error("missing dependency");
		return this.storage.transaction(() => {
			const state = { ...previous };
			const sequence = this.sequence;
			this.ensureFile(state, this.path);
			for (const run of atom.inserts) this.ensureFile(state, run.file);
			let k = 0;
			for (const run of atom.inserts) for (const _ of run.lines) this.insertLine(state, `${atom.id}.${k++}`);
			for (const line of atom.deletes) {
				const marker = this.markers.get(state.locator, this.graph.lineN(line) + 1);
				if (!marker) throw Error("missing deleted marker");
				state.sequence = sequence.update(state.sequence, { kind: "visibility", id: marker.enter, delta: 1 });
			}
			for (const id of atom.deps) {
				const seq = this.graph.atom(id).seq,
					member = required(this.members.get(state.membership, seq));
				state.membership = this.members.set(state.membership, seq, { ...member, dependents: member.dependents + 1 });
			}
			this.updateAttributes(state, atom, true);
			this.updateFiles(state, atom, 1);
			state.membership = this.members.set(state.membership, atom.seq, { present: true, dependents: 0 });
			return atom.moves?.length ? this.reconcileMoves(state) : state;
		});
	}
	/** One canonical line insertion; used by atomic apply and resumable inactive adoption. */
	insertLine(state: MarkerState, line: string): void {
		this.assertContext(state);
		const sequence = this.sequence;
		const insert = (rank: number, text: string, hidden = false): number => {
			const id = state.sequence.next;
			state.sequence = sequence.update(state.sequence, { kind: "insert", rank, text });
			if (hidden) state.sequence = sequence.update(state.sequence, { kind: "visibility", id, delta: 1 });
			return id;
		};
		const n = this.graph.lineN(line),
			parent = this.graph.parentCodeOf(n);
		if (n + 1 >= 0x80000000) throw Error("prototype line identity limit");
		const existing = this.markers.get(state.locator, n + 1);
		if (existing) {
			state.sequence = sequence.update(state.sequence, { kind: "visibility", id: existing.enter, delta: -1 });
			return;
		}
		const parentMarker = this.markers.get(state.locator, this.parentKey(parent));
		if (!parentMarker) throw Error("missing parent marker");
		const parentKey = this.parentKey(parent);
		const index = this.priorities;
		const root = this.childRoots.get(state.children, parentKey)?.root ?? null;
		const seq = this.graph.writerSeqOf(n);
		const key = orderedChildKey({
			n,
			replaces: this.graph.replacesN(n) ? 1 : 0,
			lamport: this.graph.lamportOfSeq(seq),
			seq,
			k: this.graph.kOf(n),
		});
		const preceding = index.before(root, key);
		const anchor =
			preceding === undefined ? parentMarker.enter : required(this.markers.get(state.locator, preceding + 1)).exit;
		state.children = this.childRoots.set(state.children, parentKey, { root: index.insert(root, key, n) });
		const at = sequence.rank(state.sequence, anchor) + 1;
		const enter = insert(at, line),
			exit = insert(at + 1, `${line}:end`, true);
		state.locator = this.markers.set(state.locator, n + 1, { kind: "line", enter, exit, parentKey, key });
	}
	removeDeleter(previous: MarkerState, atom: Atom): MarkerState {
		return this.removeAtom(previous, atom);
	}
	removeAtom(previous: MarkerState, atom: Atom): MarkerState {
		this.assertContext(previous);
		if (JSON.stringify(this.graph.atom(atom.id)) !== JSON.stringify(atom)) throw Error("canonical atom mismatch");
		if (!this.members.get(previous.membership, atom.seq)?.present) return previous;
		if (required(this.members.get(previous.membership, atom.seq)).dependents)
			throw Error("included dependent prevents removal");
		return this.storage.transaction(() => {
			const state = { ...previous };
			let k = 0;
			for (const run of atom.inserts)
				for (const text of run.lines) {
					const marker = this.markers.get(state.locator, this.graph.lineN(`${atom.id}.${k++}`) + 1);
					if (!marker) throw Error("missing inserted marker");
					state.sequence = this.sequence.update(state.sequence, { kind: "visibility", id: marker.enter, delta: 1 });
				}
			for (const line of atom.deletes) {
				const marker = this.markers.get(state.locator, this.graph.lineN(line) + 1);
				if (!marker) throw Error("missing deleted marker");
				state.sequence = this.sequence.update(state.sequence, { kind: "visibility", id: marker.enter, delta: -1 });
			}
			for (const id of atom.deps) {
				const seq = this.graph.atom(id).seq,
					member = required(this.members.get(state.membership, seq));
				if (!member?.present || member.dependents < 1) throw Error("invalid dependency count");
				state.membership = this.members.set(state.membership, seq, { ...member, dependents: member.dependents - 1 });
			}
			this.updateAttributes(state, atom, false);
			this.updateFiles(state, atom, -1);
			state.membership = this.members.set(state.membership, atom.seq, { present: false, dependents: 0 });
			return atom.moves?.length ? this.reconcileMoves(state) : state;
		});
	}
	reconcileMoves(previous: MarkerState): MarkerState {
		this.assertContext(previous);
		return this.storage.transaction(() => {
			const scope = numeric(this.storage.read("sequence-meta", "work-scope") ?? 0);
			this.storage.write("sequence-meta", "work-scope", scope + 1);
			const prefix = `sequence-resolver:${scope}:`,
				collections = new Set<string>();
			const scratch: GraphStateStorage = {
				read: (c, k) => this.storage.read(prefix + c, k),
				write: (c, k, v) => {
					collections.add(c);
					this.storage.write(prefix + c, k, v);
				},
				remove: (c, k) => this.storage.remove(prefix + c, k),
				entries: (c) => this.storage.entries(prefix + c),
				transaction: (body) => this.storage.transaction(body),
			};
			const has = (id: AtomId) => this.members.get(previous.membership, this.graph.atom(id).seq)?.present ?? false;
			previous = { ...previous };
			for (const id of this.graph.movers())
				for (const move of this.graph.atom(id).moves ?? [])
					if (move.parent.startsWith("^")) this.ensureFile(previous, move.parent.slice(1));
			const resolved = resolveScratchMoves(this.graph, has, scratch),
				self = this;
			function* plans(): IterableIterator<Plan> {
				for (const id of self.graph.movers())
					for (const move of self.graph.atom(id).moves ?? []) {
						if (scratch.read("planned", move.line)) continue;
						scratch.write("planned", move.line, true);
						const n = self.graph.lineN(move.line);
						if (!has(self.graph.idOfSeq(self.graph.writerSeqOf(n)))) continue;
						const marker = self.markers.get(previous.locator, n + 1);
						if (!marker || marker.kind !== "line") throw Error("missing selected relocation marker");
						const selected = resolved.selected(move.line),
							parent = resolved.parent(move.line);
						const parentKey = parent.startsWith("^")
							? required(self.fileKey(parent.slice(1)))
							: self.graph.lineN(parent) + 1;
						const seq = selected ? self.graph.atom(selected.atom).seq : self.graph.writerSeqOf(n);
						const key = orderedChildKey({
							n,
							replaces: selected ? 0 : Number(self.graph.replacesN(n)),
							lamport: self.graph.lamportOfSeq(seq),
							seq,
							k: selected ? selected.k : self.graph.kOf(n),
						});
						if (parentKey !== marker.parentKey || key !== marker.key) yield { n, parentKey, key };
					}
			}
			const state = this.relocateBatch(previous, plans());
			for (const collection of collections)
				for (const [key] of this.storage.entries(prefix + collection)) this.storage.remove(prefix + collection, key);
			return state;
		});
	}
	relocateBatch(previous: MarkerState, plans: Iterable<Plan>): MarkerState {
		this.assertContext(previous);
		return this.storage.transaction(() => {
			const scope = numeric(this.storage.read("sequence-meta", "work-scope") ?? 0);
			this.storage.write("sequence-meta", "work-scope", scope + 1);
			const name = `sequence-relocation-work:${scope}`;
			let count = 0,
				state = previous;
			for (const candidate of plans) {
				const plan = relocationPlan(candidate);
				if (this.storage.read(name, `seen:${plan.n}`)) throw Error("duplicate relocation plan");
				this.storage.write(name, `seen:${plan.n}`, true);
				this.storage.write(name, String(count++), plan);
			}
			// A file root is the temporary parking parent. All phases are invisible
			// outside this transaction; no history-sized plan array is retained.
			for (let i = 0; i < count; i++) {
				const plan = relocationPlan(this.storage.read(name, String(i)));
				const marker = this.markers.get(state.locator, plan.n + 1);
				if (!marker || marker.kind !== "line") throw Error("missing relocation marker");
				state = this.relocate(state, plan.n, 0, marker.key);
			}
			for (let i = 0; i < count; i++) {
				const plan = relocationPlan(this.storage.read(name, String(i)));
				state = this.relocate(state, plan.n, plan.parentKey, plan.key);
			}
			for (let i = 0; i < count; i++) {
				const plan = relocationPlan(this.storage.read(name, String(i)));
				this.storage.remove(name, `seen:${plan.n}`);
				this.storage.remove(name, String(i));
			}
			return state;
		});
	}
	relocate(previous: MarkerState, n: number, parentKey: number, key: string): MarkerState {
		this.assertContext(previous);
		return this.storage.transaction(() => {
			const state = { ...previous },
				seq = this.sequence,
				index = this.priorities;
			const marker = this.markers.get(state.locator, n + 1),
				target = this.markers.get(state.locator, parentKey);
			if (!marker || marker.kind !== "line" || !target) throw Error("missing relocation marker");
			const oldRoot = this.childRoots.get(state.children, marker.parentKey)?.root ?? null;
			state.children = this.childRoots.set(state.children, marker.parentKey, {
				root: index.remove(oldRoot, marker.key),
			});
			const newRoot = this.childRoots.get(state.children, parentKey)?.root ?? null;
			const sibling = index.before(newRoot, key);
			const anchor = sibling === undefined ? target.enter : required(this.markers.get(state.locator, sibling + 1)).exit;
			const from = seq.rank(state.sequence, marker.enter),
				end = seq.rank(state.sequence, marker.exit);
			const anchorRank = seq.rank(state.sequence, anchor),
				length = end - from + 1;
			if (anchorRank >= from && anchorRank <= end) throw Error("relocation would cycle");
			const to = anchorRank + 1 - (anchorRank > end ? length : 0);
			state.sequence = seq.update(state.sequence, { kind: "move", from, length, to });
			state.children = this.childRoots.set(state.children, parentKey, { root: index.insert(newRoot, key, n) });
			state.locator = this.markers.set(state.locator, n + 1, { ...marker, parentKey, key });
			return state;
		});
	}
	fileKey(path: string): number | undefined {
		if (path === this.path) return 0;
		const id = this.storage.read("sequence-file-identities", path);
		return id === undefined ? undefined : numeric(id);
	}
	parentKey(code: number): number {
		return code < 0 ? this.fileKey(this.graph.nodeOf(code).slice(1))! : code + 1;
	}
	ensureFile(state: MarkerState, path: string): void {
		this.assertContext(state);
		let key = this.fileKey(path);
		if (key === undefined) {
			key = numeric(this.storage.read("sequence-meta", "next-file") ?? 0x80000000);
			if (key >= 2 ** 32) throw Error("file identity limit");
			this.storage.write("sequence-file-identities", path, key);
			this.storage.write("sequence-meta", "next-file", key + 1);
		}
		if (this.markers.get(state.locator, key)) return;
		const seq = this.sequence;
		const insert = (text: string): number => {
			const id = state.sequence.next,
				rank = state.sequence.root === null ? 0 : seq.get(state.sequence.map, state.sequence.root).count;
			state.sequence = seq.update(state.sequence, { kind: "insert", rank, text });
			state.sequence = seq.update(state.sequence, { kind: "visibility", id, delta: 1 });
			return id;
		};
		const enter = insert(`root:${path}`),
			exit = insert(`end:${path}`);
		state.locator = this.markers.set(state.locator, key, { kind: "file", enter, exit, contributions: 0 });
	}
	updateFiles(state: MarkerState, atom: Atom, delta: 1 | -1): void {
		for (const path of this.graph.filesOf(atom.id)) {
			this.ensureFile(state, path);
			const key = required(this.fileKey(path));
			const marker = this.markers.get(state.locator, key);
			if (marker?.kind !== "file" || marker.contributions + delta < 0) throw Error("invalid file contribution count");
			state.locator = this.markers.set(state.locator, key, { ...marker, contributions: marker.contributions + delta });
		}
	}
	knownPaths(state: MarkerState): string[] {
		this.assertContext(state);
		const paths: string[] = [];
		for (const path of this.graph.knownFiles()) {
			const key = this.fileKey(path),
				marker = key === undefined ? undefined : this.markers.get(state.locator, key);
			if (marker?.kind === "file" && marker.contributions > 0) paths.push(path);
		}
		return paths.sort();
	}
	updateAttributes(state: MarkerState, atom: Atom, adding: boolean): void {
		this.assertContext(state);
		const index = this.attributePriorities,
			hex = (n: number) => n.toString(16).padStart(14, "0");
		const key = `0${hex(this.graph.lamportOfSeq(atom.seq))}${hex(atom.seq)}${hex(0)}${hex(0)}`;
		const names = new Set<string>();
		for (const attr of atom.attrs ?? []) {
			if (!["exists", "exec", "link", "blob"].includes(attr.name)) throw Error("unsupported attribute");
			const identity = JSON.stringify([attr.file, attr.name]);
			if (names.has(identity)) continue;
			names.add(identity);
			this.ensureFile(state, attr.file);
			const file = required(this.fileKey(attr.file)),
				roots = this.attributeRoots.get(state.attributeFiles, file) ?? {};
			const root = roots[attr.name] ?? null;
			state.attributeFiles = this.attributeRoots.set(state.attributeFiles, file, {
				...roots,
				[attr.name]: adding ? index.insert(root, key, { value: attr.value }) : index.remove(root, key),
			});
		}
	}
	attrs(state: MarkerState, path = this.path) {
		this.assertContext(state);
		const index = this.attributePriorities,
			file = this.fileKey(path);
		const roots = file === undefined ? {} : (this.attributeRoots.get(state.attributeFiles, file) ?? {});
		const value = (name: ProjectionAttributeName) => index.before(roots[name] ?? null, "f".repeat(57))?.value ?? null;
		return { exists: value("exists") === "1", exec: value("exec") === "1", link: value("link"), blob: value("blob") };
	}
	lines(state: MarkerState, path = this.path): string[] {
		return [...this.lineIds(state, path)];
	}
	*lineIds(state: MarkerState, path = this.path): IterableIterator<string> {
		this.assertContext(state);
		const key = this.fileKey(path);
		if (key === undefined) return;
		const marker = this.markers.get(state.locator, key);
		if (!marker) return;
		for (const line of this.sequence.range(
			state.sequence,
			this.sequence.rank(state.sequence, marker.enter) + 1,
			this.sequence.rank(state.sequence, marker.exit),
		))
			yield line.text;
	}
}
