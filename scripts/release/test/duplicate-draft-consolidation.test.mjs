import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectDuplicateDrafts } from "../duplicate-draft-consolidation.mjs";
import { captureDirectTargetRead } from "../duplicate-draft-consolidation-evidence.mjs";
import { parseConsolidationEnvelope } from "../duplicate-draft-consolidation-schema.mjs";
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs";
import {
	createDuplicateDraftConsolidationFixture,
	DUPLICATE_DRAFT_CANDIDATE,
	DUPLICATE_DRAFT_IDS,
	DUPLICATE_DRAFT_SURVIVOR_ID,
} from "./support/duplicate-draft-consolidation-fixture.mjs";

const OUTPUT = ".dawn/release/duplicate-draft-consolidation.proposed.json";
const BASE_TIME = Date.parse("2026-09-01T12:00:00.000Z");
const CONTROLLER_SHA = "b".repeat(40);

test("inspects the exact incident, observes the gap, and writes one canonical private proposal", async (t) => {
	const fixture = await inspectionFixture(t);
	const result = await inspectDuplicateDrafts(
		exactInput(),
		fixture.dependencies,
	);

	assert.deepEqual(result, {
		proposalSha256: result.proposalSha256,
		version: DUPLICATE_DRAFT_CANDIDATE.version,
		commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
		survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
		duplicates: [...DUPLICATE_DRAFT_IDS],
		output: OUTPUT,
	});
	assert.match(result.proposalSha256, /^[0-9a-f]{64}$/u);
	assert.equal(Object.isFrozen(result), true);
	assert.equal(Object.isFrozen(result.duplicates), true);
	assert.deepEqual(fixture.waits, [60_000]);
	assert.equal(fixture.releaseFixture.downloadCount, 135);
	assert.deepEqual(fixture.npmCalls, [
		...CANONICAL_RELEASE_PACKAGE_ORDER,
		...CANONICAL_RELEASE_PACKAGE_ORDER,
	]);

	const target = path.join(fixture.root, OUTPUT);
	const bytes = await readFile(target);
	const envelope = parseConsolidationEnvelope("proposed", bytes);
	assert.equal(envelope.recordSha256, result.proposalSha256);
	assert.deepEqual(
		envelope.record.npmInventories.map(({ stage }) => stage),
		["inspect-initial", "inspect-ready"],
	);
	assert.equal(
		Date.parse(envelope.record.npmInventories[1].startedAt) -
			Date.parse(envelope.record.npmInventories[0].completedAt),
		60_000,
	);
	assert.equal(
		envelope.record.confirmation.template,
		"<64-lowercase-hex-digest>",
	);
	assert.deepEqual(envelope.record.controller, {
		headSha: CONTROLLER_SHA,
		originMainSha: CONTROLLER_SHA,
		githubMainSha: CONTROLLER_SHA,
	});
	assert.deepEqual(
		envelope.record.releases.map(({ role, id }) => ({ role, id })),
		[
			{ role: "survivor", id: DUPLICATE_DRAFT_SURVIVOR_ID },
			{ role: "duplicate", id: DUPLICATE_DRAFT_IDS[0] },
			{ role: "duplicate", id: DUPLICATE_DRAFT_IDS[1] },
		],
	);
	assert.equal((await stat(target)).mode & 0o777, 0o600);
	assert.equal((await lstat(target)).isSymbolicLink(), false);
	assert.deepEqual(fixture.releaseFixture.operations.slice(-6), [
		`get:${DUPLICATE_DRAFT_SURVIVOR_ID}`,
		`list-assets:${DUPLICATE_DRAFT_SURVIVOR_ID}`,
		`get:${DUPLICATE_DRAFT_IDS[0]}`,
		`list-assets:${DUPLICATE_DRAFT_IDS[0]}`,
		`get:${DUPLICATE_DRAFT_IDS[1]}`,
		`list-assets:${DUPLICATE_DRAFT_IDS[1]}`,
	]);
	assert.deepEqual(
		fixture.events,
		expectedInspectionEvents(fixture.releaseFixture),
	);
	assert.equal(
		fixture.events.filter((event) => event.startsWith("download:")).length,
		135,
	);
	assert.equal(
		fixture.events.filter((event) => event.startsWith("attest:")).length,
		3,
	);
	assert.equal(
		fixture.events.filter((event) => event.startsWith("npm:initial:")).length,
		21,
	);
	assert.equal(
		fixture.events.filter((event) => event.startsWith("npm:ready:")).length,
		21,
	);
	assert.equal(
		fixture.events.filter((event) => event.startsWith("metadata:initial:"))
			.length,
		7,
	);
	assert.equal(
		fixture.events.filter((event) => event.startsWith("metadata:final:"))
			.length,
		7,
	);
	assert.equal(fixture.clockCallsAfterTerminal, 0);
	assert.throws(() => fixture.dependencies.now(), /terminal/iu);
	await assert.rejects(
		fixture.dependencies.adapters.github.getRepository(),
		/sealed|terminal/iu,
	);
});

test("uses verification work inside the gap and waits only the exact nonnegative remainder", async (t) => {
	const fixture = await inspectionFixture(t, { verificationMs: 61_000 });
	await inspectDuplicateDrafts(exactInput(), fixture.dependencies);
	assert.deepEqual(fixture.waits, []);

	const second = await inspectionFixture(t, { verificationMs: 17_250 });
	await inspectDuplicateDrafts(exactInput(), second.dependencies);
	assert.deepEqual(second.waits, [42_750]);
});

test("creates only the exact private proposal parent in a clean canonical repository", async (t) => {
	const fixture = await inspectionFixture(t, { makeReleaseDirectory: false });
	await inspectDuplicateDrafts(exactInput(), fixture.dependencies);
	assert.equal(
		(await stat(path.join(fixture.root, ".dawn"))).isDirectory(),
		true,
	);
	assert.equal(
		(await stat(path.join(fixture.root, ".dawn", "release"))).isDirectory(),
		true,
	);
	assert.equal(
		(await stat(path.join(fixture.root, OUTPUT))).mode & 0o777,
		0o600,
	);
});

test("rejects a symlinked repository root before any adapter, download, or write", async (t) => {
	const parent = await realpath(
		await mkdtemp(path.join(os.tmpdir(), "dawn-inspect-link-")),
	);
	t.after(() => rm(parent, { recursive: true, force: true }));
	const physical = path.join(parent, "physical");
	const linked = path.join(parent, "linked");
	await mkdir(physical);
	await symlink(physical, linked, "dir");
	const fixture = await inspectionFixture(t, {
		root: linked,
		makeReleaseDirectory: false,
	});
	await assert.rejects(
		inspectDuplicateDrafts(exactInput(), fixture.dependencies),
	);
	assert.deepEqual(fixture.events, []);
	assert.equal(fixture.releaseFixture.downloadCount, 0);
	await assert.rejects(() => lstat(path.join(physical, ".dawn")), {
		code: "ENOENT",
	});
});

test("seal validation precedes root revalidation and rejects a root replacement from the seal boundary", async (t) => {
	const parent = await realpath(
		await mkdtemp(path.join(os.tmpdir(), "dawn-inspect-race-")),
	);
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = path.join(parent, "checkout");
	const displaced = path.join(parent, "checkout-displaced");
	await mkdir(path.join(root, ".dawn", "release"), { recursive: true });
	const fixture = await inspectionFixture(t, {
		root,
		onSeal() {
			renameSync(root, displaced);
			mkdirSync(path.join(root, ".dawn", "release"), { recursive: true });
		},
	});
	await assert.rejects(
		inspectDuplicateDrafts(exactInput(), fixture.dependencies),
	);
	assert.equal(fixture.events.includes("write"), false);
	await assert.rejects(() => readFile(path.join(root, OUTPUT)), {
		code: "ENOENT",
	});
	await assert.rejects(() => readFile(path.join(displaced, OUTPUT)), {
		code: "ENOENT",
	});
});

test("rejects any injected post-root-validation hook before adapter calls", async (t) => {
	const fixture = await inspectionFixture(t);
	await assert.rejects(
		inspectDuplicateDrafts(exactInput(), {
			...fixture.dependencies,
			afterRootValidation() {
				assert.fail("post-root-validation hooks must be unreachable");
			},
		}),
	);
	assert.deepEqual(fixture.events, []);
});

test("rejects a retreating trusted clock without writing", async (t) => {
	const fixture = await inspectionFixture(t);
	let calls = 0;
	const dependencies = Object.freeze({
		...fixture.dependencies,
		now() {
			calls += 1;
			return new Date(BASE_TIME - calls).toISOString();
		},
	});
	await assert.rejects(inspectDuplicateDrafts(exactInput(), dependencies));
	await assert.rejects(() => readFile(path.join(fixture.root, OUTPUT)), {
		code: "ENOENT",
	});
});

test("rejects malformed incident input before any adapter or filesystem call", async (t) => {
	const variants = [
		{},
		{ ...exactInput(), version: "0.8.23" },
		{ ...exactInput(), survivor: 379991871 },
		{ ...exactInput(), duplicates: [...DUPLICATE_DRAFT_IDS].reverse() },
		{
			...exactInput(),
			duplicates: [DUPLICATE_DRAFT_IDS[0], DUPLICATE_DRAFT_IDS[0]],
		},
		{ ...exactInput(), output: `../${OUTPUT}` },
		{ ...exactInput(), output: path.resolve("/tmp/proposed.json") },
		{ ...exactInput(), extra: true },
		new Proxy(exactInput(), {}),
	];
	const accessor = exactInput();
	Object.defineProperty(accessor, "version", {
		enumerable: true,
		get() {
			throw new Error("secret accessor");
		},
	});
	variants.push(accessor);
	const hidden = exactInput();
	Object.defineProperty(hidden, "hidden", { value: true });
	variants.push(hidden);
	const symbol = exactInput();
	symbol[Symbol("hidden")] = true;
	variants.push(symbol);

	for (const input of variants) {
		let calls = 0;
		const fixture = await inspectionFixture(t);
		const adapters = Object.freeze({
			...fixture.dependencies.adapters,
			local: Object.freeze({
				async readState() {
					calls += 1;
					throw new Error("called");
				},
			}),
		});
		await assert.rejects(
			inspectDuplicateDrafts(
				input,
				Object.freeze({ ...fixture.dependencies, adapters }),
			),
		);
		assert.equal(calls, 0);
		await assert.rejects(() => readFile(path.join(fixture.root, OUTPUT)), {
			code: "ENOENT",
		});
	}
});

test("rejects unsafe dependencies and adapter descriptors before calls", async (t) => {
	const fixture = await inspectionFixture(t);
	const badAdapters = { ...fixture.dependencies.adapters };
	Object.defineProperty(badAdapters, "github", {
		enumerable: true,
		get() {
			throw new Error("credential body");
		},
	});
	const hiddenAdapters = { ...fixture.dependencies.adapters };
	Object.defineProperty(hiddenAdapters, "hidden", { value: true });
	Object.freeze(hiddenAdapters);
	const hiddenLocal = { ...fixture.dependencies.adapters.local };
	Object.defineProperty(hiddenLocal, "hidden", { value: true });
	Object.freeze(hiddenLocal);
	const hiddenLocalAdapters = replaceFacade(
		fixture.dependencies.adapters,
		"local",
		hiddenLocal,
	);
	for (const dependencies of [
		{ ...fixture.dependencies, extra: true },
		{
			...fixture.dependencies,
			repositoryRootIdentity: Object.freeze({}),
		},
		{ ...fixture.dependencies, adapters: badAdapters },
		{ ...fixture.dependencies, adapters: hiddenAdapters },
		{ ...fixture.dependencies, adapters: hiddenLocalAdapters },
		new Proxy(fixture.dependencies, {}),
	]) {
		await assert.rejects(
			inspectDuplicateDrafts(exactInput(), dependencies),
			(error) => {
				assert.doesNotMatch(String(error), /credential body/iu);
				return true;
			},
		);
	}
});

test("fails closed on changed authority or non-E404 npm evidence without writing", async (t) => {
	for (const mutation of ["dirty", "active-workflow", "published-package"]) {
		const fixture = await inspectionFixture(t, { mutation });
		await assert.rejects(
			inspectDuplicateDrafts(exactInput(), fixture.dependencies),
		);
		await assert.rejects(() => readFile(path.join(fixture.root, OUTPUT)), {
			code: "ENOENT",
		});
	}
});

test("rejects the historical candidate in every current-controller position before output effects", async (t) => {
	for (const candidateControllerField of ["local", "origin", "github"]) {
		const fixture = await inspectionFixture(t, {
			candidateControllerField,
			makeReleaseDirectory: false,
		});
		await assert.rejects(
			inspectDuplicateDrafts(exactInput(), fixture.dependencies),
		);
		assert.equal(fixture.events.includes("write"), false);
		assert.deepEqual(
			fixture.events,
			candidateControllerField === "github"
				? [
						"metadata:initial:local",
						"metadata:initial:repository",
						"metadata:initial:actor",
						"metadata:initial:main",
					]
				: ["metadata:initial:local"],
		);
		await assert.rejects(() => lstat(path.join(fixture.root, ".dawn")), {
			code: "ENOENT",
		});
	}
});

test("rejects authority and release drift between complete capture phases without writing", async (t) => {
	for (const lateMutation of [
		"controller",
		"repository",
		"workflow",
		"tag",
		"release",
	]) {
		const fixture = await inspectionFixture(t, { lateMutation });
		await assert.rejects(
			inspectDuplicateDrafts(exactInput(), fixture.dependencies),
		);
		assert.equal(fixture.events.includes("write"), false);
		await assert.rejects(() => readFile(path.join(fixture.root, OUTPUT)), {
			code: "ENOENT",
		});
	}
});

test("rejects a managed Release added or published during the observation gap", async (t) => {
	for (const lateRelease of ["extra-draft", "published"]) {
		const fixture = await inspectionFixture(t, { lateRelease });
		await assert.rejects(
			inspectDuplicateDrafts(exactInput(), fixture.dependencies),
		);
		await assert.rejects(() => readFile(path.join(fixture.root, OUTPUT)), {
			code: "ENOENT",
		});
		assert.equal(fixture.releaseListCalls, 2);
	}
});

test("rejects an unsafe existing output and a symlinked release directory", async (t) => {
	const fixture = await inspectionFixture(t);
	const target = path.join(fixture.root, OUTPUT);
	await writeFile(target, "unsafe existing output\n", { mode: 0o644 });
	const original = await readFile(target);
	await assert.rejects(
		inspectDuplicateDrafts(exactInput(), fixture.dependencies),
	);
	assert.deepEqual(await readFile(target), original);

	const linked = await inspectionFixture(t, { makeReleaseDirectory: false });
	const outside = await mkdtemp(
		path.join(os.tmpdir(), "dawn-inspect-outside-"),
	);
	t.after(() => rm(outside, { recursive: true, force: true }));
	await mkdir(path.join(linked.root, ".dawn"), { recursive: true });
	await symlink(outside, path.join(linked.root, ".dawn", "release"), "dir");
	await assert.rejects(
		inspectDuplicateDrafts(exactInput(), linked.dependencies),
	);
	assert.deepEqual(linked.events, []);
	assert.equal(linked.releaseFixture.downloadCount, 0);
	await assert.rejects(
		() => readFile(path.join(outside, path.basename(OUTPUT))),
		{
			code: "ENOENT",
		},
	);
});

test("redacts remote diagnostics and never returns raw evidence", async (t) => {
	const fixture = await inspectionFixture(t, {
		remoteError: "token ghp_secret response body",
	});
	await assert.rejects(
		inspectDuplicateDrafts(exactInput(), fixture.dependencies),
		(error) => {
			assert.equal(error.message, "Duplicate-draft inspection failed.");
			assert.doesNotMatch(String(error), /ghp_secret|response body/iu);
			return true;
		},
	);
});

function replaceFacade(adapters, name, facade) {
	const replacement = { ...adapters, [name]: facade };
	Object.defineProperty(
		replacement,
		"captureConsolidationAuthority",
		Object.getOwnPropertyDescriptor(adapters, "captureConsolidationAuthority"),
	);
	return Object.freeze(replacement);
}

function exactInput() {
	return {
		version: DUPLICATE_DRAFT_CANDIDATE.version,
		commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
		survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
		duplicates: [...DUPLICATE_DRAFT_IDS],
		output: OUTPUT,
	};
}

function expectedInspectionEvents(releaseFixture) {
	const metadata = (phase) =>
		["local", "repository", "actor", "main", "workflow", "runs", "tag"].map(
			(operation) => `metadata:${phase}:${operation}`,
		);
	const hydration = releaseFixture.releases.flatMap((release) => [
		...release.assets.map((asset) => `download:${release.id}:${asset.id}`),
		`attest:${release.id}`,
	]);
	const terminalReads = [
		DUPLICATE_DRAFT_SURVIVOR_ID,
		...DUPLICATE_DRAFT_IDS,
	].flatMap((releaseId) => [`get:${releaseId}`, `list-assets:${releaseId}`]);
	return [
		...metadata("initial"),
		...CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => `npm:initial:${name}`),
		"releases:initial",
		...hydration,
		"wait:60000",
		...CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => `npm:ready:${name}`),
		"releases:final",
		...metadata("final"),
		...terminalReads,
	];
}

async function inspectionFixture(t, options = {}) {
	const root =
		options.root ??
		(await realpath(await mkdtemp(path.join(os.tmpdir(), "dawn-inspect-"))));
	if (options.root === undefined)
		t.after(() => rm(root, { recursive: true, force: true }));
	if (options.makeReleaseDirectory !== false)
		await mkdir(path.join(root, ".dawn", "release"), { recursive: true });
	const releaseFixture = createDuplicateDraftConsolidationFixture();
	const events = [];
	const npmCalls = [];
	const waits = [];
	let releaseListCalls = 0;
	let metadataPhase = "initial";
	let attestationCalls = 0;
	let terminalComplete = false;
	let clockCallsAfterTerminal = 0;
	let nowMs = BASE_TIME;
	const now = () => {
		if (terminalComplete) {
			clockCallsAfterTerminal += 1;
			throw new Error("injected clock rejected after terminal completion");
		}
		return new Date(nowMs).toISOString();
	};
	const assertNetworkOpen = () => {
		if (terminalComplete) throw new Error("adapter rejected by terminal seal");
	};
	const localState = {
		headSha:
			options.candidateControllerField === "local"
				? DUPLICATE_DRAFT_CANDIDATE.commitSha
				: CONTROLLER_SHA,
		branch: "main",
		porcelainStatus: options.mutation === "dirty" ? " M package.json" : "",
		originMainSha:
			options.candidateControllerField === "origin"
				? DUPLICATE_DRAFT_CANDIDATE.commitSha
				: CONTROLLER_SHA,
	};
	const adapters = {
		local: Object.freeze({
			async readState() {
				assertNetworkOpen();
				events.push(`metadata:${metadataPhase}:local`);
				if (
					metadataPhase === "final" &&
					options.lateMutation === "controller"
				) {
					return {
						...structuredClone(localState),
						headSha: "c".repeat(40),
						originMainSha: "c".repeat(40),
					};
				}
				return structuredClone(localState);
			},
		}),
		github: Object.freeze({
			async getRepository() {
				assertNetworkOpen();
				events.push(`metadata:${metadataPhase}:repository`);
				if (options.remoteError) throw new Error(options.remoteError);
				if (
					metadataPhase === "final" &&
					options.lateMutation === "repository"
				) {
					return {
						name: "cacheplane/dawnai",
						id: "1210070283",
						defaultBranch: "main",
					};
				}
				return {
					name: "cacheplane/dawnai",
					id: "1210070282",
					defaultBranch: "main",
				};
			},
			async getAuthenticatedUser() {
				assertNetworkOpen();
				events.push(`metadata:${metadataPhase}:actor`);
				return { login: "blove", id: "61436" };
			},
			async getDefaultBranchSha() {
				assertNetworkOpen();
				events.push(`metadata:${metadataPhase}:main`);
				return metadataPhase === "final" &&
					options.lateMutation === "controller"
					? "c".repeat(40)
					: options.candidateControllerField === "github"
						? DUPLICATE_DRAFT_CANDIDATE.commitSha
						: CONTROLLER_SHA;
			},
			async getWorkflowState() {
				assertNetworkOpen();
				events.push(`metadata:${metadataPhase}:workflow`);
				return {
					workflowId: "202458345",
					path: ".github/workflows/release.yml",
					state:
						options.mutation === "active-workflow" ||
						(metadataPhase === "final" && options.lateMutation === "workflow")
							? "active"
							: "disabled_manually",
				};
			},
			async listNonterminalWorkflowRuns(query) {
				assertNetworkOpen();
				events.push(`metadata:${metadataPhase}:runs`);
				return { query: structuredClone(query), runs: [] };
			},
			async getAnnotatedTag() {
				assertNetworkOpen();
				events.push(`metadata:${metadataPhase}:tag`);
				return {
					name: "v0.8.22",
					objectSha:
						metadataPhase === "final" && options.lateMutation === "tag"
							? "c".repeat(40)
							: "a".repeat(40),
					targetSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
					objectType: "tag",
					observedAt: now(),
				};
			},
			async listReleases() {
				assertNetworkOpen();
				releaseListCalls += 1;
				const phase = releaseListCalls === 1 ? "initial" : "final";
				events.push(`releases:${phase}`);
				nowMs += options.verificationMs ?? 0;
				const releases = structuredClone(releaseFixture.releases);
				if (releaseListCalls === 2 && options.lateRelease === "extra-draft") {
					const extra = structuredClone(releases[1]);
					extra.id = 379999999;
					extra.node_id = "RE_late_extra";
					extra.tag_name = "untagged-late-extra";
					for (const [index, asset] of extra.assets.entries()) {
						asset.id = 990_000 + index;
						asset.node_id = `RA_late_${index}`;
					}
					releases.push(extra);
				}
				if (releaseListCalls === 2 && options.lateRelease === "published") {
					releases[0].draft = false;
					releases[0].published_at = "2026-09-01T12:01:00Z";
				}
				if (phase === "final") metadataPhase = "final";
				return {
					status: "PRESENT",
					operation: "releases",
					httpStatus: 200,
					code: null,
					value: releases,
				};
			},
			async downloadReleaseAsset(request) {
				assertNetworkOpen();
				events.push(`download:${request.releaseId}:${request.assetId}`);
				return releaseFixture.github.downloadReleaseAsset(request);
			},
			async getRelease(request) {
				assertNetworkOpen();
				events.push(`get:${request.releaseId}`);
				const result = await releaseFixture.github.getRelease(request);
				if (options.lateMutation === "release")
					result.value.name = "changed after observation";
				return result;
			},
			async listReleaseAssets(request) {
				assertNetworkOpen();
				events.push(`list-assets:${request.releaseId}`);
				return releaseFixture.github.listReleaseAssets(request);
			},
		}),
		npm: Object.freeze({
			async observePackageVersion({ name }) {
				assertNetworkOpen();
				events.push(
					`npm:${npmCalls.length < CANONICAL_RELEASE_PACKAGE_ORDER.length ? "initial" : "ready"}:${name}`,
				);
				npmCalls.push(name);
				return options.mutation === "published-package"
					? {
							status: "PRESENT",
							operation: "package-version",
							httpStatus: 200,
							code: null,
						}
					: {
							status: "ABSENT",
							operation: "package-version",
							httpStatus: 404,
							code: "E404",
						};
			},
		}),
		attestations: Object.freeze({
			async verify(request) {
				assertNetworkOpen();
				const releaseId = [DUPLICATE_DRAFT_SURVIVOR_ID, ...DUPLICATE_DRAFT_IDS][
					attestationCalls
				];
				attestationCalls += 1;
				events.push(`attest:${releaseId}`);
				return releaseFixture.attestations.verify(request);
			},
		}),
		writer: Object.freeze({
			async deleteDuplicate() {
				assert.fail("inspection must not delete");
			},
		}),
	};
	Object.defineProperty(adapters, "captureConsolidationAuthority", {
		value: Object.freeze(async function captureConsolidationAuthority() {
			assert.fail("inspection must not capture delete authority");
		}),
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(adapters, "captureInspectionTerminal", {
		value: Object.freeze(async function captureInspectionTerminal(input) {
			assertNetworkOpen();
			const releases = [];
			for (const expectedEvidence of input.releases) {
				const read = await captureDirectTargetRead({
					candidate: input.candidate,
					releaseId: expectedEvidence.id,
					role: expectedEvidence.role,
					expectedEvidence,
					github: adapters.github,
					now,
				});
				releases.push(read.evidence);
			}
			await options.afterTerminal?.();
			const completedAt = new Date(nowMs).toISOString();
			terminalComplete = true;
			return Object.freeze({
				releases: Object.freeze(releases),
				completedAt,
			});
		}),
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(adapters, "assertInspectionTerminalSealed", {
		value: Object.freeze(function assertInspectionTerminalSealed() {
			if (!terminalComplete)
				throw new Error("inspection terminal is not sealed");
			options.onSeal?.();
		}),
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.freeze(adapters);
	const dependencies = Object.freeze({
		repositoryRoot: root,
		adapters,
		now,
		async wait(milliseconds, { signal }) {
			assert.equal(signal instanceof AbortSignal, true);
			assert.equal(signal.aborted, false);
			waits.push(milliseconds);
			events.push(`wait:${milliseconds}`);
			nowMs += milliseconds;
		},
	});
	return {
		root,
		releaseFixture,
		events,
		npmCalls,
		waits,
		get clockCallsAfterTerminal() {
			return clockCallsAfterTerminal;
		},
		get releaseListCalls() {
			return releaseListCalls;
		},
		dependencies,
	};
}
