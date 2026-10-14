import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "capacity-git-dependency-sandbox/node_modules/isomorphic-git";
const inputs = {
	"index.js": "eebe6911fa660d4b95857768ea2308be74435dd5f9a796bb7b2491a31bdd109d",
	"index.cjs": "33364e3ed7f3a1a6cf17a1ecabbfc5d6de6a8494f31a524d8ac293402ad4e447",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const queue = readFileSync("capacity-git-bounded-fifo.mjs", "utf8").replace("export class", "class");
function once(source, before, after) {
	if (source.split(before).length !== 2) throw Error(`Sideband anchor mismatch: ${before}`);
	return source.replace(before, after);
}
const outputs = [];
for (const [file, expected] of Object.entries(inputs)) {
	let source = readFileSync(join(root, file), "utf8");
	if (hash(source) !== expected) throw Error(`Unrecognized input: ${file}`);
	source = once(source, "class GitSideBand {", `${queue}\nclass GitSideBand {`);
	source = once(source, "  static demux(input) {", "  static demux(input, bounded = false) {");
	source = once(
		source,
		"    const packfile = new FIFO();",
		"    const packfile = bounded ? new BoundedPackFIFO(async () => { await getIterator(input).return?.(); }) : new FIFO();",
	);
	source = once(source, "          packfile.write(line.slice(1));", "          await packfile.write(line.slice(1));");
	source = once(
		source,
		"      nextBit();\n    };\n    nextBit();",
		`      return nextBit();
    };
    nextBit().catch(error => { packetlines.destroy(error); progress.destroy(error); packfile.destroy(error); });`,
	);
	source = once(
		source,
		"async function parseUploadPackResponse(stream) {\n  const { packetlines, packfile, progress } = GitSideBand.demux(stream);",
		"async function parseUploadPackResponse(stream, bounded = false) {\n  const { packetlines, packfile, progress } = GitSideBand.demux(stream, bounded);",
	);
	source = once(
		source,
		"  const response = await parseUploadPackResponse(raw.body);",
		"  const response = await parseUploadPackResponse(raw.body, Boolean(cache && cache[Symbol.for('abso.git.disk-pack')]));",
	);
	outputs.push({ file, source, sha256: hash(source) });
}
if (!process.argv.includes("--check")) {
	for (const { file, source } of outputs) writeFileSync(join(root, file), source);
	writeFileSync(
		"capacity-git-sideband-patch-manifest.json",
		JSON.stringify(
			outputs.map(({ file, sha256 }) => ({ file, sha256 })),
			null,
			2,
		),
	);
}
console.log(JSON.stringify(outputs.map(({ file, sha256 }) => ({ file, sha256 }))));
