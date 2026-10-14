import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const rootIndex = process.argv.indexOf("--root");
if (rootIndex < 0 || !process.argv[rootIndex + 1])
	throw Error("Pass --root with the exact isomorphic-git package directory");
const root = resolve(process.argv[rootIndex + 1]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = {
	"index.js": "66c20b7d890a6d48819f0be5f7bb1c5aab69937e6318ec912295c501028a5084",
	"index.cjs": "b2142bba9e651fce83d6c1d266d32fc5eefa748544c452f9f22fada4e33dc367",
};
const expected = {
	"index.js": "50ada141b506bff7cced797098f5ea70a6e40cda859884cc25b0dea985b10592",
	"index.cjs": "3b8a78b7145330038cf56e057f7726004a78d0af9a55845b685cf1f65443bae0",
};
if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version !== "1.44.2")
	throw Error("Unsupported Git version");
const installed = Object.fromEntries(Object.keys(original).map((file) => [file, readFileSync(join(root, file))]));
if (Object.entries(expected).every(([file, digest]) => hash(installed[file]) === digest)) {
	console.log("Verified the complete Git capacity runtime patch.");
	process.exit(0);
}
if (process.argv.includes("--check")) throw Error("Complete Git capacity runtime patch is absent or modified");
for (const [file, digest] of Object.entries(original)) {
	if (hash(installed[file]) !== digest) throw Error(`Unrecognized or partially patched Git bundle: ${file}`);
}
const temporary = mkdtempSync(join(tmpdir(), "abso-git-patch-"));
if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith("abso-git-patch-"))
	throw Error("Unexpected temporary cleanup path");
try {
	const staged = join(temporary, "capacity-git-dependency-sandbox/node_modules/isomorphic-git");
	mkdirSync(staged, { recursive: true });
	copyFileSync(join(root, "package.json"), join(staged, "package.json"));
	for (const [file, bytes] of Object.entries(installed)) writeFileSync(join(staged, file), bytes);
	copyFileSync(join(scripts, "capacity-git-bounded-fifo.mjs"), join(temporary, "capacity-git-bounded-fifo.mjs"));
	for (const stage of ["push", "fetch", "sideband", "progress", "pump"]) {
		execFileSync(process.execPath, [join(scripts, `capacity-patch-git-${stage}.mjs`)], {
			cwd: temporary,
			stdio: "pipe",
		});
	}
	const outputs = Object.fromEntries(Object.keys(expected).map((file) => [file, readFileSync(join(staged, file))]));
	for (const [file, digest] of Object.entries(expected)) {
		if (hash(outputs[file]) !== digest) throw Error(`Unexpected complete Git patch: ${file}`);
	}
	// All stages and both final hashes pass before touching the installed package.
	for (const [file, bytes] of Object.entries(outputs)) writeFileSync(join(root, file), bytes);
	console.log("Installed and verified the complete Git capacity runtime patch.");
} finally {
	try {
		rmSync(temporary, { recursive: true, force: true });
	} catch {
		console.warn("Could not remove the Git patch staging directory.");
	}
}
