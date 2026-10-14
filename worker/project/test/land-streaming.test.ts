import assert from "node:assert/strict";
import { test } from "node:test";
import { StableOverlaySet, StableSet } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { type LandHost, landCollisions } from "../land.ts";
import { addVersion, Membership, type Space } from "../spaces.ts";

test("landing collision setup does not enumerate shared history", () => {
	class History extends StableSet<string> {
		readonly retainedBytes = 0;
		readonly end: number;
		constructor(end: number) {
			super();
			this.end = end;
		}
		has(id: string) {
			return /^a\d+$/.test(id) && Number(id.slice(1)) < this.end;
		}
		values(): SetIterator<string> {
			throw Error("shared history enumeration forbidden during setup");
		}
	}
	for (const size of [32, 8192, 1_000_000]) {
		const shared = { name: "", own: new History(size) } as unknown as Space;
		const draft = {
			name: "draft",
			own: new StableOverlaySet(["draft-change"]),
			versions: [{ sharedBase: 0 }],
		} as unknown as Space;
		const host = {
			shared: () => shared,
			version: () => 1,
			at: (_space: Space, version: number) => new History(version === 0 ? size - 1 : size),
			viewAt: () => ({}),
			sharedView: () => ({}),
			pairs: (_changes: string[], newer: ReadonlySet<string>, union: ReadonlySet<string>) => {
				assert.equal(newer.has(`a${size - 1}`), true);
				assert.equal(newer.has("a0"), false);
				assert.equal(union.has("a0"), true);
				assert.equal(union.has("draft-change"), true);
				return [];
			},
			definitionRule: () => ({ collisions: () => [] }),
		} as unknown as LandHost;
		assert.deepEqual(landCollisions(host, draft, ["draft-change"], false).collisions, []);
	}
});

test("landing uses real stored membership without enumerating shared ownership", (t) => {
	const storage = new SqlState();
	try {
		const membership = new Membership(storage);
		const shared = membership.shared;
		for (let version = 0; version < 40; version++) {
			addVersion(shared, { version, agent: "test", message: "version", time: 0, atoms: [`a${version}`] });
		}
		t.mock.method(shared.own, "values", () => {
			throw Error("stored shared history enumeration forbidden");
		});
		const draft = {
			name: "draft",
			own: new StableOverlaySet(["draft-change"]),
			versions: [{ sharedBase: 38 }],
		} as unknown as Space;
		const host = {
			shared: () => shared,
			version: () => 39,
			at: (space: Space, version: number) => membership.at(space, version),
			viewAt: () => ({}),
			sharedView: () => ({}),
			pairs: (_changes: string[], newer: ReadonlySet<string>, union: ReadonlySet<string>) => {
				assert.deepEqual([...newer], ["a39"]);
				assert.equal(union.has("a0"), true);
				assert.equal(union.has("draft-change"), true);
				return [];
			},
			definitionRule: () => ({ collisions: () => [] }),
		} as unknown as LandHost;
		assert.deepEqual(landCollisions(host, draft, ["draft-change"], false).collisions, []);
	} finally {
		storage.db.close();
	}
});
