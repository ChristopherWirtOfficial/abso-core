// What the client prints is mostly text a server sent: version messages, news,
// CI logs, file paths, agent names. So nothing in it gets to drive the terminal.
// Tabs, newlines and colors (SGR, ESC[...m) pass. Colors pass only to a terminal
// with NO_COLOR unset, and are dropped otherwise. Every other control character,
// and with it every other escape sequence, is shown as text (\x1b, \x07, \u009b),
// so nothing vanishes silently.

/** Whether colors pass: a terminal, and NO_COLOR unset or empty (no-color.org). */
export function colorsPass(stream: { isTTY?: boolean }, env: Readonly<Record<string, string | undefined>>): boolean {
	return stream.isTTY === true && !env.NO_COLOR;
}

/** The length of the SGR sequence (ESC [ digits ; : m) starting at i, or 0 when there isn't one. */
function sgrAt(text: string, i: number): number {
	if (text.charCodeAt(i) !== 0x1b || text[i + 1] !== "[") return 0;
	for (let j = i + 2; j < text.length && j < i + 64; j++) {
		const c = text[j]!;
		if (c === "m") return j - i + 1;
		if (!/[0-9;:]/.test(c)) return 0;
	}
	return 0;
}

/** Whether a character code is one the terminal acts on: C0 but tab and newline, DEL, and C1. */
const control = (c: number) => (c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f);

/** `text` as it is safe to print: colors kept only when `colors`, every other control character shown as text. */
export function terminalText(text: string, colors: boolean): string {
	let i = 0;
	while (i < text.length && !control(text.charCodeAt(i))) i++;
	if (i === text.length) return text;
	let out = text.slice(0, i);
	for (; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (!control(c)) {
			out += text[i];
			continue;
		}
		const sgr = sgrAt(text, i);
		if (sgr > 0) {
			if (colors) out += text.slice(i, i + sgr);
			i += sgr - 1;
		} else if (c === 0x0d && text.charCodeAt(i + 1) === 0x0a) out += "\r";
		else out += c < 0x80 ? `\\x${c.toString(16).padStart(2, "0")}` : `\\u${c.toString(16).padStart(4, "0")}`;
	}
	return out;
}
