// Asks go to seats: an ask to a name that isn't an agent in the project would
// wait on nobody, so it's refused, with the closest seat named. Seats are only
// ever this project's own.

/** A name as people write it: lower case, letters and digits only ("abso - Cloud Infra Lead" → "absocloudinfralead"). */
function plain(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Edits from a to b: insertions, deletions and substitutions. */
function distance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++)
			next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
		row = next;
	}
	return row[b.length]!;
}

/**
 * The seat a name most likely meant, or null. The same name written another way wins; then the longest seat
 * the name holds ("abso - Cloud Infra Lead" holds cloud), or that holds the name; then a near spelling.
 */
export function closestSeat(name: string, seats: readonly string[]): string | null {
	const n = plain(name);
	if (n === "") return null;
	const same = seats.find((s) => plain(s) === n);
	if (same) return same;
	const held = seats
		.filter((s) => plain(s).length >= 3 && (n.includes(plain(s)) || plain(s).includes(n)))
		.sort((a, b) => plain(b).length - plain(a).length);
	if (held[0]) return held[0];
	let best: string | null = null;
	let least = Math.max(2, Math.floor(n.length / 3)) + 1;
	for (const s of seats) {
		const d = distance(n, plain(s));
		if (d < least) [best, least] = [s, d];
	}
	return best;
}

/** Why an ask to `of` is refused, or null when `of` is a seat. */
export function seatRefusal(of: string, project: string, seats: readonly string[]): string | null {
	if (seats.includes(of)) return null;
	const near = closestSeat(of, seats);
	return `${JSON.stringify(of)} isn't an agent in ${project}, so nobody would hear the ask${near ? `; did you mean ${near}?` : "."} abso status lists the agents.`;
}
