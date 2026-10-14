/** An admission refusal that is stable for the same remote head and limit policy. */
export class GitIntakeLimitError extends Error {
	readonly kind: "pack" | "object" | "decoded" | "delta";
	constructor(kind: GitIntakeLimitError["kind"], message: string) {
		super(message);
		this.kind = kind;
	}
}
