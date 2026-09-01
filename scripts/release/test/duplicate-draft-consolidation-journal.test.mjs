import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { inspectEquivalentDrafts } from "../duplicate-draft-consolidation-evidence.mjs";
import {
	appendJournalEvent,
	createConsolidationJournal,
	createFinalConsolidationReceipt,
	deriveConsolidationState,
	nextResumeAction,
	parseConsolidationJournal,
} from "../duplicate-draft-consolidation-journal.mjs";
import {
	canonicalEventEnvelope,
	canonicalRecordSha256,
	createConsolidationEnvelope,
} from "../duplicate-draft-consolidation-schema.mjs";
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs";
import {
	createDuplicateDraftConsolidationFixture,
	DUPLICATE_DRAFT_CANDIDATE,
	DUPLICATE_DRAFT_IDS,
	DUPLICATE_DRAFT_SURVIVOR_ID,
} from "./support/duplicate-draft-consolidation-fixture.mjs";

const CONTROLLER_SHA = DUPLICATE_DRAFT_CANDIDATE.commitSha;
const REPOSITORY_ID = "1210070282";
const ACTOR = Object.freeze({ login: "blove", id: "61436" });
const TAG_OBJECT_SHA = "a".repeat(40);
const WORKFLOW_ID = "202458345";
const BASE_TIME = Date.parse("2026-09-01T12:00:00.000Z");
let confirmationSha256;

let fixture;

test.before(async () => {
	fixture = await journalFixture();
	confirmationSha256 = createHash("sha256")
		.update(exactConfirmation(fixture.proposedEnvelope), "utf8")
		.digest("hex");
});

test("creates and strictly parses an immutable canonical operation journal", () => {
	const journal = newJournal();
	const parsed = parseConsolidationJournal(journal);

	assert.notEqual(parsed, journal);
	assert.deepEqual(parsed, journal);
	assert.equal(parsed.record.events.length, 1);
	assert.equal(parsed.record.events[0].event.type, "operation-started");
	assert.equal(parsed.record.events[0].event.sequence, 1);
	assert.equal(parsed.record.events[0].event.previousEventSha256, null);
	assert.equal(Object.isFrozen(parsed), true);
	assert.equal(Object.isFrozen(parsed.record.events), true);
	assert.equal(deriveConsolidationState(parsed).phase, "operation-started");
});

test("rejects event hash mutation, sequence gaps, reordering, and raw truncation", () => {
	const authority = preDeleteAuthority(0);
	const started = newJournal();
	const withAuthority = appendAuthority(started, 0, 1, authority, 1);
	const withIntent = appendIntent(withAuthority, 0, 1, 2);

	for (const mutate of [
		(value) => {
			value.record.events[1].event.payload.attemptNumber = 2;
		},
		(value) => {
			value.record.events[1].event.sequence = 7;
		},
		(value) => {
			[value.record.events[1], value.record.events[2]] = [
				value.record.events[2],
				value.record.events[1],
			];
		},
		(value) => {
			value.record.events.pop();
		},
	]) {
		const changed = structuredClone(withIntent);
		mutate(changed);
		assert.throws(
			() => parseConsolidationJournal(changed),
			/digest|sequence|previous|canonical|bind/iu,
		);
	}
});

test("replays every event type through the fixed two-target confirmed-204 sequence", () => {
	let journal = newJournal();
	journal = appendNpm(journal, 0, 1, "perform-initial", 1);
	journal = appendAuthority(journal, 0, 1, preDeleteAuthority(0), 2);
	journal = appendIntent(journal, 0, 1, 3);
	journal = appendOutcome(journal, 0, 1, "confirmed-204", 204, 4);
	journal = appendAbsence(journal, 0, 1, "confirmed-204", 5);
	journal = appendAuthority(journal, 1, 1, preDeleteAuthority(1), 6);
	journal = appendIntent(journal, 1, 1, 7);
	journal = appendOutcome(journal, 1, 1, "confirmed-204", 204, 8);
	journal = appendAbsence(journal, 1, 1, "confirmed-204", 9);
	journal = appendJournalEvent(
		journal,
		"final-authority-observed",
		{ authority: finalAuthority() },
		at(10),
	);

	const state = deriveConsolidationState(journal);
	assert.deepEqual(state.completedTargets, [...DUPLICATE_DRAFT_IDS]);
	assert.equal(state.currentTargetReleaseId, null);
	assert.equal(state.phase, "final-authority-observed");
	assert.equal(
		nextResumeAction(state, { classification: "absent" }),
		"complete",
	);
});

test("rejects second-target events before first-target absence convergence", () => {
	assert.throws(
		() => appendAuthority(newJournal(), 1, 1, preDeleteAuthority(1), 1),
		/order|target|preceding|converge/iu,
	);
});

test("requires an authority event and its exact digest immediately before intent", () => {
	assert.throws(
		() =>
			appendJournalEvent(
				newJournal(),
				"delete-intent",
				{
					targetReleaseId: DUPLICATE_DRAFT_IDS[0],
					attemptNumber: 1,
					authorityEventSha256: "d".repeat(64),
				},
				at(1),
			),
		/authority|intent|preced/iu,
	);
	const authorityJournal = appendAuthority(
		newJournal(),
		0,
		1,
		preDeleteAuthority(0),
		1,
	);
	assert.throws(
		() =>
			appendJournalEvent(
				authorityJournal,
				"delete-intent",
				{
					targetReleaseId: DUPLICATE_DRAFT_IDS[0],
					attemptNumber: 1,
					authorityEventSha256: "d".repeat(64),
				},
				at(2),
			),
		/digest|authority|intent|bind/iu,
	);
});

for (const [classification, httpStatus] of [
	["transport-ambiguous", null],
	["response-404-ambiguous", 404],
]) {
	test(`${classification} may converge absent without erasing its ambiguity`, () => {
		let journal = appendIntent(
			appendAuthority(newJournal(), 0, 1, preDeleteAuthority(0), 1),
			0,
			1,
			2,
		);
		journal = appendOutcome(journal, 0, 1, classification, httpStatus, 3);
		assert.equal(
			nextResumeAction(deriveConsolidationState(journal), {
				classification: "absent",
				directGet404At: at(4),
				listAbsentAt: at(4),
				attempts: 2,
			}),
			"reconcile-absence",
		);
		journal = appendAbsence(journal, 0, 1, "ambiguous", 4);
		assert.equal(deriveConsolidationState(journal).phase, "target-converged");
	});
}

test("an intent with no outcome and unchanged target requires reconciliation then a fresh attempt", () => {
	const authority = preDeleteAuthority(0);
	let journal = appendIntent(
		appendAuthority(newJournal(), 0, 1, authority, 1),
		0,
		1,
		2,
	);
	let state = deriveConsolidationState(journal);
	assert.equal(
		nextResumeAction(state, {
			classification: "present-unchanged",
			releaseEvidence: targetEvidence(authority),
			observations: 1,
		}),
		"refresh-and-retry",
	);
	journal = appendReconciliation(
		journal,
		0,
		1,
		"present-unchanged-retryable",
		targetEvidence(authority),
		3,
	);
	journal = appendAuthority(journal, 0, 2, preDeleteAuthority(0), 4);
	journal = appendIntent(journal, 0, 2, 5);
	state = deriveConsolidationState(journal);
	assert.equal(state.attemptNumber, 2);
	assert.equal(state.phase, "delete-intent");
});

test("a retry perform-initial observation advances and binds the next attempt", () => {
	const authority = preDeleteAuthority(0);
	let journal = appendAuthority(newJournal(), 0, 1, authority, 1);
	journal = appendIntent(journal, 0, 1, 2);
	journal = appendReconciliation(
		journal,
		0,
		1,
		"present-unchanged-retryable",
		targetEvidence(authority),
		3,
	);
	journal = appendNpm(journal, 0, 2, "perform-initial", 4);
	assert.equal(deriveConsolidationState(journal).attemptNumber, 2);
	journal = appendAuthority(journal, 0, 2, preDeleteAuthority(0), 5);
	journal = appendIntent(journal, 0, 2, 6);
	assert.equal(deriveConsolidationState(journal).attemptNumber, 2);
	assert.throws(
		() => appendNpm(journal, 0, 3, "perform-initial", 7),
		/state|attempt|legal/iu,
	);
});

test("recorded ambiguity requires six unchanged reads before retry, or reconciles absence", () => {
	const authority = preDeleteAuthority(0);
	let journal = appendOutcome(
		appendIntent(appendAuthority(newJournal(), 0, 1, authority, 1), 0, 1, 2),
		0,
		1,
		"transport-ambiguous",
		null,
		3,
	);
	const state = deriveConsolidationState(journal);
	assert.equal(
		nextResumeAction(state, {
			classification: "present-unchanged",
			releaseEvidence: targetEvidence(authority),
			observations: 5,
		}),
		"stop",
	);
	assert.equal(
		nextResumeAction(state, {
			classification: "present-unchanged",
			releaseEvidence: targetEvidence(authority),
			observations: 6,
		}),
		"refresh-and-retry",
	);
	journal = appendReconciliation(journal, 0, 1, "absent-ambiguous", null, 4);
	journal = appendAbsence(journal, 0, 1, "ambiguous", 5);
	assert.equal(deriveConsolidationState(journal).phase, "target-converged");
});

test("changed, published, and malformed targets always stop", () => {
	const authority = preDeleteAuthority(0);
	const journal = appendIntent(
		appendAuthority(newJournal(), 0, 1, authority, 1),
		0,
		1,
		2,
	);
	const state = deriveConsolidationState(journal);
	for (const classification of ["changed", "published", "malformed"]) {
		assert.equal(nextResumeAction(state, { classification }), "stop");
	}
});

test("a target present after confirmed 204 stops instead of retrying", () => {
	const authority = preDeleteAuthority(0);
	const journal = appendOutcome(
		appendIntent(appendAuthority(newJournal(), 0, 1, authority, 1), 0, 1, 2),
		0,
		1,
		"confirmed-204",
		204,
		3,
	);
	assert.equal(
		nextResumeAction(deriveConsolidationState(journal), {
			classification: "present-unchanged",
			releaseEvidence: targetEvidence(authority),
			observations: 6,
		}),
		"stop",
	);
});

test("caps one target at three intents", () => {
	let journal = newJournal();
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const authority = preDeleteAuthority(0);
		journal = appendAuthority(journal, 0, attempt, authority, attempt * 4 - 3);
		journal = appendIntent(journal, 0, attempt, attempt * 4 - 2);
		journal = appendOutcome(
			journal,
			0,
			attempt,
			"transport-ambiguous",
			null,
			attempt * 4 - 1,
		);
		journal = appendReconciliation(
			journal,
			0,
			attempt,
			"present-unchanged-retryable",
			targetEvidence(authority),
			attempt * 4,
		);
	}
	assert.equal(
		nextResumeAction(deriveConsolidationState(journal), {
			classification: "present-unchanged",
			releaseEvidence: targetEvidence(preDeleteAuthority(0)),
			observations: 6,
		}),
		"stop",
	);
	assert.throws(
		() => appendAuthority(journal, 0, 4, preDeleteAuthority(0), 13),
		/attempt|maximum|three|exhaust/iu,
	);
});

test("rejects main drift from the operation-started controller SHA", () => {
	const authority = structuredClone(preDeleteAuthority(0));
	const drifted = "f".repeat(40);
	authority.controller = {
		headSha: drifted,
		originMainSha: drifted,
		githubMainSha: drifted,
	};
	assert.throws(
		() => appendAuthority(newJournal(), 0, 1, authority, 1),
		/controller|main|drift|operation/iu,
	);
});

test("allows final authority only after both targets converge absent", () => {
	assert.throws(
		() =>
			appendJournalEvent(
				newJournal(),
				"final-authority-observed",
				{ authority: finalAuthority() },
				at(1),
			),
		/both|target|converge|final/iu,
	);
});

test("creates a final receipt only from a completed two-target journal", () => {
	let journal = newJournal();
	for (let index = 0; index < 2; index += 1) {
		journal = appendAuthority(
			journal,
			index,
			1,
			preDeleteAuthority(index),
			index * 4 + 1,
		);
		journal = appendIntent(journal, index, 1, index * 4 + 2);
		journal = appendOutcome(
			journal,
			index,
			1,
			"confirmed-204",
			204,
			index * 4 + 3,
		);
		journal = appendAbsence(journal, index, 1, "confirmed-204", index * 4 + 4);
	}
	const final = finalAuthority();
	journal = appendJournalEvent(
		journal,
		"final-authority-observed",
		{ authority: final },
		at(9),
	);
	const receipt = createFinalConsolidationReceipt({
		proposedEnvelope: fixture.proposedEnvelope,
		journalEnvelope: journal,
		finalAuthority: final,
		completedAt: at(10),
	});
	assert.equal(
		receipt.record.journalEnvelope.recordSha256,
		journal.recordSha256,
	);
	assert.deepEqual(receipt.record.finalSurvivor, final.releases[0]);
	for (const mutate of [
		(authority) => {
			authority.annotatedTag.objectSha = "b".repeat(40);
		},
		(authority) => {
			authority.workflowAuthority.state = "active";
		},
		(authority) => {
			authority.releases[0].semantic.name = "changed survivor";
		},
		(authority) => {
			authority.payloadProof.consolidationPayloadSha256 = "f".repeat(64);
		},
	]) {
		const changed = structuredClone(final);
		mutate(changed);
		assert.throws(() => {
			const changedJournal = replaceFinalAuthority(journal, changed);
			createFinalConsolidationReceipt({
				proposedEnvelope: fixture.proposedEnvelope,
				journalEnvelope: changedJournal,
				finalAuthority: changed,
				completedAt: at(10),
			});
		}, /tag|workflow|survivor|payload|proposal|authority|state/iu);
	}

	const incomplete = appendAuthority(
		newJournal(),
		0,
		1,
		preDeleteAuthority(0),
		1,
	);
	assert.throws(
		() =>
			createFinalConsolidationReceipt({
				proposedEnvelope: fixture.proposedEnvelope,
				journalEnvelope: incomplete,
				finalAuthority: final,
				completedAt: at(10),
			}),
		/both|complete|final|converge/iu,
	);
});

function newJournal() {
	return createConsolidationJournal({
		proposedEnvelope: fixture.proposedEnvelope,
		confirmationSha256,
		recordedAt: at(0),
	});
}

function exactConfirmation(proposedEnvelope) {
	const { candidate, roles } = proposedEnvelope.record;
	return `CONSOLIDATE ${candidate.version} ${candidate.commitSha} SURVIVOR ${roles.survivor} DELETE ${roles.duplicates.join(",")} PROPOSAL ${proposedEnvelope.recordSha256}`;
}

function replaceFinalAuthority(journal, authority) {
	const changed = structuredClone(journal);
	changed.record.events.at(-1).event.payload.authority = authority;
	changed.record.events = rebuildEventChain(changed.record.events);
	changed.record.updatedAt = changed.record.events.at(-1).event.recordedAt;
	return createConsolidationEnvelope("journal", changed.record);
}

function rebuildEventChain(events) {
	let previousEventSha256 = null;
	return events.map(({ event }, index) => {
		const envelope = canonicalEventEnvelope(
			{
				...event,
				sequence: index + 1,
				previousEventSha256,
			},
			previousEventSha256,
		);
		previousEventSha256 = envelope.eventSha256;
		return envelope;
	});
}

function appendNpm(journal, targetIndex, attemptNumber, stage, second) {
	return appendJournalEvent(
		journal,
		"npm-observed",
		{
			targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
			attemptNumber,
			inventory: npmInventory(stage, second),
		},
		at(second),
	);
}

function appendAuthority(
	journal,
	targetIndex,
	attemptNumber,
	authority,
	second,
) {
	return appendJournalEvent(
		journal,
		"delete-authority-observed",
		{
			targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
			attemptNumber,
			authority,
		},
		at(second),
	);
}

function appendIntent(journal, targetIndex, attemptNumber, second) {
	const authorityEvent = journal.record.events.at(-1);
	return appendJournalEvent(
		journal,
		"delete-intent",
		{
			targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
			attemptNumber,
			authorityEventSha256: authorityEvent.eventSha256,
		},
		at(second),
	);
}

function appendOutcome(
	journal,
	targetIndex,
	attemptNumber,
	classification,
	httpStatus,
	second,
) {
	return appendJournalEvent(
		journal,
		"delete-outcome",
		{
			targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
			attemptNumber,
			classification,
			httpStatus,
			observedAt: at(second),
		},
		at(second),
	);
}

function appendReconciliation(
	journal,
	targetIndex,
	attemptNumber,
	classification,
	releaseEvidence,
	second,
) {
	return appendJournalEvent(
		journal,
		"resume-reconciliation",
		{
			targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
			attemptNumber,
			classification,
			releaseEvidence,
			observedAt: at(second),
		},
		at(second),
	);
}

function appendAbsence(journal, targetIndex, attemptNumber, basis, second) {
	return appendJournalEvent(
		journal,
		"absence-converged",
		{
			targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
			attemptNumber,
			basis,
			directGet404At: at(second),
			listAbsentAt: at(second),
			attempts: 1,
			completedAt: at(second),
		},
		at(second),
	);
}

function preDeleteAuthority(targetIndex) {
	const stage = targetIndex === 0 ? "pre-delete-1" : "pre-delete-2";
	const releases =
		targetIndex === 0
			? fixture.proposedEnvelope.record.releases
			: [
					fixture.proposedEnvelope.record.releases[0],
					fixture.proposedEnvelope.record.releases[2],
				];
	const target = releases.find(
		({ id }) => id === DUPLICATE_DRAFT_IDS[targetIndex],
	);
	return {
		stage,
		controller: { ...fixture.proposedEnvelope.record.controller },
		annotatedTag: {
			...fixture.proposedEnvelope.record.annotatedTag,
			observedAt: at(0),
		},
		workflowAuthority: {
			...fixture.proposedEnvelope.record.workflowAuthority,
			observedAt: at(0),
		},
		npmInventory: npmInventory(stage, 0),
		releases: structuredClone(releases),
		payloadProof: structuredClone(fixture.proposedEnvelope.record.payloadProof),
		targetRead: {
			releaseGetStartedAt: at(0),
			releaseGetCompletedAt: at(0),
			assetsListStartedAt: at(0),
			assetsListCompletedAt: at(0),
			evidence: structuredClone(target),
			evidenceSha256: canonicalRecordSha256(target),
		},
		observedAt: at(0),
	};
}

function finalAuthority() {
	return {
		stage: "final",
		controller: { ...fixture.proposedEnvelope.record.controller },
		annotatedTag: {
			...fixture.proposedEnvelope.record.annotatedTag,
			observedAt: at(0),
		},
		workflowAuthority: {
			...fixture.proposedEnvelope.record.workflowAuthority,
			observedAt: at(0),
		},
		npmInventory: npmInventory("final", 0),
		releases: [structuredClone(fixture.proposedEnvelope.record.releases[0])],
		payloadProof: structuredClone(fixture.proposedEnvelope.record.payloadProof),
		targetRead: null,
		observedAt: at(0),
	};
}

function targetEvidence(authority) {
	return structuredClone(authority.targetRead.evidence);
}

async function journalFixture() {
	const source = createDuplicateDraftConsolidationFixture();
	const inspected = await inspectEquivalentDrafts({
		candidate: source.candidate,
		survivorId: source.survivorId,
		duplicateIds: source.duplicateIds,
		releases: source.releases,
		github: source.github,
		attestations: source.attestations,
	});
	const repository = {
		name: "cacheplane/dawnai",
		id: REPOSITORY_ID,
		defaultBranch: "main",
		actor: { ...ACTOR },
	};
	const controller = {
		headSha: CONTROLLER_SHA,
		originMainSha: CONTROLLER_SHA,
		githubMainSha: CONTROLLER_SHA,
	};
	const annotatedTag = {
		name: DUPLICATE_DRAFT_CANDIDATE.tag,
		objectSha: TAG_OBJECT_SHA,
		targetSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
		objectType: "tag",
		observedAt: at(0),
	};
	const workflowAuthority = {
		workflowId: WORKFLOW_ID,
		path: ".github/workflows/release.yml",
		state: "disabled_manually",
		query: {
			statuses: ["in_progress", "pending", "queued", "requested", "waiting"],
			perPage: 100,
			maximumPages: 100,
		},
		nonterminalRuns: [],
		observedAt: at(0),
	};
	const proposedEnvelope = createConsolidationEnvelope("proposed", {
		schemaVersion: 1,
		repository,
		controller,
		candidate: DUPLICATE_DRAFT_CANDIDATE,
		roles: {
			survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
			duplicates: [...DUPLICATE_DRAFT_IDS],
		},
		confirmation: {
			version: DUPLICATE_DRAFT_CANDIDATE.version,
			commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
			survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
			duplicates: [...DUPLICATE_DRAFT_IDS],
			template: "CONSOLIDATE <64-lowercase-hex-digest>",
		},
		annotatedTag,
		workflowAuthority,
		npmInventories: [
			npmInventory("inspect-initial", 0),
			npmInventory("inspect-ready", 0),
		],
		releases: inspected.releases,
		payloadProof: inspected.payloadProof,
		inspectedAt: at(0),
	});
	return { proposedEnvelope };
}

function npmInventory(stage, second) {
	return {
		stage,
		startedAt: at(second),
		completedAt: at(second),
		packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({
			name,
			version: DUPLICATE_DRAFT_CANDIDATE.version,
			status: "ABSENT",
			httpStatus: 404,
			code: "E404",
			observedAt: at(second),
		})),
	};
}

function at(second) {
	return new Date(BASE_TIME + second * 1000).toISOString();
}
