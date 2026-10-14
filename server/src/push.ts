// Out to Artifacts (#8): shared's files as one git commit on main of the
// project's repo, with the publish message and the agent as author. The repo
// is created on first use. isomorphic-git works in an in-memory filesystem:
// a depth-1 clone of main with nothing checked out, then a new tree from
// shared's files that compresses and writes only what changed (abso issue 293).
import { createHash } from "node:crypto";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { FileModes } from "../../worker/project/project-api.ts";
import type { SqliteStorage } from "./engine-project.ts";
import { GitDiskIntake } from "./git-disk-intake.ts";
import { GitFileContents } from "./git-file-contents.ts";
import { gitHttp } from "./git-http.ts";
import { MemoryFS } from "./memory-fs.ts";

export interface PushResult {
	repo: string;
	remote: string;
	commit: string;
	version: number;
	ms: number;
}

/** New blob bytes per push before the push out splits into parts: Artifacts refuses a push much over 20 MB. */
const PUSH_BATCH = 16 * 1024 * 1024;

/** A file as a tree entry holds it: its blob and its mode ("100644", "100755", "120000"). */
export interface TreeFile {
	oid: string;
	mode: string;
}

/** Every file in a tree, and every folder's tree oid ("" is the root), read from tree objects only. */
export async function readTreeFiles(
	fs: MemoryFS,
	dir: string,
	oid: string,
	prefix = "",
	files = new Map<string, TreeFile>(),
	trees = new Map<string, string>(),
	cache?: object,
): Promise<{ files: Map<string, TreeFile>; trees: Map<string, string> }> {
	trees.set(prefix, oid);
	const { tree } = await git.readTree({ fs, dir, oid, cache });
	for (const e of tree) {
		const path = prefix === "" ? e.path : `${prefix}/${e.path}`;
		if (e.type === "tree") await readTreeFiles(fs, dir, e.oid, path, files, trees, cache);
		else if (e.type === "blob") files.set(path, { oid: e.oid, mode: e.mode });
	}
	return { files, trees };
}

/**
 * Hash the Git header and content separately so export does not allocate a second whole-file buffer.
 */
export async function blobOid(bytes: Uint8Array): Promise<string> {
	return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

const parentOf = (path: string) => {
	const cut = path.lastIndexOf("/");
	return cut < 0 ? "" : path.slice(0, cut);
};

/**
 * The tree for `files`, written bottom up. A folder with nothing changed under it keeps its old tree oid (`before`),
 * so only the folders on a changed path are written again.
 */
export async function writeTrees(
	fs: MemoryFS,
	dir: string,
	files: Map<string, TreeFile>,
	before: Map<string, string>,
	changed: Set<string>,
): Promise<string> {
	const dirty = new Set<string>([""]);
	for (const path of changed) for (let d = parentOf(path); d !== ""; d = parentOf(d)) dirty.add(d);
	type Entry = { mode: string; oid: string; type: "blob" | "tree" };
	const kids = new Map<string, Map<string, Entry>>([["", new Map()]]);
	const folder = (d: string) => {
		let k = kids.get(d);
		if (!k) {
			kids.set(d, (k = new Map()));
			if (d !== "") folder(parentOf(d));
		}
		return k;
	};
	for (const [path, f] of files)
		folder(parentOf(path)).set(path.slice(path.lastIndexOf("/") + 1), { ...f, type: "blob" });
	// Deepest first, so a folder's subfolders have their oids before it is written.
	const depth = (d: string) => (d === "" ? 0 : d.split("/").length);
	const order = [...kids.keys()].sort((a, b) => depth(b) - depth(a));
	let root = "";
	for (const d of order) {
		const old = before.get(d);
		const oid =
			old !== undefined && !dirty.has(d)
				? old
				: await git.writeTree({ fs, dir, tree: [...kids.get(d)!].map(([path, e]) => ({ path, ...e })) });
		if (d === "") root = oid;
		else folder(parentOf(d)).set(d.slice(d.lastIndexOf("/") + 1), { mode: "040000", oid, type: "tree" });
	}
	return root;
}

/**
 * A project's Artifacts repo: abso-<project>. Project names are letters, digits, ".", "_" and "-" (validName), which
 * repo names take as they are.
 */
export function repoName(project: string): string {
	return `abso-${project}`;
}

/** The project one of our repos holds, or null for a repo that isn't ours. */
export function projectOfRepo(repo: string): string | null {
	return repo.startsWith("abso-") && repo.length > "abso-".length ? repo.slice("abso-".length) : null;
}

/** The repo's remote and a write token good for `seconds`, creating the repo if it's new. */
export async function writeAccess(
	artifacts: Artifacts,
	name: string,
	seconds = 600,
): Promise<{ remote: string; secret: string }> {
	try {
		using repo = await artifacts.get(name);
		const [info, token] = await Promise.all([repo.info(), repo.createToken("write", seconds)]);
		return { remote: info!.remote, secret: token.plaintext.split("?expires=")[0]! };
	} catch {
		const created = await artifacts.create(name, { description: `abso project ${name}`, setDefaultBranch: "main" });
		return { remote: created.remote, secret: created.token.split("?expires=")[0]! };
	}
}

export interface SharedFiles {
	version: number;
	files: Record<string, string>;
	modes?: FileModes;
	blobs?: Record<string, string>;
	last?: { agent: string; message: string };
}

/**
 * Shared's files as commits on top of `head` (null: a repo with no main yet), in the repo at `dir`. `part` is called
 * with each earlier part's commit when the new blobs are too big for one push. Answers the last commit and how many
 * paths changed.
 */
export async function commitShared(
	fs: MemoryFS,
	dir: string,
	head: string | null,
	shared: SharedFiles,
	readBlob: (sha256: string) => Uint8Array | null,
	part: (commit: string) => Promise<void> = async () => {},
	cache?: object,
): Promise<{ commit: string; changed: number }> {
	const old = head
		? await readTreeFiles(
				fs,
				dir,
				(await git.readCommit({ fs, dir, oid: head, cache })).commit.tree,
				"",
				new Map(),
				new Map(),
				cache,
			)
		: { files: new Map<string, TreeFile>(), trees: new Map<string, string>() };
	const blobs = shared.blobs ?? {};
	const now = new Map<string, TreeFile>();
	const changed = new Set<string>();
	for (const path of old.files.keys()) if (!(path in shared.files) && !(path in blobs)) changed.add(path);
	// A file whose blob and mode match the last push keeps its entry; only a new blob is compressed and written.
	const put = async (path: string, bytes: Uint8Array, mode: string, oid: string) => {
		const was = old.files.get(path);
		if (was?.oid !== oid) await git.writeBlob({ fs, dir, blob: bytes });
		if (was?.oid !== oid || was.mode !== mode) changed.add(path);
		now.set(path, { oid, mode });
	};
	// Each file goes into the tree as a blob with its mode (#27): 100755 for exec, 120000 for a link, whose blob is
	// its target.
	const enc = new TextEncoder();
	const agent = shared.last?.agent ?? "abso";
	const author = { name: agent, email: `${agent}@abso.invalid` };
	const committer = { name: "abso", email: "abso@abso.invalid" };
	const say = (p: string) => `${shared.last?.message ?? "Start the project"}${p}\n\nabso-version: ${shared.version}\n`;
	let parent = head;
	// A part holds what's written so far and preserves old entries for files not reached yet.
	const commitNow = async (message: string) => {
		const files = new Map(now);
		for (const [path, f] of old.files)
			if (!files.has(path) && (path in blobs || path in shared.files)) files.set(path, f);
		const tree = await writeTrees(fs, dir, files, old.trees, changed);
		parent = await git.commit({
			cache,
			fs,
			dir,
			message,
			author,
			committer,
			tree,
			parent: parent ? [parent] : [],
			ref: "main",
		});
		return parent;
	};
	// Artifacts refuses a push much over 20 MB, so when new text or binary blobs add up
	// to more than PUSH_BATCH, the earlier ones go in commits of their own
	// first. Every part carries abso-version, so intake never takes them in.
	let pending = 0;
	let parts = 0;
	for (const path of Object.keys(shared.files)) {
		const mode = shared.modes?.[path];
		const link = typeof mode?.link === "string" ? mode.link : null;
		const bytes = enc.encode(link ?? shared.files[path]!);
		const oid = await blobOid(bytes);
		const fresh = old.files.get(path)?.oid !== oid;
		if (fresh && pending > 0 && pending + bytes.byteLength > PUSH_BATCH) {
			await part(await commitNow(say(` (part ${++parts})`)));
			pending = 0;
		}
		if (fresh) pending += bytes.byteLength;
		await put(path, bytes, link !== null ? "120000" : mode?.exec ? "100755" : "100644", oid);
	}
	for (const [path, sha] of Object.entries(blobs)) {
		const bytes = readBlob(sha);
		if (!bytes) throw new Error(`${path}: blob ${sha} is missing from the project's store`);
		const oid = await blobOid(bytes);
		const fresh = old.files.get(path)?.oid !== oid;
		if (fresh && pending > 0 && pending + bytes.byteLength > PUSH_BATCH) {
			await part(await commitNow(say(` (part ${++parts})`)));
			pending = 0;
		}
		if (fresh) pending += bytes.byteLength;
		await put(path, bytes, shared.modes?.[path]?.exec ? "100755" : "100644", oid);
	}
	const commit = await commitNow(say(parts > 0 ? ` (part ${parts + 1}, last)` : ""));
	return { commit, changed: changed.size };
}

export async function pushShared(
	artifacts: Artifacts,
	project: string,
	shared: SharedFiles,
	/** A binary file's bytes by SHA-256 (#27), from the project's blob store. */
	readBlob: (sha256: string) => Uint8Array | null = () => null,
	disk?: { storage: SqliteStorage; maxPackBytes: number; maxObjectBytes: number; maxDecodedBytes: number },
): Promise<PushResult> {
	const t0 = Date.now();
	const name = repoName(project);
	const { remote, secret } = await writeAccess(artifacts, name);
	const onAuth = () => ({ username: "x", password: secret });
	using contents = disk ? new GitFileContents(disk.storage, disk.maxObjectBytes, disk.maxDecodedBytes) : undefined;
	using intake = disk
		? new GitDiskIntake(disk.storage, disk.maxPackBytes, disk.maxObjectBytes, disk.maxDecodedBytes)
		: undefined;
	const cache = disk ? {} : undefined;
	if (intake && cache) intake.attach(cache);
	const transport = disk ? gitHttp() : http;
	let fs = new MemoryFS(contents);
	const dir = "/repo";
	// A new repo has no main yet. isomorphic-git "clones" an empty repo without
	// an error but leaves HEAD on master, so check for main and start clean.
	// Nothing is checked out: the new tree is built from tree objects (293).
	// Only an explicitly absent main is an empty repository. Transport, decode,
	// and size failures must never become permission to replace remote history.
	const refs = await git.listServerRefs({ http: transport, url: remote, onAuth, prefix: "refs/heads/main" });
	let head: string | null = null;
	if (refs.some((ref) => ref.ref === "refs/heads/main")) {
		await git.clone({
			fs,
			http: transport,
			cache,
			dir,
			url: remote,
			ref: "main",
			singleBranch: true,
			depth: 1,
			noCheckout: true,
			onAuth,
		});
		intake?.assertReady();
		head = await git.resolveRef({ fs, dir, ref: "main" });
	}
	if (head === null) {
		fs = new MemoryFS(contents);
		await git.init({ fs, dir, defaultBranch: "main" });
	}
	const t1 = Date.now();
	const push = () => git.push({ fs, http: transport, cache, dir, url: remote, ref: "main", remoteRef: "main", onAuth });
	const { commit, changed } = await commitShared(
		fs,
		dir,
		head,
		shared,
		readBlob,
		async () => void (await push()),
		cache,
	);
	const t2 = Date.now();
	await push();
	console.log(
		`push ${project} v${shared.version}: clone ${t1 - t0} ms, files ${t2 - t1} ms (${changed} changed), push ${Date.now() - t2} ms`,
	);
	return { repo: name, remote, commit, version: shared.version, ms: Date.now() - t0 };
}
