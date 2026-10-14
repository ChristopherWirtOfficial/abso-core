import { CachedStateStorage } from "../../src/engine/state-source.ts";
import type { WriterAdoptionFrame } from "../../worker/project/project.ts";
import type { Entry } from "../../worker/project/project-types.ts";
import type { SqliteLog, SqliteStorage } from "./engine-project.ts";
import { smallFrameJson } from "./small-frame-json.ts";
import { StoredJson, storeJson } from "./stored-json.ts";
import { storedJsonView } from "./stored-json-view.ts";
import { SqliteWriterState, writerFrameChunksDigest } from "./writer-host.ts";

/** Keep decoded views alive through the complete page checkpoint, then remove their rows. */
export function withDecodedFrames<T>(
	storage: SqliteStorage,
	namespace: string,
	log: SqliteLog,
	input: { from: number; to: number; maxEntries: number; maxBytes: number; digest: string },
	consume: (frames: Iterable<WriterAdoptionFrame>) => T,
): { result: T; digest: string } {
	if (
		![input.from, input.to, input.maxEntries, input.maxBytes].every(Number.isSafeInteger) ||
		input.from < 0 ||
		input.to < input.from ||
		input.maxEntries < 1 ||
		input.maxEntries > 256 ||
		input.maxBytes < 1
	)
		throw Error("invalid decoded frame page bounds");
	return storage.transactionSync(() => {
		SqliteWriterState.initialize(storage);
		const state = new SqliteWriterState(storage, namespace);
		// Bound cached reads across all disk-backed frames in this page.
		const reads = new CachedStateStorage(state, 64 * 1024, 256);
		if (
			storage.sql.exec("SELECT 1 AS present FROM writer_state WHERE namespace = ? LIMIT 1", namespace).toArray().length
		)
			throw Error("decoded frame namespace is occupied");
		let digest = input.digest;
		let active = true;
		const frames = function* (): IterableIterator<WriterAdoptionFrame> {
			let bytes = 0;
			for (let seq = input.from; seq < input.to && seq < input.from + input.maxEntries; seq++) {
				if (!active) throw Error("decoded frame page has ended");
				const size = log.frameBytes(seq);
				if (size > input.maxBytes - bytes) {
					if (bytes) return;
					throw Error("decoded frame exceeds page byte bound");
				}
				digest = writerFrameChunksDigest(digest, seq, log.frameChunks(seq));
				bytes += size;
				if (size <= 4096) {
					yield { seq, bytes: size, entry: smallFrameJson(log.frameChunks(seq)) as Entry };
				} else {
					storeJson(state, String(seq), log.frameChunks(seq));
					yield { seq, bytes: size, entry: storedJsonView(new StoredJson(reads, String(seq))) as Entry };
				}
			}
		};
		try {
			const result = consume(frames());
			if (
				result &&
				typeof result === "object" &&
				(typeof (result as { then?: unknown }).then === "function" ||
					typeof (result as { next?: unknown }).next === "function")
			)
				throw Error("decoded frame consumption must finish synchronously");
			return { result: structuredClone(result), digest };
		} finally {
			active = false;
			reads.clear();
			storage.sql.exec("DELETE FROM writer_state WHERE namespace = ?", namespace);
		}
	});
}
