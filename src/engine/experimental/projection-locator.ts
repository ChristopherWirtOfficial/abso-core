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
