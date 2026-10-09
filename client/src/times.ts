// When something happened, short and the same everywhere it's shown (abso
// issue 124): "08:34 UTC" today, "Oct 7 21:10 UTC" before that.

import { newsShown } from "./core.ts";

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

/** A news item as shown, with its time: a tell's after who told it, any other at its end. */
export function newsWithTime(text: string, at: number | null, now: number = Date.now()): string {
	return newsShown(text, at === null ? undefined : shortWhen(at, now));
}
