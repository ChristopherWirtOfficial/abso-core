// abso init and abso join: start a project from a folder, or join one into a folder.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Api, ApiError } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { writeKnownBlobs } from "./blobs.ts";
import { defaultAgentName, mintFreeName, mintKey, readBox } from "./box.ts";
import { STARTING_ABSOIGNORE } from "./check-ignore.ts";
import { CLIENT_DIR } from "./client-version.ts";
import { type Env, type Output, plural } from "./command-env.ts";
import { leftOutText, syncFolder, uploadBlobs } from "./commands.ts";
import { findRoot, installKey, readConfig, type Settings, tokenFor, writeConfig } from "./config.ts";
import { elsewhereText } from "./doctor.ts";
import { fromEnv } from "./env-names.ts";
import { clearKnown, loadIgnore, readFolder, writeKnown } from "./folder.ts";
import { modInstalled } from "./install.ts";
import { type FullMode, foldModes, writeKnownModes } from "./modes.ts";
import { siteOf } from "./orgs.ts";
import { projectFileName, readProjectFile, startingProjectFileText, writeStartingProjectFile } from "./project-file.ts";
import { refusedText } from "./safety.ts";
import { chooseServer, serverFlag } from "./server-choice.ts";
import { OLD_STATE_DIR, STATE_DIR, stateDir } from "./state-dir.ts";

/** The server to join or start on, in the order every command picks one (server-choice.ts chooseServer). */
export function serverFrom(args: Parsed, env: Pick<Env, "env" | "cwd">): string {
	return chooseServer(serverFlag(args), env.cwd, env.env);
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function agentFrom(args: Parsed, named?: string): string {
	const agent = named ?? str(args, "agent");
	if (!agent) throw new UsageError("give this folder's agent name with --agent <name>");
	if (!NAME.test(agent))
		throw new UsageError(`agent names are letters, digits, dot, dash and underscore (got ${JSON.stringify(agent)})`);
	return agent;
}

function makeSettings(args: Parsed, env: Env, project: string): Settings {
	return { server: serverFrom(args, env), project, agent: agentFrom(args) };
}

export async function runInit(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length > 1) throw new UsageError("init takes one folder");
	const root = resolve(env.cwd, args.positionals[0] ?? ".");
	if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`${root} is not a folder`);
	if (findRoot(root) === root) throw new UsageError(`${root} already has .abso/config.json`);
	const project = str(args, "project");
	if (!project) throw new UsageError("give the project a name with --project <name>");
	const config = makeSettings(args, env, project);
	const asIs = bool(args, "as-is");
	const absoignore = join(root, ".absoignore");
	const wroteIgnore = !asIs && !existsSync(absoignore) && !existsSync(join(root, ".avcsignore"));
	if (wroteIgnore) writeFileSync(absoignore, STARTING_ABSOIGNORE);
	// What the server runs on each new version (#39), guessed from package.json; recorded with the rest.
	const wroteProject = asIs ? "exists" : writeStartingProjectFile(root);
	const { files, blobs, modes, leftOut } = readFolder(root, loadIgnore(root));
	const token = tokenFor(config.server, env.env);
	const api = new Api({ ...config, ...(token ? { token } : {}) });
	await uploadBlobs(api, blobs);
	const answer = await api.init(
		Object.fromEntries(files),
		modes,
		Object.fromEntries([...blobs].map(([rel, b]) => [rel, b.sha])),
	);
	writeConfig(root, config);
	clearKnown(root);
	for (const [rel, text] of files) writeKnown(root, rel, text);
	writeKnownBlobs(root, new Map([...blobs].map(([rel, b]) => [rel, b.sha])));
	const knownModes = new Map<string, FullMode>();
	foldModes(knownModes, modes);
	writeKnownModes(root, knownModes);
	const synced = await syncFolder(root, api);
	return {
		text: [
			`Created project ${project} at version ${answer.version} from ${plural(files.size, "text file")} in ${root}.`,
			...leftOutText(leftOut),
			...(wroteIgnore
				? ["Wrote a starting .absoignore (Claude Code state and operating system files); edit it like .gitignore."]
				: []),
			...startingProjectFileText(wroteProject),
			...(answer.skipped && answer.skipped.length > 0 ? [`The server skipped: ${answer.skipped.join(", ")}.`] : []),
			`This folder is agent ${config.agent}. Settings are in .abso/config.json.`,
			...refusedText(synced.refused),
			...(synced.kept.length > 0 ? [`Kept your copy of ${synced.kept.join(", ")}.`] : []),
			hookHint(env.env),
		].join("\n"),
		json: {
			project,
			version: answer.version,
			files: files.size,
			root,
			agent: config.agent,
			wroteAbsoignore: wroteIgnore,
			wroteProjectFile: typeof wroteProject === "string" ? null : wroteProject,
			leftOut,
		},
	};
}

/**
 * Where abso join writes: --dir, else here when --agent is given (as before, so a folder prepared with
 * abso key install --server is joined where its key is). With no --agent: here when this folder is empty, else
 * ./<project>, which has to be new or empty so nobody's files are written over. A folder holding only abso's own
 * state folder counts as empty.
 */
export function joinFolder(args: Parsed, env: Pick<Env, "cwd">, project: string): string {
	const dir = str(args, "dir");
	if (dir !== undefined) return resolve(env.cwd, dir);
	if (str(args, "agent") !== undefined) return resolve(env.cwd);
	const empty = (path: string) => readdirSync(path).every((name) => name === STATE_DIR || name === OLD_STATE_DIR);
	if (empty(env.cwd)) return resolve(env.cwd);
	const sub = resolve(env.cwd, project);
	if (existsSync(sub) && (!statSync(sub).isDirectory() || !empty(sub)))
		throw new UsageError(`${sub} already has files in it: say where to join with --dir <folder>`);
	return sub;
}

/** Signed out, the server doesn't say who owns a project, and the website puts every project under this one owner for now. */
const SITE_OWNER = "christopher";

/**
 * Whether anyone can read the project: its status answers with no credentials. Only the answer's code
 * counts, never its body, and no redirect is followed. A private project and a missing one look the same.
 */
export async function isPublic(server: string, project: string): Promise<boolean> {
	try {
		const response = await fetch(new URL(`/p/${encodeURIComponent(project)}/status`, server), {
			redirect: "error",
			signal: AbortSignal.timeout(3000),
		});
		return response.status === 200;
	} catch {
		return false;
	}
}

/**
 * Why a join failed signed out. Without --reader, the client reads only as an agent, which needs a
 * sign-in; a public project is read signed out on the website, or with abso join --reader.
 */
async function signedOut(server: string, project: string): Promise<string> {
	return (await isPublic(server, project))
		? `${project} is public: read it at ${siteOf(server)}/${SITE_OWNER}/${project} (every page is also JSON), or here with abso join ${project} --reader. To work on it: abso login.`
		: `This box isn't signed in to ${server}. abso login signs it in.${elsewhereText(server, `abso join ${project}`)}`;
}

/** A folder that reads a public project signed out: no agent, no key, no copy of the files. */
async function joinAsVisitor(root: string, server: string, project: string, env: Env): Promise<Output> {
	writeConfig(root, { server, project, agent: "", visitor: true });
	const api = new Api(readConfig(root, env.env));
	let version: number;
	try {
		version = (await api.status()).version;
	} catch (error) {
		rmSync(stateDir(root), { recursive: true, force: true });
		throw error;
	}
	return {
		text: [
			`Joined ${project} to read it signed out, at version ${version}, in ${root}. Nothing is sent with a sign-in, and nothing here is recorded.`,
			`This folder holds no copy of the files: abso files lists them, abso show ${version}:<file> prints one, and status, log, blame, why, where, issues, issue and search read the rest.`,
			`To work on ${project}: abso login, then abso join ${project} in a new folder.`,
			...(root === resolve(env.cwd) ? [] : [`cd ${relative(env.cwd, root) || root}`]),
		].join("\n"),
		json: { project, visitor: true, version, root },
	};
}

export async function runJoin(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length !== 1) throw new UsageError("join takes the project name: abso join <project>");
	const project = args.positionals[0]!;
	if (!NAME.test(project))
		throw new UsageError(
			`project names are letters, digits, dot, dash and underscore (got ${JSON.stringify(project)})`,
		);
	const root = joinFolder(args, env, project);
	mkdirSync(root, { recursive: true });
	if (findRoot(root) === root) throw new UsageError(`${root} already has .abso/config.json`);
	const reader = bool(args, "reader");
	const server = serverFrom(args, env);
	const box = readBox(server);
	const hasKey = existsSync(join(stateDir(root), "key"));
	let agent: string;
	let minted: { key: string; id: string } | undefined;
	if (str(args, "agent") !== undefined) {
		agent = agentFrom(args);
		minted = box && !hasKey && !fromEnv(env.env, "KEY_FILE") ? await mintKey(box, project, agent) : undefined;
	} else if (fromEnv(env.env, "KEY_FILE")) {
		// A pipeline run's key (ABSO_KEY_FILE) belongs to one agent, which the runner names in ABSO_AGENT.
		const named = fromEnv(env.env, "AGENT");
		if (!named)
			throw new UsageError("a pipeline run's key joins as its own agent: give it with --agent <name> or ABSO_AGENT");
		agent = agentFrom(args, named);
	} else {
		// No --agent: the box's name, or the next free -2, -3. Not signed in, --reader reads a public project signed out.
		if (!box && reader && !hasKey && (await isPublic(server, project)))
			return joinAsVisitor(root, server, project, env);
		if (!box)
			throw new UsageError(
				`${await signedOut(server, project)} (A folder that already has a key joins with --agent <name>.)`,
			);
		if (hasKey) throw new UsageError(`${root} already has a key: give its agent's name with --agent <name>`);
		const free = await mintFreeName(box, project, defaultAgentName());
		agent = free.agent;
		minted = { key: free.key, id: free.id };
	}
	const config = { server, project, agent, ...(reader ? { reader: true } : {}) };
	writeConfig(root, config);
	clearKnown(root);
	if (minted) installKey(root, JSON.stringify(minted));
	const settings = readConfig(root, env.env);
	const api = new Api(settings);
	let synced: Awaited<ReturnType<typeof syncFolder>>;
	try {
		// Before the sync, so the server never takes a record from this folder.
		if (reader) await api.reader(true);
		// Every file, even when the server has seen this agent sync before: its plain sync answer would hold only what changed since (#37).
		synced = await syncFolder(root, api, true);
	} catch (error) {
		if (!(error instanceof ApiError && error.status === 401 && !box && !settings.token)) throw error;
		rmSync(stateDir(root), { recursive: true, force: true });
		throw new UsageError(await signedOut(config.server, project));
	}
	return {
		text: [
			`Joined ${project} as ${config.agent} at version ${synced.version}: wrote ${plural(synced.written.length, "file")} into ${root}.${reader ? " It is a reader: status, pull, log, show, files and export work, and nothing it does is recorded or pushed." : ""}${minted ? ` It signs in with its own key, ${minted.id}, made from this box's sign-in.` : ""}`,
			...refusedText(synced.refused),
			...(synced.kept.length > 0
				? [
						`These files were already here and differ from shared, so they were left alone: ${synced.kept.join(", ")}. abso record sends them as your changes.`,
					]
				: []),
			...setupHint(root),
			hookHint(env.env),
			...(root === resolve(env.cwd) ? [] : [`cd ${relative(env.cwd, root) || root}`]),
		].join("\n"),
		json: {
			project,
			agent: config.agent,
			version: synced.version,
			written: synced.written,
			kept: synced.kept,
			refused: synced.refused,
			root,
		},
	};
}

/** What to run before building or testing here (#43): a joined folder has the project's files, not what avcs.json's setup installs. */
function setupHint(root: string): string[] {
	const read = readProjectFile(root);
	const setup = read !== null && "file" in read ? read.file.setup : "";
	return setup === ""
		? []
		: [`Nothing is installed yet. Before building or testing here, run ${projectFileName(root)}'s setup: ${setup}`];
}

function hookHint(env: Readonly<Record<string, string | undefined>>): string {
	return modInstalled(env)
		? "Edits made by Claude Code here are recorded by the abso mod on this machine, signed in as this folder. Anything else: abso record."
		: `Edits made by Claude Code reach the server through the abso mod, which isn't on this machine yet: node ${join(CLIENT_DIR, "install-mod.ts")} installs it, and new chats load it. Anything else: abso record.`;
}
