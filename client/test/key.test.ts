import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialLabel, installKey, tokenFor, writeConfig } from "../src/config.ts";

function folder() {
	const root = mkdtempSync(join(tmpdir(), "abso-key-"));
	writeConfig(root, { server: "https://staging.abso.example", project: "p", agent: "a" });
	return root;
}

const KEY = "abso_sk_abcdefghijklmnopqrstuvwxyz012345";
const ID = "k_ab12cd34";

test("a key in the folder is sent instead of AVCS_TOKEN, and only to its server", () => {
	const root = folder();
	installKey(root, JSON.stringify({ key: KEY, id: ID }));
	const env = { AVCS_TOKEN: "shared-token-value" };
	assert.equal(tokenFor("https://staging.abso.example", env, root), KEY);
	assert.throws(() => tokenFor("https://abso.example", env, root), /different server/);
	const label = credentialLabel(root, "https://staging.abso.example", env);
	assert.deepEqual(label, { kind: "agent key", id: ID });
	assert.equal(JSON.stringify(label).includes(KEY), false);
});

test("with no key, the shared token is unchanged", () => {
	const root = folder();
	const env = {
		AVCS_TOKEN: "shared-token-value",
		AVCS_TRUSTED_SERVERS: "https://abso.example",
		AVCS_SERVERS_FILE: "no-servers.json",
	};
	assert.equal(tokenFor("https://abso.example", env, root), "shared-token-value");
	assert.deepEqual(credentialLabel(root, "https://abso.example", env), { kind: "shared token", id: null });
});

test("install writes .abso/key and does not leave the key in the returned value", () => {
	const root = folder();
	const installed = installKey(root, JSON.stringify({ key: KEY, id: ID }));
	assert.deepEqual(installed, { id: ID });
	const stored = readFileSync(join(root, ".abso", "key"), "utf8");
	assert.equal(stored.includes(KEY), true);
	assert.equal(JSON.stringify(installed).includes(KEY), false);
	writeFileSync(join(root, ".abso", "key"), stored);
});

test("a key installed with --server before join is the one join's folder sends", () => {
	const root = mkdtempSync(join(tmpdir(), "abso-key-"));
	const staging = "https://staging.abso.example";
	assert.throws(() => installKey(root, JSON.stringify({ key: KEY, id: ID })), /--server/);
	installKey(root, JSON.stringify({ key: KEY, id: ID }), staging);
	writeConfig(root, { server: staging, project: "p", agent: "a" });
	assert.equal(tokenFor(staging, {}, root), KEY);
	assert.throws(
		() => installKey(root, JSON.stringify({ key: KEY, id: ID }), "https://abso.example"),
		/not https:\/\/abso.example/,
	);
});
