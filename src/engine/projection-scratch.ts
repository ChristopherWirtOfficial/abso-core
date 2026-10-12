import type { GraphStateStorage } from "./state-source.ts";

let nextScope = 0;

/** Synchronous derived-state work only. All scratch writes roll back, even on
 * success. The outer canonical transaction is left intact. Returned values
 * must be detached data, never iterators, promises or storage handles. */
export function withProjectionScratch<T>(
	storage: GraphStateStorage,
	validateIdentity: () => void,
	operation: (scratch: GraphStateStorage) => T,
): T {
	if (nextScope >= Number.MAX_SAFE_INTEGER) throw new Error("projection scope identity exhausted");
	const prefix = `projection-scratch:${++nextScope}:`;
	const finished = {};
	let active = true;
	let result: T;
	const collection = (name: string): string => {
		if (!active) throw new Error("projection scratch scope has ended");
		return prefix + name;
	};
	const scratch: GraphStateStorage = {
		read: (name, key) => storage.read(collection(name), key),
		write: (name, key, value) => storage.write(collection(name), key, value),
		remove: (name, key) => storage.remove(collection(name), key),
		*entries(name) {
			for (const entry of storage.entries(collection(name))) {
				collection(name);
				yield entry;
			}
		},
		transaction: (body) => {
			collection("");
			return storage.transaction(body);
		},
	};
	try {
		storage.transaction(() => {
			validateIdentity();
			const value = operation(scratch);
			if (
				value &&
				(typeof (value as { then?: unknown }).then === "function" ||
					typeof (value as { next?: unknown }).next === "function")
			)
				throw new Error("projection must complete synchronously");
			// Detach successful output before rollback; rejects embedded functions,
			// storage capabilities and generators instead of leaking their scope.
			result = structuredClone(value);
			validateIdentity();
			throw finished;
		});
	} catch (error) {
		if (error !== finished) throw error;
		return result!;
	} finally {
		active = false;
	}
	throw new Error("storage did not propagate projection rollback");
}
