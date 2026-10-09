// abso init and abso join: start a project from a folder, or join one into a folder.

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Api, ApiError } from "./api.ts";
import { bool, type Parsed, str, UsageError } from "./args.ts";
import { writeKnownBlobs } from "./blobs.ts";
import { mintKey, readBox } from "./box.ts";
import { STARTING_AVCSIGNORE } from "./check-ignore.ts";
import { CLIENT_DIR } from "./client-version.ts";
import { type Env, type Output, plural } from "./command-env.ts";
import { leftOutText, syncFolder, uploadBlobs } from "./commands.ts";
import { AVCS_DIR, findRoot, installKey, readConfig, type Settings, tokenFor, writeConfig } from "./config.ts";
import { clearKnown, loadIgnore, readFolder, writeKnown } from "./folder.ts";
import { modInstalled } from "./install.ts";
import { type FullMode, foldModes, writeKnownModes } from "./modes.ts";
import { PROJECT_FILE, readProjectFile, startingProjectFileText, writeStartingProjectFile } from "./project-file.ts";
import { refusedText } from "./safety.ts";

function serverFrom(args: Parsed, env: Env): string {
	const server = str(args, "server") ?? env.env.AVCS_SERVER;
	if (!server) throw new UsageError("give the server with --server <url> (or AVCS_SERVER)");
	return server;
}

function agentFrom(args: Parsed): string {
	const agent = str(args, "agent");
	if (!agent) throw new UsageError("give this folder's agent name with --agent <name>");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent))
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
	if (findRoot(root) === root) throw new UsageError(`${root} already has .avcs/config.json`);
	const project = str(args, "project");
	if (!project) throw new UsageError("give the project a name with --project <name>");
	const config = makeSettings(args, env, project);
	const asIs = bool(args, "as-is");
	const avcsignore = join(root, ".avcsignore");
	const wroteIgnore = !asIs && !existsSync(avcsignore);
	if (wroteIgnore) writeFileSync(avcsignore, STARTING_AVCSIGNORE);
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
				? ["Wrote a starting .avcsignore (Claude Code state and operating system files); edit it like .gitignore."]
				: []),
			...startingProjectFileText(wroteProject),
			...(answer.skipped && answer.skipped.length > 0 ? [`The server skipped: ${answer.skipped.join(", ")}.`] : []),
			`This folder is agent ${config.agent}. Settings are in .avcs/config.json.`,
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
			wroteAvcsignore: wroteIgnore,
			wroteProjectFile: typeof wroteProject === "string" ? null : wroteProject,
			leftOut,
		},
	};
}

export async function runJoin(args: Parsed, env: Env): Promise<Output> {
	if (args.positionals.length !== 1)
		throw new UsageError("join takes the project name: abso join <project> --agent <name>");
	const project = args.positionals[0]!;
	const root = resolve(env.cwd, str(args, "dir") ?? ".");
	mkdirSync(root, { recursive: true });
	if (findRoot(root) === root) throw new UsageError(`${root} already has .avcs/config.json`);
	const reader = bool(args, "reader");
	const config = { ...makeSettings(args, env, project), ...(reader ? { reader: true } : {}) };
	const box = readBox(config.server);
	const minted =
		box && !existsSync(join(root, AVCS_DIR, "key")) ? await mintKey(box, project, config.agent) : undefined;
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
		rmSync(join(root, AVCS_DIR), { recursive: true, force: true });
		throw new UsageError(`This box isn't signed in to ${config.server}. abso login signs it in.`);
	}
	return {
		text: [
			`Joined ${project} as ${config.agent} at version ${synced.version}: wrote ${plural(synced.written.length, "file")} into ${root}.${reader ? " It is a reader: status, sync, log, show, files and export work, and nothing it does is recorded or published." : ""}${minted ? ` It signs in with its own key, ${minted.id}, made from this box's sign-in.` : ""}`,
			...refusedText(synced.refused),
			...(synced.kept.length > 0
				? [
						`These files were already here and differ from shared, so they were left alone: ${synced.kept.join(", ")}. abso record sends them as your changes.`,
					]
				: []),
			...setupHint(root),
			hookHint(env.env),
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

/** What to run before building or testing here (#43, Engine): a joined folder has the project's files, not what avcs.json's setup installs. */
function setupHint(root: string): string[] {
	const read = readProjectFile(root);
	const setup = read !== null && "file" in read ? read.file.setup : "";
	return setup === ""
		? []
		: [`Nothing is installed yet. Before building or testing here, run ${PROJECT_FILE}'s setup: ${setup}`];
}

function hookHint(env: Readonly<Record<string, string | undefined>>): string {
	return modInstalled(env)
		? "Edits made by Claude Code here are recorded by the avcs mod on this machine, signed in as this folder. Anything else: abso record."
		: `Edits made by Claude Code reach the server through the avcs mod, which isn't on this machine yet: node ${join(CLIENT_DIR, "install-mod.ts")} installs it, and new chats load it. Anything else: abso record.`;
}
