import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { test } from "node:test";
import git from "isomorphic-git";
import { Project } from "../../worker/project/project.ts";
import { EngineProject } from "../src/engine-project.ts";
import { GitDiskIntake } from "../src/git-disk-intake.ts";
import { GitIntakeLimitError } from "../src/git-intake-limit.ts";
import { MemoryFS } from "../src/memory-fs.ts";
import { memoryStorage } from "./helpers.ts";

const hooks = registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers")
			return {
				url: `data:text/javascript,${encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }")}`,
				shortCircuit: true,
			};
		return next(specifier, context);
	},
});
const { ProjectObject } = await import("../src/project-object.ts");
hooks.deregister();

for (const disk of [false, true])
	test(`failed intake retries across cold objects with disk mode ${disk}`, async (t) => {
		const storage = memoryStorage();
		t.after(() => storage.db.close());
		const values = new Map<string, unknown>();
		let alarm: number | null = null;
		const context = {
			id: { toString: () => "retry" },
			storage: {
				...storage,
				get: async (key: string) => values.get(key),
				put: async (key: string | Record<string, unknown>, value?: unknown) => {
					if (typeof key === "string") values.set(key, value);
					else for (const [name, item] of Object.entries(key)) values.set(name, item);
				},
				delete: async (key: string) => values.delete(key),
				getAlarm: async () => alarm,
				setAlarm: async (value: number) => {
					alarm = value;
				},
			},
		};
		const object = (enabled: boolean) =>
			new ProjectObject(
				context as never,
				{
					ABSO_DISK_FIRST: disk ? "on" : "off",
					ABSO_ARTIFACTS: enabled ? "on" : "off",
					ARTIFACTS: {},
				} as never,
			);
		assert.equal((await object(false).call("retry", "init", undefined, { files: { "a.txt": "first\n" } })).status, 200);
		let ready = false;
		for (let page = 0; page < 100; page++) {
			if ((await object(false).call("retry", "status", undefined, {})).status === 200) {
				ready = true;
				break;
			}
		}
		assert.equal(ready, true);
		let fails = true;
		t.mock.method(ProjectObject.prototype, "gitSync", async () => {
			if (fails) throw Error("transient intake failure");
			return null;
		});
		for (const [index, minutes] of [1, 5, 15, 15].entries()) {
			alarm = null;
			const before = Date.now();
			await object(true).alarm();
			assert.equal(values.get("git:retry-attempts"), index + 1);
			assert.ok(alarm !== null && alarm >= before + minutes * 60000 && alarm <= Date.now() + minutes * 60000);
			assert.equal(values.get("pushed"), undefined);
		}
		fails = false;
		values.set("pushed", { version: Number.MAX_SAFE_INTEGER });
		alarm = null;
		await object(true).alarm();
		assert.equal(values.has("git:retry-attempts"), false);
		assert.equal(values.has("git:error"), false);
	});

test("size refusals survive cold objects, retry changed heads or policy, and prevent outgoing pushes", async (t) => {
	let scheduled = 0;
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const values = new Map<string, unknown>();
	const context = {
		id: { toString: () => "size-refusal" },
		storage: {
			...storage,
			get: async (key: string) => values.get(key),
			put: async (key: string | Record<string, unknown>, value?: unknown) => {
				if (typeof key === "string") values.set(key, value);
				else for (const [name, item] of Object.entries(key)) values.set(name, item);
			},
			delete: async (key: string) => values.delete(key),
			getAlarm: async () => null,
			setAlarm: async (value: number) => {
				scheduled = value;
			},
		},
	};
	const artifacts = {
		get: async () => ({
			info: async () => ({ remote: "https://artifacts.invalid/size" }),
			createToken: async () => ({ plaintext: "invented-test-token" }),
			[Symbol.dispose]() {},
		}),
	};
	const object = (enabled = true) =>
		new ProjectObject(
			context as never,
			{
				ABSO_DISK_FIRST: "on",
				ABSO_ARTIFACTS: enabled ? "on" : "off",
				ARTIFACTS: artifacts,
			} as never,
		);
	assert.equal(
		(await object(false).call("size-refusal", "init", undefined, { files: { "a.txt": "original\n" } })).status,
		200,
	);
	let ready = false;
	for (let page = 0; page < 100; page++) {
		const result = await object(false).call("size-refusal", "status", undefined, {});
		if (result.status === 200) {
			ready = true;
			break;
		}
		assert.equal(result.status, 503);
	}
	assert.equal(ready, true, "project indexing must finish before testing intake refusals");
	let head = "a".repeat(40),
		downloads = 0,
		pushes = 0,
		transient = false;
	t.mock.method(git, "listServerRefs", async () => [{ ref: "refs/heads/main", oid: head }]);
	t.mock.method(git, "clone", async () => {
		downloads++;
		if (transient) throw Error("temporary network failure");
		throw new GitIntakeLimitError("decoded", "Git pack exceeds total decoded byte limit");
	});
	t.mock.method(git, "push", async () => {
		pushes++;
		return { ok: true };
	});
	await assert.rejects(() => object().gitSync(), /decoded byte limit/);
	await assert.rejects(() => object().gitSync(), /decoded byte limit/);
	assert.equal(downloads, 1);
	assert.equal(values.get("git:head"), undefined);
	assert.equal((await object().out()).version, 0);
	assert.match(JSON.stringify((await object().out()).git.error), /decoded byte limit/);
	await object().alarm();
	assert.ok(scheduled >= Date.now() + 59_000);
	assert.equal(values.get("git:retry-attempts"), 1);
	assert.equal(downloads, 1);
	assert.equal(pushes, 0);
	head = "b".repeat(40);
	await assert.rejects(() => object().gitSync(), /decoded byte limit/);
	assert.equal(downloads, 2);
	values.set("git:size-refusal", { ...(values.get("git:size-refusal") as object), policy: "old-policy" });
	await assert.rejects(() => object().gitSync(), /decoded byte limit/);
	assert.equal(downloads, 3);
	head = "c".repeat(40);
	transient = true;
	await assert.rejects(() => object().gitSync(), /temporary network failure/);
	await assert.rejects(() => object().gitSync(), /temporary network failure/);
	assert.equal(downloads, 5);
	assert.equal(values.has("git:size-refusal"), false);
	await object().alarm();
	assert.equal(pushes, 0);
	assertGitScratchEmpty(storage);
});

function assertGitScratchEmpty(storage: ReturnType<typeof memoryStorage>) {
	for (const table of [
		"git_pack_spool",
		"git_pack_resolve",
		"git_object_meta",
		"git_object_bytes",
		"git_object_budget",
	])
		assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
}

/** Keep transport synthetic while exercising the real disk pack decoder and cache. */
async function cloneFixture(remote: MemoryFS, options: Parameters<typeof git.clone>[0]) {
	const intake = (options.cache as Record<symbol, GitDiskIntake> | undefined)?.[Symbol.for("abso.git.disk-pack")];
	if (!intake) {
		(options.fs as MemoryFS).entries = structuredClone(remote.entries);
		return;
	}
	const oids = [...remote.entries.keys()].flatMap((path) => {
		const match = /\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/.exec(path);
		return match ? [match[1]! + match[2]!] : [];
	});
	const pack = (await git.packObjects({ fs: remote, dir: "/repo", oids, write: false })).packfile!;
	const { Inflate } = createRequire(import.meta.url)("pako");
	await intake.ingest([pack], () => new Inflate({ chunkSize: 16384 }));
	await git.init({ fs: options.fs, dir: options.dir, defaultBranch: "main" });
	await git.writeRef({
		fs: options.fs,
		dir: options.dir,
		ref: "main",
		value: await git.resolveRef({ fs: remote, dir: "/repo", ref: "main" }),
	});
}

test("empty disk projects and unloadable legacy projects preserve lookup fallbacks", async (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const context = { id: { toString: () => "empty" }, storage: { ...storage, get: async () => undefined } };
	const disk = new ProjectObject(context as never, { ABSO_DISK_FIRST: "on" } as never);
	assert.deepEqual(await disk.call("empty", "status", undefined, {}), {
		status: 404,
		body: { error: "no such project; run init first" },
	});
	assert.deepEqual(await disk.agents("empty"), []);
	assert.deepEqual(await disk.news("empty", [{ from: "alice", issue: null, text: "Hello" }]), [{ to: [] }]);
	await disk.alarm();
	t.mock.method(EngineProject, "open", () => {
		throw Error("unloadable legacy log");
	});
	const legacy = new ProjectObject(context as never, {} as never);
	assert.deepEqual(await legacy.agents("empty"), []);
	assert.deepEqual(await legacy.news("empty", [{ from: "alice", issue: null, text: "Hello" }]), [{ to: [] }]);
	await legacy.alarm();
});

test("ProjectObject disk-first calls survive cold objects without replay", async (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	const values = new Map<string, unknown>();
	let alarm: number | null = null;
	let onReaders: (() => Promise<void>) | undefined;
	let failGitAcknowledgement = false;
	let failNamePersistence = false;
	const context = {
		id: { toString: () => "project-1" },
		storage: {
			...storage,
			get: async (key: string) => {
				if (key === "readers" && onReaders) {
					const action = onReaders;
					onReaders = undefined;
					await action();
				}
				return values.get(key);
			},
			put: async (key: string | Record<string, unknown>, value?: unknown) => {
				if (key === "name" && failNamePersistence) {
					failNamePersistence = false;
					throw Error("injected name persistence failure");
				}
				if (failGitAcknowledgement && typeof key === "object" && "git:head" in key) {
					failGitAcknowledgement = false;
					throw Error("injected Git cursor persistence failure");
				}
				if (typeof key === "string") values.set(key, value);
				else for (const [name, v] of Object.entries(key)) values.set(name, v);
			},
			delete: async (key: string) => values.delete(key),
			getAlarm: async () => alarm,
			setAlarm: async (value: number) => {
				alarm = value;
			},
		},
	};
	const object = () =>
		new ProjectObject(
			context as never,
			{ ABSO_DISK_FIRST: "on", ABSO_ARTIFACTS: "off", KEY_HMAC_SECRET: "invented-test-secret" } as never,
		);
	t.mock.method(Project, "load", () => {
		throw Error("full history replay forbidden");
	});
	const call = async (op: string, agent: string | undefined, body: unknown, requestId?: string) => {
		for (let page = 0; page < 100; page++) {
			const result = await object().call("project", op, agent, body, false, undefined, undefined, requestId);
			if (result.status !== 503) {
				assert.notEqual(result.status, 500, JSON.stringify({ op, result }));
				return result;
			}
			assert.notEqual(alarm, null);
			await object().alarm();
		}
		throw Error("adoption did not finish");
	};
	const initId = "00000000-0000-4000-8000-000000000008";
	const initBody = { files: { "a.txt": "one\ntwo\n" } };
	failNamePersistence = true;
	await assert.rejects(
		() => object().call("project", "init", undefined, initBody, false, undefined, undefined, initId),
		/name persistence failure/,
	);
	const initializedLog = storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all();
	assert.equal((await call("init", undefined, initBody, initId)).status, 200);
	assert.deepEqual(storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all(), initializedLog);
	assert.equal((await call("sync", "alice", {})).status, 200);
	const requestId = "00000000-0000-4000-8000-000000000007";
	const recordBody = { files: { "a.txt": "changed\n" } };
	failNamePersistence = true;
	await assert.rejects(
		() => object().call("project", "record", "alice", recordBody, false, undefined, undefined, requestId),
		/name persistence failure/,
	);
	const recordedLog = storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all();
	assert.equal(
		(await object().call("project", "record", "alice", recordBody, false, undefined, undefined, requestId)).status,
		200,
	);
	assert.deepEqual(storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all(), recordedLog);
	assert.equal(
		(
			await object().call(
				"project",
				"record",
				"alice",
				{ files: { "a.txt": "different\n" } },
				false,
				undefined,
				undefined,
				requestId,
			)
		).status,
		409,
	);
	const published = await call("publish", "alice", { message: "Disk first" });
	assert.equal(published.status, 200);
	assert.equal((published.body as { ok: boolean }).ok, true);
	const issued = await object().issueAgentKey("alice", "test-address", null, "writer");
	assert.ok("key" in issued);
	const keyCall = { presented: issued.key, address: "test-address", write: true, route: "record" };
	const crossPrincipal = await object().call(
		"project",
		"record",
		"alice",
		recordBody,
		false,
		undefined,
		keyCall,
		requestId,
	);
	assert.equal(crossPrincipal.status, 200, "each checked principal owns its own request ID namespace");
	const principalReceipts = storage.db
		.prepare("SELECT DISTINCT key FROM writer_state WHERE collection = 'runtime:receipts' AND key LIKE ?")
		.all(`http:%:${requestId}`);
	assert.equal(principalReceipts.length, 2);
	const beforeSharedReplay = storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all();
	assert.equal((await call("record", "alice", recordBody, requestId)).status, 200);
	assert.deepEqual(storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all(), beforeSharedReplay);
	const keyRequestId = "00000000-0000-4000-8000-000000000010";
	assert.equal(
		(await object().call("project", "record", "alice", recordBody, false, undefined, keyCall, keyRequestId)).status,
		200,
	);
	await object().revokeAgentKey(issued.id, "test-address");
	const beforeRevokedRetry = storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all();
	const revokedRetry = await object().call(
		"project",
		"record",
		"alice",
		recordBody,
		false,
		undefined,
		keyCall,
		keyRequestId,
	);
	assert.equal(revokedRetry.status, 403);
	assert.deepEqual(storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all(), beforeRevokedRetry);
	const readerId = "00000000-0000-4000-8000-000000000009";
	failNamePersistence = true;
	await assert.rejects(
		() => object().call("project", "reader", "alice", { reader: true }, false, undefined, undefined, readerId),
		/name persistence failure/,
	);
	const nowRefused = await object().call(
		"project",
		"record",
		"alice",
		recordBody,
		false,
		undefined,
		undefined,
		requestId,
	);
	assert.equal(
		(nowRefused.body as { ok: boolean }).ok,
		false,
		"current reader authority overrides an earlier successful receipt",
	);
	assert.equal(
		(await object().call("project", "reader", "alice", { reader: true }, false, undefined, undefined, readerId)).status,
		200,
	);
	assert.equal((await call("reader", "alice", { reader: false })).status, 200);
	const file = await call("file", undefined, { path: "a.txt", version: "1" });
	assert.equal(file.status, 200);
	assert.match(JSON.stringify(file.body), /changed/);
	const feed = await call("feed", undefined, { from: "0", limit: "2" });
	assert.equal(feed.status, 200);
	assert.ok((feed.body as { next: number }).next > 0);
	assert.deepEqual(await object().agents("project"), ["alice"]);
	assert.equal((await object().out()).version, 1);
	assert.deepEqual(await object().news("project", [{ from: "bob", issue: null, text: "Hello", to: ["alice"] }]), [
		{ to: ["alice"] },
	]);
	assert.equal((await call("status", undefined, {})).status, 200);
	for (const agent of ["alice", "bob"]) assert.equal((await call("sync", agent, {})).status, 200);
	assert.equal((await call("record", "alice", { files: { "a.txt": "Alice's change\n" } })).status, 200);
	assert.equal((await call("record", "bob", { files: { "a.txt": "Bob's change\n" } })).status, 200);
	assert.equal((await call("publish", "alice", { message: "Alice wins first" })).status, 200);
	const collision = await call("publish", "bob", { message: "Bob conflicts" });
	assert.equal((collision.body as { ok: boolean }).ok, false);
	assert.equal((collision.body as { collisions: unknown[] }).collisions.length, 1);
	const historical = await call("file", undefined, { path: "a.txt", version: "1" });
	assert.equal(historical.status, 200);
	assert.match(JSON.stringify(historical.body), /changed/);
	const rows = () => ({
		log: storage.db.prepare("SELECT * FROM log ORDER BY seq,part").all(),
		state: storage.db.prepare("SELECT * FROM writer_state ORDER BY namespace,collection,key,part").all(),
	});
	const stable = rows();
	const disabled = new ProjectObject(context as never, { ABSO_DISK_FIRST: "off" } as never);
	const held = await disabled.call("project", "record", "alice", { files: { "a.txt": "legacy write\n" } });
	assert.equal(held.status, 409);
	assert.match(JSON.stringify(held.body), /enable ABSO_DISK_FIRST/);
	assert.equal(await disabled.gitSync(), null);
	assert.deepEqual(rows(), stable);
	assert.equal((await call("status", undefined, {})).status, 200, "re-enabling disk mode preserves the valid root");
	const originalAnnounce = EngineProject.prototype.announce;
	const failingAnnounce = t.mock.method(
		EngineProject.prototype,
		"announce",
		function (this: EngineProject, ...args: Parameters<EngineProject["announce"]>) {
			originalAnnounce.apply(this, args);
			throw Error("injected after announce");
		},
	);
	await assert.rejects(
		() => object().news("project", [{ from: "bob", issue: null, text: "Must roll back", to: ["alice"] }]),
		/injected after announce/,
	);
	assert.deepEqual(rows(), stable);
	failingAnnounce.mock.restore();
	const current = object();
	onReaders = async () => {
		await current.revokeAgentKey("missing-test-key", "127.0.0.1");
	};
	const revoked = await current.call("project", "record", "alice", { files: { "a.txt": "unauthorized\n" } });
	assert.equal(revoked.status, 409);
	assert.equal((revoked.body as { retryable: boolean }).retryable, true);
	assert.deepEqual(rows(), stable);
	const original = EngineProject.prototype.record;
	t.mock.method(
		EngineProject.prototype,
		"record",
		function (this: EngineProject, ...args: Parameters<EngineProject["record"]>) {
			original.apply(this, args);
			throw Error("injected after record");
		},
	);
	await assert.rejects(
		() => object().call("project", "record", "alice", { files: { "a.txt": "failed\n" } }),
		/injected after record/,
	);
	assert.deepEqual(rows(), stable);
	// Exercise the real alarm and commit builder; only remote transport is mocked.
	t.mock.method(git, "listServerRefs", async () => []);
	t.mock.method(git, "clone", async () => {
		throw Error("empty test repository");
	});
	let pushed = 0;
	let failPush = true;
	let remoteFiles: MemoryFS | undefined;
	t.mock.method(git, "push", async (options: Parameters<typeof git.push>[0]) => {
		if (failPush) {
			failPush = false;
			throw Error("injected Artifacts transport failure");
		}
		const oid = await git.resolveRef({ fs: options.fs, dir: options.dir, ref: "main" });
		const commit = await git.readCommit({ fs: options.fs, dir: options.dir, oid });
		assert.match(commit.commit.message, /abso-version: 2/);
		const blob = await git.readBlob({ fs: options.fs, dir: options.dir, oid, filepath: "a.txt" });
		assert.equal(new TextDecoder().decode(blob.blob), "Alice's change\n");
		pushed++;
		// The remote owns its copy; the export's scratch files expire when push returns.
		remoteFiles = new MemoryFS();
		for (const [path, entry] of (options.fs as MemoryFS).entries) {
			remoteFiles.entries.set(
				path,
				entry.kind === "file"
					? { ...entry, data: new Uint8Array((await (options.fs as MemoryFS).readFile(path)) as Uint8Array) }
					: { ...entry },
			);
		}
		return { ok: true };
	});
	const artifacts = {
		get: async () => ({
			info: async () => ({ remote: "https://artifacts.invalid/test" }),
			createToken: async () => ({ plaintext: "invented-test-token" }),
			[Symbol.dispose]() {},
		}),
	};
	const bound = () => new ProjectObject(context as never, { ABSO_DISK_FIRST: "on", ARTIFACTS: artifacts } as never);
	// Deliver the pending alarm: the fake storage must clear it as the host does.
	alarm = null;
	await bound().alarm();
	assert.equal(pushed, 0);
	assert.equal(values.get("pushed"), undefined, "failed transport must not acknowledge a push");
	assert.match(JSON.stringify(values.get("pushError")), /injected Artifacts transport failure/);
	assert.deepEqual(rows(), stable, "failed remote transport leaves canonical state unchanged");
	assert.ok(alarm !== null && alarm > Date.now(), "failed transport schedules a retry");
	await bound().alarm();
	assert.equal(pushed, 1);
	assert.equal(values.get("pushError"), undefined, "cold retry clears the transport error");
	assert.equal((await bound().out()).pushed?.version, 2);
	assert.deepEqual(rows(), stable, "pushing shared does not mutate canonical project state");
	await bound().alarm();
	assert.equal(pushed, 1, "a cold alarm does not push the same version again");
	assert.ok(remoteFiles);
	const remote = remoteFiles;
	const parent = await git.resolveRef({ fs: remote, dir: "/repo", ref: "main" });
	const blob = await git.writeBlob({ fs: remote, dir: "/repo", blob: new TextEncoder().encode("From Git\n") });
	const tree = await git.writeTree({
		fs: remote,
		dir: "/repo",
		tree: [{ mode: "100644", path: "a.txt", oid: blob, type: "blob" }],
	});
	const incoming = await git.commit({
		fs: remote,
		dir: "/repo",
		tree,
		parent: [parent],
		message: "Plain Git edit",
		author: { name: "Git writer", email: "test@example.invalid" },
	});
	await git.writeRef({ fs: remote, dir: "/repo", ref: "main", value: incoming, force: true });
	t.mock.method(git, "listServerRefs", async () => [{ ref: "refs/heads/main", oid: incoming }]);
	t.mock.method(git, "clone", async (options: Parameters<typeof git.clone>[0]) => {
		await cloneFixture(remote, options);
	});
	const beforeIntake = rows();
	const originalRead = GitDiskIntake.prototype.read;
	t.mock.method(GitDiskIntake.prototype, "read", function (this: GitDiskIntake, oid: string) {
		if (oid === blob) throw Error("whole intake text blob forbidden");
		return originalRead.call(this, oid);
	});
	const originalIngest = EngineProject.prototype.ingest;
	const failedIngest = t.mock.method(
		EngineProject.prototype,
		"ingest",
		function (this: EngineProject, ...args: Parameters<EngineProject["ingest"]>) {
			originalIngest.apply(this, args);
			throw Error("injected after Git intake");
		},
	);
	await assert.rejects(() => bound().gitSync(), /injected after Git intake/);
	assertGitScratchEmpty(storage);
	assert.deepEqual(rows(), beforeIntake);
	assert.equal((await bound().out()).git.head, parent, "failed intake must not acknowledge the remote head");
	failedIngest.mock.restore();
	failGitAcknowledgement = true;
	await assert.rejects(() => bound().gitSync(), /Git cursor persistence failure/);
	assertGitScratchEmpty(storage);
	const committedIntake = rows();
	assert.equal((await bound().out()).version, 3);
	assert.equal((await bound().out()).git.head, parent);
	const intake = await bound().gitSync();
	assertGitScratchEmpty(storage);
	assert.deepEqual(rows(), committedIntake, "retry after cursor failure returns the atomic intake receipt");
	assert.ok(intake);
	assert.equal(intake?.head, incoming);
	assert.equal(intake?.commits, 1);
	assert.equal((intake.answer as { landed: boolean }).landed, true, JSON.stringify(intake));
	const imported = await call("file", undefined, { path: "a.txt", version: "3" });
	assert.equal(imported.status, 200);
	assert.match(JSON.stringify(imported.body), /From Git/);
	const afterIntake = rows();
	assert.equal(await bound().gitSync(), null);
	assert.deepEqual(rows(), afterIntake, "cold intake does not apply the same commit twice");
});

for (const disk of [false, true]) {
	test(`Git refusal permits a later fixing commit with disk mode ${disk}`, async (t) => {
		const storage = memoryStorage();
		t.after(() => storage.db.close());
		const values = new Map<string, unknown>();
		const context = {
			id: { toString: () => "refusal" },
			storage: {
				...storage,
				get: async (key: string) => values.get(key),
				put: async (key: string | Record<string, unknown>, value?: unknown) => {
					if (typeof key === "string") values.set(key, value);
					else for (const [k, v] of Object.entries(key)) values.set(k, v);
				},
				getAlarm: async () => null,
				setAlarm: async () => {},
			},
		};
		const artifacts = {
			get: async () => ({
				info: async () => ({ remote: "https://artifacts.invalid/refusal" }),
				createToken: async () => ({ plaintext: "invented-test-token" }),
				[Symbol.dispose]() {},
			}),
		};
		const object = () =>
			new ProjectObject(context as never, { ABSO_DISK_FIRST: disk ? "on" : "off", ARTIFACTS: artifacts } as never);
		const call = async (op: string, body: unknown) => {
			for (let page = 0; page < 100; page++) {
				const result = await object().call("refusal", op, undefined, body);
				if (result.status !== 503) return result;
			}
			throw Error("preparation did not finish");
		};
		assert.equal((await call("init", { files: { "a.txt": "original\n" } })).status, 200);
		assert.equal((await call("status", {})).status, 200);
		const remote = new MemoryFS();
		await git.init({ fs: remote, dir: "/repo", defaultBranch: "main" });
		const commit = async (files: Record<string, string>, message: string, parent: string[]) => {
			const entries = [];
			for (const [path, text] of Object.entries(files))
				entries.push({
					mode: "100644",
					path,
					type: "blob" as const,
					oid: await git.writeBlob({ fs: remote, dir: "/repo", blob: new TextEncoder().encode(text) }),
				});
			const tree = await git.writeTree({ fs: remote, dir: "/repo", tree: entries });
			const oid = await git.commit({
				fs: remote,
				dir: "/repo",
				tree,
				parent,
				message,
				author: { name: "Git writer", email: "test@example.invalid" },
			});
			await git.writeRef({ fs: remote, dir: "/repo", ref: "main", value: oid, force: true });
			return oid;
		};
		const base = await commit({ "a.txt": "original\n" }, "Initial\n\nabso-version: 0", []);
		values.set("git:head", base);
		let head = await commit({ "A.TXT": "clash\n", "a.txt": "original\n" }, "Refused", [base]);
		t.mock.method(git, "listServerRefs", async () => [{ ref: "refs/heads/main", oid: head }]);
		t.mock.method(git, "clone", async (options: Parameters<typeof git.clone>[0]) => {
			await cloneFixture(remote, options);
		});
		const refused = await object().gitSync();
		assert.ok(refused);
		assert.match(JSON.stringify(refused.answer), /one file|clash/i);
		assert.equal(values.get("git:head"), head);
		assert.equal(await object().gitSync(), null);
		head = await commit({ "a.txt": "fixed\n" }, "Fixed", [head]);
		const fixed = await object().gitSync();
		assert.ok(fixed);
		assert.equal((fixed.answer as { landed: boolean }).landed, true, JSON.stringify(fixed));
		assert.equal(values.get("git:head"), head);
		assert.match(
			JSON.stringify((await call("file", { path: "a.txt", version: String((await object().out()).version) })).body),
			/fixed/,
		);
	});
}
