/** What the view shows, as of the last refresh. */
export type AvcsView = {
	/** The abso folder, project and agent, or null outside one. */
	folder: { root: string; project: string; agent: string } | null;
	/** shared, or the named draft the agent is in. */
	space: string;
	/** The version the space is at, and the version the agent's draft builds on. */
	version: number;
	base: number | null;
	/** Files with unpublished changes, and how many changes. */
	files: string[];
	changes: number;
	/** Unpublished work left in other spaces. */
	parked: { space: string; changes: number }[];
	/** Other agents with unpublished changes in the same files: agent -> files. */
	overlap: { agent: string; files: string[] }[];
	/** The newest news lines, oldest first: [iso time, sentence]. */
	news: [string, string][];
	/** When the view was refreshed (ms), and the error if the last refresh failed. */
	at: number;
	error: string | null;
};

declare module "claude-code" {
	interface PluginState {
		"abso-view": { view: AvcsView | null; seenNewsAt: string };
	}
}
