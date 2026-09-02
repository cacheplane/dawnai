import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, types as utilTypes } from "node:util";

import { captureNpmInventory } from "./duplicate-draft-consolidation-authority.mjs";
import { inspectEquivalentDrafts } from "./duplicate-draft-consolidation-evidence.mjs";
import { writePrivateEnvelope } from "./duplicate-draft-consolidation-files.mjs";
import { classifyConsolidationReleases } from "./duplicate-draft-consolidation-release-classifier.mjs";
import {
	canonicalConsolidationEnvelopeBytes,
	createConsolidationEnvelope,
} from "./duplicate-draft-consolidation-schema.mjs";

const REPOSITORY = Object.freeze({
	name: "cacheplane/dawnai",
	id: "1210070282",
	defaultBranch: "main",
	actor: Object.freeze({ login: "blove", id: "61436" }),
});
const CANDIDATE = Object.freeze({
	version: "0.8.22",
	commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
	tag: "v0.8.22",
});
const SURVIVOR = "379991871";
const DUPLICATES = Object.freeze(["379982100", "379986168"]);
const OUTPUT = ".dawn/release/duplicate-draft-consolidation.proposed.json";
const OBSERVATION_GAP_MS = 60_000;
const ROOT_GUARDS = new WeakMap();
const WORKFLOW_QUERY = deepFreeze({
	statuses: ["in_progress", "pending", "queued", "requested", "waiting"],
	perPage: 100,
	maximumPages: 100,
});

export async function inspectDuplicateDrafts(input, dependencies) {
	let context;
	try {
		context = normalizeInvocation(input, dependencies);
	} catch {
		throw new TypeError("Duplicate-draft inspection input is invalid.");
	}

	try {
		const rootGuard =
			context.repositoryRootIdentity ??
			(await captureRepositoryRoot(context.repositoryRoot));
		const initialMetadata = await captureMetadata(context);
		const initialInventory = await captureNpmInventory({
			stage: "inspect-initial",
			candidate: CANDIDATE,
			npm: context.adapters.npm,
			now: context.now,
		});
		const gapStartedAt = Date.parse(initialInventory.completedAt);

		const releases = await readReleaseEnumeration(context);
		const inspected = await inspectEquivalentDrafts({
			candidate: CANDIDATE,
			survivorId: SURVIVOR,
			duplicateIds: DUPLICATES,
			releases,
			github: context.adapters.github,
			attestations: context.adapters.attestations,
		});

		const afterVerification = timestamp(context.now, "inspection clock");
		const elapsed = Date.parse(afterVerification) - gapStartedAt;
		if (elapsed < 0) throw new Error("Inspection clock is not monotone");
		const remaining = Math.max(0, OBSERVATION_GAP_MS - elapsed);
		if (remaining > 0) {
			const signal = AbortSignal.timeout(remaining + 5_000);
			await context.wait(remaining, { signal });
		}
		const readyBoundary = timestamp(context.now, "ready boundary clock");
		if (Date.parse(readyBoundary) - gapStartedAt < OBSERVATION_GAP_MS) {
			throw new Error("Observation gap did not reach sixty seconds");
		}

		const readyInventory = await captureNpmInventory({
			stage: "inspect-ready",
			candidate: CANDIDATE,
			npm: context.adapters.npm,
			now: context.now,
		});
		if (
			Date.parse(readyInventory.startedAt) - gapStartedAt <
			OBSERVATION_GAP_MS
		) {
			throw new Error(
				"Ready inventory began before the observation gap closed",
			);
		}
		const finalReleaseEnumeration = await readReleaseEnumeration(context);
		const finalMetadata = await captureMetadata(context);
		assertStableMetadata(initialMetadata, finalMetadata);
		const preliminaryEnvelope = proposalEnvelope({
			metadata: finalMetadata,
			npmInventories: [initialInventory, readyInventory],
			releases: inspected.releases,
			payloadProof: inspected.payloadProof,
			inspectedAt: timestamp(context.now, "preliminary inspection clock"),
		});
		classifyConsolidationReleases(
			finalReleaseEnumeration,
			preliminaryEnvelope.record,
			"pre-delete-1",
		);
		const terminal = exactPlain(
			await context.adapters.captureInspectionTerminal({
				candidate: CANDIDATE,
				releases: inspected.releases,
			}),
			["releases", "completedAt"],
			"inspection terminal",
		);
		if (!Array.isArray(terminal.releases) || terminal.releases.length !== 3) {
			throw new Error("Inspection terminal evidence is incomplete");
		}
		terminal.completedAt = timestampValue(
			terminal.completedAt,
			"inspection terminal completion",
		);
		context.adapters.assertInspectionTerminalSealed();

		const envelope = proposalEnvelope({
			metadata: finalMetadata,
			npmInventories: [initialInventory, readyInventory],
			releases: terminal.releases,
			payloadProof: inspected.payloadProof,
			inspectedAt: terminal.completedAt,
		});
		const bytes = canonicalConsolidationEnvelopeBytes("proposed", envelope);
		const absoluteOutput = context.absoluteOutput;
		await revalidateRepositoryRoot(rootGuard);
		await writePrivateEnvelope(absoluteOutput, bytes);
		return deepFreeze({
			proposalSha256: envelope.recordSha256,
			version: CANDIDATE.version,
			commitSha: CANDIDATE.commitSha,
			survivor: SURVIVOR,
			duplicates: [...DUPLICATES],
			output: OUTPUT,
		});
	} catch {
		throw new Error("Duplicate-draft inspection failed.");
	}
}

Object.defineProperty(inspectDuplicateDrafts, "captureRepositoryRoot", {
	value: Object.freeze(captureRepositoryRoot),
	enumerable: false,
	writable: false,
	configurable: false,
});

async function readReleaseEnumeration(context) {
	const envelope = exactPlain(
		await context.adapters.github.listReleases(),
		["status", "operation", "httpStatus", "code", "value"],
		"Release enumeration",
	);
	if (
		envelope.status !== "PRESENT" ||
		envelope.operation !== "releases" ||
		envelope.httpStatus !== 200 ||
		envelope.code !== null ||
		!Array.isArray(envelope.value)
	) {
		throw new Error("Release enumeration is incomplete");
	}
	return envelope.value;
}

function proposalEnvelope({
	metadata,
	npmInventories,
	releases,
	payloadProof,
	inspectedAt,
}) {
	return createConsolidationEnvelope("proposed", {
		schemaVersion: 1,
		repository: metadata.repository,
		controller: metadata.controller,
		candidate: CANDIDATE,
		roles: { survivor: SURVIVOR, duplicates: DUPLICATES },
		confirmation: {
			version: CANDIDATE.version,
			commitSha: CANDIDATE.commitSha,
			survivor: SURVIVOR,
			duplicates: DUPLICATES,
			template: "<64-lowercase-hex-digest>",
		},
		annotatedTag: metadata.annotatedTag,
		workflowAuthority: metadata.workflowAuthority,
		npmInventories,
		releases,
		payloadProof,
		inspectedAt,
	});
}

async function captureMetadata(context) {
	const local = exactPlain(
		await context.adapters.local.readState(),
		["headSha", "branch", "porcelainStatus", "originMainSha"],
		"local checkout",
	);
	if (
		!/^[0-9a-f]{40}$/u.test(local.headSha) ||
		local.headSha === CANDIDATE.commitSha ||
		local.originMainSha === CANDIDATE.commitSha ||
		local.originMainSha !== local.headSha ||
		local.branch !== "main" ||
		local.porcelainStatus !== ""
	) {
		throw new Error("Local checkout authority is invalid");
	}

	const repository = exactPlain(
		await context.adapters.github.getRepository(),
		["name", "id", "defaultBranch"],
		"repository authority",
	);
	const actor = exactPlain(
		await context.adapters.github.getAuthenticatedUser(),
		["login", "id"],
		"actor authority",
	);
	if (!isDeepStrictEqual({ ...repository, actor }, REPOSITORY)) {
		throw new Error("Repository or actor authority is invalid");
	}
	const githubMainSha = await context.adapters.github.getDefaultBranchSha();
	if (
		githubMainSha === CANDIDATE.commitSha ||
		githubMainSha !== local.headSha
	) {
		throw new Error("GitHub main authority is invalid");
	}
	const workflow = exactPlain(
		await context.adapters.github.getWorkflowState(),
		["workflowId", "path", "state"],
		"workflow authority",
	);
	if (
		!/^[1-9][0-9]*$/u.test(workflow.workflowId) ||
		workflow.path !== ".github/workflows/release.yml" ||
		workflow.state !== "disabled_manually"
	) {
		throw new Error("Release workflow authority is invalid");
	}
	const runRead = exactPlain(
		await context.adapters.github.listNonterminalWorkflowRuns(WORKFLOW_QUERY),
		["query", "runs"],
		"workflow-run authority",
	);
	if (
		!isDeepStrictEqual(runRead.query, WORKFLOW_QUERY) ||
		!Array.isArray(runRead.runs) ||
		runRead.runs.length !== 0
	) {
		throw new Error("Release workflow has nonterminal runs");
	}
	const annotatedTag = exactPlain(
		await context.adapters.github.getAnnotatedTag({ name: CANDIDATE.tag }),
		["name", "objectSha", "targetSha", "objectType", "observedAt"],
		"annotated-tag authority",
	);
	if (
		annotatedTag.name !== CANDIDATE.tag ||
		!/^[0-9a-f]{40}$/u.test(annotatedTag.objectSha) ||
		annotatedTag.targetSha !== CANDIDATE.commitSha ||
		annotatedTag.objectType !== "tag"
	) {
		throw new Error("Annotated tag authority is invalid");
	}
	annotatedTag.observedAt = timestampValue(
		annotatedTag.observedAt,
		"tag timestamp",
	);
	const observedAt = timestamp(context.now, "workflow observation clock");
	return deepFreeze({
		repository: { ...repository, actor },
		controller: {
			headSha: local.headSha,
			originMainSha: local.originMainSha,
			githubMainSha,
		},
		annotatedTag,
		workflowAuthority: {
			...workflow,
			query: WORKFLOW_QUERY,
			nonterminalRuns: [],
			observedAt,
		},
	});
}

function assertStableMetadata(initial, final) {
	const stableInitial = structuredClone(initial);
	const stableFinal = structuredClone(final);
	delete stableInitial.annotatedTag.observedAt;
	delete stableFinal.annotatedTag.observedAt;
	delete stableInitial.workflowAuthority.observedAt;
	delete stableFinal.workflowAuthority.observedAt;
	if (!isDeepStrictEqual(stableInitial, stableFinal)) {
		throw new Error("Authority changed during the observation gap");
	}
}

function normalizeInvocation(input, dependencies) {
	const normalizedInput = exactPlain(
		input,
		["version", "commitSha", "survivor", "duplicates", "output"],
		"inspection input",
	);
	if (
		normalizedInput.version !== CANDIDATE.version ||
		normalizedInput.commitSha !== CANDIDATE.commitSha ||
		normalizedInput.survivor !== SURVIVOR ||
		normalizedInput.output !== OUTPUT ||
		!safeArrayEquals(normalizedInput.duplicates, DUPLICATES)
	) {
		throw new TypeError("Inspection does not identify the approved incident");
	}
	const normalizedDependencies = exactOptionalFields(
		dependencies,
		["repositoryRoot", "adapters", "now", "wait"],
		["repositoryRootIdentity"],
		"inspection dependencies",
	);
	if (
		typeof normalizedDependencies.repositoryRoot !== "string" ||
		!path.isAbsolute(normalizedDependencies.repositoryRoot) ||
		path.normalize(normalizedDependencies.repositoryRoot) !==
			normalizedDependencies.repositoryRoot
	) {
		throw new TypeError("Repository root is not canonical");
	}
	const adapters = bindAdapters(normalizedDependencies.adapters);
	const now = trustedClock(
		safeFunction(normalizedDependencies.now, "inspection clock"),
	);
	const wait = safeFunction(normalizedDependencies.wait, "inspection waiter");
	const repositoryRootIdentity = bindRepositoryRootIdentity(
		normalizedDependencies.repositoryRootIdentity,
		normalizedDependencies.repositoryRoot,
	);
	const absoluteOutput = path.join(
		normalizedDependencies.repositoryRoot,
		...OUTPUT.split("/"),
	);
	if (
		path.relative(normalizedDependencies.repositoryRoot, absoluteOutput) !==
			OUTPUT.split("/").join(path.sep) ||
		path.basename(absoluteOutput) !==
			"duplicate-draft-consolidation.proposed.json"
	) {
		throw new TypeError("Proposal output is outside the approved path");
	}
	return {
		adapters,
		now,
		wait,
		absoluteOutput,
		repositoryRootIdentity,
		repositoryRoot: normalizedDependencies.repositoryRoot,
	};
}

function bindAdapters(value) {
	if (!safeRecord(value) || !Object.isFrozen(value))
		throw new TypeError("Adapters are invalid");
	const names = Object.keys(value);
	if (
		!isDeepStrictEqual(names, [
			"local",
			"github",
			"npm",
			"attestations",
			"writer",
		])
	) {
		throw new TypeError("Adapter facade is not exact");
	}
	if (
		!isDeepStrictEqual(Object.getOwnPropertyNames(value), [
			...names,
			"captureConsolidationAuthority",
			"captureInspectionTerminal",
			"assertInspectionTerminalSealed",
		]) ||
		Object.getOwnPropertySymbols(value).length !== 0
	) {
		throw new TypeError("Adapter facade hidden fields are invalid");
	}
	const captureAuthority = hiddenAdapterMethod(
		value,
		"captureConsolidationAuthority",
	);
	const captureInspectionTerminal = hiddenAdapterMethod(
		value,
		"captureInspectionTerminal",
	);
	const assertInspectionTerminalSealed = hiddenAdapterMethod(
		value,
		"assertInspectionTerminalSealed",
	);
	const adapters = {
		local: bindFacade(
			dataValue(value, "local"),
			["readState"],
			"local adapter",
		),
		github: bindFacade(
			dataValue(value, "github"),
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
			"GitHub adapter",
		),
		npm: bindFacade(
			dataValue(value, "npm"),
			["observePackageVersion"],
			"npm adapter",
		),
		attestations: bindFacade(
			dataValue(value, "attestations"),
			["verify"],
			"attestation adapter",
		),
		writer: bindFacade(
			dataValue(value, "writer"),
			["deleteDuplicate"],
			"writer adapter",
		),
	};
	for (const [name, operation] of [
		["captureConsolidationAuthority", captureAuthority],
		["captureInspectionTerminal", captureInspectionTerminal],
		["assertInspectionTerminalSealed", assertInspectionTerminalSealed],
	]) {
		Object.defineProperty(adapters, name, {
			value: (...args) => Reflect.apply(operation, value, args),
			enumerable: false,
			writable: false,
			configurable: false,
		});
		Object.freeze(adapters[name]);
	}
	return Object.freeze(adapters);
}

function hiddenAdapterMethod(value, name) {
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (
		descriptor?.enumerable !== false ||
		descriptor.writable !== false ||
		descriptor.configurable !== false ||
		typeof descriptor.value !== "function" ||
		utilTypes.isProxy(descriptor.value) ||
		!Object.isFrozen(descriptor.value)
	) {
		throw new TypeError("Adapter hidden entrypoint is invalid");
	}
	return descriptor.value;
}

async function captureRepositoryRoot(repositoryRoot) {
	if (
		typeof repositoryRoot !== "string" ||
		!path.isAbsolute(repositoryRoot) ||
		path.normalize(repositoryRoot) !== repositoryRoot ||
		(await realpath(repositoryRoot)) !== repositoryRoot
	) {
		throw new Error("Repository root is not physically canonical");
	}
	const effectiveUserId = currentEffectiveUserId();
	const root = await captureDirectoryIdentity(
		repositoryRoot,
		effectiveUserId,
		false,
	);
	const dawnPath = path.join(repositoryRoot, ".dawn");
	const releasePath = path.join(dawnPath, "release");
	if (path.relative(repositoryRoot, releasePath) !== ".dawn/release") {
		throw new Error("Proposal directory is outside the repository root");
	}
	const dawn = await captureDirectoryIdentity(dawnPath, effectiveUserId, true);
	const release = await captureDirectoryIdentity(
		releasePath,
		effectiveUserId,
		true,
	);
	if (!dawn.exists && release.exists) {
		throw new Error("Proposal directory containment is invalid");
	}
	const capability = {};
	Object.defineProperty(capability, "toJSON", {
		value() {
			throw new TypeError("Repository-root identity cannot be serialized");
		},
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.freeze(capability.toJSON);
	Object.freeze(capability);
	ROOT_GUARDS.set(
		capability,
		Object.freeze({
			repositoryRoot,
			effectiveUserId,
			root,
			dawn,
			release,
		}),
	);
	return capability;
}

function bindRepositoryRootIdentity(value, repositoryRoot) {
	if (value === undefined) return undefined;
	const record =
		value !== null && typeof value === "object"
			? ROOT_GUARDS.get(value)
			: undefined;
	if (record === undefined || record.repositoryRoot !== repositoryRoot) {
		throw new TypeError("Repository-root identity is invalid");
	}
	return value;
}

async function revalidateRepositoryRoot(capability) {
	const record = ROOT_GUARDS.get(capability);
	if (record === undefined)
		throw new Error("Repository-root identity is invalid");
	if ((await realpath(record.repositoryRoot)) !== record.repositoryRoot) {
		throw new Error("Repository root changed before proposal publication");
	}
	await assertDirectoryIdentity(
		record.repositoryRoot,
		record.root,
		record.effectiveUserId,
	);
	const currentComponents = [];
	for (const [target, expected] of [
		[path.join(record.repositoryRoot, ".dawn"), record.dawn],
		[path.join(record.repositoryRoot, ".dawn", "release"), record.release],
	]) {
		if (expected.exists) {
			currentComponents.push([
				target,
				await assertDirectoryIdentity(target, expected, record.effectiveUserId),
			]);
			continue;
		}
		await assertDirectoryAbsent(target);
		await mkdir(target, { mode: 0o700 });
		currentComponents.push([
			target,
			await captureDirectoryIdentity(target, record.effectiveUserId, false),
		]);
	}
	await assertDirectoryIdentity(
		record.repositoryRoot,
		record.root,
		record.effectiveUserId,
	);
	for (const [target, identity] of currentComponents) {
		await assertDirectoryIdentity(target, identity, record.effectiveUserId);
	}
}

async function captureDirectoryIdentity(target, effectiveUserId, allowAbsent) {
	let status;
	try {
		status = await lstat(target, { bigint: true });
	} catch (error) {
		if (allowAbsent && error?.code === "ENOENT") {
			return Object.freeze({ exists: false });
		}
		throw error;
	}
	if (
		status.isSymbolicLink() ||
		!status.isDirectory() ||
		status.uid !== effectiveUserId ||
		(status.mode & 0o022n) !== 0n ||
		(await realpath(target)) !== target
	) {
		throw new Error("Repository path identity is unsafe");
	}
	const current = await lstat(target, { bigint: true });
	if (
		current.isSymbolicLink() ||
		!current.isDirectory() ||
		current.dev !== status.dev ||
		current.ino !== status.ino ||
		current.mode !== status.mode ||
		current.uid !== status.uid
	) {
		throw new Error("Repository path identity changed during validation");
	}
	return Object.freeze({
		exists: true,
		dev: current.dev,
		ino: current.ino,
		mode: current.mode,
		uid: current.uid,
	});
}

async function assertDirectoryIdentity(target, expected, effectiveUserId) {
	const observed = await captureDirectoryIdentity(
		target,
		effectiveUserId,
		false,
	);
	if (
		!expected.exists ||
		observed.dev !== expected.dev ||
		observed.ino !== expected.ino ||
		observed.mode !== expected.mode ||
		observed.uid !== expected.uid
	) {
		throw new Error("Repository path identity changed before publication");
	}
	return observed;
}

async function assertDirectoryAbsent(target) {
	try {
		await lstat(target, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	throw new Error("Repository path appeared before publication");
}

function currentEffectiveUserId() {
	if (typeof process.geteuid !== "function") {
		throw new Error("Repository owner identity is unavailable");
	}
	const value = process.geteuid();
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error("Repository owner identity is invalid");
	}
	return BigInt(value);
}

function bindFacade(value, methods, label) {
	if (
		!safeRecord(value) ||
		!Object.isFrozen(value) ||
		!isDeepStrictEqual([...Object.keys(value)].sort(), [...methods].sort()) ||
		!isDeepStrictEqual(
			[...Object.getOwnPropertyNames(value)].sort(),
			[...methods].sort(),
		) ||
		Object.getOwnPropertySymbols(value).length !== 0
	) {
		throw new TypeError(`${label} is invalid`);
	}
	const facade = {};
	for (const method of methods) {
		const operation = safeFunction(dataValue(value, method), `${label} method`);
		facade[method] = (...args) => Reflect.apply(operation, value, args);
	}
	return Object.freeze(facade);
}

function exactPlain(value, fields, label) {
	if (!safeRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
		throw new TypeError(`${label} must be a plain object`);
	}
	const names = Object.getOwnPropertyNames(value);
	if (!isDeepStrictEqual(names, fields))
		throw new TypeError(`${label} fields are invalid`);
	const output = {};
	for (const field of fields) output[field] = dataValue(value, field);
	return output;
}

function exactOptionalFields(value, fields, optionalFields, label) {
	if (!safeRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
		throw new TypeError(`${label} must be a plain object`);
	}
	const names = Object.getOwnPropertyNames(value);
	const expected = [
		...fields,
		...optionalFields.filter((field) => names.includes(field)),
	];
	if (!isDeepStrictEqual(names, expected))
		throw new TypeError(`${label} fields are invalid`);
	const output = {};
	for (const field of names) output[field] = dataValue(value, field);
	return output;
}

function dataValue(value, field) {
	const descriptor = Object.getOwnPropertyDescriptor(value, field);
	if (
		descriptor?.enumerable !== true ||
		!("value" in descriptor) ||
		descriptor.get !== undefined ||
		descriptor.set !== undefined
	) {
		throw new TypeError("Required data property is unsafe");
	}
	return descriptor.value;
}

function safeRecord(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		!utilTypes.isProxy(value) &&
		[Object.prototype, null].includes(Object.getPrototypeOf(value))
	);
}

function safeFunction(value, label) {
	if (typeof value !== "function" || utilTypes.isProxy(value))
		throw new TypeError(`${label} is invalid`);
	return value;
}

function safeArrayEquals(value, expected) {
	if (
		!Array.isArray(value) ||
		utilTypes.isProxy(value) ||
		value.length !== expected.length ||
		Object.getOwnPropertySymbols(value).length !== 0
	)
		return false;
	if (
		!isDeepStrictEqual(Object.getOwnPropertyNames(value), ["0", "1", "length"])
	)
		return false;
	return expected.every(
		(entry, index) => dataValue(value, String(index)) === entry,
	);
}

function timestamp(now, label) {
	return timestampValue(Reflect.apply(now, undefined, []), label);
}

function trustedClock(source) {
	let previous = null;
	const clock = () => {
		const value = timestampValue(
			Reflect.apply(source, undefined, []),
			"trusted inspection clock",
		);
		const current = Date.parse(value);
		if (previous !== null && current < previous) {
			throw new TypeError("Trusted inspection clock is not monotone");
		}
		previous = current;
		return value;
	};
	return Object.freeze(clock);
}

function timestampValue(value, label) {
	if (
		typeof value !== "string" ||
		!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(
			value,
		) ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new TypeError(`${label} is invalid`);
	}
	return value;
}

function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}
