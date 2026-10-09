// Environment names: ABSO_<NAME>, or the older AVCS_<NAME> from before the rename.
// Read the new one first; where abso sets one for a program it runs, it sets both.

export type EnvMap = Readonly<Record<string, string | undefined>>;

/** ABSO_<name> if set (and not empty), else AVCS_<name>. */
export function fromEnv(env: EnvMap, name: string): string | undefined {
	return env[`ABSO_${name}`] || env[`AVCS_${name}`] || undefined;
}

/** Each ABSO_ entry once more under its AVCS_ name, for programs written before the rename. */
export function withOldNames<T extends Record<string, string | undefined>>(
	vars: T,
): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = { ...vars };
	for (const [k, v] of Object.entries(vars)) if (k.startsWith("ABSO_")) out[`AVCS_${k.slice(5)}`] = v;
	return out;
}
