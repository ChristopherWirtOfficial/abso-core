/**
 * A deterministic model of the lifecycle permit contract for #560.
 *
 * This is not a live issuer, durable authority, or authentication mechanism.
 * It models the serialized decisions a future server-owned authority must
 * preserve across restart. The caller supplies already authenticated facts.
 */

export type LifecycleTransitionKind = "delete" | "restore" | "migration" | "revoke-actor";

export interface LifecycleFence {
	readonly tenant: string;
	readonly project: string;
	readonly incarnation: number;
	readonly actor: string;
	readonly operationId: string;
	readonly requestDigest: string;
	readonly inputDigest: string;
	readonly rootDigest: string;
	readonly generation: number;
	readonly logHead: number;
	readonly sharedHead: number;
	readonly actorHead: number;
	readonly queueSequence: number;
	readonly authorizationRevision: number;
	readonly policyRevision: number;
	readonly build: string;
}

export interface LifecyclePermit {
	readonly id: string;
	readonly fence: LifecycleFence;
	readonly authorityRevision: number;
	readonly status: "active" | "installed";
}

export interface VerifiedReplayResult {
	readonly permitId: string;
	readonly operationId: string;
	readonly requestDigest: string;
	readonly inputDigest: string;
	readonly actor: string;
	readonly incarnation: number;
	readonly authorizationRevision: number;
	readonly policyRevision: number;
	readonly build: string;
	readonly outputDigest: string;
	readonly nextRootDigest: string;
	readonly nextGeneration: number;
	readonly nextLogHead: number;
	readonly nextSharedHead: number;
	readonly nextActorHead: number;
	readonly nextQueueSequence: number;
}

export interface InstallReceipt {
	readonly permitId: string;
	readonly operationId: string;
	readonly tenant: string;
	readonly project: string;
	readonly incarnation: number;
	readonly requestDigest: string;
	readonly outputDigest: string;
	readonly previousRootDigest: string;
	readonly nextRootDigest: string;
	readonly previousGeneration: number;
	readonly nextGeneration: number;
	readonly previousLogHead: number;
	readonly nextLogHead: number;
	readonly previousSharedHead: number;
	readonly nextSharedHead: number;
	readonly previousActorHead: number;
	readonly nextActorHead: number;
	readonly previousQueueSequence: number;
	readonly nextQueueSequence: number;
}

export interface LifecycleTransition {
	readonly id: string;
	readonly kind: LifecycleTransitionKind;
	readonly actor?: string;
	readonly status: "draining" | "complete";
}

interface ProjectAuthority {
	phase: "active" | "draining" | "deleted" | "blocked";
	incarnation: number;
	authorizationRevision: number;
	policyRevision: number;
	actors: string[];
	authorityRevision: number;
	permit: LifecyclePermit | null;
	transition: LifecycleTransition | null;
	transitions: Record<string, LifecycleTransition>;
	permits: Record<string, LifecyclePermit>;
	replayResults: Record<string, VerifiedReplayResult>;
	installReceipts: Record<string, InstallReceipt>;
}

export interface LifecycleAuthoritySnapshot {
	readonly authorityId: string;
	readonly revision: number;
	readonly blocked: boolean;
	readonly projects: Readonly<Record<string, ProjectAuthority>>;
	readonly tombstones: Readonly<Record<string, number>>;
}

function key(tenant: string, project: string): string {
	return `${tenant}\u0000${project}`;
}

function copy<T>(value: T): T {
	return structuredClone(value);
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Modeled serialized authority. It deliberately has no timeout or expiry API. */
export class LifecycleAuthorityModel {
	private state: {
		authorityId: string;
		revision: number;
		blocked: boolean;
		projects: Record<string, ProjectAuthority>;
		tombstones: Record<string, number>;
	};

	constructor(authorityId = "modeled-authority") {
		this.state = { authorityId, revision: 0, blocked: false, projects: {}, tombstones: {} };
	}

	static restart(snapshot: LifecycleAuthoritySnapshot, externalFloor: number): LifecycleAuthorityModel {
		const model = new LifecycleAuthorityModel(snapshot.authorityId);
		model.state = copy(snapshot);
		// A real authority must advance this floor atomically with each safety
		// mutation. This model only checks the supplied floor; it does not prove
		// that an independent durable floor exists or cannot be rewound.
		if (model.state.revision < externalFloor) {
			model.state.blocked = true;
			for (const project of Object.values(model.state.projects)) project.phase = "blocked";
		}
		return model;
	}

	snapshot(): LifecycleAuthoritySnapshot {
		return copy(this.state);
	}

	createProject(
		tenant: string,
		project: string,
		actors: readonly string[],
		authorizationRevision = 1,
		policyRevision = 1,
	): number {
		if (this.state.blocked) throw new Error("authority rollback blocks project creation");
		const projectKey = key(tenant, project);
		if (this.state.projects[projectKey] || this.state.tombstones[projectKey])
			throw new Error("existing project identities require a serialized restore transition");
		const incarnation = (this.state.tombstones[projectKey] ?? 0) + 1;
		this.state.revision++;
		this.state.tombstones[projectKey] = incarnation;
		this.state.projects[projectKey] = {
			phase: "active",
			incarnation,
			authorizationRevision,
			policyRevision,
			actors: [...new Set(actors)].sort(),
			authorityRevision: this.state.revision,
			permit: null,
			transition: null,
			transitions: {},
			permits: {},
			replayResults: {},
			installReceipts: {},
		};
		return incarnation;
	}

	grant(fence: LifecycleFence): LifecyclePermit {
		if (this.state.blocked) throw new Error("authority rollback blocks permits");
		const project = this.project(fence.tenant, fence.project);
		const previous = project.permits[fence.operationId];
		if (previous) {
			if (!same(previous.fence, fence)) throw new Error("operation identifier reused with a different fence");
			return copy(previous);
		}
		if (project.phase !== "active" || project.transition?.status === "draining")
			throw new Error("lifecycle transition blocks new permits");
		if (!project.actors.includes(fence.actor)) throw new Error("actor is not authorized");
		if (
			fence.incarnation !== project.incarnation ||
			fence.authorizationRevision !== project.authorizationRevision ||
			fence.policyRevision !== project.policyRevision
		)
			throw new Error("stale lifecycle fence");
		if (project.permit) throw new Error("another permit holds the project");
		// Persisting a hold is itself a safety mutation. Advance the modeled
		// high-water revision before issuing a permit so a pre-grant snapshot
		// cannot be accepted after this grant.
		this.state.revision++;
		project.authorityRevision = this.state.revision;
		const permit: LifecyclePermit = {
			id: `${project.authorityRevision}:${fence.operationId}`,
			fence: copy(fence),
			authorityRevision: project.authorityRevision,
			status: "active",
		};
		project.permit = permit;
		project.permits[fence.operationId] = permit;
		return copy(permit);
	}

	registerReplayResult(permit: LifecyclePermit, result: VerifiedReplayResult): void {
		if (this.state.blocked) throw new Error("authority rollback blocks replay results");
		const project = this.project(permit.fence.tenant, permit.fence.project);
		const authoritativePermit = project.permit;
		if (!authoritativePermit || authoritativePermit.id !== permit.id || authoritativePermit.status !== "active")
			throw new Error("replay result has no active permit");
		if (!same(authoritativePermit, permit)) throw new Error("permit does not match the authoritative challenge");
		const operationId = permit.fence.operationId;
		const existing = project.replayResults[operationId];
		if (existing) {
			if (!same(existing, result)) throw new Error("conflicting replay result for permit");
			return;
		}
		if (
			result.permitId !== permit.id ||
			result.operationId !== operationId ||
			result.requestDigest !== permit.fence.requestDigest ||
			result.inputDigest !== permit.fence.inputDigest ||
			result.actor !== permit.fence.actor ||
			result.incarnation !== permit.fence.incarnation ||
			result.authorizationRevision !== permit.fence.authorizationRevision ||
			result.policyRevision !== permit.fence.policyRevision ||
			result.build !== permit.fence.build
		)
			throw new Error("replay result does not match the permit challenge");
		project.replayResults[operationId] = copy(result);
		this.state.revision++;
		project.authorityRevision = this.state.revision;
	}

	requestTransition(
		tenant: string,
		projectId: string,
		transitionId: string,
		kind: LifecycleTransitionKind,
		actor?: string,
	): LifecycleTransition {
		if (this.state.blocked) throw new Error("authority rollback blocks lifecycle changes");
		const project = this.project(tenant, projectId);
		if (project.phase === "blocked") throw new Error("authority rollback blocks lifecycle changes");
		const previous = project.transitions[transitionId];
		if (previous) {
			if (previous.kind !== kind || previous.actor !== actor) throw new Error("conflicting lifecycle transition");
			return copy(previous);
		}
		if (project.transition?.status === "draining") throw new Error("conflicting lifecycle transition");
		if (project.phase === "deleted" && kind !== "restore") throw new Error("deleted project requires restore");
		if (project.phase !== "deleted" && kind === "restore") throw new Error("restore requires a deleted project");
		if (kind === "revoke-actor" && (!actor || !project.actors.includes(actor)))
			throw new Error("actor revocation target is not active");
		project.transition = { id: transitionId, kind, actor, status: "draining" };
		project.transitions[transitionId] = project.transition;
		project.phase = "draining";
		// Draining must also advance the floor: a snapshot from before this
		// transition must not be restarted as though no transition existed.
		this.state.revision++;
		project.authorityRevision = this.state.revision;
		if (!project.permit) this.finishTransition(project, tenant, projectId);
		return copy(project.transitions[transitionId]);
	}

	resolveInstall(receipt: InstallReceipt): void {
		if (this.state.blocked) throw new Error("authority rollback blocks receipt resolution");
		const project = this.projectById(receipt.project, receipt);
		const resolved = project.installReceipts[receipt.operationId];
		if (resolved) {
			if (!same(resolved, receipt)) throw new Error("conflicting install receipt");
			return;
		}
		const permit = project.permits[receipt.operationId];
		if (!permit || permit.id !== receipt.permitId) throw new Error("receipt has no matching permit");
		if (!project.permit || project.permit.id !== receipt.permitId) throw new Error("permit is not the active hold");
		const result = project.replayResults[receipt.operationId];
		if (!result) throw new Error("install outcome has no registered replay result");
		if (
			receipt.tenant !== permit.fence.tenant ||
			receipt.project !== permit.fence.project ||
			receipt.incarnation !== permit.fence.incarnation ||
			receipt.requestDigest !== permit.fence.requestDigest ||
			receipt.outputDigest !== result.outputDigest ||
			receipt.nextRootDigest !== result.nextRootDigest ||
			receipt.nextGeneration !== result.nextGeneration ||
			receipt.nextLogHead !== result.nextLogHead ||
			receipt.nextSharedHead !== result.nextSharedHead ||
			receipt.nextActorHead !== result.nextActorHead ||
			receipt.nextQueueSequence !== result.nextQueueSequence ||
			receipt.previousRootDigest !== permit.fence.rootDigest ||
			receipt.previousGeneration !== permit.fence.generation ||
			receipt.previousLogHead !== permit.fence.logHead ||
			receipt.previousSharedHead !== permit.fence.sharedHead ||
			receipt.previousActorHead !== permit.fence.actorHead ||
			receipt.previousQueueSequence !== permit.fence.queueSequence
		)
			throw new Error("install receipt does not match the held snapshot");
		project.installReceipts[receipt.operationId] = copy(receipt);
		project.permits[receipt.operationId] = { ...permit, status: "installed" };
		project.permit = null;
		this.state.revision++;
		project.authorityRevision = this.state.revision;
		if (project.transition) this.finishTransition(project, receipt.tenant, receipt.project);
	}

	private finishTransition(project: ProjectAuthority, tenant: string, projectId: string): void {
		const transition = project.transition;
		if (!transition || transition.status !== "draining" || project.permit) return;
		if (transition.kind === "delete") {
			project.phase = "deleted";
			project.incarnation++;
			this.state.tombstones[key(tenant, projectId)] = project.incarnation;
		} else if (transition.kind === "restore" || transition.kind === "migration") {
			project.incarnation++;
			project.phase = "active";
			this.state.tombstones[key(tenant, projectId)] = project.incarnation;
		} else {
			project.actors = project.actors.filter((entry) => entry !== transition.actor);
			project.authorizationRevision++;
			project.phase = "active";
		}
		this.state.revision++;
		project.authorityRevision = this.state.revision;
		project.transition = { ...transition, status: "complete" };
		project.transitions[transition.id] = project.transition;
	}

	private project(tenant: string, projectId: string): ProjectAuthority {
		const project = this.state.projects[key(tenant, projectId)];
		if (!project) throw new Error("unknown project");
		return project;
	}

	private projectById(projectId: string, receipt: InstallReceipt): ProjectAuthority {
		const project = this.state.projects[key(receipt.tenant, projectId)];
		if (!project) throw new Error("unknown project");
		return project;
	}
}

interface LocalProjectState {
	readonly tenant: string;
	readonly project: string;
	readonly incarnation: number;
	rootDigest: string;
	generation: number;
	logHead: number;
	sharedHead: number;
	actorHead: number;
	queueSequence: number;
}

export interface LocalInstallSnapshot {
	readonly projects: Readonly<Record<string, LocalProjectState>>;
	readonly receipts: Readonly<Record<string, InstallReceipt>>;
}

/**
 * Models the project-local transaction only. A real implementation must use
 * one durable SQLite transaction for state and receipt.
 */
export class LocalInstallStoreModel {
	private projects: Record<string, LocalProjectState> = {};
	private receipts: Record<string, InstallReceipt> = {};

	static restart(snapshot: LocalInstallSnapshot): LocalInstallStoreModel {
		const store = new LocalInstallStoreModel();
		store.projects = copy(snapshot.projects);
		store.receipts = copy(snapshot.receipts);
		return store;
	}

	snapshot(): LocalInstallSnapshot {
		return copy({ projects: this.projects, receipts: this.receipts });
	}

	seed(
		tenant: string,
		project: string,
		incarnation: number,
		rootDigest: string,
		generation = 0,
		logHead = 0,
		sharedHead = 0,
		actorHead = 0,
		queueSequence = 0,
	): void {
		this.projects[key(tenant, project)] = {
			tenant,
			project,
			incarnation,
			rootDigest,
			generation,
			logHead,
			sharedHead,
			actorHead,
			queueSequence,
		};
	}

	install(permit: LifecyclePermit, result: VerifiedReplayResult): InstallReceipt {
		const fence = permit.fence;
		const receiptKey = `${fence.tenant}\u0000${fence.project}\u0000${fence.operationId}`;
		const existing = this.receipts[receiptKey];
		if (existing) {
			if (
				existing.permitId !== permit.id ||
				existing.outputDigest !== result.outputDigest ||
				existing.nextRootDigest !== result.nextRootDigest ||
				existing.nextGeneration !== result.nextGeneration ||
				existing.nextLogHead !== result.nextLogHead ||
				existing.nextSharedHead !== result.nextSharedHead ||
				existing.nextActorHead !== result.nextActorHead ||
				existing.nextQueueSequence !== result.nextQueueSequence
			)
				throw new Error("operation already has a conflicting install receipt");
			return copy(existing);
		}
		if (permit.status !== "active") throw new Error("permit is not active");
		if (
			result.permitId !== permit.id ||
			result.operationId !== fence.operationId ||
			result.requestDigest !== fence.requestDigest ||
			result.inputDigest !== fence.inputDigest ||
			result.actor !== fence.actor ||
			result.incarnation !== fence.incarnation ||
			result.authorizationRevision !== fence.authorizationRevision ||
			result.policyRevision !== fence.policyRevision ||
			result.build !== fence.build
		)
			throw new Error("replay result does not match its permit");
		const project = this.projects[key(fence.tenant, fence.project)];
		if (!project) throw new Error("local project is missing");
		if (
			project.incarnation !== fence.incarnation ||
			project.rootDigest !== fence.rootDigest ||
			project.generation !== fence.generation ||
			project.logHead !== fence.logHead ||
			project.sharedHead !== fence.sharedHead ||
			project.actorHead !== fence.actorHead ||
			project.queueSequence !== fence.queueSequence
		)
			throw new Error("local project changed after snapshot authorization");
		if (
			result.nextGeneration <= project.generation ||
			result.nextLogHead < project.logHead ||
			result.nextSharedHead < project.sharedHead ||
			result.nextActorHead < project.actorHead ||
			result.nextQueueSequence < project.queueSequence
		)
			throw new Error("replay result moves a head backwards");

		const receipt: InstallReceipt = {
			permitId: permit.id,
			operationId: fence.operationId,
			tenant: fence.tenant,
			project: fence.project,
			incarnation: fence.incarnation,
			requestDigest: fence.requestDigest,
			outputDigest: result.outputDigest,
			previousRootDigest: project.rootDigest,
			nextRootDigest: result.nextRootDigest,
			previousGeneration: project.generation,
			nextGeneration: result.nextGeneration,
			previousLogHead: project.logHead,
			nextLogHead: result.nextLogHead,
			previousSharedHead: project.sharedHead,
			nextSharedHead: result.nextSharedHead,
			previousActorHead: project.actorHead,
			nextActorHead: result.nextActorHead,
			previousQueueSequence: project.queueSequence,
			nextQueueSequence: result.nextQueueSequence,
		};
		// Construct everything first, then perform the modeled atomic state/receipt commit.
		this.projects[key(fence.tenant, fence.project)] = {
			...project,
			rootDigest: receipt.nextRootDigest,
			generation: receipt.nextGeneration,
			logHead: receipt.nextLogHead,
			sharedHead: receipt.nextSharedHead,
			actorHead: receipt.nextActorHead,
			queueSequence: receipt.nextQueueSequence,
		};
		this.receipts[receiptKey] = receipt;
		return copy(receipt);
	}

	readReceipt(tenant: string, project: string, operationId: string): InstallReceipt | null {
		const receipt = this.receipts[`${tenant}\u0000${project}\u0000${operationId}`];
		return receipt ? copy(receipt) : null;
	}
}
