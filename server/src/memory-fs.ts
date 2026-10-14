// From Cloudflare's isomorphic-git example, with fixes isomorphic-git 1.43
// needs: errors carry .code (isomorphic-git checks err.code === "ENOENT"),
// stats are plain fields it can normalize in place, and the executable bit
// and symbolic links are kept (#27), so a checkout of a repo with either works.

function fsError(code: string, path: string): Error {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

type Entry =
	| { kind: "dir"; children: Set<string>; mtimeMs: number }
	| { kind: "file"; data: Uint8Array; byteLength?: number; exec: boolean; mtimeMs: number }
	| { kind: "link"; target: string; mtimeMs: number };

const enc = new TextEncoder();

/** Optional scratch storage for file contents; directory metadata remains in memory. */
export interface FileContents {
	write(path: string, bytes: Uint8Array): void;
	read(path: string): Uint8Array;
	remove(path: string): void;
}

/** Plain fields, not getters: isomorphic-git writes to them when it normalizes stats. */
class MemoryStats {
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	mode: number;
	private kind: Entry["kind"];

	constructor(entry: Entry) {
		this.kind = entry.kind;
		this.size =
			entry.kind === "file"
				? (entry.byteLength ?? entry.data.byteLength)
				: entry.kind === "link"
					? enc.encode(entry.target).byteLength
					: 0;
		this.mtimeMs = entry.mtimeMs;
		this.ctimeMs = entry.mtimeMs;
		this.mode = entry.kind === "dir" ? 0o040000 : entry.kind === "link" ? 0o120000 : entry.exec ? 0o100755 : 0o100644;
	}

	isFile() {
		return this.kind === "file";
	}

	isDirectory() {
		return this.kind === "dir";
	}

	isSymbolicLink() {
		return this.kind === "link";
	}
}

export class MemoryFS {
	private readonly contents?: FileContents;
	constructor(contents?: FileContents) {
		this.contents = contents;
	}
	encoder = new TextEncoder();
	decoder = new TextDecoder();
	entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);

	promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.lstat.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
		chmod: this.chmod.bind(this),
	};

	normalize(input: string) {
		const segments: string[] = [];

		for (const part of input.split("/")) {
			if (!part || part === ".") {
				continue;
			}

			if (part === "..") {
				segments.pop();
				continue;
			}

			segments.push(part);
		}

		return `/${segments.join("/")}` || "/";
	}

	parent(path: string) {
		const normalized = this.normalize(path);
		if (normalized === "/") {
			return "/";
		}

		const parts = normalized.split("/").filter(Boolean);
		parts.pop();
		return parts.length ? `/${parts.join("/")}` : "/";
	}

	basename(path: string) {
		return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
	}

	getEntry(path: string) {
		return this.entries.get(this.normalize(path));
	}

	requireEntry(path: string) {
		const entry = this.getEntry(path);
		if (!entry) {
			throw fsError("ENOENT", path);
		}

		return entry;
	}

	requireDir(path: string) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "dir") {
			throw fsError("ENOTDIR", path);
		}

		return entry;
	}

	async mkdir(path: string, options?: { recursive?: boolean } | number) {
		const target = this.normalize(path);
		if (target === "/") {
			return;
		}

		const recursive = typeof options === "object" && options !== null && options.recursive;
		const parent = this.parent(target);

		if (!this.entries.has(parent)) {
			if (!recursive) {
				throw fsError("ENOENT", parent);
			}

			await this.mkdir(parent, { recursive: true });
		}

		if (this.entries.has(target)) {
			return;
		}

		this.entries.set(target, {
			kind: "dir",
			children: new Set(),
			mtimeMs: Date.now(),
		});

		this.requireDir(parent).children.add(this.basename(target));
	}

	/** options.mode with any execute bit (isomorphic-git passes 0o777 for 100755) makes the file executable. */
	async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: string | { mode?: number }) {
		const target = this.normalize(path);
		await this.mkdir(this.parent(target), { recursive: true });

		const bytes =
			typeof data === "string" ? this.encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
		const mode = typeof options === "object" && options !== null ? options.mode : undefined;
		this.contents?.write(target, bytes);

		this.entries.set(target, {
			kind: "file",
			data: this.contents ? new Uint8Array(0) : bytes,
			...(this.contents ? { byteLength: bytes.byteLength } : {}),
			exec: mode !== undefined && (mode & 0o111) !== 0,
			mtimeMs: Date.now(),
		});

		this.requireDir(this.parent(target)).children.add(this.basename(target));
	}

	async readFile(path: string, options?: string | { encoding?: string }) {
		const entry = this.requireEntry(path);
		if (entry.kind === "dir") {
			throw fsError("EISDIR", path);
		}

		const data =
			entry.kind === "link"
				? this.encoder.encode(entry.target)
				: this.contents
					? this.contents.read(this.normalize(path))
					: entry.data;
		const encoding = typeof options === "string" ? options : options?.encoding;
		return encoding ? this.decoder.decode(data) : data;
	}

	async readdir(path: string) {
		return [...this.requireDir(path).children].sort();
	}

	async unlink(path: string) {
		const target = this.normalize(path);
		const entry = this.requireEntry(target);
		if (entry.kind === "dir") {
			throw fsError("EISDIR", path);
		}

		if (entry.kind === "file") this.contents?.remove(target);
		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async rmdir(path: string) {
		const target = this.normalize(path);
		const entry = this.requireDir(target);
		if (entry.children.size > 0) {
			throw fsError("ENOTEMPTY", path);
		}

		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async stat(path: string) {
		return new MemoryStats(this.requireEntry(path));
	}

	/** Links aren't followed anywhere here, so lstat and stat agree. */
	async lstat(path: string) {
		return this.stat(path);
	}

	async readlink(path: string): Promise<string> {
		const entry = this.requireEntry(path);
		if (entry.kind !== "link") throw fsError("EINVAL", path);
		return entry.target;
	}

	async symlink(target: string, path: string): Promise<void> {
		const at = this.normalize(path);
		if (this.entries.has(at)) throw fsError("EEXIST", path);
		await this.mkdir(this.parent(at), { recursive: true });
		this.entries.set(at, { kind: "link", target, mtimeMs: Date.now() });
		this.requireDir(this.parent(at)).children.add(this.basename(at));
	}

	async chmod(path: string, mode: number): Promise<void> {
		const entry = this.requireEntry(path);
		if (entry.kind === "file") entry.exec = (mode & 0o111) !== 0;
	}
}
