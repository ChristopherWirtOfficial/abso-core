// A pipeline run's key (ABSO_KEY_FILE): read from the file the runner wrote, sent only where a token may go,
// held in memory only, and a run key's refusals reach the job as the server wrote them.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Api, ApiError } from "../src/api.ts";
import { credentialLabel, installKey, readConfig, runKey, tokenFor, writeConfig } from "../src/config.ts";

const KEY = "abso_sk_runkeyabcdefghijklmnopqrstuvwx";
const LOCAL = "http://127.0.0.1:8787";

function keyFile(text: string): string {
	const path = join(mkdtempSync(join(tmpdir(), "abso-run-key-")), "key");
	writeFileSync(path, text);
	return path;
}

function folder(server = LOCAL) {
	const root = mkdtempSync(join(tmpdir(), "abso-run-key-"));
	writeConfig(root, { server, project: "p", agent: "run-7-check-test" });
	return root;
}

const NO_SERVERS = { ABSO_SERVERS_FILE: "no-servers.json" };

test("ABSO_KEY_FILE's key is the credential when no token or folder key is set", () => {
	const env = { ...NO_SERVERS, ABSO_KEY_FILE: keyFile(KEY) };
	assert.equal(runKey(env), KEY);
	assert.equal(tokenFor(LOCAL, env, folder()), KEY);
	assert.deepEqual(credentialLabel(folder(), LOCAL, env), { kind: "pipeline run key", id: null });
	assert.equal(readConfig(folder(), env).token, KEY);
});

test("a trailing newline in the key file is not part of the key", () => {
	assert.equal(runKey({ ABSO_KEY_FILE: keyFile(`${KEY}\n`) }), KEY);
});

test("ABSO_TOKEN and a folder's own key both come before the run key", () => {
	const env = { ...NO_SERVERS, ABSO_KEY_FILE: keyFile(KEY), ABSO_TOKEN: "shared-token-value" };
	assert.equal(tokenFor(LOCAL, env, folder()), "shared-token-value");
	assert.deepEqual(credentialLabel(folder(), LOCAL, env), { kind: "shared token", id: null });
	const root = folder();
	installKey(root, JSON.stringify({ key: "abso_sk_folderkeyabcdefghijklmnopqrstu", id: "k_ab12cd34" }));
	assert.equal(
		tokenFor(LOCAL, { ...NO_SERVERS, ABSO_KEY_FILE: keyFile(KEY) }, root),
		"abso_sk_folderkeyabcdefghijklmnopqrstu",
	);
});

test("the run key goes only where a token may, and the refusal doesn't hold it", () => {
	const env = { ...NO_SERVERS, ABSO_KEY_FILE: keyFile(KEY) };
	assert.throws(
		() => tokenFor("https://someone-else.example", env, folder("https://someone-else.example")),
		(err: Error) => /sends your token only to/.test(err.message) && !err.message.includes(KEY),
	);
});

test("a key file abso can't read, or that holds no key, is named without its contents", () => {
	const missing = join(tmpdir(), "abso-no-such-key-file");
	assert.throws(() => runKey({ ABSO_KEY_FILE: missing }), /can't read/);
	const wrong = keyFile("not-a-key secret-looking-text");
	assert.throws(
		() => runKey({ ABSO_KEY_FILE: wrong }),
		(err: Error) => /doesn't hold an abso key/.test(err.message) && !err.message.includes("secret-looking-text"),
	);
});

test("a run key's refusal reaches the job as the server wrote it, and without the key", async () => {
	let sent = "";
	const server = createServer((req, res) => {
		sent = req.headers.authorization ?? "";
		res.writeHead(403, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "a pipeline run's key can't land" }));
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	try {
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const config = readConfig(folder(url), { ...NO_SERVERS, ABSO_KEY_FILE: keyFile(KEY) });
		await assert.rejects(
			new Api(config).land("try"),
			(err: Error) =>
				err instanceof ApiError &&
				err.status === 403 &&
				/a pipeline run's key can't land/.test(err.message) &&
				!err.message.includes(KEY),
		);
		assert.equal(sent, `Bearer ${KEY}`);
	} finally {
		server.close();
	}
});
