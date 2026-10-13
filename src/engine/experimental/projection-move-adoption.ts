import { createHash } from "node:crypto";
import type { RelocationInfo } from "../graph.ts";
import { orderedChildKey } from "../ordered-index.ts";
import type { GraphStateStorage } from "../state-source.ts";
import type { ExperimentalMarkerProjection, MarkerState } from "./projection-marker.ts";
import { resolveMovesPage } from "./projection-move-resolution.ts";

type Phase = "files" | "resolve" | "plans" | "park" | "place" | "cleanup" | "done";
interface Cursor {
	identity: string;
	phase: Phase;
	mover: number;
	move: number;
	count: number;
	item: number;
	collection: number;
}
interface Plan {
	n: number;
	parentKey: number;
	key: string;
}
const collections = ["selected", "seen", "work", "ignored", "reached", "progress", "planned", "plans"];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function shape(value: unknown, fields: string): asserts value is Record<string, unknown> {
	const keys = fields.split(" ");
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw Error("invalid move adoption record");
}

/** The caller must persist the returned private root in the same transaction. */
export function adoptMovesStep(
	p: ExperimentalMarkerProjection,
	previous: MarkerState,
	task: string,
	identity: string,
): { done: boolean; state: MarkerState } {
	p.assertContext(previous);
	if (!task || task.length > 128 || !/^[a-f0-9]{64}$/.test(identity)) throw Error("invalid move adoption identity");
	const name = `move-adoption:${task}`;
	const scratch: GraphStateStorage = {
		read: (c, k) => p.storage.read(`${name}:${c}`, k),
		write: (c, k, v) => p.storage.write(`${name}:${c}`, k, v),
		remove: (c, k) => p.storage.remove(`${name}:${c}`, k),
		entries: (c) => p.storage.entries(`${name}:${c}`),
		transaction: (body) => p.storage.transaction(body),
	};
	return p.storage.transaction(() => {
		const saved = p.storage.read(name, "cursor");
		let restored: Cursor | undefined;
		if (saved !== undefined) {
			shape(saved, "format checksum cursor");
			if (saved.format !== 1 || saved.checksum !== digest(saved.cursor)) throw Error("damaged move adoption cursor");
			shape(saved.cursor, "identity phase mover move count item collection");
			restored = saved.cursor as unknown as Cursor;
		}
		const cursor: Cursor = restored ?? {
			identity,
			phase: "files",
			mover: 0,
			move: 0,
			count: 0,
			item: 0,
			collection: 0,
		};
		if (
			cursor.identity !== identity ||
			!["files", "resolve", "plans", "park", "place", "cleanup", "done"].includes(cursor.phase) ||
			![cursor.mover, cursor.move, cursor.count, cursor.item, cursor.collection].every(
				(n) => Number.isSafeInteger(n) && n >= 0,
			) ||
			cursor.mover > p.graph.movers().length ||
			cursor.item > cursor.count ||
			cursor.count > p.graph.lineCount ||
			cursor.collection > collections.length
		)
			throw Error("invalid move adoption cursor");
		const mover = p.graph.movers()[cursor.mover];
		if (cursor.move > (mover === undefined ? 0 : (p.graph.atom(mover).moves?.length ?? 0)))
			throw Error("invalid move adoption offset");
		let state = { ...previous };
		const has = (id: string) => p.members.get(state.membership, p.graph.atom(id).seq)?.present ?? false;
		switch (cursor.phase) {
			case "files":
			case "plans": {
				if (cursor.mover === p.graph.movers().length) {
					cursor.phase = cursor.phase === "files" ? "resolve" : "park";
					cursor.mover = 0;
					cursor.move = 0;
					break;
				}
				const moves = p.graph.atom(p.graph.movers()[cursor.mover]!).moves ?? [];
				if (cursor.move > moves.length) throw Error("invalid move adoption offset");
				if (cursor.move === moves.length) {
					cursor.mover++;
					cursor.move = 0;
					break;
				}
				const move = moves[cursor.move++]!;
				if (cursor.phase === "files") {
					if (move.parent.startsWith("^")) p.ensureFile(state, move.parent.slice(1));
					break;
				}
				if (scratch.read("planned", move.line)) break;
				scratch.write("planned", move.line, true);
				const n = p.graph.lineN(move.line);
				if (!has(p.graph.idOfSeq(p.graph.writerSeqOf(n)))) break;
				const marker = p.markers.get(state.locator, n + 1);
				if (marker?.kind !== "line") throw Error("missing selected relocation marker");
				const selected = scratch.read("selected", move.line) as RelocationInfo | undefined;
				const parent = selected?.parent ?? p.graph.lineParent(move.line);
				if (parent === undefined) throw Error("missing relocation ancestry");
				const parentKey = parent.startsWith("^") ? p.fileKey(parent.slice(1)) : p.graph.lineN(parent) + 1;
				if (parentKey === undefined) throw Error("missing relocation file");
				const seq = selected ? p.graph.atom(selected.atom).seq : p.graph.writerSeqOf(n);
				const key = orderedChildKey({
					n,
					replaces: selected ? 0 : Number(p.graph.replacesN(n)),
					lamport: p.graph.lamportOfSeq(seq),
					seq,
					k: selected ? selected.k : p.graph.kOf(n),
				});
				if (parentKey !== marker.parentKey || key !== marker.key)
					scratch.write("plans", String(cursor.count++), { n, parentKey, key });
				break;
			}
			case "resolve":
				if (resolveMovesPage(p.graph, has, scratch, identity, 1).done) cursor.phase = "plans";
				break;
			case "park":
			case "place": {
				if (cursor.item === cursor.count) {
					cursor.phase = cursor.phase === "park" ? "place" : "cleanup";
					cursor.item = 0;
					break;
				}
				const plan = scratch.read("plans", String(cursor.item++)) as Plan | undefined;
				if (
					!plan ||
					!Number.isSafeInteger(plan.n) ||
					plan.n < 0 ||
					!Number.isSafeInteger(plan.parentKey) ||
					plan.parentKey < 0 ||
					!/^[0-9a-f]{57}$/.test(plan.key)
				)
					throw Error("invalid saved relocation plan");
				const marker = p.markers.get(state.locator, plan.n + 1);
				if (marker?.kind !== "line") throw Error("missing relocation marker");
				state = p.relocate(
					state,
					plan.n,
					cursor.phase === "park" ? 0 : plan.parentKey,
					cursor.phase === "park" ? marker.key : plan.key,
				);
				break;
			}
			case "cleanup": {
				if (cursor.collection === collections.length) {
					cursor.phase = "done";
					break;
				}
				const collection = collections[cursor.collection]!;
				const iterator = scratch.entries(collection)[Symbol.iterator]();
				let row: IteratorResult<readonly [string, unknown]>;
				try {
					row = iterator.next();
				} finally {
					iterator.return?.();
				}
				if (row.done) cursor.collection++;
				else scratch.remove(collection, row.value[0]);
				break;
			}
		}
		if (cursor.phase === "done") p.storage.remove(name, "cursor");
		else p.storage.write(name, "cursor", { format: 1, checksum: digest(cursor), cursor });
		return { done: cursor.phase === "done", state };
	});
}
