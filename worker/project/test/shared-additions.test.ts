import assert from "node:assert/strict";
import { test } from "node:test";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { addVersion, Membership, SharedAdditions } from "../spaces.ts";

test("shared additions preserve drop/re-add semantics and retained snapshot identity", (t) => {
	const storage = new SqlState();
	try {
		const membership = new Membership(storage),
			space = membership.shared;
		const add = (atoms: string[], dropped: string[] = []) =>
			addVersion(space, { version: space.versions.length, agent: "test", message: "version", time: 0, atoms, dropped });
		add(["a"]);
		add(["b"]);
		add([], ["b"]);
		add(["b", "c"]);
		add(["c"]);
		const base = membership.at(space, 0),
			current = membership.at(space, 4);
		const additions = new SharedAdditions(space, 0, base, current);
		assert.deepEqual([...additions], ["b", "c"]);
		add([], ["b"]);
		add(["d"]);
		add(["b"]);
		assert.deepEqual([...additions], ["b", "c"]);
		assert.equal(additions.has("d"), false);
		assert.deepEqual([...new SharedAdditions(space, 4, current, membership.at(space, 7))], ["d"]);
		const read = storage.read.bind(storage);
		t.mock.method(storage, "read", (collection: string, key: string) => {
			if (collection === 'membership:"":events') throw Error("full event enumeration forbidden");
			return read(collection, key);
		});
		assert.equal(additions.size, 2);
		assert.deepEqual([...additions], ["b", "c"]);
	} finally {
		storage.db.close();
	}
});
