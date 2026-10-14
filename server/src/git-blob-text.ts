import type { GitByteRanges } from "./git-delta-stream.ts";

export class InvalidGitUtf8 extends Error {}

/** Strict UTF-8 decoding with the same BOM handling as whole-file intake. */
export function* gitBlobText(bytes: GitByteRanges): IterableIterator<string> {
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	const size = 16384;
	const decode = (chunk?: Uint8Array, stream = false) => {
		try {
			return decoder.decode(chunk, { stream });
		} catch (error) {
			throw new InvalidGitUtf8("Git blob is not UTF-8", { cause: error });
		}
	};
	for (let at = 0; at < bytes.byteLength; at += size) {
		const text = decode(bytes.read(at, Math.min(size, bytes.byteLength - at)), true);
		for (let offset = 0; offset < text.length; offset += size) yield text.slice(offset, offset + size);
	}
	const tail = decode();
	if (tail) yield tail;
}
