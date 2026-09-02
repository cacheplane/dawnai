import { snapshotJson } from "./adapter-normalize.mjs";
import { canonicalRecordSha256 } from "./duplicate-draft-consolidation-schema.mjs";
import { parseReleaseMarker } from "./metadata.mjs";

const APPROVED_CANDIDATE = Object.freeze({
	version: "0.8.22",
	commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
	tag: "v0.8.22",
});
const SURVIVOR_ID = "379991871";
const DUPLICATE_IDS = Object.freeze(["379982100", "379986168"]);
const INCIDENT_IDS = Object.freeze([SURVIVOR_ID, ...DUPLICATE_IDS]);
const ID_PATTERN = /^[1-9][0-9]*$/u;
const DAWN_MARKER_IDENTITY = "DAWN_RELEASE_CONTROLLER_MARKER";

const STAGE_RULES = Object.freeze({
	"pre-delete-1": Object.freeze({
		releaseIds: INCIDENT_IDS,
		targetReleaseId: DUPLICATE_IDS[0],
	}),
	"pre-delete-2": Object.freeze({
		releaseIds: Object.freeze([SURVIVOR_ID, DUPLICATE_IDS[1]]),
		targetReleaseId: DUPLICATE_IDS[1],
	}),
	final: Object.freeze({
		releaseIds: Object.freeze([SURVIVOR_ID]),
		targetReleaseId: null,
	}),
});

export function consolidationStageRule(stage) {
	const rule = STAGE_RULES[stage];
	if (rule === undefined)
		throw new TypeError("Consolidation authority stage is invalid");
	return rule;
}

export function classifyConsolidationReleases(rawReleases, proposal, stage) {
	const rule = consolidationStageRule(stage);
	assertApprovedProposalIdentity(proposal);
	const releases = snapshotJson(rawReleases);
	if (!Array.isArray(releases))
		throw new TypeError("Release enumeration must be an array");

	const expected = new Set(rule.releaseIds);
	const selected = new Map();
	const seenIds = new Set();
	const entries = [];
	for (const [index, release] of releases.entries()) {
		const id = canonicalId(release?.id, `GitHub Release ${index} id`);
		if (seenIds.has(id))
			throw new Error("GitHub Release enumeration contains a duplicate ID");
		seenIds.add(id);

		let marker = null;
		try {
			marker = parseReleaseMarker(release.body);
		} catch {
			marker = null;
		}
		const exactMarker = markerMatches(marker, APPROVED_CANDIDATE);
		const exactTag = release.tag_name === APPROVED_CANDIDATE.tag;
		const incidentId = INCIDENT_IDS.includes(id);
		const suspiciousMarkerBody = isSuspiciousMarkerBody(
			release.body,
			APPROVED_CANDIDATE,
		);
		const partialMarker = markerSharesCandidateIdentity(
			marker,
			APPROVED_CANDIDATE,
		);
		const managed =
			exactMarker ||
			exactTag ||
			incidentId ||
			partialMarker ||
			suspiciousMarkerBody;

		if (!managed) {
			entries.push({ index, id, classification: "unrelated", release });
			continue;
		}
		if (!exactMarker) {
			throw new Error(
				"Managed candidate Release marker or tag identity is malformed or ambiguous",
			);
		}
		if (
			release.draft !== true ||
			release.immutable !== false ||
			release.published_at !== null
		) {
			throw new Error(
				"Managed candidate Release is published or not an exact draft",
			);
		}
		if (!expected.has(id)) {
			throw new Error(
				"Release enumeration contains a managed candidate contrary to the authority stage",
			);
		}
		selected.set(id, release);
		entries.push({ index, id, classification: "managed", release });
	}

	if (
		selected.size !== rule.releaseIds.length ||
		rule.releaseIds.some((id) => !selected.has(id))
	) {
		throw new Error(
			"Release enumeration is missing an exact remaining managed candidate draft",
		);
	}
	const enumerationRecord = {
		stage,
		candidate: APPROVED_CANDIDATE,
		expectedReleaseIds: rule.releaseIds,
		entries,
	};
	return deepFreeze({
		selected: rule.releaseIds.map((id) => selected.get(id)),
		enumerationSha256: canonicalRecordSha256(enumerationRecord),
	});
}

function assertApprovedProposalIdentity(proposal) {
	if (
		proposal === null ||
		typeof proposal !== "object" ||
		proposal.candidate?.version !== APPROVED_CANDIDATE.version ||
		proposal.candidate?.commitSha !== APPROVED_CANDIDATE.commitSha ||
		proposal.candidate?.tag !== APPROVED_CANDIDATE.tag ||
		proposal.roles?.survivor !== SURVIVOR_ID ||
		!Array.isArray(proposal.roles?.duplicates) ||
		proposal.roles.duplicates.length !== DUPLICATE_IDS.length ||
		proposal.roles.duplicates.some(
			(id, index) => id !== DUPLICATE_IDS[index],
		) ||
		!Array.isArray(proposal.releases) ||
		proposal.releases.length !== INCIDENT_IDS.length ||
		proposal.releases.some(({ id }, index) => id !== INCIDENT_IDS[index])
	) {
		throw new Error(
			"Release classification proposal is not the approved incident identity",
		);
	}
}

function markerMatches(marker, candidate) {
	return (
		marker !== null &&
		marker.version === candidate.version &&
		marker.commitSha === candidate.commitSha &&
		marker.tag === candidate.tag
	);
}

function markerSharesCandidateIdentity(marker, candidate) {
	return (
		marker !== null &&
		(marker.version === candidate.version ||
			marker.commitSha === candidate.commitSha ||
			marker.tag === candidate.tag)
	);
}

function isSuspiciousMarkerBody(body, candidate) {
	return (
		typeof body === "string" &&
		(body.includes(DAWN_MARKER_IDENTITY) ||
			body.includes(candidate.commitSha) ||
			body.includes(candidate.tag))
	);
}

function canonicalId(value, label) {
	const id = typeof value === "number" ? String(value) : value;
	if (typeof id !== "string" || !ID_PATTERN.test(id)) {
		throw new TypeError(`${label} must be a canonical positive decimal id`);
	}
	return id;
}

function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}
