import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "capacity-git-dependency-sandbox/node_modules/isomorphic-git";
const hashes = {
	"index.js": "66c20b7d890a6d48819f0be5f7bb1c5aab69937e6318ec912295c501028a5084",
	"index.cjs": "b2142bba9e651fce83d6c1d266d32fc5eefa748544c452f9f22fada4e33dc367",
};
const patched = {
	"index.js": "0bd051b1a38bf8d593bf37b5acf9ee453ddab33d48950c84e2c2c3f3ec449fc8",
	"index.cjs": "6c9f6eab37a10c9311f2b7aa8d24b0772d4ba2703d848525a0519e1454d016e7",
};
if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version !== "1.44.2")
	throw Error("Unsupported Git version");
const installed = Object.fromEntries(
	Object.keys(hashes).map((file) => [
		file,
		createHash("sha256")
			.update(readFileSync(join(root, file)))
			.digest("hex"),
	]),
);
if (Object.keys(patched).every((file) => installed[file] === patched[file])) {
	console.log(JSON.stringify({ verified: true, version: "1.44.2", bundles: installed }));
	process.exit(0);
}
if (process.argv.includes("--check")) throw Error("Git runtime patch is absent or modified");
function replaceOnce(source, before, after) {
	if (source.split(before).length !== 2) throw Error("Patch anchor mismatch");
	return source.replace(before, after);
}
const outputs = [];
for (const [file, expected] of Object.entries(hashes)) {
	const original = readFileSync(join(root, file), "utf8");
	if (createHash("sha256").update(original).digest("hex") !== expected) throw Error(`Unrecognized source: ${file}`);
	const start = original.indexOf("async function _pack({");
	const end = original.indexOf("\n// @ts-check", start);
	if (start < 0 || end < 0) throw Error("Missing pack implementation");
	const old = original.slice(start, end);
	let streamed = replaceOnce(old, "async function _pack({", "async function* _packStream({");
	streamed = replaceOnce(
		streamed,
		"  for (const oid of oids) {",
		"  yield* outputStream;\n  outputStream.length = 0;\n  for (const oid of oids) {",
	);
	streamed = replaceOnce(
		streamed,
		"    await writeObject({ write, object, stype: type });",
		"    await writeObject({ write, object, stype: type });\n    yield* outputStream;\n    outputStream.length = 0;",
	);
	streamed = replaceOnce(streamed, "  outputStream.push(digest);\n  return outputStream", "  yield digest;");
	let result =
		original.slice(0, start) +
		streamed +
		"\nasync function _pack(options) {\n  const output = [];\n  for await (const chunk of _packStream(options)) output.push(chunk);\n  return output;\n}\n" +
		original.slice(end);
	const begin = result.indexOf("  const packstream2 = _delete");
	const finish = result.indexOf("  const res = await GitRemoteHTTP.connect({", begin);
	if (begin < 0 || finish < 0) throw Error("Missing push implementation");
	result =
		result.slice(0, begin) +
		`  const packoids = [...objects];
  // Recreate the stream for every authentication retry; never retain a whole pack.
  const packbody = {
    async *[Symbol.asyncIterator]() {
      yield* packstream1;
      if (!_delete) yield* _packStream({ fs, cache, gitdir, oids: packoids });
    }
  };
` +
		result.slice(finish);
	result = replaceOnce(result, "    body: [...packstream1, ...packstream2],", "    body: packbody,");
	const sha256 = createHash("sha256").update(result).digest("hex");
	if (sha256 !== patched[file]) throw Error(`Unexpected patch output: ${file}`);
	outputs.push({ file, result, sha256 });
}
// Validate every input before changing either runtime bundle.
for (const output of outputs) writeFileSync(join(root, output.file), output.result);
writeFileSync(
	"capacity-git-push-patch-manifest.json",
	JSON.stringify(
		outputs.map(({ file, sha256 }) => ({ file, sha256 })),
		null,
		2,
	),
);
console.log(
	JSON.stringify({
		version: "1.44.2",
		patched: outputs.map(({ file, sha256 }) => ({ file, sha256 })),
		scope: "Isolated push patch; fetch and install integration incomplete",
	}),
);
