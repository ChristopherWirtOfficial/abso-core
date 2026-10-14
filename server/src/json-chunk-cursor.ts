/** Incremental UTF-16 cursor over canonical log chunks. */
export class JsonChunkCursor {
	readonly #input: Iterator<string>;
	#chunk = "";
	#offset = 0;
	constructor(chunks: Iterable<string>) {
		this.#input = chunks[Symbol.iterator]();
	}
	peek(): string | undefined {
		while (this.#offset === this.#chunk.length) {
			const next = this.#input.next();
			if (next.done) return undefined;
			if (typeof next.value !== "string" || next.value.length > 600000) throw Error("invalid JSON input chunk");
			this.#chunk = next.value;
			this.#offset = 0;
		}
		return this.#chunk[this.#offset];
	}
	take(): string {
		const char = this.peek();
		if (char === undefined) throw Error("truncated JSON input");
		this.#offset++;
		return char;
	}
	/** Consume one quoted JSON string, yielding bounded decoded text. */
	*stringChunks(): IterableIterator<string> {
		if (this.take() !== '"') throw Error("expected JSON string");
		let buffer = "";
		for (;;) {
			let char = this.take();
			if (char === '"') {
				if (buffer) yield buffer;
				return;
			}
			if (char.charCodeAt(0) < 32) throw Error("unescaped JSON control character");
			if (char === "\\") {
				const escape = this.take();
				const simple: Record<string, string> = {
					'"': '"',
					"\\": "\\",
					"/": "/",
					b: "\b",
					f: "\f",
					n: "\n",
					r: "\r",
					t: "\t",
				};
				if (escape === "u") {
					let hex = "";
					for (let i = 0; i < 4; i++) hex += this.take();
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw Error("invalid JSON Unicode escape");
					char = String.fromCharCode(Number.parseInt(hex, 16));
				} else {
					if (!Object.hasOwn(simple, escape)) throw Error("invalid JSON escape");
					char = simple[escape]!;
				}
			}
			buffer += char;
			if (buffer.length === 16384) {
				yield buffer;
				buffer = "";
			}
		}
	}
	close(): void {
		this.#input.return?.();
	}
}
