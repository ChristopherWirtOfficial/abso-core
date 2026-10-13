import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExperimentalMarkerProjection } from "../experimental/projection-marker.ts";
import type { ProjectionIdentity } from "../experimental/projection-root.ts";
import { ProjectionSnapshots } from "../experimental/projection-snapshots.ts";
import { Graph } from "../graph.ts";
import { CachedStateStorage } from "../state-source.ts";
import { Repo } from "./helpers.ts";
import { SqlState } from "./storage-helper.ts";

test("experimental snapshots reopen and refuse wrong identities before projection reads", () => {
	const filename = join(mkdtempSync(join(tmpdir(), "abso-projection-snapshot-")), "state.sqlite");
	let storage = new SqlState(filename);
	const repo = Repo.init({ "f.txt": "hello\n", "g.txt": "other\n" });
	const identity: ProjectionIdentity = {
		database: "database-a",
		namespace: "index-a",
		registry: "registry-a",
		defaultFile: "f.txt",
		sourceGeneration: 1,
		sourceLength: 1,
		sourceDigest: "a".repeat(64),
		membership: "base",
	};
	try {
		let graph = new Graph({ storage: new CachedStateStorage(storage) });
		graph.add(repo.graph.atom("a0"));
		let adapter = new ExperimentalMarkerProjection(storage, graph, "f.txt", "index-a");
		let snapshots = new ProjectionSnapshots(storage, adapter, identity);
		const state = adapter.apply(adapter.empty(), repo.graph.atom("a0"));
		const handle = snapshots.save(0, identity, state);
		storage.db.close();
		storage = new SqlState(filename);
		graph = new Graph({ storage: new CachedStateStorage(storage) });
		adapter = new ExperimentalMarkerProjection(storage, graph, "f.txt", "index-a");
		snapshots = new ProjectionSnapshots(storage, adapter, identity);
		const reopened = snapshots.load(handle, identity);
		assert.deepEqual(adapter.lines(reopened), ["a0.0"]);
		for (const field of Object.keys(identity) as (keyof ProjectionIdentity)[]) {
			const changed = {
				...identity,
				[field]:
					typeof identity[field] === "number"
						? Number(identity[field]) + 1
						: field === "sourceDigest"
							? "b".repeat(64)
							: `${identity[field]}:other`,
			};
			const reads = storage.reads,
				writes = storage.writes;
			assert.throws(() => snapshots.load(handle, changed), /mismatch/);
			assert.equal(storage.reads, reads);
			assert.equal(storage.writes, writes);
		}
		assert.throws(
			() =>
				new ProjectionSnapshots(
					storage,
					new ExperimentalMarkerProjection(storage, graph, "g.txt", "index-a"),
					identity,
				),
			/constructor mismatch/,
		);
		const rows = () => JSON.stringify(storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all());
		const before = rows();
		assert.throws(
			() =>
				storage.transaction(() => {
					snapshots.save(1, identity, reopened);
					throw Error("fail after snapshot");
				}),
			/fail after snapshot/,
		);
		assert.equal(rows(), before);
		storage.write('experimental-projection:["database-a","index-a"]:context', "binding", {
			...identity,
			registry: "replaced",
		});
		assert.throws(() => snapshots.load(handle, identity), /registry binding/);
	} finally {
		storage.db.close();
	}
});

test("experimental snapshots preserve mixed files across two reopens and subsequent writes", () => {
	const directory = mkdtempSync(join(tmpdir(), "abso-projection-mixed-"));
	const filename = join(directory, "state.sqlite");
	let storage = new SqlState(filename);
	const repo = Repo.init({ "f.txt": "a\nb\n", "g.txt": "x\n" });
	const identity: ProjectionIdentity = {
		database: "mixed-database",
		namespace: "mixed-index",
		registry: "mixed-registry",
		defaultFile: "f.txt",
		sourceGeneration: 1,
		sourceLength: 1,
		sourceDigest: "a".repeat(64),
		membership: "base",
	};
	let graph = new Graph({ storage: new CachedStateStorage(storage) });
	let adapter = new ExperimentalMarkerProjection(storage, graph, "f.txt", identity.namespace);
	let snapshots = new ProjectionSnapshots(storage, adapter, identity);
	graph.add(repo.graph.atom("a0"));
	let state = adapter.apply(adapter.empty(), repo.graph.atom("a0"));
	const original = snapshots.save(0, identity, state);
	const reopen = () => {
		storage.db.close();
		storage = new SqlState(filename);
		graph = new Graph({ storage: new CachedStateStorage(storage) });
		adapter = new ExperimentalMarkerProjection(storage, graph, "f.txt", identity.namespace);
		snapshots = new ProjectionSnapshots(storage, adapter, identity);
	};
	const check = () => {
		const view = repo.view();
		for (const path of ["f.txt", "g.txt", "empty.txt"]) {
			assert.deepEqual(
				adapter.lines(state, path),
				view.lines(path).map((line) => line.id),
			);
			assert.deepEqual(adapter.attrs(state, path), view.attrs(path));
		}
	};
	try {
		const move = repo.edit({ move: { file: "f.txt", start: 0, end: 1, to: "g.txt", at: 0 } });
		graph.add(move);
		state = adapter.apply(state, move);
		const attr = repo.edit({
			attrs: [
				{ file: "empty.txt", name: "exists", value: "1" },
				{ file: "g.txt", name: "exec", value: "1" },
			],
		});
		graph.add(attr);
		state = adapter.apply(state, attr);
		const mixedIdentity = { ...identity, sourceLength: 3, sourceDigest: "b".repeat(64), membership: "mixed" };
		const mixed = snapshots.save(1, mixedIdentity, state);
		reopen();
		state = snapshots.load(mixed, mixedIdentity);
		check();
		const writes = storage.writes;
		assert.equal(adapter.apply(state, attr), state);
		assert.equal(storage.writes, writes);
		for (const atom of [attr, move]) {
			repo.shared.delete(atom.id);
			state = adapter.removeAtom(state, atom);
			check();
		}
		assert.deepEqual(adapter.lines(snapshots.load(original, identity), "f.txt"), ["a0.0", "a0.1"]);
		const edit = repo.edit({ edits: [{ file: "g.txt", old: "x\n", new: "after restart\n" }] });
		graph.add(edit);
		state = adapter.apply(state, edit);
		check();
		const finalIdentity = { ...identity, sourceLength: 4, sourceDigest: "c".repeat(64), membership: "edited" };
		const final = snapshots.save(2, finalIdentity, state);
		reopen();
		state = snapshots.load(final, finalIdentity);
		check();
		assert.deepEqual(adapter.lines(snapshots.load(mixed, mixedIdentity), "g.txt"), ["a0.0", "a0.2"]);
		assert.equal(
			storage.db
				.prepare(
					"SELECT count(*) AS n FROM state WHERE collection LIKE '%sequence-resolver:%' OR collection LIKE '%sequence-relocation-work:%'",
				)
				.get()!.n,
			0,
		);
	} finally {
		storage.db.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
