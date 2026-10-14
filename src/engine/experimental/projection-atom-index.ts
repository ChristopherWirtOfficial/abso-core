import { createHash } from "node:crypto";
import { jsonValueChunks } from "../json-value-chunks.ts";
import type { GraphStateStorage } from "../state-source.ts";
import type { Atom, AttrSet, Relocation } from "../types.ts";

type Field = "deps" | "inserts" | "deletes" | "attrs" | "moves" | "files";
interface Run {
	file: string;
	parent: string;
	lines: number;
}
interface Header {
	format: 1;
	id: string;
	seq: number;
	digest: string;
	counts: Record<Field, number>;
	checksum: string;
}
const fields: Field[] = ["deps", "inserts", "deletes", "attrs", "moves", "files"];

// Checksums detect record damage; authority comes from the canonical writer transaction.
const checksum = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const headerChecksum = (header: Omit<Header, "checksum">): string =>
	checksum([header.format, header.id, header.seq, header.digest, fields.map((field) => header.counts[field])]);

function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw Error("invalid projection atom record");
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const atomId = (value: unknown): value is string =>
	typeof value === "string" && /^a(0|[1-9][0-9]*)$/.test(value) && integer(Number(value.slice(1)));
const lineId = (value: unknown): value is string =>
	typeof value === "string" &&
	/^a(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value) &&
	value.split(".").every((part, i) => integer(Number(i === 0 ? part.slice(1) : part)));
const parent = (value: unknown) => typeof value === "string" && (value.startsWith("^") || lineId(value));
function itemValue(field: Field, value: unknown): unknown {
	if (field === "deps" || field === "deletes" || field === "files") {
		if (!(field === "deps" ? atomId(value) : field === "deletes" ? lineId(value) : typeof value === "string"))
			throw Error("invalid projection atom item");
	} else if (field === "inserts") {
		shape(value, ["file", "parent", "lines"]);
		if (typeof value.file !== "string" || !parent(value.parent) || !integer(value.lines))
			throw Error("invalid projection atom run");
	} else if (field === "moves") {
		shape(value, ["line", "parent"]);
		if (!lineId(value.line) || !parent(value.parent)) throw Error("invalid projection atom move");
	} else {
		shape(value, ["file", "name", "value"]);
		if (
			typeof value.file !== "string" ||
			!["exists", "exec", "link", "blob"].includes(String(value.name)) ||
			(value.value !== null && typeof value.value !== "string")
		)
			throw Error("invalid projection atom attribute");
	}
	// Every validated record field is scalar; detach proxy-backed records without cloning a container graph.
	return value && typeof value === "object" ? { ...value } : value;
}

/** Derived index only. The caller supplies an already validated canonical atom and
 * its digest inside the canonical indexing transaction. This builder does not
 * claim bounded decoding of the original atom. */
export class ProjectionAtomIndex {
	readonly storage: GraphStateStorage;
	constructor(storage: GraphStateStorage) {
		this.storage = storage;
	}
	put(atom: Atom, digest: string, files: readonly string[]): void {
		if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(atom.seq) || atom.seq < 0 || atom.id !== `a${atom.seq}`)
			throw Error("invalid projection atom identity");
		const name = `projection-atom-index:${atom.id}`;
		this.storage.transaction(() => {
			if (this.storage.read(name, "header") !== undefined) throw Error("projection atom index already exists");
			const counts = {} as Record<Field, number>;
			for (const field of fields) {
				const values = field === "files" ? files : (atom[field] ?? []);
				counts[field] = values.length;
				for (let i = 0; i < values.length; i++) {
					const value =
						field === "inserts"
							? { file: atom.inserts[i]!.file, parent: atom.inserts[i]!.parent, lines: atom.inserts[i]!.lines.length }
							: values[i];
					const item = itemValue(field, value);
					this.storage.write(name, `${field}:${i}`, {
						value: item,
						checksum: checksum([atom.id, digest, field, i, item]),
					});
				}
			}
			const header = { format: 1 as const, id: atom.id, seq: atom.seq, digest, counts };
			this.storage.write(name, "header", { ...header, checksum: headerChecksum(header) } satisfies Header);
		});
	}
	/** Read a descriptor from a source-fenced, atomically maintained writer index. */
	openAccepted(id: string): ProjectionAtomDescriptor {
		if (!atomId(id)) throw Error("invalid projection atom identity");
		const header = this.storage.read(`projection-atom-index:${id}`, "header");
		shape(header, ["format", "id", "seq", "digest", "counts", "checksum"]);
		if (typeof header.digest !== "string") throw Error("invalid projection atom digest");
		return this.open(id, header.digest);
	}

	open(id: string, digest: string): ProjectionAtomDescriptor {
		if (!/^a(0|[1-9][0-9]*)$/.test(id) || !/^[a-f0-9]{64}$/.test(digest))
			throw Error("invalid projection atom identity");
		const name = `projection-atom-index:${id}`;
		const raw = this.storage.read(name, "header");
		shape(raw, ["format", "id", "seq", "digest", "counts", "checksum"]);
		shape(raw.counts, fields);
		const header = raw as unknown as Header;
		if (
			header.checksum !== headerChecksum(header) ||
			header.format !== 1 ||
			header.id !== id ||
			header.digest !== digest ||
			!Number.isSafeInteger(header.seq) ||
			header.seq < 0 ||
			id !== `a${header.seq}` ||
			!header.counts ||
			Object.keys(header.counts).length !== fields.length ||
			fields.some((field) => !Number.isSafeInteger(header.counts[field]) || header.counts[field] < 0)
		)
			throw Error("missing or invalid projection atom index");
		return new ProjectionAtomDescriptor(this.storage, name, structuredClone(header));
	}
}
export class ProjectionAtomDescriptor {
	readonly id: string;
	readonly seq: number;
	readonly digest: string;
	readonly #storage: GraphStateStorage;
	readonly #name: string;
	readonly #counts: Record<Field, number>;
	constructor(storage: GraphStateStorage, name: string, header: Header) {
		this.#storage = storage;
		this.#name = name;
		this.id = header.id;
		this.seq = header.seq;
		this.digest = header.digest;
		this.#counts = { ...header.counts };
	}
	related(id: string): ProjectionAtomDescriptor {
		return new ProjectionAtomIndex(this.#storage).openAccepted(id);
	}

	count(field: Field): number {
		if (!fields.includes(field)) throw Error("invalid projection atom field");
		return this.#counts[field];
	}
	item(field: "inserts", index: number): Run;
	item(field: "attrs", index: number): AttrSet;
	item(field: "moves", index: number): Relocation;
	item(field: "deps" | "deletes" | "files", index: number): string;
	item(field: Field, index: number): unknown {
		if (!Number.isSafeInteger(index) || index < 0 || index >= this.count(field))
			throw Error("projection atom item out of range");
		const value = this.#storage.read(this.#name, `${field}:${index}`);
		if (value === undefined) throw Error("missing projection atom item");
		shape(value, ["value", "checksum"]);
		if (value.checksum !== checksum([this.id, this.digest, field, index, value.value]))
			throw Error("invalid projection atom item checksum");
		return itemValue(field, value.value);
	}
}

/** Opt-in persistent Graph callback: indexes the just-accepted canonical atom. */
export function indexAcceptedProjectionAtom(atom: Atom, files: readonly string[], storage: GraphStateStorage): void {
	const hash = createHash("sha256");
	for (const chunk of jsonValueChunks(atom)) hash.update(chunk);
	const digest = hash.digest("hex");
	new ProjectionAtomIndex(storage).put(atom, digest, files);
}
