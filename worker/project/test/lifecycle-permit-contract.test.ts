import assert from "node:assert/strict";
import { test } from "node:test";
import {
	LifecycleAuthorityModel,
	type LifecycleFence,
	type LifecyclePermit,
	LocalInstallStoreModel,
	type VerifiedReplayResult,
} from "../lifecycle-permit-contract.ts";

function setup() {
	const authority = new LifecycleAuthorityModel("authority-test");
	const incarnation = authority.createProject("tenant", "project", ["alice", "bob"]);
	const fence: LifecycleFence = {
		tenant: "tenant",
		project: "project",
		incarnation,
		actor: "alice",
		operationId: "operation-1",
		requestDigest: "request-digest",
		inputDigest: "canonical-input-digest",
		rootDigest: "root-0",
		generation: 0,
		logHead: 10,
		sharedHead: 4,
		actorHead: 6,
		queueSequence: 3,
		authorizationRevision: 1,
		policyRevision: 1,
		build: "engine-build-1",
	};
	const beforeGrant = authority.snapshot();
	const permit = authority.grant(fence);
	const result: VerifiedReplayResult = {
		permitId: permit.id,
		operationId: fence.operationId,
		requestDigest: fence.requestDigest,
		inputDigest: fence.inputDigest,
		actor: fence.actor,
		incarnation,
		authorizationRevision: fence.authorizationRevision,
		policyRevision: fence.policyRevision,
		build: fence.build,
		outputDigest: "output-digest",
		nextRootDigest: "root-1",
		nextGeneration: 1,
		nextLogHead: 12,
		nextSharedHead: 5,
		nextActorHead: 7,
		nextQueueSequence: 4,
	};
	const local = new LocalInstallStoreModel();
	local.seed("tenant", "project", incarnation, "root-0", 0, 10, 4, 6, 3);
	return { authority, beforeGrant, fence, incarnation, permit, result, local };
}

function install(permit: LifecyclePermit, result: VerifiedReplayResult, local: LocalInstallStoreModel) {
	return local.install(permit, result);
}

test("every new safety mutation advances the modeled rollback floor", () => {
	const { authority, beforeGrant, fence, permit, result, local } = setup();
	const afterGrant = authority.snapshot();
	assert.equal(afterGrant.revision, beforeGrant.revision + 1);
	assert.equal(permit.authorityRevision, afterGrant.revision);
	assert.deepEqual(authority.grant(fence), permit);
	assert.equal(authority.snapshot().revision, afterGrant.revision);

	const beforeReplay = authority.snapshot();
	authority.registerReplayResult(permit, result);
	const afterReplay = authority.snapshot().revision;
	assert.equal(afterReplay, beforeReplay.revision + 1);
	authority.registerReplayResult(permit, result);
	assert.equal(authority.snapshot().revision, afterReplay);

	const beforeTransition = authority.snapshot();
	const transition = authority.requestTransition("tenant", "project", "delete-floor", "delete");
	const afterTransition = authority.snapshot();
	assert.equal(transition.status, "draining");
	assert.equal(afterTransition.revision, beforeTransition.revision + 1);
	assert.equal(afterTransition.projects["tenant\u0000project"]?.authorityRevision, afterTransition.revision);
	assert.deepEqual(authority.requestTransition("tenant", "project", "delete-floor", "delete"), transition);
	assert.equal(authority.snapshot().revision, afterTransition.revision);

	const receipt = install(permit, result, local);
	const beforeInstallResolution = authority.snapshot().revision;
	authority.resolveInstall(receipt);
	const afterInstallResolution = authority.snapshot().revision;
	assert.equal(afterInstallResolution, beforeInstallResolution + 2);
	assert.equal(authority.snapshot().projects["tenant\u0000project"]?.authorityRevision, afterInstallResolution);
	authority.resolveInstall(receipt);
	assert.equal(authority.snapshot().revision, afterInstallResolution);
});

test("rollback floors reject snapshots taken before grant, replay registration, or drain", () => {
	const { authority, beforeGrant, fence, permit, result, local } = setup();
	const grantRevision = authority.snapshot().revision;
	const afterGrantRestart = LifecycleAuthorityModel.restart(beforeGrant, grantRevision);
	assert.equal(afterGrantRestart.snapshot().blocked, true);
	assert.equal(afterGrantRestart.snapshot().projects["tenant\u0000project"]?.permit, null);
	const receipt = install(permit, result, local);
	const blockedBeforeGrantActions = afterGrantRestart.snapshot();
	assert.throws(() => afterGrantRestart.grant({ ...fence, operationId: "after-rollback" }), /rollback blocks/);
	assert.throws(
		() => afterGrantRestart.requestTransition("tenant", "project", "after-rollback", "delete"),
		/rollback blocks/,
	);
	assert.throws(() => afterGrantRestart.resolveInstall(receipt), /rollback blocks/);
	assert.deepEqual(afterGrantRestart.snapshot(), blockedBeforeGrantActions);

	const beforeReplay = authority.snapshot();
	authority.registerReplayResult(permit, result);
	const afterReplayRevision = authority.snapshot().revision;
	assert.equal(afterReplayRevision, beforeReplay.revision + 1);
	const afterReplayRollback = LifecycleAuthorityModel.restart(beforeReplay, afterReplayRevision);
	assert.equal(afterReplayRollback.snapshot().blocked, true);
	const blockedBeforeReplayRegistration = afterReplayRollback.snapshot();
	assert.throws(() => afterReplayRollback.registerReplayResult(permit, result), /rollback blocks/);
	assert.deepEqual(afterReplayRollback.snapshot(), blockedBeforeReplayRegistration);

	const beforeDrain = authority.snapshot();
	authority.requestTransition("tenant", "project", "delete-floor", "delete");
	const drainRevision = authority.snapshot().revision;
	assert.equal(drainRevision, beforeDrain.revision + 1);
	const afterDrainRollback = LifecycleAuthorityModel.restart(beforeDrain, drainRevision);
	assert.equal(afterDrainRollback.snapshot().blocked, true);
	assert.equal(afterDrainRollback.snapshot().projects["tenant\u0000project"]?.permit?.id, permit.id);
	const blockedBeforeDrainActions = afterDrainRollback.snapshot();
	assert.throws(
		() => afterDrainRollback.grant({ ...permit.fence, operationId: "during-stale-drain" }),
		/rollback blocks/,
	);
	assert.throws(
		() => afterDrainRollback.requestTransition("tenant", "project", "second-transition", "migration"),
		/rollback blocks/,
	);
	assert.throws(() => afterDrainRollback.resolveInstall(receipt), /rollback blocks/);
	assert.deepEqual(afterDrainRollback.snapshot(), blockedBeforeDrainActions);
});

test("grant-first serializes deletion behind an exact installation receipt", () => {
	const { authority, permit, result, local } = setup();
	assert.equal(authority.requestTransition("tenant", "project", "delete-1", "delete").status, "draining");
	assert.throws(() => authority.grant({ ...permit.fence, operationId: "operation-2" }), /transition blocks/);
	assert.equal(authority.snapshot().projects["tenant\u0000project"]?.phase, "draining");

	authority.registerReplayResult(permit, result);
	const receipt = install(permit, result, local);
	authority.resolveInstall(receipt);
	assert.equal(authority.snapshot().projects["tenant\u0000project"]?.phase, "deleted");
	assert.equal(authority.snapshot().tombstones["tenant\u0000project"], 2);
	assert.throws(() => authority.grant({ ...permit.fence, operationId: "operation-2" }), /transition blocks/);
});

test("transition-first blocks permits and restore rotates the retained incarnation", () => {
	const authority = new LifecycleAuthorityModel();
	const firstIncarnation = authority.createProject("tenant", "project", ["alice"]);
	assert.equal(authority.requestTransition("tenant", "project", "delete-1", "delete").status, "complete");
	const beforeRestore = authority.snapshot();
	assert.throws(() => authority.grant({ ...setup().fence, incarnation: firstIncarnation }), /transition blocks/);
	assert.equal(authority.requestTransition("tenant", "project", "restore-1", "restore").status, "complete");
	const restored = authority.snapshot();
	assert.equal(restored.projects["tenant\u0000project"]?.incarnation, 3);
	assert.equal(restored.tombstones["tenant\u0000project"], 3);
	assert.equal(beforeRestore.tombstones["tenant\u0000project"], 2);
	assert.throws(() => authority.grant({ ...setup().fence, incarnation: firstIncarnation }), /stale lifecycle fence/);
});

test("restart preserves an active hold and a lost install acknowledgement resolves by exact receipt", () => {
	const { authority, permit, result, local } = setup();
	const transition = authority.requestTransition("tenant", "project", "migration-1", "migration");
	assert.equal(transition.status, "draining");
	authority.registerReplayResult(permit, result);

	const restartedAuthority = LifecycleAuthorityModel.restart(authority.snapshot(), authority.snapshot().revision);
	const restartedLocal = LocalInstallStoreModel.restart(local.snapshot());
	assert.throws(() => restartedAuthority.grant({ ...permit.fence, operationId: "operation-2" }), /transition blocks/);
	assert.equal(restartedAuthority.snapshot().projects["tenant\u0000project"]?.permit?.id, permit.id);
	assert.equal(restartedLocal.readReceipt("tenant", "project", permit.fence.operationId), null);

	const receipt = install(permit, result, restartedLocal);
	const afterLocalCommit = LocalInstallStoreModel.restart(restartedLocal.snapshot());
	const afterAuthorityCommit = LifecycleAuthorityModel.restart(
		restartedAuthority.snapshot(),
		restartedAuthority.snapshot().revision,
	);
	const recoveredReceipt = afterLocalCommit.readReceipt("tenant", "project", permit.fence.operationId);
	assert.deepEqual(recoveredReceipt, receipt);
	afterAuthorityCommit.resolveInstall(recoveredReceipt!);
	assert.equal(afterAuthorityCommit.snapshot().projects["tenant\u0000project"]?.phase, "active");
	assert.equal(afterAuthorityCommit.snapshot().projects["tenant\u0000project"]?.incarnation, 2);
	assert.deepEqual(
		afterAuthorityCommit.snapshot().projects["tenant\u0000project"]?.installReceipts["operation-1"],
		receipt,
	);
});

test("no install outcome leaves the hold intact across restart; there is no timeout release", () => {
	const { authority, permit } = setup();
	authority.requestTransition("tenant", "project", "delete-1", "delete");
	const restarted = LifecycleAuthorityModel.restart(authority.snapshot(), authority.snapshot().revision);
	assert.equal(restarted.snapshot().projects["tenant\u0000project"]?.permit?.id, permit.id);
	assert.equal(restarted.snapshot().projects["tenant\u0000project"]?.transition?.status, "draining");
	assert.throws(() => restarted.grant({ ...permit.fence, operationId: "retry-with-new-id" }), /transition blocks/);
	assert.throws(
		() =>
			restarted.resolveInstall({
				permitId: permit.id,
				operationId: permit.fence.operationId,
				tenant: permit.fence.tenant,
				project: permit.fence.project,
				incarnation: permit.fence.incarnation,
				requestDigest: permit.fence.requestDigest,
				outputDigest: "unknown",
				previousRootDigest: permit.fence.rootDigest,
				nextRootDigest: "unknown",
				previousGeneration: permit.fence.generation,
				nextGeneration: 1,
				previousLogHead: permit.fence.logHead,
				nextLogHead: permit.fence.logHead,
				previousSharedHead: permit.fence.sharedHead,
				nextSharedHead: permit.fence.sharedHead,
				previousActorHead: permit.fence.actorHead,
				nextActorHead: permit.fence.actorHead,
				previousQueueSequence: permit.fence.queueSequence,
				nextQueueSequence: permit.fence.queueSequence,
			}),
		/no registered replay result/,
	);
	assert.equal(restarted.snapshot().projects["tenant\u0000project"]?.permit?.id, permit.id);
});

test("local install commits heads and exact receipt together and retries idempotently", () => {
	const { permit, result, local } = setup();
	const receipt = install(permit, result, local);
	assert.deepEqual(install(permit, result, local), receipt);
	const state = local.snapshot().projects["tenant\u0000project"];
	assert.equal(state?.rootDigest, "root-1");
	assert.equal(state?.generation, 1);
	assert.equal(state?.logHead, 12);
	assert.equal(state?.sharedHead, 5);
	assert.equal(state?.actorHead, 7);
	assert.equal(state?.queueSequence, 4);
	assert.deepEqual(local.readReceipt("tenant", "project", "operation-1"), receipt);
	assert.throws(() => install(permit, { ...result, outputDigest: "conflict" }, local), /conflicting install receipt/);
});

test("a stale local snapshot or mismatched challenge changes neither state nor receipt", () => {
	const { permit, result, local } = setup();
	local.seed("tenant", "project", permit.fence.incarnation, "changed-root", 0, 10, 4, 6, 3);
	const before = local.snapshot();
	assert.throws(() => install(permit, result, local), /changed after snapshot/);
	assert.deepEqual(local.snapshot(), before);

	const fresh = new LocalInstallStoreModel();
	fresh.seed("tenant", "project", permit.fence.incarnation, permit.fence.rootDigest, 0, 10, 4, 6, 3);
	assert.throws(() => install(permit, { ...result, build: "unreviewed-build" }, fresh), /does not match its permit/);
	assert.equal(fresh.readReceipt("tenant", "project", "operation-1"), null);
});

test("a same-ID permit clone cannot redefine the challenge used for replay registration", () => {
	const { authority, permit, result } = setup();
	const before = authority.snapshot();
	const alteredPermit: LifecyclePermit = {
		...permit,
		fence: {
			...permit.fence,
			actor: "bob",
			authorizationRevision: 2,
			policyRevision: 7,
			build: "different-build",
		},
	};
	const alteredResult = {
		...result,
		actor: "bob",
		authorizationRevision: 2,
		policyRevision: 7,
		build: "different-build",
	};

	assert.throws(
		() => authority.registerReplayResult(alteredPermit, alteredResult),
		/does not match the authoritative challenge/,
	);
	assert.deepEqual(authority.snapshot(), before);
});

test("completed lifecycle transitions are not replayed by later installs after restart", () => {
	const initial = setup();
	let authority = initial.authority;
	let local = initial.local;
	let actor = "alice";
	let operationNumber = 0;
	let rootDigest = initial.fence.rootDigest;
	let generation = initial.fence.generation;
	let logHead = initial.fence.logHead;
	let sharedHead = initial.fence.sharedHead;
	let actorHead = initial.fence.actorHead;
	let queueSequence = initial.fence.queueSequence;

	const perform = (transition?: { kind: "delete" | "migration" | "revoke-actor"; actor?: string }) => {
		const project = authority.snapshot().projects["tenant\u0000project"]!;
		const operationId = `operation-${++operationNumber}`;
		const fence: LifecycleFence = {
			...initial.fence,
			operationId,
			actor,
			incarnation: project.incarnation,
			authorizationRevision: project.authorizationRevision,
			policyRevision: project.policyRevision,
			rootDigest,
			generation,
			logHead,
			sharedHead,
			actorHead,
			queueSequence,
		};
		const permit = authority.grant(fence);
		if (transition)
			authority.requestTransition(
				"tenant",
				"project",
				`transition-${operationNumber}`,
				transition.kind,
				transition.actor,
			);
		const result: VerifiedReplayResult = {
			permitId: permit.id,
			operationId,
			requestDigest: fence.requestDigest,
			inputDigest: fence.inputDigest,
			actor: fence.actor,
			incarnation: fence.incarnation,
			authorizationRevision: fence.authorizationRevision,
			policyRevision: fence.policyRevision,
			build: fence.build,
			outputDigest: `output-${operationNumber}`,
			nextRootDigest: `root-${operationNumber}`,
			nextGeneration: generation + 1,
			nextLogHead: logHead + 2,
			nextSharedHead: sharedHead + 1,
			nextActorHead: actorHead + 1,
			nextQueueSequence: queueSequence,
		};
		authority.registerReplayResult(permit, result);
		const receipt = local.install(permit, result);
		authority.resolveInstall(receipt);
		rootDigest = result.nextRootDigest;
		generation = result.nextGeneration;
		logHead = result.nextLogHead;
		sharedHead = result.nextSharedHead;
		actorHead = result.nextActorHead;
		queueSequence = result.nextQueueSequence;
		return authority.snapshot().projects["tenant\u0000project"]!;
	};

	const restart = () => {
		const snapshot = authority.snapshot();
		authority = LifecycleAuthorityModel.restart(snapshot, snapshot.revision);
		local = LocalInstallStoreModel.restart(local.snapshot());
	};
	const rebindLocalIncarnation = (incarnation: number) => {
		const snapshot = local.snapshot();
		const projectKey = "tenant\u0000project";
		const projectState = snapshot.projects[projectKey]!;
		local = LocalInstallStoreModel.restart({
			...snapshot,
			projects: { ...snapshot.projects, [projectKey]: { ...projectState, incarnation } },
		});
	};

	let project = perform({ kind: "migration" });
	assert.equal(project.incarnation, 2);
	assert.equal(project.authorityRevision, authority.snapshot().revision);
	restart();
	rebindLocalIncarnation(project.incarnation);
	project = perform();
	assert.equal(project.incarnation, 2);

	project = perform({ kind: "revoke-actor", actor: "alice" });
	assert.equal(project.authorizationRevision, 2);
	assert.equal(project.actors.includes("alice"), false);
	actor = "bob";
	restart();
	project = perform();
	assert.equal(project.incarnation, 2);
	assert.equal(project.authorizationRevision, 2);

	project = perform({ kind: "delete" });
	assert.equal(project.phase, "deleted");
	assert.equal(project.incarnation, 3);
	restart();
	authority.requestTransition("tenant", "project", "restore-final", "restore");
	project = authority.snapshot().projects["tenant\u0000project"]!;
	assert.equal(project.phase, "active");
	assert.equal(project.incarnation, 4);
	restart();
	local = new LocalInstallStoreModel();
	local.seed(
		"tenant",
		"project",
		project.incarnation,
		rootDigest,
		generation,
		logHead,
		sharedHead,
		actorHead,
		queueSequence,
	);
	project = perform();
	assert.equal(project.incarnation, 4);
	assert.equal(project.authorizationRevision, 2);
});

test("actor revocation drains an active permit and invalidates the old authorization revision", () => {
	const { authority, permit, result, local } = setup();
	assert.equal(
		authority.requestTransition("tenant", "project", "revoke-alice", "revoke-actor", "alice").status,
		"draining",
	);
	authority.registerReplayResult(permit, result);
	const receipt = install(permit, result, local);
	authority.resolveInstall(receipt);
	const state = authority.snapshot().projects["tenant\u0000project"];
	assert.equal(state?.authorizationRevision, 2);
	assert.equal(state?.actors.includes("alice"), false);
	assert.throws(() => authority.grant({ ...permit.fence, operationId: "operation-2" }), /actor is not authorized/);
});

test("authority rollback behind the independent high-water floor fails closed", () => {
	const { authority, permit } = setup();
	const behind = LifecycleAuthorityModel.restart(authority.snapshot(), authority.snapshot().revision + 1);
	assert.throws(() => behind.grant({ ...permit.fence, operationId: "operation-2" }), /rollback blocks/);
	assert.throws(() => behind.requestTransition("tenant", "project", "delete-1", "delete"), /rollback blocks/);
	assert.throws(() => behind.createProject("tenant", "other", ["alice"]), /rollback blocks/);
	assert.equal(behind.snapshot().projects["tenant\u0000project"]?.phase, "blocked");
});
