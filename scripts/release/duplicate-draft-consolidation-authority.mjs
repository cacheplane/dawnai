import { createHash } from "node:crypto";
import { isDeepStrictEqual, types as utilTypes } from "node:util";

import {
	assertEvidenceEqualsProposal,
	captureDirectTargetRead,
	inspectEquivalentDrafts,
} from "./duplicate-draft-consolidation-evidence.mjs";
import {
	canonicalEventEnvelope,
	canonicalRecordSha256,
	createConsolidationEnvelope,
} from "./duplicate-draft-consolidation-schema.mjs";
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
		await context.local.readState(),
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
		await context.github.getRepository(),
		"GitHub repository",
	);
	const actor = snapshotPlain(
		await context.github.getAuthenticatedUser(),
		"GitHub actor",
	);
	const githubMainSha = await context.github.getDefaultBranchSha();
	const workflow = snapshotPlain(
		await context.github.getWorkflowState(),
		"Release workflow",
	);
	const nonterminalRuns = snapshotPlain(
		await context.github.listNonterminalWorkflowRuns(),
		"nonterminal workflow runs",
	);
	const annotatedTag = snapshotPlain(
		await context.github.getAnnotatedTag({ name: CANDIDATE.tag }),
		"annotated tag",
	);
	const releaseEnvelope = snapshotPlain(
		await context.github.listReleases(),
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
		observedAt: callTimestamp(context.now, "workflow authority observation"),
	});
	const currentTag = normalizeAnnotatedTag(annotatedTag);
	assertStableTagAndWorkflow(currentTag, workflowAuthority, proposal);

	const npmInventory = await captureNpmInventory({
		stage: context.stage,
		candidate: proposal.candidate,
		npm: context.npm.source,
		now: context.now,
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
		github: context.github,
		attestations: context.attestations,
		contextNow: context.now,
	});
	let releases = broadEvidence.releases;
	const payloadProof = broadEvidence.payloadProof;

	let targetRead = null;
	let terminalReadCount;
	if (stageRule.targetReleaseId !== null) {
		const targetIndex = releases.findIndex(
			({ id }) => id === stageRule.targetReleaseId,
		);
		if (targetIndex < 0)
			throw new Error("Authority target is absent from the Release list");
		targetRead = await captureDirectTargetRead({
			candidate: proposal.candidate,
			releaseId: stageRule.targetReleaseId,
			role: "duplicate",
			expectedEvidence: proposal.releases.find(
				({ id }) => id === stageRule.targetReleaseId,
			),
			github: context.github.source,
			now: context.now,
		});
		if (!isDeepStrictEqual(targetRead.evidence, releases[targetIndex])) {
			throw new Error(
				"Direct target evidence disagrees with the complete Release list",
			);
		}
		releases = releases.with(targetIndex, targetRead.evidence);
		terminalReadCount = readNetworkCount(context.networkReadCount);
	} else {
		terminalReadCount = readNetworkCount(context.networkReadCount);
	}
	const observedAt = callTimestamp(context.now, "authority observation");
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

	if (readNetworkCount(context.networkReadCount) !== terminalReadCount) {
		throw new Error(
			"Network epoch was invalidated after terminal read completion",
		);
	}
	const networkEpoch = createNetworkEpoch({
		authority,
		proposal,
		targetReleaseId: stageRule.targetReleaseId,
		terminalReadCount,
		networkReadCount: context.networkReadCount,
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
		[
			"stage",
			"proposal",
			"targetReleaseId",
			"local",
			"github",
			"npm",
			"attestations",
			"networkReadCount",
			"now",
		],
		"authority capture input",
	);
	const stage = dataString(value, "stage", "authority stage");
	if (!AUTHORITY_STAGES.has(stage))
		throw new TypeError("Authority stage is invalid");
	const target = dataValue(value, "targetReleaseId", "authority target");
	const targetReleaseId =
		target === null ? null : canonicalId(target, "authority target");
	const local = bindBoundary(
		dataValue(value, "local", "local reader"),
		["readState"],
		"local reader",
	);
	const github = bindBoundary(
		dataValue(value, "github", "GitHub reader"),
		[
			"getRepository",
			"getAuthenticatedUser",
			"getDefaultBranchSha",
			"getWorkflowState",
			"listNonterminalWorkflowRuns",
			"getAnnotatedTag",
			"listReleases",
			"downloadReleaseAsset",
			"getRelease",
			"listReleaseAssets",
		],
		"GitHub reader",
	);
	const npm = bindBoundary(
		dataValue(value, "npm", "npm reader"),
		["observePackageVersion"],
		"npm reader",
	);
	const attestations = bindBoundary(
		dataValue(value, "attestations", "attestation verifier"),
		["verify"],
		"attestation verifier",
	);
	return {
		stage,
		proposal: snapshotPlain(
			dataValue(value, "proposal", "proposal"),
			"proposal",
		),
		targetReleaseId,
		local,
		github,
		npm,
		attestations,
		networkReadCount: dataFunction(
			value,
			"networkReadCount",
			"network read counter",
		),
		now: dataFunction(value, "now", "authority clock"),
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

function normalizeWorkflowAuthority({ workflow, nonterminalRuns, observedAt }) {
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
			statuses: [...WORKFLOW_STATUSES],
			perPage: 100,
			maximumPages: 100,
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
		assertTimestampOrder(
			inventory.completedAt,
			authority.targetRead.releaseGetStartedAt,
			"terminal target read",
		);
		assertTimestampOrder(
			authority.targetRead.assetsListCompletedAt,
			authority.observedAt,
			"terminal target read",
		);
	} else {
		assertTimestampOrder(
			inventory.completedAt,
			authority.observedAt,
			"authority observation phase",
		);
	}
}

function createNetworkEpoch({
	authority,
	proposal,
	targetReleaseId,
	terminalReadCount,
	networkReadCount,
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
					["authority", "proposal", "targetReleaseId", "now", "writeIntent"],
					"network epoch consumption",
				);
				const currentReadCount = readNetworkCount(networkReadCount);
				if (currentReadCount !== terminalReadCount) {
					throw new Error(
						"Network epoch was invalidated by an intervening adapter read",
					);
				}
				const consumedAuthority = assertFreshWriterAuthority(
					dataValue(value, "authority", "epoch authority"),
					dataValue(value, "proposal", "epoch proposal"),
					dataString(value, "now", "epoch clock"),
				);
				const consumedProposal = normalizeProposal(
					dataValue(value, "proposal", "epoch proposal"),
				);
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
				const writeIntent = dataFunction(
					value,
					"writeIntent",
					"local journal-intent writer",
				);
				const beforeWriteCount = readNetworkCount(networkReadCount);
				if (beforeWriteCount !== terminalReadCount) {
					throw new Error(
						"Network epoch changed before the local journal-intent write",
					);
				}
				let result;
				try {
					result = await writeIntent();
				} catch {
					throw new Error("Local journal-intent write failed closed");
				}
				const afterWriteCount = readNetworkCount(networkReadCount);
				if (afterWriteCount !== terminalReadCount) {
					throw new Error(
						"Local journal-intent write performed a network read",
					);
				}
				return result;
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

function exactInput(value, expectedKeys, label) {
	if (!isPlainObject(value) || utilTypes.isProxy(value))
		throw new TypeError(`${label} must be a plain non-proxy object`);
	assertExactKeys(value, expectedKeys, label, { allowFunctions: true });
	return value;
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
	if (
		keys.length !== expected.length ||
		keys.some((key, index) => key !== expected[index]) ||
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

function assertTimestampOrder(earlier, later, label) {
	const first = canonicalTimestamp(earlier, label);
	const second = canonicalTimestamp(later, label);
	if (Date.parse(second) < Date.parse(first))
		throw new Error(`${label} timestamps are not monotone`);
}

function assertReadCount(value) {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new TypeError("Network read counter is invalid");
}

function readNetworkCount(networkReadCount) {
	let value;
	try {
		value = networkReadCount();
	} catch {
		throw new TypeError("Network read counter failed closed");
	}
	assertReadCount(value);
	return value;
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
