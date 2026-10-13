import { createHash } from "node:crypto";
import type { Graph, RelocationInfo } from "../graph.ts";
import { isStartNode } from "../keys.ts";
import type { GraphStateStorage } from "../state-source.ts";
import type { NodeId, Relocation } from "../types.ts";

export interface ProjectionMoveSource {
	count(id: string): number;
	at(id: string, k: number): Relocation | undefined;
}
export function graphMoveSource(graph: Graph): ProjectionMoveSource {
	return { count: (id) => graph.atom(id).moves?.length ?? 0, at: (id, k) => graph.atom(id).moves?.[k] };
}

interface Progress {
	identity: string;
	phase: "scan" | "walk" | "entry" | "weakest" | "repick" | "mark" | "done";
	mover: number;
	move: number;
	work: number;
	item: number;
	line: NodeId | null;
	slow: NodeId | null;
	fast: NodeId | null;
	meeting: NodeId | null;
	entry: NodeId | null;
	current: NodeId | null;
	weakest: RelocationInfo | null;
	best: RelocationInfo | null;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function shape(value: unknown, fields: string): asserts value is Record<string, unknown> {
	const keys = fields.split(" ");
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw Error("invalid move resolution record");
}
function readProgress(value: unknown, graph: Graph, source: ProjectionMoveSource): Progress | undefined {
	if (value === undefined) return undefined;
	shape(value, "format checksum state");
	if (value.format !== 1 || value.checksum !== digest(value.state)) throw Error("damaged move resolution cursor");
	shape(value.state, "identity phase mover move work item line slow fast meeting entry current weakest best");
	const state = value.state;
	if (
		typeof state.identity !== "string" ||
		!state.identity ||
		state.identity.length > 4096 ||
		!["scan", "walk", "entry", "weakest", "repick", "mark", "done"].includes(String(state.phase)) ||
		![state.mover, state.move, state.work, state.item].every(integer) ||
		Number(state.mover) > graph.movers().length ||
		Number(state.item) > Number(state.work) ||
		Number(state.work) > graph.lineCount
	)
		throw Error("invalid move resolution position");
	const mover = graph.movers()[Number(state.mover)];
	if (Number(state.move) > (mover === undefined ? 0 : source.count(mover))) throw Error("invalid move offset");
	for (const key of ["line", "slow", "fast", "meeting", "entry", "current"])
		if (state[key] !== null && (typeof state[key] !== "string" || !state[key] || String(state[key]).length > 4096))
			throw Error("invalid move ancestry cursor");
	for (const key of ["weakest", "best"]) {
		const move = state[key];
		if (move === null) continue;
		shape(move, "atom line parent k");
		if (typeof move.atom !== "string" || !integer(move.k)) throw Error("invalid saved move");
		const canonical = source.at(move.atom, move.k);
		if (!canonical || canonical.line !== move.line || canonical.parent !== move.parent)
			throw Error("saved move identity mismatch");
	}
	if (
		(state.phase === "repick" && state.weakest === null) ||
		(["entry", "weakest", "repick", "mark"].includes(String(state.phase)) && state.line === null) ||
		(state.phase === "entry" && (state.entry === null || state.meeting === null)) ||
		(state.phase === "weakest" && (state.entry === null || state.current === null))
	)
		throw Error("incomplete move resolution cursor");
	return state as unknown as Progress;
}

/** Private paged equivalent of resolveScratchMoves. Caller isolates storage and
 * binds identity to immutable graph, membership and source before every page. */
export function resolveMovesPage(
	graph: Graph,
	has: (id: string) => boolean,
	storage: GraphStateStorage,
	identity: string,
	maxSteps: number,
	source: ProjectionMoveSource = graphMoveSource(graph),
): { done: boolean; steps: number } {
	if (!identity || identity.length > 4096 || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 256)
		throw Error("invalid move resolution page");
	return storage.transaction(() => {
		let state = readProgress(storage.read("progress", "cursor"), graph, source);
		if (state && state.identity !== identity) throw Error("move resolution identity changed");
		state ??= {
			identity,
			phase: "scan",
			mover: 0,
			move: 0,
			work: 0,
			item: 0,
			line: null,
			slow: null,
			fast: null,
			meeting: null,
			entry: null,
			current: null,
			weakest: null,
			best: null,
		};
		const selected = (line: string) => storage.read("selected", line) as RelocationInfo | undefined;
		const parent = (line: string): NodeId => {
			const value = selected(line)?.parent ?? graph.lineParent(line);
			if (value === undefined) throw Error("missing relocation ancestry");
			return value;
		};
		const terminal = (node: NodeId | null) => node === null || isStartNode(node) || !!storage.read("reached", node);
		const step = (node: NodeId | null): NodeId | null => (terminal(node) ? null : parent(node!));
		const stronger = (a: RelocationInfo, b: RelocationInfo) => graph.comparePriority(a.atom, b.atom) > 0;
		const moveKey = (move: RelocationInfo) => JSON.stringify([move.atom, move.k]);
		const restartWalk = () => {
			state!.phase = "walk";
			state!.slow = state!.line;
			state!.fast = state!.line;
		};
		let steps = 0;
		while (state.phase !== "done" && steps < maxSteps) {
			steps++;
			switch (state.phase) {
				case "scan":
				case "repick": {
					if (state.mover === graph.movers().length) {
						if (state.phase === "scan") {
							state.phase = "walk";
							state.line = null;
						} else {
							const line = state.weakest!.line;
							if (state.best) storage.write("selected", line, state.best);
							else storage.remove("selected", line);
							restartWalk();
						}
						break;
					}
					const id = graph.movers()[state.mover]!;
					if (!has(id)) {
						state.mover++;
						state.move = 0;
						break;
					}
					const count = source.count(id);
					if (state.move === count) {
						state.mover++;
						state.move = 0;
						break;
					}
					const k = state.move++;
					const move = source.at(id, k);
					if (!move) throw Error("missing indexed move");
					const candidate: RelocationInfo = { atom: id, ...move, k };
					if (state.phase === "scan") {
						if (!storage.read("seen", candidate.line)) {
							storage.write("seen", candidate.line, true);
							storage.write("work", String(state.work++), candidate.line);
						}
						const best = selected(candidate.line);
						if (!best || stronger(candidate, best)) storage.write("selected", candidate.line, candidate);
					} else if (
						candidate.line === state.weakest!.line &&
						!storage.read("ignored", moveKey(candidate)) &&
						(!state.best || stronger(candidate, state.best))
					)
						state.best = candidate;
					break;
				}
				case "walk": {
					if (state.line === null) {
						if (state.item === state.work) {
							state.phase = "done";
							break;
						}
						state.line = storage.read("work", String(state.item)) as string;
						restartWalk();
						break;
					}
					state.slow = step(state.slow);
					state.fast = step(step(state.fast));
					if (terminal(state.slow) || terminal(state.fast)) {
						state.phase = "mark";
						state.current = state.line;
					} else if (state.slow === state.fast) {
						state.phase = "entry";
						state.meeting = state.slow;
						state.entry = state.line;
					}
					break;
				}
				case "entry": {
					if (state.entry === state.meeting) {
						state.phase = "weakest";
						state.current = state.entry;
						state.weakest = null;
						break;
					}
					state.entry = step(state.entry);
					state.meeting = step(state.meeting);
					break;
				}
				case "weakest": {
					const move = selected(state.current!);
					if (move && (!state.weakest || stronger(state.weakest, move))) state.weakest = move;
					state.current = parent(state.current!);
					if (state.current === state.entry) {
						if (!state.weakest) throw Error("canonical ancestry unexpectedly cycles");
						storage.write("ignored", moveKey(state.weakest), true);
						state.phase = "repick";
						state.mover = 0;
						state.move = 0;
						state.best = null;
					}
					break;
				}
				case "mark": {
					if (terminal(state.current)) {
						state.item++;
						state.line = null;
						state.phase = "walk";
						break;
					}
					const next = parent(state.current!);
					storage.write("reached", state.current!, true);
					state.current = next;
					break;
				}
			}
		}
		storage.write("progress", "cursor", { format: 1, checksum: digest(state), state });
		return { done: state.phase === "done", steps };
	});
}
