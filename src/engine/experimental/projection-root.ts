import type { GraphStateStorage } from "../state-source.ts";

/** Internal experiment only. No production writer selects this format. */
export interface ProjectionIdentity {
	readonly database: string;
	readonly namespace: string;
	readonly sourceGeneration: number;
	readonly sourceLength: number;
	readonly sourceDigest: string;
	readonly membership: string;
	readonly registry: string;
	readonly defaultFile: string;
}
export interface ProjectionRoots {
	readonly sequence: number | null;
	readonly sequenceRoot: number | null;
	readonly sequenceNext: number;
	readonly locator: number | null;
	readonly children: number | null;
	readonly membership: number | null;
	readonly attributes: number | null;
}
export interface ProjectionHandle {
	readonly format: 1;
	readonly id: number;
	readonly identity: ProjectionIdentity;
}
interface RootRecord extends ProjectionHandle {
	readonly roots: ProjectionRoots;
}
const fields = [
	"database",
	"namespace",
	"sourceGeneration",
	"sourceLength",
	"sourceDigest",
	"membership",
	"registry",
	"defaultFile",
] as const;
const rootFields = [
	"sequence",
	"sequenceRoot",
	"sequenceNext",
	"locator",
	"children",
	"membership",
	"attributes",
] as const;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
function identity(value: unknown): asserts value is ProjectionIdentity {
	if (!object(value) || Object.keys(value).length !== fields.length) throw Error("invalid projection identity");
	for (const field of fields) {
		const item = value[field];
		if (field === "sourceGeneration" || field === "sourceLength") {
			if (!integer(item)) throw Error("invalid projection source position");
		} else if (typeof item !== "string" || item.length === 0 || item.length > 4096)
			throw Error("invalid projection identity field");
	}
	if (!/^[a-f0-9]{64}$/.test(value.sourceDigest as string)) throw Error("invalid projection source digest");
}
function roots(value: unknown): asserts value is ProjectionRoots {
	if (!object(value) || Object.keys(value).length !== rootFields.length) throw Error("invalid projection roots");
	for (const field of rootFields)
		if (value[field] !== null && !integer(value[field])) throw Error("invalid projection page reference");
	if (
		!integer(value.sequenceNext) ||
		value.sequenceNext > 2 ** 32 ||
		(value.sequenceRoot !== null && (!integer(value.sequenceRoot) || value.sequenceRoot >= value.sequenceNext)) ||
		(value.sequenceRoot === null) !== (value.sequenceNext === 0) ||
		(value.sequence === null) !== (value.sequenceRoot === null)
	)
		throw Error("invalid projection sequence state");
}
export function assertProjectionIdentity(actual: ProjectionIdentity, expected: ProjectionIdentity): void {
	identity(actual);
	identity(expected);
	for (const field of fields)
		if (actual[field] !== expected[field]) throw Error(`projection identity mismatch: ${field}`);
}
function collection(expected: ProjectionIdentity): string {
	return `experimental-projection:${JSON.stringify([expected.database, expected.namespace])}:roots`;
}
/** Identity checks precede storage access. The host supplies trusted expected identity. */
export function readProjectionRoot(
	storage: GraphStateStorage,
	handle: ProjectionHandle,
	expected: ProjectionIdentity,
): ProjectionRoots {
	if (!object(handle) || handle.format !== 1 || !integer(handle.id)) throw Error("invalid projection handle");
	assertProjectionIdentity(handle.identity, expected);
	const record = storage.read(collection(expected), String(handle.id));
	if (!object(record) || record.format !== 1 || record.id !== handle.id || Object.keys(record).length !== 4)
		throw Error("invalid projection root record");
	identity(record.identity);
	assertProjectionIdentity(record.identity, expected);
	roots(record.roots);
	return structuredClone(record.roots);
}
/** The caller's enclosing transaction must include canonical state and its receipt. */
export function createProjectionRoot(
	storage: GraphStateStorage,
	expected: ProjectionIdentity,
	id: number,
	pages: ProjectionRoots,
): ProjectionHandle {
	identity(expected);
	roots(pages);
	if (!integer(id)) throw Error("invalid projection root id");
	const frozenIdentity = structuredClone(expected),
		frozenPages = structuredClone(pages);
	return storage.transaction(() => {
		const name = collection(frozenIdentity);
		if (storage.read(name, String(id)) !== undefined) throw Error("projection root already exists");
		const record: RootRecord = { format: 1, id, identity: frozenIdentity, roots: frozenPages };
		storage.write(name, String(id), record);
		return { format: 1, id, identity: structuredClone(frozenIdentity) };
	});
}
