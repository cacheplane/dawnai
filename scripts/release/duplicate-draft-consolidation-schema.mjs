import { createHash } from "node:crypto";

import { RELEASE_PAYLOAD_LIMITS } from "./limits.mjs";
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs";

const MEBIBYTE = 1024 * 1024;

export const DUPLICATE_DRAFT_CONSOLIDATION_LIMITS = Object.freeze({
	proposedBytes: 4 * MEBIBYTE,
	journalBytes: 64 * MEBIBYTE,
	finalReceiptBytes: 96 * MEBIBYTE,
	authorityStageBytes: 8 * MEBIBYTE,
	survivorEvidenceBytes: 2 * MEBIBYTE,
	journalEventReserveBytes: 8 * MEBIBYTE,
	envelopeReserveBytes: MEBIBYTE,
	maximumDeleteAttempts: 3,
	maximumTargets: 2,
	maximumAssetDownloads: 135,
});

if (
	DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes <
		(DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumTargets *
			DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumDeleteAttempts +
			1) *
			DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes +
			DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalEventReserveBytes ||
	DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes <
		DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes +
			DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes +
			DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes +
			DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.survivorEvidenceBytes +
			DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.envelopeReserveBytes ||
	RELEASE_PAYLOAD_LIMITS.escrowBytes <= 0
) {
	throw new Error(
		"Duplicate-draft consolidation limits do not preserve required headroom",
	);
}

const ENVELOPE_FIELDS = Object.freeze(["record", "recordSha256"]);
const EVENT_ENVELOPE_FIELDS = Object.freeze(["event", "eventSha256"]);
const EVENT_FIELDS = Object.freeze([
	"schemaVersion",
	"sequence",
	"previousEventSha256",
	"type",
	"recordedAt",
	"payload",
]);
const WORKFLOW_STATUSES = Object.freeze([
	"in_progress",
	"pending",
	"queued",
	"requested",
	"waiting",
]);
const APPROVED_SURVIVOR_ID = "379991871";
const APPROVED_DUPLICATE_IDS = Object.freeze(["379982100", "379986168"]);
const INSPECT_STAGES = Object.freeze(["inspect-initial", "inspect-ready"]);
const PERFORM_STAGES = new Set([
	"perform-initial",
	"pre-delete-1",
	"pre-delete-2",
	"final",
]);
const RECORD_FIELDS = Object.freeze({
	proposed: Object.freeze([
		"schemaVersion",
		"repository",
		"controller",
		"candidate",
		"roles",
		"confirmation",
		"annotatedTag",
		"workflowAuthority",
		"npmInventories",
		"releases",
		"payloadProof",
		"inspectedAt",
	]),
	journal: Object.freeze([
		"schemaVersion",
		"repository",
		"candidate",
		"proposedRecordSha256",
		"confirmationSha256",
		"deletionOrder",
		"events",
		"updatedAt",
	]),
	final: Object.freeze([
		"schemaVersion",
		"proposedEnvelope",
		"journalEnvelope",
		"finalAuthority",
		"finalSurvivor",
		"completedAt",
	]),
});
const KIND_LIMITS = Object.freeze({
	proposed: DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes,
	journal: DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
	final: DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes,
});
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const TIMESTAMP_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function createConsolidationEnvelope(kind, record) {
	const normalized = normalizeRecord(kind, record);
	const envelope = {
		record: normalized,
		recordSha256: canonicalRecordSha256(normalized),
	};
	assertWithinKindLimit(
		kind,
		Buffer.byteLength(`${JSON.stringify(envelope)}\n`, "utf8"),
	);
	return envelope;
}

export function canonicalConsolidationEnvelopeBytes(kind, envelope) {
	const normalized = normalizeEnvelope(kind, envelope);
	const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
	assertWithinKindLimit(kind, bytes.byteLength);
	return bytes;
}

export function parseConsolidationEnvelope(kind, bytes) {
	const maximum = kindLimit(kind);
	if (!(bytes instanceof Uint8Array))
		throw new TypeError("Envelope bytes must be a byte array");
	if (bytes.byteLength > maximum)
		throw new Error(`${kind} envelope exceeds its byte limit`);

	let source;
	try {
		source = UTF8_DECODER.decode(bytes);
	} catch {
		throw new TypeError("Envelope is not valid UTF-8");
	}
	let value;
	try {
		value = JSON.parse(source);
	} catch {
		throw new TypeError("Envelope is not valid JSON");
	}
	const normalized = normalizeEnvelope(kind, value);
	const canonical = `${JSON.stringify(normalized)}\n`;
	if (source !== canonical) {
		throw new TypeError("Envelope bytes are not canonical");
	}
	return normalized;
}

export function canonicalRecordSha256(record) {
	const source = JSON.stringify(record);
	if (source === undefined)
		throw new TypeError("Record is not JSON serializable");
	return createHash("sha256").update(`${source}\n`, "utf8").digest("hex");
}

export function canonicalEventEnvelope(event, previousEventSha256) {
	const expectedSequence = assertPositiveInteger(
		event?.sequence,
		"Journal event sequence",
	);
	const normalizedEvent = normalizeEvent(
		event,
		expectedSequence,
		previousEventSha256,
	);
	return {
		event: normalizedEvent,
		eventSha256: canonicalRecordSha256(normalizedEvent),
	};
}

export function parseJournalEventEnvelope(
	value,
	expectedSequence,
	previousEventSha256,
) {
	assertExactFields(value, EVENT_ENVELOPE_FIELDS, "Journal event envelope");
	const event = normalizeEvent(
		value.event,
		expectedSequence,
		previousEventSha256,
	);
	const eventSha256 = assertSha256(value.eventSha256, "Journal event digest");
	if (eventSha256 !== canonicalRecordSha256(event)) {
		throw new TypeError(
			"Journal event digest does not match its canonical event",
		);
	}
	return { event, eventSha256 };
}

function normalizeEnvelope(kind, value) {
	assertExactFields(value, ENVELOPE_FIELDS, `${kind} envelope`);
	const record = normalizeRecord(kind, value.record);
	const recordSha256 = assertSha256(
		value.recordSha256,
		`${kind} record digest`,
	);
	if (recordSha256 !== canonicalRecordSha256(record)) {
		throw new TypeError(
			`${kind} envelope digest does not match its canonical record`,
		);
	}
	return { record, recordSha256 };
}

function normalizeRecord(kind, value) {
	kindLimit(kind);
	if (kind === "proposed") return normalizeProposedRecord(value);
	if (kind === "journal") return normalizeJournalRecord(value);
	return normalizeFinalRecord(value);
}

function normalizeProposedRecord(value) {
	assertExactFields(value, RECORD_FIELDS.proposed, "Proposed record");
	assertSchemaVersion(value.schemaVersion, "Proposed record");
	const repository = normalizeRepository(value.repository);
	const controller = normalizeController(value.controller);
	const candidate = normalizeCandidate(value.candidate);
	const roles = normalizeRoles(value.roles);
	const confirmation = normalizeConfirmation(value.confirmation);
	const annotatedTag = normalizeAnnotatedTag(value.annotatedTag);
	const workflowAuthority = normalizeWorkflowAuthority(value.workflowAuthority);
	const npmInventories = assertArray(
		value.npmInventories,
		"Proposed npm inventories",
	).map(normalizeNpmInventory);
	const releases = assertArray(value.releases, "Proposed releases").map(
		normalizeReleaseEvidence,
	);
	const payloadProof = normalizePayloadProof(value.payloadProof);
	const inspectedAt = assertTimestamp(
		value.inspectedAt,
		"Proposed inspection timestamp",
	);

	assertArrayEqual(
		npmInventories.map(({ stage }) => stage),
		INSPECT_STAGES,
		"Proposed npm inventory stages",
	);
	for (const inventory of npmInventories) {
		if (
			inventory.packages.some(({ version }) => version !== candidate.version)
		) {
			throw new TypeError(
				"Proposed npm observations must identify the candidate version",
			);
		}
	}
	assertIdentityContract(candidate, roles, confirmation);
	if (
		annotatedTag.name !== candidate.tag ||
		annotatedTag.targetSha !== candidate.commitSha
	) {
		throw new TypeError(
			"Annotated tag does not identify the proposed candidate",
		);
	}
	const expectedReleaseIds = [roles.survivor, ...roles.duplicates];
	assertArrayEqual(
		releases.map(({ id }) => id),
		expectedReleaseIds,
		"Proposed release order",
	);
	assertArrayEqual(
		releases.map(({ role }) => role),
		["survivor", ...roles.duplicates.map(() => "duplicate")],
		"Proposed release roles",
	);
	if (
		releases.reduce((total, release) => total + release.assets.length, 0) >
		DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumAssetDownloads
	) {
		throw new TypeError(
			"Proposed release evidence exceeds the asset download limit",
		);
	}
	assertPayloadMatchesReleases(payloadProof, releases);

	return {
		schemaVersion: 1,
		repository,
		controller,
		candidate,
		roles,
		confirmation,
		annotatedTag,
		workflowAuthority,
		npmInventories,
		releases,
		payloadProof,
		inspectedAt,
	};
}

function normalizeJournalRecord(value) {
	assertExactFields(value, RECORD_FIELDS.journal, "Journal record");
	assertSchemaVersion(value.schemaVersion, "Journal record");
	const repository = normalizeRepository(value.repository);
	const candidate = normalizeCandidate(value.candidate);
	const proposedRecordSha256 = assertSha256(
		value.proposedRecordSha256,
		"Journal proposed record digest",
	);
	const confirmationSha256 = assertSha256(
		value.confirmationSha256,
		"Journal confirmation digest",
	);
	const deletionOrder = normalizeIdentityArray(
		value.deletionOrder,
		"Journal deletion order",
	);
	if (
		deletionOrder.length !== DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumTargets
	) {
		throw new TypeError(
			"Journal deletion order must contain exactly two targets",
		);
	}
	assertArrayEqual(
		deletionOrder,
		APPROVED_DUPLICATE_IDS,
		"Approved journal deletion order",
	);
	const rawEvents = assertArray(value.events, "Journal events");
	const events = [];
	let previousEventSha256 = null;
	for (let index = 0; index < rawEvents.length; index += 1) {
		const envelope = parseJournalEventEnvelope(
			rawEvents[index],
			index + 1,
			previousEventSha256,
		);
		validateJournalEventTarget(envelope.event, deletionOrder);
		events.push(envelope);
		previousEventSha256 = envelope.eventSha256;
	}
	const intentCounts = new Map();
	for (const { event } of events) {
		if (event.type !== "delete-intent") continue;
		const count = (intentCounts.get(event.payload.targetReleaseId) ?? 0) + 1;
		if (count > DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumDeleteAttempts) {
			throw new TypeError(
				"Journal target exceeds the maximum number of delete intents",
			);
		}
		intentCounts.set(event.payload.targetReleaseId, count);
	}
	if (events.length > 0) {
		const first = events[0].event;
		if (
			first.type !== "operation-started" ||
			first.payload.proposedRecordSha256 !== proposedRecordSha256 ||
			first.payload.confirmationSha256 !== confirmationSha256
		) {
			throw new TypeError(
				"Journal must begin with its bound operation-started event",
			);
		}
		assertArrayEqual(
			first.payload.deletionOrder,
			deletionOrder,
			"Journal operation deletion order",
		);
	}
	const updatedAt = assertTimestamp(
		value.updatedAt,
		"Journal update timestamp",
	);
	return {
		schemaVersion: 1,
		repository,
		candidate,
		proposedRecordSha256,
		confirmationSha256,
		deletionOrder,
		events,
		updatedAt,
	};
}

function normalizeFinalRecord(value) {
	assertExactFields(value, RECORD_FIELDS.final, "Final receipt record");
	assertSchemaVersion(value.schemaVersion, "Final receipt record");
	const proposedEnvelope = normalizeEnvelope(
		"proposed",
		value.proposedEnvelope,
	);
	const journalEnvelope = normalizeEnvelope("journal", value.journalEnvelope);
	if (
		journalEnvelope.record.proposedRecordSha256 !==
		proposedEnvelope.recordSha256
	) {
		throw new TypeError(
			"Final receipt journal does not bind the embedded proposal",
		);
	}
	const finalAuthority = normalizeAuthorityStage(value.finalAuthority);
	if (finalAuthority.stage !== "final" || finalAuthority.targetRead !== null) {
		throw new TypeError(
			"Final receipt authority must be the final no-target-read stage",
		);
	}
	const finalSurvivor = normalizeReleaseEvidence(value.finalSurvivor);
	if (
		finalAuthority.releases.length !== 1 ||
		finalAuthority.releases[0].role !== "survivor" ||
		JSON.stringify(finalAuthority.releases[0]) !== JSON.stringify(finalSurvivor)
	) {
		throw new TypeError(
			"Final survivor must exactly match the final authority survivor",
		);
	}
	const completedAt = assertTimestamp(
		value.completedAt,
		"Final receipt completion timestamp",
	);
	return {
		schemaVersion: 1,
		proposedEnvelope,
		journalEnvelope,
		finalAuthority,
		finalSurvivor,
		completedAt,
	};
}

function normalizeRepository(value) {
	assertExactFields(
		value,
		["name", "id", "defaultBranch", "actor"],
		"Repository",
	);
	return {
		name: assertNonemptyString(value.name, "Repository name"),
		id: assertId(value.id, "Repository id"),
		defaultBranch: assertNonemptyString(
			value.defaultBranch,
			"Repository default branch",
		),
		actor: normalizeActor(value.actor, "Repository actor"),
	};
}

function normalizeActor(value, label) {
	assertExactFields(value, ["login", "id"], label);
	return {
		login: assertNonemptyString(value.login, `${label} login`),
		id: assertId(value.id, `${label} id`),
	};
}

function normalizeController(value) {
	assertExactFields(
		value,
		["headSha", "originMainSha", "githubMainSha"],
		"Controller",
	);
	const headSha = assertGitSha(value.headSha, "Controller head SHA");
	const originMainSha = assertGitSha(
		value.originMainSha,
		"Controller origin/main SHA",
	);
	const githubMainSha = assertGitSha(
		value.githubMainSha,
		"Controller GitHub main SHA",
	);
	if (headSha !== originMainSha || headSha !== githubMainSha) {
		throw new TypeError("Controller SHAs must be identical");
	}
	return { headSha, originMainSha, githubMainSha };
}

function normalizeCandidate(value) {
	assertExactFields(value, ["version", "commitSha", "tag"], "Candidate");
	const version = assertMatchingString(
		value.version,
		VERSION_PATTERN,
		"Candidate version",
	);
	const commitSha = assertGitSha(value.commitSha, "Candidate commit SHA");
	const tag = assertNonemptyString(value.tag, "Candidate tag");
	if (tag !== `v${version}`)
		throw new TypeError("Candidate tag must match its version");
	return { version, commitSha, tag };
}

function normalizeRoles(value) {
	assertExactFields(value, ["survivor", "duplicates"], "Release roles");
	const survivor = assertId(value.survivor, "Survivor Release id");
	const duplicates = normalizeIdentityArray(
		value.duplicates,
		"Duplicate Release ids",
	);
	if (
		duplicates.length !== DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumTargets ||
		duplicates.includes(survivor) ||
		survivor !== APPROVED_SURVIVOR_ID
	) {
		throw new TypeError(
			"Release roles must identify one survivor and two ordered duplicates",
		);
	}
	assertArrayEqual(
		duplicates,
		APPROVED_DUPLICATE_IDS,
		"Approved duplicate Release order",
	);
	return { survivor, duplicates };
}

function normalizeConfirmation(value) {
	assertExactFields(
		value,
		["version", "commitSha", "survivor", "duplicates", "template"],
		"Confirmation",
	);
	const template = assertNonemptyString(
		value.template,
		"Confirmation template",
	);
	if ((template.match(/<64-lowercase-hex-digest>/gu) ?? []).length !== 1) {
		throw new TypeError(
			"Confirmation template must retain the digest placeholder",
		);
	}
	return {
		version: assertMatchingString(
			value.version,
			VERSION_PATTERN,
			"Confirmation version",
		),
		commitSha: assertGitSha(value.commitSha, "Confirmation commit SHA"),
		survivor: assertId(value.survivor, "Confirmation survivor id"),
		duplicates: normalizeIdentityArray(
			value.duplicates,
			"Confirmation duplicate ids",
		),
		template,
	};
}

function normalizeAnnotatedTag(value) {
	assertExactFields(
		value,
		["name", "objectSha", "targetSha", "objectType", "observedAt"],
		"Annotated tag",
	);
	const objectType = assertNonemptyString(
		value.objectType,
		"Annotated tag object type",
	);
	if (objectType !== "tag")
		throw new TypeError("Candidate tag must be an annotated tag object");
	return {
		name: assertNonemptyString(value.name, "Annotated tag name"),
		objectSha: assertGitSha(value.objectSha, "Annotated tag object SHA"),
		targetSha: assertGitSha(value.targetSha, "Annotated tag target SHA"),
		objectType,
		observedAt: assertTimestamp(
			value.observedAt,
			"Annotated tag observation timestamp",
		),
	};
}

function normalizeWorkflowAuthority(value) {
	assertExactFields(
		value,
		["workflowId", "path", "state", "query", "nonterminalRuns", "observedAt"],
		"Workflow authority",
	);
	assertExactFields(
		value.query,
		["statuses", "perPage", "maximumPages"],
		"Workflow query",
	);
	const statuses = assertArray(
		value.query.statuses,
		"Workflow query statuses",
	).map((status) => assertNonemptyString(status, "Workflow query status"));
	assertArrayEqual(statuses, WORKFLOW_STATUSES, "Workflow query statuses");
	if (value.query.perPage !== 100 || value.query.maximumPages !== 100) {
		throw new TypeError(
			"Workflow query bounds must be the reviewed 100-by-100 values",
		);
	}
	const nonterminalRuns = assertArray(
		value.nonterminalRuns,
		"Nonterminal workflow runs",
	).map(normalizeWorkflowRun);
	if (nonterminalRuns.length !== 0)
		throw new TypeError("Nonterminal workflow runs must be empty");
	if (
		value.path !== ".github/workflows/release.yml" ||
		value.state !== "disabled_manually"
	) {
		throw new TypeError(
			"Release workflow must remain disabled at its canonical path",
		);
	}
	return {
		workflowId: assertId(value.workflowId, "Workflow id"),
		path: value.path,
		state: value.state,
		query: { statuses, perPage: 100, maximumPages: 100 },
		nonterminalRuns,
		observedAt: assertTimestamp(
			value.observedAt,
			"Workflow authority observation timestamp",
		),
	};
}

function normalizeWorkflowRun(value) {
	assertExactFields(
		value,
		["id", "runAttempt", "status", "event", "headSha", "headBranch"],
		"Workflow run",
	);
	return {
		id: assertId(value.id, "Workflow run id"),
		runAttempt: assertPositiveInteger(value.runAttempt, "Workflow run attempt"),
		status: assertNonemptyString(value.status, "Workflow run status"),
		event: assertNonemptyString(value.event, "Workflow run event"),
		headSha: assertGitSha(value.headSha, "Workflow run head SHA"),
		headBranch: assertNonemptyString(
			value.headBranch,
			"Workflow run head branch",
		),
	};
}

function normalizeNpmInventory(value) {
	assertExactFields(
		value,
		["stage", "startedAt", "completedAt", "packages"],
		"npm inventory",
	);
	const packages = assertArray(value.packages, "npm package observations").map(
		normalizeNpmObservation,
	);
	assertArrayEqual(
		packages.map(({ name }) => name),
		CANONICAL_RELEASE_PACKAGE_ORDER,
		"npm package order",
	);
	return {
		stage: assertNonemptyString(value.stage, "npm inventory stage"),
		startedAt: assertTimestamp(
			value.startedAt,
			"npm inventory start timestamp",
		),
		completedAt: assertTimestamp(
			value.completedAt,
			"npm inventory completion timestamp",
		),
		packages,
	};
}

function normalizeNpmObservation(value) {
	assertExactFields(
		value,
		["name", "version", "status", "httpStatus", "code", "observedAt"],
		"npm package observation",
	);
	if (
		value.status !== "ABSENT" ||
		value.httpStatus !== 404 ||
		value.code !== "E404"
	) {
		throw new TypeError(
			"npm package observation must be exact ABSENT/404/E404 evidence",
		);
	}
	return {
		name: assertNonemptyString(value.name, "npm package name"),
		version: assertMatchingString(
			value.version,
			VERSION_PATTERN,
			"npm package version",
		),
		status: value.status,
		httpStatus: value.httpStatus,
		code: value.code,
		observedAt: assertTimestamp(value.observedAt, "npm observation timestamp"),
	};
}

function normalizeReleaseEvidence(value) {
	assertExactFields(
		value,
		[
			"role",
			"id",
			"nodeId",
			"tagName",
			"createdAt",
			"updatedAt",
			"semantic",
			"assets",
		],
		"Release evidence",
	);
	if (!new Set(["survivor", "duplicate"]).has(value.role)) {
		throw new TypeError("Release evidence has an invalid role");
	}
	const assets = assertArray(value.assets, "Release assets").map(
		normalizeAssetEvidence,
	);
	if (assets.length !== 45 || new Set(assets.map(({ id }) => id)).size !== 45) {
		throw new TypeError(
			"Release evidence must contain exactly 45 uniquely identified assets",
		);
	}
	assertUniqueNames(
		assets.map(({ name }) => name),
		"Release asset names",
	);
	const aggregateSize = assets.reduce((total, { size }) => total + size, 0);
	if (
		!Number.isSafeInteger(aggregateSize) ||
		aggregateSize > RELEASE_PAYLOAD_LIMITS.escrowBytes
	) {
		throw new TypeError(
			"Release asset evidence exceeds the escrow payload limit",
		);
	}
	return {
		role: value.role,
		id: assertId(value.id, "Release id"),
		nodeId: assertNonemptyString(value.nodeId, "Release node id"),
		tagName: assertNonemptyString(value.tagName, "Release tag name"),
		createdAt: assertTimestamp(value.createdAt, "Release creation timestamp"),
		updatedAt: assertTimestamp(value.updatedAt, "Release update timestamp"),
		semantic: normalizeReleaseSemantic(value.semantic),
		assets,
	};
}

function normalizeReleaseSemantic(value) {
	assertExactFields(
		value,
		[
			"name",
			"targetCommitish",
			"draft",
			"immutable",
			"prerelease",
			"publishedAt",
			"body",
			"bodySha256",
			"author",
		],
		"Release semantic evidence",
	);
	if (
		value.draft !== true ||
		value.immutable !== false ||
		value.prerelease !== false ||
		value.publishedAt !== null
	) {
		throw new TypeError(
			"Managed duplicate Release must remain a mutable non-prerelease draft",
		);
	}
	const body = assertString(value.body, "Release body");
	const bodySha256 = assertSha256(value.bodySha256, "Release body digest");
	return {
		name: assertNonemptyString(value.name, "Release name"),
		targetCommitish: assertGitSha(
			value.targetCommitish,
			"Release target commitish",
		),
		draft: value.draft,
		immutable: value.immutable,
		prerelease: value.prerelease,
		publishedAt: null,
		body,
		bodySha256,
		author: normalizeServiceIdentity(value.author, "Release author"),
	};
}

function normalizeServiceIdentity(value, label) {
	assertExactFields(value, ["login", "id", "nodeId"], label);
	return {
		login: assertNonemptyString(value.login, `${label} login`),
		id: assertId(value.id, `${label} id`),
		nodeId: assertNonemptyString(value.nodeId, `${label} node id`),
	};
}

function normalizeAssetEvidence(value) {
	assertExactFields(
		value,
		[
			"id",
			"nodeId",
			"name",
			"label",
			"state",
			"contentType",
			"size",
			"digest",
			"uploader",
			"createdAt",
			"updatedAt",
			"downloadCount",
			"downloadSha256",
		],
		"Asset evidence",
	);
	const digest = assertNonemptyString(value.digest, "Asset service digest");
	if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
		throw new TypeError(
			"Asset service digest must be canonical sha256 evidence",
		);
	}
	return {
		id: assertId(value.id, "Asset id"),
		nodeId: assertNonemptyString(value.nodeId, "Asset node id"),
		name: assertNonemptyString(value.name, "Asset name"),
		label:
			value.label === null ? null : assertString(value.label, "Asset label"),
		state: assertNonemptyString(value.state, "Asset state"),
		contentType: assertNonemptyString(value.contentType, "Asset content type"),
		size: assertNonnegativeInteger(value.size, "Asset size"),
		digest,
		uploader: normalizeServiceIdentity(value.uploader, "Asset uploader"),
		createdAt: assertTimestamp(value.createdAt, "Asset creation timestamp"),
		updatedAt: assertTimestamp(value.updatedAt, "Asset update timestamp"),
		downloadCount: assertNonnegativeInteger(
			value.downloadCount,
			"Asset download count",
		),
		downloadSha256: assertSha256(
			value.downloadSha256,
			"Downloaded asset digest",
		),
	};
}

function normalizePayloadProof(value) {
	assertExactFields(
		value,
		[
			"baseAssetSet",
			"baseAssetSetSha256",
			"consolidationPayloadSha256",
			"attestationVerification",
		],
		"Payload proof",
	);
	const baseAssetSet = assertArray(value.baseAssetSet, "Base asset set").map(
		normalizeNamedDigest,
	);
	if (baseAssetSet.length !== 45)
		throw new TypeError("Base asset set must contain exactly 45 assets");
	assertUniqueNames(
		baseAssetSet.map(({ name }) => name),
		"Base asset set names",
	);
	assertExactFields(
		value.attestationVerification,
		["status", "subjects"],
		"Attestation verification",
	);
	if (value.attestationVerification.status !== "VERIFIED") {
		throw new TypeError("Attestation verification must be VERIFIED");
	}
	const subjects = assertArray(
		value.attestationVerification.subjects,
		"Attestation subjects",
	).map(normalizeNamedDigest);
	if (subjects.length !== 22)
		throw new TypeError("Attestation verification requires 22 subjects");
	assertUniqueNames(
		subjects.map(({ name }) => name),
		"Attestation subject names",
	);
	return {
		baseAssetSet,
		baseAssetSetSha256: assertSha256(
			value.baseAssetSetSha256,
			"Base asset set digest",
		),
		consolidationPayloadSha256: assertSha256(
			value.consolidationPayloadSha256,
			"Consolidation payload digest",
		),
		attestationVerification: { status: "VERIFIED", subjects },
	};
}

function normalizeNamedDigest(value) {
	assertExactFields(value, ["name", "sha256"], "Named digest");
	return {
		name: assertNonemptyString(value.name, "Named digest name"),
		sha256: assertSha256(value.sha256, "Named digest SHA-256"),
	};
}

function normalizeAuthorityStage(value) {
	assertExactFields(
		value,
		[
			"stage",
			"controller",
			"annotatedTag",
			"workflowAuthority",
			"npmInventory",
			"releases",
			"payloadProof",
			"targetRead",
			"observedAt",
		],
		"Authority stage",
	);
	const stage = assertNonemptyString(value.stage, "Authority stage name");
	if (!PERFORM_STAGES.has(stage))
		throw new TypeError("Authority stage name is invalid");
	const npmInventory = normalizeNpmInventory(value.npmInventory);
	if (npmInventory.stage !== stage)
		throw new TypeError("Authority stage and npm inventory stage differ");
	const releases = assertArray(value.releases, "Authority releases").map(
		normalizeReleaseEvidence,
	);
	if (releases.length === 0 || releases[0].role !== "survivor") {
		throw new TypeError("Authority releases must begin with the survivor");
	}
	const payloadProof = normalizePayloadProof(value.payloadProof);
	assertPayloadMatchesReleases(payloadProof, releases);
	const targetRead =
		value.targetRead === null ? null : normalizeTargetRead(value.targetRead);
	if ((stage === "final") !== (targetRead === null)) {
		throw new TypeError("targetRead is null only for final authority");
	}
	if (stage === "final" && releases.length !== 1) {
		throw new TypeError("Final authority must contain only the survivor");
	}
	if (
		targetRead !== null &&
		!releases.some(
			(release) =>
				release.id === targetRead.evidence.id &&
				JSON.stringify(release) === JSON.stringify(targetRead.evidence),
		)
	) {
		throw new TypeError(
			"Target read evidence must exactly match an authority Release",
		);
	}
	return {
		stage,
		controller: normalizeController(value.controller),
		annotatedTag: normalizeAnnotatedTag(value.annotatedTag),
		workflowAuthority: normalizeWorkflowAuthority(value.workflowAuthority),
		npmInventory,
		releases,
		payloadProof,
		targetRead,
		observedAt: assertTimestamp(
			value.observedAt,
			"Authority observation timestamp",
		),
	};
}

function normalizeTargetRead(value) {
	assertExactFields(
		value,
		[
			"releaseGetStartedAt",
			"releaseGetCompletedAt",
			"assetsListStartedAt",
			"assetsListCompletedAt",
			"evidence",
			"evidenceSha256",
		],
		"Target read",
	);
	const evidence = normalizeReleaseEvidence(value.evidence);
	const evidenceSha256 = assertSha256(
		value.evidenceSha256,
		"Target read evidence digest",
	);
	if (evidenceSha256 !== canonicalRecordSha256(evidence)) {
		throw new TypeError("Target read evidence digest does not match");
	}
	const timestamps = [
		assertTimestamp(value.releaseGetStartedAt, "Release GET start timestamp"),
		assertTimestamp(
			value.releaseGetCompletedAt,
			"Release GET completion timestamp",
		),
		assertTimestamp(value.assetsListStartedAt, "Asset list start timestamp"),
		assertTimestamp(
			value.assetsListCompletedAt,
			"Asset list completion timestamp",
		),
	];
	for (let index = 1; index < timestamps.length; index += 1) {
		if (timestamps[index] < timestamps[index - 1]) {
			throw new TypeError("Target read timestamps must be monotone");
		}
	}
	return {
		releaseGetStartedAt: timestamps[0],
		releaseGetCompletedAt: timestamps[1],
		assetsListStartedAt: timestamps[2],
		assetsListCompletedAt: timestamps[3],
		evidence,
		evidenceSha256,
	};
}

function normalizeEvent(value, expectedSequence, previousEventSha256) {
	assertExactFields(value, EVENT_FIELDS, "Journal event");
	assertSchemaVersion(value.schemaVersion, "Journal event");
	const sequence = assertPositiveInteger(
		expectedSequence,
		"Expected journal event sequence",
	);
	if (value.sequence !== sequence)
		throw new TypeError("Journal event sequence is not contiguous");
	const expectedPrevious =
		previousEventSha256 === null
			? null
			: assertSha256(previousEventSha256, "Previous journal event digest");
	if (value.previousEventSha256 !== expectedPrevious) {
		throw new TypeError(
			"Journal event does not bind the immediately previous digest",
		);
	}
	if (sequence === 1 && expectedPrevious !== null) {
		throw new TypeError("First journal event must have no previous digest");
	}
	if (sequence > 1 && expectedPrevious === null) {
		throw new TypeError("Later journal events must bind a previous digest");
	}
	const type = assertNonemptyString(value.type, "Journal event type");
	return {
		schemaVersion: 1,
		sequence,
		previousEventSha256: expectedPrevious,
		type,
		recordedAt: assertTimestamp(value.recordedAt, "Journal event timestamp"),
		payload: normalizeEventPayload(type, value.payload),
	};
}

function normalizeEventPayload(type, value) {
	if (type === "operation-started") {
		assertExactFields(
			value,
			[
				"proposedRecordSha256",
				"confirmationSha256",
				"controllerSha",
				"deletionOrder",
			],
			"operation-started payload",
		);
		const deletionOrder = normalizeIdentityArray(
			value.deletionOrder,
			"Operation deletion order",
		);
		if (
			deletionOrder.length !==
			DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumTargets
		) {
			throw new TypeError("Operation deletion order must contain two targets");
		}
		assertArrayEqual(
			deletionOrder,
			APPROVED_DUPLICATE_IDS,
			"Approved operation deletion order",
		);
		return {
			proposedRecordSha256: assertSha256(
				value.proposedRecordSha256,
				"Proposed record digest",
			),
			confirmationSha256: assertSha256(
				value.confirmationSha256,
				"Confirmation digest",
			),
			controllerSha: assertGitSha(
				value.controllerSha,
				"Operation controller SHA",
			),
			deletionOrder,
		};
	}
	if (type === "npm-observed") {
		assertExactFields(
			value,
			["targetReleaseId", "attemptNumber", "inventory"],
			"npm-observed payload",
		);
		const inventory = normalizeNpmInventory(value.inventory);
		if (!PERFORM_STAGES.has(inventory.stage)) {
			throw new TypeError(
				"npm-observed event has an invalid perform-stage inventory",
			);
		}
		return {
			targetReleaseId: assertId(
				value.targetReleaseId,
				"npm-observed target Release id",
			),
			attemptNumber: assertDeleteAttempt(value.attemptNumber),
			inventory,
		};
	}
	if (type === "delete-authority-observed") {
		assertExactFields(
			value,
			["targetReleaseId", "attemptNumber", "authority"],
			"delete-authority-observed payload",
		);
		const targetReleaseId = assertId(
			value.targetReleaseId,
			"Authority target Release id",
		);
		const authority = normalizeAuthorityStage(value.authority);
		if (authority.targetRead?.evidence.id !== targetReleaseId) {
			throw new TypeError(
				"Delete authority target read must identify the deletion target",
			);
		}
		return {
			targetReleaseId,
			attemptNumber: assertDeleteAttempt(value.attemptNumber),
			authority,
		};
	}
	if (type === "delete-intent") {
		assertExactFields(
			value,
			["targetReleaseId", "attemptNumber", "authorityEventSha256"],
			"delete-intent payload",
		);
		return {
			targetReleaseId: assertId(
				value.targetReleaseId,
				"Delete intent target Release id",
			),
			attemptNumber: assertDeleteAttempt(value.attemptNumber),
			authorityEventSha256: assertSha256(
				value.authorityEventSha256,
				"Delete authority event digest",
			),
		};
	}
	if (type === "delete-outcome") return normalizeDeleteOutcome(value);
	if (type === "resume-reconciliation")
		return normalizeResumeReconciliation(value);
	if (type === "absence-converged") return normalizeAbsenceConverged(value);
	if (type === "final-authority-observed") {
		assertExactFields(value, ["authority"], "final-authority-observed payload");
		const authority = normalizeAuthorityStage(value.authority);
		if (authority.stage !== "final")
			throw new TypeError("Final authority event must contain final authority");
		return { authority };
	}
	throw new TypeError("Unknown journal event type");
}

function normalizeDeleteOutcome(value) {
	assertExactFields(
		value,
		[
			"targetReleaseId",
			"attemptNumber",
			"classification",
			"httpStatus",
			"observedAt",
		],
		"delete-outcome payload",
	);
	const triplets = new Map([
		["confirmed-204", 204],
		["transport-ambiguous", null],
		["response-404-ambiguous", 404],
	]);
	if (
		!triplets.has(value.classification) ||
		triplets.get(value.classification) !== value.httpStatus
	) {
		throw new TypeError(
			"Delete outcome classification and HTTP status are inconsistent",
		);
	}
	return {
		targetReleaseId: assertId(
			value.targetReleaseId,
			"Delete outcome target Release id",
		),
		attemptNumber: assertDeleteAttempt(value.attemptNumber),
		classification: value.classification,
		httpStatus: value.httpStatus,
		observedAt: assertTimestamp(value.observedAt, "Delete outcome timestamp"),
	};
}

function normalizeResumeReconciliation(value) {
	assertExactFields(
		value,
		[
			"targetReleaseId",
			"attemptNumber",
			"classification",
			"releaseEvidence",
			"observedAt",
		],
		"resume-reconciliation payload",
	);
	const targetReleaseId = assertId(
		value.targetReleaseId,
		"Resume target Release id",
	);
	let releaseEvidence;
	if (value.classification === "present-unchanged-retryable") {
		releaseEvidence = normalizeReleaseEvidence(value.releaseEvidence);
		if (releaseEvidence.id !== targetReleaseId) {
			throw new TypeError(
				"Resume Release evidence does not identify its target",
			);
		}
	} else if (
		value.classification === "absent-ambiguous" &&
		value.releaseEvidence === null
	) {
		releaseEvidence = null;
	} else {
		throw new TypeError(
			"Resume classification and Release evidence are inconsistent",
		);
	}
	return {
		targetReleaseId,
		attemptNumber: assertDeleteAttempt(value.attemptNumber),
		classification: value.classification,
		releaseEvidence,
		observedAt: assertTimestamp(
			value.observedAt,
			"Resume reconciliation timestamp",
		),
	};
}

function normalizeAbsenceConverged(value) {
	assertExactFields(
		value,
		[
			"targetReleaseId",
			"attemptNumber",
			"basis",
			"directGet404At",
			"listAbsentAt",
			"attempts",
			"completedAt",
		],
		"absence-converged payload",
	);
	if (!new Set(["confirmed-204", "ambiguous"]).has(value.basis)) {
		throw new TypeError("Absence convergence basis is invalid");
	}
	const attempts = assertPositiveInteger(
		value.attempts,
		"Absence convergence attempts",
	);
	if (attempts > 6)
		throw new TypeError("Absence convergence exceeds six read attempts");
	return {
		targetReleaseId: assertId(
			value.targetReleaseId,
			"Absence target Release id",
		),
		attemptNumber: assertDeleteAttempt(value.attemptNumber),
		basis: value.basis,
		directGet404At: assertTimestamp(
			value.directGet404At,
			"Direct GET absence timestamp",
		),
		listAbsentAt: assertTimestamp(
			value.listAbsentAt,
			"Release list absence timestamp",
		),
		attempts,
		completedAt: assertTimestamp(
			value.completedAt,
			"Absence convergence timestamp",
		),
	};
}

function validateJournalEventTarget(event, deletionOrder) {
	const targetReleaseId = event.payload.targetReleaseId;
	if (
		targetReleaseId !== undefined &&
		!deletionOrder.includes(targetReleaseId)
	) {
		throw new TypeError(
			"Journal event target is not in the fixed deletion order",
		);
	}
}

function assertIdentityContract(candidate, roles, confirmation) {
	if (
		candidate.version !== confirmation.version ||
		candidate.commitSha !== confirmation.commitSha ||
		roles.survivor !== confirmation.survivor
	) {
		throw new TypeError(
			"Confirmation does not bind the proposed candidate and survivor",
		);
	}
	assertArrayEqual(
		confirmation.duplicates,
		roles.duplicates,
		"Confirmation duplicate identities",
	);
}

function assertPayloadMatchesReleases(payloadProof, releases) {
	const expected = payloadProof.baseAssetSet;
	for (const release of releases) {
		assertArrayEqual(
			release.assets.map(({ name }) => name),
			expected.map(({ name }) => name),
			"Release assets and payload proof names",
		);
		assertArrayEqual(
			release.assets.map(({ downloadSha256 }) => downloadSha256),
			expected.map(({ sha256 }) => sha256),
			"Release assets and payload proof digests",
		);
	}
}

function normalizeIdentityArray(value, label) {
	const identities = assertArray(value, label).map((entry) =>
		assertId(entry, label),
	);
	if (new Set(identities).size !== identities.length)
		throw new TypeError(`${label} contains duplicates`);
	return identities;
}

function assertExactFields(value, fields, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	const keys = Object.keys(value);
	if (
		keys.length !== fields.length ||
		fields.some((field) => !Object.hasOwn(value, field))
	) {
		throw new TypeError(`${label} must contain exactly: ${fields.join(", ")}`);
	}
}

function assertSchemaVersion(value, label) {
	if (value !== 1)
		throw new TypeError(`${label} schemaVersion must be integer 1`);
}

function assertArray(value, label) {
	if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
		throw new TypeError(`${label} must be a dense array`);
	}
	return value;
}

function assertArrayEqual(actual, expected, label) {
	if (
		actual.length !== expected.length ||
		actual.some((entry, index) => entry !== expected[index])
	) {
		throw new TypeError(`${label} is not canonical`);
	}
}

function assertUniqueNames(values, label) {
	if (new Set(values).size !== values.length)
		throw new TypeError(`${label} must be unique`);
}

function assertString(value, label) {
	if (typeof value !== "string")
		throw new TypeError(`${label} must be a string`);
	return value;
}

function assertNonemptyString(value, label) {
	const string = assertString(value, label);
	if (string.length === 0) throw new TypeError(`${label} must not be empty`);
	return string;
}

function assertMatchingString(value, pattern, label) {
	const string = assertNonemptyString(value, label);
	if (!pattern.test(string)) throw new TypeError(`${label} is not canonical`);
	return string;
}

function assertId(value, label) {
	return assertMatchingString(value, POSITIVE_DECIMAL_PATTERN, label);
}

function assertSha256(value, label) {
	return assertMatchingString(value, SHA256_PATTERN, label);
}

function assertGitSha(value, label) {
	return assertMatchingString(value, GIT_SHA_PATTERN, label);
}

function assertTimestamp(value, label) {
	const timestamp = assertMatchingString(value, TIMESTAMP_PATTERN, label);
	try {
		return new Date(timestamp).toISOString();
	} catch {
		throw new TypeError(`${label} is not a valid UTC instant`);
	}
}

function assertPositiveInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new TypeError(`${label} must be a positive integer`);
	return value;
}

function assertNonnegativeInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${label} must be a nonnegative integer`);
	}
	return value;
}

function assertDeleteAttempt(value) {
	const attempt = assertPositiveInteger(value, "Delete attempt number");
	if (attempt > DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumDeleteAttempts) {
		throw new TypeError("Delete attempt number exceeds the reviewed maximum");
	}
	return attempt;
}

function kindLimit(kind) {
	const maximum = KIND_LIMITS[kind];
	if (maximum === undefined)
		throw new TypeError("Unknown consolidation envelope kind");
	return maximum;
}

function assertWithinKindLimit(kind, byteLength) {
	const maximum = kindLimit(kind);
	if (byteLength > maximum)
		throw new Error(`${kind} envelope exceeds its byte limit`);
}
