import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGitReader } from "../adapters/git.mjs";
import { createNpmReader } from "../adapters/npm.mjs";
import { planRelease } from "../planner.mjs";
import { orderReleasePackages } from "../topology.mjs";
import {
	createFaultHarness,
	discoverFaultWorkspace,
} from "./support/fault-harness.mjs";
import { startFaultProxy } from "./support/fault-proxy.mjs";
import { createGitFixture } from "./support/git-fixture.mjs";
import { startVerdaccio } from "./support/verdaccio.mjs";

const FIXTURE_DIRECTORY = fileURLToPath(
	new URL("./fixtures/fault-workspace", import.meta.url),
);
const VERSION = "1.2.3";
const NEXT_VERSION = "1.2.4";
const FIXTURE_WORKSPACE = await readFixtureWorkspace(FIXTURE_DIRECTORY);
const PACKAGE_NAMES = FIXTURE_WORKSPACE.packages.map(({ name }) => name);

test("Verdaccio uses disposable loopback storage and releases its random port on failure cleanup", async () => {
	let registry;
	try {
		registry = await startVerdaccio();
		assert.match(registry.url, /^http:\/\/127\.0\.0\.1:\d+\/$/u);
		assert.equal((await fetch(registry.url)).status, 200);
		await access(registry.directory);
		throw new Error("synthetic test failure");
	} catch (error) {
		assert.equal(error.message, "synthetic test failure");
	} finally {
		const firstClose = registry?.close();
		const concurrentClose = registry?.close();
		assert.equal(firstClose, concurrentClose);
		await firstClose;
	}

	await assert.rejects(access(registry.directory), { code: "ENOENT" });
	await assert.rejects(
		fetch(registry.url, { signal: AbortSignal.timeout(500) }),
	);
	await registry.close();
});

test("the harness derives dependency order, publishes only locally, and preserves exact tarball bytes", async (t) => {
	const harness = await createFaultHarness({
		fixtureDirectory: FIXTURE_DIRECTORY,
	});
	t.after(() => harness.close());
	const workspace = FIXTURE_WORKSPACE;
	const expectedOrder = orderReleasePackages(workspace.packages, {
		gateOrder: workspace.gateOrder,
	}).map(({ name }) => name);

	const publication = await harness.packAndPublish();
	assert.deepEqual(
		publication.map(({ name }) => name),
		expectedOrder,
	);
	assert.deepEqual(expectedOrder, PACKAGE_NAMES);
	assert.ok(
		publication.every(
			({ registryUrl }) => registryUrl === harness.registry.url,
		),
	);

	const reader = createNpmReader({
		registryUrl: harness.registry.url,
		trustedRegistryOrigins: [new URL(harness.registry.url).origin],
	});
	for (const packed of publication) {
		const observed = await reader.observePackageVersion({
			name: packed.name,
			version: VERSION,
		});
		assert.equal(observed.status, "PRESENT");
		const downloaded = Buffer.from(
			await (await fetch(observed.package.tarballUrl)).arrayBuffer(),
		);
		assert.equal(sha256(downloaded), packed.sha256);
		assert.equal(sha256(await readFile(packed.tarballPath)), packed.sha256);
	}

	const thirdObservation = await Promise.all(
		publication.map(({ name }) =>
			reader.observePackageVersion({ name, version: VERSION }),
		),
	);
	assert.ok(thirdObservation.every(({ status }) => status === "PRESENT"));

	const disposableDirectories = [
		harness.runtimeDirectory,
		harness.registry.directory,
		harness.git.directory,
	];
	const proxyUrl = harness.proxy.url;
	await harness.close();
	for (const directory of disposableDirectories) {
		await assert.rejects(access(directory), { code: "ENOENT" });
	}
	await assert.rejects(fetch(proxyUrl, { signal: AbortSignal.timeout(500) }));
});

test("workspace discovery follows validated fixture data across nested paths and added packages", async (t) => {
	const directory = await mkdtemp(
		join(tmpdir(), "dawn-release-topology-test-"),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	await cp(FIXTURE_DIRECTORY, directory, { recursive: true });
	await mkdir(join(directory, "nested"));
	await rename(
		join(directory, "packages", "base"),
		join(directory, "nested", "foundation"),
	);
	await mkdir(join(directory, "independent"));
	await writeFile(
		join(directory, "independent", "package.json"),
		JSON.stringify({
			name: "@fault/alpha",
			version: VERSION,
			type: "module",
			main: "index.js",
			files: ["index.js"],
		}),
	);
	await writeFile(
		join(directory, "independent", "index.js"),
		"export const packageName = '@fault/alpha'\n",
	);
	const originalPolicy = JSON.parse(
		await readFile(join(directory, "fault-harness.json"), "utf8"),
	);
	await writeFile(
		join(directory, "fault-harness.json"),
		JSON.stringify({
			packageDirectories: [
				"packages/gate",
				"independent",
				"nested/foundation",
				"packages/middle",
			],
			gateOrder: originalPolicy.gateOrder,
		}),
	);
	const changesets = JSON.parse(
		await readFile(join(directory, ".changeset", "config.json")),
	);
	changesets.fixed = [
		[
			"@fault/middle",
			...originalPolicy.gateOrder,
			"@fault/alpha",
			"@fault/base",
		],
	];
	await writeFile(
		join(directory, ".changeset", "config.json"),
		JSON.stringify(changesets),
	);

	const discovered = await discoverFaultWorkspace({
		fixtureDirectory: directory,
	});
	const exactDirectory = await realpath(directory);
	assert.deepEqual(
		discovered.orderedPackages.map(({ name }) => name),
		[
			"@fault/alpha",
			"@fault/base",
			"@fault/middle",
			...originalPolicy.gateOrder,
		],
	);
	assert.deepEqual(
		discovered.orderedPackages.map(({ directory: packageDirectory }) =>
			relative(exactDirectory, packageDirectory),
		),
		["independent", "nested/foundation", "packages/middle", "packages/gate"],
	);
});

test("package subprocesses reject lifecycle probes and isolate hostile ambient credentials", async (t) => {
	const directory = await mkdtemp(
		join(tmpdir(), "dawn-release-package-env-test-"),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	await cp(FIXTURE_DIRECTORY, directory, { recursive: true });
	const probe = join(directory, "lifecycle-ran");
	const manifestPath = join(directory, "packages", "gate", "package.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.scripts = {
		prepack: `node -e "require('node:fs').writeFileSync('${probe}', 'ran')"`,
	};
	await writeFile(manifestPath, JSON.stringify(manifest));
	const hostile = {
		AWS_SECRET_ACCESS_KEY: "cloud-secret-value",
		COREPACK_HOME: "/forbidden/corepack-home",
		GITHUB_TOKEN: "github-secret-value",
		HOME: "/forbidden/home",
		HTTP_PROXY: "http://credential:http-proxy-secret@example.invalid",
		HTTPS_PROXY: "http://credential:proxy-secret@example.invalid",
		NODE_AUTH_TOKEN: "node-secret-value",
		NPM_TOKEN: "npm-secret-value",
		XDG_CACHE_HOME: "/forbidden/xdg-cache",
		XDG_CONFIG_HOME: "/forbidden/xdg-config",
		npm_config_registry: "https://registry.example.invalid/",
	};
	const inherited = installTemporaryEnvironment(hostile);
	let harness;
	try {
		harness = await createFaultHarness({ fixtureDirectory: directory });
		t.after(() => harness.close());
		await assert.rejects(harness.packAndPublish(), (error) => {
			assert.match(error.message, /prepack/u);
			assert.doesNotMatch(
				error.message,
				/cloud-secret-value|github-secret-value|proxy-secret|node-secret-value|npm-secret-value/u,
			);
			return true;
		});
		await assert.rejects(access(probe), { code: "ENOENT" });

		const workingManifestPath = join(
			harness.git.workingDirectory,
			"packages",
			"gate",
			"package.json",
		);
		const workingManifest = JSON.parse(
			await readFile(workingManifestPath, "utf8"),
		);
		delete workingManifest.scripts;
		await writeFile(workingManifestPath, JSON.stringify(workingManifest));
		const publication = await harness.packAndPublish();
		assert.ok(
			publication.every(
				({ registryUrl }) => registryUrl === harness.registry.url,
			),
		);
		await assert.rejects(access(probe), { code: "ENOENT" });
	} finally {
		restoreEnvironment(inherited);
	}
});

test("package tools accept validated non-default entry points and exact versions", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dawn-release-tools-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const pnpmMarker = join(directory, "pnpm-used");
	const npmMarker = join(directory, "npm-used");
	const nodeBin = dirname(process.execPath);
	const npmVersion = execFileSync(join(nodeBin, "npm"), ["--version"], {
		encoding: "utf8",
	}).trim();
	const tools = {
		pnpm: {
			executable: join(directory, "custom-pnpm"),
			version: "10.33.0",
		},
		npm: {
			executable: join(directory, "custom-npm"),
			version: npmVersion,
		},
	};
	await writeToolWrapper({
		path: tools.pnpm.executable,
		target: join(nodeBin, "corepack"),
		prefixArguments: ["pnpm"],
		marker: pnpmMarker,
	});
	await writeToolWrapper({
		path: tools.npm.executable,
		target: join(nodeBin, "npm"),
		prefixArguments: [],
		marker: npmMarker,
	});

	const harness = await createFaultHarness({
		fixtureDirectory: FIXTURE_DIRECTORY,
		packageTools: tools,
	});
	t.after(() => harness.close());
	await harness.packAndPublish();
	assert.equal((await readFile(pnpmMarker, "utf8")).length >= 3, true);
	assert.equal((await readFile(npmMarker, "utf8")).length >= 2, true);
});

test("package tool probes share the harness startup deadline", async (t) => {
	const directory = await mkdtemp(
		join(tmpdir(), "dawn-release-tool-deadline-"),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	const tools = {
		pnpm: {
			executable: join(directory, "delayed-pnpm"),
			version: "10.33.0",
		},
		npm: {
			executable: join(directory, "unused-npm"),
			version: "1.0.0",
		},
	};
	await writeFile(
		tools.pnpm.executable,
		'#!/usr/bin/env node\nsetTimeout(() => console.log("10.33.0"), 300)\n',
		{ mode: 0o755 },
	);
	await writeFile(
		tools.npm.executable,
		'#!/usr/bin/env node\nconsole.log("1.0.0")\n',
		{ mode: 0o755 },
	);
	const closed = { registry: false, proxy: false, git: false };
	let unexpectedHarness;
	const started = performance.now();
	try {
		await assert.rejects(
			createFaultHarness({
				fixtureDirectory: FIXTURE_DIRECTORY,
				startupTimeoutMs: 100,
				cleanupTimeoutMs: 100,
				packageTools: tools,
				dependencies: {
					async startVerdaccio() {
						return {
							url: "http://127.0.0.1:12345/",
							async close() {
								closed.registry = true;
							},
						};
					},
					async startFaultProxy() {
						return {
							async close() {
								closed.proxy = true;
							},
						};
					},
					async createGitFixture() {
						return {
							workingDirectory: FIXTURE_DIRECTORY,
							async close() {
								closed.git = true;
							},
						};
					},
				},
			}).then((harness) => {
				unexpectedHarness = harness;
				return harness;
			}),
			(error) => error.code === "PACKAGE_COMMAND_FAILED",
		);
	} finally {
		await unexpectedHarness?.close();
	}
	assert.ok(performance.now() - started < 250);
	assert.deepEqual(closed, { registry: true, proxy: true, git: true });
});

test("the production npm reader distinguishes exact absence and every deterministic proxy fault", async (t) => {
	const harness = await createFaultHarness({
		fixtureDirectory: FIXTURE_DIRECTORY,
	});
	t.after(() => harness.close());
	await harness.packAndPublish();
	const reader = createNpmReader({
		registryUrl: harness.proxy.url,
		trustedRegistryOrigins: [new URL(harness.proxy.url).origin],
		timeoutMs: 100,
	});

	harness.proxy.setMode("delayed-visibility", { misses: 1 });
	const delayedMissing = await reader.observePackageVersion({
		name: PACKAGE_NAMES[0],
		version: VERSION,
	});
	assert.equal(delayedMissing.status, "ABSENT");
	assert.equal(
		(
			await reader.observePackageVersion({
				name: PACKAGE_NAMES[0],
				version: VERSION,
			})
		).status,
		"PRESENT",
	);
	const visibleLatest = await reader.observePackageMetadata({
		name: PACKAGE_NAMES[0],
	});
	assertPlannerDisposition({
		exact: delayedMissing,
		latest: visibleLatest,
		blocked: false,
		candidateVersion: VERSION,
	});

	harness.proxy.setMode("exact-version-e404");
	const exactMissing = await reader.observePackageVersion({
		name: PACKAGE_NAMES[0],
		version: NEXT_VERSION,
	});
	assert.deepEqual(pickClassification(exactMissing), {
		status: "ABSENT",
		operation: "package-version",
		httpStatus: 404,
		code: "E404",
	});
	const latest = await reader.observePackageMetadata({
		name: PACKAGE_NAMES[0],
	});
	assert.equal(latest.status, "PRESENT");
	assert.equal(latest.metadata.latest, VERSION);
	assertPlannerDisposition({ exact: exactMissing, latest, blocked: false });

	harness.proxy.setMode("package-e404");
	const missingPackage = await reader.observePackageMetadata({
		name: PACKAGE_NAMES[0],
	});
	assert.deepEqual(pickClassification(missingPackage), {
		status: "AMBIGUOUS",
		operation: "package-metadata",
		httpStatus: 404,
		code: "E404",
	});
	const exactUnderPackageFault = await reader.observePackageVersion({
		name: PACKAGE_NAMES[0],
		version: NEXT_VERSION,
	});
	assertPlannerDisposition({
		exact: exactUnderPackageFault,
		latest: missingPackage,
		blocked: true,
	});

	const rows = [
		["unauthorized", "AMBIGUOUS", 401],
		["forbidden", "AMBIGUOUS", 403],
		["rate-limited", "AMBIGUOUS", 429],
		["malformed-json", "ERROR", 200],
		["server-error", "AMBIGUOUS", 500],
		["unavailable", "AMBIGUOUS", 503],
		["stall", "AMBIGUOUS", null],
	];
	for (const [mode, status, httpStatus] of rows) {
		harness.proxy.setMode(mode);
		const stalledClient =
			mode === "stall" ? harness.proxy.waitForNextAbort() : null;
		const observed = await reader.observePackageVersion({
			name: PACKAGE_NAMES[0],
			version: NEXT_VERSION,
		});
		assert.equal(observed.status, status, mode);
		assert.equal(observed.httpStatus, httpStatus, mode);
		assertPlannerDisposition({ exact: observed, latest: null, blocked: true });
		await stalledClient;
	}
	assert.ok(harness.proxy.snapshot().abortedRequests >= 1);
});

test("the fault proxy is loopback-only, has no network control endpoint, and resets in process", async (t) => {
	const registry = await startVerdaccio();
	const proxy = await startFaultProxy({ upstreamUrl: registry.url });
	t.after(async () => {
		await proxy.close();
		await registry.close();
	});
	assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+\/$/u);
	proxy.setMode("unauthorized");
	assert.equal(
		(await fetch(new URL("-/fault-control", proxy.url))).status,
		401,
	);
	proxy.reset();
	assert.notEqual(
		(await fetch(new URL("-/fault-control", proxy.url))).status,
		200,
	);
	assert.throws(() => proxy.setMode("arbitrary"), /fault mode/u);
	const firstClose = proxy.close();
	const concurrentClose = proxy.close();
	assert.equal(firstClose, concurrentClose);
	await firstClose;
});

test("fault proxy enforces one absolute streaming deadline and rejects truncated upstream bodies", async (t) => {
	const upstream = await startBoundedUpstream();
	const proxy = await startFaultProxy({
		upstreamUrl: upstream.url,
		forwardDeadlineMs: 75,
	});
	t.after(async () => {
		await proxy.close();
		await upstream.close();
	});

	const slowStarted = performance.now();
	await assert.rejects(
		fetch(new URL("slow", proxy.url), {
			signal: AbortSignal.timeout(2_000),
		}).then((response) => response.text()),
	);
	assert.ok(performance.now() - slowStarted < 1_000);

	const truncatedStarted = performance.now();
	await assert.rejects(
		fetch(new URL("truncated", proxy.url), {
			signal: AbortSignal.timeout(2_000),
		}).then((response) => response.text()),
	);
	assert.ok(performance.now() - truncatedStarted < 1_000);
	assert.equal(proxy.snapshot().activeForwards, 0);

	await proxy.close();
	assert.equal(proxy.snapshot().openSockets, 0);
	await upstream.close();
	assert.equal(upstream.openSockets(), 0);
});

test("harness close is concurrent-safe, bounded, and retries only incomplete resources", async () => {
	let registryCloseAttempts = 0;
	let proxyCloseAttempts = 0;
	let gitCloseAttempts = 0;
	let registryDirectory;
	let gitDirectory;
	const harness = await createFaultHarness({
		fixtureDirectory: FIXTURE_DIRECTORY,
		cleanupTimeoutMs: 75,
		dependencies: {
			async startVerdaccio() {
				const resource = await startVerdaccio();
				registryDirectory = resource.directory;
				return {
					...resource,
					async close() {
						registryCloseAttempts += 1;
						if (registryCloseAttempts === 1)
							throw new Error("injected registry close secret");
						await resource.close();
					},
				};
			},
			async startFaultProxy(options) {
				const resource = await startFaultProxy(options);
				return {
					...resource,
					close() {
						proxyCloseAttempts += 1;
						if (proxyCloseAttempts === 1) return new Promise(() => {});
						return resource.close();
					},
				};
			},
			async createGitFixture(options) {
				const resource = await createGitFixture(options);
				gitDirectory = resource.directory;
				return {
					...resource,
					async close() {
						gitCloseAttempts += 1;
						await resource.close();
					},
				};
			},
		},
	});
	const firstClose = harness.close();
	const concurrentClose = harness.close();
	assert.equal(firstClose, concurrentClose);
	await assert.rejects(firstClose, (error) => {
		assert.equal(error instanceof AggregateError, true);
		assert.doesNotMatch(error.message, /secret/u);
		return true;
	});
	assert.deepEqual(
		{ registryCloseAttempts, proxyCloseAttempts, gitCloseAttempts },
		{ registryCloseAttempts: 2, proxyCloseAttempts: 1, gitCloseAttempts: 1 },
	);

	await harness.close();
	assert.deepEqual(
		{ registryCloseAttempts, proxyCloseAttempts, gitCloseAttempts },
		{ registryCloseAttempts: 2, proxyCloseAttempts: 2, gitCloseAttempts: 1 },
	);
	await Promise.all([
		assert.rejects(access(registryDirectory), { code: "ENOENT" }),
		assert.rejects(access(gitDirectory), { code: "ENOENT" }),
		assert.rejects(access(harness.runtimeDirectory), { code: "ENOENT" }),
	]);
	await harness.close();
});

test("harness startup rollback closes each acquired resource and sanitizes cleanup failures", async () => {
	let registryDirectory;
	let closeAttempts = 0;
	await assert.rejects(
		createFaultHarness({
			fixtureDirectory: FIXTURE_DIRECTORY,
			cleanupTimeoutMs: 100,
			dependencies: {
				async startVerdaccio() {
					const resource = await startVerdaccio();
					registryDirectory = resource.directory;
					return {
						...resource,
						async close() {
							closeAttempts += 1;
							await resource.close();
							throw new Error("cleanup secret value");
						},
					};
				},
				async startFaultProxy() {
					throw Object.assign(new Error("startup secret value"), {
						code: "INJECTED_START",
					});
				},
				createGitFixture: assert.fail,
			},
		}),
		(error) => {
			assert.equal(error instanceof AggregateError, true);
			assert.equal(
				error.errors.some(({ code }) => code === "INJECTED_START"),
				true,
			);
			assert.doesNotMatch(
				`${error.message} ${error.errors.map(({ message }) => message)}`,
				/secret/u,
			);
			return true;
		},
	);
	assert.equal(closeAttempts, 2);
	await assert.rejects(access(registryDirectory), { code: "ENOENT" });
});

test("startup rollback retries a failed registry close within its shared cleanup budget", async () => {
	let registry;
	let closeAttempts = 0;
	await assert.rejects(
		createFaultHarness({
			fixtureDirectory: FIXTURE_DIRECTORY,
			cleanupTimeoutMs: 500,
			dependencies: {
				async startVerdaccio() {
					registry = await startVerdaccio();
					return {
						...registry,
						async close() {
							closeAttempts += 1;
							if (closeAttempts === 1)
								throw new Error("first close failed before delegation");
							await registry.close();
						},
					};
				},
				async startFaultProxy() {
					throw Object.assign(new Error("injected startup failure"), {
						code: "INJECTED_START",
					});
				},
				createGitFixture: assert.fail,
			},
		}),
		(error) => error.code === "INJECTED_START",
	);
	assert.equal(closeAttempts, 2);
	await assert.rejects(access(registry.directory), { code: "ENOENT" });
	await assert.rejects(
		fetch(registry.url, { signal: AbortSignal.timeout(500) }),
	);
});

test("harness startup deadline cleans resources that arrive after timeout", async () => {
	let registryClosed = false;
	let lateCloseAttempts = 0;
	let resolveLateClose;
	const lateClose = new Promise((resolve) => {
		resolveLateClose = resolve;
	});
	await assert.rejects(
		createFaultHarness({
			fixtureDirectory: FIXTURE_DIRECTORY,
			startupTimeoutMs: 25,
			cleanupTimeoutMs: 100,
			dependencies: {
				async startVerdaccio() {
					return {
						url: "http://127.0.0.1:12345/",
						async close() {
							registryClosed = true;
						},
					};
				},
				startFaultProxy() {
					return new Promise((resolve) => {
						setTimeout(
							() =>
								resolve({
									async close() {
										lateCloseAttempts += 1;
										if (lateCloseAttempts === 1)
											throw new Error("late close retry");
										resolveLateClose();
									},
								}),
							50,
						);
					});
				},
				createGitFixture: assert.fail,
			},
		}),
		(error) => error.code === "DEADLINE_EXCEEDED",
	);
	assert.equal(lateCloseAttempts, 2);
	await Promise.race([
		lateClose,
		new Promise((_, reject) =>
			setTimeout(
				() => reject(new Error("late startup cleanup did not run")),
				250,
			),
		),
	]);
	assert.equal(registryClosed, true);
});

test("the temporary Git fixture keeps identity local and production reads the advanced annotated tag", async (t) => {
	const hostileDirectory = await mkdtemp(join(tmpdir(), "dawn-hostile-git-"));
	t.after(() => rm(hostileDirectory, { recursive: true, force: true }));
	const hostileTemplate = join(hostileDirectory, "template");
	const hostileMarker = join(hostileDirectory, "hook-ran");
	await mkdir(join(hostileTemplate, "hooks"), { recursive: true });
	await writeFile(
		join(hostileTemplate, "hooks", "pre-commit"),
		`#!/bin/sh\nprintf ran > '${hostileMarker}'\n`,
		{ mode: 0o755 },
	);
	const hostileGitEnvironment = {
		GIT_DEFAULT_HASH: "sha256",
		GIT_DIR: "/dev/null",
		GIT_TEMPLATE_DIR: hostileTemplate,
	};
	const inheritedGitEnvironment = new Map(
		Object.keys(hostileGitEnvironment).map((name) => [
			name,
			Reflect.get(process.env, name),
		]),
	);
	for (const [name, value] of Object.entries(hostileGitEnvironment)) {
		Reflect.set(process.env, name, value);
	}
	let fixture;
	try {
		fixture = await createGitFixture({ sourceDirectory: FIXTURE_DIRECTORY });
	} finally {
		for (const [name, value] of inheritedGitEnvironment) {
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else Reflect.set(process.env, name, value);
		}
	}
	t.after(() => fixture.close());
	await assert.rejects(access(hostileMarker), { code: "ENOENT" });
	assert.match(fixture.oldCommitSha, /^[0-9a-f]{40}$/u);
	assert.match(fixture.mainCommitSha, /^[0-9a-f]{40}$/u);
	const reader = createGitReader({ root: fixture.workingDirectory });

	assert.equal(
		await reader.resolveTag({ tag: `v${VERSION}` }),
		fixture.oldCommitSha,
	);
	assert.equal(
		await reader.isAncestor({
			ancestor: fixture.oldCommitSha,
			descendant: fixture.mainCommitSha,
		}),
		true,
	);
	assert.deepEqual(
		await reader.listFirstParentHistory({ ref: "main", maxCount: 2 }),
		[fixture.mainCommitSha, fixture.oldCommitSha],
	);
	assert.equal(
		(
			await reader.listFirstParentHistory({ ref: "origin/main", maxCount: 1 })
		)[0],
		fixture.mainCommitSha,
	);
	assert.equal(
		(
			await readFile(
				new URL("config", `file://${fixture.workingDirectory}/.git/`),
				"utf8",
			)
		).includes(fixture.bareRemoteDirectory),
		true,
	);
	const localConfig = await readFile(
		new URL("config", `file://${fixture.workingDirectory}/.git/`),
		"utf8",
	);
	assert.match(localConfig, /name = Release Fault Fixture/u);
	assert.match(localConfig, /email = fault@example\.invalid/u);

	const repeated = await createGitFixture({
		sourceDirectory: FIXTURE_DIRECTORY,
	});
	t.after(() => repeated.close());
	assert.equal(repeated.oldCommitSha, fixture.oldCommitSha);
	assert.equal(repeated.mainCommitSha, fixture.mainCommitSha);
	const firstClose = repeated.close();
	const concurrentClose = repeated.close();
	assert.equal(firstClose, concurrentClose);
	await firstClose;
	await assert.rejects(access(repeated.directory), { code: "ENOENT" });
});

async function readFixtureWorkspace(root) {
	const policy = JSON.parse(
		await readFile(join(root, "fault-harness.json"), "utf8"),
	);
	return {
		gateOrder: policy.gateOrder,
		packages: await Promise.all(
			policy.packageDirectories.map(async (directory) =>
				JSON.parse(
					await readFile(join(root, directory, "package.json"), "utf8"),
				),
			),
		),
	};
}

function assertPlannerDisposition({
	exact,
	latest,
	blocked,
	candidateVersion = NEXT_VERSION,
}) {
	const candidate = {
		version: candidateVersion,
		commitSha: "0123456789abcdef0123456789abcdef01234567",
		ciWorkflow: "CI",
		ciCheck: "validate",
		publisherWorkflow: ".github/workflows/release.yml",
	};
	const packages = PACKAGE_NAMES.map((name, index) =>
		packageIdentity(name, index, candidateVersion),
	);
	const observation = plannerObservation(candidate, packages);
	if (exact.status !== "ABSENT") {
		observation.registry.packages[0] = ambiguousRegistryPackage(
			PACKAGE_NAMES[0],
		);
	} else {
		observation.registry.packages[0].latest = {
			status: latest?.status === "PRESENT" ? "present" : "ambiguous",
			version: latest?.status === "PRESENT" ? latest.metadata.latest : null,
		};
	}
	const plan = planRelease({ candidate, observation, mode: "shadow" });
	assert.equal(plan.disposition, blocked ? "blocked" : "would-transition");
	assert.deepEqual(plan.proposedMutations.length, blocked ? 0 : 1);
}

function plannerObservation(candidate, packages) {
	const pendingAttestations = [
		...packages.map((pkg) => ({
			name: pkg.attestationFilename,
			status: "pending",
			sha256: null,
			subjectName: pkg.filename,
			subjectSha256: pkg.tarballSha256,
		})),
		{
			name: "manifest.json.intoto.jsonl",
			status: "pending",
			sha256: null,
			subjectName: "manifest.json",
			subjectSha256: "a".repeat(64),
		},
	];
	return {
		inventory: { status: "valid", packages },
		ci: {
			status: "success",
			workflow: candidate.ciWorkflow,
			check: candidate.ciCheck,
			commitSha: candidate.commitSha,
		},
		otherCandidates: [],
		tag: { status: "absent", commitSha: null },
		artifacts: {
			status: "absent",
			manifestVersion: null,
			manifestCommitSha: null,
			manifestSha256: null,
			files: packages.map((pkg) => ({
				name: pkg.name,
				status: "pending",
				assetName: pkg.filename,
				sha256: null,
				integrity: null,
			})),
			manifestAsset: { name: "manifest.json", sha256: null },
			releaseRecordAsset: { name: "release-record.json", sha256: null },
			manifestAttestationAsset: {
				name: "manifest.json.intoto.jsonl",
				sha256: null,
			},
			attestations: pendingAttestations,
		},
		escrow: { status: "absent", manifestSha256: null, assets: [] },
		registry: {
			publishJobStarted: false,
			mutationStarted: false,
			packages: packages.map(({ name }) => absentRegistryPackage(name)),
		},
		release: {
			status: "absent",
			tag: null,
			commitSha: null,
			metadataReconciled: false,
			assets: [],
		},
		requiredSmokeLanes: ["install"],
		smokes: [
			{
				name: "install",
				status: "pending",
				version: candidate.version,
				commitSha: candidate.commitSha,
				manifestSha256: null,
				workflowRunId: 1,
				runAttempt: 1,
			},
		],
		audit: {
			status: "none",
			version: null,
			commitSha: null,
			manifestSha256: null,
			workflowRunId: null,
			runAttempt: null,
			conclusion: null,
		},
		abandonment: { requested: false, recorded: false },
	};
}

function packageIdentity(name, index, version) {
	const stem = name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
	return {
		name,
		version,
		filename: `${stem}-${version}.tgz`,
		tarballSha256: String(index + 1).repeat(64),
		attestationFilename: `${stem}-${version}.tgz.intoto.jsonl`,
		attestationSha256: String(index + 4).repeat(64),
		integrity: `sha512-${Buffer.alloc(64, index + 1).toString("base64")}`,
	};
}

function absentRegistryPackage(name) {
	return {
		name,
		status: "e404",
		version: null,
		tarballSha256: null,
		integrity: null,
		latest: { status: "e404", version: null },
		signature: { status: "missing" },
		provenance: null,
	};
}

function ambiguousRegistryPackage(name) {
	return {
		name,
		status: "ambiguous",
		version: null,
		tarballSha256: null,
		integrity: null,
		latest: { status: "ambiguous", version: null },
		signature: { status: "ambiguous" },
		provenance: null,
	};
}

function pickClassification(value) {
	return {
		status: value.status,
		operation: value.operation,
		httpStatus: value.httpStatus,
		code: value.code,
	};
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function installTemporaryEnvironment(values) {
	const inherited = new Map(
		Object.keys(values).map((name) => [name, Reflect.get(process.env, name)]),
	);
	for (const [name, value] of Object.entries(values))
		Reflect.set(process.env, name, value);
	return inherited;
}

function restoreEnvironment(inherited) {
	for (const [name, value] of inherited) {
		if (value === undefined) Reflect.deleteProperty(process.env, name);
		else Reflect.set(process.env, name, value);
	}
}

async function writeToolWrapper({ path, target, prefixArguments, marker }) {
	await writeFile(
		path,
		`#!/usr/bin/env node\nconst { appendFileSync } = require("node:fs")\nconst { spawnSync } = require("node:child_process")\nappendFileSync(${JSON.stringify(marker)}, "x")\nconst result = spawnSync(${JSON.stringify(target)}, [...${JSON.stringify(prefixArguments)}, ...process.argv.slice(2)], { stdio: "inherit", env: process.env })\nprocess.exit(result.status ?? 1)\n`,
		{ mode: 0o755 },
	);
}

async function startBoundedUpstream() {
	const sockets = new Set();
	const intervals = new Set();
	const server = createServer((request, response) => {
		if (request.url === "/slow") {
			response.writeHead(200, { "Content-Type": "application/json" });
			let writes = 0;
			const interval = setInterval(() => {
				if (writes >= 20) {
					clearInterval(interval);
					intervals.delete(interval);
					response.end("{}");
					return;
				}
				writes += 1;
				response.write(" ");
			}, 20);
			intervals.add(interval);
			response.once("close", () => {
				clearInterval(interval);
				intervals.delete(interval);
			});
			return;
		}
		response.writeHead(200, {
			"Content-Type": "application/json",
			"Content-Length": "100",
		});
		response.end("{}");
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.notEqual(address, null);
	assert.equal(typeof address, "object");
	let closePromise = null;
	return {
		url: `http://127.0.0.1:${address.port}/`,
		openSockets: () => sockets.size,
		close() {
			if (closePromise !== null) return closePromise;
			for (const interval of intervals) clearInterval(interval);
			intervals.clear();
			for (const socket of sockets) socket.destroy();
			closePromise = new Promise((resolve, reject) =>
				server.close((error) =>
					error === undefined ? resolve() : reject(error),
				),
			);
			return closePromise;
		},
	};
}
