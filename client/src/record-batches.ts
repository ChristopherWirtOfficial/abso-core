import { ApiError, type RecordAnswer } from "./api.ts";
import type { Mode, Modes } from "./modes.ts";

/** One atomic path entry from the folder scan. */
export interface RecordItem {
	readonly path: string;
	readonly text?: string | null;
	readonly mode?: Modes[string];
	readonly blob?: string;
}

/** A record request; a path's text, mode, and blob reference always travel together. */
export interface RecordBatch {
	readonly files: Record<string, string | null>;
	readonly modes: Modes;
	readonly blobs: Record<string, string>;
	readonly paths: readonly string[];
}

export const RECORD_BODY_BUDGET = 8 * 1024 * 1024;

export class RecordItemTooLargeError extends Error {
	readonly path: string;
	readonly bytes: number;
	readonly budget: number;
	constructor(path: string, bytes: number, budget: number) {
		super(`Not recorded: ${path} needs a ${bytes}-byte record request by itself, over the ${budget}-byte limit.`);
		this.name = "RecordItemTooLargeError";
		this.path = path;
		this.bytes = bytes;
		this.budget = budget;
	}
}

function bodyFor(items: readonly RecordItem[]): RecordBatch {
	const files: Record<string, string | null> = {};
	const modes: Record<string, Mode> = {};
	const blobs: Record<string, string> = {};
	for (const item of items) {
		if (item.text !== undefined) files[item.path] = item.text;
		if (item.mode !== undefined) modes[item.path] = item.mode;
		if (item.blob !== undefined) blobs[item.path] = item.blob;
	}
	return { files, modes, blobs, paths: items.map((item) => item.path) };
}

/** Exact serialized UTF-8 size of the API record body. */
export function serializedRecordBytes(batch: RecordBatch): number {
	return Buffer.byteLength(
		JSON.stringify({
			files: batch.files,
			...(Object.keys(batch.modes).length ? { modes: batch.modes } : {}),
			...(Object.keys(batch.blobs).length ? { blobs: batch.blobs } : {}),
		}),
		"utf8",
	);
}

/** Deterministically split sorted atomic path entries under the serialized body budget. */
export function batchRecordItems(items: readonly RecordItem[], budget = RECORD_BODY_BUDGET): RecordBatch[] {
	if (!Number.isSafeInteger(budget) || budget <= 0)
		throw new RangeError("record body budget must be a positive safe integer");
	const sorted = [...items].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const batches: RecordBatch[] = [];
	let current: RecordItem[] = [];
	for (const item of sorted) {
		const candidate = bodyFor([...current, item]);
		if (serializedRecordBytes(candidate) <= budget) {
			current.push(item);
			continue;
		}
		if (current.length === 0) throw new RecordItemTooLargeError(item.path, serializedRecordBytes(candidate), budget);
		batches.push(bodyFor(current));
		current = [item];
		const single = bodyFor(current);
		const bytes = serializedRecordBytes(single);
		if (bytes > budget) throw new RecordItemTooLargeError(item.path, bytes, budget);
	}
	if (current.length > 0) batches.push(bodyFor(current));
	return batches;
}

export interface RecordApi {
	record(
		files: Record<string, string | null>,
		extra?: { session?: string; subagent?: string },
		modes?: Modes,
		blobs?: Readonly<Record<string, string>>,
	): Promise<RecordAnswer>;
}

/** Retry only an outcome that may have been accepted; an identical record is a no-op once its state landed. */
export async function sendRecordBatch(api: RecordApi, batch: RecordBatch): Promise<RecordAnswer> {
	const blobMap = batch.blobs;
	try {
		return await api.record(batch.files, {}, batch.modes, blobMap);
	} catch (error) {
		if (
			!(error instanceof ApiError) ||
			error.notSent ||
			(error.status !== undefined && (error.status < 200 || (error.status >= 300 && error.status < 500)))
		)
			throw error;
		// The server diffs whole-file state against the agent's current view. Replaying these exact maps is idempotent.
		return api.record(batch.files, {}, batch.modes, blobMap);
	}
}

/** Run batches in order and expose only confirmed batches to local bookkeeping. */
export async function sendRecordBatches(
	api: RecordApi,
	batches: readonly RecordBatch[],
	beforeSend: (batch: RecordBatch) => Promise<void>,
	onConfirmed: (batch: RecordBatch, answer: RecordAnswer) => Promise<void>,
): Promise<RecordAnswer[]> {
	const answers: RecordAnswer[] = [];
	for (const batch of batches) {
		await beforeSend(batch);
		const answer = await sendRecordBatch(api, batch);
		if (!answer.ok) throw new Error(`the server refused the record: ${answer.reason ?? "no reason given"}`);
		await onConfirmed(batch, answer);
		answers.push(answer);
	}
	return answers;
}
