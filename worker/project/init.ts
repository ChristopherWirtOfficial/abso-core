// Create the project from its first files. Writes go through InitHost; today
// the host is Project.

import { type AttrSet, buildBase, canonicalText, type View } from "../../src/engine/index.ts";
import { checkPath } from "./path-rules.ts";
import { ProjectError } from "./project-error.ts";
import { configProblem } from "./project-helpers.ts";
import type { Entry, Modes, ProjectOptions } from "./project-types.ts";
import { clashInPaths } from "./spelling.ts";
import { checkModes } from "./view-changes.ts";

/** What creating the project needs from a Project. */
export interface InitHost {
	initialized(): boolean;
	readonly whole: ProjectOptions["whole"];
	wholeOut(
		files: Readonly<Record<string, string | null>>,
		blobs: Readonly<Record<string, string>>,
		view: View | undefined,
		config?: string,
	): { files: Record<string, string | null>; blobs: Record<string, string> };
	checkBlobs(blobs: unknown, files: object): Record<string, string>;
	commit(entries: Entry[]): void;
}

/** Create the project from its first files. */
export function init(
	host: InitHost,
	files: Readonly<Record<string, string>>,
	time: number,
	modes: Modes = {},
	blobs: Readonly<Record<string, string>> = {},
): { version: 0; skipped: string[] } {
	if (host.initialized()) throw new ProjectError("already-initialized", "the project already exists");
	if (typeof files !== "object" || files === null) throw new ProjectError("bad-request", "init needs {files}");
	const clash = clashInPaths([...new Set([...Object.keys(files), ...Object.keys(blobs)])].toSorted());
	if (clash) throw new ProjectError("bad-request", `init: ${clash} (#49)`);
	const config = typeof files["avcs.json"] === "string" ? configProblem(files["avcs.json"]) : undefined;
	if (config) throw new ProjectError("bad-request", `init: avcs.json ${config}`);
	if (host.whole) {
		// The project file being created says which paths are whole (#46).
		const config = typeof files["avcs.json"] === "string" ? files["avcs.json"] : undefined;
		({ files, blobs } = host.wholeOut(files, blobs, undefined, config) as {
			files: Record<string, string>;
			blobs: Record<string, string>;
		});
	}
	const kept: Record<string, string> = {};
	const attrs: AttrSet[] = [];
	for (const [path, sha] of Object.entries(host.checkBlobs(blobs, files)).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
		attrs.push({ file: path, name: "blob", value: sha });
	}
	for (const path of Object.keys(files).toSorted()) {
		checkPath(path);
		const text = files[path];
		if (typeof text !== "string") throw new ProjectError("bad-request", `${path}: file text must be a string`);
		const canonical = canonicalText(text);
		kept[path] = canonical;
		// An empty file is kept by its exists attribute.
		if (canonical === "" && typeof modes[path]?.link !== "string")
			attrs.push({ file: path, name: "exists", value: "1" });
	}
	for (const path of Object.keys(checkModes(modes)).toSorted()) {
		checkPath(path);
		const m = modes[path]!;
		if (m.exec === true) attrs.push({ file: path, name: "exec", value: "1" });
		if (typeof m.link === "string") attrs.push({ file: path, name: "link", value: m.link });
	}
	const atom = buildBase(kept, { author: "init", message: "Start the project", time }, attrs);
	const skipped: string[] = [];
	host.commit([{ type: "init", atom, time }]);
	return { version: 0, skipped };
}
