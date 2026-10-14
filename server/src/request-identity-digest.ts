import { createHash } from "node:crypto";
import { jsonValueChunks } from "../../src/engine/json-value-chunks.ts";

/** Preserve canonicalJson identity bytes without retaining the complete encoded request. */
export function requestIdentityDigest(value: unknown): string {
	const hash = createHash("sha256");
	const active = new Set<object>();
	function* chunks(input: unknown, absent?: string): Generator<string> {
		if (typeof input === "string") {
			yield* jsonValueChunks(input);
		} else if (input && typeof input === "object") {
			if (active.has(input)) throw new TypeError("cyclic request identity");
			active.add(input);
			try {
				if (Array.isArray(input)) {
					yield "[";
					const length = input.length;
					for (let i = 0; i < length; i++) {
						if (i) yield ",";
						if (i in input) yield* chunks(input[i], "");
					}
					yield "]";
				} else {
					yield "{";
					let first = true;
					for (const key of Object.keys(input).sort()) {
						if (!first) yield ",";
						first = false;
						yield* jsonValueChunks(key);
						yield ":";
						yield* chunks((input as Record<string, unknown>)[key], "undefined");
					}
					yield "}";
				}
			} finally {
				active.delete(input);
			}
		} else {
			const encoded = JSON.stringify(input);
			if (encoded === undefined && absent === undefined) throw new TypeError("unsupported request identity");
			yield encoded ?? absent!;
		}
	}
	for (const chunk of chunks(value)) hash.update(chunk);
	return hash.digest("hex");
}
