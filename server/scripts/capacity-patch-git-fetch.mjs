import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Extends only the reviewed-version push prototype in this isolated dependency tree.
const root = "capacity-git-dependency-sandbox/node_modules/isomorphic-git";
const inputs = {
	"index.js": "0bd051b1a38bf8d593bf37b5acf9ee453ddab33d48950c84e2c2c3f3ec449fc8",
	"index.cjs": "6c9f6eab37a10c9311f2b7aa8d24b0772d4ba2703d848525a0519e1454d016e7",
};
const hash = (source) => createHash("sha256").update(source).digest("hex");
const expectedOutputs = {
	"index.js": "eebe6911fa660d4b95857768ea2308be74435dd5f9a796bb7b2491a31bdd109d",
	"index.cjs": "33364e3ed7f3a1a6cf17a1ecabbfc5d6de6a8494f31a524d8ac293402ad4e447",
};
function once(source, before, after) {
	if (source.split(before).length !== 2) throw Error("Fetch patch anchor mismatch");
	return source.replace(before, after);
}
if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version !== "1.44.2") {
	throw Error("Unsupported Git version");
}
const outputs = [];
const installed = Object.fromEntries(Object.keys(inputs).map((file) => [file, readFileSync(join(root, file), "utf8")]));
if (Object.entries(expectedOutputs).every(([file, expected]) => hash(installed[file]) === expected)) {
	console.log(
		JSON.stringify({
			verified: true,
			scope: "Isolated fetch prototype",
			bundles: expectedOutputs,
		}),
	);
	process.exit(0);
}
for (const [file, expected] of Object.entries(inputs)) {
	const source = installed[file];
	if (hash(source) !== expected) throw Error(`Unrecognized input: ${file}`);
	let result = once(
		source,
		"  const packfile = Buffer.from(await collect(response.packfile));",
		`  const diskPack = cache && cache[Symbol.for('abso.git.disk-pack')];
  if (diskPack) {
    await diskPack.ingest(response.packfile, () => new pako.Inflate({ chunkSize: 16384 }));
    if (raw.body.error) throw raw.body.error
    const result = {
      defaultBranch: response.HEAD,
      fetchHead: response.FETCH_HEAD.oid,
      fetchHeadDescription: response.FETCH_HEAD.description,
    };
    if (response.headers) result.headers = response.headers;
    if (prune) result.pruned = response.pruned;
    return result
  }
  const packfile = Buffer.from(await collect(response.packfile));`,
	);
	const readStart = result.indexOf("async function _readObject({");
	const readEnd = result.indexOf("\nclass AlreadyExistsError", readStart);
	if (readStart < 0 || readEnd < 0) throw Error("Missing object reader boundary");
	const readFunction = once(
		result.slice(readStart, readEnd),
		"  // Curry the current read method so that the packfile un-deltification",
		`  const diskPack = cache && cache[Symbol.for('abso.git.disk-pack')];
  if (diskPack && format === 'content') {
    const stored = await diskPack.read(oid);
    if (stored) return stored
  }

  // Curry the current read method so that the packfile un-deltification`,
	);
	result = result.slice(0, readStart) + readFunction + result.slice(readEnd);
	if (hash(result) !== expectedOutputs[file]) throw Error(`Unexpected fetch patch output: ${file}`);
	outputs.push({ file, result, sha256: hash(result) });
}
// Validate both installed bundles and every anchor before either write.
if (!process.argv.includes("--check")) {
	for (const { file, result } of outputs) writeFileSync(join(root, file), result);
	writeFileSync(
		"capacity-git-fetch-patch-manifest.json",
		JSON.stringify(
			outputs.map(({ file, sha256 }) => ({ file, sha256 })),
			null,
			2,
		),
	);
}
console.log(
	JSON.stringify({
		scope: "Isolated fetch prototype; runtime adapter and transport acceptance still required",
		outputs: outputs.map(({ file, sha256 }) => ({ file, sha256 })),
	}),
);
