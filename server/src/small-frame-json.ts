import { jsonEvents } from "./json-events.ts";

/** Decode a small canonical frame with the same validation as the streamed path. */
export function smallFrameJson(chunks: Iterable<string>): unknown {
	let text = "";
	for (const chunk of chunks) {
		if (text.length + chunk.length > 4096) throw Error("small canonical frame exceeds bound");
		text += chunk;
	}
	// Count UTF-8 after joining so a surrogate pair split across chunks counts once.
	if (new TextEncoder().encode(text).byteLength > 4096) throw Error("small canonical frame exceeds bound");
	// Preserve depth, key and scalar limits; the fast path must not change acceptance.
	for (const event of jsonEvents([text])) void event;
	return JSON.parse(text);
}
