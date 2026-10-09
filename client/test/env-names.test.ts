import assert from "node:assert/strict";
import { test } from "node:test";
import { readToken, trustedServers } from "../src/config.ts";
import { fromEnv, withOldNames } from "../src/env-names.ts";

test("ABSO_ names win over AVCS_ ones, and the old ones still work", () => {
	assert.equal(fromEnv({ ABSO_X: "new", AVCS_X: "old" }, "X"), "new");
	assert.equal(fromEnv({ AVCS_X: "old" }, "X"), "old");
	assert.equal(fromEnv({ ABSO_X: "", AVCS_X: "old" }, "X"), "old");
	assert.equal(fromEnv({}, "X"), undefined);
	assert.equal(readToken({ ABSO_TOKEN: " new ", AVCS_TOKEN: "old" }), "new");
	assert.equal(readToken({ AVCS_TOKEN: "old" }), "old");
	assert.match(
		trustedServers({ ABSO_TRUSTED_SERVERS: "https://a.example", ABSO_SERVERS_FILE: "no-servers.json" }),
		/a\.example/,
	);
});

test("a program abso runs gets both the new and the old names", () => {
	const out = withOldNames({ ABSO_AGENT: "a", ABSO_SPACE: "shared", OTHER: "x" });
	assert.equal(out.AVCS_AGENT, "a");
	assert.equal(out.AVCS_SPACE, "shared");
	assert.equal(out.ABSO_AGENT, "a");
	assert.equal(out.AVCS_OTHER, undefined);
});
