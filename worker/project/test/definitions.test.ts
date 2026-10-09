import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBase, Graph, View } from "../../../src/engine/index.ts";
import { definitionsIn } from "../definitions.ts";

function defs(files: Record<string, string>): Record<string, string[]> {
	const graph = new Graph();
	const a0 = buildBase(files, { author: "t", message: "t" });
	graph.add(a0);
	const out: Record<string, string[]> = {};
	for (const [name, list] of definitionsIn(new View(graph, [a0.id]))) out[name] = list.map((d) => d.text);
	return out;
}

test("function headers stop at the body; blocks of types are whole", () => {
	const found = defs({
		"a.ts": [
			"export function parsePattern(text: string,",
			"    flags: string): Node {",
			"  return compileNode(text);",
			"}",
			"export const matchAll = (re: Node, s: string) => {",
			"  return [];",
			"};",
			"const MAX_DEPTH = 10;",
			"export interface Node {",
			"  kind: string;",
			"  kids: Node[];",
			"}",
			'type Flag = "g" | "i";',
			"class Engine {",
			"  async runOnce(input: string): Promise<void> {",
			"    helperCall(input);",
			"  }",
			"}",
		].join("\n"),
	});
	assert.deepEqual(found, {
		parsePattern: ["export function parsePattern(text: string,\n    flags: string): Node {"],
		matchAll: ["export const matchAll = (re: Node, s: string) => {"],
		MAX_DEPTH: ["const MAX_DEPTH = 10;"],
		Node: ["export interface Node {\n  kind: string;\n  kids: Node[];\n}"],
		Flag: ['type Flag = "g" | "i";'],
		// Only top-level declarations: the method runOnce is reached through a dot, never imported.
		Engine: ["class Engine {"],
	});
});

test("Python, Go and Rust shapes; calls are not definitions", () => {
	const found = defs({
		"a.py": "def compile_pattern(text,\n                    flags=0):\n    return run_it(text)\nMAX_STEPS = 100\n",
		"b.go": "func (m *Matcher) MatchString(s string) bool {\n\treturn false\n}\n",
		"c.rs":
			"pub fn find_at(hay: &str, at: usize) -> Option<usize> {\n    None\n}\npub struct Span {\n    start: usize,\n}\n",
		"d.md": "function notCode(x) {\n",
	});
	assert.deepEqual(found, {
		compile_pattern: ["def compile_pattern(text,\n                    flags=0):"],
		MAX_STEPS: ["MAX_STEPS = 100"],
		MatchString: ["func (m *Matcher) MatchString(s string) bool {"],
		find_at: ["pub fn find_at(hay: &str, at: usize) -> Option<usize> {"],
		Span: ["pub struct Span {\n    start: usize,\n}"],
	});
});

test("data files hold no definitions: JSON, CSV and lock files are passed over, however code-like a line looks (abso issue 158)", () => {
	const codeLike = "export function parsePattern(text: string): Node {\n  return compileNode(text);\n}\n";
	assert.deepEqual(defs({ "fixtures/a.json": codeLike, "data/b.csv": codeLike, "c.lock": codeLike }), {});
	assert.deepEqual(Object.keys(defs({ "src/a.ts": codeLike })), ["parsePattern"]);
});
