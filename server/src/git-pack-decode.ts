import type { GitPackResolver } from "./git-pack-resolver.ts";
import type { GitPackSpool } from "./git-pack-spool.ts";

/** Structural adapter for the pinned Git dependency's streaming inflater. */
export interface PackInflater {
	onData: (bytes: Uint8Array) => void;
	push(bytes: Uint8Array, final: boolean): unknown;
	ended: boolean;
	err: number;
	msg: string;
	strm: { avail_in: number };
}

/** Decode verified disk bytes without collecting a pack or decoded object in memory. */
export function decodeGitPack(
	spool: GitPackSpool,
	resolver: GitPackResolver,
	createInflater: () => PackInflater,
): void {
	try {
		decodeVerifiedPack(spool, resolver, createInflater);
	} catch (error) {
		// Intake owns this resolver. Never expose earlier objects from a rejected pack.
		resolver.dispose();
		throw error;
	}
}

function decodeVerifiedPack(spool: GitPackSpool, resolver: GitPackResolver, createInflater: () => PackInflater): void {
	const end = spool.byteLength - 20;
	const header = spool.read(0, 12);
	const count = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(8);
	let position = 12;
	let cached: Uint8Array = new Uint8Array(0),
		cachedAt = 0;
	const byte = () => {
		if (position >= end) throw Error("truncated Git pack header");
		if (position < cachedAt || position >= cachedAt + cached.length) {
			cachedAt = position;
			cached = spool.read(position, Math.min(65536, end - position));
		}
		return cached[position++ - cachedAt]!;
	};
	for (let index = 0; index < count; index++) {
		const offset = position;
		let current = byte();
		const kind = (current >> 4) & 7;
		let length = current & 15,
			factor = 16;
		while (current & 128) {
			current = byte();
			length += (current & 127) * factor;
			factor *= 128;
			if (!Number.isSafeInteger(length) || !Number.isSafeInteger(factor)) throw Error("invalid Git object size");
		}
		let base: number | string | undefined;
		if (kind === 6) {
			current = byte();
			let distance = current & 127;
			while (current & 128) {
				current = byte();
				distance = (distance + 1) * 128 + (current & 127);
				if (!Number.isSafeInteger(distance)) throw Error("invalid Git delta distance");
			}
			base = offset - distance;
		} else if (kind === 7) {
			let reference = "";
			for (let i = 0; i < 20; i++) reference += byte().toString(16).padStart(2, "0");
			base = reference;
		}
		const type = ["", "commit", "tree", "blob", "tag", "", "delta", "delta"][kind];
		if (!type) throw Error("unsupported Git object type");
		resolver.addChunks(
			offset,
			type,
			(write) => {
				const inflater = createInflater();
				let decoded = 0;
				inflater.onData = (bytes) => {
					decoded += bytes.length;
					if (bytes.length > 65536 || decoded > length) throw Error("invalid inflated Git object size");
					write(bytes);
				};
				while (!inflater.ended) {
					if (position >= end) throw Error("truncated compressed Git object");
					const chunk = spool.read(position, Math.min(65536, end - position));
					inflater.push(chunk, false);
					if (inflater.err) throw Error(`Git inflate failed: ${inflater.msg}`);
					const consumed = chunk.length - inflater.strm.avail_in;
					if (consumed <= 0 || consumed > chunk.length) throw Error("Git inflater made no progress");
					position += consumed;
				}
				if (decoded !== length) throw Error("inflated Git object size mismatch");
			},
			base,
		);
	}
	if (position !== end) throw Error("unexpected bytes after Git pack objects");
	resolver.resolve();
}
