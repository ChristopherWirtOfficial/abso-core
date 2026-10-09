// Where names are defined in a view, and which names a set of lines uses,
// for the changed-definition rule (#11): publishing is refused when new code
// uses a name whose definition changed in work published after the agent's
// base. Like names.ts, this never parses; it reads the shapes a
// definition has in the usual languages.
//
// What counts as a name's definition, only at the top level of a file (an
// unindented line: what another file can import; never a local, a
// parameter or a method):
// - a function or Go func: its header, from the name through the parameter
//   list and return type to the opening brace (or the colon or arrow), so a
//   body edit is not a definition change;
// - a type, interface, enum, struct or trait: the whole block, since its
//   shape is what users rely on;
// - a class: its header line;
// - a const/let/var/val, or a name assigned at the start of a line: the
//   declaring line, or the header when the value is a function.
//
// A use means a definition only through an import of it, or in the file
// that defines it (project.ts, #definitionCore).

import type { LineId, View } from "../../src/engine/index.ts";
import { codeOfLines, isCommonName, isProse } from "./names.ts";

export interface Definition {
	readonly name: string;
	readonly file: string;
	/** Visible lines [start, end) of the file, 0-based. */
	readonly start: number;
	readonly end: number;
	readonly lines: readonly LineId[];
	/** The definition's text as written (with strings and comments), one line per line. */
	readonly text: string;
}

const NAME = "[A-Za-z_$][A-Za-z0-9_$]*";
const KEYWORD_DEF = new RegExp(`\\b(function\\*?|class|def|fn|type|interface|enum|struct|trait)\\s+(${NAME})`);
const GO_FUNC = new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?(${NAME})`);
const VAR_DEF = new RegExp(`\\b(?:const|let|var|val)\\s+(${NAME})\\s*(?::[^=]*)?=`);
const METHOD = new RegExp(
	`^\\s*(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set|export|default)\\s+)*\\*?(${NAME})\\s*(?:<[^()]*>)?\\s*\\(`,
);
/** Words that open a statement, never a definition's name, in the usual languages. */
const KEYWORDS = new Set([
	"if",
	"else",
	"elif",
	"for",
	"foreach",
	"while",
	"do",
	"switch",
	"case",
	"match",
	"when",
	"catch",
	"try",
	"except",
	"finally",
	"with",
	"return",
	"yield",
	"await",
	"throw",
	"raise",
	"new",
	"delete",
	"typeof",
	"void",
	"in",
	"of",
	"unless",
	"until",
	"loop",
	"select",
	"go",
	"defer",
	"assert",
	"print",
	"super",
	"this",
	"self",
	"import",
	"export",
	"from",
	"require",
	"function",
	"lambda",
]);
const TOP_ASSIGN = new RegExp(`^(${NAME})\\s*(?::[^=]*)?=(?![=>])`);
const MAX_HEADER = 30;

const cache = new WeakMap<View, Map<string, readonly Definition[]>>();

/**
 * Every definition in the view's code files (or only in `files`), by name.
 * Each file's definitions are cached per view.
 */
export function definitionsIn(view: View, files?: Iterable<string>): Map<string, Definition[]> {
	let perFile = cache.get(view);
	if (!perFile) {
		perFile = new Map();
		cache.set(view, perFile);
	}
	const out = new Map<string, Definition[]>();
	for (const file of files ?? view.paths()) {
		let defs = perFile.get(file);
		if (!defs) {
			defs = definitionsInFile(view, file);
			perFile.set(file, defs);
		}
		for (const def of defs) {
			const list = out.get(def.name);
			if (list) list.push(def);
			else out.set(def.name, [def]);
		}
	}
	return out;
}

function definitionsInFile(view: View, file: string, keepCommon = false): Definition[] {
	if (isProse(file) || !view.hasFile(file)) return [];
	const out: Definition[] = [];
	const visible = view.lines(file);
	const code = codeOfLines(visible.map((l) => l.text));
	for (let i = 0; i < code.length; i++) {
		// Only top-level declarations: what another file can import. Locals,
		// parameters and methods are indented.
		if (/^\s/.test(code[i]!)) continue;
		const found = defineAt(code, i);
		if (!found || (!keepCommon && (found.name.length < 3 || isCommonName(found.name)))) continue;
		out.push({
			name: found.name,
			file,
			start: i,
			end: found.end,
			lines: visible.slice(i, found.end).map((l) => l.id),
			text: visible
				.slice(i, found.end)
				.map((l) => l.text)
				.join("\n"),
		});
	}
	return out;
}

/**
 * Top-level definitions defined more than once in one file, common names
 * included (two `parse` functions in a file are a mistake whatever the name).
 * Each spans its whole block, body and all, for showing to the agent.
 */
export function definedTwice(view: View, file: string): Map<string, Definition[]> {
	const out = new Map<string, Definition[]>();
	const all = definitionsInFile(view, file, true);
	const count = new Map<string, number>();
	for (const d of all) count.set(d.name, (count.get(d.name) ?? 0) + 1);
	if (![...count.values()].some((n) => n > 1)) return out;
	const visible = view.lines(file);
	const code = codeOfLines(visible.map((l) => l.text));
	for (const d of all) {
		if (count.get(d.name)! < 2) continue;
		const end = Math.max(d.end, wholeBlockEnd(code, d.start));
		const whole: Definition = {
			...d,
			end,
			lines: visible.slice(d.start, end).map((l) => l.id),
			text: visible
				.slice(d.start, end)
				.map((l) => l.text)
				.join("\n"),
		};
		const list = out.get(d.name);
		if (list) list.push(whole);
		else out.set(d.name, [whole]);
	}
	return out;
}

/**
 * Where a top-level definition starting on line i ends (exclusive), body
 * included: the line where its braces close, or, for an indented block
 * (Python), the line before the next one back at its indentation.
 */
function wholeBlockEnd(code: readonly string[], i: number): number {
	let depth = 0;
	let opened = false;
	for (let j = i; j < code.length && j < i + 2000; j++) {
		for (const c of code[j]!) {
			if (c === "{" || c === "(" || c === "[") {
				depth++;
				if (c === "{") opened = true;
			} else if (c === "}" || c === ")" || c === "]") depth--;
		}
		if (opened && depth <= 0) return j + 1;
		if (!opened && depth <= 0 && /:\s*$/.test(code[j]!)) {
			// An indented block: up to the next non-blank line at the top level.
			let k = j + 1;
			while (k < code.length && (code[k]!.trim() === "" || /^\s/.test(code[k]!))) k++;
			while (k > j + 1 && code[k - 1]!.trim() === "") k--;
			return k;
		}
		if (!opened && depth <= 0 && /[;,]\s*$/.test(code[j]!)) return j + 1;
	}
	return i + 1;
}

/** A definition starting on line i: its name and where it ends (exclusive). */
/**
 * Whether a declaration found at `at` starts its line, after modifiers
 * only: `export const x`, `async function f`, `pub fn g`. A `let` inside
 * `for (let i = 0; ...)` or a `function` passed as an argument is not a
 * definition of the file (#37, Builder 4).
 */
const LEADS =
	/^\s*(?:(?:export|default|declare|async|public|private|protected|static|abstract|override|readonly|pub(?:\([a-z]+\))?|unsafe|extern|const|final|sealed|open|data|inline|private\[this\])\s+)*$/;
function startsLine(line: string, at: number): boolean {
	return LEADS.test(line.slice(0, at));
}

function defineAt(code: readonly string[], i: number): { name: string; end: number } | undefined {
	const line = code[i]!;
	const found = KEYWORD_DEF.exec(line);
	const kw = found && startsLine(line, found.index) ? found : null;
	if (kw) {
		const [, keyword, name] = kw;
		if (keyword === "class") return { name: name!, end: i + 1 };
		if (
			keyword === "type" ||
			keyword === "interface" ||
			keyword === "enum" ||
			keyword === "struct" ||
			keyword === "trait"
		) {
			return { name: name!, end: blockEnd(code, i, kw.index) };
		}
		return { name: name!, end: headerEnd(code, i, kw.index) ?? i + 1 };
	}
	const go = GO_FUNC.exec(line);
	if (go && startsLine(line, go.index)) return { name: go[1]!, end: headerEnd(code, i, go.index) ?? i + 1 };
	const v = VAR_DEF.exec(line);
	if (v && startsLine(line, v.index)) {
		const rest = line.slice(v.index + v[0].length);
		if (/^\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(rest)) {
			return { name: v[1]!, end: headerEnd(code, i, v.index + v[0].length) ?? i + 1 };
		}
		return { name: v[1]!, end: i + 1 };
	}
	const m = METHOD.exec(line);
	// `for (...) {`, `while (...) {` and `if (...) {` look like a method with a body; a keyword names nothing (#37).
	if (m && !KEYWORDS.has(m[1]!)) {
		// A method definition, not a call: after its parameters comes a body.
		const end = headerEnd(code, i, m.index, true);
		if (end !== undefined) return { name: m[1]!, end };
	}
	const t = TOP_ASSIGN.exec(line);
	if (t) return { name: t[1]!, end: i + 1 };
	return undefined;
}

/**
 * The end of a function header starting at line i, column `from`: once the
 * parentheses close, the header ends at the line holding `{`, `=>` or a
 * trailing `:` (Python). With `needBody`, a `;` or `,` first means it was a
 * call, not a definition (undefined).
 */
function headerEnd(code: readonly string[], i: number, from: number, needBody = false): number | undefined {
	let depth = 0;
	let opened = false;
	for (let j = i; j < code.length && j < i + MAX_HEADER; j++) {
		const line = j === i ? code[j]!.slice(from) : code[j]!;
		for (let k = 0; k < line.length; k++) {
			const c = line[k]!;
			if (c === "(") {
				depth++;
				opened = true;
			} else if (c === ")") depth--;
			else if (depth === 0 && opened) {
				if (c === "{") return j + 1;
				if (c === "=" && line[k + 1] === ">") return j + 1;
				if (c === ";" || c === ",") return needBody ? undefined : j + 1;
				if (c === "=" && needBody) return undefined;
			}
		}
		if (depth === 0 && opened && /:\s*$/.test(line)) return j + 1;
	}
	return needBody ? undefined : opened ? i + 1 : undefined;
}

/** The end of a braced (or one-line) block starting at line i, column `from`. */
function blockEnd(code: readonly string[], i: number, from: number): number {
	let depth = 0;
	let opened = false;
	for (let j = i; j < code.length && j < i + 500; j++) {
		const line = j === i ? code[j]!.slice(from) : code[j]!;
		for (const c of line) {
			if (c === "{" || c === "(" || c === "[") {
				depth++;
				opened = true;
			} else if (c === "}" || c === ")" || c === "]") depth--;
			else if (c === ";" && depth === 0) return j + 1;
		}
		if (opened && depth <= 0) return j + 1;
		if (!opened && j === i && !/[=:{]\s*$/.test(line) && !/\b(?:struct|enum|interface|trait)\b/.test(line))
			return j + 1;
	}
	return i + 1;
}

const importCache = new WeakMap<View, Map<string, ReadonlyMap<string, string>>>();

/**
 * Names a file imports by name, and the project file each comes from, when
 * that file is in the view: JavaScript and TypeScript `import { a, b } from
 * "./x"` (also across lines; an aliased name is left out) and `import a
 * from "./x"`, and Python `from
 * x.y import a, b`. Lets a use of a name be matched to the definition it
 * means instead of every definition with that name.
 */
export function importsOf(view: View, file: string): ReadonlyMap<string, string> {
	let perFile = importCache.get(view);
	if (!perFile) {
		perFile = new Map();
		importCache.set(view, perFile);
	}
	let out = perFile.get(file);
	if (out) return out;
	const found = new Map<string, string>();
	const text = view.text(file);
	for (const m of text.matchAll(/\bimport\s+(?:type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
		const target = resolveModule(view, file, m[2]!);
		if (!target) continue;
		// A default import: `import body from "./x"` or `import body, { a } from "./x"`.
		const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(m[1]!.trim());
		if (def) found.set(def[1]!, target);
		const named = /\{([^}]*)\}/.exec(m[1]!);
		if (!named) continue;
		for (const part of named[1]!.split(",")) {
			const name = part.trim().replace(/^type\s+/, "");
			if (/^[A-Za-z_$][\w$]*$/.test(name)) found.set(name, target);
		}
	}
	for (const m of text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+\(?([^)\n]*)\)?/gm)) {
		const target = resolvePython(view, file, m[1]!);
		if (!target) continue;
		for (const part of m[2]!.split(",")) {
			const name = part.trim();
			if (/^[A-Za-z_]\w*$/.test(name)) found.set(name, target);
		}
	}
	out = found;
	perFile.set(file, out);
	return out;
}

function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

function joinPath(dir: string, rel: string): string {
	const parts = dir === "" ? [] : dir.split("/");
	for (const p of rel.split("/")) {
		if (p === "" || p === ".") continue;
		if (p === "..") parts.pop();
		else parts.push(p);
	}
	return parts.join("/");
}

function resolveModule(view: View, from: string, spec: string): string | undefined {
	if (!spec.startsWith(".")) return undefined;
	const base = joinPath(dirOf(from), spec);
	const stem = base.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
	for (const candidate of [
		base,
		`${stem}.ts`,
		`${stem}.tsx`,
		`${stem}.js`,
		`${stem}.mjs`,
		`${stem}/index.ts`,
		`${stem}/index.js`,
	]) {
		if (view.hasFile(candidate)) return candidate;
	}
	return undefined;
}

function resolvePython(view: View, from: string, spec: string): string | undefined {
	const dots = /^\.*/.exec(spec)![0].length;
	const rest = spec.slice(dots).replace(/\./g, "/");
	let dir = dots > 0 ? dirOf(from) : "";
	for (let i = 1; i < dots; i++) dir = dirOf(dir);
	const base = rest === "" ? dir : joinPath(dir, rest);
	for (const candidate of [`${base}.py`, `${base}/__init__.py`]) if (view.hasFile(candidate)) return candidate;
	if (dots === 0) {
		const local = joinPath(dirOf(from), rest);
		for (const candidate of [`${local}.py`, `${local}/__init__.py`]) if (view.hasFile(candidate)) return candidate;
	}
	return undefined;
}

/**
 * The names some lines of code use (identifiers that aren't common names),
 * from code text. A name right after a dot (`x.body`, `x?.body`) is a
 * property, not a use of a definition, so it is left out; a spread
 * (`...body`) is a use.
 */
export function usedNames(code: string): string[] {
	const out: string[] = [];
	for (const m of code.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
		const w = m[0];
		if (w.length < 3 || isCommonName(w)) continue;
		const at = m.index;
		if (at > 0 && code[at - 1] === "." && !(at >= 3 && code.slice(at - 3, at) === "...")) continue;
		out.push(w);
	}
	return out;
}
