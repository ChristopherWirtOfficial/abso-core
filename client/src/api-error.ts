// How a call to the server fails: an ApiError, and whether the request ever went out.

export class ApiError extends Error {
	readonly status: number | undefined;
	/** The connection never opened, so the request never reached the server (safe to run again). */
	readonly notSent: boolean;
	constructor(message: string, status?: number, notSent = false) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.notSent = notSent;
	}
}

/** Codes for a connection that never opened: the request never went out. */
const NOT_SENT = new Set([
	"UND_ERR_CONNECT_TIMEOUT",
	"ECONNREFUSED",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EADDRNOTAVAIL",
]);

/** Whether a fetch failed before its request went out (connect timeout, refused, no route, no DNS answer). */
export function neverSent(err: unknown): boolean {
	const cause = (err as { cause?: { code?: string; errors?: readonly { code?: string }[] } }).cause;
	if (cause === undefined) return false;
	if (NOT_SENT.has(cause.code ?? "")) return true;
	// Trying each address in turn (Node's autoSelectFamily) fails with every attempt's error.
	return (
		Array.isArray(cause.errors) &&
		cause.errors.length > 0 &&
		cause.errors.every((e) => NOT_SENT.has(e.code ?? "") || e.code === "ETIMEDOUT")
	);
}

/** The server's `{error: "sentence"}` answer, or the start of whatever it sent. */
export function errorSentence(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: unknown; reason?: unknown };
		if (typeof parsed.error === "string") return parsed.error;
		if (typeof parsed.reason === "string") return parsed.reason;
	} catch {
		// Not JSON.
	}
	return body.slice(0, 300);
}
