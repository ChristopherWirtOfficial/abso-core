/** Persisted records for the internal projection experiment; not a production format. */
export type ProjectionPage = number | null;
export interface FileMarker {
	readonly contributions: number;
	readonly kind: "file";
	readonly enter: number;
	readonly exit: number;
}
export interface LineMarker {
	readonly kind: "line";
	readonly enter: number;
	readonly exit: number;
	readonly parentKey: number;
	readonly key: string;
}
export type ProjectionMarker = FileMarker | LineMarker;
export interface ProjectionMembership {
	readonly present: boolean;
	readonly dependents: number;
}
export interface ProjectionChildRoot {
	readonly root: ProjectionPage;
}
export type ProjectionAttributeName = "exists" | "exec" | "link" | "blob";
export type ProjectionAttributes = Partial<Record<ProjectionAttributeName, ProjectionPage>>;
export interface ProjectionAttributeValue {
	readonly value: string | null;
}
const safe = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const markerId = (value: unknown): value is number => safe(value) && value < 2 ** 32;
const page = (value: unknown): value is ProjectionPage => value === null || safe(value);
export function projectionMarker(value: unknown): ProjectionMarker {
	if (!record(value) || !markerId(value.enter) || !markerId(value.exit) || value.enter === value.exit)
		throw Error("invalid projection marker endpoints");
	if (value.kind === "file" && Object.keys(value).length === 4 && safe(value.contributions))
		return { kind: "file", enter: value.enter, exit: value.exit, contributions: value.contributions };
	if (
		value.kind !== "line" ||
		Object.keys(value).length !== 5 ||
		!markerId(value.parentKey) ||
		typeof value.key !== "string" ||
		!/^[0-9a-f]{57}$/.test(value.key)
	)
		throw Error("invalid projection line marker");
	return { kind: "line", enter: value.enter, exit: value.exit, parentKey: value.parentKey, key: value.key };
}
export function projectionMembership(value: unknown): ProjectionMembership {
	if (
		!record(value) ||
		Object.keys(value).length !== 2 ||
		typeof value.present !== "boolean" ||
		!safe(value.dependents) ||
		(!value.present && value.dependents !== 0)
	)
		throw Error("invalid projection membership");
	return { present: value.present, dependents: value.dependents };
}
export function projectionChildRoot(value: unknown): ProjectionChildRoot {
	if (!record(value) || Object.keys(value).length !== 1 || !page(value.root))
		throw Error("invalid projection child root");
	return { root: value.root };
}
export function projectionAttributes(value: unknown): ProjectionAttributes {
	if (!record(value) || Object.keys(value).length > 4) throw Error("invalid projection attributes");
	const out: ProjectionAttributes = {};
	for (const [name, root] of Object.entries(value)) {
		if (!["exists", "exec", "link", "blob"].includes(name) || !page(root))
			throw Error("invalid projection attribute root");
		out[name as ProjectionAttributeName] = root;
	}
	return out;
}
export function projectionAttributeValue(value: unknown): ProjectionAttributeValue {
	if (!record(value) || Object.keys(value).length !== 1 || (value.value !== null && typeof value.value !== "string"))
		throw Error("invalid projection attribute value");
	return { value: value.value };
}
