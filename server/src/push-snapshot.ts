import type { FileModes } from "../../worker/project/project-api.ts";

export interface PushSnapshotMetadata {
	version: number;
	paths: string[];
	modes: FileModes;
	blobs: Record<string, string>;
	last?: { agent: string; message: string };
}

/** Construct outside the read scope so detaching metadata never evaluates file text. */
export function pushSnapshot(
	metadata: PushSnapshotMetadata,
	readText: (version: number, path: string) => string,
	readBatch?: (version: number, paths: readonly string[]) => Record<string, string>,
) {
	const { paths, ...shared } = metadata;
	const files: Record<string, string> = Object.create(null);
	let cache: Record<string, string> = Object.create(null);
	for (let index = 0; index < paths.length; index++) {
		const path = paths[index]!;
		Object.defineProperty(files, path, {
			enumerable: true,
			get: () => {
				if (!readBatch) return readText(shared.version, path);
				if (!Object.hasOwn(cache, path)) cache = readBatch(shared.version, paths.slice(index, index + 64));
				if (!Object.hasOwn(cache, path)) throw Error("push batch omitted requested file");
				const text = cache[path]!;
				delete cache[path];
				return text;
			},
		});
	}
	return { ...shared, files };
}
