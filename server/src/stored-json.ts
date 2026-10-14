import type { GraphStateStorage } from "../../src/engine/state-source.ts";
import { StoredText } from "../../src/engine/stored-text.ts";
import { type JsonEvent, jsonEvents } from "./json-events.ts";

/** Temporary decoded JSON on disk. A root is published only after complete parsing. */
export function storeJson(storage: GraphStateStorage, namespace: string, chunks: Iterable<string>): number {
	return storage.transaction(() => {
		if (storage.read(namespace, "root") !== undefined) throw Error("decoded JSON already exists");
		const events = jsonEvents(chunks);
		let nextId = 0;
		const take = (): JsonEvent => {
			const event = events.next();
			if (event.done) throw Error("truncated JSON events");
			return event.value;
		};
		const text = new StoredText(storage, `${namespace}:text`);
		const value = (event = take()): number => {
			const id = nextId++;
			if (!Number.isSafeInteger(nextId)) throw Error("decoded JSON identity overflow");
			if (event.kind === "value")
				storage.write(namespace, String(id), {
					kind: "value",
					value: typeof event.value === "number" ? String(event.value) : event.value,
					number: typeof event.value === "number",
					negativeZero: Object.is(event.value, -0),
				});
			else if (event.kind === "string") {
				text.writeChunks(
					String(id),
					(function* () {
						for (;;) {
							const part = take();
							if (part.kind === "string-end") return;
							if (part.kind !== "text") throw Error("invalid JSON string events");
							yield part.value;
						}
					})(),
				);
				storage.write(namespace, String(id), { kind: "string" });
			} else if (event.kind === "array" || event.kind === "object") {
				let count = 0;
				for (;;) {
					const child = take();
					if (child.kind === "end") break;
					if (event.kind === "object" && child.kind !== "key") throw Error("invalid JSON object events");
					const key = child.kind === "key" ? child.value : String(count);
					const childId = value(event.kind === "object" ? take() : child);
					const edge = JSON.stringify([id, key]);
					if (event.kind === "object" && storage.read(`${namespace}:edges`, edge) === undefined) {
						storage.write(`${namespace}:keys`, JSON.stringify([id, count]), key);
						count++;
					}
					storage.write(`${namespace}:edges`, edge, childId);
					if (event.kind === "array") count++;
				}
				storage.write(namespace, String(id), { kind: event.kind, count });
			} else throw Error("invalid JSON value event");
			return id;
		};
		try {
			const root = value();
			if (!events.next().done) throw Error("trailing JSON events");
			storage.write(namespace, "root", { format: 1, id: root, nodes: nextId });
			return root;
		} finally {
			events.return?.();
		}
	});
}

/** A disk-backed JSON node. Child lookup does not decode siblings or string payloads. */
export class StoredJson {
	readonly storage: GraphStateStorage;
	readonly namespace: string;
	readonly id: number;
	readonly nodes: number;
	constructor(storage: GraphStateStorage, namespace: string, id?: number) {
		this.storage = storage;
		this.namespace = namespace;
		const root = storage.read(namespace, "root") as { format: number; id: number; nodes: number } | undefined;
		if (root?.format !== 1 || !Number.isSafeInteger(root.nodes) || root.nodes < 1 || root.id !== 0)
			throw Error("invalid stored JSON root");
		this.nodes = root.nodes;
		this.id = id ?? root.id;
		if (!Number.isSafeInteger(this.id) || this.id < 0 || this.id >= this.nodes)
			throw Error("invalid stored JSON identity");
	}
	private node(): { kind: string; count?: number; value?: unknown; number?: boolean; negativeZero?: boolean } {
		const node = this.storage.read(this.namespace, String(this.id)) as
			| { kind: string; count?: number; value?: unknown; number?: boolean; negativeZero?: boolean }
			| undefined;
		if (!node || !["array", "object", "string", "value"].includes(node.kind)) throw Error("invalid stored JSON node");
		return node;
	}
	get kind(): string {
		return this.node().kind;
	}
	get length(): number {
		const node = this.node();
		if (node.kind !== "array" || !Number.isSafeInteger(node.count) || node.count! < 0)
			throw Error("invalid stored JSON array");
		return node.count!;
	}
	child(key: string | number): StoredJson | undefined {
		const node = this.node();
		if (node.kind !== "object" && node.kind !== "array") throw Error("stored JSON node is not a container");
		if (
			node.kind === "array" &&
			(typeof key !== "number" || !Number.isSafeInteger(key) || key < 0 || key >= this.length)
		)
			return undefined;
		const id = this.storage.read(`${this.namespace}:edges`, JSON.stringify([this.id, String(key)]));
		if (id === undefined) {
			if (node.kind === "array") throw Error("missing stored JSON array element");
			return undefined;
		}
		if (typeof id !== "number") throw Error("invalid stored JSON edge");
		return new StoredJson(this.storage, this.namespace, id);
	}
	*elements(): IterableIterator<StoredJson> {
		const length = this.length;
		for (let index = 0; index < length; index++) yield this.child(index)!;
	}
	*properties(): IterableIterator<[string, StoredJson]> {
		const node = this.node();
		if (node.kind !== "object" || !Number.isSafeInteger(node.count) || node.count! < 0)
			throw Error("invalid stored JSON object");
		for (let index = 0; index < node.count!; index++) {
			const key = this.storage.read(`${this.namespace}:keys`, JSON.stringify([this.id, index]));
			if (typeof key !== "string") throw Error("missing stored JSON object key");
			const child = this.child(key);
			if (!child) throw Error("missing stored JSON object member");
			yield [key, child];
		}
	}
	*textChunks(): IterableIterator<string> {
		if (this.kind !== "string") throw Error("stored JSON node is not text");
		yield* new StoredText(this.storage, `${this.namespace}:text`).chunks(String(this.id));
	}
	scalar(): number | boolean | null {
		const node = this.node();
		if (node.kind !== "value") throw Error("stored JSON node is not a scalar");
		if (node.number) {
			if (typeof node.value !== "string" || Number.isNaN(Number(node.value))) throw Error("invalid stored JSON number");
			return node.negativeZero ? -0 : Number(node.value);
		}
		if (node.value === null || typeof node.value === "boolean" || typeof node.value === "number") return node.value;
		throw Error("invalid stored JSON scalar");
	}
}
