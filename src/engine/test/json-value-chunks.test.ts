import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { equalJsonValues, jsonValueChunks } from "../json-value-chunks.ts";

test("canonical JSON chunks preserve scalar, container and toJSON encoding", () => {
	const values = [
		null,
		true,
		false,
		0,
		-0,
		1.25,
		NaN,
		Infinity,
		{ z: undefined, a: [undefined, null, 'quoted"\n\t\\', "\ud800", "\udc00", "\u2028\u2029"] },
		new Array(3),
		{ 20: "twenty", 2: "two", before: 1, after: 2 },
		{
			nested: {
				toJSON(key: string) {
					return { key, value: "converted" };
				},
			},
		},
		JSON.parse('{"__proto__":"data","constructor":"also data"}'),
	];
	for (const value of values) assert.equal([...jsonValueChunks(value)].join(""), JSON.stringify(value));
	for (const left of values)
		for (const right of values)
			assert.equal(equalJsonValues(left, right), JSON.stringify(left) === JSON.stringify(right));
});

test("canonical JSON string chunks preserve every surrogate split and bound escaped output", () => {
	for (const offset of [16382, 16383, 16384, 16385]) {
		const value = { text: `${"a".repeat(offset)}\ud83d\ude80${"\u0000".repeat(40000)}\ud800` };
		const hash = createHash("sha256");
		for (const chunk of jsonValueChunks(value)) {
			assert.ok(chunk.length <= 16384 * 6);
			hash.update(chunk);
		}
		assert.equal(hash.digest("hex"), createHash("sha256").update(JSON.stringify(value)).digest("hex"));
	}
});

test("canonical JSON visits large arrays incrementally and rejects cycles", () => {
	let reads = 0;
	const values = new Proxy(new Array(10000), {
		get(target, key, receiver) {
			if (typeof key === "string" && /^[0-9]+$/.test(key)) {
				reads++;
				return Number(key);
			}
			return Reflect.get(target, key, receiver);
		},
	});
	const chunks = jsonValueChunks(values);
	assert.equal(chunks.next().value, "[");
	assert.equal(reads, 0);
	assert.equal(chunks.next().value, "0");
	assert.equal(reads, 1);
	chunks.return?.();
	const cyclic: unknown[] = [];
	cyclic.push(cyclic);
	assert.throws(() => [...jsonValueChunks(cyclic)], /cyclic/);
});
