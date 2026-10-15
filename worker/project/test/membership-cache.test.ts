// The in-memory membership cache is bounded across every space (abso Capacity): 106 drafts on prod project abso
// each kept whole copies of shared's set, 37 MB in all. One least-recently-used cache now holds MEMBERSHIP_SETS_KEPT.

import assert from "node:assert/strict";
import { test } from "node:test";
import { addVersion, MEMBERSHIP_SETS_KEPT, Membership, newSpace } from "../spaces.ts";

const SHARED = "";

/** Shared with `versions` versions, version v adding atom s<v>; then `drafts` drafts, each on shared's version 3. */
function membership(versions: number, drafts: number): Membership {
	const m = new Membership();
	for (let v = 0; v < versions; v++)
		addVersion(m.shared, { version: v, agent: "a", message: `v${v}`, time: 0, atoms: [`s${v}`] });
	for (let d = 0; d < drafts; d++) {
		const space = newSpace(`d${d}`);
		m.spaces.set(space.name, space);
		addVersion(space, { version: 0, agent: "a", message: "start", time: 0, atoms: [], sharedBase: 3 });
		addVersion(space, { version: 1, agent: "a", message: "work", time: 0, atoms: [`d${d}-x`], sharedBase: 3 });
	}
	return m;
}

test("the cache never holds more than MEMBERSHIP_SETS_KEPT sets, however many drafts are read", () => {
	const m = membership(10, MEMBERSHIP_SETS_KEPT * 3);
	for (let d = 0; d < MEMBERSHIP_SETS_KEPT * 3; d++) m.at(m.spaces.get(`d${d}`)!, 1);
	assert.ok(m.setsKept <= MEMBERSHIP_SETS_KEPT, `kept ${m.setsKept}`);
});

test("a set that fell out of the cache is built again the same, and a kept one is the same object", () => {
	const m = membership(10, MEMBERSHIP_SETS_KEPT * 2);
	const first = m.spaces.get("d0")!;
	const before = [...m.at(first, 1)].sort();
	assert.deepEqual(before, ["d0-x", "s0", "s1", "s2", "s3"], "shared at its base, plus its own");
	for (let d = 1; d < MEMBERSHIP_SETS_KEPT * 2; d++) m.at(m.spaces.get(`d${d}`)!, 1);
	assert.deepEqual([...m.at(first, 1)].sort(), before, "rebuilt after eviction, same contents");
	const again = m.at(first, 1);
	assert.equal(m.at(first, 1), again, "while kept, the same set");
	// Shared's history and its newest version answer as before.
	assert.deepEqual([...m.at(m.shared, 2)].sort(), ["s0", "s1", "s2"]);
	assert.equal(m.at(m.shared, 9), m.shared.own, "shared's newest version is its live set, never cached");
});

test("a draft replaced under the same name never gets the old one's set", () => {
	const m = membership(10, 1);
	const old = m.spaces.get("d0")!;
	assert.ok(m.at(old, 1).has("d0-x"));
	const replaced = newSpace("d0");
	m.spaces.set("d0", replaced);
	addVersion(replaced, { version: 0, agent: "a", message: "start", time: 0, atoms: [], sharedBase: 5 });
	addVersion(replaced, { version: 1, agent: "a", message: "work", time: 0, atoms: ["new"], sharedBase: 5 });
	const now = m.at(replaced, 1);
	assert.equal(now.has("d0-x"), false);
	assert.deepEqual([...now].sort(), ["new", "s0", "s1", "s2", "s3", "s4", "s5"]);
	assert.equal(SHARED, m.shared.name);
});
