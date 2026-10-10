// Times as abso shows them (abso issue 124): short, and the same everywhere.

import assert from "node:assert/strict";
import { test } from "node:test";
import { newsWithTime, seenText, shortWhen } from "../src/times.ts";

const now = Date.parse("2026-10-08T08:45:00Z");

test("today's times are the hour and minute; earlier ones carry the date, and another year's the year", () => {
	assert.equal(shortWhen(Date.parse("2026-10-08T08:34:59Z"), now), "08:34 UTC");
	assert.equal(shortWhen(Date.parse("2026-10-07T21:10:00Z"), now), "Oct 7 21:10 UTC");
	assert.equal(shortWhen(Date.parse("2025-12-31T23:59:00Z"), now), "Dec 31 2025 23:59 UTC");
});

test("seen says when, or new", () => {
	assert.equal(seenText(null, now), "new");
	assert.equal(seenText(Date.parse("2026-10-08T08:40:00Z"), now), "seen 08:40 UTC");
});

test("news carries its time after the who", () => {
	const at = Date.parse("2026-10-08T08:34:00Z");
	assert.equal(
		newsWithTime("Announcement from ann (as claimed): Split api.ts", at, now),
		"ann (as claimed) told you, 08:34 UTC:\nSplit api.ts",
	);
	assert.equal(
		newsWithTime('Announcement from C (a person, signed in on the website, id cf-1): "hi"', at, now),
		"C (a person) told you, 08:34 UTC:\nhi",
	);
	assert.equal(
		newsWithTime("Announcement from ann (as claimed): Split api.ts", null, now),
		"ann (as claimed) told you:\nSplit api.ts",
	);
	assert.equal(
		newsWithTime('w1 pushed "x" (version 3), which changes a.txt line 2', at, now),
		'w1 pushed "x" (version 3), which changes a.txt line 2 (08:34 UTC)',
	);
	assert.equal(newsWithTime("from before times", null, now), "from before times");
});

test("a tell is shown as who told you and how sure that is, with what was said below", () => {
	const shown = (text: string) => newsWithTime(text, null, now);
	assert.equal(shown("Announcement from ann (key k_0123abcd): Go"), "ann (checked) told you:\nGo");
	assert.equal(shown("Announcement from ann (key k_0123abcd, box b7): Go"), "ann (checked, box b7) told you:\nGo");
	assert.equal(shown("Announcement from ann (shared token): Go"), "ann (as claimed) told you:\nGo");
	// A person's words are unquoted, line breaks and all; their id is left out.
	const person = shown(
		`Announcement from Robin Ash (a person, signed in on the website, id cf-9): ${JSON.stringify('Two\nlines "here"')}`,
	);
	assert.equal(person, 'Robin Ash (a person) told you:\nTwo\nlines "here"');
	// Anything else that starts the same way is other news, shown as it is.
	assert.equal(shown("Announcement from ann (made up): Go"), "Announcement from ann (made up): Go");
});
