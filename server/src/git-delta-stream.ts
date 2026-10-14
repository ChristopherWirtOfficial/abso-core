export interface GitByteRanges {
	readonly byteLength: number;
	read(start: number, length: number): Uint8Array;
}

/** Decode without retaining the base or complete result. Caller must roll back output if decoding throws. */
export function applyGitDeltaChunks(
	delta: GitByteRanges,
	base: GitByteRanges,
	write: (chunk: Uint8Array) => void,
	maxResultBytes: number,
): number {
	if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 0) throw Error("invalid delta result limit");
	let position = 0,
		produced = 0;
	let cached: Uint8Array = new Uint8Array(0),
		cacheStart = 0;
	const byte = () => {
		if (position >= delta.byteLength) throw Error("truncated Git delta");
		if (position < cacheStart || position >= cacheStart + cached.length) {
			cacheStart = position;
			const count = Math.min(65536, delta.byteLength - position);
			cached = delta.read(position, count);
			if (cached.length !== count) throw Error("missing delta bytes");
		}
		return cached[position++ - cacheStart]!;
	};
	const integer = () => {
		let value = 0,
			multiplier = 1;
		for (let i = 0; i < 8; i++) {
			const next = byte();
			value += (next & 127) * multiplier;
			if (!Number.isSafeInteger(value)) throw Error("Git delta integer overflow");
			if (!(next & 128)) return value;
			multiplier *= 128;
		}
		throw Error("Git delta integer overflow");
	};
	if (integer() !== base.byteLength) throw Error("Git delta base length mismatch");
	const size = integer();
	if (size > maxResultBytes) throw Error("Git delta result exceeds bound");
	const emit = (chunk: Uint8Array) => {
		if (produced + chunk.length > size) throw Error("Git delta result length mismatch");
		write(chunk);
		produced += chunk.length;
	};
	while (position < delta.byteLength) {
		const instruction = byte();
		if (instruction & 128) {
			let offset = 0,
				length = 0;
			for (let i = 0; i < 4; i++) if (instruction & (1 << i)) offset += byte() * 2 ** (8 * i);
			for (let i = 0; i < 3; i++) if (instruction & (16 << i)) length += byte() * 2 ** (8 * i);
			if (!length) length = 65536;
			if (offset + length > base.byteLength) throw Error("Git delta copy exceeds base");
			if (produced + length > size) throw Error("Git delta result length mismatch");
			for (let at = 0; at < length; at += 65536) {
				const count = Math.min(65536, length - at),
					chunk = base.read(offset + at, count);
				if (chunk.length !== count) throw Error("missing delta base bytes");
				emit(chunk);
			}
		} else {
			if (!instruction) throw Error("invalid Git delta instruction");
			const literal = new Uint8Array(instruction);
			for (let i = 0; i < instruction; i++) literal[i] = byte();
			emit(literal);
		}
	}
	if (produced !== size) throw Error("Git delta result length mismatch");
	return size;
}
