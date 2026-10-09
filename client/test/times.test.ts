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
		"Announcement from ann (as claimed), 08:34 UTC: Split api.ts",
	);
	assert.equal(
		newsWithTime('Announcement from C (a person, signed in on the website, id cf-1): "hi"', at, now),
		'Announcement from C (a person, signed in on the website, id cf-1), 08:34 UTC: "hi"',
	);
	assert.equal(
		newsWithTime('w1 published "x" (version 3), which changes a.txt line 2', at, now),
		'w1 published "x" (version 3), which changes a.txt line 2 (08:34 UTC)',
	);
	assert.equal(newsWithTime("from before times", null, now), "from before times");
});
