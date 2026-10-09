// errorSentence: what an error answer says, from JSON or from the host's HTML error page.

import assert from "node:assert/strict";
import { test } from "node:test";
import { errorSentence } from "../src/api-error.ts";

test("a JSON answer gives its error, else its reason", () => {
	assert.equal(errorSentence('{"error":"no such draft"}'), "no such draft");
	assert.equal(errorSentence('{"reason":"paused"}'), "paused");
	assert.equal(errorSentence("plain words"), "plain words");
});

test("an HTML error page is said by its title and Ray ID, not its first lines", () => {
	const page = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<head>
<title>Worker threw exception | example.workers.dev | Cloudflare</title>
</head>
<body>${"<div></div>\n".repeat(50)}
<span>Cloudflare Ray ID: <strong class="font-semibold">8c1f2e3d4a5b6c7d</strong></span>
</body></html>`;
	assert.equal(
		errorSentence(page),
		'an HTML error page titled "Worker threw exception | example.workers.dev | Cloudflare" (Ray ID 8c1f2e3d4a5b6c7d), not the server\'s own answer: the server failed before it could say why',
	);
	assert.equal(
		errorSentence("<html><body>oops</body></html>"),
		"an HTML error page, not the server's own answer: the server failed before it could say why",
	);
});
