/** JSON.stringify-compatible chunks for canonical data, without a whole-value string.
 * Individual input strings and object key lists still belong to the caller.
 */
export function* jsonValueChunks(input: unknown): IterableIterator<string> {
	const active = new Set<object>();
	function* string(value: string): IterableIterator<string> {
		yield '"';
		for (let from = 0; from < value.length; ) {
			let end = Math.min(from + 16384, value.length);
			const last = value.charCodeAt(end - 1),
				next = value.charCodeAt(end);
			if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
			yield JSON.stringify(value.slice(from, end)).slice(1, -1);
			from = end;
		}
		yield '"';
	}
	const normalize = (value: unknown, key: string): unknown => {
		if (value !== null && typeof value === "object") {
			const toJSON = (value as { toJSON?: unknown }).toJSON;
			if (typeof toJSON === "function") return toJSON.call(value, key);
		}
		return value;
	};
	const omitted = (value: unknown) => value === undefined || typeof value === "function" || typeof value === "symbol";
	function* encode(value: unknown): IterableIterator<string> {
		if (typeof value === "string") yield* string(value);
		else if (value === null || typeof value === "boolean" || typeof value === "number") yield JSON.stringify(value);
		else if (typeof value !== "object" || value === null) throw Error("unsupported canonical JSON value");
		else {
			if (active.has(value)) throw Error("cyclic canonical JSON value");
			if (active.size >= 128) throw Error("canonical JSON depth exceeds bound");
			active.add(value);
			try {
				if (Array.isArray(value)) {
					yield "[";
					const length = value.length;
					for (let i = 0; i < length; i++) {
						if (i) yield ",";
						const child = normalize(value[i], String(i));
						yield* encode(omitted(child) ? null : child);
					}
					yield "]";
				} else {
					yield "{";
					let first = true;
					for (const key of Object.keys(value)) {
						const child = normalize((value as Record<string, unknown>)[key], key);
						if (omitted(child)) continue;
						if (!first) yield ",";
						first = false;
						yield* string(key);
						yield ":";
						yield* encode(child);
					}
					yield "}";
				}
			} finally {
				active.delete(value);
			}
		}
	}
	yield* encode(normalize(input, ""));
}

/** Exact serialized-content equality, retaining only the current pair of chunks. */
export function equalJsonValues(left: unknown, right: unknown): boolean {
	const a = jsonValueChunks(left),
		b = jsonValueChunks(right);
	let x = a.next(),
		y = b.next(),
		i = 0,
		j = 0;
	try {
		for (;;) {
			while (!x.done && i === x.value.length) {
				x = a.next();
				i = 0;
			}
			while (!y.done && j === y.value.length) {
				y = b.next();
				j = 0;
			}
			if (x.done || y.done) return x.done === y.done;
			const length = Math.min(x.value.length - i, y.value.length - j);
			if (x.value.slice(i, i + length) !== y.value.slice(j, j + length)) return false;
			i += length;
			j += length;
		}
	} finally {
		a.return?.();
		b.return?.();
	}
}
