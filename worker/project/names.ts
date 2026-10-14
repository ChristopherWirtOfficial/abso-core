// Reading names out of lines of code, for branch mode's questions ("does this
// commit need the one that introduced a name it uses?"). Cheap, deterministic
// and not tied to one language: it never parses, it only leaves out what is
// surely not a use of someone's name.
//
// - String literals and comments are left out (//, /* */, # and -- with a
//   space after them, Python's triple quotes, and lines inside a block comment
//   that start with *). Code inside a template literal's ${...} stays.
// - Keywords, built-ins and common library names of the usual languages are
//   not names anyone introduced.
// - Prose files (Markdown, plain text, READMEs) have no code.
// - A name the commit declares itself (const x, def x, x = ..., x := ...) is
//   its own, not a use of another commit's.

/** Identifiers counted as names: three or more characters. */
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const MIN_LENGTH = 3;

/**
 * Keywords and built-ins of common languages (JavaScript/TypeScript, Python,
 * Go, Rust, Java, C and C#, shell, SQL), and the standard library names agents
 * use everywhere. Compared in lower case.
 */
const COMMON = new Set(
	[
		// JavaScript and TypeScript
		"abstract any arguments as async await bigint boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get global if implements import in infer instanceof interface is keyof let module namespace never new null number object of override package private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield",
		"array buffer console date document error evalerror function globalthis infinity intl json map math nan promise proxy rangeerror referenceerror reflect regexp syntaxerror typeerror urierror weakmap weakset window process aggregateerror arraybuffer uint8array",
		"clearinterval cleartimeout decodeuricomponent encodeuricomponent fetch isfinite isnan parsefloat parseint queuemicrotask setinterval settimeout structuredclone",
		"awaited exclude extract iterable iterator nonnullable omit parameters partial pick readonlyarray record required returntype",
		// Methods and properties of the standard library
		"add apply assign bind call ceil clear concat entries every filter find findindex findlast flat flatmap floor foreach freeze has hasownproperty includes indexof isarray join keys lastindexof length log max min now padend padstart parse pop prototype push random reduce reject replace replaceall resolve reverse round shift size slice some sort splice split startswith endswith stringify substring then tofixed tolowercase tostring touppercase trim trimend trimstart unshift valueof values warn info debug abs sqrt pow sign trunc next done value",
		// Tests
		"after afterall aftereach assert before beforeall beforeeach deepequal deepstrictequal describe equal expect notequal ok rejects strictequal test throws tobe toequal",
		// Python
		"and def del elif except false lambda none nonlocal not or pass raise self cls print len range list dict tuple int float str bool bytes isinstance issubclass property staticmethod classmethod enumerate zip sorted reversed open exception valueerror keyerror indexerror attributeerror runtimeerror notimplementederror stopiteration __init__ __name__ __main__",
		// Go and Rust
		"func chan defer fallthrough goto nil make append cap copy panic recover rune int64 int32 float64 float32 uint uint8 uint32 uint64 usize isize fn mut pub use mod impl trait match loop where crate some ok err vec option result box unsafe dyn ref move",
		// Java, C, C#
		"void long short char double byte final synchronized volatile transient native throws struct union typedef sizeof unsigned signed auto register extern include define ifdef ifndef endif pragma using virtual template typename operator friend inline explicit nullptr std vector printf malloc free main",
		// Shell and SQL
		"echo then fi esac local source exit read unset select where insert update create table values into join left right inner outer group order having limit offset distinct union all primary key foreign references index view begin commit rollback",
	]
		.join(" ")
		.split(/\s+/),
);

/** Whether a name is a keyword, built-in or common library name. */
export function isCommonName(name: string): boolean {
	return COMMON.has(name.toLowerCase());
}

const PROSE_EXTENSIONS = new Set(["md", "markdown", "mdown", "txt", "text", "rst", "adoc", "asciidoc", "org"]);
const PROSE_NAMES = new Set([
	"readme",
	"license",
	"licence",
	"changelog",
	"changes",
	"notice",
	"authors",
	"contributing",
	"copying",
]);

/** Files of prose, whose words are not code: Markdown, plain text, READMEs and the like. */
/** Data files: no code defines or uses a name in them, however big they are (abso issue 158). */
const DATA_EXTENSIONS = new Set(["json", "jsonc", "json5", "jsonl", "ndjson", "geojson", "csv", "tsv", "lock", "svg"]);

/**
 * Whether the definition rule passes over a file: prose, or data. Scanning a
 * 23,000-line JSON fixture for definitions it can't hold cost a big publish
 * hundreds of milliseconds, and its keys could pass for uses of code names.
 */
export function holdsNoCode(path: string): boolean {
	if (isProse(path)) return true;
	const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	const dot = base.lastIndexOf(".");
	return dot > 0 && DATA_EXTENSIONS.has(base.slice(dot + 1));
}

export function isProse(path: string): boolean {
	const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 ? base.slice(dot + 1) : "";
	const stem = dot > 0 ? base.slice(0, dot) : base;
	return PROSE_EXTENSIONS.has(ext) || PROSE_NAMES.has(stem);
}

interface ScanState {
	/** Open template literals and the code inside their ${...}, innermost last. */
	readonly stack: ({ kind: "code"; depth: number } | { kind: "template" })[];
	/** Inside a block comment. */
	block: boolean;
	/** Inside a Python triple-quoted string: its quote. */
	triple: string | undefined;
}

function spaceBefore(line: string, i: number): boolean {
	return i === 0 || line[i - 1] === " " || line[i - 1] === "\t";
}

function spaceAfter(line: string, i: number): boolean {
	return i >= line.length || line[i] === " " || line[i] === "\t";
}

/** One line's code, given what the lines before it left open. */
function scanLine(line: string, st: ScanState): string {
	if (!st.block && st.triple === undefined && st.stack.length === 1) {
		// A line inside a block comment that started above these lines.
		const t = line.trimStart();
		if (t.startsWith("*")) return "";
	}
	let out = "";
	let i = 0;
	const n = line.length;
	while (i < n) {
		if (st.block) {
			const end = line.indexOf("*/", i);
			if (end < 0) return out;
			st.block = false;
			i = end + 2;
			out += " ";
			continue;
		}
		if (st.triple !== undefined) {
			const end = line.indexOf(st.triple, i);
			if (end < 0) return out;
			i = end + 3;
			st.triple = undefined;
			out += " ";
			continue;
		}
		const top = st.stack[st.stack.length - 1]!;
		const c = line[i]!;
		if (top.kind === "template") {
			if (c === "\\") i += 2;
			else if (c === "`") {
				st.stack.pop();
				i++;
				out += " ";
			} else if (c === "$" && line[i + 1] === "{") {
				st.stack.push({ kind: "code", depth: 0 });
				i += 2;
				out += " ";
			} else i++;
			continue;
		}
		if (c === "/" && line[i + 1] === "/") return out;
		if (c === "/" && line[i + 1] === "*") {
			st.block = true;
			i += 2;
			continue;
		}
		if (c === "#" && spaceBefore(line, i) && spaceAfter(line, i + 1)) return out;
		if (c === "-" && line[i + 1] === "-" && spaceBefore(line, i) && spaceAfter(line, i + 2)) return out;
		if (c === '"' || c === "'") {
			if (line.startsWith(c.repeat(3), i)) {
				st.triple = c.repeat(3);
				i += 3;
				continue;
			}
			let j = i + 1;
			while (j < n && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
			// An unclosed quote (an apostrophe, a Rust lifetime) is just a character.
			i = j < n ? j + 1 : i + 1;
			out += " ";
			continue;
		}
		if (c === "`") {
			st.stack.push({ kind: "template" });
			i++;
			out += " ";
			continue;
		}
		if (c === "{") top.depth++;
		else if (c === "}") {
			if (top.depth === 0 && st.stack.length > 1) {
				st.stack.pop();
				i++;
				out += " ";
				continue;
			}
			top.depth = Math.max(0, top.depth - 1);
		}
		out += c;
		i++;
	}
	return out;
}

/**
 * The code of consecutive lines (one inserted run, or a file): each line
 * without its string literals and comments. A string or comment opened on
 * one line continues on the next.
 */
export function codeOfLines(lines: Iterable<string>): string[] {
	return [...eachCodeLine(lines)];
}

export function* eachCodeLine(lines: Iterable<string>): IterableIterator<string> {
	const st: ScanState = { stack: [{ kind: "code", depth: 0 }], block: false, triple: undefined };
	for (const line of lines) yield scanLine(line, st);
}

/** Names in some code (from codeOfLines): identifiers of three or more characters that aren't common names. */
export function namesIn(code: string): string[] {
	return (code.match(IDENT) ?? []).filter((w) => w.length >= MIN_LENGTH && !isCommonName(w));
}

const DECLARATION =
	/\b(?:const|let|var|function\*?|class|def|fn|func|type|interface|enum|struct|trait|val|my|local)\s+(?:mut\s+)?([A-Za-z_$][A-Za-z0-9_$]*)/g;
const ASSIGNMENT = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]*)?(?::=|=(?![=>]))/;
const FOR_IN = /\bfor\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+in\b/g;

/**
 * Names some code declares: after a declaring keyword (const x, def x, class
 * X, fn x, ...), assigned at the start of a line (x = ..., x: T = ...,
 * x := ...), or a Python loop variable. Destructuring and parameters are left
 * alone: there the name may well be someone else's.
 */
export function declaredIn(code: string): string[] {
	const out: string[] = [];
	for (const m of code.matchAll(DECLARATION)) out.push(m[1]!);
	for (const m of code.matchAll(FOR_IN)) out.push(m[1]!);
	const a = ASSIGNMENT.exec(code);
	if (a) out.push(a[1]!);
	return out;
}
