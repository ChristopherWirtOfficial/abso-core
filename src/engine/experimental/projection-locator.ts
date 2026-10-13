import type { GraphStateStorage } from "../state-source.ts";

type Page = number | null;
interface Leaf {
	format: 1;
	kind: "leaf";
	prefix: string;
	value: unknown;
}
interface Branch {
	format: 1;
	kind: "branch";
	prefix: string;
	children: Record<string, number>;
}
type Node = Leaf | Branch;
const safe = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
function page(id: unknown): asserts id is Page {
	if (id !== null && !safe(id)) throw Error("invalid locator page reference");
}
function keyOf(id: number): string {
	if (!safe(id) || id >= 2 ** 32) throw Error("experimental locator identity limit");
	return id.toString(16).padStart(8, "0");
}
/** Internal immutable experiment. Hosts bind roots through ProjectionIdentity. */
export class ProjectionLocator<T> {
	readonly #storage: GraphStateStorage;
	readonly #collection: string;
	readonly #decode: (value: unknown) => T;
	constructor(storage: GraphStateStorage, namespace: string, decode: (value: unknown) => T) {
		if (!namespace || namespace.length > 4096) throw Error("invalid locator namespace");
		this.#storage = storage;
		this.#collection = `experimental-locator:${JSON.stringify(namespace)}`;
		this.#decode = decode;
	}
	#read(id: number, parent?: string, digit?: string): Node {
		page(id);
		const row = this.#storage.read(this.#collection, String(id));
		if (!object(row) || row.format !== 1 || typeof row.prefix !== "string" || !/^[0-9a-f]{0,8}$/.test(row.prefix))
			throw Error("invalid locator node");
		if (parent !== undefined && (row.prefix.length <= parent.length || !row.prefix.startsWith(parent + digit)))
			throw Error("invalid locator edge");
		if (row.kind === "leaf") {
			if (row.prefix.length !== 8 || Object.keys(row).length !== 4 || !("value" in row))
				throw Error("invalid locator leaf");
			return row as unknown as Leaf;
		}
		if (row.kind !== "branch" || row.prefix.length >= 8 || Object.keys(row).length !== 4 || !object(row.children))
			throw Error("invalid locator branch");
		const children = Object.entries(row.children);
		if (children.length < 2 || children.length > 16) throw Error("invalid locator fanout");
		for (const [digit, child] of children)
			if (!/^[0-9a-f]$/.test(digit) || !safe(child) || child === id) throw Error("invalid locator child");
		return row as unknown as Branch;
	}
	#write(node: Node): number {
		const next = this.#storage.read(this.#collection, "next") ?? 0;
		if (!safe(next) || !Number.isSafeInteger(next + 1)) throw Error("invalid locator allocation");
		if (this.#storage.read(this.#collection, String(next)) !== undefined) throw Error("locator allocation collision");
		this.#storage.write(this.#collection, String(next), node);
		this.#storage.write(this.#collection, "next", next + 1);
		return next;
	}
	/** Persist only pages reachable from the final root of a bounded update batch. */
	setMany(root: Page, values: ReadonlyArray<readonly [number, T]>): Page {
		page(root);
		if (values.length > 256) throw Error("locator batch limit");
		return this.#storage.transaction(() => {
			const staged = new Map<string, unknown>();
			const storage: GraphStateStorage = {
				read: (collection, key) =>
					collection === this.#collection && staged.has(key) ? staged.get(key) : this.#storage.read(collection, key),
				write: (collection, key, value) => {
					if (collection !== this.#collection) throw Error("unexpected batch collection");
					staged.set(key, value);
				},
				remove: () => {
					throw Error("unexpected batch removal");
				},
				entries: () => {
					throw Error("unexpected batch scan");
				},
				transaction: (body) => body(),
			};
			// The namespace is encoded into the collection at construction.
			const namespace = JSON.parse(this.#collection.slice("experimental-locator:".length)) as string;
			const index = new ProjectionLocator<T>(storage, namespace, this.#decode);
			let result = root;
			for (const [id, value] of values) result = index.set(result, id, value);
			const retained = new Set<number>();
			const visit = (id: Page): void => {
				if (id === null || retained.has(id) || !staged.has(String(id))) return;
				retained.add(id);
				const node = staged.get(String(id)) as Node;
				if (node.kind === "branch") for (const child of Object.values(node.children)) visit(child);
			};
			visit(result);
			for (const id of retained) this.#storage.write(this.#collection, String(id), staged.get(String(id)));
			if (staged.has("next")) this.#storage.write(this.#collection, "next", staged.get("next"));
			return result;
		});
	}

	get(root: Page, id: number): T | undefined {
		page(root);
		const key = keyOf(id);
		let current = root,
			parent: string | undefined,
			digit: string | undefined;
		for (let depth = 0; current !== null; depth++) {
			if (depth > 8) throw Error("invalid locator depth");
			const node = this.#read(current, parent, digit);
			if (!key.startsWith(node.prefix)) return undefined;
			if (node.kind === "leaf") return this.#decode(structuredClone(node.value));
			parent = node.prefix;
			digit = key[parent.length]!;
			current = node.children[digit] ?? null;
		}
		return undefined;
	}
	/** Stream immutable leaves in numeric key order, retaining at most eight branch levels. */
	*entries(root: Page): IterableIterator<readonly [number, T]> {
		page(root);
		const index = this;
		function* visit(current: Page, parent?: string, digit?: string, depth = 0): IterableIterator<readonly [number, T]> {
			if (depth > 8) throw Error("invalid locator depth");
			if (current === null) return;
			const node = index.#read(current, parent, digit);
			if (node.kind === "leaf") {
				yield [Number.parseInt(node.prefix, 16), index.#decode(structuredClone(node.value))];
				return;
			}
			for (const digit of Object.keys(node.children).sort())
				yield* visit(node.children[digit]!, node.prefix, digit, depth + 1);
		}
		yield* visit(root);
	}

	set(root: Page, id: number, value: T): number {
		page(root);
		const key = keyOf(id),
			checked = structuredClone(this.#decode(structuredClone(value)));
		return this.#storage.transaction(() => {
			const visit = (current: Page, parent?: string, digit?: string, depth = 0): number => {
				if (depth > 8) throw Error("invalid locator depth");
				if (current === null) return this.#write({ format: 1, kind: "leaf", prefix: key, value: checked });
				const node = this.#read(current, parent, digit);
				let common = 0;
				while (common < node.prefix.length && node.prefix[common] === key[common]) common++;
				if (common < node.prefix.length) {
					const leaf = this.#write({ format: 1, kind: "leaf", prefix: key, value: checked });
					return this.#write({
						format: 1,
						kind: "branch",
						prefix: key.slice(0, common),
						children: { [node.prefix[common]!]: current, [key[common]!]: leaf },
					});
				}
				if (node.kind === "leaf") return this.#write({ format: 1, kind: "leaf", prefix: key, value: checked });
				const nextDigit = key[common]!;
				const child = visit(node.children[nextDigit] ?? null, node.prefix, nextDigit, depth + 1);
				return this.#write({ ...node, children: { ...node.children, [nextDigit]: child } });
			};
			return visit(root);
		});
	}
}
