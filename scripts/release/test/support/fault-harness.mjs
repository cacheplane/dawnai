import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

import { orderReleasePackages } from "../../topology.mjs";
import { startFaultProxy } from "./fault-proxy.mjs";
import { createGitFixture } from "./git-fixture.mjs";
import { startVerdaccio } from "./verdaccio.mjs";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const MAX_LIFECYCLE_TIMEOUT_MS = 30_000;

export async function createFaultHarness({
	fixtureDirectory,
	startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
	cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
	dependencies = {},
}) {
	if (typeof fixtureDirectory !== "string" || !isAbsolute(fixtureDirectory)) {
		throw new TypeError("Fault workspace fixture must be an absolute path");
	}
	assertLifecycleTimeout(startupTimeoutMs, "startup");
	assertLifecycleTimeout(cleanupTimeoutMs, "cleanup");
	const factories = harnessFactories(dependencies);
	const runtimeDirectory = await mkdtemp(
		join(tmpdir(), "dawn-release-fault-harness-"),
	);
	const resources = [
		resource("runtime directory", () =>
			rm(runtimeDirectory, { recursive: true, force: true }),
		),
	];
	const startupDeadline = Date.now() + startupTimeoutMs;
	let registry;
	let proxy;
	let git;
	try {
		registry = await acquireWithDeadline(
			() => factories.startVerdaccio(),
			Math.max(1, startupDeadline - Date.now()),
			"Verdaccio startup",
		);
		assertClosableResource(registry, "Verdaccio");
		resources.push(resource("Verdaccio", () => registry.close()));
		proxy = await acquireWithDeadline(
			() => factories.startFaultProxy({ upstreamUrl: registry.url }),
			Math.max(1, startupDeadline - Date.now()),
			"fault proxy startup",
		);
		assertClosableResource(proxy, "fault proxy");
		resources.push(resource("fault proxy", () => proxy.close()));
		git = await acquireWithDeadline(
			() => factories.createGitFixture({ sourceDirectory: fixtureDirectory }),
			Math.max(1, startupDeadline - Date.now()),
			"Git fixture startup",
		);
		assertClosableResource(git, "Git fixture");
		resources.push(resource("Git fixture", () => git.close()));
		const packsDirectory = join(runtimeDirectory, "packs");
		const cacheDirectory = join(runtimeDirectory, "npm-cache");
		const tempDirectory = join(runtimeDirectory, "tmp");
		const homeDirectory = join(runtimeDirectory, "home");
		const configDirectory = join(runtimeDirectory, "xdg-config");
		const xdgCacheDirectory = join(runtimeDirectory, "xdg-cache");
		await Promise.all([
			mkdir(packsDirectory),
			mkdir(cacheDirectory),
			mkdir(tempDirectory),
			mkdir(homeDirectory),
			mkdir(configDirectory),
			mkdir(xdgCacheDirectory),
		]);
		const userConfig = join(runtimeDirectory, "npmrc");
		await writeFile(userConfig, npmConfiguration(registry.url), {
			mode: 0o600,
		});
		const tools = await resolvePackageTools(git.workingDirectory);
		let published = false;
		let closePromise = null;
		const harness = {
			runtimeDirectory,
			registry,
			proxy,
			git,
			async packAndPublish() {
				if (published) throw new Error("Fault workspace was already published");
				assertDisposableRegistry(registry.url);
				const { orderedPackages: ordered } = await discoverFaultWorkspace({
					fixtureDirectory: git.workingDirectory,
				});
				assertNoLifecycleScripts(ordered);
				const environment = npmEnvironment({
					registryUrl: registry.url,
					userConfig,
					cacheDirectory,
					tempDirectory,
					homeDirectory,
					configDirectory,
					xdgCacheDirectory,
				});
				await command(
					process.execPath,
					[
						tools.pnpm,
						"install",
						"--offline",
						"--ignore-scripts",
						"--frozen-lockfile=false",
					],
					{
						cwd: git.workingDirectory,
						env: environment,
						operation: "pnpm-install",
					},
				);
				const publication = [];
				for (const packageJson of ordered) {
					const packageDirectory = packageJson.directory;
					const packedOutput = await command(
						process.execPath,
						[tools.pnpm, "pack", "--pack-destination", packsDirectory],
						{
							cwd: packageDirectory,
							env: environment,
							operation: "pnpm-pack",
						},
					);
					const tarballName = packedOutput
						.split("\n")
						.map((line) => line.trim())
						.findLast((line) => line.endsWith(".tgz"));
					if (tarballName === undefined)
						throw new Error("Package manager did not report a tarball");
					const tarballPath = join(packsDirectory, basename(tarballName));
					const bytes = await readFile(tarballPath);
					await command(
						process.execPath,
						[
							tools.npm,
							"publish",
							tarballPath,
							"--registry",
							registry.url,
							"--tag",
							"latest",
							"--access",
							"public",
							"--provenance=false",
							"--userconfig",
							userConfig,
							"--scope=",
							"--ignore-scripts",
						],
						{
							cwd: packageDirectory,
							env: environment,
							operation: "npm-publish",
						},
					);
					publication.push(
						Object.freeze({
							name: packageJson.name,
							version: packageJson.version,
							tarballPath,
							sha256: digest("sha256", bytes, "hex"),
							integrity: `sha512-${digest("sha512", bytes, "base64")}`,
							registryUrl: registry.url,
						}),
					);
				}
				published = true;
				return Object.freeze(publication);
			},
			close() {
				if (closePromise !== null) return closePromise;
				closePromise = cleanupResources(resources, cleanupTimeoutMs).then(
					() => {
						return undefined;
					},
					(error) => {
						closePromise = null;
						throw error;
					},
				);
				return closePromise;
			},
		};
		return Object.freeze(harness);
	} catch (error) {
		const cleanupErrors = await cleanupResources(
			resources,
			cleanupTimeoutMs,
		).then(
			() => [],
			(cleanupError) =>
				cleanupError instanceof AggregateError
					? cleanupError.errors
					: [cleanupError],
		);
		const initiatingError = sanitizedError(
			error,
			"Fault harness startup failed",
		);
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[initiatingError, ...cleanupErrors],
				"Fault harness startup rollback failed",
			);
		}
		throw initiatingError;
	}
}

function harnessFactories(value) {
	if (value === null || Array.isArray(value) || typeof value !== "object") {
		throw new TypeError("Fault harness dependencies are invalid");
	}
	const allowed = ["createGitFixture", "startFaultProxy", "startVerdaccio"];
	if (Object.keys(value).some((name) => !allowed.includes(name))) {
		throw new TypeError("Fault harness dependencies are invalid");
	}
	const factories = {
		createGitFixture: value.createGitFixture ?? createGitFixture,
		startFaultProxy: value.startFaultProxy ?? startFaultProxy,
		startVerdaccio: value.startVerdaccio ?? startVerdaccio,
	};
	if (
		Object.values(factories).some((factory) => typeof factory !== "function")
	) {
		throw new TypeError("Fault harness dependencies are invalid");
	}
	return factories;
}

function resource(label, close) {
	return { label, close, complete: false };
}

async function cleanupResources(resources, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	const pending = [...resources]
		.reverse()
		.filter(({ complete }) => !complete)
		.map(async (entry) => {
			try {
				await withDeadline(
					Promise.resolve().then(() => entry.close()),
					Math.max(1, deadline - Date.now()),
					`${entry.label} cleanup`,
				);
				entry.complete = true;
				return null;
			} catch (error) {
				return sanitizedError(error, `${entry.label} cleanup failed`);
			}
		});
	const errors = (await Promise.all(pending)).filter((error) => error !== null);
	if (errors.length > 0)
		throw new AggregateError(errors, "Fault harness cleanup failed");
}

function withDeadline(promise, timeoutMs, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					Object.assign(new Error(`${label} exceeded its deadline`), {
						code: "DEADLINE_EXCEEDED",
					}),
				),
			timeoutMs,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function acquireWithDeadline(factory, timeoutMs, label) {
	const pending = Promise.resolve().then(factory);
	try {
		return await withDeadline(pending, timeoutMs, label);
	} catch (error) {
		pending.then(
			(lateResource) =>
				Promise.resolve(lateResource?.close?.()).catch(() => {}),
			() => {},
		);
		throw error;
	}
}

function sanitizedError(error, message) {
	const code =
		typeof error?.code === "string" &&
		/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
			? error.code
			: "FAULT_HARNESS_FAILED";
	return Object.assign(new Error(message), { code });
}

function assertClosableResource(value, label) {
	if (
		value === null ||
		typeof value !== "object" ||
		typeof value.close !== "function"
	) {
		throw new TypeError(`${label} resource is invalid`);
	}
}

function assertLifecycleTimeout(value, label) {
	if (
		!Number.isSafeInteger(value) ||
		value < 10 ||
		value > MAX_LIFECYCLE_TIMEOUT_MS
	) {
		throw new TypeError(`Fault harness ${label} timeout is invalid`);
	}
}

export async function discoverFaultWorkspace({ fixtureDirectory }) {
	if (typeof fixtureDirectory !== "string" || !isAbsolute(fixtureDirectory)) {
		throw new TypeError("Fault workspace fixture must be an absolute path");
	}
	const root = await realpath(fixtureDirectory);
	const policy = parseObject(
		await readFile(join(root, "fault-harness.json"), "utf8"),
		"policy",
	);
	if (!hasExactKeys(policy, ["packageDirectories", "gateOrder"])) {
		throw new TypeError("Fault workspace policy fields are invalid");
	}
	const packageDirectories = validatedStrings(
		policy.packageDirectories,
		"package directories",
	);
	const gateOrder = validatedStrings(policy.gateOrder, "gate order");
	const packages = [];
	for (const configuredDirectory of packageDirectories) {
		if (!isSafeRelativeDirectory(configuredDirectory)) {
			throw new TypeError("Fault workspace package directory is invalid");
		}
		const directory = resolve(root, configuredDirectory);
		if (
			!withinRoot(root, directory) ||
			!(await lstat(directory)).isDirectory()
		) {
			throw new TypeError("Fault workspace package directory is invalid");
		}
		const exactDirectory = await realpath(directory);
		if (!withinRoot(root, exactDirectory) || exactDirectory !== directory) {
			throw new TypeError("Fault workspace package directory is invalid");
		}
		const manifest = parseObject(
			await readFile(join(directory, "package.json"), "utf8"),
			"manifest",
		);
		if (
			typeof manifest.name !== "string" ||
			manifest.name.length === 0 ||
			typeof manifest.version !== "string" ||
			manifest.version.length === 0
		) {
			throw new TypeError("Fault workspace package identity is invalid");
		}
		packages.push({ ...manifest, directory });
	}
	const changesets = parseObject(
		await readFile(join(root, ".changeset", "config.json"), "utf8"),
		"Changesets config",
	);
	if (
		!Array.isArray(changesets.fixed) ||
		changesets.fixed.length !== 1 ||
		!Array.isArray(changesets.fixed[0])
	) {
		throw new TypeError("Fault workspace fixed group is invalid");
	}
	const fixedNames = validatedStrings(changesets.fixed[0], "fixed group");
	const packageNames = packages.map(({ name }) => name);
	if (!sameSet(fixedNames, packageNames)) {
		throw new TypeError(
			"Fault workspace inventory differs from its fixed group",
		);
	}
	if (gateOrder.some((name) => !fixedNames.includes(name))) {
		throw new TypeError(
			"Fault workspace gate policy is outside its fixed group",
		);
	}
	const versions = new Set(packages.map(({ version }) => version));
	if (versions.size !== 1)
		throw new TypeError("Fault workspace versions are not uniform");
	return Object.freeze({
		gateOrder: Object.freeze([...gateOrder]),
		orderedPackages: Object.freeze(
			orderReleasePackages(packages, { gateOrder }),
		),
	});
}

function parseObject(source, label) {
	let value;
	try {
		value = JSON.parse(source);
	} catch {
		throw new TypeError(`Fault workspace ${label} is invalid JSON`);
	}
	if (value === null || Array.isArray(value) || typeof value !== "object") {
		throw new TypeError(`Fault workspace ${label} is invalid`);
	}
	return value;
}

function hasExactKeys(value, expected) {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	);
}

function validatedStrings(value, label) {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		!value.every((item) => typeof item === "string" && item.length > 0) ||
		new Set(value).size !== value.length
	) {
		throw new TypeError(`Fault workspace ${label} are invalid`);
	}
	return value;
}

function isSafeRelativeDirectory(value) {
	return (
		!isAbsolute(value) &&
		value.length <= 512 &&
		value
			.split("/")
			.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))
	);
}

function withinRoot(root, target) {
	const path = relative(root, target);
	return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function sameSet(left, right) {
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return (
		sortedLeft.length === sortedRight.length &&
		sortedLeft.every((name, index) => name === sortedRight[index])
	);
}

function npmConfiguration(registryUrl) {
	const host = new URL(registryUrl).host;
	return [
		`registry=${registryUrl}`,
		`@fault:registry=${registryUrl}`,
		`//${host}/:_authToken=fault-harness-token`,
		"replace-registry-host=never",
		"provenance=false",
		"fund=false",
		"audit=false",
		"",
	].join("\n");
}

function npmEnvironment({
	registryUrl,
	userConfig,
	cacheDirectory,
	tempDirectory,
	homeDirectory,
	configDirectory,
	xdgCacheDirectory,
}) {
	return {
		PATH: requiredPath(),
		HOME: homeDirectory,
		TMPDIR: tempDirectory,
		XDG_CONFIG_HOME: configDirectory,
		XDG_CACHE_HOME: xdgCacheDirectory,
		LANG: "C",
		LC_ALL: "C",
		CI: "1",
		NPM_CONFIG_USERCONFIG: userConfig,
		NPM_CONFIG_CACHE: cacheDirectory,
		NPM_CONFIG_REGISTRY: registryUrl,
		NPM_CONFIG_PROVENANCE: "false",
		NPM_CONFIG_IGNORE_SCRIPTS: "true",
		NPM_CONFIG_REPLACE_REGISTRY_HOST: "never",
		"npm_config_@fault:registry": registryUrl,
		npm_config_scope: "",
		npm_config_tmp: tempDirectory,
	};
}

async function resolvePackageTools(workspaceDirectory) {
	const rootManifest = parseObject(
		await readFile(join(workspaceDirectory, "package.json"), "utf8"),
		"root manifest",
	);
	const match = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(
		rootManifest.packageManager,
	);
	if (match === null)
		throw new TypeError("Fault workspace package manager is invalid");
	const pnpm = join(
		userInfo().homedir,
		".cache",
		"node",
		"corepack",
		"v1",
		"pnpm",
		match[1],
		"bin",
		"pnpm.cjs",
	);
	const npm = resolve(
		dirname(process.execPath),
		"../lib/node_modules/npm/bin/npm-cli.js",
	);
	for (const tool of [pnpm, npm]) {
		if (!(await lstat(tool)).isFile())
			throw new Error("Required package tool is unavailable");
	}
	return Object.freeze({ pnpm, npm });
}

function assertNoLifecycleScripts(packages) {
	const forbidden = new Set();
	for (const packageJson of packages) {
		if (packageJson.scripts === undefined) continue;
		if (
			packageJson.scripts === null ||
			Array.isArray(packageJson.scripts) ||
			typeof packageJson.scripts !== "object"
		) {
			throw new TypeError("Fault workspace package scripts are invalid");
		}
		for (const name of Object.keys(packageJson.scripts)) forbidden.add(name);
	}
	if (forbidden.size > 0) {
		throw new TypeError(
			`Fault workspace contains forbidden lifecycle script names: ${[...forbidden].sort().join(", ")}`,
		);
	}
}

function requiredPath() {
	const value = Reflect.get(process.env, "PATH");
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new TypeError("Fault harness requires a safe PATH");
	}
	return value;
}

function command(executable, args, { cwd, env, operation }) {
	return new Promise((resolve, reject) => {
		execFile(
			executable,
			args,
			{
				cwd,
				env,
				shell: false,
				timeout: COMMAND_TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BYTES,
				encoding: "utf8",
				windowsHide: true,
			},
			(error, stdout) => {
				if (error !== null) {
					reject(
						Object.assign(
							new Error(`Fault harness ${operation} command failed`),
							{
								code: "PACKAGE_COMMAND_FAILED",
							},
						),
					);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

function assertDisposableRegistry(value) {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.port === "" ||
		url.pathname !== "/" ||
		url.username !== "" ||
		url.password !== ""
	) {
		throw new TypeError("Publish registry must be a disposable loopback URL");
	}
}

function digest(algorithm, bytes, encoding) {
	return createHash(algorithm).update(bytes).digest(encoding);
}
