import { createHash } from "node:crypto";
import { isDeepStrictEqual, types as utilTypes } from "node:util";

import {
	assertEvidenceEqualsProposal,
	captureDirectTargetRead,
	inspectEquivalentDrafts,
} from "./duplicate-draft-consolidation-evidence.mjs";
import {
	readPrivateEnvelope,
	writePrivateEnvelope,
} from "./duplicate-draft-consolidation-files.mjs";
import {
	appendJournalEvent,
	deriveConsolidationState,
	parseConsolidationJournal,
} from "./duplicate-draft-consolidation-journal.mjs";
import {
	canonicalConsolidationEnvelopeBytes,
	canonicalEventEnvelope,
	canonicalRecordSha256,
	createConsolidationEnvelope,
	DUPLICATE_DRAFT_CONSOLIDATION_LIMITS,
} from "./duplicate-draft-consolidation-schema.mjs";
import {
	claimConsolidationTransitionFacade,
	invokeConsolidationTransition,
} from "./duplicate-draft-consolidation-transition.mjs";
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs";
import { parseReleaseMarker } from "./metadata.mjs";

const REPOSITORY = "cacheplane/dawnai";
const REPOSITORY_ID = "1210070282";
const ACTOR = Object.freeze({ login: "blove", id: "61436" });
const CANDIDATE = Object.freeze({
	version: "0.8.22",
	commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
	tag: "v0.8.22",
});
const SURVIVOR_ID = "379991871";
const DUPLICATE_IDS = Object.freeze(["379982100", "379986168"]);
const WORKFLOW_PATH = ".github/workflows/release.yml";
const WORKFLOW_STATUSES = Object.freeze([
	"in_progress",
	"pending",
	"queued",
	"requested",
	"waiting",
]);
const WORKFLOW_RUN_QUERY = Object.freeze({
	statuses: WORKFLOW_STATUSES,
	perPage: 100,
	maximumPages: 100,
});
const NPM_STAGES = new Set([
	"inspect-initial",
	"inspect-ready",
	"perform-initial",
	"pre-delete-1",
	"pre-delete-2",
	"final",
]);
const AUTHORITY_STAGES = new Set(["pre-delete-1", "pre-delete-2", "final"]);
const MAXIMUM_NPM_OPERATION_MS = 120_000;
const MAXIMUM_WRITER_AGE_MS = 120_000;
const TIMESTAMP_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ID_PATTERN = /^[1-9][0-9]*$/u;

export async function captureNpmInventory(input) {
	const value = exactInput(
		input,
		["stage", "candidate", "npm", "now"],
		"npm inventory input",
	);
	const stage = dataString(value, "stage", "npm inventory stage");
	if (!NPM_STAGES.has(stage))
		throw new TypeError("npm inventory stage is invalid");
	const candidate = normalizeCandidate(
		dataValue(value, "candidate", "npm candidate"),
	);
	const npm = bindBoundary(
		dataValue(value, "npm", "npm reader"),
		["observePackageVersion"],
		"npm reader",
	);
	const now = dataFunction(value, "now", "npm inventory clock");

	const startedAt = callTimestamp(now, "npm inventory start");
	const packages = [];
	let previousObservedAt = startedAt;
	for (const name of CANONICAL_RELEASE_PACKAGE_ORDER) {
		const result = snapshotPlain(
			await npm.observePackageVersion({ name, version: candidate.version }),
			"npm package-version evidence",
		);
		assertExactKeys(
			result,
			["status", "operation", "httpStatus", "code"],
			"npm package-version evidence",
		);
		if (
			result.status !== "ABSENT" ||
			result.operation !== "package-version" ||
			result.httpStatus !== 404 ||
			result.code !== "E404"
		) {
			throw new Error(
				"npm package-version absence evidence is incomplete or ambiguous",
			);
		}
		const observedAt = callTimestamp(now, "npm package observation");
		assertTimestampOrder(
			previousObservedAt,
			observedAt,
			"npm package observation",
		);
		previousObservedAt = observedAt;
		packages.push({
			name,
			version: candidate.version,
			status: "ABSENT",
			httpStatus: 404,
			code: "E404",
			observedAt,
		});
	}
	const completedAt = callTimestamp(now, "npm inventory completion");
	assertTimestampOrder(
		packages.at(-1).observedAt,
		completedAt,
		"npm inventory completion",
	);
	if (
		Date.parse(completedAt) - Date.parse(startedAt) >
		MAXIMUM_NPM_OPERATION_MS
	) {
		throw new Error("npm inventory operation exceeded its duration bound");
	}
	return deepFreeze({ stage, startedAt, completedAt, packages });
}

export async function captureConsolidationAuthority(input) {
	const context = normalizeCaptureInput(input);
	const proposal = normalizeProposal(context.proposal);
	assertProductionProposal(proposal);
	const stageRule = authorityStageRule(context.stage);
	if (context.targetReleaseId !== stageRule.targetReleaseId) {
		throw new Error(
			"Authority target is not the approved current next duplicate",
		);
	}

	const localState = snapshotPlain(
		await context.adapters.local.readState(),
		"local checkout state",
	);
	assertExactKeys(
		localState,
		["headSha", "branch", "porcelainStatus", "originMainSha"],
		"local checkout state",
	);
	if (
		localState.branch !== "main" ||
		localState.porcelainStatus !== "" ||
		!SHA_PATTERN.test(localState.headSha) ||
		localState.headSha !== localState.originMainSha
	) {
		throw new Error(
			"Local checkout must be clean symbolic main at exact origin/main",
		);
	}

	const repository = snapshotPlain(
		await context.adapters.github.getRepository(),
		"GitHub repository",
	);
	const actor = snapshotPlain(
		await context.adapters.github.getAuthenticatedUser(),
		"GitHub actor",
	);
	const githubMainSha = await context.adapters.github.getDefaultBranchSha();
	const workflow = snapshotPlain(
		await context.adapters.github.getWorkflowState(),
		"Release workflow",
	);
	const nonterminalRunRead = snapshotPlain(
		await context.adapters.github.listNonterminalWorkflowRuns(
			WORKFLOW_RUN_QUERY,
		),
		"nonterminal workflow-run read",
	);
	const nonterminalRuns = normalizeNonterminalRunRead(
		nonterminalRunRead,
		WORKFLOW_RUN_QUERY,
	);
	const annotatedTag = snapshotPlain(
		await context.adapters.github.getAnnotatedTag({ name: CANDIDATE.tag }),
		"annotated tag",
	);
	const releaseEnvelope = snapshotPlain(
		await context.adapters.github.listReleases(),
		"Release enumeration",
	);
	const listedReleases = presentValue(releaseEnvelope, "releases");
	if (!Array.isArray(listedReleases))
		throw new TypeError("Release enumeration is malformed");

	assertRepositoryAuthority({ repository, actor, proposal });
	if (
		typeof githubMainSha !== "string" ||
		githubMainSha !== localState.headSha ||
		githubMainSha !== proposal.controller.githubMainSha
	) {
		throw new Error(
			"Controller HEAD, origin/main, and GitHub main SHAs must match",
		);
	}
	if (
		localState.headSha !== proposal.controller.headSha ||
		localState.originMainSha !== proposal.controller.originMainSha
	) {
		throw new Error(
			"Current controller SHA authority differs from the proposal",
		);
	}
	const workflowAuthority = normalizeWorkflowAuthority({
		workflow,
		nonterminalRuns,
		query: WORKFLOW_RUN_QUERY,
		observedAt: callTimestamp(
			context.adapters.now,
			"workflow authority observation",
		),
	});
	const currentTag = normalizeAnnotatedTag(annotatedTag);
	assertStableTagAndWorkflow(currentTag, workflowAuthority, proposal);

	const npmInventory = await captureNpmInventory({
		stage: context.stage,
		candidate: proposal.candidate,
		npm: context.adapters.npm.source,
		now: context.adapters.now,
	});
	const selectedRaw = selectManagedReleases(
		listedReleases,
		proposal,
		stageRule.releaseIds,
	);
	const broadEvidence = await hydrateListedEvidence({
		stage: context.stage,
		selectedRaw,
		proposal,
		github: context.adapters.github,
		attestations: context.adapters.attestations,
		contextNow: context.adapters.now,
	});
	let releases = broadEvidence.releases;
	const payloadProof = broadEvidence.payloadProof;

	let targetRead = null;
	let adapterEpoch;
	if (stageRule.targetReleaseId !== null) {
		const targetIndex = releases.findIndex(
			({ id }) => id === stageRule.targetReleaseId,
		);
		if (targetIndex < 0)
			throw new Error("Authority target is absent from the Release list");
		const terminal = context.adapters.authorityEpoch.beginTerminalRead({
			releaseId: stageRule.targetReleaseId,
		});
		try {
			targetRead = await captureDirectTargetRead({
				candidate: proposal.candidate,
				releaseId: stageRule.targetReleaseId,
				role: "duplicate",
				expectedEvidence: proposal.releases.find(
					({ id }) => id === stageRule.targetReleaseId,
				),
				github: terminal.github,
				now: context.adapters.now,
			});
			adapterEpoch = terminal.seal();
		} catch {
			terminal.abort();
			throw new Error("Terminal target read failed closed");
		}
		if (!isDeepStrictEqual(targetRead.evidence, releases[targetIndex])) {
			throw new Error(
				"Direct target evidence disagrees with the complete Release list",
			);
		}
		releases = releases.with(targetIndex, targetRead.evidence);
	} else {
		try {
			adapterEpoch = context.adapters.authorityEpoch.sealWithoutTarget();
		} catch {
			throw new Error("Final network epoch failed closed");
		}
	}
	const observedAt = callTimestamp(
		context.adapters.now,
		"authority observation",
	);
	const authority = normalizeAuthorityStage({
		stage: context.stage,
		controller: {
			headSha: localState.headSha,
			originMainSha: localState.originMainSha,
			githubMainSha,
		},
		annotatedTag: currentTag,
		workflowAuthority,
		npmInventory,
		releases,
		payloadProof,
		targetRead,
		observedAt,
	});
	assertAuthorityTemporalOrder(authority, observedAt);
	assertAuthorityAgainstProposal(authority, proposal);
	if (stageRule.targetReleaseId !== null) {
		assertFreshWriterAuthority(authority, proposal, observedAt);
	}

	try {
		adapterEpoch.validate();
	} catch {
		throw new Error("Network epoch was invalidated after terminal completion");
	}
	const networkEpoch = createNetworkEpoch({
		authority,
		proposal,
		targetReleaseId: stageRule.targetReleaseId,
		adapterEpoch,
		transitionCapability: context.transitionCapability,
	});
	const result = { authority };
	Object.defineProperty(result, "networkEpoch", {
		value: networkEpoch,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return Object.freeze(result);
}

export function assertFreshWriterAuthority(authority, proposal, now) {
	const normalizedProposal = normalizeProposal(proposal);
	assertProductionProposal(normalizedProposal);
	const stage = ownDataString(authority, "stage", "writer authority stage");
	if (stage !== "pre-delete-1" && stage !== "pre-delete-2") {
		throw new Error("Writer authority must be a pre-delete stage");
	}
	const normalizedAuthority = normalizeAuthorityStage(authority);
	const currentTimestamp = canonicalTimestamp(now, "writer authority clock");
	assertAuthorityTemporalOrder(normalizedAuthority, currentTimestamp);
	assertAuthorityAgainstProposal(normalizedAuthority, normalizedProposal);
	const age =
		Date.parse(currentTimestamp) -
		Date.parse(normalizedAuthority.npmInventory.completedAt);
	if (age < 0)
		throw new Error("Writer authority contains a future npm observation");
	if (age > MAXIMUM_WRITER_AGE_MS) {
		throw new Error("Writer authority npm inventory is stale beyond 120000ms");
	}
	return normalizedAuthority;
}

function normalizeCaptureInput(input) {
	const value = exactInput(
		input,
		["stage", "proposal", "targetReleaseId", "adapters"],
		"authority capture input",
	);
	const stage = dataString(value, "stage", "authority stage");
	if (!AUTHORITY_STAGES.has(stage))
		throw new TypeError("Authority stage is invalid");
	const target = dataValue(value, "targetReleaseId", "authority target");
	const targetReleaseId =
		target === null ? null : canonicalId(target, "authority target");
	const rawAdapters = dataValue(value, "adapters", "consolidation adapters");
	const adapters = bindAdapterFacade(rawAdapters);
	const transitionCapability = claimConsolidationTransitionFacade(rawAdapters);
	return {
		stage,
		proposal: snapshotPlain(
			dataValue(value, "proposal", "proposal"),
			"proposal",
		),
		targetReleaseId,
		adapters,
		transitionCapability,
	};
}

function normalizeProposal(value) {
	return deepFreeze(
		createConsolidationEnvelope("proposed", snapshotPlain(value, "proposal"))
			.record,
	);
}

function assertProductionProposal(proposal) {
	if (
		proposal.repository.name !== REPOSITORY ||
		proposal.repository.id !== REPOSITORY_ID ||
		proposal.repository.defaultBranch !== "main" ||
		!isDeepStrictEqual(proposal.repository.actor, ACTOR) ||
		!isDeepStrictEqual(proposal.candidate, CANDIDATE) ||
		proposal.roles.survivor !== SURVIVOR_ID ||
		!isDeepStrictEqual(proposal.roles.duplicates, DUPLICATE_IDS)
	) {
		throw new Error(
			"Proposal does not bind the approved production incident identity",
		);
	}
}

function authorityStageRule(stage) {
	if (stage === "pre-delete-1") {
		return {
			releaseIds: [SURVIVOR_ID, ...DUPLICATE_IDS],
			targetReleaseId: DUPLICATE_IDS[0],
		};
	}
	if (stage === "pre-delete-2") {
		return {
			releaseIds: [SURVIVOR_ID, DUPLICATE_IDS[1]],
			targetReleaseId: DUPLICATE_IDS[1],
		};
	}
	return { releaseIds: [SURVIVOR_ID], targetReleaseId: null };
}

function assertRepositoryAuthority({ repository, actor, proposal }) {
	assertExactKeys(
		repository,
		["name", "id", "defaultBranch"],
		"GitHub repository",
	);
	assertExactKeys(actor, ["login", "id"], "GitHub actor");
	if (
		repository.name !== REPOSITORY ||
		repository.id !== REPOSITORY_ID ||
		repository.defaultBranch !== "main" ||
		actor.login !== ACTOR.login ||
		actor.id !== ACTOR.id ||
		!isDeepStrictEqual({ ...repository, actor }, proposal.repository)
	) {
		throw new Error("GitHub repository or actor identity is not approved");
	}
}

function normalizeNonterminalRunRead(value, executedQuery) {
	assertExactKeys(value, ["query", "runs"], "nonterminal workflow-run read");
	const echoedQuery = snapshotPlain(
		value.query,
		"nonterminal workflow-run query echo",
	);
	assertExactKeys(
		echoedQuery,
		["statuses", "perPage", "maximumPages"],
		"nonterminal workflow-run query echo",
	);
	if (!isDeepStrictEqual(echoedQuery, executedQuery)) {
		throw new Error(
			"Nonterminal workflow-run query echo differs from the executed query",
		);
	}
	if (!Array.isArray(value.runs)) {
		throw new TypeError("Nonterminal workflow-run result is malformed");
	}
	return value.runs;
}

function normalizeWorkflowAuthority({
	workflow,
	nonterminalRuns,
	query,
	observedAt,
}) {
	assertExactKeys(
		workflow,
		["workflowId", "path", "state"],
		"Release workflow",
	);
	if (
		!ID_PATTERN.test(workflow.workflowId) ||
		workflow.path !== WORKFLOW_PATH ||
		workflow.state !== "disabled_manually"
	) {
		throw new Error(
			"Release workflow authority is missing, malformed, or active",
		);
	}
	if (!Array.isArray(nonterminalRuns) || nonterminalRuns.length !== 0) {
		throw new Error("Release workflow has a nonterminal or duplicate run");
	}
	return {
		workflowId: workflow.workflowId,
		path: WORKFLOW_PATH,
		state: "disabled_manually",
		query: {
			statuses: [...query.statuses],
			perPage: query.perPage,
			maximumPages: query.maximumPages,
		},
		nonterminalRuns: [],
		observedAt,
	};
}

function normalizeAnnotatedTag(value) {
	assertExactKeys(
		value,
		["name", "objectSha", "targetSha", "objectType", "observedAt"],
		"annotated tag",
	);
	if (
		value.name !== CANDIDATE.tag ||
		!SHA_PATTERN.test(value.objectSha) ||
		value.targetSha !== CANDIDATE.commitSha ||
		value.objectType !== "tag"
	) {
		throw new Error("Candidate tag is moved, lightweight, or malformed");
	}
	return {
		name: value.name,
		objectSha: value.objectSha,
		targetSha: value.targetSha,
		objectType: value.objectType,
		observedAt: canonicalTimestamp(
			value.observedAt,
			"annotated tag observation",
		),
	};
}

function assertStableTagAndWorkflow(tag, workflow, proposal) {
	for (const field of ["name", "objectSha", "targetSha", "objectType"]) {
		if (tag[field] !== proposal.annotatedTag[field]) {
			throw new Error(
				"Current annotated tag differs from the approved proposal",
			);
		}
	}
	for (const field of ["workflowId", "path", "state"]) {
		if (workflow[field] !== proposal.workflowAuthority[field]) {
			throw new Error(
				"Current Release workflow differs from the approved proposal",
			);
		}
	}
}

function selectManagedReleases(rawReleases, proposal, expectedIds) {
	const expected = new Set(expectedIds);
	const selected = new Map();
	const allIds = new Set();
	for (const [index, source] of rawReleases.entries()) {
		const release = snapshotPlain(source, `GitHub Release ${index}`);
		const id = canonicalId(release.id, `GitHub Release ${index} id`);
		if (allIds.has(id))
			throw new Error("GitHub Release enumeration contains a duplicate ID");
		allIds.add(id);
		let marker = null;
		try {
			marker = parseReleaseMarker(release.body);
		} catch {
			marker = null;
		}
		const candidateMarker =
			marker !== null &&
			marker.version === CANDIDATE.version &&
			marker.commitSha === CANDIDATE.commitSha &&
			marker.tag === CANDIDATE.tag;
		const candidateTag = release.tag_name === CANDIDATE.tag;
		if (
			!candidateMarker &&
			!candidateTag &&
			![SURVIVOR_ID, ...DUPLICATE_IDS].includes(id)
		)
			continue;
		if (!candidateMarker)
			throw new Error("Managed candidate Release marker is malformed");
		if (!expected.has(id))
			throw new Error(
				"Release enumeration contains an extra managed candidate Release",
			);
		if (selected.has(id))
			throw new Error(
				"Release enumeration contains a duplicate managed Release",
			);
		selected.set(id, release);
	}
	if (
		selected.size !== expectedIds.length ||
		expectedIds.some((id) => !selected.has(id))
	) {
		throw new Error(
			"Release enumeration is missing an exact remaining managed draft",
		);
	}
	if (proposal.releases.length !== 3)
		throw new Error("Proposal Release evidence is incomplete");
	return expectedIds.map((id) => selected.get(id));
}

async function hydrateListedEvidence({
	stage,
	selectedRaw,
	proposal,
	github,
	attestations,
	contextNow,
}) {
	if (stage === "pre-delete-1") {
		const inspected = await inspectEquivalentDrafts({
			candidate: proposal.candidate,
			survivorId: proposal.roles.survivor,
			duplicateIds: proposal.roles.duplicates,
			releases: selectedRaw,
			github: github.source,
			attestations: attestations.source,
		});
		if (!isDeepStrictEqual(inspected.payloadProof, proposal.payloadProof)) {
			throw new Error(
				"Current production payload proof differs from the proposal",
			);
		}
		return inspected;
	}
	const releases = [];
	for (const raw of selectedRaw) {
		const id = canonicalId(raw.id, "listed Release id");
		const expectedEvidence = proposal.releases.find(
			(release) => release.id === id,
		);
		if (expectedEvidence === undefined)
			throw new Error("Listed Release is absent from the proposal");
		const read = await captureDirectTargetRead({
			candidate: proposal.candidate,
			releaseId: id,
			role: expectedEvidence.role,
			expectedEvidence,
			github: Object.freeze({
				async getRelease() {
					return {
						status: "PRESENT",
						operation: "release",
						httpStatus: 200,
						code: null,
						value: raw,
					};
				},
				async listReleaseAssets() {
					return {
						status: "PRESENT",
						operation: "release-assets",
						httpStatus: 200,
						code: null,
						value: raw.assets,
					};
				},
			}),
			now: contextNow,
		});
		releases.push(read.evidence);
	}
	await verifyCurrentPayloadDownloads(releases, github.source);
	return deepFreeze({ releases, payloadProof: proposal.payloadProof });
}

async function verifyCurrentPayloadDownloads(releases, github) {
	let downloads = 0;
	for (const release of releases) {
		for (const asset of release.assets) {
			downloads += 1;
			if (downloads > 135) {
				throw new Error(
					"Current Release payload exceeded the download-count bound",
				);
			}
			const envelope = snapshotPlain(
				await github.downloadReleaseAsset({
					releaseId: release.id,
					assetId: asset.id,
					maximumBytes: asset.size,
				}),
				"current Release asset download",
			);
			assertExactKeys(
				envelope,
				["status", "operation", "httpStatus", "code", "contentBase64"],
				"current Release asset download",
			);
			if (
				envelope.status !== "PRESENT" ||
				envelope.operation !== "release-asset-download" ||
				envelope.httpStatus !== 200 ||
				envelope.code !== null ||
				typeof envelope.contentBase64 !== "string"
			) {
				throw new Error(
					"Current Release asset download is unavailable or ambiguous",
				);
			}
			const maximumCharacters = Math.ceil(asset.size / 3) * 4;
			if (envelope.contentBase64.length > maximumCharacters) {
				throw new Error(
					"Current Release asset download exceeds its declared size",
				);
			}
			const bytes = Buffer.from(envelope.contentBase64, "base64");
			if (
				bytes.byteLength !== asset.size ||
				bytes.toString("base64") !== envelope.contentBase64 ||
				createHash("sha256").update(bytes).digest("hex") !==
					asset.downloadSha256
			) {
				throw new Error(
					"Current Release asset bytes differ from the proven proposal",
				);
			}
		}
	}
}

function normalizeAuthorityStage(value) {
	const stage = ownDataString(value, "stage", "authority stage");
	const event =
		stage === "final"
			? {
					schemaVersion: 1,
					sequence: 1,
					previousEventSha256: null,
					type: "final-authority-observed",
					recordedAt: ownDataString(
						value,
						"observedAt",
						"authority observation",
					),
					payload: { authority: value },
				}
			: {
					schemaVersion: 1,
					sequence: 1,
					previousEventSha256: null,
					type: "delete-authority-observed",
					recordedAt: ownDataString(
						value,
						"observedAt",
						"authority observation",
					),
					payload: {
						targetReleaseId: authorityStageRule(stage).targetReleaseId,
						attemptNumber: 1,
						authority: value,
					},
				};
	return deepFreeze(
		canonicalEventEnvelope(event, null).event.payload.authority,
	);
}

function assertAuthorityAgainstProposal(authority, proposal) {
	const rule = authorityStageRule(authority.stage);
	if (!isDeepStrictEqual(authority.controller, proposal.controller)) {
		throw new Error("Authority controller differs from the proposal");
	}
	assertStableTagAndWorkflow(
		authority.annotatedTag,
		authority.workflowAuthority,
		proposal,
	);
	if (
		authority.npmInventory.stage !== authority.stage ||
		authority.npmInventory.packages.some(
			(entry, index) =>
				entry.name !== CANONICAL_RELEASE_PACKAGE_ORDER[index] ||
				entry.version !== proposal.candidate.version,
		)
	) {
		throw new Error(
			"Authority npm inventory does not bind the proposal candidate",
		);
	}
	if (
		!isDeepStrictEqual(
			authority.releases.map(({ id }) => id),
			rule.releaseIds,
		)
	) {
		throw new Error("Authority remaining Release identities are invalid");
	}
	for (const release of authority.releases) {
		const proposed = proposal.releases.find(({ id }) => id === release.id);
		if (proposed === undefined)
			throw new Error("Authority Release is absent from the proposal");
		assertEvidenceEqualsProposal(release, proposed);
	}
	if (!isDeepStrictEqual(authority.payloadProof, proposal.payloadProof)) {
		throw new Error("Authority payload proof differs from the proposal");
	}
	if (rule.targetReleaseId === null) {
		if (authority.targetRead !== null)
			throw new Error("Final authority must not contain a target read");
	} else if (
		authority.targetRead === null ||
		authority.targetRead.evidence.id !== rule.targetReleaseId ||
		!isDeepStrictEqual(
			authority.targetRead.evidence,
			authority.releases.find(({ id }) => id === rule.targetReleaseId),
		)
	) {
		throw new Error(
			"Authority direct target is not the approved current next duplicate",
		);
	}
}

function assertAuthorityTemporalOrder(authority, ceiling) {
	const ceilingTimestamp = canonicalTimestamp(
		ceiling,
		"authority time ceiling",
	);
	const inventory = authority.npmInventory;
	assertTimestampOrder(
		authority.annotatedTag.observedAt,
		authority.workflowAuthority.observedAt,
		"authority observation phase",
	);
	assertTimestampOrder(
		authority.workflowAuthority.observedAt,
		inventory.startedAt,
		"authority observation phase",
	);
	let previousNpmTimestamp = inventory.startedAt;
	for (const observation of inventory.packages) {
		assertTimestampOrder(
			previousNpmTimestamp,
			observation.observedAt,
			"npm observation",
		);
		previousNpmTimestamp = observation.observedAt;
	}
	assertTimestampOrder(
		previousNpmTimestamp,
		inventory.completedAt,
		"npm inventory",
	);
	for (const observedAt of [
		authority.annotatedTag.observedAt,
		authority.workflowAuthority.observedAt,
		inventory.completedAt,
		authority.observedAt,
	]) {
		assertTimestampOrder(observedAt, ceilingTimestamp, "authority observation");
	}
	for (const release of authority.releases) {
		assertTimestampOrder(
			release.createdAt,
			release.updatedAt,
			"Release service observation",
		);
		assertTimestampOrder(
			release.updatedAt,
			ceilingTimestamp,
			"Release service observation",
		);
		for (const asset of release.assets) {
			assertTimestampOrder(
				asset.createdAt,
				asset.updatedAt,
				"asset service observation",
			);
			assertTimestampOrder(
				asset.updatedAt,
				ceilingTimestamp,
				"asset service observation",
			);
		}
	}
	if (authority.targetRead !== null) {
		assertTargetReadChronology(authority, inventory.completedAt);
	} else {
		assertTimestampOrder(
			inventory.completedAt,
			authority.observedAt,
			"authority observation phase",
		);
	}
}

function assertTargetReadChronology(authority, npmCompletedAt) {
	const chronology = [
		npmCompletedAt,
		authority.targetRead.releaseGetStartedAt,
		authority.targetRead.releaseGetCompletedAt,
		authority.targetRead.assetsListStartedAt,
		authority.targetRead.assetsListCompletedAt,
		authority.observedAt,
	];
	for (let index = 1; index < chronology.length; index += 1) {
		assertTimestampOrder(
			chronology[index - 1],
			chronology[index],
			"terminal target-read chronology",
		);
	}
}

function createNetworkEpoch({
	authority,
	proposal,
	targetReleaseId,
	adapterEpoch,
	transitionCapability,
}) {
	const authoritySha256 = canonicalRecordSha256(authority);
	const proposalSha256 = canonicalRecordSha256(proposal);
	let consumed = false;
	const capability = {};
	Object.defineProperties(capability, {
		consume: {
			enumerable: false,
			configurable: false,
			writable: false,
			async value(input) {
				if (consumed)
					throw new Error("Network epoch has already been consumed");
				consumed = true;
				const value = exactInput(
					input,
					[
						"authority",
						"proposal",
						"confirmation",
						"targetReleaseId",
						"intentPath",
						"currentJournal",
					],
					"network epoch consumption",
				);
				assertAdapterEpochSealed(adapterEpoch);
				const currentTimestamp = readTrustedEpochClock(adapterEpoch);
				const consumedAuthority = assertFreshWriterAuthority(
					dataValue(value, "authority", "epoch authority"),
					dataValue(value, "proposal", "epoch proposal"),
					currentTimestamp,
				);
				const consumedProposal = normalizeProposal(
					dataValue(value, "proposal", "epoch proposal"),
				);
				const proposedEnvelope = createConsolidationEnvelope(
					"proposed",
					consumedProposal,
				);
				const confirmation = dataString(
					value,
					"confirmation",
					"operator confirmation",
				);
				assertExactIncidentConfirmation(confirmation, proposedEnvelope);
				const consumedTarget = canonicalId(
					dataValue(value, "targetReleaseId", "epoch target"),
					"epoch target",
				);
				if (
					canonicalRecordSha256(consumedAuthority) !== authoritySha256 ||
					canonicalRecordSha256(consumedProposal) !== proposalSha256 ||
					consumedTarget !== targetReleaseId
				) {
					throw new Error(
						"Network epoch authority, proposal, or target binding changed",
					);
				}
				const intentPath = dataString(
					value,
					"intentPath",
					"journal intent path",
				);
				if (intentPath !== adapterEpoch.journalPath) {
					throw new Error(
						"Journal intent path is not the adapter-owned private path",
					);
				}
				const expectedCurrent = parseConsolidationJournal(
					dataValue(value, "currentJournal", "current journal"),
				);
				const expectedConfirmationSha256 = createHash("sha256")
					.update(confirmation, "utf8")
					.digest("hex");
				const expectedCurrentState = deriveConsolidationState(expectedCurrent);
				if (
					expectedCurrent.record.proposedRecordSha256 !== proposalSha256 ||
					expectedCurrent.record.confirmationSha256 !==
						expectedConfirmationSha256 ||
					expectedCurrentState.controllerSha !==
						consumedAuthority.controller.headSha
				) {
					throw new Error(
						"Current journal does not bind proposal confirmation and controller",
					);
				}
				let currentBytes;
				try {
					currentBytes = await readPrivateEnvelope(
						intentPath,
						DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
					);
				} catch {
					throw new Error(
						"Exact current private journal could not be authenticated; do not DELETE",
					);
				}
				const currentEnvelope = parseConsolidationJournal(currentBytes);
				const expectedCurrentBytes = canonicalConsolidationEnvelopeBytes(
					"journal",
					expectedCurrent,
				);
				if (
					!currentBytes.equals(expectedCurrentBytes) ||
					!isDeepStrictEqual(currentEnvelope, expectedCurrent)
				) {
					throw new Error(
						"Current journal file differs from the authenticated expected history",
					);
				}
				const journalHeadPath = `${intentPath.slice(0, -"journal.json".length)}journal.head.json`;
				let currentHeadBytes;
				try {
					currentHeadBytes = await reconcileJournalHead({
						journalHeadPath,
						journalPath: intentPath,
						journal: currentEnvelope,
					});
				} catch {
					throw new Error(
						"Durable journal head anchor is missing, ahead, divergent, or unsafe; do not DELETE",
					);
				}
				if (
					expectedCurrentState.phase !== "delete-authority-observed" ||
					expectedCurrentState.currentTargetReleaseId !== consumedTarget ||
					!isDeepStrictEqual(
						expectedCurrentState.lastAuthority,
						consumedAuthority,
					)
				) {
					throw new Error(
						"Current journal is not the exact legal delete-authority predecessor",
					);
				}
				const beforeWriteTimestamp = readTrustedEpochClock(adapterEpoch);
				assertFreshWriterAuthority(
					consumedAuthority,
					consumedProposal,
					beforeWriteTimestamp,
				);
				assertAdapterEpochSealed(adapterEpoch);
				const intentEnvelope = appendJournalEvent(
					currentEnvelope,
					"delete-intent",
					{
						targetReleaseId: consumedTarget,
						attemptNumber: expectedCurrentState.attemptNumber,
						authorityEventSha256: expectedCurrentState.lastEventSha256,
					},
					beforeWriteTimestamp,
				);
				const intentBytes = canonicalConsolidationEnvelopeBytes(
					"journal",
					intentEnvelope,
				);
				try {
					await writePrivateEnvelope(
						intentPath,
						intentBytes,
						undefined,
						currentBytes,
					);
				} catch {
					throw new Error(
						"Journal intent may already be durable; persistence failed, so do not DELETE or reconsume",
					);
				}
				try {
					const committedJournal = await readPrivateEnvelope(
						intentPath,
						DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
					);
					if (!committedJournal.equals(intentBytes)) {
						throw new Error(
							"Committed journal bytes differ from the legal intent",
						);
					}
					const parsedCommitted = parseConsolidationJournal(committedJournal);
					if (!isDeepStrictEqual(parsedCommitted, intentEnvelope)) {
						throw new Error(
							"Committed journal envelope differs from the legal intent",
						);
					}
					const committedHeadBytes = canonicalJournalHeadBytes(
						intentPath,
						intentEnvelope,
					);
					await writePrivateEnvelope(
						journalHeadPath,
						committedHeadBytes,
						undefined,
						currentHeadBytes,
					);
					const committedHead = await readPrivateEnvelope(
						journalHeadPath,
						16 * 1024,
					);
					if (!committedHead.equals(committedHeadBytes)) {
						throw new Error(
							"Committed journal head differs from the legal intent",
						);
					}
					const completedTimestamp = readTrustedEpochClock(adapterEpoch);
					assertFreshWriterAuthority(
						consumedAuthority,
						consumedProposal,
						completedTimestamp,
					);
					adapterEpoch.validate();
					return invokeConsolidationTransition(transitionCapability, {
						targetReleaseId: consumedTarget,
						authority: consumedAuthority,
						proposedEnvelope,
						confirmation,
						predecessorJournal: currentBytes,
						committedJournal,
					});
				} catch {
					throw new Error(
						"Journal intent may already be durable; post-write authority failed, so do not DELETE or reconsume",
					);
				}
			},
		},
		toJSON: {
			enumerable: false,
			configurable: false,
			writable: false,
			value() {
				throw new TypeError("Network epoch capability cannot be serialized");
			},
		},
	});
	return Object.freeze(capability);
}

function assertAdapterEpochSealed(adapterEpoch) {
	try {
		adapterEpoch.validate();
	} catch {
		throw new Error("Adapter network epoch is invalid or no longer sealed");
	}
}

function readTrustedEpochClock(adapterEpoch) {
	try {
		return canonicalTimestamp(adapterEpoch.now(), "trusted adapter clock");
	} catch {
		throw new TypeError("Trusted adapter clock failed closed");
	}
}

async function reconcileJournalHead({ journalHeadPath, journalPath, journal }) {
	let headBytes;
	try {
		headBytes = await readPrivateEnvelope(journalHeadPath, 16 * 1024);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) throw error;
		await writePrivateEnvelope(
			journalHeadPath,
			canonicalJournalHeadBytes(journalPath, journal),
			undefined,
			null,
		);
		return readPrivateEnvelope(journalHeadPath, 16 * 1024);
	}
	const head = parseJournalHead(headBytes, journalPath);
	if (journalHeadMatches(head, journal)) return headBytes;
	if (head.sequence + 1 !== journal.record.events.length) {
		throw new Error("Journal and durable head have divergent sequence lineage");
	}
	const predecessor = createConsolidationEnvelope("journal", {
		...journal.record,
		events: journal.record.events.slice(0, -1),
		updatedAt: journal.record.events.at(-2).event.recordedAt,
	});
	parseConsolidationJournal(predecessor);
	if (!journalHeadMatches(head, predecessor)) {
		throw new Error(
			"Journal is not one legal append ahead of its durable head",
		);
	}
	await writePrivateEnvelope(
		journalHeadPath,
		canonicalJournalHeadBytes(journalPath, journal),
		undefined,
		headBytes,
	);
	return readPrivateEnvelope(journalHeadPath, 16 * 1024);
}

function canonicalJournalHeadBytes(journalPath, journal) {
	return Buffer.from(
		`${JSON.stringify({
			schemaVersion: 1,
			journalPath,
			repository: journal.record.repository,
			proposedRecordSha256: journal.record.proposedRecordSha256,
			journalRecordSha256: journal.recordSha256,
			lastEventSha256: journal.record.events.at(-1).eventSha256,
			sequence: journal.record.events.length,
			updatedAt: journal.record.updatedAt,
		})}\n`,
		"utf8",
	);
}

function parseJournalHead(bytes, expectedJournalPath) {
	let value;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("Journal head is not canonical UTF-8 JSON");
	}
	assertExactKeys(
		value,
		[
			"schemaVersion",
			"journalPath",
			"repository",
			"proposedRecordSha256",
			"journalRecordSha256",
			"lastEventSha256",
			"sequence",
			"updatedAt",
		],
		"journal head",
	);
	if (
		value.schemaVersion !== 1 ||
		value.journalPath !== expectedJournalPath ||
		!Number.isSafeInteger(value.sequence) ||
		value.sequence < 1 ||
		!/^[0-9a-f]{64}$/u.test(value.proposedRecordSha256) ||
		!/^[0-9a-f]{64}$/u.test(value.journalRecordSha256) ||
		!/^[0-9a-f]{64}$/u.test(value.lastEventSha256) ||
		canonicalTimestamp(value.updatedAt, "journal head timestamp") !==
			value.updatedAt ||
		!Buffer.from(`${JSON.stringify(value)}\n`, "utf8").equals(bytes)
	) {
		throw new Error("Journal head fields or canonical bytes are invalid");
	}
	return value;
}

function journalHeadMatches(head, journal) {
	return (
		head.journalRecordSha256 === journal.recordSha256 &&
		head.proposedRecordSha256 === journal.record.proposedRecordSha256 &&
		head.lastEventSha256 === journal.record.events.at(-1).eventSha256 &&
		head.sequence === journal.record.events.length &&
		head.updatedAt === journal.record.updatedAt &&
		isDeepStrictEqual(head.repository, journal.record.repository)
	);
}

function hasErrorCode(error, code) {
	if (error !== null && typeof error === "object") {
		if (error.code === code) return true;
		if (hasErrorCode(error.cause, code)) return true;
		if (
			Array.isArray(error.errors) &&
			error.errors.some((entry) => hasErrorCode(entry, code))
		)
			return true;
	}
	return false;
}

function exactInput(value, expectedKeys, label) {
	if (!isPlainObject(value) || utilTypes.isProxy(value))
		throw new TypeError(`${label} must be a plain non-proxy object`);
	assertExactKeys(value, expectedKeys, label, { allowFunctions: true });
	return value;
}

function bindAdapterFacade(value) {
	if (
		!isPlainObject(value) ||
		utilTypes.isProxy(value) ||
		!Object.isFrozen(value) ||
		Object.getOwnPropertySymbols(value).length !== 0
	) {
		throw new TypeError(
			"consolidation adapters must be an immutable plain non-proxy facade",
		);
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const expected = new Set([
		"local",
		"github",
		"npm",
		"attestations",
		"writer",
		"authorityEpoch",
	]);
	if (
		Object.keys(descriptors).length !== expected.size ||
		Object.keys(descriptors).some((key) => !expected.has(key))
	) {
		throw new TypeError("consolidation adapter facade fields are invalid");
	}
	for (const name of ["local", "github", "npm", "attestations", "writer"]) {
		const descriptor = descriptors[name];
		if (
			descriptor?.enumerable !== true ||
			!("value" in descriptor) ||
			descriptor.get !== undefined ||
			descriptor.set !== undefined
		) {
			throw new TypeError("consolidation adapter facade fields are invalid");
		}
	}
	const epochDescriptor = descriptors.authorityEpoch;
	if (
		epochDescriptor?.enumerable !== false ||
		epochDescriptor.writable !== false ||
		epochDescriptor.configurable !== false ||
		!("value" in epochDescriptor)
	) {
		throw new TypeError("adapter authority capability descriptor is invalid");
	}
	const authorityEpoch = bindAuthorityCapability(epochDescriptor.value, value);
	return Object.freeze({
		local: bindBoundary(
			descriptors.local.value,
			["readState"],
			"local Git reader",
		),
		github: bindBoundary(
			descriptors.github.value,
			[
				"getRepository",
				"getAuthenticatedUser",
				"getDefaultBranchSha",
				"getWorkflowState",
				"listNonterminalWorkflowRuns",
				"getAnnotatedTag",
				"listReleases",
				"getRelease",
				"listReleaseAssets",
				"downloadReleaseAsset",
			],
			"GitHub authority reader",
		),
		npm: bindBoundary(
			descriptors.npm.value,
			["observePackageVersion"],
			"npm authority reader",
		),
		attestations: bindBoundary(
			descriptors.attestations.value,
			["verify"],
			"attestation authority reader",
		),
		writer: bindBoundary(
			descriptors.writer.value,
			["deleteDuplicate"],
			"duplicate delete writer",
		),
		authorityEpoch,
		now: authorityEpoch.now,
	});
}

function bindAuthorityCapability(value, facade) {
	assertHiddenCapability(
		value,
		[
			"now",
			"journalPath",
			"validateFacade",
			"beginTerminalRead",
			"sealWithoutTarget",
			"toJSON",
		],
		"adapter authority capability",
	);
	const now = hiddenDataFunction(value, "now", "adapter authority clock");
	const validateFacade = hiddenDataFunction(
		value,
		"validateFacade",
		"adapter facade validator",
	);
	const beginTerminalRead = hiddenDataFunction(
		value,
		"beginTerminalRead",
		"terminal-read capability",
	);
	const sealWithoutTarget = hiddenDataFunction(
		value,
		"sealWithoutTarget",
		"final-stage capability",
	);
	try {
		validateFacade.call(value, facade);
	} catch {
		throw new TypeError("adapter authority capability binding failed closed");
	}
	return Object.freeze({
		now: () => {
			try {
				return now.call(value);
			} catch {
				throw new TypeError("Trusted adapter clock failed closed");
			}
		},
		journalPath: hiddenDataValue(value, "journalPath", "adapter journal path"),
		beginTerminalRead(input) {
			try {
				return bindTerminalCapability(beginTerminalRead.call(value, input));
			} catch {
				throw new Error("Terminal network epoch failed closed");
			}
		},
		sealWithoutTarget() {
			try {
				return bindFinalEpoch(sealWithoutTarget.call(value));
			} catch {
				throw new Error("Final network epoch failed closed");
			}
		},
	});
}

function bindFinalEpoch(value) {
	assertHiddenCapability(
		value,
		["now", "journalPath", "validate", "toJSON"],
		"final adapter epoch",
	);
	const now = hiddenDataFunction(value, "now", "final adapter clock");
	const validate = hiddenDataFunction(
		value,
		"validate",
		"final epoch validator",
	);
	return Object.freeze({
		now: () => now.call(value),
		journalPath: hiddenDataValue(value, "journalPath", "final journal path"),
		validate: () => validate.call(value),
	});
}

function bindTerminalCapability(value) {
	assertHiddenCapability(
		value,
		["github", "seal", "abort", "toJSON"],
		"terminal network capability",
	);
	const github = bindBoundary(
		hiddenDataValue(value, "github", "terminal GitHub reader"),
		["getRelease", "listReleaseAssets"],
		"terminal GitHub reader",
	).source;
	const seal = hiddenDataFunction(value, "seal", "terminal epoch seal");
	const abort = hiddenDataFunction(value, "abort", "terminal epoch abort");
	return Object.freeze({
		github,
		seal() {
			try {
				return bindSealedEpoch(seal.call(value));
			} catch {
				throw new Error("Terminal network epoch seal failed closed");
			}
		},
		abort() {
			try {
				abort.call(value);
			} catch {
				throw new Error("Terminal network epoch abort failed closed");
			}
		},
	});
}

function bindSealedEpoch(value) {
	assertHiddenCapability(
		value,
		["now", "journalPath", "validate", "toJSON"],
		"sealed adapter epoch",
	);
	const now = hiddenDataFunction(value, "now", "sealed adapter clock");
	const validate = hiddenDataFunction(
		value,
		"validate",
		"sealed epoch validator",
	);
	return Object.freeze({
		now: () => now.call(value),
		journalPath: hiddenDataValue(value, "journalPath", "sealed journal path"),
		validate: () => validate.call(value),
	});
}

function assertHiddenCapability(value, expectedKeys, label) {
	if (
		!isPlainObject(value) ||
		utilTypes.isProxy(value) ||
		!Object.isFrozen(value) ||
		Object.getOwnPropertySymbols(value).length !== 0
	) {
		throw new TypeError(`${label} is invalid`);
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const expected = new Set(expectedKeys);
	if (
		Object.keys(descriptors).length !== expected.size ||
		Object.keys(descriptors).some((key) => !expected.has(key)) ||
		Object.values(descriptors).some(
			(descriptor) =>
				descriptor.enumerable !== false ||
				descriptor.writable !== false ||
				descriptor.configurable !== false ||
				!("value" in descriptor),
		)
	) {
		throw new TypeError(`${label} fields or descriptors are invalid`);
	}
}

function hiddenDataValue(value, name, label) {
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (
		descriptor?.enumerable !== false ||
		descriptor.writable !== false ||
		descriptor.configurable !== false ||
		!("value" in descriptor)
	) {
		throw new TypeError(`${label} is invalid`);
	}
	return descriptor.value;
}

function hiddenDataFunction(value, name, label) {
	const result = hiddenDataValue(value, name, label);
	if (typeof result !== "function" || utilTypes.isProxy(result)) {
		throw new TypeError(`${label} must be a non-proxy function`);
	}
	return result;
}

function bindBoundary(value, methods, label) {
	if (
		!isPlainObject(value) ||
		utilTypes.isProxy(value) ||
		!Object.isFrozen(value)
	) {
		throw new TypeError(`${label} must be an immutable plain non-proxy object`);
	}
	assertExactKeys(value, methods, label, { allowFunctions: true });
	const bound = {};
	for (const method of methods) {
		const fn = dataFunction(value, method, `${label} method`);
		bound[method] = async (...args) => {
			try {
				return await fn.apply(value, args);
			} catch {
				throw new Error(`${label} operation failed closed`);
			}
		};
	}
	const source = Object.freeze(bound);
	return Object.freeze({ ...source, source });
}

function dataValue(value, name, label) {
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (
		descriptor === undefined ||
		!descriptor.enumerable ||
		!("value" in descriptor)
	) {
		throw new TypeError(`${label} must be an enumerable data property`);
	}
	return descriptor.value;
}

function dataString(value, name, label) {
	const result = dataValue(value, name, label);
	if (typeof result !== "string")
		throw new TypeError(`${label} must be a string`);
	return result;
}

function dataFunction(value, name, label) {
	const result = dataValue(value, name, label);
	if (typeof result !== "function" || utilTypes.isProxy(result)) {
		throw new TypeError(`${label} must be a non-proxy function`);
	}
	return result;
}

function ownDataString(value, name, label) {
	if (!isPlainObject(value) || utilTypes.isProxy(value))
		throw new TypeError(`${label} object is invalid`);
	return dataString(value, name, label);
}

function assertExactKeys(
	value,
	expected,
	label,
	{ allowFunctions = false } = {},
) {
	if (!isPlainObject(value) || utilTypes.isProxy(value))
		throw new TypeError(`${label} must be a plain object`);
	if (Object.getOwnPropertySymbols(value).length !== 0)
		throw new TypeError(`${label} contains symbol properties`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Object.keys(descriptors);
	const expectedSet = new Set(expected);
	if (
		keys.length !== expected.length ||
		keys.some((key) => !expectedSet.has(key)) ||
		keys.some((key) => {
			const descriptor = descriptors[key];
			return (
				!descriptor.enumerable ||
				!("value" in descriptor) ||
				(!allowFunctions && typeof descriptor.value === "function")
			);
		})
	) {
		throw new TypeError(`${label} fields or descriptors are invalid`);
	}
}

function snapshotPlain(value, label) {
	if (utilTypes.isProxy(value))
		throw new TypeError(`${label} must not be a proxy`);
	if (Array.isArray(value)) {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const symbols = Object.getOwnPropertySymbols(value);
		if (symbols.length !== 0)
			throw new TypeError(`${label} contains symbol properties`);
		const keys = Object.keys(descriptors).filter((key) => key !== "length");
		if (
			keys.length !== value.length ||
			keys.some((key, index) => key !== String(index))
		) {
			throw new TypeError(`${label} must be a dense canonical array`);
		}
		return keys.map((key) => {
			const descriptor = descriptors[key];
			if (!descriptor.enumerable || !("value" in descriptor))
				throw new TypeError(`${label} contains an accessor`);
			return snapshotPlain(descriptor.value, `${label}[${key}]`);
		});
	}
	if (value !== null && typeof value === "object") {
		if (!isPlainObject(value))
			throw new TypeError(`${label} must contain only plain objects`);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.getOwnPropertySymbols(value).length !== 0)
			throw new TypeError(`${label} contains symbol properties`);
		const result = {};
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (
				!descriptor.enumerable ||
				!("value" in descriptor) ||
				typeof descriptor.value === "function"
			) {
				throw new TypeError(
					`${label} contains hidden, accessor, or function properties`,
				);
			}
			result[key] = snapshotPlain(descriptor.value, `${label}.${key}`);
		}
		return result;
	}
	if (
		typeof value === "symbol" ||
		typeof value === "function" ||
		typeof value === "bigint"
	) {
		throw new TypeError(`${label} contains a non-data value`);
	}
	return value;
}

function presentValue(value, operation) {
	assertExactKeys(
		value,
		["status", "operation", "httpStatus", "code", "value"],
		`${operation} envelope`,
	);
	if (
		value.status !== "PRESENT" ||
		value.operation !== operation ||
		value.httpStatus !== 200 ||
		value.code !== null
	) {
		throw new Error(`${operation} evidence is unavailable or ambiguous`);
	}
	return value.value;
}

function normalizeCandidate(value) {
	const candidate = snapshotPlain(value, "candidate");
	assertExactKeys(candidate, ["version", "commitSha", "tag"], "candidate");
	if (!isDeepStrictEqual(candidate, CANDIDATE)) {
		throw new Error("Candidate is not the approved v0.8.22 incident");
	}
	return candidate;
}

function canonicalId(value, label) {
	const result =
		typeof value === "number" && Number.isSafeInteger(value)
			? String(value)
			: value;
	if (typeof result !== "string" || !ID_PATTERN.test(result))
		throw new TypeError(`${label} is invalid`);
	return result;
}

function callTimestamp(now, label) {
	let value;
	try {
		value = now();
	} catch {
		throw new TypeError(`${label} clock failed`);
	}
	return canonicalTimestamp(value, label);
}

function canonicalTimestamp(value, label) {
	if (
		typeof value !== "string" ||
		!TIMESTAMP_PATTERN.test(value) ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(Date.parse(value)).toISOString() !== value
	) {
		throw new TypeError(`${label} must be a canonical timestamp`);
	}
	return value;
}

function assertExactIncidentConfirmation(value, proposedEnvelope) {
	if (
		typeof value !== "string" ||
		Buffer.byteLength(value, "utf8") > 512 ||
		[...value].some((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
		})
	) {
		throw new TypeError(
			"Operator confirmation must be an exact control-free string",
		);
	}
	const { candidate, roles } = proposedEnvelope.record;
	const expected = `CONSOLIDATE ${candidate.version} ${candidate.commitSha} SURVIVOR ${roles.survivor} DELETE ${roles.duplicates.join(",")} PROPOSAL ${proposedEnvelope.recordSha256}`;
	if (value !== expected) {
		throw new Error("Operator confirmation does not exactly bind the proposal");
	}
}

function assertTimestampOrder(earlier, later, label) {
	const first = canonicalTimestamp(earlier, label);
	const second = canonicalTimestamp(later, label);
	if (Date.parse(second) < Date.parse(first))
		throw new Error(`${label} timestamps are not monotone`);
}

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}
