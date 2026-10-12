import type { GraphStateStorage } from "./state-source.ts";

const WIDTH = 57;
type Leaf = { prefix: string; value: number };
type Branch = { prefix: string; children: (number | null)[] };
type Node = Leaf | Branch;
const safe = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Exact existing layout priority, encoded for ascending lexical traversal. */
export function orderedChildKey(child: {
	replaces: number;
	lamport: number;
	seq: number;
	k: number;
	n: number;
}): string {
	if (![child.lamport, child.seq, child.k, child.n].every(safe) || ![0, 1].includes(child.replaces))
		throw new Error("invalid ordered child priority");
	const hex = (n: number) => n.toString(16).padStart(14, "0");
	return `${1 - child.replaces}${hex(Number.MAX_SAFE_INTEGER - child.lamport)}${hex(Number.MAX_SAFE_INTEGER - child.seq)}${hex(child.k)}${hex(child.n)}`;
}

/** Compressed radix tree with at most 16 references per node and 57 levels.
 * No collection scan or history-sized sibling array is needed. Values are
 * immutable numeric identities; the caller owns namespace isolation. */
export class OrderedIndex {
	readonly #storage: GraphStateStorage;
	readonly #collection: string;
	readonly #group: string;
	constructor(storage: GraphStateStorage, collection: string, group: string) {
		this.#storage = storage;
		this.#collection = collection;
		this.#group = group;
	}
	#key(id: number | "meta"): string {
		return JSON.stringify([this.#group, id]);
	}
	#next(): number | undefined {
		const meta = this.#storage.read(this.#collection, this.#key("meta")) as
			| { format?: unknown; next?: unknown; count?: unknown }
			| undefined;
		if (meta === undefined) {
			if (this.#storage.read(this.#collection, this.#key(0)) !== undefined)
				throw new Error("missing ordered index metadata");
			return undefined;
		}
		if (
			meta?.format !== 1 ||
			!safe(meta.next) ||
			meta.next < 1 ||
			!safe(meta.count) ||
			meta.count < 1 ||
			meta.count > meta.next
		)
			throw new Error("invalid ordered index metadata");
		return meta.next;
	}
	get size(): number {
		if (this.#next() === undefined) return 0;
		return (this.#storage.read(this.#collection, this.#key("meta")) as { count: number }).count;
	}
	#write(id: number, node: Node): void {
		this.#storage.write(this.#collection, this.#key(id), node);
	}
	#read(id: number, expected: string): Node {
		const node = this.#storage.read(this.#collection, this.#key(id)) as Node | undefined;
		if (
			!node ||
			typeof node.prefix !== "string" ||
			!/^[0-9a-f]*$/.test(node.prefix) ||
			node.prefix.length > WIDTH ||
			!node.prefix.startsWith(expected)
		)
			throw new Error("invalid ordered index node");
		if ("value" in node) {
			if (node.prefix.length !== WIDTH || !safe(node.value) || "children" in node)
				throw new Error("invalid ordered index leaf");
		} else if (
			node.prefix.length >= WIDTH ||
			!Array.isArray(node.children) ||
			node.children.length !== 16 ||
			!node.children.every((id) => id === null || safe(id)) ||
			node.children.filter((id) => id !== null).length < 2
		) {
			throw new Error("invalid ordered index branch");
		}
		return node;
	}
	/** Nested host transactions must roll back all allocation, split and link writes. */
	insert(key: string, value: number): void {
		if (key.length !== WIDTH || !/^[0-9a-f]+$/.test(key) || !safe(value))
			throw new Error("invalid ordered index entry");
		this.#storage.transaction(() => {
			let next = this.#next();
			let count = this.size;
			if (next === undefined) {
				this.#write(0, { prefix: key, value });
				this.#storage.write(this.#collection, this.#key("meta"), { format: 1, next: 1, count: 1 });
				return;
			}
			const allocate = (node: Node): number => {
				if (next! >= Number.MAX_SAFE_INTEGER) throw new Error("ordered index identity exhausted");
				const id = next!++;
				this.#write(id, node);
				return id;
			};
			const add = (id: number, expected: string): void => {
				const node = this.#read(id, expected);
				let common = 0;
				while (common < node.prefix.length && node.prefix[common] === key[common]) common++;
				if (common < node.prefix.length) {
					count++;
					const children: (number | null)[] = Array(16).fill(null);
					children[parseInt(node.prefix[common]!, 16)] = allocate(node);
					children[parseInt(key[common]!, 16)] = allocate({ prefix: key, value });
					this.#write(id, { prefix: key.slice(0, common), children });
				} else if ("value" in node) {
					if (node.value !== value) throw new Error("ordered index key reused");
				} else {
					const digit = parseInt(key[common]!, 16);
					const child = node.children[digit]!;
					if (child === null) {
						count++;
						node.children[digit] = allocate({ prefix: key, value });
						this.#write(id, node);
					} else add(child, node.prefix + key[common]);
				}
			};
			add(0, "");
			this.#storage.write(this.#collection, this.#key("meta"), { format: 1, next, count });
		});
	}
	*values(after?: string): IterableIterator<number> {
		if (after !== undefined && (after.length !== WIDTH || !/^[0-9a-f]+$/.test(after)))
			throw new Error("invalid ordered index cursor");
		if (this.#next() === undefined) return;
		const walk = function* (this: OrderedIndex, id: number, expected: string): IterableIterator<number> {
			if (after !== undefined && expected < after.slice(0, expected.length)) return;
			const node = this.#read(id, expected);
			if (after !== undefined && node.prefix < after.slice(0, node.prefix.length)) return;
			if ("value" in node) {
				if (after === undefined || node.prefix > after) yield node.value;
				return;
			}
			for (let digit = 0; digit < 16; digit++) {
				const child = node.children[digit]!;
				if (child !== null) yield* walk.call(this, child, node.prefix + digit.toString(16));
			}
		};
		yield* walk.call(this, 0, "");
	}
}
