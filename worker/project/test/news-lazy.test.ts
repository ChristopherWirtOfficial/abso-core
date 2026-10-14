import assert from "node:assert/strict";
import { test } from "node:test";
import { type NewsHost, newsForOthers } from "../news.ts";
import type { AgentState } from "../project-types.ts";
import type { Space } from "../spaces.ts";

test("news skips historical views when no other agent has a draft in the space", () => {
	const publisher = { name: "alice", space: "" } as AgentState;
	const idle = { name: "bob", space: "" } as AgentState;
	const elsewhere = { name: "carol", space: "branch" } as AgentState;
	const space = { name: "", versions: [{ atoms: [] }] } as unknown as Space;
	let draftReads = 0;
	const host = new Proxy(
		{
			agents: new Map([
				["alice", publisher],
				["bob", idle],
				["carol", elsewhere],
			]),
			draft: (agent: AgentState) => {
				assert.equal(agent, idle);
				draftReads++;
				return [];
			},
		},
		{
			get(target, key) {
				if (key in target) return Reflect.get(target, key);
				throw Error(`Unexpected news work: ${String(key)}`);
			},
		},
	) as unknown as NewsHost;
	newsForOthers(host, publisher, space, 0, []);
	assert.equal(draftReads, 1);
});
