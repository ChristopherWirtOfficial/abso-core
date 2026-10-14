import type { ReadView, VisibleLine } from "../../src/engine/index.ts";
import { StoredText } from "../../src/engine/stored-text.ts";
import { eachCodeLine } from "./names.ts";

/** Parsed code is temporary derived data, discarded with the scratch transaction. */
export function withDefinitionCode<T>(
	view: ReadView,
	visible: readonly VisibleLine[],
	operation: (code: readonly string[]) => T,
): T {
	function* source() {
		for (const line of visible) yield line.text;
	}
	if (!view.graph.hasOrderedChildren) return operation([...eachCodeLine(source())]);
	const iterator = eachCodeLine(source());
	let prefix: string[] = [];
	let size = 0;
	let pending = iterator.next();
	while (!pending.done && size + pending.value.length + 1 <= 65536) {
		prefix.push(pending.value);
		size += pending.value.length + 1;
		pending = iterator.next();
	}
	if (pending.done) return operation(prefix);
	return view.graph.withProjectionScratch((storage) => {
		const text = new StoredText(storage, "definition-code");
		let count = 0;
		for (const line of prefix) text.write(String(count++), line);
		prefix = [];
		text.write(String(count++), pending.value!);
		for (const line of iterator) text.write(String(count++), line);
		const cache = new Map<number, string>();
		let characters = 0;
		const read = (index: number) => {
			if (index < 0 || index >= count) return undefined;
			const cached = cache.get(index);
			if (cached !== undefined) return cached;
			const value = text.read(String(index));
			if (value.length <= 65536) {
				while (cache.size >= 64 || characters + value.length > 65536) {
					const first = cache.keys().next().value!;
					characters -= cache.get(first)!.length;
					cache.delete(first);
				}
				cache.set(index, value);
				characters += value.length;
			}
			return value;
		};
		let active = true;
		const code = new Proxy([] as string[], {
			has(target, key) {
				if (!active) throw Error("definition code scope has ended");
				if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) return Number(key) < count;
				return Reflect.has(target, key);
			},
			get(target, key, receiver) {
				if (!active) throw Error("definition code scope has ended");
				if (key === "length") return count;
				if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) return read(Number(key));
				return Reflect.get(target, key, receiver);
			},
		});
		try {
			return operation(code);
		} finally {
			active = false;
		}
	});
}
