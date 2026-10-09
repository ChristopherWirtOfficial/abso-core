// Small helpers for ids and claim keys.

import { ATTR_NAMES, type AtomId, type AttrName, EngineError, type Key, type LineId, type NodeId } from "./types.ts";

/** The start node of a file: "^<path>". */
export function startNode(path: string): NodeId {
	return `^${path}`;
}

export function isStartNode(node: NodeId): boolean {
	return node.startsWith("^");
}

export function atomId(seq: number): AtomId {
	return `a${seq}`;
}

/** The seq inside an atom id, or -1 if it isn't one. */
export function seqOf(id: AtomId): number {
	// Hand-parsed: this runs on every atom lookup. Same rule as /^a(0|[1-9][0-9]*)$/.
	const n = id.length;
	if (n < 2 || n > 16 || id.charCodeAt(0) !== 97 /* a */ || (n > 2 && id.charCodeAt(1) === 48) /* leading 0 */)
		return -1;
	let seq = 0;
	for (let i = 1; i < n; i++) {
		const c = id.charCodeAt(i) - 48;
		if (c < 0 || c > 9) return -1;
		seq = seq * 10 + c;
	}
	return seq;
}

export function isAtomId(s: string): boolean {
	return seqOf(s) >= 0;
}

export function lineId(atom: AtomId, k: number): LineId {
	return `${atom}.${k}`;
}

/** The atom that wrote a line. */
export function writerOf(line: LineId): AtomId {
	const dot = line.indexOf(".");
	if (dot < 0) throw new EngineError("unknown-line", `not a line id: ${line}`);
	return line.slice(0, dot);
}

export function lineKey(line: LineId): Key {
	return `L:${line}`;
}

export function gapKey(node: NodeId): Key {
	return `G:${node}`;
}

/** The key of one attribute of a file: "A:<attr>:<path>". */
export function attrKey(file: string, name: AttrName): Key {
	return `A:${name}:${file}`;
}

/** The key of where a line sits: "P:<lineId>". A move writes it. */
export function posKey(line: LineId): Key {
	return `P:${line}`;
}

/** For a line, gap or position key, `node` is the line (or start node); for an attribute key, the file. */
export interface ParsedKey {
	readonly kind: "line" | "gap" | "attr" | "pos";
	readonly node: NodeId;
	readonly attr?: AttrName;
}

export function parseKey(key: Key): ParsedKey {
	if (key.startsWith("L:") && key.length > 2 && !isStartNode(key.slice(2))) {
		return { kind: "line", node: key.slice(2) };
	}
	if (key.startsWith("G:") && key.length > 2) return { kind: "gap", node: key.slice(2) };
	if (key.startsWith("P:") && key.length > 2 && !isStartNode(key.slice(2))) return { kind: "pos", node: key.slice(2) };
	if (key.startsWith("A:")) {
		const colon = key.indexOf(":", 2);
		const attr = key.slice(2, colon) as AttrName;
		if (colon > 2 && ATTR_NAMES.includes(attr) && key.length > colon + 1)
			return { kind: "attr", node: key.slice(colon + 1), attr };
	}
	throw new EngineError("bad-atom", `not a claim key: ${key}`);
}

/** The line a key names, if it is an L: key. */
export function lineOfKey(key: Key): LineId | undefined {
	return key.startsWith("L:") ? key.slice(2) : undefined;
}
