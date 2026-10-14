import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "capacity-git-dependency-sandbox/node_modules/isomorphic-git";
const inputs = {
	"index.js": "20512aae32eb8dd64b798c0dd4ba666ea801bec6c9de37d259527c93ce3e48ec",
	"index.cjs": "b4cd8c52f3fa945b553dbb7a740c965b48b93dfc2469f10849e111abd00c7460",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
function once(source, before, after) {
	if (source.split(before).length !== 2) throw Error(`Progress anchor mismatch: ${before}`);
	return source.replace(before, after);
}
const outputs = [];
for (const [file, expected] of Object.entries(inputs)) {
	let source = readFileSync(join(root, file), "utf8");
	if (hash(source) !== expected) throw Error(`Unrecognized input: ${file}`);
	source = once(
		source,
		"  static demux(input, bounded = false) {",
		"  static demux(input, bounded = false, discardProgress = false) {",
	);
	source = once(
		source,
		"          progress.write(line.slice(1));",
		"          if (!discardProgress) progress.write(line.slice(1));",
	);
	source = once(source, "          progress.write(error);", "          if (!discardProgress) progress.write(error);");
	source = once(
		source,
		"async function parseUploadPackResponse(stream, bounded = false) {\n  const { packetlines, packfile, progress } = GitSideBand.demux(stream, bounded);",
		"async function parseUploadPackResponse(stream, bounded = false, discardProgress = false) {\n  const { packetlines, packfile, progress } = GitSideBand.demux(stream, bounded, discardProgress);",
	);
	source = once(
		source,
		"  const response = await parseUploadPackResponse(raw.body, Boolean(cache && cache[Symbol.for('abso.git.disk-pack')]));",
		"  const response = await parseUploadPackResponse(raw.body, Boolean(cache && cache[Symbol.for('abso.git.disk-pack')]), Boolean(cache && cache[Symbol.for('abso.git.disk-pack')]) && !onProgress && !onMessage);",
	);
	outputs.push({ file, source, sha256: hash(source) });
}
if (!process.argv.includes("--check")) {
	for (const { file, source } of outputs) writeFileSync(join(root, file), source);
	writeFileSync(
		"capacity-git-progress-patch-manifest.json",
		JSON.stringify(
			outputs.map(({ file, sha256 }) => ({ file, sha256 })),
			null,
			2,
		),
	);
}
console.log(JSON.stringify(outputs.map(({ file, sha256 }) => ({ file, sha256 }))));
