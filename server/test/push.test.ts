import assert from "node:assert/strict";
import { describe, it } from "node:test";
import git from "isomorphic-git";
import { absoVersion } from "../src/ingest.ts";
import { MemoryFS } from "../src/memory-fs.ts";
import { commitShared, projectOfRepo, readTreeFiles, repoName } from "../src/push.ts";

describe("repo names", () => {
	it("names a project's Artifacts repo abso-<project>, and back", () => {
		assert.equal(repoName("game"), "abso-game");
		assert.equal(repoName("my.site_2"), "abso-my.site_2");
		assert.equal(projectOfRepo("abso-game"), "game");
		assert.equal(projectOfRepo("avcs-game"), null);
		assert.equal(projectOfRepo("abso-"), null);
	});

	it("reads the version a pushed commit carries, under either name", () => {
		assert.equal(absoVersion("Fix it\n\nabso-version: 12\n"), 12);
		assert.equal(absoVersion("Fix it\n\navcs-version: 7\n"), 7);
		assert.equal(absoVersion("a person's own commit"), undefined);
	});
});

describe("commitShared", () => {
	it("writes shared as a commit with its modes, then only what changed", async () => {
		const fs = new MemoryFS();
		const dir = "/repo";
		await git.init({ fs, dir, defaultBranch: "main" });
		const noBlobs = () => null;
		const first = await commitShared(
			fs,
			dir,
			null,
			{
				version: 0,
				files: { "a.txt": "one\n", "run.sh": "echo hi\n", link: "" },
				modes: { "run.sh": { exec: true }, link: { link: "a.txt" } },
			},
			noBlobs,
		);
		assert.equal(first.changed, 3);
		const commit = (await git.readCommit({ fs, dir, oid: first.commit })).commit;
		assert.match(commit.message, /^Start the project\n\nabso-version: 0\n$/);
		const { files } = await readTreeFiles(fs, dir, commit.tree);
		assert.deepEqual(Object.fromEntries([...files].map(([p, f]) => [p, f.mode])), {
			"a.txt": "100644",
			link: "120000",
			"run.sh": "100755",
		});
		const second = await commitShared(
			fs,
			dir,
			first.commit,
			{
				version: 1,
				files: { "a.txt": "one\ntwo\n", "run.sh": "echo hi\n", link: "" },
				modes: { "run.sh": { exec: true }, link: { link: "a.txt" } },
				last: { agent: "alice", message: "Add two" },
			},
			noBlobs,
		);
		assert.equal(second.changed, 1);
		const next = (await git.readCommit({ fs, dir, oid: second.commit })).commit;
		assert.equal(next.author.name, "alice");
		assert.deepEqual(next.parent, [first.commit]);
		assert.equal(absoVersion(next.message), 1);
	});
});
