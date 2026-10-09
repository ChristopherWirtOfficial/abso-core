// A small tar writer (POSIX ustar, with pax headers for long paths), so
// `abso run` can send the folder without a dependency. Gzipped with node:zlib.

import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;
const ENCODER = new TextEncoder();

export interface TarEntry {
	readonly path: string;
	readonly data: Uint8Array;
	/** Unix permission bits; 0o644 unless given. */
	readonly mode?: number;
	/** A symbolic link to this target (data is then empty). */
	readonly link?: string;
}

function octal(value: number, width: number): string {
	// width includes the terminating NUL.
	return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, mode: number, type: string, prefix = "", linkname = ""): Uint8Array {
	const h = new Uint8Array(BLOCK);
	const put = (offset: number, text: string): void => {
		h.set(ENCODER.encode(text), offset);
	};
	put(0, name);
	put(100, octal(mode, 8));
	put(108, octal(0, 8));
	put(116, octal(0, 8));
	put(124, octal(size, 12));
	put(136, octal(0, 12));
	put(148, "        ");
	put(156, type);
	put(157, linkname);
	put(257, "ustar\0");
	put(263, "00");
	put(345, prefix);
	let sum = 0;
	for (const b of h) sum += b;
	put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
	return h;
}

/** Split a path into ustar's prefix (155 bytes) and name (100 bytes), or undefined when it doesn't fit. */
function splitPath(path: string): { name: string; prefix: string } | undefined {
	if (ENCODER.encode(path).length <= 100) return { name: path, prefix: "" };
	for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
		const prefix = path.slice(0, i);
		const name = path.slice(i + 1);
		if (ENCODER.encode(prefix).length <= 155 && ENCODER.encode(name).length <= 100) return { name, prefix };
	}
	return undefined;
}

function padded(data: Uint8Array): Uint8Array[] {
	const rest = data.length % BLOCK;
	return rest === 0 ? [data] : [data, new Uint8Array(BLOCK - rest)];
}

/** A pax record "<len> path=<path>\n", where len counts the whole record. */
function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let len = ENCODER.encode(body).length + 1;
	while (String(len).length + ENCODER.encode(body).length !== len) len++;
	return `${len}${body}`;
}

export function tar(entries: readonly TarEntry[]): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const entry of entries) {
		const link = entry.link;
		const mode = entry.mode ?? (link === undefined ? 0o644 : 0o777);
		const type = link === undefined ? "0" : "2";
		const data = link === undefined ? entry.data : new Uint8Array(0);
		const split = splitPath(entry.path);
		const longLink = link !== undefined && ENCODER.encode(link).length > 100;
		if (split === undefined || longLink) {
			const pax = ENCODER.encode(
				(split === undefined ? paxRecord("path", entry.path) : "") + (longLink ? paxRecord("linkpath", link) : ""),
			);
			parts.push(header("PaxHeader", pax.length, 0o644, "x"), ...padded(pax));
		}
		const name = split ? split.name : entry.path.slice(-100).replace(/^[^/]*\//, "");
		parts.push(header(name, data.length, mode, type, split?.prefix ?? "", link !== undefined && !longLink ? link : ""));
		parts.push(...padded(data));
	}
	parts.push(new Uint8Array(BLOCK * 2));
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

export function tarGz(entries: readonly TarEntry[]): Uint8Array<ArrayBuffer> {
	return new Uint8Array(gzipSync(tar(entries)));
}

/**
 * The files and links in a tar.gz (abso fetch reads the box's files back).
 * Folders and other kinds are passed over; pax headers give long paths and
 * link targets.
 */
export function untarGz(gz: Uint8Array): TarEntry[] {
	const data = gunzipSync(gz);
	const text = (from: number, len: number): string =>
		new TextDecoder().decode(data.subarray(from, from + len)).replace(/\0[\s\S]*$/, "");
	const out: TarEntry[] = [];
	let pax: Record<string, string> = {};
	for (let at = 0; at + BLOCK <= data.length; ) {
		if (data.subarray(at, at + BLOCK).every((b) => b === 0)) break;
		const name = text(at, 100);
		const mode = parseInt(text(at + 100, 8).trim() || "644", 8);
		const size = parseInt(text(at + 124, 12).trim() || "0", 8);
		const type = text(at + 156, 1);
		const linkname = text(at + 157, 100);
		const prefix = text(at + 345, 155);
		const body = data.subarray(at + BLOCK, at + BLOCK + size);
		at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
		if (type === "x") {
			// Records of "<len> key=value\n".
			pax = {};
			for (const m of new TextDecoder().decode(body).matchAll(/\d+ ([^=\n]+)=([^\n]*)\n/g)) pax[m[1]!] = m[2]!;
			continue;
		}
		if (type === "g") continue;
		const path = (pax.path ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, "");
		if (type === "0" || type === "" || type === "7") out.push({ path, data: new Uint8Array(body), mode: mode & 0o777 });
		else if (type === "2") out.push({ path, data: new Uint8Array(0), link: pax.linkpath ?? linkname });
		pax = {};
	}
	return out;
}
