import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonEvents } from "../src/json-events.ts";

test("structural JSON decoding is invariant at every chunk boundary", () => {
	const documents = [
		'{"type":"init","atom":{"lines":["a\\n","\\uD83D\\uDE00"],"seq":0}}',
		"[true,false,null,-0,1.2e-3,{},[]]",
		'"plain"',
	];
	for (const document of documents) {
		const expected = [...jsonEvents([document])];
		for (let split = 0; split <= document.length; split++)
			assert.deepEqual([...jsonEvents([document.slice(0, split), document.slice(split)])], expected);
	}
	for (const invalid of [
		'{"a":1,}',
		"[1,]",
		'{"a" 1}',
		"[01]",
		"[+1]",
		"[.1]",
		"[1e]",
		"[undefined]",
		"true false",
		"[",
		"{",
	])
		assert.throws(() => [...jsonEvents([invalid])], /JSON/);
	assert.throws(() => [...jsonEvents(["[".repeat(130) + "0" + "]".repeat(130)])], /nesting/);
});

test("structural JSON decoding streams large arrays and closes early input", () => {
	let closed = false;
	const source = function* () {
		try {
			yield "[";
			for (let i = 0; i < 100000; i++) yield `${i ? "," : ""}${i}`;
			yield "]";
		} finally {
			closed = true;
		}
	};
	let count = 0;
	for (const event of jsonEvents(source()))
		if (event.kind === "value") {
			assert.equal(event.value, count);
			count++;
		}
	assert.equal(count, 100000);
	assert.equal(closed, true);
	closed = false;
	for (const event of jsonEvents(source())) {
		assert.equal(event.kind, "array");
		break;
	}
	assert.equal(closed, true);
});

function materialize(document: string): unknown {
	const events = jsonEvents(document.split(""));
	const next = () => {
		const event = events.next();
		if (event.done) throw Error("missing event");
		return event.value;
	};
	const value = (event = next()): unknown => {
		if (event.kind === "value") return event.value;
		if (event.kind === "string") {
			let text = "";
			for (;;) {
				const fragment = next();
				if (fragment.kind === "string-end") return text;
				if (fragment.kind !== "text") throw Error("bad string event");
				text += fragment.value;
			}
		}
		if (event.kind === "array") {
			const result: unknown[] = [];
			for (;;) {
				const child = next();
				if (child.kind === "end") return result;
				result.push(value(child));
			}
		}
		if (event.kind === "object") {
			const result: Record<string, unknown> = {};
			for (;;) {
				const key = next();
				if (key.kind === "end") return result;
				if (key.kind !== "key") throw Error("bad key event");
				Object.defineProperty(result, key.value, {
					value: value(),
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
		}
		throw Error("unexpected event");
	};
	const result = value();
	assert.equal(events.next().done, true);
	return result;
}

test("streamed JSON agrees with JSON.parse on generated and adversarial documents", () => {
	let seed = 731;
	const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
	const generate = (depth: number): unknown => {
		const choice = random() % (depth ? 6 : 4);
		if (choice === 0) return null;
		if (choice === 1) return random() % 2 === 0;
		if (choice === 2) return (random() - 0x80000000) / 17;
		if (choice === 3) return `quotes"\\\n${String.fromCharCode(random() % 65536)}\uD83D\uDE00`;
		if (choice === 4) return Array.from({ length: random() % 5 }, () => generate(depth - 1));
		return Object.fromEntries(Array.from({ length: random() % 5 }, (_, i) => [`key${i}`, generate(depth - 1)]));
	};
	for (let i = 0; i < 200; i++) {
		const document = JSON.stringify(generate(4));
		assert.deepEqual(materialize(document), JSON.parse(document));
	}
	for (const document of [
		'{"__proto__":{"polluted":true},"constructor":0,"a":1,"a":2}',
		"[-0,1e999,-1e999,1e-999]",
		'{"\\u0061":"\\uD800\\uDC00"}',
	])
		assert.deepEqual(materialize(document), JSON.parse(document));
});

import { MemoryStore, Project } from "../../worker/project/project.ts";

test("streamed JSON preserves real canonical project entries", () => {
	const memory = new MemoryStore();
	const project = new Project(memory);
	project.init({ "a.txt": "one\ntwo\n" }, 0);
	project.record("alice", { "a.txt": "ONE\ntwo\n" }, 1);
	project.publish("alice", "Publish", 2);
	project.switchTo("alice", "draft", 3);
	project.record("alice", { "a.txt": "ONE\nTWO\n" }, 4);
	project.publish("alice", "Draft publish", 5);
	project.land("alice", "Land", 6);
	for (const entry of memory.entries) {
		const document = JSON.stringify(entry);
		assert.deepEqual(materialize(document), JSON.parse(document));
	}
	assert.ok(memory.entries.length > 5);
});
