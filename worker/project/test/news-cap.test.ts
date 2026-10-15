// An agent's unheard news is capped (abso Capacity): stopped agents kept every line, 7 MB of prod project abso.

import assert from "node:assert/strict";
import { test } from "node:test";
import { capNews, droppedNewsLine, NEWS_KEPT, NEWS_TRIM } from "../news.ts";

const agentWith = (n: number) => ({
	news: Array.from({ length: n }, (_, i) => `news ${i}`),
	newsAt: Array.from({ length: n }, (_, i) => i),
});

test("news up to NEWS_KEPT plus NEWS_TRIM lines is kept as it is", () => {
	const agent = agentWith(NEWS_KEPT + NEWS_TRIM);
	capNews(agent);
	assert.equal(agent.news.length, NEWS_KEPT + NEWS_TRIM);
	assert.equal(agent.news[0], "news 0");
});

test("past that, the oldest go: the newest NEWS_KEPT stay, behind one line counting the dropped, times in step", () => {
	const n = NEWS_KEPT + NEWS_TRIM + 1;
	const agent = agentWith(n);
	capNews(agent);
	assert.equal(agent.news.length, NEWS_KEPT + 1);
	assert.equal(agent.news[0], droppedNewsLine(n - NEWS_KEPT));
	assert.equal(agent.news[1], `news ${n - NEWS_KEPT}`);
	assert.equal(agent.news.at(-1), `news ${n - 1}`);
	assert.equal(agent.newsAt.length, agent.news.length);
	assert.equal(agent.newsAt[1], n - NEWS_KEPT);
});

test("the dropped count adds up across trims", () => {
	const agent = agentWith(NEWS_KEPT + NEWS_TRIM + 1);
	capNews(agent);
	const first = NEWS_TRIM + 1;
	for (let i = 0; i < NEWS_TRIM + 1; i++) {
		agent.news.push(`more ${i}`);
		agent.newsAt.push(1000 + i);
	}
	capNews(agent);
	assert.equal(agent.news[0], droppedNewsLine(first + NEWS_TRIM + 1));
	assert.equal(agent.news.length, NEWS_KEPT + 1);
	assert.equal(agent.news.at(-1), `more ${NEWS_TRIM}`);
	assert.equal(
		droppedNewsLine(1),
		`1 older news item went unheard and was dropped: an agent keeps its newest ${NEWS_KEPT}.`,
	);
});
