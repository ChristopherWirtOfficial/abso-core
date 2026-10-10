// A comment too long for the Issues Worker goes up in parts (abso issue 394): each fits, each says which part it
// is, and none ends inside a code block it doesn't close.

import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMENT_MAX, commentParts } from "../src/issues.ts";

const paragraph = (n: number) => `Paragraph ${n}. ${"words go here ".repeat(40).trim()}`;

test("a comment that fits goes up as it is, with no part marks", () => {
	const text = "x".repeat(COMMENT_MAX);
	assert.deepEqual(commentParts(text), [text]);
});

test("a longer one is cut at paragraph breaks, each part fits and says which it is, and nothing is lost", () => {
	const text = Array.from({ length: 20 }, (_, i) => paragraph(i + 1)).join("\n\n");
	const parts = commentParts(text);
	assert.ok(parts.length >= 2);
	for (const [i, p] of parts.entries()) {
		assert.ok(p.length <= COMMENT_MAX, `part ${i + 1} has ${p.length}`);
		assert.ok(p.startsWith(`(${i + 1}/${parts.length})\n\n`));
		// Each part after its mark starts a paragraph.
		assert.match(p.split("\n\n")[1]!, /^Paragraph \d+\./);
	}
	const rejoined = parts.map((p) => p.replace(/^\(\d+\/\d+\)\n\n/, "")).join("\n\n");
	assert.equal(rejoined, text);
});

test("text with no breaks is cut at spaces, and text with no spaces at the limit", () => {
	for (const text of ["word ".repeat(2000).trim(), "y".repeat(9000)]) {
		const parts = commentParts(text);
		for (const p of parts) assert.ok(p.length <= COMMENT_MAX);
		const body = parts.map((p) => p.replace(/^\(\d+\/\d+\)\n\n/, ""));
		assert.equal(body.join(text.includes(" ") ? " " : ""), text);
	}
});

test("a part that would end inside a code block closes it, and the next part opens it again", () => {
	const code = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join("\n");
	const text = `Before.\n\n\`\`\`ts\n${code}\n\`\`\`\n\nAfter.`;
	const parts = commentParts(text);
	assert.ok(parts.length >= 2);
	for (const p of parts) {
		assert.ok(p.length <= COMMENT_MAX);
		const fences = p.split("\n").filter((l) => l.startsWith("```")).length;
		assert.equal(fences % 2, 0, `a part leaves a code block open:\n${p.slice(-80)}`);
	}
	assert.match(parts[1]!, /^\(2\/\d+\)\n\n```ts\n/);
});

test("a character outside the Basic Multilingual Plane is never split in two", () => {
	const text = "😀".repeat(3000);
	for (const p of commentParts(text)) {
		assert.ok(p.length <= COMMENT_MAX);
		assert.doesNotMatch(p, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
	}
});
