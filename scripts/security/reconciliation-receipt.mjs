import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { canonicalJsonBytes, EvidenceError } from "./github-evidence.mjs";
import { verifyPublicationSnapshot } from "./publication-containment.mjs";

const GHSA_PATTERN =
	/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u;
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TIMESTAMP_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;

function fail(code) {
	throw new EvidenceError(code);
}

export function validateReconciliationFileInputs({
	auditExpectationFixtureBytes,
	auditReceiptBytes,
	baselineReceiptBytes,
	dependabotIdentitiesFixtureBytes,
	expectedReviewedBaseSha,
}) {
	const auditExpectation = validateAuditExpectationForReceipt(
		parseEvidenceJsonBytes(auditExpectationFixtureBytes),
	);
	const audit = validateAuditReceipt(parseEvidenceJsonBytes(auditReceiptBytes));
	if (!canonicalJsonBytes(audit).equals(auditReceiptBytes))
		fail("INVALID_AUDIT_RECEIPT");
	for (const mode of ["full", "production"]) {
		if (
			JSON.stringify(audit[mode].records) !==
				JSON.stringify(auditExpectation[mode].records) ||
			audit[mode].muted.length !== 0
		) {
			fail("AUDIT_EXPECTATION_MISMATCH");
		}
	}
	const dependabotIdentities = validateDependabotExpectationForReceipt(
		parseEvidenceJsonBytes(dependabotIdentitiesFixtureBytes),
	);
	if (dependabotIdentities.defaultSha !== expectedReviewedBaseSha) {
		fail("DEPENDABOT_BASELINE_PROVENANCE_MISMATCH");
	}
	const baselineReceipt = validateBaselineReceiptForReconciliation(
		parseEvidenceJsonBytes(baselineReceiptBytes),
		{ dependabotIdentities, expectedReviewedBaseSha },
	);
	if (!canonicalJsonBytes(baselineReceipt).equals(baselineReceiptBytes)) {
		fail("INVALID_BASELINE_RECEIPT");
	}
	const digests = {
		auditExpectationFixtureSha256: sha256(auditExpectationFixtureBytes),
		auditReceiptSha256: sha256(auditReceiptBytes),
		baselineReceiptSha256: sha256(baselineReceiptBytes),
		dependabotIdentitiesFixtureSha256: sha256(dependabotIdentitiesFixtureBytes),
	};
	if (digests.auditReceiptSha256 !== digest(audit))
		fail("AUDIT_RECEIPT_DIGEST_MISMATCH");
	return { audit, baselineReceipt, dependabotIdentities, digests };
}

export function createReconciliationReceipt({
	completedAtMilliseconds,
	fileInputs,
	fixed,
	mergedAt,
	observationHead,
	openA,
	openB,
	prNumber,
	publicationAfter,
	publicationBefore,
	repository,
	reviewedBaseSha,
	reviewedHeadSha,
	mergeSha,
	startedAtMilliseconds,
	verificationRuns,
}) {
	const receipt = {
		audit: {
			digest: fileInputs.digests.auditReceiptSha256,
			evidence: fileInputs.audit,
		},
		dependabot: { fixed, open: openA },
		digests: {
			inputs: fileInputs.digests,
			outputs: {
				fixedAlertsSha256: digest(fixed),
				openSnapshotASha256: digest(openA),
				openSnapshotBSha256: digest(openB),
				publicationAfterSha256: digest(publicationAfter),
				publicationBeforeSha256: digest(publicationBefore),
			},
		},
		kind: "dependency-security-reconciliation",
		observation: {
			completedAt: formatTimestampMilliseconds(completedAtMilliseconds),
			startedAt: formatTimestampMilliseconds(startedAtMilliseconds),
		},
		observationHead,
		pr: {
			mergeParentShas: [reviewedBaseSha, reviewedHeadSha],
			mergeSha,
			mergedAt,
			number: prNumber,
			reviewedBaseSha,
			reviewedHeadSha,
		},
		publication: publicationAfter,
		repository,
		schemaVersion: 1,
		verificationRuns,
	};
	if (canonicalJsonBytes(receipt).byteLength > 32 * 1024) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	return validateReconciliationReceipt(receipt);
}

function parseEvidenceJsonBytes(value) {
	if (
		!Buffer.isBuffer(value) ||
		value.byteLength === 0 ||
		value.byteLength > 1024 * 1024
	) {
		fail("INVALID_RECONCILIATION_INPUT");
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
	} catch {
		fail("INVALID_RECONCILIATION_INPUT");
	}
}

function validateAuditExpectationForReceipt(value) {
	const expectation = safeClone(value);
	assertExactKeys(expectation, ["full", "production", "schemaVersion"]);
	if (expectation.schemaVersion !== 1) fail("INVALID_AUDIT_EXPECTATION");
	return {
		full: validateAuditExpectationMode(expectation.full),
		production: validateAuditExpectationMode(expectation.production),
		schemaVersion: 1,
	};
}

function validateAuditExpectationMode(value) {
	if (!isRecord(value)) fail("INVALID_AUDIT_EXPECTATION");
	assertExactKeys(value, ["muted", "records"]);
	if (
		!Array.isArray(value.muted) ||
		value.muted.length !== 0 ||
		!Array.isArray(value.records)
	) {
		fail("INVALID_AUDIT_EXPECTATION");
	}
	const records = value.records
		.map(validateAuditRecord)
		.sort(compareAuditRecords);
	if (
		new Set(records.map((record) => JSON.stringify(record))).size !==
		records.length
	) {
		fail("INVALID_AUDIT_EXPECTATION");
	}
	return { muted: [], records };
}

function validateDependabotExpectationForReceipt(value) {
	const fixture = safeClone(value);
	assertExactKeys(fixture, [
		"defaultSha",
		"open",
		"repository",
		"schemaVersion",
	]);
	if (
		fixture.schemaVersion !== 1 ||
		fixture.repository !== "cacheplane/dawnai" ||
		!isSha(fixture.defaultSha) ||
		!Array.isArray(fixture.open) ||
		fixture.open.length === 0
	) {
		fail("INVALID_DEPENDABOT_FIXTURE");
	}
	const open = fixture.open.map(validateNormalizedAlert);
	const numbers = open.map((alert) => alert.number);
	if (
		new Set(numbers).size !== numbers.length ||
		numbers.some(
			(number, index) => index > 0 && number <= numbers[index - 1],
		) ||
		open.some(
			(alert) =>
				alert.state !== "open" ||
				alert.fixedAt !== null ||
				alert.dismissal !== null ||
				alert.autoDismissedAt !== null,
		)
	) {
		fail("INVALID_DEPENDABOT_FIXTURE");
	}
	return {
		defaultSha: fixture.defaultSha,
		open,
		repository: fixture.repository,
		schemaVersion: 1,
	};
}

function validateBaselineReceiptForReconciliation(
	value,
	{ dependabotIdentities, expectedReviewedBaseSha },
) {
	const receipt = safeClone(value);
	assertExactKeys(receipt, [
		"capturedAt",
		"dependabot",
		"kind",
		"publication",
		"repository",
		"schemaVersion",
		"sourceSha",
	]);
	if (
		receipt.kind !== "dependency-security-baseline" ||
		receipt.repository !== "cacheplane/dawnai" ||
		receipt.schemaVersion !== 1 ||
		!isTimestamp(receipt.capturedAt) ||
		!isSha(receipt.sourceSha)
	) {
		fail("INVALID_BASELINE_RECEIPT");
	}
	assertExactKeys(receipt.dependabot, ["defaultSha", "open"]);
	if (
		receipt.dependabot.defaultSha !== expectedReviewedBaseSha ||
		JSON.stringify(receipt.dependabot.open) !==
			JSON.stringify(dependabotIdentities.open)
	) {
		fail("INVALID_BASELINE_RECEIPT");
	}
	const publication = verifyPublicationSnapshot(receipt.publication, {
		expectedDefaultSha: expectedReviewedBaseSha,
	});
	if (publication.sourceSha !== receipt.sourceSha)
		fail("INVALID_BASELINE_RECEIPT");
	return {
		capturedAt: receipt.capturedAt,
		dependabot: {
			defaultSha: expectedReviewedBaseSha,
			open: dependabotIdentities.open,
		},
		kind: "dependency-security-baseline",
		publication,
		repository: "cacheplane/dawnai",
		schemaVersion: 1,
		sourceSha: receipt.sourceSha,
	};
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function digest(value) {
	return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

function formatTimestampMilliseconds(value) {
	if (
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > 8_640_000_000_000_000
	) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	try {
		return new Date(value).toISOString().replace(/\.[0-9]{3}Z$/u, "Z");
	} catch {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
}

export function validateReconciliationReceipt(value) {
	try {
		return validateReconciliationReceiptValue(value);
	} catch {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
}

function validateReconciliationReceiptValue(value) {
	const receipt = safeClone(value);
	assertExactKeys(receipt, [
		"audit",
		"dependabot",
		"digests",
		"kind",
		"observation",
		"observationHead",
		"pr",
		"publication",
		"repository",
		"schemaVersion",
		"verificationRuns",
	]);
	if (
		receipt.kind !== "dependency-security-reconciliation" ||
		receipt.repository !== "cacheplane/dawnai" ||
		receipt.schemaVersion !== 1 ||
		!isSha(receipt.observationHead)
	) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	assertExactKeys(receipt.observation, ["completedAt", "startedAt"]);
	if (
		!isTimestamp(receipt.observation.startedAt) ||
		!isTimestamp(receipt.observation.completedAt)
	) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	assertExactKeys(receipt.pr, [
		"mergeParentShas",
		"mergeSha",
		"mergedAt",
		"number",
		"reviewedBaseSha",
		"reviewedHeadSha",
	]);
	if (
		!isSha(receipt.pr.mergeSha) ||
		!isSha(receipt.pr.reviewedBaseSha) ||
		!isSha(receipt.pr.reviewedHeadSha) ||
		!Array.isArray(receipt.pr.mergeParentShas) ||
		receipt.pr.mergeParentShas.length !== 2 ||
		receipt.pr.mergeParentShas[0] !== receipt.pr.reviewedBaseSha ||
		receipt.pr.mergeParentShas[1] !== receipt.pr.reviewedHeadSha ||
		!Number.isSafeInteger(receipt.pr.number) ||
		receipt.pr.number < 1 ||
		!isTimestamp(receipt.pr.mergedAt) ||
		Date.parse(receipt.observation.startedAt) <
			Date.parse(receipt.pr.mergedAt) ||
		Date.parse(receipt.observation.completedAt) <
			Date.parse(receipt.observation.startedAt)
	) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	assertExactKeys(receipt.audit, ["digest", "evidence"]);
	const audit = validateAuditReceipt(receipt.audit.evidence);
	if (
		!isDigest(receipt.audit.digest) ||
		receipt.audit.digest !== digest(audit)
	) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	assertExactKeys(receipt.digests, ["inputs", "outputs"]);
	assertExactKeys(receipt.digests.inputs, [
		"auditExpectationFixtureSha256",
		"auditReceiptSha256",
		"baselineReceiptSha256",
		"dependabotIdentitiesFixtureSha256",
	]);
	assertExactKeys(receipt.digests.outputs, [
		"fixedAlertsSha256",
		"openSnapshotASha256",
		"openSnapshotBSha256",
		"publicationAfterSha256",
		"publicationBeforeSha256",
	]);
	if (
		!Object.values(receipt.digests.inputs).every(isDigest) ||
		!Object.values(receipt.digests.outputs).every(isDigest) ||
		receipt.digests.inputs.auditReceiptSha256 !== receipt.audit.digest
	) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	assertExactKeys(receipt.dependabot, ["fixed", "open"]);
	const fixed = validateReceiptAlerts(
		receipt.dependabot.fixed,
		"fixed",
		receipt.pr.mergedAt,
	);
	const open = validateReceiptAlerts(
		receipt.dependabot.open,
		"open",
		receipt.pr.mergedAt,
	);
	const numbers = [...fixed, ...open].map((alert) => alert.number);
	if (new Set(numbers).size !== numbers.length)
		fail("INVALID_RECONCILIATION_RECEIPT");
	const publication = verifyPublicationSnapshot(receipt.publication, {
		expectedDefaultSha: receipt.observationHead,
	});
	if (publication.sourceSha !== receipt.observationHead) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	const expectedOutputDigests = {
		fixedAlertsSha256: digest(fixed),
		openSnapshotASha256: digest(open),
		openSnapshotBSha256: digest(open),
		publicationAfterSha256: digest(publication),
		publicationBeforeSha256: digest(publication),
	};
	if (
		JSON.stringify(receipt.digests.outputs) !==
		JSON.stringify(expectedOutputDigests)
	) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	const verificationRuns = validateVerificationRunReceipt(
		receipt.verificationRuns,
		receipt.pr.mergeSha,
		receipt.observationHead,
	);
	return {
		audit: { digest: receipt.audit.digest, evidence: audit },
		dependabot: { fixed, open },
		digests: receipt.digests,
		kind: "dependency-security-reconciliation",
		observation: receipt.observation,
		observationHead: receipt.observationHead,
		pr: receipt.pr,
		publication,
		repository: "cacheplane/dawnai",
		schemaVersion: 1,
		verificationRuns,
	};
}

function validateVerificationRunReceipt(value, mergeSha, observationHead) {
	if (!Array.isArray(value)) fail("INVALID_RECONCILIATION_RECEIPT");
	const workflowPaths = [
		".github/workflows/ci.yml",
		".github/workflows/codeql.yml",
		".github/workflows/scorecard.yml",
	];
	const heads = [...new Set([mergeSha, observationHead])].sort(compareText);
	const expectedTuples = heads.flatMap((headSha) =>
		workflowPaths.map((workflowPath) => `${headSha}\0${workflowPath}`),
	);
	const runIds = new Set();
	const runs = value.map((run) => {
		assertExactKeys(run, [
			"conclusion",
			"event",
			"headBranch",
			"headSha",
			"runAttempt",
			"runId",
			"status",
			"workflowPath",
		]);
		if (
			run.conclusion !== "success" ||
			run.event !== "push" ||
			run.headBranch !== "main" ||
			!isSha(run.headSha) ||
			!Number.isSafeInteger(run.runAttempt) ||
			run.runAttempt < 1 ||
			!Number.isSafeInteger(run.runId) ||
			run.runId < 1 ||
			runIds.has(run.runId) ||
			run.status !== "completed" ||
			!workflowPaths.includes(run.workflowPath)
		) {
			fail("INVALID_RECONCILIATION_RECEIPT");
		}
		runIds.add(run.runId);
		return run;
	});
	if (
		JSON.stringify(runs.map((run) => `${run.headSha}\0${run.workflowPath}`)) !==
		JSON.stringify(expectedTuples)
	) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	return runs;
}

function validateReceiptAlerts(value, expectedState, mergedAt) {
	if (!Array.isArray(value) || value.length === 0)
		fail("INVALID_RECONCILIATION_RECEIPT");
	const alerts = value.map(validateNormalizedAlert);
	const numbers = alerts.map((alert) => alert.number);
	if (
		new Set(numbers).size !== numbers.length ||
		numbers.some(
			(number, index) => index > 0 && number <= numbers[index - 1],
		) ||
		alerts.some(
			(alert) =>
				alert.state !== expectedState ||
				alert.dismissal !== null ||
				alert.autoDismissedAt !== null ||
				(expectedState === "open" && alert.fixedAt !== null) ||
				(expectedState === "fixed" &&
					(alert.fixedAt === null ||
						Date.parse(alert.fixedAt) < Date.parse(mergedAt))),
		)
	) {
		fail("INVALID_RECONCILIATION_RECEIPT");
	}
	return alerts;
}

export function validateAuditReceipt(value) {
	const receipt = safeClone(value);
	assertExactKeys(receipt, ["full", "kind", "production", "schemaVersion"]);
	if (receipt.kind !== "pnpm-audit" || receipt.schemaVersion !== 1) {
		fail("INVALID_AUDIT_RECEIPT");
	}
	return {
		full: validateAuditMode(receipt.full),
		kind: "pnpm-audit",
		production: validateAuditMode(receipt.production),
		schemaVersion: 1,
	};
}

function validateAuditMode(value) {
	if (!isRecord(value)) fail("INVALID_AUDIT_RECEIPT");
	assertExactKeys(value, [
		"exitCode",
		"muted",
		"records",
		"severityTotals",
		"status",
	]);
	if (
		!Array.isArray(value.muted) ||
		value.muted.length !== 0 ||
		!Array.isArray(value.records)
	) {
		fail("INVALID_AUDIT_RECEIPT");
	}
	const records = value.records.map(validateAuditRecord);
	const identities = records.map((record) => JSON.stringify(record));
	if (new Set(identities).size !== identities.length)
		fail("INVALID_AUDIT_RECEIPT");
	const totals = { critical: 0, high: 0, info: 0, low: 0, moderate: 0 };
	for (const record of records) totals[record.severity] += 1;
	if (
		!isRecord(value.severityTotals) ||
		JSON.stringify(value.severityTotals) !== JSON.stringify(totals) ||
		(records.length === 0 &&
			(value.exitCode !== 0 || value.status !== "clean")) ||
		(records.length > 0 &&
			(value.exitCode !== 1 || value.status !== "findings"))
	) {
		fail("INVALID_AUDIT_RECEIPT");
	}
	return {
		exitCode: value.exitCode,
		muted: [],
		records,
		severityTotals: totals,
		status: value.status,
	};
}

function validateAuditRecord(record) {
	if (!isRecord(record)) fail("INVALID_AUDIT_RECEIPT");
	assertExactKeys(record, ["ghsa", "package", "severity", "version"]);
	if (
		typeof record.ghsa !== "string" ||
		!GHSA_PATTERN.test(record.ghsa) ||
		typeof record.package !== "string" ||
		!PACKAGE_PATTERN.test(record.package) ||
		typeof record.version !== "string" ||
		!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u.test(record.version) ||
		!["critical", "high", "info", "low", "moderate"].includes(record.severity)
	) {
		fail("INVALID_AUDIT_RECEIPT");
	}
	return record;
}

function compareAuditRecords(left, right) {
	return compareText(JSON.stringify(left), JSON.stringify(right));
}

function validateNormalizedAlert(value) {
	if (!isRecord(value)) fail("INVALID_DEPENDABOT_FIXTURE");
	assertExactKeys(value, [
		"autoDismissedAt",
		"createdAt",
		"dismissal",
		"ecosystem",
		"fixedAt",
		"ghsa",
		"manifest",
		"number",
		"package",
		"relationship",
		"scope",
		"severity",
		"state",
		"updatedAt",
	]);
	if (
		!Number.isSafeInteger(value.number) ||
		value.number < 1 ||
		!["auto_dismissed", "dismissed", "fixed", "open"].includes(value.state) ||
		value.ecosystem !== "npm" ||
		typeof value.package !== "string" ||
		!PACKAGE_PATTERN.test(value.package) ||
		typeof value.manifest !== "string" ||
		!isSafeManifest(value.manifest) ||
		!["direct", "transitive"].includes(value.relationship) ||
		!["development", "runtime"].includes(value.scope) ||
		typeof value.ghsa !== "string" ||
		!GHSA_PATTERN.test(value.ghsa) ||
		!["critical", "high", "low", "medium"].includes(value.severity) ||
		!isTimestamp(value.createdAt) ||
		!isTimestamp(value.updatedAt) ||
		!nullableTimestamp(value.fixedAt) ||
		!nullableTimestamp(value.autoDismissedAt) ||
		!isNormalizedDismissal(value.dismissal)
	) {
		fail("INVALID_DEPENDABOT_FIXTURE");
	}
	if (
		(value.state === "open" &&
			(value.fixedAt !== null ||
				value.dismissal !== null ||
				value.autoDismissedAt !== null)) ||
		(value.state === "fixed" &&
			(value.fixedAt === null || value.dismissal !== null)) ||
		(value.state === "dismissed" && value.dismissal === null) ||
		(value.state === "auto_dismissed" && value.autoDismissedAt === null)
	) {
		fail("INVALID_DEPENDABOT_FIXTURE");
	}
	return value;
}

function nullableTimestamp(value) {
	return value === null || isTimestamp(value);
}

function isNormalizedDismissal(value) {
	if (value === null) return true;
	if (!isRecord(value)) return false;
	try {
		assertExactKeys(value, ["at", "by", "comment", "reason"]);
	} catch {
		return false;
	}
	return (
		isTimestamp(value.at) &&
		typeof value.by === "string" &&
		/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value.by) &&
		typeof value.comment === "string" &&
		Buffer.byteLength(value.comment, "utf8") <= 4096 &&
		typeof value.reason === "string" &&
		/^[a-z_]{1,64}$/u.test(value.reason)
	);
}

function isDigest(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function safeClone(value) {
	try {
		return JSON.parse(canonicalJsonBytes(value).toString("utf8"));
	} catch {
		fail("INVALID_DEPENDABOT_VALUE");
	}
}

function assertExactKeys(value, expected) {
	if (!isRecord(value)) fail("INVALID_DEPENDABOT_FIXTURE");
	const actual = Object.keys(value).sort(compareText);
	const wanted = [...expected].sort(compareText);
	if (JSON.stringify(actual) !== JSON.stringify(wanted))
		fail("INVALID_DEPENDABOT_FIXTURE");
}

function isTimestamp(value) {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return false;
	try {
		return new Date(timestamp).toISOString().replace(".000Z", "Z") === value;
	} catch {
		return false;
	}
}

function isSafeManifest(value) {
	return (
		value.length > 0 &&
		value.length <= 1024 &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		value
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha(value) {
	return typeof value === "string" && SHA_PATTERN.test(value);
}

function compareText(left, right) {
	return left === right ? 0 : left < right ? -1 : 1;
}
