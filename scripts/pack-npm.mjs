// Packs the npm package @abso-cli/abso from this checkout: the client as scripts/build-client.mjs builds it,
// for Node 20 or later. It never publishes and never reads npm's sign-in.
//
//   npm ci && npm run pack:npm -- <version>      (e.g. 0.171.0)
//
// It writes the package to dist/npm/package/ and its tarball, as npm pack names it, to dist/npm/.
// The package's layout: bin/abso.mjs checks Node's version and loads dist/abso.mjs, the bundle, stamped
// with the version so the client knows it is an installed package.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient } from "./build-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
	process.stderr.write("Use: npm run pack:npm -- <version>, such as 0.171.0\n");
	process.exit(2);
}
const node = 20;

const files = {
	"package.json": `${JSON.stringify(
		{
			name: "@abso-cli/abso",
			version,
			description: "abso: version control built for AI agents first. The command line client.",
			license: "MIT",
			homepage: "https://abso.dev",
			keywords: ["version control", "vcs", "agents", "ai", "abso"],
			type: "module",
			engines: { node: `>=${node}` },
			bin: { abso: "bin/abso.mjs" },
			files: ["bin", "dist"],
			publishConfig: { access: "public" },
		},
		null,
		2,
	)}\n`,
	// A dynamic import, so an older Node reaches the version check before it reads the bundle.
	"bin/abso.mjs": `#!/usr/bin/env node
const major = Number(process.versions.node.split(".")[0]);
if (major < ${node}) {
	process.stderr.write("abso needs Node ${node} or later, and this is Node " + process.versions.node + ". Install a newer Node from https://nodejs.org and run abso again.\\n");
	process.exit(1);
}
await import("../dist/abso.mjs");
`,
	"dist/abso.mjs": buildClient([`globalThis.__ABSO_PACKAGE_VERSION__ = ${JSON.stringify(version)};`]),
	"README.md": `# abso\n\nabso is version control for agents. This package is the abso command line.\n\nIt needs Node ${node} or later. Install it with \`npm install -g @abso-cli/abso\`, or run \`npx @abso-cli/abso help\`.\n\n[abso.dev](https://abso.dev)\n`,
	LICENSE: readFileSync(join(root, "LICENSE"), "utf8"),
};

const out = join(root, "dist", "npm");
const pkg = join(out, "package");
rmSync(pkg, { recursive: true, force: true });
for (const [path, text] of Object.entries(files)) {
	mkdirSync(dirname(join(pkg, path)), { recursive: true });
	writeFileSync(join(pkg, path), text);
}
// Under npm run, npm_execpath is npm's own script, which runs without a shell on every platform.
const npm = process.env.npm_execpath;
const pack = ["pack", pkg, "--pack-destination", out, "--ignore-scripts"];
const tarball = (
	npm
		? execFileSync(process.execPath, [npm, ...pack], { cwd: root, encoding: "utf8" })
		: execFileSync("npm", pack, { cwd: root, encoding: "utf8", shell: process.platform === "win32" })
)
	.trim()
	.split("\n")
	.pop();
process.stdout.write(`Packed @abso-cli/abso ${version}: dist/npm/${tarball}\n`);
