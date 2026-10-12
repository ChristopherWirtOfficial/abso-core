import type { Entry } from "./project-types.ts";

export const OPERATION_CHUNK_BYTES = 64 * 1024;
export const OPERATION_CHUNK_ENTRIES = 32;
export const OPERATION_MAX_BYTES = 4 * 1024 * 1024;
export const OPERATION_MAX_CHUNKS = 64;

export interface OperationHeads {
	readonly log: number;
	readonly shared: number;
	readonly actorMine: number;
	readonly actorBase: number;
	readonly queueRevision: number;
}

export interface OperationQueueEffect {
	readonly kind: "enqueue";
	readonly queueId: number;
	readonly actor: string;
	readonly entryIndex: number;
	readonly position: number;
}

export interface OperationLogSummary {
	readonly lines: number;
	readonly keys: number;
	readonly chars: number;
	readonly sharedVersion?: number;
	readonly lastPublish?: { readonly agent: string; readonly time: number };
}

export interface ProjectOperation {
	readonly id: string;
	readonly tenant: string;
	readonly project: string;
	readonly incarnation: string;
	readonly actor: string;
	readonly build: string;
	readonly executorIdentity: string;
	readonly rootDigest: string;
	readonly authorizationRevision: string;
	readonly policyRevision: string;
	readonly operationTime: number;
	readonly queuePolicy: { readonly policyRevision: string; readonly checkerReady: boolean };
	readonly generation: number;
	readonly heads: OperationHeads;
	readonly message: string;
	readonly files: Readonly<Record<string, string | null>>;
}

export interface OperationFence {
	readonly tenant: string;
	readonly project: string;
	readonly incarnation: string;
	readonly actor: string;
	readonly build: string;
	readonly executorIdentity: string;
	readonly rootDigest: string;
	readonly authorizationRevision: string;
	readonly policyRevision: string;
	readonly generation: number;
	readonly heads: OperationHeads;
}

export interface OperationProjection {
	readonly sharedHead: number;
	readonly actorMineHead: number;
	readonly actorBaseHead: number;
	readonly queueRevision: number;
	readonly queueEffects: readonly OperationQueueEffect[];
	readonly logSummary: OperationLogSummary;
}

export interface OperationReceipt {
	readonly id: string;
	readonly tenant: string;
	readonly project: string;
	readonly incarnation: string;
	readonly actor: string;
	readonly build: string;
	readonly executorIdentity: string;
	readonly authorizationRevision: string;
	readonly policyRevision: string;
	readonly generation: number;
	readonly previousRootDigest: string;
	readonly nextRootDigest: string;
	readonly previousHeads: OperationHeads;
	readonly nextHeads: OperationHeads;
	readonly requestDigest: string;
	readonly outputDigest: string;
	readonly entryCount: number;
	readonly queueRevision: number;
	readonly queueEffects: readonly OperationQueueEffect[];
	readonly status: "committed";
}

export interface OperationChunk {
	readonly index: number;
	readonly firstEntry: number;
	readonly count: number;
	readonly bytes: number;
	readonly entries: readonly Entry[];
	readonly text: string;
	readonly digest: string;
	readonly chain: string;
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function encodeEntries(entries: readonly Entry[]): string {
	return canonicalJson(entries);
}

export async function digestText(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function chainDigest(
	previous: string,
	index: number,
	count: number,
	bytes: number,
	digest: string,
): Promise<string> {
	return digestText(canonicalJson({ previous, index, count, bytes, digest }));
}

export async function digestOperation(operation: ProjectOperation): Promise<string> {
	return digestText(canonicalJson(operation));
}

function* jsonTokens(value: unknown, ancestors = new Set<object>()): Generator<string> {
	if (value === null || typeof value === "boolean") {
		yield String(value);
		return;
	}
	if (typeof value === "number") {
		yield Number.isFinite(value) ? JSON.stringify(value) : "null";
		return;
	}
	if (typeof value === "string") {
		yield '"';
		for (const point of value) {
			const code = point.charCodeAt(0);
			if (point === '"') yield '\\"';
			else if (point === "\\") yield "\\\\";
			else if (point === "\b") yield "\\b";
			else if (point === "\f") yield "\\f";
			else if (point === "\n") yield "\\n";
			else if (point === "\r") yield "\\r";
			else if (point === "\t") yield "\\t";
			else if (code < 0x20 || (point.length === 1 && code >= 0xd800 && code <= 0xdfff))
				yield `\\u${code.toString(16).padStart(4, "0")}`;
			else yield point;
		}
		yield '"';
		return;
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new TypeError("cannot serialize a cyclic entry");
		ancestors.add(value);
		yield "[";
		for (let index = 0; index < value.length; index++) {
			if (index) yield ",";
			yield* jsonTokens(value[index] ?? null, ancestors);
		}
		yield "]";
		ancestors.delete(value);
		return;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (ancestors.has(record)) throw new TypeError("cannot serialize a cyclic entry");
		ancestors.add(record);
		yield "{";
		let first = true;
		for (const key in record) {
			if (!Object.hasOwn(record, key)) continue;
			const child = record[key];
			if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
			if (!first) yield ",";
			first = false;
			yield* jsonTokens(key, ancestors);
			yield ":";
			yield* jsonTokens(child, ancestors);
		}
		yield "}";
		ancestors.delete(record);
		return;
	}
	if (value === undefined || typeof value === "function" || typeof value === "symbol") {
		yield "null";
		return;
	}
	throw new TypeError("entry contains an unsupported JSON value");
}

export interface Utf8Frame {
	readonly text: string;
	readonly bytes: number;
}

export function* utf8JsonFrames(value: unknown): Generator<Utf8Frame> {
	let frame = "";
	let bytes = 0;
	for (const token of jsonTokens(value)) {
		for (const point of token) {
			const size = new TextEncoder().encode(point).byteLength;
			if (bytes + size > OPERATION_CHUNK_BYTES) {
				yield { text: frame, bytes };
				frame = "";
				bytes = 0;
			}
			frame += point;
			bytes += size;
		}
	}
	if (frame || bytes === 0) yield { text: frame, bytes };
}

export function measureUtf8Json(value: unknown): { bytes: number; frames: number } {
	let bytes = 0;
	let frames = 0;
	for (const frame of utf8JsonFrames(value)) {
		bytes += frame.bytes;
		frames++;
	}
	return { bytes, frames };
}

/**
 * Emits bounded JSON chunks for small entries. The store separately frames a
 * single large entry; this helper intentionally keeps its array contract.
 */
export async function* chunkEntries(entries: Iterable<Entry>): AsyncGenerator<OperationChunk> {
	let index = 0;
	let firstEntry = 0;
	let previous = "";
	let batch: Entry[] = [];
	let batchBytes = 2;
	for (const entry of entries) {
		const text = canonicalJson(entry);
		const size = new TextEncoder().encode(text).byteLength;
		if (size + 2 > OPERATION_CHUNK_BYTES) throw new RangeError("one operation entry requires split UTF-8 framing");
		const withComma = size + (batch.length ? 1 : 0);
		if (batch.length && (batch.length >= OPERATION_CHUNK_ENTRIES || batchBytes + withComma > OPERATION_CHUNK_BYTES)) {
			const chunkText = encodeEntries(batch);
			const bytes = new TextEncoder().encode(chunkText).byteLength;
			const digest = await digestText(chunkText);
			const chain = await chainDigest(previous, index, batch.length, bytes, digest);
			yield { index, firstEntry, count: batch.length, bytes, entries: batch, text: chunkText, digest, chain };
			previous = chain;
			firstEntry += batch.length;
			index++;
			batch = [];
			batchBytes = 2;
		}
		batch.push(entry);
		batchBytes += size + (batch.length > 1 ? 1 : 0);
	}
	if (batch.length) {
		const text = encodeEntries(batch);
		const bytes = new TextEncoder().encode(text).byteLength;
		const digest = await digestText(text);
		const chain = await chainDigest(previous, index, batch.length, bytes, digest);
		yield { index, firstEntry, count: batch.length, bytes, entries: batch, text, digest, chain };
	}
}
