import type { GraphStateStorage } from "../state-source.ts";

type Page = number | null;
type Node =
	| { format: 2; kind: "leaf"; prefix: string; value: unknown }
	| { format: 2; kind: "branch"; prefix: string; children: Record<string, number> };
const safe = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function check(root: Page, key: string): void {
	if ((root !== null && !safe(root)) || !/^[0-9a-f]{57}$/.test(key)) throw Error("invalid priority lookup");
}
/** Immutable compressed priority paths. Reads legacy depth pages; writes format 2. */
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
	#read(id: number, expected: string): Node {
		if (!safe(id) || expected.length > 57) throw Error("invalid priority reference");
		const row = this.#storage.read(this.#collection, String(id));
		if (!object(row) || Object.keys(row).length !== 4) throw Error("invalid priority node");
		const legacy = row.format === 1;
		const prefix = legacy ? expected : row.prefix;
		if (
			(legacy ? row.depth !== expected.length : row.format !== 2) ||
			typeof prefix !== "string" ||
			!/^[0-9a-f]{0,57}$/.test(prefix) ||
			!prefix.startsWith(expected)
		)
			throw Error("invalid priority prefix");
		if (row.kind === "leaf") {
			if (prefix.length !== 57 || !("value" in row)) throw Error("invalid priority leaf");
			return { format: 2, kind: "leaf", prefix, value: row.value };
		}
		if (row.kind !== "branch" || prefix.length >= 57 || !object(row.children)) throw Error("invalid priority branch");
		const entries = Object.entries(row.children);
		if (entries.length < (legacy ? 1 : 2) || entries.length > 16) throw Error("invalid priority fanout");
		for (const [digit, child] of entries)
			if (!/^[0-9a-f]$/.test(digit) || !safe(child) || child === id) throw Error("invalid priority child");
		return { format: 2, kind: "branch", prefix, children: row.children as Record<string, number> };
	}
	#allocate<R>(body: (write: (node: Node) => number) => R): R {
		return this.#storage.transaction(() => {
			let next = this.#storage.read(this.#collection, "next") ?? 0;
			if (!safe(next)) throw Error("invalid priority allocation");
			const initial = next;
			const result = body((node) => {
				// Collapse legacy singleton paths before storing a compressed page.
				while (node.kind === "branch" && Object.keys(node.children).length === 1) {
					const [digit, child] = Object.entries(node.children)[0]!;
					node = this.#read(child, node.prefix + digit);
				}
				if (!safe(next) || !Number.isSafeInteger(next + 1)) throw Error("invalid priority allocation");
				if (this.#storage.read(this.#collection, String(next)) !== undefined)
					throw Error("priority allocation collision");
				const id = next++;
				this.#storage.write(this.#collection, String(id), node);
				return id;
			});
			if (next !== initial) this.#storage.write(this.#collection, "next", next);
			return result;
		});
	}

	insert(root: Page, key: string, value: T): number {
		check(root, key);
		const checked = structuredClone(this.#decode(structuredClone(value)));
		return this.#allocate((write) => {
			const leaf = () => write({ format: 2, kind: "leaf", prefix: key, value: checked });
			const visit = (id: Page, expected: string): number => {
				if (id === null) return leaf();
				const node = this.#read(id, expected);
				let common = 0;
				while (common < node.prefix.length && node.prefix[common] === key[common]) common++;
				if (common < node.prefix.length) {
					// Legacy pages need their inferred prefix persisted when moved below a new branch.
					const old = write(node),
						added = leaf();
					return write({
						format: 2,
						kind: "branch",
						prefix: key.slice(0, common),
						children: { [node.prefix[common]!]: old, [key[common]!]: added },
					});
				}
				if (node.kind === "leaf") return leaf();
				const digit = key[node.prefix.length]!;
				const child = visit(node.children[digit] ?? null, node.prefix + digit);
				return write({ ...node, children: { ...node.children, [digit]: child } });
			};
			return visit(root, "");
		});
	}
	remove(root: Page, key: string): Page {
		check(root, key);
		return this.#allocate((write) => {
			const visit = (id: Page, expected: string): Page => {
				if (id === null) throw Error("missing priority key");
				const node = this.#read(id, expected);
				if (!key.startsWith(node.prefix)) throw Error("missing priority key");
				if (node.kind === "leaf") return null;
				const digit = key[node.prefix.length]!,
					child = visit(node.children[digit] ?? null, node.prefix + digit),
					children = { ...node.children };
				if (child === null) delete children[digit];
				else children[digit] = child;
				const entries = Object.entries(children);
				if (!entries.length) return null;
				if (entries.length === 1) {
					const [d, c] = entries[0]!;
					return write(this.#read(c, node.prefix + d));
				}
				return write({ ...node, children });
			};
			return visit(root, "");
		});
	}
	before(root: Page, key: string): T | undefined {
		check(root, key);
		const maximum = (id: number, expected: string): T => {
			const node = this.#read(id, expected);
			if (node.kind === "leaf") return this.#decode(structuredClone(node.value));
			const digit = Object.keys(node.children).sort().at(-1)!;
			return maximum(node.children[digit]!, node.prefix + digit);
		};
		const visit = (id: Page, expected: string): T | undefined => {
			if (id === null) return undefined;
			const node = this.#read(id, expected);
			if (!key.startsWith(node.prefix)) return node.prefix < key ? maximum(id, expected) : undefined;
			if (node.kind === "leaf") return undefined;
			const digit = key[node.prefix.length]!;
			const same = node.children[digit];
			if (same !== undefined) {
				const found = visit(same, node.prefix + digit);
				if (found !== undefined) return found;
			}
			const lower = Object.keys(node.children)
				.filter((d) => d < digit)
				.sort()
				.at(-1);
			return lower === undefined ? undefined : maximum(node.children[lower]!, node.prefix + lower);
		};
		return visit(root, "");
	}
}
