// Commit message trailers: "Key: value" lines in the last paragraph of a
// message, the way git writes Signed-off-by. View commits carry Atom, Deps,
// Resolves, Reason and View-Heads; ingested tie atoms carry Git-Commit.

export interface Trailer {
	readonly key: string;
	readonly value: string;
}

/** Trailer keys the git view writes. A last paragraph with View-Heads is a view's own block. */
export const VIEW_HEADS = "View-Heads";
/** The trailer an ingested commit's tie atom carries: the full sha of the git commit. */
export const GIT_COMMIT = "Git-Commit";

const TRAILER_LINE = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/;

/** Line endings to "\n", no blank lines at the start, no trailing whitespace at the end. */
export function cleanMessage(message: string): string {
	return message
		.replace(/\r\n?/g, "\n")
		.replace(/^(?:[ \t]*\n)+/, "")
		.trimEnd();
}

/** A trailer value on one line: line breaks become spaces. */
export function oneLine(text: string): string {
	return text.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * The message, a blank line, then one "Key: value" line per trailer. The
 * result ends with a newline. An empty message gets `fallback` as its subject
 * so the trailers never become the subject line.
 */
export function withTrailers(message: string, trailers: readonly Trailer[], fallback: string): string {
	const body = cleanMessage(message) || fallback;
	if (trailers.length === 0) return `${body}\n`;
	const block = trailers.map((t) => `${t.key}: ${oneLine(t.value)}`).join("\n");
	return `${body}\n\n${block}\n`;
}

/** Split a cleaned message into its paragraphs (separated by blank lines). */
function paragraphs(message: string): string[] {
	return cleanMessage(message)
		.split(/\n[ \t]*\n/)
		.filter((p) => p.trim() !== "");
}

/**
 * The trailers in the last paragraph, when every line of it is a trailer (a
 * line starting with whitespace continues the one above). Otherwise none.
 * A one-paragraph message has no trailers: it is all subject.
 */
export function parseTrailers(message: string): Trailer[] {
	const paras = paragraphs(message);
	if (paras.length < 2) return [];
	const out: { key: string; value: string }[] = [];
	for (const line of paras[paras.length - 1]!.split("\n")) {
		const last = out[out.length - 1];
		if (/^[ \t]/.test(line) && last) {
			last.value = `${last.value} ${line.trim()}`;
			continue;
		}
		const m = TRAILER_LINE.exec(line);
		if (!m) return [];
		out.push({ key: m[1]!, value: m[2]!.trim() });
	}
	return out;
}

/** The value of the first trailer with this key, if any. */
export function trailerValue(trailers: readonly Trailer[], key: string): string | undefined {
	return trailers.find((t) => t.key === key)?.value;
}

/**
 * The message without a view's trailer block (a last paragraph carrying
 * View-Heads). Used when a person reworded or amended a view commit and it is
 * ingested as their own: its old trailers describe atoms, not this change.
 */
export function stripViewTrailers(message: string): string {
	const paras = paragraphs(message);
	if (paras.length >= 2 && trailerValue(parseTrailers(message), VIEW_HEADS) !== undefined) {
		return paras.slice(0, -1).join("\n\n");
	}
	return cleanMessage(message);
}

/** First line of a message, and the rest (without the blank line between). */
export function splitSubject(message: string): { subject: string; body: string } {
	const clean = cleanMessage(message);
	const nl = clean.indexOf("\n");
	if (nl < 0) return { subject: clean, body: "" };
	return { subject: clean.slice(0, nl).trim(), body: clean.slice(nl + 1).replace(/^(?:[ \t]*\n)+/, "") };
}
