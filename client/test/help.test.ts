// abso help --json: every command help shows, as data, for a command reference built from the client.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandTable, main } from "../src/main.ts";

interface HelpJson {
	ok: boolean;
	command: string;
	version: string;
	intro: string;
	note: string;
	commands: { name: string; usage: string; about: string; flags: Record<string, string> }[];
}

describe("abso help --json", () => {
	it("lists every command help shows, with its usage, about and flags", async () => {
		const out = await main(["help", "--json"], { cwd: process.cwd(), env: {}, write: () => {} });
		assert.equal(out.exit, 0);
		const data = JSON.parse(out.stdout) as HelpJson;
		assert.deepEqual(out.data, data);
		assert.equal(data.ok, true);
		assert.equal(data.command, "help");
		assert.match(data.version, /\S/);
		const names = data.commands.map((c) => c.name);
		assert.deepEqual(names, [...Object.keys(commandTable()), "hook", "mcp", "--version"]);
		const join = data.commands.find((c) => c.name === "join")!;
		assert.equal(join.usage, commandTable().join!.usage);
		assert.equal(join.flags.reader, "boolean");
		assert.equal(join.flags.agent, "string");
		for (const c of data.commands) {
			assert.match(c.usage, /^abso /, c.name);
			assert.ok(c.about.length > 0, c.name);
		}
	});

	it("help without --json says the same, as text", async () => {
		const text = (await main(["help"], { cwd: process.cwd(), env: {}, write: () => {} })).stdout;
		const data = JSON.parse(
			(await main(["--help", "--json"], { cwd: process.cwd(), env: {}, write: () => {} })).stdout,
		) as HelpJson;
		assert.ok(text.startsWith(`${data.intro}\n`));
		assert.ok(text.endsWith(`${data.note}\n`));
		for (const c of data.commands) assert.ok(text.includes(`  ${c.usage}\n      ${c.about}\n`), c.name);
	});
});
