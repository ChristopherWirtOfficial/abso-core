// Imported history (abso issue 23): a version whose history was imported names
// its original author, the way git names a commit's author beside its
// committer. Every other version names the agent who published it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { byWhom } from "../src/history-answers.ts";

test("a version names its original author when it has one, else its agent", () => {
	assert.equal(
		byWhom({ agent: "replay-a1", author: "Ada Lovelace <ada@example.com>" }),
		"Ada Lovelace <ada@example.com>",
	);
	assert.equal(byWhom({ agent: "ann" }), "ann");
});
