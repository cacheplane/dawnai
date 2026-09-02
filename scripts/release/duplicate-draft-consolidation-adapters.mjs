import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual, types as utilTypes } from "node:util";

import {
	normalizeAdapterEnvelope,
	snapshotJson,
} from "./adapter-normalize.mjs";
import { createGitHubReader as defaultCreateGitHubReader } from "./adapters/github.mjs";
import { createHttpGet } from "./adapters/http.mjs";
import { createNpmReader as defaultCreateNpmReader } from "./adapters/npm.mjs";
import { createCliAttestationVerifier as defaultCreateCliAttestationVerifier } from "./artifact-store.mjs";
import {
	assertEvidenceEqualsProposal,
	captureDirectTargetRead,
} from "./duplicate-draft-consolidation-evidence.mjs";
import { readPrivateEnvelope } from "./duplicate-draft-consolidation-files.mjs";
import {
	appendJournalEvent,
	deriveConsolidationState,
	parseConsolidationJournal,
} from "./duplicate-draft-consolidation-journal.mjs";
import {
	classifyConsolidationReleases,
	consolidationStageRule,
} from "./duplicate-draft-consolidation-release-classifier.mjs";
import {
	canonicalConsolidationEnvelopeBytes,
	canonicalRecordSha256,
	createConsolidationEnvelope,
	DUPLICATE_DRAFT_CONSOLIDATION_LIMITS,
	parseConsolidationEnvelope,
} from "./duplicate-draft-consolidation-schema.mjs";
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs";
import { createOwnerPreflightAdapters as defaultCreateOwnerPreflightAdapters } from "./preflight-owner-adapters.mjs";
import { createReleasePreparationRunner as defaultCreateReleasePreparationRunner } from "./process-runner.mjs";

const REPOSITORY = "cacheplane/dawnai";
const OWNER = "cacheplane";
const REPO = "dawnai";
const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const JSON_ACCEPT = "application/vnd.github+json";
const USER_AGENT = "dawn-duplicate-draft-consolidation/1";
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const APPROVED_TAG = "v0.8.22";
const SURVIVOR_ID = "379991871";
const DUPLICATE_IDS = Object.freeze(["379982100", "379986168"]);
const MAX_PAGES = 100;
const MAX_RECORDS = 10_000;
const MAX_TOKEN_BYTES = 4_096;
const MAX_DIRECT_JSON_BYTES = 8 * 1024 * 1024;
const DELETE_TIMEOUT_MS = 15_000;
const MAX_DELETE_TIMEOUT_MS = 60_000;
const MAX_LINK_HEADER_BYTES = 16_384;
const TIMESTAMP_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ID_PATTERN = /^[1-9][0-9]*$/u;
const NONTERMINAL_STATUS_ORDER = Object.freeze([
	"in_progress",
	"pending",
	"queued",
	"requested",
	"waiting",
]);
const PAGINATION_RELATIONS = new Set(["first", "last", "next", "prev"]);
const ROOT_OPTION_FIELDS = new Set([
	"cwd",
	"token",
	"environment",
	"dependencies",
]);
const DEPENDENCY_FIELDS = new Set([
	"fetchImpl",
	"run",
	"now",
	"createGitHubReader",
	"createOwnerPreflightAdapters",
	"createNpmReader",
	"createCliAttestationVerifier",
	"createReleasePreparationRunner",
]);
const DELETE_OPTION_FIELDS = new Set([
	"repository",
	"apiOrigin",
	"survivorId",
	"duplicateIds",
	"token",
	"fetchImpl",
	"timeoutMs",
	"now",
]);
const DELETE_CALL_FIELDS = new Set(["releaseId", "signal", "permit"]);
const SAFE_ENVIRONMENT_NAMES = new Set([
	"CI",
	"COLORTERM",
	"COMSPEC",
	"FORCE_COLOR",
	"GITHUB_ACTIONS",
	"HOME",
	"LANG",
	"LC_ALL",
	"PATH",
	"Path",
	"PATHEXT",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"TERM",
	"USERPROFILE",
]);
const WINDOWS_SAFE_ENVIRONMENT_NAMES = new Map(
	[...SAFE_ENVIRONMENT_NAMES].map((name) => [
		name.toUpperCase(),
		name === "Path" ? "PATH" : name,
	]),
);
const WINDOWS_ENVIRONMENT_MARKERS = new Set([
	"COMSPEC",
	"PATHEXT",
	"SYSTEMROOT",
]);
const DELETE_WRITER_IDENTITIES = new WeakMap();
const DELETE_PERMIT_BINDINGS = new WeakMap();

export async function createDuplicateDraftConsolidationAdapters(options) {
	const root = exactDataOptions(options, ROOT_OPTION_FIELDS, "Adapter options");
	const cwd = normalizedRoot(required(root, "cwd", "Adapter root"));
	const environment = Object.hasOwn(root, "environment")
		? snapshotEnvironment(root.environment)
		: snapshotRuntimeEnvironment(process.env);
	const dependencies = exactDataOptions(
		Object.hasOwn(root, "dependencies") ? root.dependencies : {},
		DEPENDENCY_FIELDS,
		"Adapter dependencies",
	);
	const fetchImpl = dependencyFunction(dependencies, "fetchImpl", fetch);
	const now = dependencyFunction(dependencies, "now", () =>
		new Date().toISOString(),
	);
	const networkGuard = createNetworkGuard({ cwd, now });
	const guardedFetch = (...args) =>
		networkGuard.runRequest("network transport", () => fetchImpl(...args));
	const createGitHubReader = dependencyFunction(
		dependencies,
		"createGitHubReader",
		defaultCreateGitHubReader,
	);
	const createOwnerPreflightAdapters = dependencyFunction(
		dependencies,
		"createOwnerPreflightAdapters",
		defaultCreateOwnerPreflightAdapters,
	);
	const createNpmReader = dependencyFunction(
		dependencies,
		"createNpmReader",
		defaultCreateNpmReader,
	);
	const createCliAttestationVerifier = dependencyFunction(
		dependencies,
		"createCliAttestationVerifier",
		defaultCreateCliAttestationVerifier,
	);
	const createReleasePreparationRunner = dependencyFunction(
		dependencies,
		"createReleasePreparationRunner",
		defaultCreateReleasePreparationRunner,
	);
	const run = Object.hasOwn(dependencies, "run")
		? dependencies.run
		: createReleasePreparationRunner({
				commandTimeoutMs: 15_000,
				overallTimeoutMs: 10 * 60_000,
				maxOutputBytes: 2 * 1024 * 1024,
			});
	assertFunction(run, "Adapter command runner");

	const safeEnvironment = subprocessEnvironment(environment);
	const injectedToken = Object.hasOwn(root, "token")
		? root.token
		: Object.hasOwn(environment, "GH_TOKEN")
			? environment.GH_TOKEN
			: environment.GITHUB_TOKEN;
	const token =
		injectedToken === undefined
			? await resolveGhToken({ cwd, environment: safeEnvironment, run })
			: canonicalToken(injectedToken);
	const authenticatedFetch = githubFetch(guardedFetch);
	const timestampNow = networkGuard.now;
	const wallNow = () => Date.parse(timestampNow());
	const githubReader = createGitHubReader({
		owner: OWNER,
		repo: REPO,
		token,
		apiOrigin: API_ORIGIN,
		fetchImpl: authenticatedFetch,
		maxPages: MAX_PAGES,
		maxRecords: MAX_RECORDS,
		now: wallNow,
	});
	const rawGithub = createIncidentGitHubReader({
		reader: githubReader,
		fetchImpl: authenticatedFetch,
		token,
		now: timestampNow,
		wallNow,
	});
	const github = guardNetworkFacade(rawGithub, networkGuard, "GitHub reader");
	const ownerRun = (command, args, options) =>
		run(command, args, { ...options, env: { ...safeEnvironment } });
	const ownerAdapters = createOwnerPreflightAdapters({
		cwd,
		environment: safeEnvironment,
		run: ownerRun,
	});
	const rawLocal = createLocalGitReader({
		cwd,
		environment: safeEnvironment,
		run,
		ownerAdapters,
	});
	const local = guardNetworkFacade(rawLocal, networkGuard, "local Git reader");
	const npmReader = createNpmReader({ fetchImpl: guardedFetch });
	const observePackageVersion = bindMethod(
		npmReader,
		"observePackageVersion",
		"npm package-version reader",
	);
	const npm = deepFreeze({
		async observePackageVersion(input) {
			const result = await networkGuard.runRequest(
				"npm package-version reader",
				() => observePackageVersion(input),
				[input],
			);
			return deepFreeze(
				normalizeAdapterEnvelope(containsProxy(result) ? null : result, {
					source: "npm",
					operation: "package-version",
					payloadKey: "package",
				}),
			);
		},
	});
	const runGh = async (args) => {
		if (!safeStringArray(args))
			throw new TypeError("Attestation command arguments are invalid");
		await networkGuard.runRequest("attestation verifier", () =>
			executeExact(run, "gh", args, {
				cwd,
				env: { ...safeEnvironment, GH_TOKEN: token },
			}),
		);
	};
	const attestationVerifier = createCliAttestationVerifier({
		repository: REPOSITORY,
		token,
		runGh,
	});
	const verifyAttestations = bindMethod(
		attestationVerifier,
		"verify",
		"attestation verifier",
	);
	const attestations = deepFreeze({
		async verify(input) {
			return networkGuard.runRequest(
				"attestation verifier",
				async () => normalizeAttestationResult(await verifyAttestations(input)),
				[input],
			);
		},
	});
	const rawWriter = createExactDuplicateDeleteEffect({
		repository: REPOSITORY,
		apiOrigin: API_ORIGIN,
		survivorId: SURVIVOR_ID,
		duplicateIds: DUPLICATE_IDS,
		token,
		fetchImpl: guardedFetch,
		timeoutMs: DELETE_TIMEOUT_MS,
		now: timestampNow,
	});
	networkGuard.bindWriter(rawWriter);
	const writer = deepFreeze({
		async deleteDuplicate(input) {
			const call = exactDataOptions(
				input,
				new Set(["releaseId", "signal", "permit"]),
				"Guarded delete call options",
			);
			const releaseId = canonicalStringId(
				required(call, "releaseId", "Delete Release ID"),
			);
			const permit = required(call, "permit", "Delete permit");
			return networkGuard.runDelete(permit, releaseId, () =>
				rawWriter.deleteDuplicate({
					releaseId,
					permit,
					...(call.signal === undefined ? {} : { signal: call.signal }),
				}),
			);
		},
	});

	const adapters = { local, github, npm, attestations, writer };
	Object.defineProperty(adapters, "authorityEpoch", {
		value: networkGuard.createAuthorityCapability(rawGithub, adapters),
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.freeze(adapters);
	return adapters;
}

export function createExactDuplicateDeleteEffect(options) {
	const value = exactDataOptions(
		options,
		DELETE_OPTION_FIELDS,
		"Delete effect options",
	);
	if (required(value, "repository", "Delete repository") !== REPOSITORY) {
		throw new TypeError(
			"Delete repository is not the approved incident repository",
		);
	}
	if (required(value, "apiOrigin", "Delete API origin") !== API_ORIGIN) {
		throw new TypeError("Delete API origin is not the approved trusted origin");
	}
	const survivorId = canonicalStringId(
		required(value, "survivorId", "Delete survivor ID"),
	);
	if (survivorId !== SURVIVOR_ID) {
		throw new TypeError("Delete survivor is not the approved survivor");
	}
	const duplicateIds = snapshotStringArray(
		required(value, "duplicateIds", "Delete duplicate IDs"),
		"Delete duplicate IDs",
	).map(canonicalStringId);
	if (
		!arraysEqual(duplicateIds, DUPLICATE_IDS) ||
		duplicateIds.includes(survivorId)
	) {
		throw new TypeError(
			"Delete duplicate IDs are not the approved ordered duplicate set",
		);
	}
	const approved = new Set(duplicateIds);
	const token = canonicalToken(required(value, "token", "Delete token"));
	const fetchImpl = requiredFunction(
		value,
		"fetchImpl",
		"Delete fetch implementation",
	);
	const timeoutMs = boundedInteger(
		required(value, "timeoutMs", "Delete timeout"),
		1,
		MAX_DELETE_TIMEOUT_MS,
		"Delete timeout",
	);
	const now = requiredFunction(value, "now", "Delete clock");
	const writerIdentity = Object.freeze({});

	const writer = deepFreeze({
		async deleteDuplicate(input) {
			const call = exactDataOptions(
				input,
				DELETE_CALL_FIELDS,
				"Delete call options",
			);
			const releaseId = canonicalStringId(
				required(call, "releaseId", "Delete Release ID"),
			);
			const permit = required(call, "permit", "Delete permit");
			const permitBinding =
				permit !== null && typeof permit === "object"
					? DELETE_PERMIT_BINDINGS.get(permit)
					: undefined;
			if (
				permitBinding === undefined ||
				permitBinding.writerIdentity !== writerIdentity ||
				permitBinding.releaseId !== releaseId ||
				permitBinding.used ||
				!permitBinding.armed
			) {
				if (permitBinding !== undefined) permitBinding.used = true;
				throw new Error("Delete requires an armed one-use guard-minted permit");
			}
			permitBinding.armed = false;
			permitBinding.used = true;
			if (releaseId === survivorId || !approved.has(releaseId)) {
				throw new TypeError(
					"Release ID is the survivor or is not an approved duplicate",
				);
			}
			const callerSignal = call.signal;
			if (callerSignal !== undefined) assertAbortSignal(callerSignal);
			if (callerSignal?.aborted === true) {
				throw new Error("Duplicate Release deletion was aborted before send");
			}

			const observedAt = canonicalTimestamp(callClock(now));
			if (observedAt > permitBinding.authorityExpiresAt) {
				throw new Error(
					"Delete permit expired at the writer's final pre-send clock",
				);
			}
			const deadline = deleteDeadline(timeoutMs, callerSignal);
			let response;
			try {
				response = await deadline.race(
					fetchImpl(`${API_ORIGIN}/repos/${REPOSITORY}/releases/${releaseId}`, {
						method: "DELETE",
						redirect: "manual",
						headers: githubHeaders(token),
						signal: deadline.signal,
					}),
				);
			} catch {
				deadline.dispose();
				return deleteOutcome("transport-ambiguous", null, observedAt);
			}
			let normalized;
			try {
				normalized = await deleteResponse(response, deadline);
			} finally {
				deadline.dispose();
			}
			if (normalized.status === 204) {
				return deleteOutcome("confirmed-204", 204, observedAt);
			}
			if (normalized.status === 404) {
				return deleteOutcome("response-404-ambiguous", 404, observedAt);
			}
			if (normalized.status >= 300 && normalized.status < 400) {
				throw new Error(
					`GitHub DELETE failed closed on redirect HTTP ${normalized.status}`,
				);
			}
			throw new Error(
				`GitHub DELETE failed closed with HTTP ${normalized.status}`,
			);
		},
	});
	DELETE_WRITER_IDENTITIES.set(writer, writerIdentity);
	return writer;
}

function createIncidentGitHubReader({
	reader,
	fetchImpl,
	token,
	now,
	wallNow,
}) {
	const getRef = bindMethod(reader, "getRef", "GitHub reader");
	const getGitTag = bindMethod(reader, "getGitTag", "GitHub reader");
	const getWorkflow = bindMethod(reader, "getWorkflow", "GitHub reader");
	const listReleases = bindMethod(reader, "listReleases", "GitHub reader");
	const getRelease = bindMethod(reader, "getRelease", "GitHub reader");
	const listReleaseAssets = bindMethod(
		reader,
		"listReleaseAssets",
		"GitHub reader",
	);
	const downloadReleaseAsset = bindMethod(
		reader,
		"downloadReleaseAsset",
		"GitHub reader",
	);
	const http = createHttpGet({
		fetchImpl,
		timeoutMs: DELETE_TIMEOUT_MS,
		maxResponseBytes: MAX_DIRECT_JSON_BYTES,
	});

	return deepFreeze({
		async getRepository() {
			const body = await readDirectJson(http, BASE_URL(), token, "repository");
			if (
				!isPlainRecord(body) ||
				body.full_name !== REPOSITORY ||
				body.default_branch !== "main"
			) {
				throw new TypeError("GitHub repository evidence is malformed");
			}
			return deepFreeze({
				name: REPOSITORY,
				id: canonicalId(body.id),
				defaultBranch: "main",
			});
		},
		async getAuthenticatedUser() {
			const body = await readDirectJson(
				http,
				`${API_ORIGIN}/user`,
				token,
				"authenticated user",
			);
			if (!isPlainRecord(body) || !safeLogin(body.login)) {
				throw new TypeError("GitHub authenticated-user evidence is malformed");
			}
			return deepFreeze({ login: body.login, id: canonicalId(body.id) });
		},
		async getDefaultBranchSha() {
			const value = presentValue(await getRef({ ref: "heads/main" }), "ref");
			if (
				!isPlainRecord(value) ||
				value.ref !== "refs/heads/main" ||
				!isPlainRecord(value.object) ||
				value.object.type !== "commit" ||
				!isSha(value.object.sha)
			) {
				throw new TypeError("GitHub default-branch evidence is malformed");
			}
			return value.object.sha;
		},
		async getWorkflowState() {
			const value = presentValue(
				await getWorkflow({ workflow: "release.yml" }),
				"workflow",
			);
			if (
				!isPlainRecord(value) ||
				value.path !== RELEASE_WORKFLOW ||
				!safeBoundedString(value.state, 128)
			) {
				throw new TypeError("GitHub workflow evidence is malformed");
			}
			return deepFreeze({
				workflowId: canonicalId(value.id),
				path: RELEASE_WORKFLOW,
				state: value.state,
			});
		},
		async listNonterminalWorkflowRuns(input) {
			const query = exactWorkflowRunQuery(input);
			const runs = await readNonterminalWorkflowRuns(
				http,
				token,
				wallNow,
				query,
			);
			return deepFreeze({ query, runs });
		},
		async getAnnotatedTag(input) {
			const call = exactDataOptions(
				input,
				new Set(["name"]),
				"Annotated-tag options",
			);
			if (required(call, "name", "Annotated tag name") !== APPROVED_TAG) {
				throw new TypeError("Annotated tag is not the approved incident tag");
			}
			const ref = presentValue(
				await getRef({ ref: `tags/${APPROVED_TAG}` }),
				"ref",
			);
			if (
				!isPlainRecord(ref) ||
				ref.ref !== `refs/tags/${APPROVED_TAG}` ||
				!isPlainRecord(ref.object) ||
				ref.object.type !== "tag" ||
				!isSha(ref.object.sha)
			) {
				throw new TypeError("GitHub annotated-tag ref evidence is malformed");
			}
			const tag = presentValue(
				await getGitTag({ tagSha: ref.object.sha }),
				"git-tag",
			);
			if (
				!isPlainRecord(tag) ||
				tag.sha !== ref.object.sha ||
				tag.tag !== APPROVED_TAG ||
				!isPlainRecord(tag.object) ||
				tag.object.type !== "commit" ||
				!isSha(tag.object.sha)
			) {
				throw new TypeError(
					"GitHub annotated-tag object evidence is malformed",
				);
			}
			return deepFreeze({
				name: APPROVED_TAG,
				objectSha: ref.object.sha,
				targetSha: tag.object.sha,
				objectType: "tag",
				observedAt: now(),
			});
		},
		async listReleases() {
			return rejectDuplicateIds(
				await listReleases(),
				"releases",
				"DUPLICATE_RELEASE_ID",
			);
		},
		async getRelease(input) {
			return normalizedGitHubEnvelope(
				await getRelease(input),
				"release",
				"value",
			);
		},
		async listReleaseAssets(input) {
			return rejectDuplicateIds(
				await listReleaseAssets(input),
				"release-assets",
				"DUPLICATE_ASSET_ID",
			);
		},
		async downloadReleaseAsset(input) {
			return normalizedGitHubEnvelope(
				await downloadReleaseAsset(input),
				"release-asset-download",
				"contentBase64",
			);
		},
	});
}

function exactWorkflowRunQuery(value) {
	if (!isPlainRecord(value) || !Object.isFrozen(value)) {
		throw new TypeError(
			"Workflow-run query must be an exact deeply frozen object",
		);
	}
	const query = exactDataOptions(
		value,
		new Set(["statuses", "perPage", "maximumPages"]),
		"Workflow-run query",
	);
	if (utilTypes.isProxy(query.statuses) || !Object.isFrozen(query.statuses)) {
		throw new TypeError(
			"Workflow-run query must be an exact deeply frozen object",
		);
	}
	const statuses = snapshotStringArray(
		query.statuses,
		"Workflow-run query statuses",
	);
	if (
		!arraysEqual(statuses, NONTERMINAL_STATUS_ORDER) ||
		query.perPage !== 100 ||
		query.maximumPages !== MAX_PAGES
	) {
		throw new TypeError(
			"Workflow-run query does not match the exact status or page bounds",
		);
	}
	return deepFreeze({ statuses, perPage: 100, maximumPages: MAX_PAGES });
}

function guardNetworkFacade(source, guard, label) {
	const facade = {};
	for (const name of Object.keys(source)) {
		const method = bindMethod(source, name, label);
		facade[name] = (...args) =>
			guard.runRequest(`${label} ${name}`, () => method(...args), args);
	}
	return deepFreeze(facade);
}

function expectedAuthorityTrace(proposal, stage) {
	const exact = (label, args, validate, validateArgs) => ({
		label,
		args: snapshotJson(args),
		validate,
		...(validateArgs === undefined ? {} : { validateArgs }),
	});
	const equals = (expected, label) => (actual) => {
		if (!isDeepStrictEqual(actual, expected)) {
			throw new Error(`${label} differs from the authority proposal`);
		}
	};
	const steps = [
		exact("local Git reader readState", [], (actual) => {
			if (
				actual.headSha !== proposal.controller.headSha ||
				actual.originMainSha !== proposal.controller.originMainSha ||
				actual.branch !== "main" ||
				actual.porcelainStatus !== ""
			) {
				throw new Error("Local capture differs from the authority proposal");
			}
		}),
		exact("GitHub reader getRepository", [], (actual) => {
			equals(
				{
					name: proposal.repository.name,
					id: proposal.repository.id,
					defaultBranch: proposal.repository.defaultBranch,
				},
				"Repository capture",
			)(actual);
		}),
		exact(
			"GitHub reader getAuthenticatedUser",
			[],
			equals(proposal.repository.actor, "Actor capture"),
		),
		exact(
			"GitHub reader getDefaultBranchSha",
			[],
			equals(proposal.controller.githubMainSha, "GitHub main capture"),
		),
		exact("GitHub reader getWorkflowState", [], (actual) => {
			const {
				workflowId,
				path: workflowPath,
				state: workflowState,
			} = proposal.workflowAuthority;
			equals(
				{ workflowId, path: workflowPath, state: workflowState },
				"Workflow capture",
			)(actual);
		}),
		exact(
			"GitHub reader listNonterminalWorkflowRuns",
			[proposal.workflowAuthority.query],
			(actual) => {
				equals(
					{
						query: proposal.workflowAuthority.query,
						runs: proposal.workflowAuthority.nonterminalRuns,
					},
					"Workflow-run capture",
				)(actual);
			},
		),
		exact(
			"GitHub reader getAnnotatedTag",
			[{ name: proposal.candidate.tag }],
			(actual) => {
				for (const name of ["name", "objectSha", "targetSha", "objectType"]) {
					if (actual[name] !== proposal.annotatedTag[name]) {
						throw new Error("Annotated-tag capture differs from the proposal");
					}
				}
			},
		),
		exact("GitHub reader listReleases", [], (actual, session) => {
			if (
				actual.status !== "PRESENT" ||
				actual.operation !== "releases" ||
				actual.httpStatus !== 200 ||
				actual.code !== null ||
				!Array.isArray(actual.value)
			) {
				throw new Error("Release-list capture is malformed");
			}
			const classification = classifyConsolidationReleases(
				actual.value,
				proposal,
				stage,
			);
			session.keyResults.set("releases", actual);
			session.keyResults.set("release-classification", classification);
			appendExpectedPayloadTrace(
				session.expected,
				proposal,
				stage,
				classification.selected,
				exact,
				equals,
			);
		}),
	];
	for (const name of CANONICAL_RELEASE_PACKAGE_ORDER) {
		steps.push(
			exact(
				"npm package-version reader",
				[{ name, version: proposal.candidate.version }],
				equals(
					{
						status: "ABSENT",
						operation: "package-version",
						httpStatus: 404,
						code: "E404",
					},
					"npm capture",
				),
			),
		);
	}
	return steps;
}

function appendExpectedPayloadTrace(
	steps,
	proposal,
	stage,
	rawReleases,
	exact,
	equals,
) {
	const { releaseIds: remainingIds, targetReleaseId } =
		consolidationStageRule(stage);
	for (const releaseId of remainingIds) {
		const release = proposal.releases.find(({ id }) => id === releaseId);
		const rawRelease = rawReleases.find(({ id }) => String(id) === releaseId);
		if (release === undefined || rawRelease === undefined) {
			throw new Error("Authority proposal is missing a required Release");
		}
		const orderedAssets =
			stage === "pre-delete-1" ? rawRelease.assets : release.assets;
		for (const rawAsset of orderedAssets) {
			const asset = release.assets.find(({ id }) => id === String(rawAsset.id));
			if (asset === undefined) {
				throw new Error("Broad Release contains an unexpected asset");
			}
			steps.push(
				exact(
					"GitHub reader downloadReleaseAsset",
					[
						{
							releaseId,
							assetId: asset.id,
							maximumBytes: asset.size,
						},
					],
					(actual, session) => {
						assertCapturedDownload(actual, asset);
						if (!session.downloads.has(releaseId))
							session.downloads.set(releaseId, new Map());
						session.downloads
							.get(releaseId)
							.set(asset.name, Buffer.from(actual.contentBase64, "base64"));
					},
				),
			);
		}
		if (stage === "pre-delete-1") {
			steps.push(
				exact(
					"attestation verifier",
					null,
					(actual) => {
						equals(
							proposal.payloadProof.attestationVerification,
							"Attestation capture",
						)(actual);
					},
					(args, session) =>
						assertCapturedAttestationArgs(args, proposal, releaseId, session),
				),
			);
		}
	}
	if (stage !== "final") {
		steps.push(
			exact(
				"terminal Release GET",
				[{ releaseId: targetReleaseId }],
				(actual, session) => {
					session.keyResults.set("terminal-release", actual);
				},
			),
			exact(
				"terminal asset enumeration",
				[{ releaseId: targetReleaseId }],
				(actual, session) => {
					session.keyResults.set("terminal-assets", actual);
				},
			),
		);
	}
}

function assertCapturedDownload(actual, asset) {
	if (
		actual.status !== "PRESENT" ||
		actual.operation !== "release-asset-download" ||
		actual.httpStatus !== 200 ||
		actual.code !== null ||
		typeof actual.contentBase64 !== "string"
	) {
		throw new Error("Release download capture is malformed");
	}
	const bytes = Buffer.from(actual.contentBase64, "base64");
	if (
		bytes.byteLength !== asset.size ||
		bytes.toString("base64") !== actual.contentBase64 ||
		createHash("sha256").update(bytes).digest("hex") !== asset.downloadSha256
	) {
		throw new Error("Release download capture differs from the proposal");
	}
}

function assertCapturedAttestationArgs(args, proposal, releaseId, session) {
	if (!Array.isArray(args) || args.length !== 1) {
		throw new Error("Attestation capture arguments are missing or ambiguous");
	}
	const downloads = session.downloads.get(releaseId);
	if (downloads === undefined) {
		throw new Error("Attestation capture is missing guarded Release downloads");
	}
	const normalized = normalizeTraceValue(args[0]);
	const subjects = proposal.payloadProof.attestationVerification.subjects;
	const recordBytes = downloads.get("release-record.json");
	if (recordBytes === undefined) {
		throw new Error(
			"Attestation capture is missing the guarded release record",
		);
	}
	let record;
	try {
		record = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(recordBytes),
		);
	} catch {
		throw new Error("Guarded release record is not canonical JSON");
	}
	const expectedFiles = subjects.map(({ name }) => {
		const bytes = downloads.get(name);
		if (bytes === undefined)
			throw new Error("Attestation subject was not downloaded by the guard");
		return { name, bytes: { bufferBase64: bytes.toString("base64") } };
	});
	const expectedBundles = subjects.map(({ name }) => {
		const bundleName = `${name}.intoto.jsonl`;
		const bytes = downloads.get(bundleName);
		if (bytes === undefined)
			throw new Error("Attestation bundle was not downloaded by the guard");
		const expectedDigest = proposal.payloadProof.baseAssetSet.find(
			(entry) => entry.name === bundleName,
		)?.sha256;
		if (
			expectedDigest === undefined ||
			createHash("sha256").update(bytes).digest("hex") !== expectedDigest
		) {
			throw new Error("Attestation bundle digest differs from the proposal");
		}
		return {
			name: bundleName,
			bytes: { bufferBase64: bytes.toString("base64") },
		};
	});
	const expected = {
		source: "escrow",
		record,
		subjects,
		files: expectedFiles,
		bundles: expectedBundles,
	};
	if (!isDeepStrictEqual(normalized, expected)) {
		throw new Error(
			"Attestation capture arguments differ from guarded proposal evidence",
		);
	}
}

function canonicalTraceEntry(label, args, result) {
	return Object.freeze({
		label,
		argsSha256: traceSha256(normalizeTraceValue(args)),
		resultSha256: traceSha256(result),
	});
}

function traceSha256(value) {
	return createHash("sha256")
		.update(JSON.stringify(value), "utf8")
		.digest("hex");
}

function normalizeTraceValue(value, ancestors = new Set()) {
	if (Buffer.isBuffer(value)) {
		return { bufferBase64: value.toString("base64") };
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return value;
	}
	if (
		typeof value !== "object" ||
		utilTypes.isProxy(value) ||
		ancestors.has(value)
	) {
		throw new TypeError("Authority trace contains an invalid value");
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((entry) => normalizeTraceValue(entry, ancestors));
		}
		if (
			Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null
		) {
			throw new TypeError("Authority trace contains a non-plain value");
		}
		const output = {};
		for (const name of Object.keys(value).sort()) {
			const descriptor = Object.getOwnPropertyDescriptor(value, name);
			if (
				descriptor?.enumerable !== true ||
				!("value" in descriptor) ||
				descriptor.get !== undefined ||
				descriptor.set !== undefined
			) {
				throw new TypeError("Authority trace contains an unsafe field");
			}
			output[name] = normalizeTraceValue(descriptor.value, ancestors);
		}
		return output;
	} finally {
		ancestors.delete(value);
	}
}

function assertCapturedClockBinding(capture, authority) {
	const clocks = capture.clockReads;
	const npm = authority.npmInventory;
	if (
		clocks.length < 25 ||
		authority.workflowAuthority.observedAt !== clocks[0] ||
		npm.startedAt !== clocks[1] ||
		npm.completedAt !== clocks[CANONICAL_RELEASE_PACKAGE_ORDER.length + 2] ||
		authority.observedAt !== clocks.at(-1) ||
		npm.packages.some((entry, index) => entry.observedAt !== clocks[index + 2])
	) {
		throw new Error("Authority timestamps differ from the guard-owned trace");
	}
	if (capture.targetReleaseId !== null) {
		const terminalClocks = clocks.slice(-5, -1);
		const target = authority.targetRead;
		if (
			target === null ||
			!isDeepStrictEqual(terminalClocks, [
				target.releaseGetStartedAt,
				target.releaseGetCompletedAt,
				target.assetsListStartedAt,
				target.assetsListCompletedAt,
			])
		) {
			throw new Error("Terminal chronology differs from the guard-owned trace");
		}
	}
}

function assertCapturedAuthorityProjection(capture, authority) {
	const local = capture.keyResults.get("local Git reader readState");
	const main = capture.keyResults.get("GitHub reader getDefaultBranchSha");
	const tag = capture.keyResults.get("GitHub reader getAnnotatedTag");
	const workflow = capture.keyResults.get("GitHub reader getWorkflowState");
	const runs = capture.keyResults.get(
		"GitHub reader listNonterminalWorkflowRuns",
	);
	if (
		local === undefined ||
		main === undefined ||
		tag === undefined ||
		workflow === undefined ||
		runs === undefined ||
		!isDeepStrictEqual(authority.controller, {
			headSha: local.headSha,
			originMainSha: local.originMainSha,
			githubMainSha: main,
		}) ||
		!isDeepStrictEqual(authority.annotatedTag, tag) ||
		!isDeepStrictEqual(authority.workflowAuthority, {
			...workflow,
			query: runs.query,
			nonterminalRuns: runs.runs,
			observedAt: capture.clockReads[0],
		})
	) {
		throw new Error(
			"Authority projection differs from exact guard-recorded results",
		);
	}
}

async function validateCapturedReleaseEvidence(capture, authority) {
	const proposal = capture.proposedEnvelope.record;
	const expectedIds = consolidationStageRule(capture.stage).releaseIds;
	if (
		!Array.isArray(authority.releases) ||
		!isDeepStrictEqual(
			authority.releases.map(({ id }) => id),
			expectedIds,
		)
	) {
		throw new Error("Captured authority has the wrong remaining Releases");
	}
	const releaseEnvelope = capture.keyResults.get("releases");
	if (releaseEnvelope === undefined) {
		throw new Error("Captured authority has no broad Release enumeration");
	}
	const rawReleases = releaseEnvelope.value;
	const capturedClassification = capture.keyResults.get(
		"release-classification",
	);
	const classification = classifyConsolidationReleases(
		rawReleases,
		proposal,
		capture.stage,
	);
	if (
		capturedClassification === undefined ||
		capturedClassification.enumerationSha256 !==
			classification.enumerationSha256
	) {
		throw new Error(
			"Captured full Release enumeration classification differs from its trace",
		);
	}
	for (const authorityRelease of authority.releases) {
		const proposed = proposal.releases.find(
			({ id }) => id === authorityRelease.id,
		);
		const raw = classification.selected.find(
			({ id }) => String(id) === authorityRelease.id,
		);
		if (proposed === undefined || raw === undefined) {
			throw new Error("Captured Release is absent from broad enumeration");
		}
		assertEvidenceEqualsProposal(authorityRelease, proposed);
		await captureDirectTargetRead({
			candidate: proposal.candidate,
			releaseId: authorityRelease.id,
			role: authorityRelease.role,
			expectedEvidence: authorityRelease,
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
			now: () => authority.observedAt,
		});
	}
	if (capture.targetReleaseId !== null) {
		const releaseResult = capture.keyResults.get("terminal-release");
		const assetsResult = capture.keyResults.get("terminal-assets");
		const targetAuthority = authority.releases.find(
			({ id }) => id === capture.targetReleaseId,
		);
		if (
			releaseResult === undefined ||
			assetsResult === undefined ||
			targetAuthority === undefined
		) {
			throw new Error("Captured terminal Release evidence is incomplete");
		}
		const terminal = await captureDirectTargetRead({
			candidate: proposal.candidate,
			releaseId: capture.targetReleaseId,
			role: "duplicate",
			expectedEvidence: targetAuthority,
			github: Object.freeze({
				async getRelease() {
					return releaseResult;
				},
				async listReleaseAssets() {
					return assetsResult;
				},
			}),
			now: () => authority.observedAt,
		});
		if (!isDeepStrictEqual(terminal.evidence, authority.targetRead.evidence)) {
			throw new Error("Terminal evidence differs from captured authority");
		}
	}
	return classification.enumerationSha256;
}

function createNetworkGuard({ cwd, now }) {
	const context = new AsyncLocalStorage();
	const journalPath = path.join(
		cwd,
		".dawn",
		"release",
		"duplicate-draft-consolidation.journal.json",
	);
	const permitRecords = new WeakMap();
	let state = "open";
	let activeRequests = 0;
	let sequence = 0;
	let terminal = null;
	let capture = null;
	let lastClockMillis = null;
	let boundWriterIdentity = null;
	let guardFacade;

	const trustedNow = () => {
		const owner = context.getStore();
		if (
			capture !== null &&
			(state === "capturing" || state === "terminal") &&
			owner !== capture.token
		) {
			invalidate();
			throw new TypeError("Trusted adapter clock is outside authority capture");
		}
		let timestamp;
		try {
			timestamp = canonicalTimestamp(callClock(now));
		} catch {
			throw new TypeError("Trusted adapter clock failed closed");
		}
		const millis = Date.parse(timestamp);
		if (lastClockMillis !== null && millis < lastClockMillis) {
			throw new TypeError("Trusted adapter clock is not monotone");
		}
		lastClockMillis = millis;
		return timestamp;
	};

	const invalidate = () => {
		if (terminal !== null) terminal.invalidated = true;
		if (state !== "deleting" && state !== "spent") state = "invalidated";
	};

	const runRequest = async (label, operation, traceArgs) => {
		const owner = context.getStore();
		const captureOwner = capture !== null && owner === capture.token;
		const terminalOwner =
			state === "terminal" && terminal !== null && owner === terminal.token;
		const deleteOwner = state === "deleting" && owner === terminal?.deleteToken;
		const allowedDeleteRequest =
			deleteOwner &&
			(label === "approved DELETE" || label === "network transport");
		if (
			state !== "open" &&
			!captureOwner &&
			!terminalOwner &&
			!allowedDeleteRequest
		) {
			invalidate();
			throw new Error(`${label} rejected by the sealed network epoch`);
		}
		const traced = traceArgs !== undefined && capture !== null;
		if (traced) {
			if (
				(!captureOwner && !terminalOwner) ||
				capture.inFlight ||
				capture.nextStep >= capture.expected.length
			) {
				invalidate();
				throw new Error(`${label} rejected by the authority capture trace`);
			}
			const expected = capture.expected[capture.nextStep];
			if (
				expected.label !== label ||
				(expected.args !== null &&
					!isDeepStrictEqual(snapshotJson(traceArgs), expected.args))
			) {
				invalidate();
				throw new Error(
					`${label} is out of order in the authority capture trace`,
				);
			}
			if (expected.validateArgs !== undefined) {
				expected.validateArgs(traceArgs, capture);
			}
			capture.inFlight = true;
		}
		sequence += 1;
		activeRequests += 1;
		try {
			const result = await operation();
			if (deleteOwner && terminal?.invalidated) {
				throw new Error(
					`${label} completed after a reentrant adapter invalidated DELETE`,
				);
			}
			if (traced) {
				if (capture.invalidated || state === "invalidated") {
					throw new Error(
						`${label} completed after authority capture invalidation`,
					);
				}
				const expected = capture.expected[capture.nextStep];
				const resultSnapshot = snapshotJson(result);
				expected.validate(resultSnapshot, capture);
				if (!capture.keyResults.has(label)) {
					capture.keyResults.set(label, resultSnapshot);
				}
				capture.entries.push(
					canonicalTraceEntry(label, traceArgs, resultSnapshot),
				);
				capture.nextStep += 1;
				capture.inFlight = false;
			}
			return result;
		} catch (error) {
			if (traced) {
				capture.inFlight = false;
				invalidate();
			}
			throw error;
		} finally {
			activeRequests -= 1;
		}
	};

	const assertSealed = (session) => {
		if (
			terminal !== session ||
			session.invalidated ||
			state !== "sealed" ||
			activeRequests !== 0 ||
			sequence !== session.sealedSequence
		) {
			throw new Error("Adapter network epoch is no longer sealed");
		}
	};

	const sealedEpoch = (session) => {
		const capability = {};
		const descriptors = {
			now: hiddenMethod(trustedNow),
			journalPath: hiddenValue(journalPath),
			validate: hiddenMethod(() => assertSealed(session)),
			bindAuthority: hiddenMethod((input) =>
				bindCapturedAuthority(session, input),
			),
			toJSON: hiddenMethod(() => {
				throw new TypeError(
					"Adapter network epoch capability cannot be serialized",
				);
			}),
		};
		Object.defineProperties(capability, descriptors);
		return Object.freeze(capability);
	};

	const bindCapturedAuthority = async (session, input) => {
		assertSealed(session);
		if (
			capture === null ||
			capture.invalidated ||
			capture.bound !== null ||
			capture.nextStep !== capture.expected.length ||
			capture.inFlight
		) {
			invalidate();
			throw new Error("Authority capture trace is not sealable");
		}
		const value = exactDataOptions(
			input,
			new Set(["authority", "proposal", "acceptTransitionBoundary"]),
			"Captured authority binding",
		);
		const authority = snapshotJson(
			required(value, "authority", "Captured authority"),
		);
		const proposedEnvelope = createConsolidationEnvelope(
			"proposed",
			snapshotJson(required(value, "proposal", "Captured proposal")),
		);
		const acceptTransitionBoundary = requiredFunction(
			value,
			"acceptTransitionBoundary",
			"Task6 transition boundary receiver",
		);
		if (
			proposedEnvelope.recordSha256 !== capture.proposedEnvelope.recordSha256 ||
			authority.stage !== capture.stage ||
			(authority.targetRead?.evidence?.id ?? null) !== capture.targetReleaseId
		) {
			invalidate();
			throw new Error("Captured authority identity differs from its trace");
		}
		assertCapturedClockBinding(capture, authority);
		assertCapturedAuthorityProjection(capture, authority);
		const releaseEnumerationSha256 = await validateCapturedReleaseEvidence(
			capture,
			authority,
		);
		capture.bound = Object.freeze({
			traceSha256: traceSha256(capture.entries),
			authoritySha256: canonicalRecordSha256(authority),
			proposalSha256: proposedEnvelope.recordSha256,
			targetReadSha256: traceSha256(normalizeTraceValue(authority.targetRead)),
			releaseEnumerationSha256,
		});
		const transitionBoundary = (input) => {
			if (session !== terminal || guardFacade === undefined) {
				throw new Error("Authority capture epoch is no longer current");
			}
			return guardFacade.armTask6Transition(input);
		};
		Object.freeze(transitionBoundary);
		acceptTransitionBoundary(transitionBoundary);
		return undefined;
	};

	const sealCapturedWithoutTarget = (session) => {
		if (
			capture !== session ||
			state !== "capturing" ||
			session.invalidated ||
			session.inFlight ||
			session.nextStep !== session.expected.length ||
			activeRequests !== 0 ||
			session.targetReleaseId !== null
		) {
			invalidate();
			throw new Error("Final authority capture trace is incomplete");
		}
		terminal = {
			token: Object.freeze({}),
			deleteToken: Object.freeze({}),
			releaseId: null,
			nextStep: 0,
			completedSteps: 0,
			inFlight: false,
			invalidated: false,
			sealedSequence: sequence,
		};
		state = "sealed";
		return sealedEpoch(terminal);
	};

	const beginAuthorityCapture = (facade, rawGithub, input) => {
		const value = exactDataOptions(
			input,
			new Set(["stage", "proposal", "targetReleaseId"]),
			"Authority capture options",
		);
		const stage = required(value, "stage", "Authority capture stage");
		if (!new Set(["pre-delete-1", "pre-delete-2", "final"]).has(stage)) {
			throw new TypeError("Authority capture stage is invalid");
		}
		const proposedEnvelope = createConsolidationEnvelope(
			"proposed",
			snapshotJson(required(value, "proposal", "Authority capture proposal")),
		);
		const targetValue = required(
			value,
			"targetReleaseId",
			"Authority capture target",
		);
		const targetReleaseId =
			targetValue === null ? null : canonicalStringId(targetValue);
		const expectedTarget = consolidationStageRule(stage).targetReleaseId;
		if (
			targetReleaseId !== expectedTarget ||
			state !== "open" ||
			activeRequests !== 0 ||
			capture !== null
		) {
			invalidate();
			throw new Error("Authority capture cannot start from this adapter state");
		}
		const session = {
			token: Object.freeze({}),
			stage,
			targetReleaseId,
			proposedEnvelope,
			expected: expectedAuthorityTrace(proposedEnvelope.record, stage),
			nextStep: 0,
			inFlight: false,
			entries: [],
			clockReads: [],
			keyResults: new Map(),
			downloads: new Map(),
			invalidated: false,
			bound: null,
		};
		capture = session;
		state = "capturing";
		const scope = (source) => {
			const scoped = {};
			for (const name of Object.keys(source)) {
				scoped[name] = (...args) =>
					context.run(session.token, () => source[name](...args));
			}
			return deepFreeze(scoped);
		};
		const capability = {};
		Object.defineProperties(capability, {
			local: hiddenValue(scope(facade.local)),
			github: hiddenValue(scope(facade.github)),
			npm: hiddenValue(scope(facade.npm)),
			attestations: hiddenValue(scope(facade.attestations)),
			now: hiddenMethod(() =>
				context.run(session.token, () => {
					const timestamp = trustedNow();
					session.clockReads.push(timestamp);
					return timestamp;
				}),
			),
			beginTerminalRead: hiddenMethod((terminalInput) =>
				context.run(session.token, () =>
					beginTerminalRead(rawGithub, terminalInput),
				),
			),
			sealWithoutTarget: hiddenMethod(() =>
				context.run(session.token, () => sealCapturedWithoutTarget(session)),
			),
			abort: hiddenMethod(() => invalidate()),
			toJSON: hiddenMethod(() => {
				throw new TypeError(
					"Authority capture capability cannot be serialized",
				);
			}),
		});
		return Object.freeze(capability);
	};

	const beginTerminalRead = (rawGithub, input) => {
		const call = exactDataOptions(
			input,
			new Set(["releaseId"]),
			"Terminal read options",
		);
		const releaseId = canonicalStringId(
			required(call, "releaseId", "Terminal Release ID"),
		);
		if (!DUPLICATE_IDS.includes(releaseId)) {
			invalidate();
			throw new TypeError("Terminal Release ID is not an approved duplicate");
		}
		const captureOwner =
			capture !== null && context.getStore() === capture.token;
		if (
			(state !== "open" && !(state === "capturing" && captureOwner)) ||
			activeRequests !== 0
		) {
			invalidate();
			throw new Error(
				"Terminal network read cannot absorb a concurrent request",
			);
		}
		const session = {
			token: Object.freeze({}),
			deleteToken: Object.freeze({}),
			releaseId,
			nextStep: 0,
			completedSteps: 0,
			inFlight: false,
			invalidated: false,
			sealedSequence: null,
		};
		terminal = session;
		state = "terminal";
		const terminalStep = async (step, name, options, operation) => {
			let call;
			try {
				call = exactDataOptions(
					options,
					new Set(["releaseId"]),
					`Terminal ${name} options`,
				);
				const requestedReleaseId = canonicalStringId(
					required(call, "releaseId", `Terminal ${name} Release ID`),
				);
				if (requestedReleaseId !== session.releaseId) {
					throw new TypeError(
						"Terminal request target differs from its session",
					);
				}
			} catch {
				session.invalidated = true;
				state = "invalidated";
				throw new TypeError("Terminal request options failed closed");
			}
			if (
				state !== "terminal" ||
				terminal !== session ||
				session.invalidated ||
				session.nextStep !== step ||
				session.inFlight
			) {
				session.invalidated = true;
				state = "invalidated";
				throw new Error("Terminal network read order is invalid");
			}
			session.inFlight = true;
			session.nextStep = step + 1;
			try {
				const result = await context.run(session.token, () =>
					runRequest(`terminal ${name}`, () => operation(call), [call]),
				);
				if (
					state !== "terminal" ||
					terminal !== session ||
					session.invalidated ||
					!session.inFlight ||
					session.nextStep !== step + 1
				) {
					throw new Error(
						"Terminal network read was invalidated while pending",
					);
				}
				session.inFlight = false;
				session.completedSteps = step + 1;
				return result;
			} catch {
				session.inFlight = false;
				session.invalidated = true;
				state = "invalidated";
				throw new Error(`Terminal ${name} failed closed`);
			}
		};
		const github = deepFreeze({
			getRelease(options) {
				return terminalStep(0, "Release GET", options, (owned) =>
					rawGithub.getRelease(owned),
				);
			},
			listReleaseAssets(options) {
				return terminalStep(1, "asset enumeration", options, (owned) =>
					rawGithub.listReleaseAssets(owned),
				);
			},
		});
		const capability = {};
		Object.defineProperties(capability, {
			github: hiddenValue(github),
			seal: hiddenMethod(() => {
				if (
					state !== "terminal" ||
					terminal !== session ||
					session.invalidated ||
					session.nextStep !== 2 ||
					session.completedSteps !== 2 ||
					session.inFlight ||
					activeRequests !== 0
				) {
					session.invalidated = true;
					state = "invalidated";
					throw new Error("Terminal network read did not complete exactly");
				}
				if (
					capture !== null &&
					(capture.invalidated ||
						capture.inFlight ||
						capture.nextStep !== capture.expected.length)
				) {
					session.invalidated = true;
					state = "invalidated";
					throw new Error("Authority capture trace is incomplete");
				}
				state = "sealed";
				session.sealedSequence = sequence;
				return sealedEpoch(session);
			}),
			abort: hiddenMethod(() => {
				session.invalidated = true;
				state = "invalidated";
			}),
			toJSON: hiddenMethod(() => {
				throw new TypeError("Terminal network capability cannot be serialized");
			}),
		});
		return Object.freeze(capability);
	};

	guardFacade = Object.freeze({
		now: trustedNow,
		runRequest,
		bindWriter(writer) {
			const identity =
				writer !== null && typeof writer === "object"
					? DELETE_WRITER_IDENTITIES.get(writer)
					: undefined;
			if (identity === undefined || boundWriterIdentity !== null) {
				invalidate();
				throw new TypeError(
					"Adapter network guard delete writer binding failed",
				);
			}
			boundWriterIdentity = identity;
		},
		armTask6Transition(input) {
			try {
				const session = terminal;
				if (
					session === null ||
					capture === null ||
					capture.bound === null ||
					capture.invalidated
				) {
					throw new Error(
						"Task6 transition has no bound authority capture trace",
					);
				}
				assertSealed(session);
				if (
					session.releaseId === null ||
					!DUPLICATE_IDS.includes(session.releaseId) ||
					session.completedSteps !== 2 ||
					session.inFlight ||
					boundWriterIdentity === null
				) {
					throw new Error(
						"Task6 transition requires a completed approved terminal target read",
					);
				}
				const binding = exactDataOptions(
					input,
					new Set([
						"targetReleaseId",
						"authority",
						"proposedEnvelope",
						"confirmation",
						"predecessorJournal",
						"predecessorHead",
						"committedJournal",
						"committedHead",
					]),
					"Task6 journal transition",
				);
				const targetReleaseId = canonicalStringId(
					required(binding, "targetReleaseId", "Task6 transition target"),
				);
				if (targetReleaseId !== session.releaseId) {
					throw new Error(
						"Task6 transition target differs from the terminal session",
					);
				}
				const predecessorJournal = required(
					binding,
					"predecessorJournal",
					"Task6 predecessor journal",
				);
				const committedJournal = required(
					binding,
					"committedJournal",
					"Task6 committed journal",
				);
				const journalHeadPath = `${journalPath.slice(0, -"journal.json".length)}journal.head.json`;
				const predecessorHead = required(
					binding,
					"predecessorHead",
					"Task6 predecessor journal head",
				);
				const committedHead = required(
					binding,
					"committedHead",
					"Task6 committed journal head",
				);
				const predecessorProvenance = authenticatedPrivateRead(
					predecessorJournal,
					journalPath,
				);
				const committedProvenance = authenticatedPrivateRead(
					committedJournal,
					journalPath,
				);
				authenticatedPrivateRead(predecessorHead, journalHeadPath);
				authenticatedPrivateRead(committedHead, journalHeadPath);
				if (
					predecessorProvenance.identity.dev !==
						committedProvenance.identity.dev ||
					predecessorProvenance.identity.ino ===
						committedProvenance.identity.ino
				) {
					throw new Error(
						"Task6 journal transition did not replace one authenticated predecessor",
					);
				}
				const predecessorEnvelope =
					parseConsolidationJournal(predecessorJournal);
				const committedEnvelope = parseConsolidationJournal(committedJournal);
				const proposedEnvelope = parseConsolidationEnvelope(
					"proposed",
					canonicalConsolidationEnvelopeBytes(
						"proposed",
						required(binding, "proposedEnvelope", "Task6 proposed envelope"),
					),
				);
				const confirmation = required(
					binding,
					"confirmation",
					"Task6 confirmation",
				);
				assertExactIncidentConfirmation(confirmation, proposedEnvelope);
				const confirmationSha256 = createHash("sha256")
					.update(confirmation, "utf8")
					.digest("hex");
				const predecessorState = deriveConsolidationState(predecessorEnvelope);
				const authority = required(binding, "authority", "Task6 authority");
				assertTransitionAuthorityMatchesProposal(
					authority,
					proposedEnvelope.record,
					targetReleaseId,
				);
				const releaseEnvelope = capture.keyResults.get("releases");
				if (releaseEnvelope === undefined) {
					throw new Error(
						"Task6 transition has no guarded Release enumeration",
					);
				}
				const releaseClassification = classifyConsolidationReleases(
					releaseEnvelope.value,
					proposedEnvelope.record,
					capture.stage,
				);
				if (
					capture.bound.traceSha256 !== traceSha256(capture.entries) ||
					capture.bound.authoritySha256 !== canonicalRecordSha256(authority) ||
					capture.bound.proposalSha256 !== proposedEnvelope.recordSha256 ||
					capture.bound.releaseEnumerationSha256 !==
						releaseClassification.enumerationSha256 ||
					capture.bound.targetReadSha256 !==
						traceSha256(normalizeTraceValue(authority.targetRead))
				) {
					throw new Error(
						"Task6 authority differs from the sealed guard-owned trace",
					);
				}
				const expectedPredecessorHead = canonicalJournalHeadBytes(
					journalPath,
					predecessorEnvelope,
				);
				const expectedCommittedHead = canonicalJournalHeadBytes(
					journalPath,
					committedEnvelope,
				);
				if (
					!predecessorHead.equals(expectedPredecessorHead) ||
					!committedHead.equals(expectedCommittedHead)
				) {
					throw new Error(
						"Task6 authenticated journal heads do not bind the legal append",
					);
				}
				if (
					predecessorEnvelope.record.proposedRecordSha256 !==
						proposedEnvelope.recordSha256 ||
					predecessorEnvelope.record.confirmationSha256 !==
						confirmationSha256 ||
					predecessorState.controllerSha !==
						proposedEnvelope.record.controller.headSha ||
					predecessorState.phase !== "delete-authority-observed" ||
					predecessorState.currentTargetReleaseId !== targetReleaseId ||
					!isDeepStrictEqual(predecessorState.lastAuthority, authority)
				) {
					throw new Error(
						"Task6 transition predecessor does not bind confirmation, controller, target, and authority",
					);
				}
				const expectedCommitted = appendJournalEvent(
					predecessorEnvelope,
					"delete-intent",
					{
						targetReleaseId,
						attemptNumber: predecessorState.attemptNumber,
						authorityEventSha256: predecessorState.lastEventSha256,
					},
					committedEnvelope.record.updatedAt,
				);
				if (
					!committedJournal.equals(
						canonicalConsolidationEnvelopeBytes("journal", expectedCommitted),
					) ||
					!isDeepStrictEqual(committedEnvelope, expectedCommitted)
				) {
					throw new Error(
						"Task6 committed journal is not exactly one legal intent append",
					);
				}
				const authorityExpiresAt = new Date(
					Date.parse(authority.npmInventory.completedAt) + 120_000,
				).toISOString();
				if (trustedNow() > authorityExpiresAt) {
					throw new Error("Task6 authority expired before permit issuance");
				}
				const permit = {};
				Object.defineProperty(permit, "toJSON", {
					...hiddenMethod(() => {
						throw new TypeError(
							"Delete permit capability cannot be serialized",
						);
					}),
				});
				Object.freeze(permit);
				permitRecords.set(permit, {
					session,
					targetReleaseId,
					used: false,
					committedJournal,
					committedHead,
					authorityExpiresAt,
				});
				DELETE_PERMIT_BINDINGS.set(permit, {
					writerIdentity: boundWriterIdentity,
					releaseId: targetReleaseId,
					authorityExpiresAt,
					armed: false,
					used: false,
				});
				state = "permitted";
				return permit;
			} catch (error) {
				invalidate();
				throw error;
			}
		},
		runDelete: async (permit, releaseId, operation) => {
			const record =
				permit !== null && typeof permit === "object"
					? permitRecords.get(permit)
					: undefined;
			const permitBinding =
				permit !== null && typeof permit === "object"
					? DELETE_PERMIT_BINDINGS.get(permit)
					: undefined;
			if (
				record === undefined ||
				record.used ||
				record.session !== terminal ||
				record.targetReleaseId !== releaseId ||
				permitBinding === undefined ||
				permitBinding.writerIdentity !== boundWriterIdentity ||
				permitBinding.releaseId !== releaseId ||
				permitBinding.used ||
				permitBinding.armed ||
				state !== "permitted"
			) {
				invalidate();
				throw new Error(
					"Delete requires the valid one-use adapter-bound permit",
				);
			}
			record.used = true;
			permitBinding.used = true;
			try {
				const beforeRead = trustedNow();
				if (beforeRead > record.authorityExpiresAt) {
					throw new Error(
						"Delete permit expired with its absolute npm authority",
					);
				}
				const currentJournal = await readPrivateEnvelope(
					journalPath,
					DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
				);
				if (
					!sameAuthenticatedPrivateRead(
						currentJournal,
						record.committedJournal,
						journalPath,
					)
				) {
					throw new Error(
						"Delete journal identity or bytes changed after permit issuance",
					);
				}
				const journalHeadPath = `${journalPath.slice(0, -"journal.json".length)}journal.head.json`;
				const currentHead = await readPrivateEnvelope(
					journalHeadPath,
					16 * 1024,
				);
				if (
					!sameAuthenticatedPrivateRead(
						currentHead,
						record.committedHead,
						journalHeadPath,
					)
				) {
					throw new Error(
						"Delete journal head identity or bytes changed after permit issuance",
					);
				}
				const immediatelyBeforeSend = trustedNow();
				if (immediatelyBeforeSend > record.authorityExpiresAt) {
					throw new Error(
						"Delete permit expired with its absolute npm authority",
					);
				}
			} catch (error) {
				state = "spent";
				throw error;
			}
			permitBinding.armed = true;
			permitBinding.used = false;
			state = "deleting";
			try {
				return await context.run(record.session.deleteToken, () =>
					runRequest("approved DELETE", operation),
				);
			} finally {
				state = "spent";
			}
		},
		createAuthorityCapability(rawGithub, facade) {
			const capability = {};
			Object.defineProperties(capability, {
				now: hiddenMethod(trustedNow),
				journalPath: hiddenValue(journalPath),
				validateFacade: hiddenMethod((candidate) => {
					if (candidate !== facade) {
						invalidate();
						throw new TypeError(
							"Adapter authority capability is not bound to this facade",
						);
					}
				}),
				beginAuthorityCapture: hiddenMethod((input) =>
					beginAuthorityCapture(facade, rawGithub, input),
				),
				beginTerminalRead: hiddenMethod((input) =>
					beginTerminalRead(rawGithub, input),
				),
				sealWithoutTarget: hiddenMethod(() => {
					if (state !== "open" || activeRequests !== 0) {
						invalidate();
						throw new Error(
							"Final network epoch cannot absorb a concurrent request",
						);
					}
					terminal = {
						token: Object.freeze({}),
						deleteToken: Object.freeze({}),
						releaseId: null,
						nextStep: 0,
						completedSteps: 0,
						inFlight: false,
						invalidated: false,
						sealedSequence: sequence,
					};
					state = "sealed";
					return sealedEpoch(terminal);
				}),
				toJSON: hiddenMethod(() => {
					throw new TypeError(
						"Adapter authority capability cannot be serialized",
					);
				}),
			});
			return Object.freeze(capability);
		},
	});
	return guardFacade;
}

function hiddenMethod(value) {
	Object.freeze(value);
	return { value, enumerable: false, writable: false, configurable: false };
}

function hiddenValue(value) {
	return { value, enumerable: false, writable: false, configurable: false };
}

function authenticatedPrivateRead(value, expectedPath) {
	const authenticate = Object.getOwnPropertyDescriptor(
		readPrivateEnvelope,
		"authenticate",
	)?.value;
	if (typeof authenticate !== "function") {
		throw new TypeError("Private no-follow read verifier is unavailable");
	}
	return authenticate(value, expectedPath);
}

function sameAuthenticatedPrivateRead(actual, expected, expectedPath) {
	const actualIdentity = authenticatedPrivateRead(
		actual,
		expectedPath,
	).identity;
	const expectedIdentity = authenticatedPrivateRead(
		expected,
		expectedPath,
	).identity;
	return (
		actual.equals(expected) &&
		sameFileIdentity(actualIdentity, expectedIdentity)
	);
}

function sameFileIdentity(left, right) {
	return ["ctimeNs", "dev", "ino", "mtimeNs", "nlink", "size"].every(
		(name) => left[name] === right[name],
	);
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

function createLocalGitReader({ cwd, environment, run, ownerAdapters }) {
	const git = ownDataObject(
		requiredMember(ownerAdapters, "git", "Owner preflight adapters"),
		"Owner Git adapter",
	);
	const headSha = bindMethod(git, "headSha", "Owner Git adapter");
	return deepFreeze({
		async readState() {
			const head = await headSha();
			if (!isSha(head)) throw new TypeError("Local Git HEAD SHA is malformed");
			const branchResult = await executeExact(
				run,
				"git",
				["symbolic-ref", "--quiet", "--short", "HEAD"],
				{ cwd, env: environment },
			);
			const branch = singleLine(
				branchResult.stdout,
				"Local Git symbolic branch",
			);
			if (branch !== "main")
				throw new TypeError("Local Git symbolic branch must be main");
			const statusResult = await executeExact(
				run,
				"git",
				["status", "--porcelain=v1", "--untracked-files=all"],
				{ cwd, env: environment },
			);
			if (statusResult.stdout !== "") {
				throw new TypeError("Local Git porcelain status must be clean");
			}
			const originResult = await executeExact(
				run,
				"git",
				["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
				{ cwd, env: environment },
			);
			const originMainSha = singleLine(
				originResult.stdout,
				"Local Git origin/main SHA",
			);
			if (!isSha(originMainSha))
				throw new TypeError("Local Git origin/main SHA is malformed");
			return deepFreeze({
				headSha: head,
				branch,
				porcelainStatus: "",
				originMainSha,
			});
		},
	});
}

async function readNonterminalWorkflowRuns(http, token, now, query) {
	const runs = [];
	const rawIds = new Set();
	const requestedStatuses = new Set(query.statuses);
	const budget = workflowReadBudget(now);
	let total = null;
	let pages = 1;
	for (let page = 1; page <= pages; page += 1) {
		const url = workflowRunsUrl(page, query.perPage);
		const result = await readDirectJsonResult(
			http,
			url,
			token,
			"workflow runs",
			remainingWorkflowRequestBudget(budget),
		);
		consumeWorkflowResponseBudget(budget, result.bodyBytes);
		const { body } = result;
		if (
			!isPlainRecord(body) ||
			!Number.isSafeInteger(body.total_count) ||
			body.total_count < 0 ||
			body.total_count > MAX_RECORDS ||
			!Array.isArray(body.workflow_runs) ||
			body.workflow_runs.length > query.perPage
		) {
			throw new TypeError(
				"GitHub workflow-run total or record bound is malformed",
			);
		}
		if (page === 1) {
			total = body.total_count;
			pages = Math.max(1, Math.ceil(total / query.perPage));
			if (pages > query.maximumPages) {
				throw new TypeError("GitHub workflow-run page bound exceeded");
			}
		} else if (body.total_count !== total) {
			throw new TypeError("GitHub workflow-run total is unstable");
		}
		const expected =
			total === 0
				? 0
				: page < pages
					? query.perPage
					: total - (pages - 1) * query.perPage;
		if (body.workflow_runs.length !== expected) {
			throw new TypeError("GitHub workflow-run page total is inconsistent");
		}
		const nextUrl = workflowNextUrl(result.link);
		if (page < pages) {
			if (nextUrl === null)
				throw new TypeError(
					"GitHub workflow-run pagination is missing Link next",
				);
			if (nextUrl !== workflowRunsUrl(page + 1, query.perPage)) {
				throw new TypeError(
					"GitHub workflow-run Link next URL is not the expected trusted page",
				);
			}
		} else if (nextUrl !== null) {
			throw new TypeError(
				"GitHub workflow-run pagination has an unexpected Link next",
			);
		}
		for (const run of body.workflow_runs) {
			if (!isPlainRecord(run))
				throw new TypeError("GitHub workflow run is malformed");
			const id = canonicalId(run.id);
			if (rawIds.has(id))
				throw new TypeError("GitHub workflow runs contain a duplicate ID");
			rawIds.add(id);
			if (!requestedStatuses.has(run.status)) continue;
			if (
				!Number.isSafeInteger(run.run_attempt) ||
				run.run_attempt < 1 ||
				!safeBoundedString(run.event, 256) ||
				!isSha(run.head_sha) ||
				!safeBoundedString(run.head_branch, 1_024)
			) {
				throw new TypeError("GitHub nonterminal workflow run is malformed");
			}
			runs.push({
				id,
				runAttempt: run.run_attempt,
				status: run.status,
				event: run.event,
				headSha: run.head_sha,
				headBranch: run.head_branch,
			});
		}
	}
	if (rawIds.size !== total)
		throw new TypeError("GitHub workflow-run raw total is inconsistent");
	return deepFreeze(
		runs.sort((left, right) =>
			left.id === right.id
				? left.runAttempt - right.runAttempt
				: BigInt(left.id) < BigInt(right.id)
					? -1
					: 1,
		),
	);
}

async function readDirectJson(http, url, token, label) {
	return (await readDirectJsonResult(http, url, token, label)).body;
}

async function readDirectJsonResult(http, url, token, label, requestBudget) {
	const result = await http.getJson({
		url,
		headers: githubHeaders(token),
		...(requestBudget === undefined ? {} : requestBudget),
	});
	if (
		result.status !== "OK" ||
		result.httpStatus < 200 ||
		result.httpStatus >= 300
	) {
		throw new Error(`GitHub ${label} read failed closed`);
	}
	if (!isPlainRecord(result.body))
		throw new TypeError(`GitHub ${label} response is malformed`);
	return {
		body: result.body,
		link: result.headers.link,
		bodyBytes: result.bodyBytes,
	};
}

function workflowReadBudget(now) {
	const startedAt = workflowClockMillis(now);
	return {
		deadline: startedAt + DELETE_TIMEOUT_MS,
		remainingBytes: MAX_DIRECT_JSON_BYTES,
		now,
	};
}

function remainingWorkflowRequestBudget(budget) {
	const timeoutMs = budget.deadline - workflowClockMillis(budget.now);
	if (timeoutMs < 1)
		throw new Error("GitHub workflow-run operation deadline exceeded");
	if (budget.remainingBytes < 1) {
		throw new Error("GitHub workflow-run operation byte budget exceeded");
	}
	return {
		timeoutMs: Math.min(timeoutMs, DELETE_TIMEOUT_MS),
		maxResponseBytes: budget.remainingBytes,
	};
}

function consumeWorkflowResponseBudget(budget, bodyBytes) {
	if (
		!Number.isSafeInteger(bodyBytes) ||
		bodyBytes < 0 ||
		bodyBytes > budget.remainingBytes
	) {
		throw new Error("GitHub workflow-run operation byte budget exceeded");
	}
	budget.remainingBytes -= bodyBytes;
	if (budget.deadline <= workflowClockMillis(budget.now)) {
		throw new Error("GitHub workflow-run operation deadline exceeded");
	}
}

function workflowClockMillis(now) {
	const value = now();
	if (!Number.isSafeInteger(value))
		throw new TypeError("GitHub workflow-run clock is invalid");
	return value;
}

function workflowRunsUrl(page, perPage = 100) {
	return `${API_ORIGIN}/repos/${REPOSITORY}/actions/workflows/${encodeURIComponent(RELEASE_WORKFLOW)}/runs?per_page=${perPage}&page=${page}`;
}

function workflowNextUrl(value) {
	if (value === null) return null;
	const graph = exactLinkGraph(value);
	if (graph === null) {
		throw new TypeError("GitHub workflow-run Link header is malformed");
	}
	const next = [];
	const relations = new Set();
	const targetRelations = new Map();
	for (const entry of graph) {
		const url = exactWorkflowPageUrl(entry.url);
		if (relations.has(entry.relation)) {
			throw new TypeError("GitHub workflow-run Link graph is contradictory");
		}
		relations.add(entry.relation);
		addTargetRelation(targetRelations, url, entry.relation);
		if (entry.relation === "next") next.push(url);
	}
	if (!hasCompatibleSharedLinkTargets(targetRelations)) {
		throw new TypeError("GitHub workflow-run Link graph is contradictory");
	}
	return next[0] ?? null;
}

function exactWorkflowPageUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("GitHub workflow-run Link URL is malformed");
	}
	const expectedPath = new URL(workflowRunsUrl(1)).pathname;
	const entries = [...url.searchParams];
	if (
		url.origin !== API_ORIGIN ||
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== "" ||
		url.pathname !== expectedPath ||
		entries.length !== 2 ||
		url.searchParams.getAll("per_page").length !== 1 ||
		url.searchParams.get("per_page") !== "100" ||
		url.searchParams.getAll("page").length !== 1 ||
		!ID_PATTERN.test(url.searchParams.get("page"))
	) {
		throw new TypeError("GitHub workflow-run Link URL is not trusted");
	}
	return url.href;
}

function normalizeAttestationResult(value) {
	if (containsProxy(value))
		throw new TypeError("Attestation evidence is malformed");
	let snapshot;
	try {
		snapshot = snapshotJson(value);
	} catch {
		throw new TypeError("Attestation evidence is malformed");
	}
	if (
		!isPlainRecord(snapshot) ||
		!hasExactKeys(snapshot, ["status", "subjects"]) ||
		!["VERIFIED", "INVALID"].includes(snapshot.status) ||
		!Array.isArray(snapshot.subjects) ||
		snapshot.subjects.length > 22 ||
		(snapshot.status === "INVALID" && snapshot.subjects.length !== 0)
	) {
		throw new TypeError("Attestation evidence is malformed");
	}
	const names = new Set();
	const subjects = snapshot.subjects.map((subject) => {
		if (
			!isPlainRecord(subject) ||
			!hasExactKeys(subject, ["name", "sha256"]) ||
			!safeBoundedString(subject.name, 256) ||
			!/^[0-9a-f]{64}$/u.test(subject.sha256) ||
			names.has(subject.name)
		) {
			throw new TypeError("Attestation subject evidence is malformed");
		}
		names.add(subject.name);
		return { name: subject.name, sha256: subject.sha256 };
	});
	return deepFreeze({ status: snapshot.status, subjects });
}

function containsProxy(value, seen = new Set()) {
	if (value === null || typeof value !== "object" || seen.has(value))
		return false;
	if (utilTypes.isProxy(value)) return true;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (isEnumerableData(descriptor) && containsProxy(descriptor.value, seen))
			return true;
	}
	return false;
}

function hasExactKeys(value, expected) {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return (
		actual.length === sortedExpected.length &&
		actual.every((name, index) => name === sortedExpected[index])
	);
}

function githubFetch(fetchImpl) {
	const authorizedDownloadHops = new Set();
	return async (url, init) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			throw new TypeError("GitHub request URL is invalid");
		}
		const apiRequest = parsed.origin === API_ORIGIN;
		const authorizedDownloadHop =
			!apiRequest && authorizedDownloadHops.delete(parsed.href);
		if (
			parsed.protocol !== "https:" ||
			parsed.username !== "" ||
			parsed.password !== "" ||
			parsed.hash !== "" ||
			(!apiRequest && !authorizedDownloadHop)
		) {
			throw new TypeError("GitHub request origin is not trusted");
		}
		const headerEntries = Object.entries(init.headers ?? {});
		const forwardedHeaders = authorizedDownloadHop
			? Object.fromEntries(
					headerEntries.filter(
						([name]) => name.toLowerCase() !== "authorization",
					),
				)
			: { ...init.headers };
		const response = await fetchImpl(parsed.href, {
			...init,
			headers: { ...forwardedHeaders, "User-Agent": USER_AGENT },
		});
		if (apiRequest) {
			authorizeProductionDownloadHop(
				parsed,
				init,
				response,
				authorizedDownloadHops,
			);
			return enforcePaginationLinkGraph(response, parsed);
		}
		return response;
	};
}

function authorizeProductionDownloadHop(
	requestUrl,
	init,
	response,
	authorizedDownloadHops,
) {
	const headers = Object.entries(init.headers ?? {});
	if (
		init.method !== "GET" ||
		init.redirect !== "manual" ||
		requestUrl.search !== "" ||
		headers.length !== 3 ||
		exactHeaderValue(headers, "accept") !== "application/octet-stream" ||
		exactHeaderValue(headers, "x-github-api-version") !== API_VERSION ||
		!/^Bearer [^\s]+$/u.test(
			exactHeaderValue(headers, "authorization") ?? "",
		) ||
		!/^\/repos\/cacheplane\/dawnai\/releases\/assets\/[1-9][0-9]*$/u.test(
			requestUrl.pathname,
		)
	) {
		return;
	}
	let status;
	let location;
	try {
		status = response?.status;
		location = response?.headers?.get("location");
	} catch {
		return;
	}
	if (
		status !== 302 ||
		typeof location !== "string" ||
		location.length === 0 ||
		Buffer.byteLength(location, "utf8") > MAX_LINK_HEADER_BYTES
	) {
		return;
	}
	const normalized = normalizedAbsoluteUrl(location);
	if (normalized !== null) authorizedDownloadHops.add(normalized);
}

function exactHeaderValue(entries, expectedName) {
	const matches = entries.filter(
		([name]) => name.toLowerCase() === expectedName,
	);
	return matches.length === 1 && typeof matches[0][1] === "string"
		? matches[0][1]
		: null;
}

function enforcePaginationLinkGraph(response, requestUrl) {
	let link;
	try {
		link = response?.headers?.get("link");
	} catch {
		return response;
	}
	if (link === null || validPaginationLinkGraph(link, requestUrl))
		return response;
	try {
		const headers = new Headers(response.headers);
		headers.set("Link", "malformed");
		return { status: response.status, headers, body: response.body };
	} catch {
		return response;
	}
}

function validPaginationLinkGraph(value, requestUrl) {
	const graph = exactLinkGraph(value);
	if (graph === null) return false;
	const relations = new Set();
	const targetRelations = new Map();
	for (const entry of graph) {
		const url = normalizedAbsoluteUrl(entry.url);
		if (
			url === null ||
			relations.has(entry.relation) ||
			(entry.relation !== "next" &&
				exactPaginationLinkUrl(url, requestUrl) === null)
		) {
			return false;
		}
		relations.add(entry.relation);
		addTargetRelation(targetRelations, url, entry.relation);
	}
	return hasCompatibleSharedLinkTargets(targetRelations);
}

function addTargetRelation(targetRelations, url, relation) {
	const relations = targetRelations.get(url) ?? new Set();
	relations.add(relation);
	targetRelations.set(url, relations);
}

function hasCompatibleSharedLinkTargets(targetRelations) {
	for (const relations of targetRelations.values()) {
		if (relations.size === 1) continue;
		if (
			relations.size !== 2 ||
			!(
				(relations.has("next") && relations.has("last")) ||
				(relations.has("prev") && relations.has("first"))
			)
		) {
			return false;
		}
	}
	return true;
}

function normalizedAbsoluteUrl(value) {
	try {
		return new URL(value).href;
	} catch {
		return null;
	}
}

function exactLinkGraph(value) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value, "utf8") > MAX_LINK_HEADER_BYTES
	) {
		return null;
	}
	const entries = [];
	for (const part of value.split(",")) {
		const match =
			/^\s*<([^<>\s]+)>\s*;\s*rel="([A-Za-z][A-Za-z0-9._ -]*)"\s*$/u.exec(part);
		if (match === null) return null;
		const relations = match[2].split(/ +/u);
		if (
			relations.length !== 1 ||
			!PAGINATION_RELATIONS.has(relations[0]) ||
			!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(relations[0])
		) {
			return null;
		}
		entries.push({ url: match[1], relation: relations[0] });
	}
	return entries.length === 0 ? null : entries;
}

function exactPaginationLinkUrl(value, requestUrl) {
	try {
		const url = new URL(value);
		const current = new URL(requestUrl);
		if (
			url.origin !== API_ORIGIN ||
			url.protocol !== "https:" ||
			url.username !== "" ||
			url.password !== "" ||
			url.hash !== "" ||
			url.pathname !== current.pathname
		) {
			return null;
		}
		const currentQuery = uniqueQuery(current.searchParams);
		const linkQuery = uniqueQuery(url.searchParams);
		if (
			currentQuery === null ||
			linkQuery === null ||
			linkQuery.size !==
				currentQuery.size + (currentQuery.has("page") ? 0 : 1) ||
			linkQuery.get("per_page") !== "100" ||
			!ID_PATTERN.test(linkQuery.get("page"))
		) {
			return null;
		}
		for (const [name, queryValue] of currentQuery) {
			if (name !== "page" && linkQuery.get(name) !== queryValue) return null;
		}
		return url.href;
	} catch {
		return null;
	}
}

function uniqueQuery(searchParams) {
	const values = new Map();
	for (const [name, value] of searchParams) {
		if (values.has(name)) return null;
		values.set(name, value);
	}
	return values;
}

function githubHeaders(token) {
	return {
		Accept: JSON_ACCEPT,
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": API_VERSION,
		"User-Agent": USER_AGENT,
	};
}

function normalizedGitHubEnvelope(value, operation, payloadKey) {
	return deepFreeze(
		normalizeAdapterEnvelope(value, {
			source: "github",
			operation,
			payloadKey,
		}),
	);
}

function presentValue(value, operation) {
	const result = normalizedGitHubEnvelope(value, operation, "value");
	if (result.status !== "PRESENT") {
		throw new Error(`GitHub ${operation} read failed closed`);
	}
	return result.value;
}

function rejectDuplicateIds(value, operation, code) {
	const result = normalizedGitHubEnvelope(value, operation, "value");
	if (result.status !== "PRESENT") return result;
	if (!Array.isArray(result.value)) {
		return deepFreeze({
			status: "ERROR",
			operation,
			httpStatus: result.httpStatus,
			code: "MALFORMED_SCHEMA",
		});
	}
	const ids = new Set();
	for (const record of result.value) {
		let id;
		try {
			id = canonicalId(record?.id);
		} catch {
			return deepFreeze({
				status: "ERROR",
				operation,
				httpStatus: result.httpStatus,
				code: "MALFORMED_SCHEMA",
			});
		}
		if (ids.has(id)) {
			return deepFreeze({
				status: "ERROR",
				operation,
				httpStatus: result.httpStatus,
				code,
			});
		}
		ids.add(id);
	}
	return result;
}

async function resolveGhToken({ cwd, environment, run }) {
	let result;
	try {
		result = await executeExact(run, "gh", ["auth", "token"], {
			cwd,
			env: environment,
		});
	} catch {
		throw new Error("GitHub authentication token resolution failed");
	}
	if (Buffer.byteLength(result.stdout, "utf8") > MAX_TOKEN_BYTES + 2) {
		throw new TypeError("GitHub authentication token output is invalid");
	}
	const raw = result.stdout.endsWith("\r\n")
		? result.stdout.slice(0, -2)
		: result.stdout.endsWith("\n")
			? result.stdout.slice(0, -1)
			: result.stdout;
	return canonicalToken(raw);
}

async function executeExact(run, command, args, options) {
	let result;
	try {
		result = await run(command, [...args], {
			cwd: options.cwd,
			env: { ...options.env },
		});
	} catch {
		throw new Error("Bounded adapter command failed");
	}
	const value = exactDataOptions(
		result,
		new Set(["exitCode", "stdout", "stderr"]),
		"Adapter command result",
	);
	if (
		!Number.isSafeInteger(value.exitCode) ||
		value.exitCode !== 0 ||
		typeof value.stdout !== "string" ||
		typeof value.stderr !== "string"
	) {
		throw new TypeError("Adapter command result is malformed");
	}
	return value;
}

function deleteDeadline(timeoutMs, callerSignal) {
	const controller = new AbortController();
	let rejectAbort;
	const abortPromise = new Promise((_resolve, reject) => {
		rejectAbort = reject;
	});
	let settled = false;
	const abort = () => {
		if (settled) return;
		settled = true;
		controller.abort();
		rejectAbort(new Error("Delete deadline expired"));
	};
	const onCallerAbort = () => abort();
	callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
	const timer = setTimeout(abort, timeoutMs);
	return {
		signal: controller.signal,
		race(promise) {
			return Promise.race([Promise.resolve(promise), abortPromise]);
		},
		dispose() {
			settled = true;
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", onCallerAbort);
		},
	};
}

async function deleteResponse(response, deadline) {
	if (
		utilTypes.isProxy(response) ||
		response === null ||
		typeof response !== "object"
	) {
		throw new TypeError("GitHub DELETE response is malformed");
	}
	let status;
	let headers;
	let body;
	try {
		status = response.status;
		headers = response.headers;
		body = response.body;
	} catch {
		throw new TypeError("GitHub DELETE response is malformed");
	}
	const malformed =
		!Number.isInteger(status) ||
		status < 100 ||
		status > 599 ||
		headers === null ||
		typeof headers !== "object" ||
		typeof headers.get !== "function";
	await cancelDeleteResponseBody(body, deadline);
	if (malformed) {
		throw new TypeError("GitHub DELETE response is malformed");
	}
	return { status };
}

async function cancelDeleteResponseBody(body, deadline) {
	if (body === null) return;
	if (utilTypes.isProxy(body) || typeof body !== "object") {
		throw new TypeError("GitHub DELETE response body is malformed");
	}
	let cancel;
	try {
		cancel = body.cancel;
	} catch {
		throw new TypeError("GitHub DELETE response body is malformed");
	}
	if (typeof cancel !== "function" || utilTypes.isProxy(cancel)) {
		throw new TypeError("GitHub DELETE response body is malformed");
	}
	try {
		await deadline.race(Promise.resolve().then(() => cancel.call(body)));
	} catch {
		throw new Error("GitHub DELETE response body cancellation failed closed");
	}
}

function deleteOutcome(classification, httpStatus, observedAt) {
	return deepFreeze({
		classification,
		httpStatus,
		observedAt,
	});
}

function callClock(now) {
	try {
		return now();
	} catch {
		throw new TypeError("Adapter clock is invalid");
	}
}

function canonicalTimestamp(value) {
	if (
		typeof value !== "string" ||
		!TIMESTAMP_PATTERN.test(value) ||
		Number.isNaN(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) {
		throw new TypeError("Adapter clock timestamp is invalid");
	}
	return value;
}

function canonicalToken(value) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES ||
		hasControlCharacters(value) ||
		/\s/u.test(value)
	) {
		throw new TypeError("GitHub authentication token is invalid");
	}
	return value;
}

function canonicalId(value) {
	const normalized =
		Number.isSafeInteger(value) && value > 0 ? String(value) : value;
	if (typeof normalized !== "string" || !ID_PATTERN.test(normalized)) {
		throw new TypeError(
			"Identifier must be a canonical positive decimal string",
		);
	}
	return normalized;
}

function canonicalStringId(value) {
	if (typeof value !== "string" || !ID_PATTERN.test(value)) {
		throw new TypeError(
			"Identifier must be a canonical positive decimal string",
		);
	}
	return value;
}

function normalizedRoot(value) {
	if (
		typeof value !== "string" ||
		!path.isAbsolute(value) ||
		path.resolve(value) !== value ||
		hasControlCharacters(value)
	) {
		throw new TypeError("Adapter root is invalid");
	}
	return value;
}

function snapshotEnvironment(value) {
	const input = ownDataObject(value, "Adapter environment");
	return snapshotEnvironmentFields(input);
}

function snapshotRuntimeEnvironment(value) {
	if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
		throw new TypeError("Runtime environment is invalid");
	}
	return snapshotEnvironmentFields(value, process.platform === "win32");
}

function snapshotEnvironmentFields(input, windowsRuntime = false) {
	const output = Object.create(null);
	const keys = Reflect.ownKeys(input);
	for (const key of keys) {
		if (typeof key !== "string")
			throw new TypeError("Adapter environment contains a symbol");
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!isEnumerableData(descriptor) || typeof descriptor.value !== "string") {
			throw new TypeError("Adapter environment contains an unsafe field");
		}
	}
	const logicalNames = new Set(
		keys.flatMap((key) => {
			const logicalName =
				typeof key === "string" ? asciiEnvironmentName(key) : null;
			return logicalName === null ? [] : [logicalName];
		}),
	);
	const windowsShaped =
		windowsRuntime ||
		[...WINDOWS_ENVIRONMENT_MARKERS].every((name) => logicalNames.has(name));
	for (const key of keys) {
		const value = Object.getOwnPropertyDescriptor(input, key).value;
		if (key === "GH_TOKEN" || key === "GITHUB_TOKEN") {
			output[key] = value;
			continue;
		}
		if (!windowsShaped) {
			if (SAFE_ENVIRONMENT_NAMES.has(key)) output[key] = value;
			continue;
		}
		const logicalName = asciiEnvironmentName(key);
		const canonicalName =
			logicalName === null
				? undefined
				: WINDOWS_SAFE_ENVIRONMENT_NAMES.get(logicalName);
		if (canonicalName === undefined) continue;
		if (
			Object.hasOwn(output, canonicalName) &&
			output[canonicalName] !== value
		) {
			throw new TypeError(
				"Adapter Windows environment contains conflicting aliases",
			);
		}
		output[canonicalName] = value;
	}
	return Object.freeze({ ...output });
}

function subprocessEnvironment(environment) {
	const output = Object.create(null);
	for (const name of SAFE_ENVIRONMENT_NAMES) {
		if (
			name !== "PATH" &&
			name !== "Path" &&
			typeof environment[name] === "string"
		) {
			output[name] = environment[name];
		}
	}
	if (typeof environment.PATH === "string") output.PATH = environment.PATH;
	else if (typeof environment.Path === "string") output.Path = environment.Path;
	output.NO_COLOR = "1";
	return Object.freeze({ ...output });
}

function asciiEnvironmentName(value) {
	return /^[A-Za-z_]+$/u.test(value) ? value.toUpperCase() : null;
}

function exactDataOptions(value, allowed, label) {
	const input = ownDataObject(value, label);
	const keys = Reflect.ownKeys(input);
	for (const key of keys) {
		if (typeof key !== "string" || !allowed.has(key)) {
			throw new TypeError(`${label} contains an unknown or symbol field`);
		}
		if (!isEnumerableData(Object.getOwnPropertyDescriptor(input, key))) {
			throw new TypeError(`${label} contains an accessor or hidden field`);
		}
	}
	const output = Object.create(null);
	for (const key of keys) {
		output[key] = Object.getOwnPropertyDescriptor(input, key).value;
	}
	return Object.freeze({ ...output });
}

function ownDataObject(value, label) {
	if (
		utilTypes.isProxy(value) ||
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	) {
		throw new TypeError(`${label} must be a non-proxy plain object`);
	}
	return value;
}

function snapshotStringArray(value, label) {
	if (
		utilTypes.isProxy(value) ||
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	) {
		throw new TypeError(`${label} must be a plain array`);
	}
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1 || keys.at(-1) !== "length") {
		throw new TypeError(`${label} contains hidden, symbol, or sparse fields`);
	}
	const output = [];
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!isEnumerableData(descriptor) || typeof descriptor.value !== "string") {
			throw new TypeError(`${label} contains an accessor or invalid entry`);
		}
		output.push(descriptor.value);
	}
	return output;
}

function bindMethod(value, name, label) {
	const object = ownDataObject(value, label);
	const descriptor = Object.getOwnPropertyDescriptor(object, name);
	if (
		!isEnumerableData(descriptor) ||
		typeof descriptor.value !== "function" ||
		utilTypes.isProxy(descriptor.value)
	) {
		throw new TypeError(`${label} method ${name} is invalid`);
	}
	return async (...args) => descriptor.value.apply(object, args);
}

function dependencyFunction(dependencies, name, fallback) {
	if (!Object.hasOwn(dependencies, name)) return fallback;
	const value = dependencies[name];
	assertFunction(value, `Adapter dependency ${name}`);
	return value;
}

function requiredFunction(value, name, label) {
	const member = required(value, name, label);
	assertFunction(member, label);
	return member;
}

function assertFunction(value, label) {
	if (typeof value !== "function" || utilTypes.isProxy(value)) {
		throw new TypeError(`${label} is invalid`);
	}
}

function required(value, name, label) {
	if (!Object.hasOwn(value, name)) throw new TypeError(`${label} is required`);
	return value[name];
}

function requiredMember(value, name, label) {
	const object = ownDataObject(value, label);
	const descriptor = Object.getOwnPropertyDescriptor(object, name);
	if (!isEnumerableData(descriptor))
		throw new TypeError(`${label} member ${name} is invalid`);
	return descriptor.value;
}

function isEnumerableData(descriptor) {
	return (
		descriptor?.enumerable === true &&
		"value" in descriptor &&
		descriptor.get === undefined &&
		descriptor.set === undefined
	);
}

function isPlainRecord(value) {
	return (
		!utilTypes.isProxy(value) &&
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		[Object.prototype, null].includes(Object.getPrototypeOf(value))
	);
}

function safeLogin(value) {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value)
	);
}

function safeBoundedString(value, maximumBytes) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Buffer.byteLength(value, "utf8") <= maximumBytes &&
		!hasControlCharacters(value)
	);
}

function hasControlCharacters(value) {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
	});
}

function assertExactIncidentConfirmation(value, proposedEnvelope) {
	if (typeof value !== "string" || hasControlCharacters(value)) {
		throw new TypeError(
			"Task6 confirmation must be an exact control-free string",
		);
	}
	const { candidate, roles } = proposedEnvelope.record;
	const expected = `CONSOLIDATE ${candidate.version} ${candidate.commitSha} SURVIVOR ${roles.survivor} DELETE ${roles.duplicates.join(",")} PROPOSAL ${proposedEnvelope.recordSha256}`;
	if (value !== expected) {
		throw new Error("Task6 confirmation does not exactly bind the proposal");
	}
}

function assertTransitionAuthorityMatchesProposal(
	authority,
	proposal,
	targetReleaseId,
) {
	const expectedStage =
		targetReleaseId === DUPLICATE_IDS[0] ? "pre-delete-1" : "pre-delete-2";
	const stableTag = ({ observedAt: _observedAt, ...value }) => value;
	const stableWorkflow = ({ observedAt: _observedAt, ...value }) => value;
	if (
		authority.stage !== expectedStage ||
		!isDeepStrictEqual(authority.controller, proposal.controller) ||
		!isDeepStrictEqual(
			stableTag(authority.annotatedTag),
			stableTag(proposal.annotatedTag),
		) ||
		!isDeepStrictEqual(
			stableWorkflow(authority.workflowAuthority),
			stableWorkflow(proposal.workflowAuthority),
		) ||
		!isDeepStrictEqual(authority.payloadProof, proposal.payloadProof)
	) {
		throw new Error(
			"Task6 authority controller, tag, workflow, or payload differs from the proposal",
		);
	}
	for (const release of authority.releases) {
		const proposed = proposal.releases.find(({ id }) => id === release.id);
		if (proposed === undefined) {
			throw new Error("Task6 authority contains an unproposed Release");
		}
		assertEvidenceEqualsProposal(release, proposed);
	}
	if (
		authority.targetRead?.evidence.id !== targetReleaseId ||
		authority.npmInventory.stage !== expectedStage ||
		authority.npmInventory.packages.some(
			(entry) => entry.version !== proposal.candidate.version,
		)
	) {
		throw new Error(
			"Task6 authority target or npm evidence differs from the proposal",
		);
	}
}

function singleLine(value, label) {
	if (typeof value !== "string") throw new TypeError(`${label} is malformed`);
	const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
	if (
		!safeBoundedString(normalized, 1_024) ||
		normalized.includes("\n") ||
		normalized.includes("\r")
	) {
		throw new TypeError(`${label} is malformed`);
	}
	return normalized;
}

function assertAbortSignal(value) {
	if (
		utilTypes.isProxy(value) ||
		value === null ||
		typeof value !== "object" ||
		typeof value.aborted !== "boolean" ||
		typeof value.addEventListener !== "function" ||
		typeof value.removeEventListener !== "function"
	) {
		throw new TypeError("Delete abort signal is invalid");
	}
}

function safeStringArray(value) {
	return (
		Array.isArray(value) &&
		value.length <= 64 &&
		value.every(
			(entry) => typeof entry === "string" && !entry.includes("\u0000"),
		)
	);
}

function isSha(value) {
	return typeof value === "string" && SHA_PATTERN.test(value);
}

function boundedInteger(value, minimum, maximum, label) {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new TypeError(`${label} is invalid`);
	}
	return value;
}

function arraysEqual(left, right) {
	return (
		left.length === right.length &&
		left.every((entry, index) => entry === right[index])
	);
}

function BASE_URL() {
	return `${API_ORIGIN}/repos/${REPOSITORY}`;
}

function deepFreeze(value, seen = new Set()) {
	if (
		(typeof value !== "object" && typeof value !== "function") ||
		value === null ||
		seen.has(value)
	) {
		return value;
	}
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			descriptor !== undefined &&
			"value" in descriptor &&
			descriptor.enumerable
		) {
			deepFreeze(descriptor.value, seen);
		}
	}
	return Object.freeze(value);
}
