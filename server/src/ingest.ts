// In from plain git (#8, demo moment 5): commits a person pushed to the
// project's Artifacts repo, read back for project.ingest. Every commit the
// Worker pushes ends "abso-version: N" ("avcs-version: N" before the rename); the commits above the newest such
// commit that haven't been taken in yet are the person's, and N is their base.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { FileModes } from "../../worker/project/project-api.ts";
import { MemoryFS } from "./memory-fs.ts";
import { repoName } from "./push.ts";

const EXEC = 0o100755;
const LINK = 0o120000;

/** How far back to look for the Worker's last commit. */
const DEPTH = 50;
const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export interface PushedCommits {
	/** main's head when read. */
	head: string;
	author: string;
	base: number;
	/** Oldest first, each with its whole tree as text and every file's mode. Binary files are left out. */
	commits: {
		sha: string;
		message: string;
		files: Record<string, string>;
		modes: FileModes;
		blobs: Record<string, string>;
	}[];
	/** Binary files over the blob limit, left out of the commits. */
	tooBig: string[];
}

export function absoVersion(message: string): number | undefined {
	const m = /^(?:abso|avcs)-version: (\d+)\s*$/m.exec(message);
	return m ? Number(m[1]) : undefined;
}

async function readAccess(
	artifacts: Artifacts,
	project: string,
): Promise<{ url: string; onAuth: () => { username: string; password: string } } | null> {
	let repo: Awaited<ReturnType<Artifacts["get"]>>;
	try {
		repo = await artifacts.get(repoName(project));
	} catch {
		return null;
	}
	using r = repo;
	const [info, token] = await Promise.all([r.info(), r.createToken("read", 600)]);
	const password = token.plaintext.split("?expires=")[0]!;
	return { url: info!.remote, onAuth: () => ({ username: "x", password }) };
}

/** main's head on the project's repo, or null when there's no repo or no main yet. Cheap: one ref listing. */
export async function remoteHead(artifacts: Artifacts, project: string): Promise<string | null> {
	const access = await readAccess(artifacts, project);
	if (!access) return null;
	const refs = await git.listServerRefs({ http, url: access.url, onAuth: access.onAuth, prefix: "refs/heads/main" });
	return refs.find((r) => r.ref === "refs/heads/main")?.oid ?? null;
}

/**
 * The commits pushed since `seen` (the last head this project handled), or
 * none when every commit above the Worker's last one has been seen.
 */
/** Stores a binary file's bytes and answers their SHA-256, or null when they're over the limit. */
export type StoreBlob = (bytes: Uint8Array) => Promise<string | null>;

/**
 * `oldBlob` gives shared's blob for a path: a binary file over the limit
 * keeps it, since a path missing from a commit would mean the file was deleted.
 */
export async function pushedSince(
	artifacts: Artifacts,
	project: string,
	seen: string | undefined,
	storeBlob?: StoreBlob,
	oldBlob: (path: string) => string | undefined = () => undefined,
): Promise<PushedCommits | null> {
	const access = await readAccess(artifacts, project);
	if (!access) return null;
	const fs = new MemoryFS();
	const dir = "/repo";
	await git.clone({
		fs,
		http,
		dir,
		url: access.url,
		onAuth: access.onAuth,
		ref: "main",
		singleBranch: true,
		depth: DEPTH,
		noCheckout: true,
	});
	const log = await git.log({ fs, dir, ref: "main", depth: DEPTH });
	if (log.length === 0) return null;
	const head = log[0]!.oid;
	const fresh: typeof log = [];
	let base: number | undefined;
	let past = false;
	for (const c of log) {
		if (c.oid === seen) past = true;
		base = absoVersion(c.commit.message);
		if (base !== undefined) break;
		if (!past) fresh.unshift(c);
	}
	if (base === undefined) throw new Error(`no abso-version commit in main's last ${DEPTH} commits`);
	const commits = [];
	const tooBig = new Set<string>();
	for (const c of fresh)
		commits.push({
			sha: c.oid,
			message: c.commit.message.trim(),
			...(await treeText(fs, dir, c.oid, storeBlob, tooBig, oldBlob)),
		});
	return { head, author: fresh.at(-1)?.commit.author.name ?? "git", base, commits, tooBig: [...tooBig] };
}

/**
 * A commit's whole tree as text, and every file's mode: 100755 is exec, and
 * a link (120000) is "" with its target in modes. Files that aren't UTF-8
 * are left out.
 */
async function treeText(
	fs: MemoryFS,
	dir: string,
	oid: string,
	storeBlob: StoreBlob | undefined,
	tooBig: Set<string>,
	oldBlob: (path: string) => string | undefined,
): Promise<{ files: Record<string, string>; modes: FileModes; blobs: Record<string, string> }> {
	const files: Record<string, string> = {};
	const modes: FileModes = {};
	const blobs: Record<string, string> = {};
	await git.walk({
		fs,
		dir,
		trees: [git.TREE({ ref: oid })],
		map: async (path, [entry]) => {
			if (!entry || path === ".") return true;
			if ((await entry.type()) !== "blob") return true;
			const bytes = await entry.content();
			if (!bytes) return true;
			let body: string;
			try {
				body = text.decode(bytes);
			} catch {
				// Binary (#27): the bytes go to the blob store, and the file is a pointer to them.
				const sha = storeBlob ? await storeBlob(bytes) : null;
				if (sha) {
					blobs[path] = sha;
					modes[path] = { exec: (await entry.mode()) === EXEC, link: null };
				} else if (storeBlob) {
					tooBig.add(path);
					const kept = oldBlob(path);
					if (kept) blobs[path] = kept;
				}
				return true;
			}
			const mode = await entry.mode();
			if (mode === LINK) {
				files[path] = "";
				modes[path] = { exec: false, link: body };
			} else {
				files[path] = body;
				modes[path] = { exec: mode === EXEC, link: null };
			}
			return true;
		},
	});
	return { files, modes, blobs };
}
