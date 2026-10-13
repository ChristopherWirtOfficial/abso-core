import type { GraphStateStorage } from "../state-source.ts";

type Page = number | null;
interface Leaf {
	format: 1;
	kind: "leaf";
	depth: 57;
	value: unknown;
}
interface Branch {
	format: 1;
	kind: "branch";
	depth: number;
	children: Record<string, number>;
}
type Node = Leaf | Branch;
const safe = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
function check(root: Page, key: string): void {
	if ((root !== null && !safe(root)) || !/^[0-9a-f]{57}$/.test(key)) throw Error("invalid priority lookup");
}
/** Internal immutable priority experiment. At most 57 levels and 16 children. */
export class ProjectionPriority<T> {
	readonly #storage: GraphStateStorage;
	readonly #collection: string;
	readonly #decode: (value: unknown) => T;
	constructor(storage: GraphStateStorage, namespace: string, decode: (value: unknown) => T) {
		if (!namespace || namespace.length > 4096) throw Error("invalid priority namespace");
		this.#storage = storage;
		this.#collection = `experimental-priority:${JSON.stringify(namespace)}`;
		this.#decode = decode;
	}
	#read(id: number, depth: number): Node {
		if (!safe(id) || !safe(depth) || depth > 57) throw Error("invalid priority reference");
		const row = this.#storage.read(this.#collection, String(id));
		if (!object(row) || row.format !== 1 || row.depth !== depth || Object.keys(row).length !== 4)
			throw Error("invalid priority node");
		if (depth === 57) {
			if (row.kind !== "leaf" || !("value" in row)) throw Error("invalid priority leaf");
			return row as unknown as Leaf;
		}
		if (row.kind !== "branch" || !object(row.children)) throw Error("invalid priority branch");
		const entries = Object.entries(row.children);
		if (!entries.length || entries.length > 16) throw Error("invalid priority fanout");
		for (const [digit, child] of entries)
			if (!/^[0-9a-f]$/.test(digit) || !safe(child) || child === id) throw Error("invalid priority child");
		return row as unknown as Branch;
	}
	#write(node: Node): number {
		const next = this.#storage.read(this.#collection, "next") ?? 0;
		if (!safe(next) || !Number.isSafeInteger(next + 1)) throw Error("invalid priority allocation");
		if (this.#storage.read(this.#collection, String(next)) !== undefined) throw Error("priority allocation collision");
		this.#storage.write(this.#collection, String(next), node);
		this.#storage.write(this.#collection, "next", next + 1);
		return next;
	}
	insert(root: Page, key: string, value: T): number {
		check(root, key);
		const checked = structuredClone(this.#decode(structuredClone(value)));
		return this.#storage.transaction(() => {
			const visit = (id: Page, depth: number): number => {
				const node = id === null ? undefined : this.#read(id, depth);
				if (depth === 57) return this.#write({ format: 1, kind: "leaf", depth: 57, value: checked });
				if (node?.kind === "leaf") throw Error("invalid priority depth");
				const children = node?.children ?? {},
					digit = key[depth]!;
				const child = visit(children[digit] ?? null, depth + 1);
				return this.#write({ format: 1, kind: "branch", depth, children: { ...children, [digit]: child } });
			};
			return visit(root, 0);
		});
	}
	remove(root: Page, key: string): Page {
		check(root, key);
		return this.#storage.transaction(() => {
			const visit = (id: Page, depth: number): Page => {
				if (id === null) throw Error("missing priority key");
				const node = this.#read(id, depth);
				if (node.kind === "leaf") return null;
				const digit = key[depth]!,
					child = visit(node.children[digit] ?? null, depth + 1),
					children = { ...node.children };
				if (child === null) delete children[digit];
				else children[digit] = child;
				return Object.keys(children).length ? this.#write({ ...node, children }) : null;
			};
			return visit(root, 0);
		});
	}
	before(root: Page, key: string): T | undefined {
		check(root, key);
		let current = root;
		let candidate: { id: number; depth: number } | undefined;
		for (let depth = 0; current !== null && depth < 57; depth++) {
			const node = this.#read(current, depth);
			if (node.kind !== "branch") throw Error("invalid priority depth");
			const digit = key[depth]!,
				lower = Object.keys(node.children)
					.filter((item) => item < digit)
					.sort()
					.at(-1);
			if (lower !== undefined) candidate = { id: node.children[lower]!, depth: depth + 1 };
			current = node.children[digit] ?? null;
		}
		if (!candidate) return undefined;
		let { id, depth } = candidate;
		for (; depth <= 57; depth++) {
			const node = this.#read(id, depth);
			if (node.kind === "leaf") return this.#decode(structuredClone(node.value));
			id = node.children[Object.keys(node.children).sort().at(-1)!]!;
		}
		throw Error("invalid priority depth");
	}
}
