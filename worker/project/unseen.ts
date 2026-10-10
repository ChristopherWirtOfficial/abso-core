// Characters a reader can't see, refused in text the engine keeps and prints:
// version messages, starting notes, line notes and
// announcements. In a terminal, ESC and C1 start escape sequences that can
// set the clipboard or draw a fake link, so `abso log` and news must never
// carry them. The same list as the website's announcements and Issues.

const UNSEEN: [number, number, string][] = [
	[0x00, 0x08, "a control character"],
	[0x0b, 0x1f, "a control character"],
	[0x7f, 0x9f, "a control character"],
	[0x180e, 0x180e, "the Mongolian vowel separator (U+180E)"],
	[0x200b, 0x200f, "a zero-width or direction mark (U+200B-200F)"],
	[0x2028, 0x2029, "a line or paragraph separator (U+2028-2029)"],
	[0x202a, 0x202e, "a bidirectional embedding or override (U+202A-202E)"],
	[0x2060, 0x2064, "an invisible joiner or operator (U+2060-2064)"],
	[0x2066, 0x2069, "a bidirectional isolate (U+2066-2069)"],
	[0xfe00, 0xfe0f, "a variation selector (U+FE00-FE0F)"],
	[0xfeff, 0xfeff, "a byte order mark (U+FEFF)"],
	[0xe0000, 0xe007f, "a tag character (U+E0000-E007F)"],
	[0xe0100, 0xe01ef, "a variation selector (U+E0100-E01EF)"],
];

/**
 * The first character in `text` a reader can't see, as "<what> at character N", or null.
 * \n and \t pass, and so does \r before \n, since a message file written on Windows ends its lines that way.
 */
export function unseenIn(text: string): string | null {
	const chars = [...text];
	for (const [i, ch] of chars.entries()) {
		const c = ch.codePointAt(0)!;
		if (c === 0x0d && chars[i + 1] === "\n") continue;
		const hit = UNSEEN.find(([lo, hi]) => c >= lo && c <= hi);
		if (hit) return `${hit[2]} at character ${i + 1}`;
	}
	return null;
}

/** Why `text`, named `what` ("the message"), can't be kept, or null. */
export function unseenError(what: string, text: unknown): string | null {
	const hit = typeof text === "string" ? unseenIn(text) : null;
	return hit === null ? null : `${what} holds ${hit}, which a reader can't see; take it out`;
}
