// Binary files (#27): content-addressed blobs. The server keeps a binary
// file's bytes by their SHA-256 (PUT and GET /p/:project/blobs/<sha256>), and
// the file in the graph points at that hash. The client keeps the hash it
// knows for each binary file in .avcs/blobs.json, as it keeps the known copy
// of a text file, and uploads only a hash the server hasn't been told about.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./folder.ts";
import { stateDir } from "./state-dir.ts";

/** The server's limit for one file's bytes. */
export const MAX_BLOB_BYTES = 20 * 1024 * 1024;

const BLOBS_FILE = "blobs.json";

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Whether normalized text is the file the server keeps whole under `sha`
 * (#46): a text file matching avcs.json's "whole", or over 1 MB, is stored
 * like a binary file, by the hash of its text with LF endings. The client
 * keeps that hash in blobs.json, and the file on disk stays text.
 */
export function keptWholeAs(text: string, sha: string | undefined): boolean {
	return sha !== undefined && sha256(Buffer.from(text, "utf8")) === sha;
}

/** A file's bytes and their hash, or undefined when it is gone; `tooBig` when over the server's limit (bytes not read). */
export function blobOf(
	path: string,
): { sha: string; bytes: Uint8Array; size: number } | { tooBig: true; size: number } | undefined {
	try {
		const size = statSync(path).size;
		if (size > MAX_BLOB_BYTES) return { tooBig: true, size };
		const bytes = readFileSync(path);
		return { sha: sha256(bytes), bytes, size };
	} catch {
		return undefined;
	}
}

/** The binary files the server has, as far as the client knows: path -> sha256. */
export function readKnownBlobs(root: string): Map<string, string> {
	try {
		return new Map(
			Object.entries(JSON.parse(readFileSync(join(stateDir(root), BLOBS_FILE), "utf8")) as Record<string, string>),
		);
	} catch {
		return new Map();
	}
}

export function writeKnownBlobs(root: string, blobs: ReadonlyMap<string, string>): void {
	const sorted = Object.fromEntries([...blobs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	writeFileAtomic(join(stateDir(root), BLOBS_FILE), `${JSON.stringify(sorted, null, 1)}\n`);
}

/** Short form of a hash for people: the first 12 hex digits. */
export function shortSha(sha: string | null | undefined): string {
	return sha ? sha.slice(0, 12) : "(none)";
}
