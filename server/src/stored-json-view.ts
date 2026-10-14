import type { StoredJson } from "./stored-json.ts";

/** Read-only JSON view. Containers stay on disk; a requested string is materialized explicitly. */
export function storedJsonView(node: StoredJson): unknown {
	const kind = node.kind;
	if (kind === "value") return node.scalar();
	if (kind === "string") return [...node.textChunks()].join("");
	const array = kind === "array";
	const target = array ? [] : Object.create(null);
	const index = (key: PropertyKey): number | undefined => {
		if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
		const value = Number(key);
		return Number.isSafeInteger(value) ? value : undefined;
	};
	const child = (key: PropertyKey) => {
		if (typeof key !== "string") return undefined;
		if (!array) return node.child(key);
		const position = index(key);
		return position === undefined ? undefined : node.child(position);
	};
	return new Proxy(target, {
		get(target, key, receiver) {
			if (array && key === "length") return node.length;
			const value = child(key);
			if (value) return storedJsonView(value);
			return array ? Reflect.get(target, key, receiver) : undefined;
		},
		has(target, key) {
			return !!child(key) || (array && Reflect.has(target, key));
		},
		ownKeys() {
			return array
				? [...Array.from({ length: node.length }, (_, i) => String(i)), "length"]
				: [...node.properties()].map(([key]) => key);
		},
		getOwnPropertyDescriptor(target, key) {
			if (array && key === "length") return { ...Reflect.getOwnPropertyDescriptor(target, key)!, value: node.length };
			const value = child(key);
			return value
				? { configurable: true, enumerable: true, writable: false, value: storedJsonView(value) }
				: undefined;
		},
		set() {
			throw Error("stored JSON view is read-only");
		},
		defineProperty() {
			throw Error("stored JSON view is read-only");
		},
		deleteProperty() {
			throw Error("stored JSON view is read-only");
		},
		preventExtensions() {
			throw Error("stored JSON view is read-only");
		},
	});
}
