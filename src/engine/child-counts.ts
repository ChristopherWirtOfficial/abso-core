import type { GraphStateStorage } from "./state-source.ts";

const PAGE_SIZE = 256;
type Page = { format: 1; page: number; counts: number[]; digest: string };

/** Two independent 32-bit checksums over page identity and contents. This
 * detects inconsistent storage corruption, not an adversarial coherent rewrite. */
function digest(page: number, counts: readonly number[]): string {
	const text = JSON.stringify([1, page, counts]);
	let a = 2166136261;
	let b = 5381;
	for (let i = 0; i < text.length; i++) {
		a = Math.imul(a ^ text.charCodeAt(i), 16777619) >>> 0;
		b = (Math.imul(b, 33) ^ text.charCodeAt(i)) >>> 0;
	}
	return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Dense line-node counts. Graph append owns the enclosing transaction. */
export class ChildCounts {
	readonly #storage: GraphStateStorage;
	constructor(storage: GraphStateStorage) {
		this.#storage = storage;
	}
	#read(page: number, total: number): Page {
		const value = this.#storage.read("ordered-child-counts", String(page)) as Page | undefined;
		const expected = Math.min(PAGE_SIZE, total - page * PAGE_SIZE);
		if (
			!value ||
			value.format !== 1 ||
			value.page !== page ||
			!Array.isArray(value.counts) ||
			expected < 1 ||
			value.counts.length !== expected ||
			Object.keys(value.counts).length !== expected ||
			value.counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
			value.digest !== digest(page, value.counts)
		)
			throw new Error("invalid ordered child count page");
		return value;
	}
	#write(page: number, counts: number[]): void {
		this.#storage.write("ordered-child-counts", String(page), {
			format: 1,
			page,
			counts,
			digest: digest(page, counts),
		});
	}
	at(index: number, total: number): number {
		if (!Number.isSafeInteger(index) || index < 0 || index >= total)
			throw new Error("ordered child count out of bounds");
		return this.#read(Math.floor(index / PAGE_SIZE), total).counts[index % PAGE_SIZE]!;
	}
	append(total: number): void {
		const page = Math.floor(total / PAGE_SIZE);
		const offset = total % PAGE_SIZE;
		const counts = offset === 0 ? [] : this.#read(page, total).counts;
		if (offset === 0 && this.#storage.read("ordered-child-counts", String(page)) !== undefined)
			throw new Error("unexpected existing ordered child count page");
		counts.push(0);
		this.#write(page, counts);
	}
	increment(index: number, total: number): void {
		const count = this.at(index, total);
		if (count === Number.MAX_SAFE_INTEGER) throw new Error("ordered child count exhausted");
		const page = Math.floor(index / PAGE_SIZE);
		const counts = this.#read(page, total).counts;
		counts[index % PAGE_SIZE] = count + 1;
		this.#write(page, counts);
	}
}
