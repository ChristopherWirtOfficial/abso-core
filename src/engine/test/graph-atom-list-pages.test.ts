// An atom's long lists (abso Capacity, readonlyPagedArray): a new atom keeps them 256 values to a row (list format 2),
// and an atom stored before keeps a row per value (list format 1). Both read back whole, in order and by index.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph } from "../index.ts";
import { lineKey } from "../keys.ts";
import { storedArray } from "../state-source.ts";
import type { Atom } from "../types.ts";
import { SqlState } from "./storage-helper.ts";

function listAtom(keys: string[]): Atom {
	return {
		id: "a1",
		seq: 1,
		author: "fixture",
		message: "lists",
		time: 1,
		inserts: [],
		deletes: [],
		writes: keys,
		reads: [],
		holds: [],
		needs: [],
		resolves: [],
		reasons: [],
		deps: ["a0"],
	};
}

const keys = Array.from({ length: 600 }, () => lineKey("a0.0"));

test("a new atom's long list is kept 256 values to a row and reads back whole", () => {
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage });
		graph.add(buildBase({ "a.txt": "base" }, { author: "fixture", message: "base", time: 0 }));
		graph.add(listAtom(keys));
		assert.equal((storage.read("atoms", "1") as { listFormat?: number }).listFormat, 2);
		assert.equal((storage.read("atom-list:1:writes:pages", "2") as unknown[]).length, 600 - 512);
		assert.equal(storage.read("atom-list:1:writes", "0"), undefined, "no row per value");
		const writes = new Graph({ storage }).atom("a1").writes;
		assert.deepEqual([...writes], keys);
		assert.equal(writes.length, 600);
		assert.equal(writes[300], keys[300]);
		assert.equal(writes[600], undefined);
	} finally {
		storage.db.close();
	}
});

test("an atom stored before pages, a row per value, still reads back whole", () => {
	const storage = new SqlState();
	try {
		const graph = new Graph({ storage });
		graph.add(buildBase({ "a.txt": "base" }, { author: "fixture", message: "base", time: 0 }));
		graph.add(listAtom(keys));
		// Rewrite it as list format 1 kept it: a row per value and no pages.
		const record = storage.read("atoms", "1") as Record<string, unknown>;
		for (let page = 0; page < 3; page++) storage.remove("atom-list:1:writes:pages", String(page));
		storage.remove("atom-list:1:writes:meta", "length");
		const rows = storedArray<string>(storage, "atom-list:1:writes");
		for (const key of keys) rows.push(key);
		storage.write("atoms", "1", { ...record, listFormat: 1 });
		const writes = new Graph({ storage }).atom("a1").writes;
		assert.deepEqual([...writes], keys);
		assert.equal(writes[599], keys[599]);
	} finally {
		storage.db.close();
	}
});
