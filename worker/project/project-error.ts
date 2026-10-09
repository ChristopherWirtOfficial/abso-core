import type { ProjectErrorCode } from "./project-types.ts";

/** Bad input from a caller. The Worker answers 400 (409 for already-initialized). */
export class ProjectError extends Error {
	readonly code: ProjectErrorCode;
	constructor(code: ProjectErrorCode, message: string) {
		super(message);
		this.name = "ProjectError";
		this.code = code;
	}
}
