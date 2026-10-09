// The key paths match by (#49, the rulings on case and Unicode):
// two spellings are one file when their keys are equal. It's Unicode's
// canonical caseless match, used only to compare, never to rename: the
// canonical decomposition (NFD), case folding, then NFD again. JavaScript has
// no case-folding call, so upper-then-lower case stands in for it; unlike
// lower case alone, it folds ß to ss as case folding does.
//
// The engine (V8 on Workers) and the client (Node) must build the same key,
// so the client imports this file rather than writing its own. Both take
// their Unicode data from their ICU; `unicodeVersion` says which, and a
// mismatch can only matter for characters assigned after the older one.

export function pathKey(path: string): string {
	return path.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");
}

/** Whether a path is in composed form (NFC), the form most tools on Windows and Linux expect. */
export function isComposed(path: string): boolean {
	return path === path.normalize("NFC");
}

/** The Unicode version this runtime's data is from, where the runtime says. */
export const unicodeVersion: string | undefined = (globalThis as { process?: { versions?: { unicode?: string } } })
	.process?.versions?.unicode;
