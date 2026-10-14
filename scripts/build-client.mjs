// Builds client/bin/abso.mjs: the whole client, client/abso.ts and everything it imports (yaml included),
// as one plain-JS file for Node 20 or later. Node 20 can't run the .ts files themselves (it has no type
// stripping), so this file is how a checkout runs on it:
//
//   node client/bin/abso.mjs help
//
//   npm run build:client           rebuilds it; run it after changing the client and push the result.
//   npm run check:client-bundle    fails when the file isn't what a build of this folder gives (the check runs it).
//
// The file is committed, so a fresh clone runs it with no install and no build. It sits one folder under
// client/, so the client's own folder (client-version.ts) is still client/. The build is deterministic:
// paths in it are relative to the repo, so it comes out the same on every machine.
//
// Plain JS on purpose: it runs before anything is built.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "client/bin/abso.mjs";

/** The bundle's text, built in memory. */
export function buildClient() {
	const esbuild = createRequire(import.meta.url)("esbuild");
	const result = esbuild.buildSync({
		absWorkingDir: root,
		entryPoints: ["client/abso.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		write: false,
		outfile: OUT,
		logLevel: "warning",
		// A bundled CommonJS package (yaml) calls require("process") lazily, which an ES module bundle
		// can't do without a real require.
		banner: {
			js: [
				"// Built from client/abso.ts by scripts/build-client.mjs (npm run build:client). Don't edit it by hand.",
				'import { createRequire as __absoCreateRequire } from "node:module";',
				"const require = __absoCreateRequire(import.meta.url);",
			].join("\n"),
		},
	});
	// esbuild leaves control characters in string literals as they are (yaml's lexer has \x02, \x18 and \x1f).
	// Escaped, the file is plain text that every tool shows and stores as it is.
	return result.outputFiles[0].text.replace(
		/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
		(c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const path = join(root, OUT);
	const text = buildClient();
	if (process.argv.includes("--check")) {
		let have = "";
		try {
			have = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
		} catch {}
		if (have !== text) {
			process.stderr.write(
				`${OUT} is not a build of this folder's client: run npm run build:client and push the file it writes.\n`,
			);
			process.exit(1);
		}
	} else writeFileSync(path, text);
}
