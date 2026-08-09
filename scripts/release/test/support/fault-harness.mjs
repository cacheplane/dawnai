import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	basename,
	delimiter,
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
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const MAX_LIFECYCLE_TIMEOUT_MS = 30_000;
const MAX_CLEANUP_ATTEMPTS = 2;
const MIN_CLEANUP_ATTEMPT_MS = 10;
const TOOL_VERSION =
	/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export async function createFaultHarness({
	fixtureDirectory,
	startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
	cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
	packageTools,
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
			({ signal }) => factories.startVerdaccio({ signal }),
			Math.max(1, startupDeadline - Date.now()),
			cleanupTimeoutMs,
			"Verdaccio startup",
		);
		resources.push(resource("Verdaccio", () => registry.close()));
		assertClosableResource(registry, "Verdaccio");
		proxy = await acquireWithDeadline(
			({ signal }) =>
				factories.startFaultProxy({ upstreamUrl: registry.url, signal }),
			Math.max(1, startupDeadline - Date.now()),
			cleanupTimeoutMs,
			"fault proxy startup",
		);
		resources.push(resource("fault proxy", () => proxy.close()));
		assertClosableResource(proxy, "fault proxy");
		git = await acquireWithDeadline(
			({ signal }) =>
				factories.createGitFixture({
					sourceDirectory: fixtureDirectory,
					signal,
				}),
			Math.max(1, startupDeadline - Date.now()),
			cleanupTimeoutMs,
			"Git fixture startup",
		);
		resources.push(resource("Git fixture", () => git.close()));
		assertClosableResource(git, "Git fixture");
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
		const environment = npmEnvironment({
			registryUrl: registry.url,
			userConfig,
			cacheDirectory,
			tempDirectory,
			homeDirectory,
			configDirectory,
			xdgCacheDirectory,
		});
		const tools = await resolvePackageTools(
			git.workingDirectory,
			packageTools,
			environment,
			startupDeadline,
		);
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
				await toolCommand(
					tools.pnpm,
					[
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
					const packedOutput = await toolCommand(
						tools.pnpm,
						["pack", "--pack-destination", packsDirectory],
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
					await toolCommand(
						tools.npm,
						[
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
		.map((entry) => cleanupResource(entry, deadline));
	const errors = (await Promise.all(pending)).filter((error) => error !== null);
	if (errors.length > 0)
		throw new AggregateError(errors, "Fault harness cleanup failed");
}

async function cleanupResource(entry, deadline) {
	let lastError = null;
	for (let attempt = 0; attempt < MAX_CLEANUP_ATTEMPTS; attempt += 1) {
		const remaining = deadline - Date.now();
		if (remaining < MIN_CLEANUP_ATTEMPT_MS) break;
		try {
			await withDeadline(
				Promise.resolve().then(() => entry.close()),
				remaining,
				`${entry.label} cleanup`,
			);
			entry.complete = true;
			return null;
		} catch (error) {
			lastError = sanitizedError(error, `${entry.label} cleanup failed`);
		}
	}
	return (
		lastError ??
		sanitizedError(
			{ code: "DEADLINE_EXCEEDED" },
			`${entry.label} cleanup failed`,
		)
	);
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

async function acquireWithDeadline(
	factory,
	timeoutMs,
	cleanupTimeoutMs,
	label,
) {
	const controller = new AbortController();
	const pending = Promise.resolve().then(() =>
		factory({ signal: controller.signal }),
	);
	try {
		return await withDeadline(pending, timeoutMs, label);
	} catch (error) {
		controller.abort();
		const cleanupDeadline = Date.now() + cleanupTimeoutMs;
		const outcome = await withDeadline(
			pending.then(
				(value) => ({ status: "fulfilled", value }),
				() => ({ status: "rejected" }),
			),
			cleanupTimeoutMs,
			`${label} late acquisition`,
		).catch(() => null);
		if (outcome?.status === "fulfilled") {
			const lateResource = outcome.value;
			if (
				lateResource !== null &&
				typeof lateResource === "object" &&
				typeof lateResource.close === "function"
			) {
				try {
					await cleanupResources(
						[resource(`${label} late resource`, () => lateResource.close())],
						Math.max(MIN_CLEANUP_ATTEMPT_MS, cleanupDeadline - Date.now()),
					);
				} catch (cleanupError) {
					throw new AggregateError(
						[
							sanitizedError(error, `${label} failed`),
							...(cleanupError instanceof AggregateError
								? cleanupError.errors
								: [cleanupError]),
						],
						`${label} rollback failed`,
					);
				}
			}
		} else if (outcome === null) {
			throw Object.assign(
				new Error(`${label} did not settle after cancellation`),
				{ code: "ACQUISITION_ABORT_UNSETTLED" },
			);
		}
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

async function resolvePackageTools(
	workspaceDirectory,
	configured,
	environment,
	startupDeadline,
) {
	const rootManifest = parseObject(
		await readFile(join(workspaceDirectory, "package.json"), "utf8"),
		"root manifest",
	);
	const match = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(
		rootManifest.packageManager,
	);
	if (match === null)
		throw new TypeError("Fault workspace package manager is invalid");
	const expectedPnpmVersion = match[1];
	const descriptors =
		configured === undefined
			? await discoverPackageTools(expectedPnpmVersion)
			: configuredPackageTools(configured, expectedPnpmVersion);
	for (const descriptor of Object.values(descriptors)) {
		await validateToolEntryPoint(descriptor.executable);
		const remaining = Math.max(1, startupDeadline - Date.now());
		const observedVersion = (
			await command(
				descriptor.executable,
				[...descriptor.prefixArguments, "--version"],
				{
					cwd: workspaceDirectory,
					env: environment,
					operation: "package-tool-version",
					timeoutMs: Math.min(COMMAND_TIMEOUT_MS, remaining),
				},
			)
		).trim();
		if (observedVersion !== descriptor.version) {
			throw new Error("Required package tool version is unavailable");
		}
	}
	return Object.freeze(descriptors);
}

async function discoverPackageTools(expectedPnpmVersion) {
	let pnpm = await findExecutable("pnpm");
	let pnpmPrefix = [];
	if (pnpm === null) {
		pnpm = await findExecutable("corepack");
		pnpmPrefix = ["pnpm"];
	}
	const npm = await findExecutable("npm");
	if (pnpm === null || npm === null)
		throw new Error("Required package tool is unavailable");
	return {
		pnpm: toolDescriptor(pnpm, expectedPnpmVersion, pnpmPrefix),
		npm: toolDescriptor(npm, await installedNpmVersion(npm), []),
	};
}

function configuredPackageTools(value, expectedPnpmVersion) {
	if (!isExactObject(value, ["npm", "pnpm"])) {
		throw new TypeError("Fault harness package tools are invalid");
	}
	const pnpm = configuredTool(value.pnpm, "pnpm");
	const npm = configuredTool(value.npm, "npm");
	if (pnpm.version !== expectedPnpmVersion) {
		throw new TypeError("Fault harness pnpm version is invalid");
	}
	return { pnpm, npm };
}

function configuredTool(value, name) {
	if (
		!isExactObject(value, ["executable", "version"]) ||
		typeof value.executable !== "string" ||
		!isAbsolute(value.executable) ||
		value.executable.length > 1024 ||
		typeof value.version !== "string" ||
		!TOOL_VERSION.test(value.version)
	) {
		throw new TypeError(`Fault harness ${name} tool is invalid`);
	}
	return toolDescriptor(value.executable, value.version, []);
}

function toolDescriptor(executable, version, prefixArguments) {
	return Object.freeze({
		executable,
		prefixArguments: Object.freeze([...prefixArguments]),
		version,
	});
}

async function findExecutable(name) {
	for (const directory of requiredPath().split(delimiter)) {
		if (!isAbsolute(directory))
			throw new TypeError("Fault harness requires an absolute PATH");
		const candidate = join(directory, name);
		try {
			await access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {}
	}
	return null;
}

async function installedNpmVersion(executable) {
	let directory = dirname(await realpath(executable));
	for (let depth = 0; depth < 4; depth += 1) {
		try {
			const manifest = parseObject(
				await readFile(join(directory, "package.json"), "utf8"),
				"npm tool manifest",
			);
			if (manifest.name === "npm" && TOOL_VERSION.test(manifest.version)) {
				return manifest.version;
			}
		} catch {}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error("Required npm tool version is unavailable");
}

async function validateToolEntryPoint(executable) {
	const target = await realpath(executable);
	if (!(await stat(target)).isFile()) {
		throw new Error("Required package tool is unavailable");
	}
}

function isExactObject(value, expectedKeys) {
	return (
		value !== null &&
		!Array.isArray(value) &&
		typeof value === "object" &&
		hasExactKeys(value, expectedKeys)
	);
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

function command(
	executable,
	args,
	{ cwd, env, operation, timeoutMs = COMMAND_TIMEOUT_MS },
) {
	return new Promise((resolve, reject) => {
		execFile(
			executable,
			args,
			{
				cwd,
				env,
				shell: false,
				timeout: timeoutMs,
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

function toolCommand(tool, args, options) {
	return command(tool.executable, [...tool.prefixArguments, ...args], options);
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
