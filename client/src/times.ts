// When something happened, short and the same everywhere it's shown (abso
// issue 124): "08:34 UTC" today, "Oct 7 21:10 UTC" before that.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortWhen(time: number, now: number = Date.now()): string {
	const t = new Date(time);
	const hm = t.toISOString().slice(11, 16);
	if (t.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)) return `${hm} UTC`;
	const year = t.getUTCFullYear() === new Date(now).getUTCFullYear() ? "" : ` ${t.getUTCFullYear()}`;
	return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}${year} ${hm} UTC`;
}

/** When the reader first saw it: "seen 08:40 UTC", or "new" when this is the first time. */
export function seenText(seen: number | null, now: number = Date.now()): string {
	return seen === null ? "new" : `seen ${shortWhen(seen, now)}`;
}

/**
 * A news sentence with its time after the who: an announcement's after
 * "Announcement from <who> (<how>)", any other at its end.
 */
export function newsWithTime(text: string, at: number | null, now: number = Date.now()): string {
	if (at === null) return text;
	const time = shortWhen(at, now);
	const head = /^(Announcement from .+? \([^)]*\)): /.exec(text);
	return head ? `${head[1]}, ${time}: ${text.slice(head[0].length)}` : `${text} (${time})`;
}
