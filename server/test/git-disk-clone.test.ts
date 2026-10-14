import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import git, { type HttpClient } from "isomorphic-git";
import { GitDiskIntake } from "../src/git-disk-intake.ts";
import { GitFileContents } from "../src/git-file-contents.ts";
import { GitIntakeTrees } from "../src/git-intake-trees.ts";
import { pushedSince } from "../src/ingest.ts";
import { MemoryFS } from "../src/memory-fs.ts";
import { commitShared } from "../src/push.ts";
import { memoryStorage } from "./helpers.ts";

const packet = (text: string | Uint8Array) => {
	const body = Buffer.from(text);
	return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
};

for (const mode of ["success", "limit", "fatal", "server-intake", "text-intake", "binary-limit"])
	test(`actual disk clone handles ${mode}`, async (t) => {
		const rejectPack = mode === "limit";
		const source = new MemoryFS(),
			dir = "/repo";
		await git.init({ fs: source, dir, defaultBranch: "main" });
		const blob = mode === "text-intake" ? Buffer.from("x".repeat(16383) + "🚀é中".repeat(20000)) : randomBytes(400000);
		if (mode === "binary-limit") blob[0] = 255;
		const blobOid = await git.writeBlob({ fs: source, dir, blob });
		const tree = await git.writeTree({
			fs: source,
			dir,
			tree: [{ mode: "100644", path: "large.bin", oid: blobOid, type: "blob" }],
		});
		const author = {
			name: "Capacity fixture",
			email: "fixture@example.invalid",
			timestamp: 1,
			timezoneOffset: 0,
		};
		const base = await git.writeCommit({
			fs: source,
			dir,
			commit: {
				tree,
				parent: [],
				author,
				committer: author,
				message: "Base\n\nabso-version: 0\n",
			},
		});
		const head = await git.writeCommit({
			fs: source,
			dir,
			commit: {
				tree,
				parent: [base],
				author,
				committer: author,
				message: "Fixture\n",
			},
		});
		const packed = (
			await git.packObjects({
				fs: source,
				dir,
				oids: [head, base, tree, blobOid],
				write: false,
			})
		).packfile!;
		const advertisement = Buffer.concat([
			packet("# service=git-upload-pack\n"),
			Buffer.from("0000"),
			packet(`${head} HEAD\0symref=HEAD:refs/heads/main side-band-64k shallow\n`),
			packet(`${head} refs/heads/main\n`),
			Buffer.from("0000"),
		]);
		let uploads = 0;
		let uploadChunksRead = 0;
		let uploadClosed = false;
		const uploadParts = [packet("NAK\n")];
		for (let at = 0; at < packed.length; at += 16000) {
			uploadParts.push(packet(Buffer.concat([Buffer.from([1]), packed.subarray(at, at + 16000)])));
			uploadParts.push(
				packet(Buffer.concat([Buffer.from([2]), Buffer.from("Counting objects: 50% (1/2)\n".repeat(200))])),
			);
			if (mode === "fatal" && at === 16000) {
				uploadParts.push(packet(Buffer.concat([Buffer.from([3]), Buffer.from("fixture remote failure")])));
				break;
			}
		}
		uploadParts.push(Buffer.from("0000"));
		const http: HttpClient = {
			request: async ({ url, method }) => {
				const body = method === "POST" ? Buffer.concat(uploadParts) : advertisement;
				if (method === "POST") uploads++;
				return {
					url,
					method: method ?? "GET",
					statusCode: 200,
					statusMessage: "OK",
					headers: {},
					body: (async function* () {
						try {
							for (let at = 0; at < body.length; at += 997) {
								if (method === "POST") uploadChunksRead++;
								yield body.subarray(at, at + 997);
							}
						} finally {
							if (method === "POST") uploadClosed = true;
						}
					})(),
				};
			},
		};
		const storage = memoryStorage();
		const intake = new GitDiskIntake(storage, rejectPack ? 70000 : 2000000, 1000000);
		const ingest = intake.ingest.bind(intake);
		intake.ingest = async (...args) => {
			await new Promise((resolve) => setTimeout(resolve, 25));
			assert.ok(uploadChunksRead < 64, `pack source read ahead ${uploadChunksRead} chunks before disk consumption`);
			return ingest(...args);
		};
		const cache = {};
		intake.attach(cache);
		const contents = new GitFileContents(storage, 1000000, 2000000);
		const fs = new MemoryFS(contents);
		const write = fs.promises.writeFile;
		fs.promises.writeFile = async (path, ...args) => {
			assert.ok(!/\.(pack|idx)$/.test(path), "clone must not persist a collected pack or index");
			return write(path, ...args);
		};
		try {
			if (mode === "server-intake" || mode === "text-intake" || mode === "binary-limit") {
				const trees = new GitIntakeTrees(storage);
				if (mode === "text-intake" || mode === "binary-limit") {
					const original = GitDiskIntake.prototype.read;
					t.mock.method(GitDiskIntake.prototype, "read", function (this: GitDiskIntake, oid: string) {
						if (oid === blobOid) throw Error("whole blob read forbidden");
						return original.call(this, oid);
					});
				}
				const artifacts = {
					get: async () => ({
						info: async () => ({ remote: "https://fixture.invalid/repo" }),
						createToken: async () => ({ plaintext: "invented-test-token" }),
						[Symbol.dispose]() {},
					}),
				};
				const found = await pushedSince(
					artifacts as never,
					"fixture",
					undefined,
					async (bytes) => {
						assert.notEqual(mode, "binary-limit", "oversized binary must not reach the store");
						assert.deepEqual(Buffer.from(bytes), blob);
						return "fixture-blob";
					},
					mode === "binary-limit" ? () => "previous-blob" : undefined,
					undefined,
					{
						storage,
						maxPackBytes: 2000000,
						maxObjectBytes: 1000000,
						maxBinaryBytes: mode === "binary-limit" ? 100000 : undefined,
						http,
						retainFileChunks: (files, path, chunks, oid) => trees.retainChunks(files, path, chunks, oid),
					},
				);
				assert.equal(found!.base, 0);
				assert.equal(found!.commits.length, 1);
				if (mode === "text-intake") assert.equal(found!.commits[0]!.files["large.bin"], blob.toString("utf8"));
				else if (mode === "binary-limit") {
					assert.equal(found!.commits[0]!.blobs["large.bin"], "previous-blob");
					assert.deepEqual(found!.tooBig, ["large.bin"]);
				} else assert.equal(found!.commits[0]!.blobs["large.bin"], "fixture-blob");
				trees.dispose();
				for (const table of ["git_pack_spool", "git_pack_resolve", "git_object_meta", "git_object_bytes"])
					assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
				return;
			}
			const clone = git.clone({
				fs,
				dir,
				http,
				cache,
				url: "https://fixture.invalid/repo",
				ref: "main",
				singleBranch: true,
				noCheckout: true,
			});
			if (mode !== "success") {
				await assert.rejects(clone, rejectPack ? /pack exceeds byte limit/ : /fixture remote failure/);
				assert.equal(uploadClosed, true);
				for (const table of ["git_pack_spool", "git_pack_resolve", "git_object_meta", "git_object_bytes"])
					assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
				return;
			}
			await clone;
			intake.assertReady();
			assert.equal((await git.log({ fs, dir, cache, ref: "main" })).length, 2);
			let walked = 0;
			await git.walk({
				fs,
				dir,
				cache,
				trees: [git.TREE({ ref: head })],
				map: async (path, [entry]) => {
					if (path === "large.bin") {
						assert.deepEqual(Buffer.from((await entry!.content())!), blob);
						walked++;
					}
					return true;
				},
			});
			assert.equal(walked, 1);
			assert.equal(uploads, 1);
			assert.equal(await git.resolveRef({ fs, dir, ref: "main" }), head);
			assert.equal((await git.readCommit({ fs, dir, cache, oid: head })).commit.tree, tree);
			assert.deepEqual(Buffer.from((await git.readBlob({ fs, dir, cache, oid: blobOid })).blob), blob);
			const exported = await commitShared(
				fs,
				dir,
				head,
				{
					version: 1,
					files: { "new.txt": "Disk export fixture" },
					blobs: { "large.bin": "fixture-blob" },
				},
				() => blob,
				undefined,
				cache,
			);
			const next = await git.readCommit({ fs, dir, cache, oid: exported.commit });
			assert.deepEqual(next.commit.parent, [head]);
			assert.deepEqual(
				Buffer.from((await git.readBlob({ fs, dir, cache, oid: exported.commit, filepath: "large.bin" })).blob),
				blob,
			);
			assert.equal(
				Buffer.from(
					(await git.readBlob({ fs, dir, cache, oid: exported.commit, filepath: "new.txt" })).blob,
				).toString(),
				"Disk export fixture",
			);
			for (const entry of fs.entries.values()) if (entry.kind === "file") assert.equal(entry.data.byteLength, 0);
		} finally {
			contents.dispose();
			intake.dispose();
			storage.db.close();
		}
	});
