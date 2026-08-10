import { createHash } from "node:crypto";

import { createHttpGet } from "../release/adapters/http.mjs";
import {
	canonicalJsonBytes,
	consumeEvidenceBytes,
	EvidenceError,
	reserveEvidenceRequest,
} from "./github-evidence.mjs";

export const INVENTORY_PACKAGES = Object.freeze([
	"@dawn-ai/ag-ui",
	"@dawn-ai/cli",
	"@dawn-ai/config-biome",
	"@dawn-ai/config-typescript",
	"@dawn-ai/core",
	"@dawn-ai/devkit",
	"@dawn-ai/evals",
	"@dawn-ai/inspector",
	"@dawn-ai/langchain",
	"@dawn-ai/langgraph",
	"@dawn-ai/memory",
	"@dawn-ai/memory-pgvector",
	"@dawn-ai/permissions",
	"@dawn-ai/postgres-storage",
	"@dawn-ai/sandbox",
	"@dawn-ai/sdk",
	"@dawn-ai/sqlite-storage",
	"@dawn-ai/testing",
	"@dawn-ai/vite-plugin",
	"@dawn-ai/workspace",
	"create-dawn-ai-app",
]);

export const RELEASE_WORKFLOW = Object.freeze({
	id: 260503756,
	path: ".github/workflows/release.yml",
});
export const CHART_WORKFLOW = Object.freeze({
	id: 309127405,
	path: ".github/workflows/publish-chart.yml",
});

const RELEASE_INCIDENTS = Object.freeze([
	[31356780088, "3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb", 1, 20],
	[31356940801, "b6adaa982b25adf5fac61733a13ac65320c70bcd", 0, 0],
	[31357014583, "cfa55478cf8e35dc8a00ae7041c0c12479fda2d9", 1, 0],
]);
const CHART_RUN = Object.freeze({
	headSha: "3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb",
	id: 31356780047,
});
const CHART_FACTS = Object.freeze({
	"publish (dawn-app)": "dawn-app 0.1.0 already published, skipping",
	"publish (dawn-sandbox-infra)":
		"dawn-sandbox-infra 0.1.2 already published, skipping",
});
const RELEASE_JOB_IDS = Object.freeze([93357835724, null, 93359214159]);
const CHART_JOB_IDS = Object.freeze({
	"publish (dawn-app)": 93357835326,
	"publish (dawn-sandbox-infra)": 93357835324,
});
const FIRST_RELEASE_STEPS = Object.freeze([
	[1, "Set up job", "success"],
	[2, "Checkout", "success"],
	[3, "Setup pnpm", "success"],
	[4, "Setup Node.js", "success"],
	[5, "Install", "success"],
	[6, "Validate Release Candidate", "cancelled"],
	[7, "Setup Node.js for publishing", "skipped"],
	[8, "Create Release Pull Request or Publish", "skipped"],
	[9, "Attest release tarballs", "skipped"],
	[10, "Upload signed release assets", "skipped"],
	[11, "Backfill tags/releases for bootstrapped packages", "skipped"],
	[12, "Read published version", "skipped"],
	[13, "Verify published TypeScript tooling", "skipped"],
	[14, "Smoke published TypeScript tooling", "skipped"],
	[15, "Verify published Docker sandbox", "skipped"],
	[16, "Smoke published Docker sandbox PID recovery", "skipped"],
	[30, "Post Setup Node.js", "skipped"],
	[31, "Post Setup pnpm", "success"],
	[32, "Post Checkout", "success"],
	[33, "Complete job", "success"],
]);
const NPM_ORIGIN = "https://registry.npmjs.org";
const NPM_RESPONSE_LIMIT = 4 * 1024 * 1024;

function fail(code) {
	throw new EvidenceError(code);
}

export function analyzeChartLog(log, expectedFact) {
	if (
		typeof log !== "string" ||
		Buffer.byteLength(log, "utf8") > 1024 * 1024 ||
		!Object.values(CHART_FACTS).includes(expectedFact)
	) {
		fail("INVALID_CHART_LOG");
	}
	let occurrences = 0;
	let offset = 0;
	offset = log.indexOf(expectedFact, offset);
	while (offset !== -1) {
		occurrences += 1;
		offset += expectedFact.length;
		offset = log.indexOf(expectedFact, offset);
	}
	if (occurrences !== 1) fail("CHART_NOOP_UNPROVABLE");
	return {
		digest: createHash("sha256").update(log, "utf8").digest("hex"),
		noOp: true,
	};
}

export async function collectPublicationContainment({
	budget,
	currentVersion,
	expectedDefaultSha,
	github,
	inventory,
	npmRequest = createDefaultNpmRequest(),
	repo,
	sourceSha,
	targetVersion,
}) {
	if (
		repo !== "cacheplane/dawnai" ||
		!isSha(sourceSha) ||
		!isSha(expectedDefaultSha) ||
		currentVersion !== "0.8.21" ||
		targetVersion !== "0.8.22" ||
		budget === null ||
		typeof budget !== "object" ||
		github === null ||
		typeof github !== "object" ||
		typeof github.object !== "function" ||
		typeof github.list !== "function" ||
		typeof github.text !== "function" ||
		typeof npmRequest !== "function"
	) {
		fail("INVALID_PUBLICATION_REQUEST");
	}
	const normalizedInventory = normalizeInventoryInput(
		inventory,
		sourceSha,
		currentVersion,
	);
	const defaultCommit = await github.object("commits/main");
	if (defaultCommit.sha !== expectedDefaultSha) fail("DEFAULT_HEAD_MISMATCH");

	const [releaseWorkflowObject, chartWorkflowObject] = await Promise.all([
		github.object(`actions/workflows/${RELEASE_WORKFLOW.id}`),
		github.object(`actions/workflows/${CHART_WORKFLOW.id}`),
	]);
	assertWorkflowObject(releaseWorkflowObject, RELEASE_WORKFLOW);
	assertWorkflowObject(chartWorkflowObject, CHART_WORKFLOW);

	const [releaseRuns, chartRuns] = await Promise.all([
		github.list(`actions/workflows/${RELEASE_WORKFLOW.id}/runs?per_page=100`, {
			field: "workflow_runs",
			totalCount: true,
			uniqueKey: "id",
		}),
		github.list(`actions/workflows/${CHART_WORKFLOW.id}/runs?per_page=100`, {
			field: "workflow_runs",
			totalCount: true,
			uniqueKey: "id",
		}),
	]);
	const workflowEvidence = {
		chart: summarizeWorkflowRuns(
			chartWorkflowObject,
			chartRuns,
			CHART_WORKFLOW,
			sourceSha,
		),
		release: summarizeWorkflowRuns(
			releaseWorkflowObject,
			releaseRuns,
			RELEASE_WORKFLOW,
			sourceSha,
		),
	};

	const [tagRefs, releases, artifacts] = await Promise.all([
		github.list("git/matching-refs/tags/?per_page=100", { uniqueKey: "ref" }),
		github.list("releases?per_page=100", { uniqueKey: "id" }),
		github.list("actions/artifacts?per_page=100", {
			field: "artifacts",
			totalCount: true,
			uniqueKey: "id",
		}),
	]);
	const candidateAbsence = {
		artifacts: !artifacts.some((artifact) =>
			candidateArtifact(artifact?.name, targetVersion),
		),
		releases: !releases.some((release) =>
			candidateRelease(release, targetVersion),
		),
		tags: !tagRefs.some((tag) => candidateTag(tag?.ref, targetVersion)),
	};

	const releaseIncidents = [];
	for (const [index, expected] of RELEASE_INCIDENTS.entries()) {
		const history = releaseRuns.find((run) => run.id === expected[0]);
		if (history === undefined) fail("RELEASE_INCIDENT_MISSING_FROM_HISTORY");
		releaseIncidents.push(
			await collectReleaseIncident(github, history, expected, index),
		);
	}
	const chartHistory = chartRuns.find((run) => run.id === CHART_RUN.id);
	if (chartHistory === undefined) fail("CHART_INCIDENT_MISSING_FROM_HISTORY");
	const chartIncident = await collectChartIncident(github, chartHistory);
	const npm = await collectNpmAbsence({
		budget,
		currentVersion,
		npmRequest,
		packages: normalizedInventory.packages,
		targetVersion,
	});
	const closingDefaultCommit = await github.object("commits/main");
	if (closingDefaultCommit.sha !== expectedDefaultSha)
		fail("CLOSING_DEFAULT_HEAD_DRIFT");
	const closingReleaseWorkflow = await github.object(
		`actions/workflows/${RELEASE_WORKFLOW.id}`,
	);
	const closingChartWorkflow = await github.object(
		`actions/workflows/${CHART_WORKFLOW.id}`,
	);
	assertWorkflowObject(closingReleaseWorkflow, RELEASE_WORKFLOW);
	assertWorkflowObject(closingChartWorkflow, CHART_WORKFLOW);
	const closingReleaseRuns = await github.list(
		`actions/workflows/${RELEASE_WORKFLOW.id}/runs?per_page=100`,
		{ field: "workflow_runs", totalCount: true, uniqueKey: "id" },
	);
	const closingChartRuns = await github.list(
		`actions/workflows/${CHART_WORKFLOW.id}/runs?per_page=100`,
		{ field: "workflow_runs", totalCount: true, uniqueKey: "id" },
	);
	const closingWorkflowEvidence = {
		chart: summarizeWorkflowRuns(
			closingChartWorkflow,
			closingChartRuns,
			CHART_WORKFLOW,
			sourceSha,
		),
		release: summarizeWorkflowRuns(
			closingReleaseWorkflow,
			closingReleaseRuns,
			RELEASE_WORKFLOW,
			sourceSha,
		),
	};
	if (
		canonicalJsonBytes(closingWorkflowEvidence).compare(
			canonicalJsonBytes(workflowEvidence),
		) !== 0 ||
		canonicalRunHistory(closingReleaseRuns).compare(
			canonicalRunHistory(releaseRuns),
		) !== 0 ||
		canonicalRunHistory(closingChartRuns).compare(
			canonicalRunHistory(chartRuns),
		) !== 0
	) {
		fail("CLOSING_WORKFLOW_DRIFT");
	}
	const snapshot = {
		candidateAbsence,
		defaultSha: expectedDefaultSha,
		incidents: { chart: chartIncident, release: releaseIncidents },
		inventory: {
			currentVersion,
			packages: normalizedInventory.packages,
			ref: normalizedInventory.ref,
			sourceSha,
			targetVersion,
		},
		npm,
		repository: repo,
		schemaVersion: 1,
		sourceSha,
		workflows: workflowEvidence,
	};
	return verifyPublicationSnapshot(snapshot, { expectedDefaultSha });
}

function normalizeInventoryInput(value, sourceSha, currentVersion) {
	const inventory = safeClone(value);
	assertExactKeys(inventory, ["packages", "ref", "sourceSha", "version"]);
	if (
		inventory.ref !== "HEAD" ||
		inventory.sourceSha !== sourceSha ||
		inventory.version !== currentVersion ||
		!Array.isArray(inventory.packages) ||
		JSON.stringify(inventory.packages) !== JSON.stringify(INVENTORY_PACKAGES)
	) {
		fail("INVENTORY_IDENTITY_MISMATCH");
	}
	return inventory;
}

function assertWorkflowObject(value, expected) {
	if (
		!isRecord(value) ||
		value.id !== expected.id ||
		value.path !== expected.path ||
		value.state !== "disabled_manually"
	) {
		fail("WORKFLOW_IDENTITY_MISMATCH");
	}
}

function summarizeWorkflowRuns(workflow, runs, expected, sourceSha) {
	if (!Array.isArray(runs) || runs.length < 1) fail("WORKFLOW_HISTORY_EMPTY");
	let completeRuns = 0;
	let nonCompleted = 0;
	let sourceShaRuns = 0;
	for (const run of runs) {
		if (
			!isRecord(run) ||
			run.workflow_id !== expected.id ||
			run.path !== expected.path
		) {
			fail("WORKFLOW_RUN_IDENTITY_MISMATCH");
		}
		if (run.status === "completed") completeRuns += 1;
		else nonCompleted += 1;
		if (run.head_sha === sourceSha) sourceShaRuns += 1;
	}
	return {
		completeRuns,
		id: workflow.id,
		nonCompleted,
		path: workflow.path,
		retrievedRuns: runs.length,
		sourceShaRuns,
		state: workflow.state,
		totalRuns: runs.length,
	};
}

function canonicalRunHistory(runs) {
	return canonicalJsonBytes(
		runs.map((run) => ({
			conclusion: run.conclusion,
			event: run.event,
			headSha: run.head_sha,
			id: run.id,
			name: run.name,
			path: run.path,
			runAttempt: run.run_attempt,
			status: run.status,
			workflowId: run.workflow_id,
		})),
	);
}

async function collectReleaseIncident(github, history, expected, index) {
	const run = await github.object(`actions/runs/${expected[0]}`);
	assertRunIdentity(run, {
		conclusion: "cancelled",
		headSha: expected[1],
		id: expected[0],
		name: "Release",
		path: RELEASE_WORKFLOW.path,
		workflowId: RELEASE_WORKFLOW.id,
	});
	assertSameRunIdentity(history, run);
	const jobs = await github.list(
		`actions/runs/${expected[0]}/jobs?per_page=100`,
		{
			field: "jobs",
			totalCount: true,
			uniqueKey: "id",
		},
	);
	if (jobs.length !== expected[2]) fail("RELEASE_INCIDENT_JOB_MISMATCH");
	let steps = 0;
	if (index === 0) {
		const job = jobs[0];
		if (
			!isRecord(job) ||
			job.id !== RELEASE_JOB_IDS[index] ||
			job.name !== "release" ||
			job.status !== "completed" ||
			job.conclusion !== "cancelled" ||
			!Array.isArray(job.steps) ||
			job.steps.length !== FIRST_RELEASE_STEPS.length
		) {
			fail("RELEASE_INCIDENT_JOB_MISMATCH");
		}
		steps = job.steps.length;
		for (const [stepIndex, expectedStep] of FIRST_RELEASE_STEPS.entries()) {
			const step = job.steps[stepIndex];
			if (
				!isRecord(step) ||
				step.number !== expectedStep[0] ||
				step.name !== expectedStep[1] ||
				step.status !== "completed" ||
				step.conclusion !== expectedStep[2]
			) {
				fail("RELEASE_INCIDENT_STEP_MISMATCH");
			}
		}
	} else if (index === 2) {
		const job = jobs[0];
		if (
			!isRecord(job) ||
			job.id !== RELEASE_JOB_IDS[index] ||
			job.name !== "release" ||
			job.status !== "completed" ||
			job.conclusion !== "cancelled" ||
			!Array.isArray(job.steps) ||
			job.steps.length !== 0
		) {
			fail("RELEASE_INCIDENT_JOB_MISMATCH");
		}
	}
	if (steps !== expected[3]) fail("RELEASE_INCIDENT_STEP_MISMATCH");
	return {
		conclusion: "cancelled",
		headSha: expected[1],
		id: expected[0],
		jobs: jobs.length,
		publishStepsSkipped: true,
		status: "completed",
		steps,
	};
}

async function collectChartIncident(github, history) {
	const run = await github.object(`actions/runs/${CHART_RUN.id}`);
	assertRunIdentity(run, {
		conclusion: "success",
		headSha: CHART_RUN.headSha,
		id: CHART_RUN.id,
		name: "Publish Chart",
		path: CHART_WORKFLOW.path,
		workflowId: CHART_WORKFLOW.id,
	});
	assertSameRunIdentity(history, run);
	const jobs = await github.list(
		`actions/runs/${CHART_RUN.id}/jobs?per_page=100`,
		{
			field: "jobs",
			totalCount: true,
			uniqueKey: "id",
		},
	);
	if (jobs.length !== 2) fail("CHART_INCIDENT_JOB_MISMATCH");
	const normalizedJobs = [];
	for (const job of jobs) {
		if (
			!isRecord(job) ||
			typeof job.name !== "string" ||
			!Object.hasOwn(CHART_JOB_IDS, job.name) ||
			job.id !== CHART_JOB_IDS[job.name] ||
			job.status !== "completed" ||
			job.conclusion !== "success"
		) {
			fail("CHART_INCIDENT_JOB_MISMATCH");
		}
		const log = await github.text(`actions/jobs/${job.id}/logs`);
		normalizedJobs.push({
			conclusion: "success",
			...analyzeChartLog(log, CHART_FACTS[job.name]),
			name: job.name,
		});
	}
	normalizedJobs.sort((left, right) => compareText(left.name, right.name));
	return {
		headSha: CHART_RUN.headSha,
		id: CHART_RUN.id,
		jobs: normalizedJobs,
		status: "completed",
	};
}

function assertRunIdentity(run, expected) {
	if (
		!isRecord(run) ||
		run.id !== expected.id ||
		run.workflow_id !== expected.workflowId ||
		run.path !== expected.path ||
		run.name !== expected.name ||
		run.event !== "push" ||
		run.status !== "completed" ||
		run.conclusion !== expected.conclusion ||
		run.head_sha !== expected.headSha ||
		run.run_attempt !== 1
	) {
		fail("INCIDENT_RUN_IDENTITY_MISMATCH");
	}
}

function assertSameRunIdentity(history, run) {
	for (const key of [
		"id",
		"workflow_id",
		"path",
		"name",
		"event",
		"status",
		"conclusion",
		"head_sha",
		"run_attempt",
	]) {
		if (history[key] !== run[key]) fail("INCIDENT_HISTORY_DRIFT");
	}
}

async function collectNpmAbsence({
	budget,
	currentVersion,
	npmRequest,
	packages,
	targetVersion,
}) {
	const records = [];
	const requested = new Set();
	for (const name of packages) {
		const versionUrl = `${NPM_ORIGIN}/${encodeURIComponent(name)}/${encodeURIComponent(targetVersion)}`;
		const packumentUrl = `${NPM_ORIGIN}/${encodeURIComponent(name)}`;
		const attestationUrl = `${NPM_ORIGIN}/-/npm/v1/attestations/${npmAttestationName(name)}@${encodeURIComponent(targetVersion)}`;
		const targetDocument = await npmJsonRequest({
			budget,
			npmRequest,
			requested,
			url: versionUrl,
		});
		if (
			targetDocument.status !== "HTTP_ERROR" ||
			targetDocument.httpStatus !== 404 ||
			targetDocument.code !== null ||
			targetDocument.body !== `version not found: ${targetVersion}`
		) {
			fail("NPM_TARGET_DOCUMENT_NOT_ABSENT");
		}
		const packument = await npmJsonRequest({
			bodyProjection: "packument",
			budget,
			npmRequest,
			requested,
			url: packumentUrl,
		});
		if (
			packument.status !== "OK" ||
			packument.httpStatus !== 200 ||
			packument.code !== null ||
			!isRecord(packument.body) ||
			packument.body.name !== name ||
			!isRecord(packument.body["dist-tags"]) ||
			packument.body["dist-tags"].latest !== currentVersion
		) {
			fail("NPM_PACKUMENT_IDENTITY_MISMATCH");
		}
		const attestation = await npmJsonRequest({
			budget,
			npmRequest,
			requested,
			url: attestationUrl,
		});
		if (
			attestation.status !== "HTTP_ERROR" ||
			attestation.httpStatus !== 404 ||
			attestation.code !== null ||
			!isRecord(attestation.body) ||
			JSON.stringify(attestation.body) !==
				JSON.stringify({ error: "Not found" })
		) {
			fail("NPM_TARGET_ATTESTATION_NOT_ABSENT");
		}
		records.push({
			latest: currentVersion,
			name,
			packumentName: name,
			targetAttestationAbsent: true,
			targetDocumentAbsent: true,
		});
	}
	if (requested.size !== 63 || records.length !== INVENTORY_PACKAGES.length) {
		fail("NPM_REQUEST_SET_MISMATCH");
	}
	return { packages: records, requestCount: requested.size };
}

async function npmJsonRequest({
	bodyProjection = "complete",
	budget,
	npmRequest,
	requested,
	url,
}) {
	if (requested.has(url)) fail("DUPLICATE_NPM_REQUEST");
	requested.add(url);
	const limits = reserveEvidenceRequest(budget);
	let raw;
	try {
		raw = await npmRequest({
			maxResponseBytes: Math.min(limits.maxBytes, NPM_RESPONSE_LIMIT),
			timeoutMs: limits.timeoutMs,
			url,
		});
	} catch {
		fail("NPM_TRANSPORT_FAILED");
	}
	const response = projectNpmResponse(raw, bodyProjection);
	if (!Number.isSafeInteger(response.bodyBytes) || response.bodyBytes < 0) {
		fail("MALFORMED_NPM_RESPONSE");
	}
	consumeEvidenceBytes(budget, response.bodyBytes);
	return response;
}

function projectNpmResponse(raw, bodyProjection) {
	const body = ownDataProperty(raw, "body");
	return safeClone({
		body: bodyProjection === "packument" ? projectPackumentBody(body) : body,
		bodyBytes: ownDataProperty(raw, "bodyBytes"),
		code: ownDataProperty(raw, "code"),
		httpStatus: ownDataProperty(raw, "httpStatus"),
		status: ownDataProperty(raw, "status"),
	});
}

function projectPackumentBody(body) {
	const tags = ownDataProperty(body, "dist-tags");
	return {
		"dist-tags": { latest: ownDataProperty(tags, "latest") },
		name: ownDataProperty(body, "name"),
	};
}

function ownDataProperty(value, key) {
	let prototype;
	let descriptor;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptor = Object.getOwnPropertyDescriptor(value, key);
	} catch {
		fail("MALFORMED_NPM_RESPONSE");
	}
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(prototype !== Object.prototype && prototype !== null) ||
		descriptor === undefined ||
		!("value" in descriptor) ||
		descriptor.enumerable !== true
	) {
		fail("MALFORMED_NPM_RESPONSE");
	}
	return descriptor.value;
}

function createDefaultNpmRequest() {
	const http = createHttpGet({
		maxResponseBytes: NPM_RESPONSE_LIMIT,
		timeoutMs: 300_000,
	});
	return ({ maxResponseBytes, timeoutMs, url }) =>
		http.getJson({
			headers: { Accept: "application/json" },
			maxResponseBytes,
			timeoutMs,
			url,
		});
}

function npmAttestationName(name) {
	const slash = name.indexOf("/");
	return slash === -1
		? encodeURIComponent(name)
		: `${name.slice(0, slash)}%2f${name.slice(slash + 1)}`;
}

function candidateTag(ref, version) {
	return candidateVersionIdentities(version).has(
		typeof ref === "string" && ref.startsWith("refs/tags/")
			? ref.slice("refs/tags/".length)
			: "",
	);
}

function candidateRelease(release, version) {
	const identities = candidateVersionIdentities(version);
	return (
		isRecord(release) &&
		[release.tag_name, release.name].some((value) => identities.has(value))
	);
}

function candidateVersionIdentities(version) {
	return new Set([
		version,
		`v${version}`,
		...INVENTORY_PACKAGES.map((name) => `${name}@${version}`),
	]);
}

function candidateArtifact(name, version) {
	return (
		typeof name === "string" &&
		[...candidateVersionIdentities(version)].some((identity) =>
			containsBoundedIdentity(name, identity),
		)
	);
}

function containsBoundedIdentity(value, identity) {
	let offset = value.indexOf(identity);
	while (offset !== -1) {
		const before = offset === 0 ? "" : value[offset - 1];
		const end = offset + identity.length;
		const after = end === value.length ? "" : value[end];
		if (!/[0-9A-Za-z]/u.test(before) && !/[0-9A-Za-z]/u.test(after)) {
			return true;
		}
		offset = value.indexOf(identity, offset + 1);
	}
	return false;
}

export function verifyPublicationSnapshot(value, { expectedDefaultSha } = {}) {
	const snapshot = safeClone(value);
	assertExactKeys(snapshot, [
		"candidateAbsence",
		"defaultSha",
		"incidents",
		"inventory",
		"npm",
		"repository",
		"schemaVersion",
		"sourceSha",
		"workflows",
	]);
	if (
		snapshot.schemaVersion !== 1 ||
		snapshot.repository !== "cacheplane/dawnai" ||
		!isSha(snapshot.sourceSha) ||
		!isSha(snapshot.defaultSha) ||
		!isSha(expectedDefaultSha) ||
		snapshot.defaultSha !== expectedDefaultSha
	) {
		fail("INVALID_PUBLICATION_SNAPSHOT");
	}
	verifyInventory(snapshot.inventory, snapshot.sourceSha);
	verifyWorkflow(snapshot.workflows?.release, RELEASE_WORKFLOW);
	verifyWorkflow(snapshot.workflows?.chart, CHART_WORKFLOW);
	verifyNpm(snapshot.npm);
	assertExactKeys(snapshot.candidateAbsence, ["artifacts", "releases", "tags"]);
	if (
		Object.values(snapshot.candidateAbsence).some((value) => value !== true)
	) {
		fail("PUBLICATION_CANDIDATE_PRESENT");
	}
	verifyIncidents(snapshot.incidents);
	return snapshot;
}

function verifyInventory(inventory, sourceSha) {
	assertExactKeys(inventory, [
		"currentVersion",
		"packages",
		"ref",
		"sourceSha",
		"targetVersion",
	]);
	if (
		inventory.currentVersion !== "0.8.21" ||
		inventory.targetVersion !== "0.8.22" ||
		inventory.ref !== "HEAD" ||
		inventory.sourceSha !== sourceSha ||
		!Array.isArray(inventory.packages) ||
		JSON.stringify(inventory.packages) !== JSON.stringify(INVENTORY_PACKAGES)
	) {
		fail("INVENTORY_IDENTITY_MISMATCH");
	}
}

function verifyWorkflow(workflow, expected) {
	assertExactKeys(workflow, [
		"completeRuns",
		"id",
		"nonCompleted",
		"path",
		"retrievedRuns",
		"sourceShaRuns",
		"state",
		"totalRuns",
	]);
	if (
		workflow.id !== expected.id ||
		workflow.path !== expected.path ||
		workflow.state !== "disabled_manually" ||
		!Number.isSafeInteger(workflow.totalRuns) ||
		workflow.totalRuns < 1 ||
		workflow.retrievedRuns !== workflow.totalRuns ||
		workflow.completeRuns !== workflow.totalRuns ||
		workflow.nonCompleted !== 0 ||
		workflow.sourceShaRuns !== 0
	) {
		fail("WORKFLOW_CONTAINMENT_UNPROVABLE");
	}
}

function verifyNpm(npm) {
	assertExactKeys(npm, ["packages", "requestCount"]);
	if (npm.requestCount !== 63 || !Array.isArray(npm.packages)) {
		fail("NPM_CONTAINMENT_UNPROVABLE");
	}
	const seen = new Set();
	for (const record of npm.packages) {
		assertExactKeys(record, [
			"latest",
			"name",
			"packumentName",
			"targetAttestationAbsent",
			"targetDocumentAbsent",
		]);
		if (
			typeof record.name !== "string" ||
			seen.has(record.name) ||
			record.packumentName !== record.name ||
			record.latest !== "0.8.21" ||
			record.targetDocumentAbsent !== true ||
			record.targetAttestationAbsent !== true
		) {
			fail("NPM_CONTAINMENT_UNPROVABLE");
		}
		seen.add(record.name);
	}
	if (
		JSON.stringify([...seen].sort(compareText)) !==
		JSON.stringify(INVENTORY_PACKAGES)
	) {
		fail("NPM_INVENTORY_MISMATCH");
	}
}

function verifyIncidents(incidents) {
	assertExactKeys(incidents, ["chart", "release"]);
	if (
		!Array.isArray(incidents.release) ||
		incidents.release.length !== RELEASE_INCIDENTS.length
	) {
		fail("RELEASE_INCIDENT_MISMATCH");
	}
	const seen = new Set();
	for (const [index, expected] of RELEASE_INCIDENTS.entries()) {
		const record = incidents.release[index];
		assertExactKeys(record, [
			"conclusion",
			"headSha",
			"id",
			"jobs",
			"publishStepsSkipped",
			"status",
			"steps",
		]);
		if (
			seen.has(record.id) ||
			record.id !== expected[0] ||
			record.headSha !== expected[1] ||
			record.jobs !== expected[2] ||
			record.steps !== expected[3] ||
			record.status !== "completed" ||
			record.conclusion !== "cancelled" ||
			record.publishStepsSkipped !== true
		) {
			fail("RELEASE_INCIDENT_MISMATCH");
		}
		seen.add(record.id);
	}
	const chart = incidents.chart;
	assertExactKeys(chart, ["headSha", "id", "jobs", "status"]);
	if (
		chart.id !== CHART_RUN.id ||
		chart.headSha !== CHART_RUN.headSha ||
		chart.status !== "completed" ||
		!Array.isArray(chart.jobs) ||
		chart.jobs.length !== 2
	) {
		fail("CHART_INCIDENT_MISMATCH");
	}
	const chartNames = new Set();
	for (const job of chart.jobs) {
		assertExactKeys(job, ["conclusion", "digest", "name", "noOp"]);
		if (
			typeof job.name !== "string" ||
			chartNames.has(job.name) ||
			!Object.hasOwn(CHART_FACTS, job.name) ||
			job.conclusion !== "success" ||
			job.noOp !== true ||
			typeof job.digest !== "string" ||
			!/^[0-9a-f]{64}$/u.test(job.digest)
		) {
			fail("CHART_INCIDENT_MISMATCH");
		}
		chartNames.add(job.name);
	}
	if (
		JSON.stringify([...chartNames].sort(compareText)) !==
		JSON.stringify(Object.keys(CHART_FACTS).sort(compareText))
	) {
		fail("CHART_INCIDENT_MISMATCH");
	}
}

function safeClone(value) {
	try {
		return JSON.parse(canonicalJsonBytes(value).toString("utf8"));
	} catch {
		fail("INVALID_PUBLICATION_SNAPSHOT");
	}
}

function assertExactKeys(value, expected) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail("INVALID_PUBLICATION_SNAPSHOT");
	}
	const actual = Object.keys(value).sort(compareText);
	const wanted = [...expected].sort(compareText);
	if (JSON.stringify(actual) !== JSON.stringify(wanted))
		fail("INVALID_PUBLICATION_SNAPSHOT");
}

function isSha(value) {
	return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left, right) {
	return left === right ? 0 : left < right ? -1 : 1;
}
