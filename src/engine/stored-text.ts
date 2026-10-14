import type { GraphStateStorage } from "./state-source.ts";

/** Exact UTF-16 text storage with bounded values; callers choose streaming or full reads. */
export class StoredText {
	static readonly chunkCharacters = 16384;
	readonly storage: GraphStateStorage;
	readonly collection: string;
	constructor(storage: GraphStateStorage, collection: string) {
		this.storage = storage;
		this.collection = collection;
	}
	write(key: string, text: string): void {
		this.writeChunks(
			key,
			(function* () {
				for (let offset = 0; offset < text.length; offset += StoredText.chunkCharacters)
					yield text.slice(offset, offset + StoredText.chunkCharacters);
			})(),
		);
	}
	/** Input pieces and the retained buffer are bounded independently of total text length. */
	writeChunks(key: string, chunks: Iterable<string>): void {
		this.storage.transaction(() => {
			if (this.storage.read(this.collection, key) !== undefined) throw Error("stored text already exists");
			let pending = "",
				characters = 0,
				parts = 0;
			const persist = (chunk: string) =>
				this.storage.write(`${this.collection}:chunks`, JSON.stringify([key, parts++]), chunk);
			for (const chunk of chunks) {
				if (typeof chunk !== "string" || chunk.length > StoredText.chunkCharacters)
					throw Error("stored text input chunk exceeds bound");
				characters += chunk.length;
				if (!Number.isSafeInteger(characters)) throw Error("stored text length overflow");
				pending += chunk;
				if (pending.length >= StoredText.chunkCharacters) {
					persist(pending.slice(0, StoredText.chunkCharacters));
					pending = pending.slice(StoredText.chunkCharacters);
				}
			}
			if (pending) persist(pending);
			this.storage.write(this.collection, key, { format: 1, characters, parts });
		});
	}

	*chunks(key: string): IterableIterator<string> {
		const header = this.storage.read(this.collection, key) as
			| { format: number; characters: number; parts: number }
			| undefined;
		if (
			header?.format !== 1 ||
			!Number.isSafeInteger(header.characters) ||
			header.characters < 0 ||
			header.parts !== Math.ceil(header.characters / StoredText.chunkCharacters)
		)
			throw Error("invalid stored text header");
		for (let part = 0; part < header.parts; part++) {
			const chunk = this.storage.read(`${this.collection}:chunks`, JSON.stringify([key, part]));
			if (
				typeof chunk !== "string" ||
				chunk.length !== Math.min(StoredText.chunkCharacters, header.characters - part * StoredText.chunkCharacters)
			)
				throw Error("incomplete stored text");
			yield chunk;
		}
	}
	read(key: string): string {
		return [...this.chunks(key)].join("");
	}
}
