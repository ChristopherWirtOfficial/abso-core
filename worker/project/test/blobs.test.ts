// Binary files (#27): a file with no lines and a `blob` attribute, the
// SHA-256 of its bytes, which live outside the graph (R2). They travel
// through record, publish, sync, restore and plain-git intake, and collide
// only when two drafts set the same file's blob.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore, Project, ProjectError } from "../project.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function setup(held: Set<string> = new Set([A, B, C])) {
	const store = new MemoryStore();
	const project = new Project(store, { hasBlob: (sha) => held.has(sha) });
	project.init({ "README.md": "hi\n" }, 0, {}, { "logo.png": A });
	project.sync("ann");
	project.sync("bob");
	return { project, store };
}

test("init and a first pull carry binary files as blobs, not text", () => {
	const store = new MemoryStore();
	const project = new Project(store, { hasBlob: () => true });
	project.init({ "README.md": "hi\n" }, 0, {}, { "logo.png": A });
	const s = project.sync("cat");
	assert.deepEqual(s.files, { "README.md": "hi\n" });
	assert.deepEqual((s as { blobs?: unknown }).blobs, { "logo.png": A });
	assert.deepEqual(project.files(), { "README.md": "hi\n" });
	assert.deepEqual(project.blobs(), { "logo.png": A });
});

test("a blob changed, pushed and pulled; a file turning binary and back", () => {
	const { project } = setup();
	project.record("ann", {}, 1, {}, { "logo.png": B, "README.md": C });
	assert.equal(project.publish("ann", "New logo; readme is binary now", 2).ok, true);
	const b = project.sync("bob") as { files: unknown; blobs?: unknown };
	assert.deepEqual(b.files, {});
	assert.deepEqual(b.blobs, { "README.md": C, "logo.png": B });
	project.record("bob", { "README.md": "text again\n" }, 3);
	assert.equal(project.publish("bob", "Readme is text", 4).ok, true);
	const a = project.sync("ann") as { files: unknown; blobs?: unknown };
	assert.deepEqual(a.files, { "README.md": "text again\n" });
	assert.deepEqual(a.blobs, { "README.md": null });
	assert.deepEqual(project.blobs(), { "logo.png": B });
	assert.equal(project.show(1).diff.find((f) => f.path === "logo.png")?.blob?.after, B);
});

test("two drafts changing the same binary file collide; different files do not", () => {
	const { project } = setup();
	project.record("ann", {}, 1, {}, { "logo.png": B });
	project.record("bob", {}, 1, {}, { "logo.png": C });
	project.publish("ann", "Blue logo", 2);
	const refused = project.publish("bob", "Red logo", 3);
	assert.equal(refused.ok, false);
	const c = !refused.ok ? refused.collisions[0]! : undefined;
	assert.deepEqual(c && [c.kind, c.name, c.file, c.yours.text, c.theirs.text], ["attribute", "blob", "logo.png", C, B]);
	project.sync("bob");
	project.record("bob", {}, 4, {}, { "icon.png": C });
	assert.equal(project.publish("bob", "Red logo after all", 5).ok, true);
});

test("a blob must be uploaded first, be a SHA-256, and not also be text", () => {
	const { project } = setup(new Set([A]));
	const code = (f: () => unknown) => {
		try {
			f();
		} catch (e) {
			return e instanceof ProjectError ? e.message : String(e);
		}
		return "no error";
	};
	assert.match(
		code(() => project.record("ann", {}, 1, {}, { "x.png": B })),
		/upload blob b{64} first/,
	);
	assert.match(
		code(() => project.record("ann", {}, 1, {}, { "x.png": "nope" })),
		/SHA-256/,
	);
	assert.match(
		code(() => project.record("ann", { "x.png": "x" }, 1, {}, { "x.png": A })),
		/both text and a blob/,
	);
});

test("restore puts the blob back; plain-git intake takes blobs; a log with blobs loads", () => {
	const { project, store } = setup();
	project.record("ann", {}, 1, {}, { "logo.png": B });
	const r = project.restore("ann", ["logo.png"], 2) as { files: unknown; blobs?: unknown };
	assert.deepEqual(r.files, {});
	assert.deepEqual(r.blobs, { "logo.png": A });

	const answer = project.ingest(
		{
			author: "pat",
			base: 0,
			commits: [
				{ sha: "abcdef12", message: "pics", files: { "README.md": "hi\n" }, blobs: { "logo.png": A, "pic.jpg": C } },
			],
		},
		3,
	);
	assert.equal(answer.landed, true);
	assert.deepEqual(project.blobs(), { "logo.png": A, "pic.jpg": C });
	assert.deepEqual(Project.load(store.entries, new MemoryStore()).blobs(), project.blobs());
	// Without a blob store, binary files are refused.
	assert.throws(() => new Project(new MemoryStore()).init({}, 0, {}, { "logo.png": A }), /upload blob/);
});
