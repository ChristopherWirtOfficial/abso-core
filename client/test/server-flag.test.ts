// --server on every command that talks to a server (abso-core issue 10). The rules, each a test:
// - every command is sorted: one that works on this machine only takes no --server and says so; every other one
//   takes it, and help says the same words about it for each kind;
// - a missing, empty or malformed value is refused before anything is sent, for every family of command;
// - in a joined folder, --server naming the folder's own server reaches it; another server is refused, never
//   swapped in, and nothing is sent; outside a joined folder a folder command with --server is refused too;
// - an explicit --server goes to that server's own Issues Worker, which ABSO_ISSUES_SERVER doesn't redirect;
// - a command that picks its server (whoami, box, logout) uses the one named, even inside a folder on another;
// - with nothing named (abso-core issue 9) the server is the joined folder's, else ABSO_SERVER, else prod, whatever
//   this box is signed in to (doctor.test.ts has whoami with staging alone and with staging and prod both).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { writeConfig } from "../src/config.ts";
import { commandTable, main } from "../src/main.ts";
import { chooseServer, PROD_SERVER, SERVER_ORDER, sameServer, serverHelp, serverUse } from "../src/server-choice.ts";

/** A made-up token: the tests never read the real ~/.abso/token. */
const TOKEN = "abso_test-token-for-server-flag";

interface Listening {
	readonly server: Server;
	readonly url: string;
	readonly paths: string[];
}

/** A server that notes each path it is asked for and answers 500, so a command stops after its first call. */
async function listen(): Promise<Listening> {
	const paths: string[] = [];
	const server = createServer((req, res) => {
		paths.push(req.url ?? "");
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "a test server" }));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
}

const temps: string[] = [];
function temp(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `abso-server-flag-${name}-`));
	temps.push(dir);
	return dir;
}

let home: Listening;
let other: Listening;
let issuesElsewhere: Listening;
let env: Record<string, string>;

before(async () => {
	home = await listen();
	other = await listen();
	issuesElsewhere = await listen();
	const servers = join(temp("servers"), "servers.json");
	writeFileSync(servers, "{}");
	env = { ABSO_TOKEN: TOKEN, ABSO_SERVERS_FILE: servers };
});

after(() => {
	for (const l of [home, other, issuesElsewhere]) l.server.close();
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function folder(server = home.url): string {
	const root = temp("folder");
	writeConfig(root, { server, project: "demo", agent: "alice" });
	return root;
}

const run = (cwd: string, argv: string[], extra: Record<string, string> = {}) =>
	main(argv, { cwd, env: { ...env, ...extra }, write: () => {} });

function calls(): number {
	return home.paths.length + other.paths.length + issuesElsewhere.paths.length;
}

function clear(): void {
	for (const l of [home, other, issuesElsewhere]) l.paths.length = 0;
}

describe("--server on every command", () => {
	it("sorts every command: local ones take no --server, every other one does, and help says so alike", async () => {
		const table = commandTable();
		const local = Object.keys(table).filter((name) => serverUse(name) === "local");
		assert.deepEqual(local.sort(), ["check-ignore", "fix-eol", "pause", "resume", "skill"]);
		for (const [name, def] of Object.entries(table)) {
			if (serverUse(name) === "local") {
				assert.equal(def.flags.server, undefined, name);
				assert.equal(serverHelp(name), undefined, name);
				continue;
			}
			assert.equal(def.flags.server, "string", name);
			const help = await run(process.cwd(), [name, "--help"]);
			assert.ok(help.stdout.includes(`  ${serverHelp(name)}\n`), `abso ${name} --help names --server`);
		}
		const data = JSON.parse((await run(process.cwd(), ["help", "--json"])).stdout) as {
			commands: { name: string; server?: string; flags: Record<string, string> }[];
		};
		for (const c of data.commands.filter((c) => c.name in table)) assert.equal(c.server, serverHelp(c.name), c.name);
		const text = (await run(process.cwd(), ["help"])).stdout;
		assert.match(text, /Every command that talks to a server takes --server <url>/);
	});

	it("refuses --server on a command that works on this machine only", async () => {
		for (const argv of [
			["skill", "show", "--server", home.url],
			["check-ignore", "a.txt", `--server=${home.url}`],
			["pause", "--server", home.url],
		]) {
			const r = await run(folder(), argv);
			assert.equal(r.exit, 1, argv.join(" "));
			assert.match(r.stderr, /works on this machine only and talks to no server, so it takes no --server/);
		}
		const words = await run(folder(), ["check-ignore", "--", "--server"]);
		assert.doesNotMatch(words.stderr, /takes no --server/, "a path after -- is a path");
	});

	it("refuses a missing, empty or malformed value before anything is sent, in every family", async () => {
		const root = folder();
		const outside = temp("outside");
		clear();
		const families: [string, string[]][] = [
			[root, ["status"]],
			[root, ["issue", "new", "A title"]],
			[root, ["ask", "bob", "Why?"]],
			[root, ["news"]],
			[root, ["pipeline", "runs"]],
			[outside, ["whoami"]],
			[outside, ["login"]],
			[outside, ["join", "demo"]],
			[outside, ["org", "acme"]],
			[outside, ["key", "list"]],
		];
		for (const [cwd, argv] of families) {
			const missing = await run(cwd, [...argv, "--server"]);
			assert.match(missing.stderr, /--server needs a value/, argv.join(" "));
			const empty = await run(cwd, [...argv, "--server="]);
			assert.match(empty.stderr, /--server needs a server's URL, like https:\/\/api\.abso\.dev/, argv.join(" "));
			for (const bad of ["api.abso.dev", "ftp://api.abso.dev", "https://me@api.abso.dev", "https://x.example/?a=1"]) {
				const r = await run(cwd, [...argv, "--server", bad]);
				assert.equal(r.exit, 1, `${argv.join(" ")} --server ${bad}`);
				assert.match(r.stderr, /--server takes an http or https URL with no user name, query or fragment/);
			}
		}
		assert.equal(calls(), 0, "nothing was sent");
	});

	it("in a joined folder, reaches the folder's own server and refuses another without sending anything", async () => {
		const root = folder();
		for (const argv of [["status"], ["log"], ["issues"], ["issue", "1"], ["news"], ["waiting"], ["ci"]]) {
			clear();
			const same = await run(root, [...argv, "--server", `${home.url.toUpperCase().replace("HTTP", "http")}/`]);
			assert.doesNotMatch(same.stderr, /joined on/, argv.join(" "));
			assert.ok(home.paths.length > 0, `abso ${argv.join(" ")} reached the folder's server`);
			assert.equal(other.paths.length, 0);
			clear();
			const refused = await run(root, [...argv, "--server", other.url]);
			assert.equal(refused.exit, 1);
			assert.match(
				refused.stderr,
				new RegExp(
					`this folder is joined on ${home.url}, not ${other.url}, so abso ${argv[0]} won't send its work or key there`,
				),
			);
			assert.equal(calls(), 0, `abso ${argv.join(" ")} sent nothing`);
		}
	});

	it("outside a joined folder, a folder command with --server says how to join one there", async () => {
		const outside = temp("outside");
		for (const argv of [["status"], ["issue", "new", "A title"], ["ask", "bob", "Why?"], ["news"]]) {
			const r = await run(outside, [...argv, "--server", home.url]);
			assert.equal(r.exit, 1);
			assert.match(r.stderr, new RegExp(`abso join <project> --server ${home.url}`));
		}
		assert.equal(calls(), 0);
	});

	it("an explicit --server takes issues to that server's own Issues Worker, past ABSO_ISSUES_SERVER", async () => {
		const root = folder();
		const elsewhere = { ABSO_ISSUES_SERVER: issuesElsewhere.url };
		clear();
		await run(root, ["issue", "1"], elsewhere);
		assert.ok(issuesElsewhere.paths.length > 0, "without --server, ABSO_ISSUES_SERVER names the Issues Worker");
		assert.ok(home.paths.every((p) => !p.startsWith("/issues/")));
		clear();
		await run(root, ["issue", "1", "--server", home.url], elsewhere);
		assert.equal(issuesElsewhere.paths.length, 0, "--server isn't redirected");
		assert.ok(home.paths.length > 0);
		assert.ok(
			home.paths.some((p) => p.startsWith("/issues/p/demo/")),
			`the open server keeps issues at /issues/p/<project>: ${home.paths}`,
		);
	});

	it("a command that picks its server uses the one named, even in a folder on another", async () => {
		const root = folder(other.url);
		for (const argv of [["whoami"], ["box"], ["logout"]]) {
			const r = await run(root, [...argv, "--server", home.url]);
			assert.match(r.stdout, new RegExp(home.url.replace(/\./g, "\\.")), argv.join(" "));
		}
		clear();
		const doctor = await run(root, ["doctor", "--server", home.url]);
		assert.match(doctor.stdout, new RegExp(`${home.url.replace(/\./g, "\\.")} answered 500`));
		assert.equal(other.paths.filter((p) => p === "/version").length, 0, "doctor didn't swap in the folder's server");
	});

	it("counts two spellings of one server as the same, and different ports or paths as different", () => {
		assert.ok(sameServer("https://API.abso.dev/", "https://api.abso.dev"));
		assert.ok(!sameServer("http://127.0.0.1:8787", "http://127.0.0.1:8788"));
		assert.ok(!sameServer("http://127.0.0.1:8787", "http://localhost:8787"));
		assert.ok(!sameServer("https://x.example/a", "https://x.example/b"));
	});
});

describe("the server when nothing names one", () => {
	const STAGING = "https://staging.abso.example";

	it("is --server, else the joined folder's, else ABSO_SERVER, else prod", () => {
		const outside = temp("outside");
		const staging = folder(STAGING);
		assert.equal(PROD_SERVER, "https://api.abso.dev");
		assert.equal(chooseServer(undefined, outside, {}), PROD_SERVER, "nothing named: prod");
		assert.equal(chooseServer(undefined, outside, { ABSO_SERVER: STAGING }), STAGING, "the environment");
		assert.equal(chooseServer(undefined, outside, { AVCS_SERVER: STAGING }), STAGING, "its older name");
		assert.equal(chooseServer(undefined, staging, {}), STAGING, "a joined staging folder");
		assert.equal(chooseServer(undefined, staging, { ABSO_SERVER: "https://env.example" }), STAGING, "folder first");
		assert.equal(chooseServer(PROD_SERVER, staging, { ABSO_SERVER: STAGING }), PROD_SERVER, "explicit prod");
		assert.equal(chooseServer(STAGING, outside, {}), STAGING, "explicit staging");
		assert.throws(
			() => chooseServer(undefined, outside, { ABSO_SERVER: "staging" }),
			/ABSO_SERVER takes an http or https URL/,
		);
	});

	it("help names the order once for every command that picks its server", async () => {
		assert.equal(
			SERVER_ORDER,
			"--server <url>, else the server of the abso folder you're in, else ABSO_SERVER, else prod (https://api.abso.dev)",
		);
		for (const name of ["join", "init", "login", "whoami", "doctor", "box", "logout", "orgs", "org"])
			assert.ok(serverHelp(name)?.includes(SERVER_ORDER), name);
		assert.ok((await run(process.cwd(), ["help"])).stdout.includes(SERVER_ORDER));
	});

	it("a joined folder's commands go to its server with nothing named, and ABSO_SERVER doesn't move them", async () => {
		const root = folder();
		clear();
		await run(root, ["status"], { ABSO_SERVER: other.url });
		assert.ok(home.paths.length > 0);
		assert.equal(other.paths.length, 0);
	});

	it("whoami in a joined folder looks at the folder's server, and another named there is used as given", async () => {
		const root = folder();
		const here = await run(root, ["whoami"], { ABSO_SERVER: other.url });
		assert.ok(here.stdout.includes(`isn't signed in to ${home.url}`), here.stdout);
		const named = await run(root, ["box", "--server", other.url]);
		assert.ok(named.stdout.includes(`isn't signed in to ${other.url}`), named.stdout);
	});
});
