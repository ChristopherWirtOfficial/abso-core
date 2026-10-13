import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { ExperimentalMarkerProjection } from "../../../src/engine/experimental/projection-marker.ts";
import { ProjectionOverlayStorage } from "../../../src/engine/experimental/projection-overlay-storage.ts";
import { ProjectionReadScope } from "../../../src/engine/experimental/projection-read-scope.ts";
import { ProjectionReader } from "../../../src/engine/experimental/projection-reader.ts";
import type { ProjectionHandle, ProjectionIdentity } from "../../../src/engine/experimental/projection-root.ts";
import { ProjectionSnapshots } from "../../../src/engine/experimental/projection-snapshots.ts";
import type { Graph } from "../../../src/engine/graph.ts";
import { CachedStateStorage, storedArray } from "../../../src/engine/state-source.ts";
import { SqlState } from "../../../src/engine/test/storage-helper.ts";
import { MemoryStore, Project } from "../project.ts";
import type { Entry, ProjectOptions, ProjectStore } from "../project-types.ts";
import { projectedReader } from "../projection-provider.ts";
import { Membership } from "../spaces.ts";
import { ViewCache } from "../views.ts";
import { WriterAgents } from "../writer-agents.ts";

// Private test host only. Canonical frames and projection receipts share one SQLite transaction.
class ProjectionHost {
	readonly storage: SqlState;
	readonly entries: Entry[];
	verifyReadParity = true;
	readViewProvider?: ProjectOptions["readViewProvider"];
	enableReaderProvider(): void {
		this.readViewProvider = (graph) => {
			const scope = this.newReadScope(graph);
			return { keyed: (key) => this.readerForKey(key, graph, scope.guard(graph)) };
		};
	}
	#scopeFrames: { token: object; scopes: ProjectionReadScope[]; overlays: ProjectionOverlayStorage[] }[] = [];
	#nextOverlay = 0;
	newReadScope(graph: Graph): ProjectionReadScope {
		const frame = this.#scopeFrames.at(-1);
		assert.ok(frame, "reader provider requires an active transaction");
		const scope = new ProjectionReadScope(graph, () => this.#scopeFrames.at(-1)?.token);
		frame.scopes.push(scope);
		return scope;
	}
	#transaction<T>(operation: () => T): T {
		const parent = this.#scopeFrames.at(-1);
		if (parent) {
			for (const scope of parent.scopes) scope.close();
			parent.scopes.length = 0;
		}
		const frame = { token: {}, scopes: [] as ProjectionReadScope[], overlays: [] as ProjectionOverlayStorage[] };
		this.#scopeFrames.push(frame);
		try {
			return this.storage.transaction(() => {
				try {
					return operation();
				} finally {
					for (const overlay of frame.overlays) overlay.close();
				}
			});
		} finally {
			for (const scope of frame.scopes) scope.close();
			assert.equal(this.#scopeFrames.pop(), frame);
		}
	}

	constructor(filename = ":memory:") {
		this.storage = new SqlState(filename);
		this.entries = storedArray<Entry>(this.storage, "integration:canonical");
	}
	readonly store: ProjectStore = {
		append: (batch) => {
			for (const entry of batch) {
				const digest = this.storage.read("integration:source", "digest") ?? "";
				this.entries.push(entry);
				this.storage.write(
					"integration:source",
					"digest",
					createHash("sha256")
						.update(JSON.stringify([digest, entry]))
						.digest("hex"),
				);
				this.storage.write(
					"integration:prefixes",
					String(this.entries.length),
					this.storage.read("integration:source", "digest"),
				);
			}
		},
	};
	run<T>(
		id: string,
		expectedLength: number,
		operation: (project: Project) => T,
		fail = false,
		request: { body: string; target: string; authority: string } = {
			body: id,
			target: "shared",
			authority: "test-writer",
		},
	): T {
		// The real host must supply a normalized request body, never a callback's source text.
		const requestDigest = createHash("sha256")
			.update(JSON.stringify([request.body, request.target, request.authority]))
			.digest("hex");
		return this.#transaction(() => {
			const receipt = this.storage.read("integration:receipts", id) as { result: T; requestDigest: string } | undefined;
			if (receipt) {
				if (receipt.requestDigest !== requestDigest) throw Error("operation ID request conflict");
				return receipt.result;
			}
			assert.equal(this.entries.length, expectedLength, "stale canonical head");
			const project = this.entries.length
				? Project.openWriter(this.store, this.storage, this.entries.length, { readViewProvider: this.readViewProvider })
				: new Project(this.store, { writerStorage: this.storage });
			const adapter = new ExperimentalMarkerProjection(
				this.storage,
				project.graph,
				"a.txt",
				JSON.stringify(["database-a", "projection-a"]),
			);
			const context = {
				database: "database-a",
				namespace: JSON.stringify(["database-a", "projection-a"]),
				registry: "registry-a",
				defaultFile: "a.txt",
			};
			const snapshots = new ProjectionSnapshots(this.storage, adapter, context);
			const previous = this.storage.read("integration:head", "projection") as ProjectionHandle | undefined;
			if (this.entries.length && !previous) throw Error("missing committed projection head");
			const expected: ProjectionIdentity = {
				...context,
				sourceGeneration: 1,
				sourceLength: this.entries.length,
				sourceDigest: this.storage.read("integration:prefixes", String(this.entries.length)) as string,
				membership: this.entries.length ? String(project.version) : "-1",
			};
			let state = previous ? snapshots.load(previous, expected) : adapter.empty();
			const before = previous ? project.version : -1;
			const result = operation(project);
			const save = (version: number): ProjectionHandle => {
				const next = (this.storage.read("integration:head", "next-root") as number | undefined) ?? 0;
				const handle = snapshots.save(
					next,
					{
						...context,
						sourceGeneration: 1,
						sourceLength: this.entries.length,
						sourceDigest: this.storage.read("integration:source", "digest") as string,
						membership: String(version),
					},
					state,
				);
				this.storage.write("integration:head", "next-root", next + 1);
				return handle;
			};
			let versionHandle: ProjectionHandle | undefined;
			const membership = new Membership(this.storage);
			for (let version = before + 1; version <= project.version; version++) {
				const delta = membership.shared.versions[version]!;
				for (const atom of [...(delta.dropped ?? [])].map((id) => project.graph.atom(id)).sort((a, b) => b.seq - a.seq))
					state = adapter.removeAtom(state, atom);
				for (const atom of delta.atoms.map((id) => project.graph.atom(id)).sort((a, b) => a.seq - b.seq))
					state = adapter.apply(state, atom);
				versionHandle = save(version);
				this.storage.write("integration:versions", String(version), versionHandle);
			}
			const handle =
				previous && this.entries.length === expectedLength ? previous : (versionHandle ?? save(project.version));
			this.storage.write("integration:head", "projection", handle);
			this.storage.write("integration:head", "version", project.version);
			if (!this.storage.read("integration:versions", String(project.version)))
				this.storage.write("integration:versions", String(project.version), handle);
			this.storage.write("integration:receipts", id, { result, requestDigest });
			for (const path of this.verifyReadParity ? ["a.txt", "b.txt"] : []) {
				const reader = new ProjectionReader(adapter, state, this.newReadScope(project.graph).guard(project.graph));
				assert.deepEqual(reader.lines(path), project.sharedView().lines(path));
				assert.deepEqual(reader.knownPaths(), project.sharedView().knownPaths());
				assert.deepEqual(reader.sequence(path), project.sharedView().sequence(path));
				assert.equal(reader.text(path), project.sharedView().text(path));
				assert.equal(reader.hasFile(path), project.sharedView().hasFile(path));
				assert.deepEqual(
					adapter.lines(state, path),
					project
						.sharedView()
						.lines(path)
						.map((line) => line.id),
				);
				assert.deepEqual(adapter.attrs(state, path), project.sharedView().attrs(path));
			}
			if (fail) throw Error("injected outer rollback");
			return result;
		});
	}
	draftLines(name: string, path: string): string[] {
		return this.withDraftReader(name, (reader) => reader.lines(path).map((line) => line.id));
	}
	readerForKey(key: string, graph: Graph, assertLive?: () => void): ProjectionReader {
		const frame = this.#scopeFrames.at(-1);
		assert.ok(frame, "projection reads require a transaction");
		const guard = assertLive ?? this.newReadScope(graph).guard(graph);
		const versions = new Membership(this.storage).shared.versions;
		return projectedReader(
			{
				graph,
				context: {
					database: "database-a",
					namespace: JSON.stringify(["database-a", "projection-a"]),
					registry: "registry-a",
					defaultFile: "a.txt",
				},
				sourceGeneration: 1,
				sourceLength: () => this.entries.length,
				prefixDigest: (length) => this.storage.read("integration:prefixes", String(length)) as string | undefined,
				version: () => versions.length - 1,
				committed: () => ({
					version: this.storage.read("integration:head", "version") as number,
					handle: this.storage.read("integration:head", "projection") as ProjectionHandle,
				}),
				at: (version) => this.storage.read("integration:versions", String(version)) as ProjectionHandle | undefined,
				delta: (version) => versions[version],
				guard: () => guard,
				allocate: () => {
					const overlay = new ProjectionOverlayStorage(this.storage, `reader-${this.#nextOverlay++}`);
					frame.overlays.push(overlay);
					return new CachedStateStorage(overlay, frame.overlays.length <= 32 ? 8192 : 0, 32);
				},
			},
			key,
		);
	}

	withDraftReader<T>(name: string, read: (reader: ProjectionReader) => T): T {
		const rollback = Symbol("completed draft read");
		let result!: T;
		try {
			this.#transaction(() => {
				const project = Project.openWriter(this.store, this.storage, this.entries.length, {
					readViewProvider: this.readViewProvider,
				});
				const actor = new WriterAgents(this.storage).get(name);
				assert.ok(actor);
				assert.equal(actor.space, "", "named draft projection is not implemented in this test host");
				const handle = this.storage.read("integration:versions", String(actor.base)) as ProjectionHandle;
				assert.ok(handle, "missing exact base projection");
				const context = {
					database: "database-a",
					namespace: JSON.stringify(["database-a", "projection-a"]),
					registry: "registry-a",
					defaultFile: "a.txt",
				};
				const adapter = new ExperimentalMarkerProjection(this.storage, project.graph, "a.txt", context.namespace);
				const snapshots = new ProjectionSnapshots(this.storage, adapter, context);
				const expected: ProjectionIdentity = {
					...context,
					sourceGeneration: 1,
					sourceLength: handle.identity.sourceLength,
					sourceDigest: this.storage.read("integration:prefixes", String(handle.identity.sourceLength)) as string,
					membership: String(actor.base),
				};
				let state = snapshots.load(handle, expected);
				for (const id of actor.mine) state = adapter.apply(state, project.graph.atom(id));
				result = read(new ProjectionReader(adapter, state, this.newReadScope(project.graph).guard(project.graph)));
				throw rollback;
			});
		} catch (error) {
			if (error !== rollback) throw error;
		}
		return result;
	}
}

test("measure private routed fixed-working-set cost", { skip: process.env.ABSO_PROJECTION_COST !== "1" }, () => {
	for (const revisions of [8, 32, 128]) {
		const host = new ProjectionHost();
		try {
			host.run("init", 0, (p) => p.init({ "a.txt": "head\nrevision 0\ntail\n" }, 0));
			for (let i = 1; i <= revisions; i++)
				host.run(`seed-${i}`, host.entries.length, (p) => {
					p.record("writer", { "a.txt": `head\nrevision ${i}\ntail\n` }, i * 2);
					p.publish("writer", "Seed", i * 2 + 1);
				});
			host.enableReaderProvider();
			host.verifyReadParity = false;
			const byCollection = new Map<string, number>();
			const callers = new Map<string, number>();
			const read = host.storage.read.bind(host.storage);
			host.storage.read = (collection, key) => {
				if (process.env.ABSO_PROJECTION_TRACE === "1" && collection === "line-base") {
					const stack = new Error().stack!.split("\n").slice(2, 11).join("\n");
					callers.set(stack, (callers.get(stack) ?? 0) + 1);
				}
				const group = collection.startsWith("projection:temporary:") ? "projection:temporary" : collection;
				byCollection.set(group, (byCollection.get(group) ?? 0) + 1);
				return read(collection, key);
			};
			const reads = host.storage.reads,
				writes = host.storage.writes,
				scans = host.storage.scans;
			const start = performance.now();
			host.run("measured", host.entries.length, (p) => {
				p.record("writer", { "a.txt": "head\nmeasured\ntail\n" }, 1000);
				assert.equal(p.publish("writer", "Measured", 1001).ok, true);
			});
			console.log(
				JSON.stringify({
					revisions,
					liveLines: 3,
					milliseconds: performance.now() - start,
					reads: host.storage.reads - reads,
					writes: host.storage.writes - writes,
					scans: host.storage.scans - scans,
					collections: [...byCollection].sort((a, b) => b[1] - a[1]).slice(0, 12),
					callers: [...callers].sort((a, b) => b[1] - a[1]).slice(0, 3),
				}),
			);
			assert.equal(
				host.storage.db.prepare("SELECT COUNT(*) AS n FROM state WHERE collection LIKE 'projection:temporary:%'").get()!
					.n,
				0,
			);
		} finally {
			host.storage.db.close();
		}
	}
});

for (const fail of [false, true]) {
	test(`nested host transaction permanently expires parent readers after ${fail ? "rollback" : "commit"}`, () => {
		const host = new ProjectionHost();
		try {
			host.run("init", 0, (p) => p.init({ "a.txt": "one\ntwo\n" }, 0));
			host.run("outer", host.entries.length, (p) => {
				const reader = host.readerForKey("v @0", p.graph, host.newReadScope(p.graph).guard(p.graph));
				const iterator = reader.visibleLines("a.txt");
				iterator.next();
				const inner = () =>
					host.run(
						"inner",
						host.entries.length,
						() => {
							assert.throws(() => reader.text("a.txt"), /expired/);
						},
						fail,
					);
				if (fail) assert.throws(inner, /outer rollback/);
				else inner();
				assert.throws(() => reader.text("a.txt"), /expired/);
				assert.throws(() => iterator.next(), /expired/);
				assert.equal(
					host.readerForKey("v @0", p.graph, host.newReadScope(p.graph).guard(p.graph)).text("a.txt"),
					"one\ntwo\n",
				);
			});
		} finally {
			host.storage.db.close();
		}
	});
}

test("private projection host joins actual Project commits and rolls back with canonical state", () => {
	const host = new ProjectionHost();
	const oracle = new Project(new MemoryStore());
	let id = 0;
	const run = <T>(operation: (project: Project) => T) =>
		assert.deepEqual(host.run(String(id++), host.entries.length, operation), operation(oracle));
	try {
		run((p) => p.init({ "a.txt": "one\n", "b.txt": "two\n" }, 0));
		run((p) => p.record("left", { "a.txt": "ONE\n" }, 1));
		run((p) => p.record("right", { "b.txt": "TWO\n" }, 2));
		run((p) => p.publish("left", "Left", 3));
		run((p) => p.publish("right", "Right", 4));
		const rows = () => JSON.stringify(host.storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all());
		const before = rows(),
			length = host.entries.length;
		assert.throws(
			() => host.run("failure", length, (p) => p.record("left", { "a.txt": "again\n" }, 5), true),
			/outer rollback/,
		);
		assert.equal(rows(), before);
		assert.throws(() => host.run("stale", length - 1, () => null), /stale canonical head/);
		assert.equal(rows(), before);
		host.run("retry", length, (p) => p.record("left", { "a.txt": "again\n" }, 5));
		const committed = rows();
		host.run("retry", length, () => {
			throw Error("retry executed twice");
		});
		assert.equal(rows(), committed);
	} finally {
		host.storage.db.close();
	}
});

test("runtime provider refuses a valid root stored under the wrong version", () => {
	const host = new ProjectionHost();
	try {
		host.run("init", 0, (p) => p.init({ "a.txt": "one\n" }, 0));
		host.run("edit", host.entries.length, (p) => {
			p.record("writer", { "a.txt": "two\n" }, 1);
			p.publish("writer", "Edit", 2);
		});
		const original = host.storage.read("integration:versions", "1");
		host.storage.write("integration:versions", "1", host.storage.read("integration:versions", "0"));
		const writes = host.storage.writes;
		assert.throws(
			() => host.run("wrong-version", host.entries.length, (p) => host.readerForKey("v @1", p.graph)),
			/mismatch/,
		);
		assert.equal(host.storage.writes, writes);
		host.storage.write("integration:versions", "1", original);
		for (const key of ["v @2", "v named@1", "v @01", "v @1+a0"])
			assert.throws(
				() => host.run(key, host.entries.length, (p) => host.readerForKey(key, p.graph)),
				/authority|unsupported/,
			);
	} finally {
		host.storage.db.close();
	}
});

test("private projection host refuses a forged source or membership handle before executing", () => {
	const host = new ProjectionHost();
	try {
		host.run("init", 0, (p) => p.init({ "a.txt": "one\n" }, 0));
		const original = host.storage.read("integration:head", "projection") as ProjectionHandle;
		for (const change of [
			{ sourceDigest: "f".repeat(64) },
			{ sourceLength: original.identity.sourceLength + 1 },
			{ membership: "900" },
			{ database: "other-database" },
			{ sourceGeneration: 2 },
		]) {
			host.storage.write("integration:head", "projection", {
				...original,
				identity: { ...original.identity, ...change },
			});
			let invoked = false;
			const writes = host.storage.writes;
			assert.throws(
				() =>
					host.run("forged", host.entries.length, () => {
						invoked = true;
					}),
				/mismatch/,
			);
			assert.equal(invoked, false);
			assert.equal(host.storage.writes, writes);
		}
		host.storage.write("integration:head", "projection", original);
		host.run("valid", host.entries.length, (p) => p.record("writer", { "a.txt": "two\n" }, 1));
		assert.equal(
			host.storage.read("integration:prefixes", String(original.identity.sourceLength)),
			original.identity.sourceDigest,
			"later graph extension preserves the old canonical prefix identity",
		);
	} finally {
		host.storage.db.close();
	}
});

test("private projection host routes cross-file moves, later edits and dropping versions", (t) => {
	const host = new ProjectionHost();
	const oracle = new Project(new MemoryStore());
	let id = 0;
	const run = <T>(operation: (project: Project) => T) => {
		const read = host.storage.read.bind(host.storage);
		const guard =
			host.readViewProvider &&
			t.mock.method(host.storage, "read", (collection: string, key: string) => {
				if (collection === 'membership:"":events') throw Error("historical membership enumeration forbidden");
				return read(collection, key);
			});
		let actual: T;
		try {
			actual = host.run(`move-${id++}`, host.entries.length, operation);
		} finally {
			if (guard) guard.mock.restore();
		}
		assert.deepEqual(actual, operation(oracle));
	};
	try {
		const block = "function example() {\n  return 42;\n}\n";
		run((p) => p.init({ "a.txt": `header\n${block}`, "b.txt": "destination\n" }, 0));
		host.enableReaderProvider();
		run((p) => p.record("mover", { "a.txt": "header\n", "b.txt": `destination\n${block}` }, 1));
		run((p) => p.publish("mover", "Move function", 2));
		run((p) => p.record("editor", { "b.txt": `destination\n${block.replace("42", "43")}` }, 3));
		run((p) => p.publish("editor", "Edit moved function", 4));
		run((p) => p.drop("cleanup", [2], "Undo edit", 5));
		run((p) => p.drop("cleanup", [1], "Undo move", 6));
		assert.deepEqual(Project.openWriter(host.store, host.storage, host.entries.length).files(), oracle.files());
	} finally {
		host.storage.db.close();
	}
});

test("private projection host reopens the database and retries the committed receipt", () => {
	const filename = join(mkdtempSync(join(tmpdir(), "abso-project-projection-")), "state.sqlite");
	let host = new ProjectionHost(filename);
	try {
		host.run("init", 0, (p) => p.init({ "a.txt": "one\n" }, 0));
		const length = host.entries.length;
		const result = host.run("record", length, (p) => p.record("writer", { "a.txt": "two\n" }, 1));
		host.storage.db.close();
		host = new ProjectionHost(filename);
		const before = host.entries.length;
		assert.deepEqual(
			host.run("record", length, () => {
				throw Error("replayed receipt executed");
			}),
			result,
		);
		assert.equal(host.entries.length, before);
		host.run("publish", before, (p) => p.publish("writer", "After restart", 2));
		host.storage.db.close();
		host = new ProjectionHost(filename);
		assert.deepEqual(Project.openWriter(host.store, host.storage, host.entries.length).files(), { "a.txt": "two\n" });
		host.run("later", host.entries.length, (p) => p.record("writer", { "a.txt": "three\n" }, 3));
	} finally {
		host.storage.db.close();
	}
});

test("private projection host reuses its snapshot when an operation appends nothing", () => {
	const host = new ProjectionHost();
	try {
		host.run("init", 0, (p) => p.init({ "a.txt": "one\n" }, 0));
		const head = host.storage.read("integration:head", "projection");
		const length = host.entries.length;
		assert.deepEqual(
			host.run("read", length, (p) => p.files()),
			{ "a.txt": "one\n" },
		);
		assert.deepEqual(host.storage.read("integration:head", "projection"), head);
		assert.equal(host.entries.length, length);
	} finally {
		host.storage.db.close();
	}
});

test("private projection receipts reject changed request, target or authority", () => {
	const host = new ProjectionHost();
	const request = {
		body: JSON.stringify({ kind: "init", files: { "a.txt": "one\n" } }),
		target: "shared",
		authority: "writer-a",
	};
	try {
		const result = host.run("request", 0, (p) => p.init({ "a.txt": "one\n" }, 0), false, request);
		for (const changed of [
			{ ...request, body: "different" },
			{ ...request, target: "draft" },
			{ ...request, authority: "writer-b" },
		]) {
			const writes = host.storage.writes;
			assert.throws(
				() =>
					host.run(
						"request",
						0,
						() => {
							throw Error("must not execute");
						},
						false,
						changed,
					),
				/request conflict/,
			);
			assert.equal(host.storage.writes, writes);
		}
		assert.deepEqual(
			host.run(
				"request",
				0,
				() => {
					throw Error("must not execute");
				},
				false,
				request,
			),
			result,
		);
	} finally {
		host.storage.db.close();
	}
});

test("private projection derives each concurrent draft from its exact older base", () => {
	const host = new ProjectionHost();
	try {
		host.run("init", 0, (p) => p.init({ "a.txt": "one\n", "b.txt": "two\n" }, 0));
		host.run("left", host.entries.length, (p) => p.record("left", { "a.txt": "LEFT\n" }, 1));
		host.run("right", host.entries.length, (p) => p.record("right", { "b.txt": "RIGHT\n" }, 2));
		host.run("publish", host.entries.length, (p) => p.publish("right", "Advance shared", 3));
		const project = Project.openWriter(host.store, host.storage, host.entries.length);
		for (const actor of ["left", "right"])
			for (const path of ["a.txt", "b.txt"])
				assert.deepEqual(
					host.draftLines(actor, path),
					project
						.draftOf(actor)!
						.view.lines(path)
						.map((line) => line.id),
				);
		assert.notDeepEqual(host.draftLines("left", "b.txt"), host.draftLines("right", "b.txt"));
	} finally {
		host.storage.db.close();
	}
});

test("private draft projection does not enumerate historical membership or canonical frames", (t) => {
	const host = new ProjectionHost();
	try {
		host.run("init", 0, (p) => p.init({ "a.txt": "one\n" }, 0));
		for (let i = 0; i < 12; i++) {
			host.run(`record-${i}`, host.entries.length, (p) => p.record("writer", { "a.txt": `${i}\n` }, i * 2 + 1));
			host.run(`publish-${i}`, host.entries.length, (p) => p.publish("writer", `Revision ${i}`, i * 2 + 2));
		}
		host.run("draft", host.entries.length, (p) => p.record("draft", { "a.txt": "pending\n" }, 30));
		const project = Project.openWriter(host.store, host.storage, host.entries.length);
		const expected = project
			.draftOf("draft")!
			.view.lines("a.txt")
			.map((line) => line.id);
		const read = host.storage.read.bind(host.storage);
		t.mock.method(host.storage, "read", (collection: string, key: string) => {
			if (
				collection === "integration:canonical" ||
				(collection.startsWith("membership:") && (collection.includes(":events") || collection.endsWith(":own")))
			)
				throw Error(`historical enumeration forbidden: ${collection}`);
			return read(collection, key);
		});
		t.mock.method(host.storage, "entries", () => {
			throw Error("collection enumeration forbidden");
		});
		assert.deepEqual(host.draftLines("draft", "a.txt"), expected);
	} finally {
		host.storage.db.close();
	}
});

test("temporary draft projection leaves no pages after repeated reads or a failed write", () => {
	const host = new ProjectionHost();
	try {
		host.run("init", 0, (p) => p.init({ "a.txt": "one\n" }, 0));
		host.run("draft", host.entries.length, (p) => p.record("writer", { "a.txt": "draft\n" }, 1));
		const rows = () => JSON.stringify(host.storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all());
		const before = rows();
		const expected = Project.openWriter(host.store, host.storage, host.entries.length)
			.draftOf("writer")!
			.view.lines("a.txt")
			.map((line) => line.id);
		for (let i = 0; i < 3; i++) {
			assert.deepEqual(host.draftLines("writer", "a.txt"), expected);
			assert.equal(rows(), before);
		}
		host.storage.failWrite = host.storage.writes + 3;
		assert.throws(() => host.draftLines("writer", "a.txt"), /injected/);
		assert.equal(rows(), before);
		host.storage.failWrite = Infinity;
		assert.deepEqual(host.draftLines("writer", "a.txt"), expected);
		assert.equal(rows(), before);
	} finally {
		host.storage.db.close();
	}
});

test("private host retains intermediate version roots inside one outer commit", () => {
	const host = new ProjectionHost();
	try {
		host.run("init", 0, (p) => p.init({ "a.txt": "one\n" }, 0));
		host.run("batch", host.entries.length, (p) => {
			p.record("first", { "a.txt": "two\n" }, 1);
			p.publish("first", "Two", 2);
			p.record("old-base", { "a.txt": "older draft\n" }, 3);
			p.record("second", { "a.txt": "three\n" }, 4);
			p.publish("second", "Three", 5);
		});
		assert.ok(host.storage.read("integration:versions", "1"));
		assert.ok(host.storage.read("integration:versions", "2"));
		const project = Project.openWriter(host.store, host.storage, host.entries.length);
		assert.deepEqual(
			host.draftLines("old-base", "a.txt"),
			project
				.draftOf("old-base")!
				.view.lines("a.txt")
				.map((line) => line.id),
		);
	} finally {
		host.storage.db.close();
	}
});

for (const competingPath of ["a.txt", "b.txt"] as const) {
	for (const mode of ["rollback", "commit"] as const) {
		test(`actual Project record and publish route privately with ${mode}, competing ${competingPath}, and no old closure`, (t) => {
			const filename = join(mkdtempSync(join(tmpdir(), "projection-route-")), "state.sqlite");
			let host = new ProjectionHost(filename);
			try {
				host.run("init", 0, (p) => p.init({ "a.txt": "one\n", "b.txt": "two\n" }, 0));
				host.run("left", host.entries.length, (p) => p.record("left", { "a.txt": "LEFT\n" }, 1));
				host.run("right", host.entries.length, (p) => p.record("right", { [competingPath]: "RIGHT\n" }, 2));
				host.run("publish", host.entries.length, (p) => p.publish("right", "Advance shared", 3));
				const expected = "LEFT\n";
				const oracle = Project.load([...host.entries], new MemoryStore());
				const recorded = oracle.record("left", { "a.txt": "UPDATED\n" }, 4);
				const published = oracle.publish("left", "Publish routed edit", 5);
				assert.equal(published.ok, competingPath !== "a.txt");
				const rows = () => JSON.stringify(host.storage.db.prepare("SELECT * FROM state ORDER BY collection,key").all());
				const before = rows();
				let calls = 0;
				let lastReader: ProjectionReader | undefined;
				host.readViewProvider = (graph) => {
					const scope = host.newReadScope(graph);
					return {
						keyed: (key) => {
							calls++;
							return (lastReader = host.readerForKey(key, graph, scope.guard(graph)));
						},
					};
				};
				const route = (project: Project) => {
					calls = 0;
					const unkeyed = t.mock.method(ViewCache.prototype, "view", () => {
						throw Error("unkeyed historical View construction is forbidden");
					});
					const replay = t.mock.method(Project, "load", () => {
						throw Error("canonical Project replay is forbidden");
					});
					const read = host.storage.read.bind(host.storage);
					const guard = t.mock.method(host.storage, "read", (collection: string, key: string) => {
						if (collection === 'membership:"":events') throw Error("old closure membership enumeration forbidden");
						return read(collection, key);
					});
					try {
						assert.equal(project.draftOf("left")!.view.text("a.txt"), expected);
						assert.equal(calls, 1);
						assert.deepEqual(project.record("left", { "a.txt": "UPDATED\n" }, 4), recorded);
						assert.deepEqual(project.publish("left", "Publish routed edit", 5), published);
					} finally {
						replay.mock.restore();
						unkeyed.mock.restore();
						guard.mock.restore();
					}
				};
				if (mode === "rollback") {
					host.withDraftReader("left", () =>
						route(
							Project.openWriter(host.store, host.storage, host.entries.length, {
								readViewProvider: host.readViewProvider,
							}),
						),
					);
					assert.equal(rows(), before);
				} else {
					const length = host.entries.length;
					assert.throws(() => host.run("routed", length, route, true), /injected outer rollback/);
					assert.equal(rows(), before);
					assert.throws(() => lastReader!.text("a.txt"), /expired|stale/);
					host.run("routed", length, route);
					assert.equal(
						host.storage.db
							.prepare("SELECT COUNT(*) AS n FROM state WHERE collection LIKE 'projection:temporary:%'")
							.get()!.n,
						0,
					);
					const committed = rows();
					host.storage.db.close();
					host = new ProjectionHost(filename);
					assert.equal(rows(), committed);
					host.run("routed", length, () => {
						throw Error("committed retry executed twice");
					});
					assert.equal(rows(), committed);
					host.withDraftReader("left", (reader) => {
						assert.equal(reader.text("a.txt"), oracle.draftOf("left")!.view.text("a.txt"));
						assert.equal(reader.text("b.txt"), oracle.draftOf("left")!.view.text("b.txt"));
						const shared = host.readerForKey(`v @${oracle.version}`, reader.graph);
						for (const path of ["a.txt", "b.txt"]) assert.equal(shared.text(path), oracle.sharedView().text(path));
					});
					assert.equal(rows(), committed);
				}
				assert.ok(lastReader);
				assert.throws(() => lastReader!.text("a.txt"), /expired|stale/);
			} finally {
				host.storage.db.close();
			}
		});
	}
}
