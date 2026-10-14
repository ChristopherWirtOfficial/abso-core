import assert from "node:assert/strict";
import { test } from "node:test";
import { View } from "../../../src/engine/view.ts";
import { MemoryStore, Project } from "../project.ts";

test("move reconstruction does not join the intended whole file", (t) => {
	const project = new Project(new MemoryStore());
	project.init({ "a.txt": "header\nmove this line\nfooter\n", "b.txt": "destination\n" }, 0);
	project.sync("writer");
	assert.equal(project.edit("writer", { file: "a.txt", old: "move this line\n", new: "" }, 1).ok, true);
	assert.equal(project.edit("writer", { file: "b.txt", content: "destination\nmove this line\n" }, 1).ok, true);
	const whole = t.mock.method(View.prototype, "text", () => {
		throw Error("whole file join forbidden");
	});
	assert.equal(project.publish("writer", "move", 2).ok, true);
	whole.mock.restore();
	assert.deepEqual(project.files(), { "a.txt": "header\nfooter\n", "b.txt": "destination\nmove this line\n" });
});
