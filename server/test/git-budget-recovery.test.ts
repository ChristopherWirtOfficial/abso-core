import assert from "node:assert/strict";
import { test } from "node:test";
import { GitDiskIntake } from "../src/git-disk-intake.ts";
import { GitPackResolver } from "../src/git-pack-resolver.ts";
import { memoryStorage } from "./helpers.ts";

test("cold Git recovery removes abandoned byte budgets without touching canonical data", (t) => {
	const storage = memoryStorage();
	t.after(() => storage.db.close());
	storage.sql.exec("CREATE TABLE canonical_budget_fixture (value TEXT)");
	storage.sql.exec("INSERT INTO canonical_budget_fixture VALUES ('preserved')");
	const abandoned = new GitPackResolver(storage, 100, 100);
	abandoned.add(12, "blob", new TextEncoder().encode("abandoned"));
	assert.equal(storage.db.prepare("SELECT decoded FROM git_object_budget").get()!.decoded, 9);
	GitDiskIntake.recover(storage);
	GitDiskIntake.recover(storage);
	for (const table of [
		"git_pack_spool",
		"git_pack_resolve",
		"git_object_bytes",
		"git_object_meta",
		"git_object_budget",
	])
		assert.equal(storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
	assert.equal(storage.db.prepare("SELECT value FROM canonical_budget_fixture").get()!.value, "preserved");
	const retry = new GitPackResolver(storage, 3, 3);
	retry.add(12, "blob", new TextEncoder().encode("new"));
	assert.equal(storage.db.prepare("SELECT decoded FROM git_object_budget").get()!.decoded, 3);
	retry.dispose();
	assert.equal(storage.db.prepare("SELECT COUNT(*) AS n FROM git_object_budget").get()!.n, 0);
});
