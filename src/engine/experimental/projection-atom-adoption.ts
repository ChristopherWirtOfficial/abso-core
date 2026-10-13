import { createHash } from "node:crypto";
import type { Atom } from "../types.ts";
import type { ExperimentalMarkerProjection, MarkerState } from "./projection-marker.ts";
import { adoptMovesStep } from "./projection-move-adoption.ts";

const phases = [
	"dependencies",
	"files",
	"lines",
	"deletes",
	"counts",
	"attributes",
	"contributions",
	"membership",
	"moves",
	"cleanup",
	"done",
] as const;
type Phase = (typeof phases)[number];
interface Cursor {
	identity: string;
	phase: Phase;
	index: number;
	run: number;
	line: number;
	k: number;
	state: MarkerState;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function shape(value: unknown, names: string): asserts value is Record<string, unknown> {
	const keys = names.split(" ");
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw Error("invalid atom adoption record");
}
function readCursor(value: unknown): Cursor | undefined {
	if (value === undefined) return undefined;
	shape(value, "format checksum cursor");
	if (value.format !== 1 || typeof value.checksum !== "string" || value.checksum !== digest(value.cursor))
		throw Error("damaged atom adoption cursor");
	shape(value.cursor, "identity phase index run line k state");
	const cursor = value.cursor;
	shape(cursor.state, "context sequence locator membership children attributeFiles");
	for (const key of ["locator", "membership", "children", "attributeFiles"])
		if (cursor.state[key] !== null && (!Number.isSafeInteger(cursor.state[key]) || Number(cursor.state[key]) < 0))
			throw Error("invalid atom adoption page reference");
	shape(cursor.state.sequence, "map root next");
	const sequence = cursor.state.sequence;
	if (
		!Number.isSafeInteger(sequence.next) ||
		Number(sequence.next) < 0 ||
		Number(sequence.next) > 2 ** 32 ||
		(sequence.map !== null && (!Number.isSafeInteger(sequence.map) || Number(sequence.map) < 0)) ||
		(sequence.root !== null &&
			(!Number.isSafeInteger(sequence.root) ||
				Number(sequence.root) < 0 ||
				Number(sequence.root) >= Number(sequence.next))) ||
		(sequence.root === null) !== (sequence.next === 0) ||
		(sequence.map === null) !== (sequence.root === null)
	)
		throw Error("invalid atom adoption sequence");
	return cursor as unknown as Cursor;
}

/** Private adoption experiment. Partial state must never be published as a read root.
 * The host must pin source identity and atomically retain this cursor with each page.
 * Move reconciliation advances through private persisted pages.
 */
export class ProjectionAtomAdoption {
	readonly adapter: ExperimentalMarkerProjection;
	readonly task: string;
	constructor(adapter: ExperimentalMarkerProjection, task: string) {
		if (!task || task.length > 128) throw Error("invalid atom adoption task");
		this.adapter = adapter;
		this.task = task;
	}
	page(input: {
		previous: MarkerState;
		atom: Atom;
		remove: boolean;
		source: string;
		maxSteps: number;
		validateSource(): void;
	}): {
		done: boolean;
		state: MarkerState;
		steps: number;
		atomicMoveWork: boolean;
	} {
		const { adapter: p } = this;
		if (
			!/^[a-f0-9]{64}$/.test(input.source) ||
			!Number.isSafeInteger(input.maxSteps) ||
			input.maxSteps < 1 ||
			input.maxSteps > 256
		)
			throw Error("invalid atom adoption page bounds");
		const atom = input.atom;
		const identity = digest([input.source, input.previous, atom, input.remove]);
		if (digest(p.graph.atom(atom.id)) !== digest(atom)) throw Error("canonical adoption atom mismatch");
		const collection = `atom-adoption:${this.task}`;
		const validate = () => {
			const result: unknown = input.validateSource();
			if (result && typeof result === "object" && "then" in result)
				throw Error("atom adoption source validation must be synchronous");
		};
		return p.storage.transaction(() => {
			validate();
			let cursor = readCursor(p.storage.read(collection, "cursor"));
			if (cursor !== undefined) {
				if (
					!cursor ||
					cursor.identity !== identity ||
					!phases.includes(cursor.phase) ||
					![cursor.index, cursor.run, cursor.line, cursor.k].every((n) => Number.isSafeInteger(n) && n >= 0)
				)
					throw Error("invalid or changed atom adoption cursor");
				p.assertContext(cursor.state);
				if (cursor.run > atom.inserts.length || cursor.line > (atom.inserts[cursor.run]?.lines.length ?? 0))
					throw Error("invalid atom adoption line position");
				const limits: Record<Phase, number> = {
					dependencies: atom.deps.length,
					files: atom.inserts.length + 1,
					lines: 0,
					deletes: atom.deletes.length,
					counts: atom.deps.length,
					attributes: atom.attrs?.length ?? 0,
					contributions: p.graph.filesOf(atom.id).length,
					membership: 0,
					moves: 0,
					cleanup: atom.attrs?.length ?? 0,
					done: 0,
				};
				if (cursor.index > limits[cursor.phase]) throw Error("invalid atom adoption phase position");
			} else {
				p.assertContext(input.previous);
				const member = p.members.get(input.previous.membership, atom.seq);
				if (input.remove && member?.dependents) throw Error("included dependent prevents removal");
				cursor = {
					identity,
					phase: (member?.present ?? false) === !input.remove ? "done" : "dependencies",
					index: 0,
					run: 0,
					line: 0,
					k: 0,
					state: structuredClone(input.previous),
				};
			}
			let steps = 0;
			const atomicMoveWork = false;
			const next = () => {
				cursor!.phase = phases[phases.indexOf(cursor!.phase) + 1]!;
				cursor!.index = 0;
			};
			const state = cursor.state;
			const contributionFiles = p.graph.filesOf(atom.id);
			while (cursor.phase !== "done" && steps < input.maxSteps) {
				steps++;
				switch (cursor.phase) {
					case "dependencies": {
						if (input.remove || cursor.index === atom.deps.length) {
							next();
							break;
						}
						const id = atom.deps[cursor.index++]!;
						if (!p.members.get(state.membership, p.graph.atom(id).seq)?.present) throw Error("missing dependency");
						break;
					}
					case "files": {
						if (input.remove || cursor.index > atom.inserts.length) {
							next();
							break;
						}
						p.ensureFile(state, cursor.index === 0 ? p.path : atom.inserts[cursor.index - 1]!.file);
						cursor.index++;
						break;
					}
					case "lines": {
						if (cursor.run === atom.inserts.length) {
							next();
							break;
						}
						const run = atom.inserts[cursor.run]!;
						if (cursor.line === run.lines.length) {
							cursor.run++;
							cursor.line = 0;
							break;
						}
						const line = `${atom.id}.${cursor.k++}`;
						cursor.line++;
						if (!input.remove) p.insertLine(state, line);
						else {
							const marker = p.markers.get(state.locator, p.graph.lineN(line) + 1);
							if (!marker) throw Error("missing inserted marker");
							state.sequence = p.sequence.update(state.sequence, { kind: "visibility", id: marker.enter, delta: 1 });
						}
						break;
					}
					case "deletes": {
						if (cursor.index === atom.deletes.length) {
							next();
							break;
						}
						const marker = p.markers.get(state.locator, p.graph.lineN(atom.deletes[cursor.index++]!) + 1);
						if (!marker) throw Error("missing deleted marker");
						state.sequence = p.sequence.update(state.sequence, {
							kind: "visibility",
							id: marker.enter,
							delta: input.remove ? -1 : 1,
						});
						break;
					}
					case "counts": {
						if (cursor.index === atom.deps.length) {
							next();
							break;
						}
						const seq = p.graph.atom(atom.deps[cursor.index++]!).seq;
						const member = p.members.get(state.membership, seq);
						if (!member?.present || (input.remove && member.dependents < 1)) throw Error("invalid dependency count");
						state.membership = p.members.set(state.membership, seq, {
							...member,
							dependents: member.dependents + (input.remove ? -1 : 1),
						});
						break;
					}
					case "attributes": {
						const attrs = atom.attrs ?? [];
						if (cursor.index === attrs.length) {
							next();
							break;
						}
						const attr = attrs[cursor.index++]!;
						const key = JSON.stringify([attr.file, attr.name]);
						if (!p.storage.read(`${collection}:attributes`, key)) {
							p.updateAttributes(state, { ...atom, attrs: [attr] }, !input.remove);
							p.storage.write(`${collection}:attributes`, key, true);
						}
						break;
					}
					case "contributions": {
						if (cursor.index === contributionFiles.length) {
							next();
							break;
						}
						const path = contributionFiles[cursor.index++]!;
						p.ensureFile(state, path);
						const key = p.fileKey(path)!;
						const marker = p.markers.get(state.locator, key);
						const delta = input.remove ? -1 : 1;
						if (marker?.kind !== "file" || marker.contributions + delta < 0)
							throw Error("invalid file contribution count");
						state.locator = p.markers.set(state.locator, key, {
							...marker,
							contributions: marker.contributions + delta,
						});
						break;
					}
					case "membership":
						state.membership = p.members.set(state.membership, atom.seq, { present: !input.remove, dependents: 0 });
						next();
						break;
					case "moves":
						if (atom.moves?.length) {
							const result = adoptMovesStep(p, state, this.task, identity);
							Object.assign(state, result.state);
							if (!result.done) break;
						}
						next();
						break;
					case "cleanup": {
						const attrs = atom.attrs ?? [];
						if (cursor.index === attrs.length) {
							next();
							break;
						}
						const attr = attrs[cursor.index++]!;
						p.storage.remove(`${collection}:attributes`, JSON.stringify([attr.file, attr.name]));
						break;
					}
				}
			}
			validate();
			p.storage.write(collection, "cursor", { format: 1, checksum: digest(cursor), cursor });
			return { done: cursor.phase === "done", state: structuredClone(state), steps, atomicMoveWork };
		});
	}
}
