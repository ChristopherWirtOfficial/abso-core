import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "capacity-git-dependency-sandbox/node_modules/isomorphic-git";
const inputs = {
	"index.js": "4e0e9ee5a21754ebd718864dba2705385fc8254ed0c9e0d4ff56c8a2ff6fccf8",
	"index.cjs": "fe66bb236ed6d95bf720e646afc9fff1dbe3efbc441b194efde09b1b698cd583",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
function once(source, before, after) {
	if (source.split(before).length !== 2) throw Error("Git pump anchor mismatch");
	return source.replace(before, after);
}
const outputs = [];
for (const [file, expected] of Object.entries(inputs)) {
	let source = readFileSync(join(root, file), "utf8");
	if (hash(source) !== expected) throw Error(`Unrecognized pump input: ${file}`);
	source = once(
		source,
		"    const nextBit = async function () {",
		"    const nextBit = async function () {\n      while (true) {",
	);
	source = once(source, "      if (line === null) return nextBit()", "      if (line === null) continue");
	source = once(source, "      return nextBit();\n    };", "      }\n    };");
	outputs.push({ file, source, sha256: hash(source) });
}
if (!process.argv.includes("--check")) {
	for (const { file, source } of outputs) writeFileSync(join(root, file), source);
}
console.log(JSON.stringify(outputs.map(({ file, sha256 }) => ({ file, sha256 }))));
