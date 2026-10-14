import assert from "node:assert/strict";
import { test } from "node:test";
import { Api } from "../src/api.ts";

test("a logical JSON write retains its UUID across connection retry and later writes get new IDs", async (t) => {
	const api = new Api({ server: "https://example.invalid", project: "test", agent: "alice" } as never);
	const ids: (string | null)[] = [];
	t.mock.method(api, "send", async (_url: string, init: RequestInit) => {
		ids.push(new Headers(init.headers).get("Idempotency-Key"));
		if (ids.length === 1) throw Object.assign(Error("not connected"), { cause: { code: "ECONNREFUSED" } });
		return Response.json({ ok: true });
	});
	await api.json("POST", "/a/alice/record", { files: {} });
	await api.json("POST", "/a/alice/record", { files: {} });
	await api.json("GET", "/status");
	assert.match(ids[0]!, /^[0-9a-f-]{36}$/);
	assert.equal(ids[1], ids[0]);
	assert.notEqual(ids[2], ids[0]);
	assert.equal(ids[3], null);
});
