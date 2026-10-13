import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { Project } from "../../worker/project/project.ts";
import { EngineProject } from "../src/engine-project.ts";
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
	const call = async (op: string, agent: string | undefined, body: unknown) => {
		for (let page = 0; page < 100; page++) {
			const result = await object().call("project", op, agent, body);
			if (result.status !== 503) {
				assert.notEqual(result.status, 500, JSON.stringify({ op, result }));
				return result;
			}
			assert.notEqual(alarm, null);
			await object().alarm();
		}
		throw Error("adoption did not finish");
	};
	assert.equal((await call("init", undefined, { files: { "a.txt": "one\ntwo\n" } })).status, 200);
	assert.equal((await call("sync", "alice", {})).status, 200);
	assert.equal((await call("record", "alice", { files: { "a.txt": "changed\n" } })).status, 200);
	const published = await call("publish", "alice", { message: "Disk first" });
	assert.equal(published.status, 200);
	assert.equal((published.body as { ok: boolean }).ok, true);
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
});
