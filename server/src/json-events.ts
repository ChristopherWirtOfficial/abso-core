import { JsonChunkCursor } from "./json-chunk-cursor.ts";

export type JsonEvent =
	| { kind: "object" | "array" | "end" | "string" | "string-end" }
	| { kind: "key" | "text"; value: string }
	| { kind: "value"; value: number | boolean | null };

/** Structural JSON decoding. Retains nesting and one bounded string fragment, not a decoded tree. */
export function* jsonEvents(
	chunks: Iterable<string>,
	options: { finiteNumbers?: boolean } = {},
): IterableIterator<JsonEvent> {
	const cursor = new JsonChunkCursor(chunks);
	const whitespace = () => {
		while (cursor.peek() !== undefined && /[ \t\n\r]/.test(cursor.peek()!)) cursor.take();
	};
	function* value(depth: number): IterableIterator<JsonEvent> {
		if (depth > 128) throw Error("JSON nesting exceeds bound");
		whitespace();
		const first = cursor.peek();
		if (first === '"') {
			yield { kind: "string" };
			for (const text of cursor.stringChunks()) yield { kind: "text", value: text };
			yield { kind: "string-end" };
			return;
		}
		if (first === "{" || first === "[") {
			const object = cursor.take() === "{";
			const close = object ? "}" : "]";
			yield { kind: object ? "object" : "array" };
			whitespace();
			if (cursor.peek() === close) {
				cursor.take();
				yield { kind: "end" };
				return;
			}
			for (;;) {
				if (object) {
					whitespace();
					let key = "";
					for (const text of cursor.stringChunks()) {
						key += text;
						if (key.length > 4096) throw Error("JSON key exceeds bound");
					}
					yield { kind: "key", value: key };
					whitespace();
					if (cursor.take() !== ":") throw Error("expected JSON colon");
				}
				yield* value(depth + 1);
				whitespace();
				const separator = cursor.take();
				if (separator === close) break;
				if (separator !== ",") throw Error("expected JSON separator");
			}
			yield { kind: "end" };
			return;
		}
		let token = "";
		while (cursor.peek() !== undefined && !/[ \t\n\r,\]}]/.test(cursor.peek()!)) {
			token += cursor.take();
			if (token.length > 256) throw Error("JSON scalar exceeds bound");
		}
		if (token === "true" || token === "false" || token === "null") {
			yield { kind: "value", value: token === "null" ? null : token === "true" };
		} else {
			if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token)) throw Error("invalid JSON scalar");
			const number = Number(token);
			if (options.finiteNumbers && !Number.isFinite(number)) throw Error("non-finite JSON number");
			yield { kind: "value", value: number };
		}
	}
	try {
		yield* value(0);
		whitespace();
		if (cursor.peek() !== undefined) throw Error("trailing JSON input");
	} finally {
		cursor.close();
	}
}
