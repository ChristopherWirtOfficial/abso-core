// An npm install of abso says when npm has a later version, asking npm at most
// once a day. The registry here is a stand-in that counts how often it is asked.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { newerClientNote } from "../src/client-version.ts";

const DAY = 24 * 60 * 60 * 1000;
const stamp = globalThis as { __ABSO_PACKAGE_VERSION__?: string };
let registry: Server;
let registryUrl: string;
let latest = "0.67.0";
let asked = 0;
let home: string;

before(async () => {
	registry = createServer((_req, res) => {
		asked++;
		res
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify({ name: "@abso-cli/abso", version: latest }));
	});
	// As fake-server.ts: never close an idle kept-alive connection, or under load the client can reuse one as it closes
	// and fail with ECONNRESET (abso 410).
	registry.keepAliveTimeout = 0;
	await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
	registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/@abso-cli/abso/latest`;
});
after(() => {
	registry.close();
	delete stamp.__ABSO_PACKAGE_VERSION__;
});
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "abso-test-home-"));
	asked = 0;
	latest = "0.67.0";
});

describe("newerClientNote for the npm package", () => {
	it("says so when npm has a later version, and asks npm once a day", async () => {
		stamp.__ABSO_PACKAGE_VERSION__ = "0.66.0";
		const now = 1_000_000_000_000;
		const note = await newerClientNote("http://unused.test", { home, registry: registryUrl, now });
		assert.equal(note, "abso 0.67.0 is out and this is 0.66.0: npm install -g @abso-cli/abso updates it.");
		assert.equal(asked, 1);
		assert.ok(existsSync(join(home, ".abso", "npm-latest.json")));

		latest = "0.68.0";
		const kept = await newerClientNote("http://unused.test", { home, registry: registryUrl, now: now + DAY - 1 });
		assert.match(kept ?? "", /^abso 0\.67\.0 is out/, "within a day the kept answer is used");
		assert.equal(asked, 1);

		const fresh = await newerClientNote("http://unused.test", { home, registry: registryUrl, now: now + DAY });
		assert.match(fresh ?? "", /^abso 0\.68\.0 is out/);
		assert.equal(asked, 2);
		rmSync(home, { recursive: true, force: true });
	});

	it("says nothing when this is npm's latest or later, and compares numbers, not text", async () => {
		stamp.__ABSO_PACKAGE_VERSION__ = "0.67.0";
		assert.equal(await newerClientNote("http://unused.test", { home, registry: registryUrl, now: 1 }), undefined);
		rmSync(home, { recursive: true, force: true });

		home = mkdtempSync(join(tmpdir(), "abso-test-home-"));
		stamp.__ABSO_PACKAGE_VERSION__ = "0.100.0";
		latest = "0.99.0";
		assert.equal(await newerClientNote("http://unused.test", { home, registry: registryUrl, now: 1 }), undefined);
		rmSync(home, { recursive: true, force: true });
	});

	it("says nothing when npm can't be asked, and keeps no answer", async () => {
		stamp.__ABSO_PACKAGE_VERSION__ = "0.66.0";
		const note = await newerClientNote("http://unused.test", { home, registry: "http://127.0.0.1:1/latest", now: 1 });
		assert.equal(note, undefined);
		assert.equal(existsSync(join(home, ".abso", "npm-latest.json")), false);
		rmSync(home, { recursive: true, force: true });
	});

	it("asks npm again when the kept answer isn't JSON, and keeps the new one", async () => {
		stamp.__ABSO_PACKAGE_VERSION__ = "0.66.0";
		const file = join(home, ".abso", "npm-latest.json");
		mkdirSync(join(home, ".abso"), { recursive: true });
		writeFileSync(file, "not json");
		const note = await newerClientNote("http://unused.test", { home, registry: registryUrl, now: 5 });
		assert.match(note ?? "", /^abso 0\.67\.0 is out/);
		assert.equal(asked, 1);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { checked: 5, latest: "0.67.0" });
		rmSync(home, { recursive: true, force: true });
	});
});
