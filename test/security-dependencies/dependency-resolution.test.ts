import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");

const expectedUnrelatedOverrides = {
	"esbuild@<0.25.0": "0.25.10",
	"esbuild@>=0.27.3 <0.28.1": "0.28.1",
	langsmith: "0.7.10",
	"qs@>=6.11.1 <=6.15.1": "^6.15.2",
	"uuid@<11.1.1": "11.1.1",
	"vite@>=5 <6.4.3": "6.4.3",
	"ws@>=8 <8.21.0": "8.21.0",
} as const;

const expectedSecurityOverrides = {
	"@hono/node-server@<2.0.10": "2.1.0",
	"js-yaml@>=4 <4.3.1": "4.3.1",
	postcss: "8.5.23",
} as const;

const expectedOverrides = {
	...expectedUnrelatedOverrides,
	...expectedSecurityOverrides,
} as const;

const expectedSnapshotVersions = {
	"@hono/node-server": ["2.1.0"],
	"body-parser": ["1.20.6", "2.3.0"],
	"brace-expansion": ["2.1.4", "5.0.9"],
	dompurify: ["3.4.13"],
	"fast-uri": ["3.1.5"],
	hono: ["4.13.1"],
	"ip-address": ["10.5.0"],
	"js-yaml": ["3.15.1", "4.3.1", "5.2.2"],
	mermaid: ["11.16.1"],
	nanoid: ["3.3.18"],
	postcss: ["8.5.23"],
} as const;

const exactProviderUtilsParents = [
	["@ai-sdk/anthropic", "2.0.85"],
	["@ai-sdk/google", "2.0.78"],
	["@ai-sdk/google-vertex", "3.0.146"],
	["@ai-sdk/openai-compatible", "1.0.42"],
] as const;

type JsonRecord = Record<string, unknown>;

interface ParsedWorkspace {
	readonly importers: JsonRecord;
	readonly manifestOverrides: Record<string, string>;
	readonly packages: JsonRecord;
	readonly snapshots: JsonRecord;
}

interface Locator {
	readonly key: string;
	readonly name: string;
	readonly value: JsonRecord;
	readonly version: string;
}

type DependencySection =
	| "dependencies"
	| "devDependencies"
	| "optionalDependencies";

interface ReverseEdge {
	readonly parentIdentity: string;
	readonly parentKind: "importer" | "snapshot";
	readonly reference: string;
	readonly section: DependencySection;
	readonly target: Locator;
}

function requireRecord(value: unknown, label: string): JsonRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as JsonRecord;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function requireStringMap(
	value: unknown,
	label: string,
): Record<string, string> {
	const record = requireRecord(value, label);
	return Object.fromEntries(
		Object.entries(record).map(([key, entry]) => [
			key,
			requireString(entry, `${label}.${key}`),
		]),
	);
}

function parseManifest(source: string): Record<string, string> {
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		throw new Error("package.json must contain valid JSON");
	}
	const manifest = requireRecord(value, "package.json");
	const pnpm = requireRecord(manifest.pnpm, "package.json.pnpm");
	return requireStringMap(pnpm.overrides, "package.json.pnpm.overrides");
}

function parseLockfile(source: string): {
	readonly importers: JsonRecord;
	readonly overrides: Record<string, string>;
	readonly packages: JsonRecord;
	readonly snapshots: JsonRecord;
} {
	const document = parseDocument(source, {
		strict: true,
		uniqueKeys: true,
	});
	if (document.errors.length > 0 || document.warnings.length > 0) {
		throw new Error("pnpm-lock.yaml must parse without errors or warnings");
	}
	const lockfile = requireRecord(
		document.toJS({ maxAliasCount: 0 }),
		"pnpm-lock.yaml",
	);
	const expectedKeys = [
		"importers",
		"lockfileVersion",
		"overrides",
		"packages",
		"settings",
		"snapshots",
	];
	if (
		JSON.stringify(Object.keys(lockfile).sort()) !==
		JSON.stringify(expectedKeys)
	) {
		throw new Error(
			"pnpm-lock.yaml has unexpected or missing top-level records",
		);
	}
	if (lockfile.lockfileVersion !== "9.0") {
		throw new Error("pnpm-lock.yaml.lockfileVersion must be the string 9.0");
	}
	const settings = requireRecord(lockfile.settings, "pnpm-lock.yaml.settings");
	if (
		settings.autoInstallPeers !== true ||
		settings.excludeLinksFromLockfile !== false ||
		Object.keys(settings).length !== 2
	) {
		throw new Error("pnpm-lock.yaml.settings has an unexpected shape");
	}
	return {
		importers: requireRecord(lockfile.importers, "pnpm-lock.yaml.importers"),
		overrides: requireStringMap(lockfile.overrides, "pnpm-lock.yaml.overrides"),
		packages: requireRecord(lockfile.packages, "pnpm-lock.yaml.packages"),
		snapshots: requireRecord(lockfile.snapshots, "pnpm-lock.yaml.snapshots"),
	};
}

function readWorkspace(): ParsedWorkspace {
	const manifestOverrides = parseManifest(
		readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
	);
	const lockfile = parseLockfile(
		readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml"), "utf8"),
	);
	if (
		JSON.stringify(manifestOverrides) !== JSON.stringify(lockfile.overrides)
	) {
		throw new Error(
			"manifest and lockfile override maps must be byte-equivalent JSON",
		);
	}
	return {
		importers: lockfile.importers,
		manifestOverrides,
		packages: lockfile.packages,
		snapshots: lockfile.snapshots,
	};
}

function parseLocator(key: string, value: unknown, label: string): Locator {
	const bareKey = key.includes("(") ? key.slice(0, key.indexOf("(")) : key;
	const separator = bareKey.lastIndexOf("@");
	if (separator <= 0 || separator === bareKey.length - 1) {
		throw new Error(`${label} contains malformed package locator ${key}`);
	}
	const name = bareKey.slice(0, separator);
	const version = bareKey.slice(separator + 1);
	return {
		key,
		name,
		value: requireRecord(value, `${label}.${key}`),
		version,
	};
}

function locatorsFor(
	record: JsonRecord,
	name: string,
	label: string,
): Locator[] {
	return Object.entries(record)
		.map(([key, value]) => parseLocator(key, value, label))
		.filter((locator) => locator.name === name)
		.sort((left, right) => left.key.localeCompare(right.key));
}

function uniqueLocator(
	record: JsonRecord,
	name: string,
	version: string,
	label = "snapshots",
): Locator {
	const matches = locatorsFor(record, name, label).filter(
		(locator) => locator.version === version,
	);
	if (matches.length !== 1) {
		throw new Error(
			`${name}@${version} must have exactly one ${label} identity`,
		);
	}
	const match = matches[0];
	if (!match) throw new Error(`${name}@${version} identity disappeared`);
	return match;
}

function dependenciesOf(locator: Locator): JsonRecord {
	return requireRecord(
		locator.value.dependencies,
		`${locator.key}.dependencies`,
	);
}

function locatorReference(locator: Locator): string {
	const prefix = `${locator.name}@`;
	if (!locator.key.startsWith(prefix)) {
		throw new Error(
			`${locator.key} is not a canonical ${locator.name} locator`,
		);
	}
	return locator.key.slice(prefix.length);
}

function dependencyVersion(locator: Locator, dependencyName: string): string {
	return requireString(
		dependenciesOf(locator)[dependencyName],
		`${locator.key}.dependencies.${dependencyName}`,
	);
}

function importerDependency(
	workspace: ParsedWorkspace,
	importerName: string,
	sectionName: "dependencies" | "devDependencies",
	dependencyName: string,
): { readonly specifier: string; readonly version: string } {
	const importer = requireRecord(
		workspace.importers[importerName],
		`importers.${importerName}`,
	);
	const section = requireRecord(
		importer[sectionName],
		`importers.${importerName}.${sectionName}`,
	);
	const entry = requireRecord(
		section[dependencyName],
		`importers.${importerName}.${sectionName}.${dependencyName}`,
	);
	if (Object.keys(entry).sort().join(",") !== "specifier,version") {
		throw new Error(
			`importers.${importerName}.${sectionName}.${dependencyName} has an unexpected shape`,
		);
	}
	return {
		specifier: requireString(entry.specifier, "dependency specifier"),
		version: requireString(entry.version, "dependency version"),
	};
}

function versionTuple(version: string): readonly [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`invalid release version ${version}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
	const leftTuple = versionTuple(left);
	const rightTuple = versionTuple(right);
	for (const index of [0, 1, 2] as const) {
		const difference = leftTuple[index] - rightTuple[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

function vulnerableFloor(name: string, version: string): string | undefined {
	const major = versionTuple(version)[0];
	const floors: Record<string, Record<number, string>> = {
		"@hono/node-server": { 1: "2.0.10", 2: "2.0.10" },
		"body-parser": { 1: "1.20.6" },
		"brace-expansion": { 2: "2.1.4" },
		dompurify: { 3: "3.4.13" },
		"fast-uri": { 3: "3.1.5" },
		hono: { 4: "4.12.34" },
		"ip-address": { 10: "10.3.1" },
		"js-yaml": { 3: "3.15.1", 4: "4.3.1" },
		mermaid: { 11: "11.16.1" },
		nanoid: { 3: "3.3.17" },
		postcss: { 8: "8.5.23" },
	};
	return floors[name]?.[major];
}

function floorFailures(workspace: ParsedWorkspace): string[] {
	const failures: string[] = [];
	for (const name of Object.keys(expectedSnapshotVersions)) {
		for (const locator of locatorsFor(workspace.snapshots, name, "snapshots")) {
			const floor = vulnerableFloor(name, locator.version);
			if (floor && compareVersions(locator.version, floor) < 0) {
				failures.push(`${name}@${locator.version} is below ${floor}`);
			}
		}
	}
	return failures.sort();
}

function snapshotVersions(workspace: ParsedWorkspace, name: string): string[] {
	return locatorsFor(workspace.snapshots, name, "snapshots")
		.map((locator) => locator.version)
		.sort((left, right) => compareVersions(left, right));
}

function validateExactSnapshotSets(workspace: ParsedWorkspace): void {
	for (const [name, versions] of Object.entries(expectedSnapshotVersions)) {
		const snapshots = snapshotVersions(workspace, name);
		const packages = locatorsFor(workspace.packages, name, "packages")
			.map((locator) => locator.version)
			.sort((left, right) => compareVersions(left, right));
		if (JSON.stringify(snapshots) !== JSON.stringify(versions)) {
			throw new Error(`${name} has an unexpected complete snapshot set`);
		}
		if (JSON.stringify(packages) !== JSON.stringify(versions)) {
			throw new Error(`${name} has an unexpected complete package set`);
		}
	}
}

function validateOverridePolicy(overrides: Record<string, string>): void {
	const actual = Object.entries(overrides).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	const expected = Object.entries(expectedOverrides).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			"root overrides do not equal the exact reviewed ten-entry map",
		);
	}
}

function validateCompleteIdentity(
	workspace: ParsedWorkspace,
	name: string,
	version: string,
): Locator {
	const packageVersions = locatorsFor(workspace.packages, name, "packages").map(
		(locator) => locator.version,
	);
	const snapshotLocators = locatorsFor(workspace.snapshots, name, "snapshots");
	if (JSON.stringify(packageVersions) !== JSON.stringify([version])) {
		throw new Error(`${name} has an unexpected complete package identity set`);
	}
	if (
		snapshotLocators.length !== 1 ||
		snapshotLocators[0]?.version !== version
	) {
		throw new Error(`${name} has an unexpected complete snapshot identity set`);
	}
	return uniqueLocator(workspace.snapshots, name, version);
}

function validateNodeServerGraph(workspace: ParsedWorkspace): void {
	const nodeServer = validateCompleteIdentity(
		workspace,
		"@hono/node-server",
		"2.1.0",
	);
	if (nodeServer.key !== "@hono/node-server@2.1.0(hono@4.13.1)") {
		throw new Error(
			"node-server snapshot does not have the exact Hono peer identity",
		);
	}
	const expectedReference = "2.1.0(hono@4.13.1)";
	const cli = importerDependency(
		workspace,
		"packages/cli",
		"devDependencies",
		"@hono/node-server",
	);
	if (cli.specifier !== "^2.1.0" || cli.version !== expectedReference) {
		throw new Error("CLI does not bind the exact node-server snapshot");
	}

	const runtime = validateCompleteIdentity(
		workspace,
		"@copilotkit/runtime",
		"1.66.4",
	);
	const mcp = validateCompleteIdentity(
		workspace,
		"@modelcontextprotocol/sdk",
		"1.29.0",
	);
	for (const parent of [runtime, mcp]) {
		if (dependencyVersion(parent, "@hono/node-server") !== expectedReference) {
			throw new Error(
				`${parent.name} does not bind the exact node-server snapshot`,
			);
		}
	}
	if (
		dependencyVersion(runtime, "@modelcontextprotocol/sdk") !==
		locatorReference(mcp)
	) {
		throw new Error("Copilot runtime does not bind the exact MCP snapshot");
	}
	validateExactReverseEdges(workspace, nodeServer, [
		snapshotEdge(runtime),
		snapshotEdge(mcp),
		importerEdge("packages/cli", "devDependencies"),
	]);
	validateRuntimeRoots(workspace, runtime);
}

function referenceTarget(
	workspace: ParsedWorkspace,
	dependencyName: string,
	reference: string,
	label: string,
): Locator {
	const key = `${dependencyName}@${reference}`;
	if (!Object.hasOwn(workspace.snapshots, key)) {
		throw new Error(`${label} has dangling peer-qualified reference ${key}`);
	}
	return parseLocator(key, workspace.snapshots[key], "snapshots");
}

function collectReverseEdges(
	workspace: ParsedWorkspace,
	dependencyName: string,
): ReverseEdge[] {
	const edges: ReverseEdge[] = [];
	for (const [key, value] of Object.entries(workspace.snapshots)) {
		const locator = parseLocator(key, value, "snapshots");
		for (const section of ["dependencies", "optionalDependencies"] as const) {
			const sectionValue = locator.value[section];
			if (sectionValue === undefined) continue;
			const dependencyMap = requireRecord(
				sectionValue,
				`${locator.key}.${section}`,
			);
			if (!Object.hasOwn(dependencyMap, dependencyName)) continue;
			const reference = requireString(
				dependencyMap[dependencyName],
				`${locator.key}.${section}.${dependencyName}`,
			);
			edges.push({
				parentIdentity: locator.key,
				parentKind: "snapshot",
				reference,
				section,
				target: referenceTarget(
					workspace,
					dependencyName,
					reference,
					`${locator.key}.${section}.${dependencyName}`,
				),
			});
		}
	}

	for (const [importerName, value] of Object.entries(workspace.importers)) {
		const importer = requireRecord(value, `importers.${importerName}`);
		for (const section of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
		] as const) {
			const sectionValue = importer[section];
			if (sectionValue === undefined) continue;
			const dependencyMap = requireRecord(
				sectionValue,
				`importers.${importerName}.${section}`,
			);
			if (!Object.hasOwn(dependencyMap, dependencyName)) continue;
			const entry = requireRecord(
				dependencyMap[dependencyName],
				`importers.${importerName}.${section}.${dependencyName}`,
			);
			if (Object.keys(entry).sort().join(",") !== "specifier,version") {
				throw new Error(
					`importers.${importerName}.${section}.${dependencyName} has an unexpected shape`,
				);
			}
			requireString(
				entry.specifier,
				`importers.${importerName}.${section}.${dependencyName}.specifier`,
			);
			const reference = requireString(
				entry.version,
				`importers.${importerName}.${section}.${dependencyName}.version`,
			);
			edges.push({
				parentIdentity: importerName,
				parentKind: "importer",
				reference,
				section,
				target: referenceTarget(
					workspace,
					dependencyName,
					reference,
					`importers.${importerName}.${section}.${dependencyName}`,
				),
			});
		}
	}

	return edges.sort((left, right) =>
		edgeIdentity(left).localeCompare(edgeIdentity(right)),
	);
}

function edgeIdentity(edge: ReverseEdge): string {
	return `${edge.parentKind}:${edge.parentIdentity}:${edge.section}`;
}

function snapshotEdge(
	parent: Locator,
	section: Extract<
		DependencySection,
		"dependencies" | "optionalDependencies"
	> = "dependencies",
): string {
	return `snapshot:${parent.key}:${section}`;
}

function importerEdge(
	importerName: string,
	section: DependencySection = "dependencies",
): string {
	return `importer:${importerName}:${section}`;
}

function validateExactReverseEdges(
	workspace: ParsedWorkspace,
	target: Locator,
	expectedParents: readonly string[],
): void {
	const actual = collectReverseEdges(workspace, target.name)
		.filter((edge) => edge.target.key === target.key)
		.map(edgeIdentity)
		.sort();
	const expected = [...expectedParents].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${target.key} has an unexpected total reverse-edge set`);
	}
}

function validateRuntimeRoots(
	workspace: ParsedWorkspace,
	runtime: Locator,
): void {
	validateExactReverseEdges(workspace, runtime, [
		importerEdge("examples/chat/web"),
		importerEdge("examples/research/web"),
	]);
	for (const importerName of ["examples/chat/web", "examples/research/web"]) {
		const importer = importerDependency(
			workspace,
			importerName,
			"dependencies",
			"@copilotkit/runtime",
		);
		if (
			importer.specifier !== "^1.66.0" ||
			`@copilotkit/runtime@${importer.version}` !== runtime.key
		) {
			throw new Error(
				`${importerName} does not bind the exact runtime snapshot`,
			);
		}
	}
}

function validateProviderUtilsPath(workspace: ParsedWorkspace): void {
	for (const recordName of ["packages", "snapshots"] as const) {
		const versions = locatorsFor(
			workspace[recordName],
			"@ai-sdk/provider-utils",
			recordName,
		)
			.map((locator) => locator.version)
			.sort((left, right) => compareVersions(left, right));
		if (JSON.stringify(versions) !== JSON.stringify(["3.0.28", "4.0.37"])) {
			throw new Error(`provider-utils has an unexpected ${recordName} set`);
		}
	}
	const providerUtils = uniqueLocator(
		workspace.snapshots,
		"@ai-sdk/provider-utils",
		"3.0.28",
	);
	const vertex = validateCompleteIdentity(
		workspace,
		"@ai-sdk/google-vertex",
		"3.0.146",
	);
	const providerParents = exactProviderUtilsParents.map(([name, version]) =>
		uniqueLocator(workspace.snapshots, name, version),
	);
	validateExactReverseEdges(
		workspace,
		providerUtils,
		providerParents.map((parent) => snapshotEdge(parent)),
	);
	for (const parent of providerParents) {
		if (
			dependencyVersion(parent, "@ai-sdk/provider-utils") !==
			locatorReference(providerUtils)
		) {
			throw new Error(
				`${parent.key} does not bind the exact provider-utils identity`,
			);
		}
	}

	for (const [name, version] of exactProviderUtilsParents) {
		if (name === "@ai-sdk/google-vertex") continue;
		const child = uniqueLocator(workspace.snapshots, name, version);
		if (dependencyVersion(vertex, name) !== locatorReference(child)) {
			throw new Error(`Google Vertex does not bind ${name}@${version}`);
		}
		validateExactReverseEdges(workspace, child, [snapshotEdge(vertex)]);
	}
	if (
		dependencyVersion(vertex, "@ai-sdk/provider-utils") !==
		locatorReference(providerUtils)
	) {
		throw new Error("Google Vertex does not bind provider-utils 3.0.28");
	}

	const runtime = validateCompleteIdentity(
		workspace,
		"@copilotkit/runtime",
		"1.66.4",
	);
	if (
		dependencyVersion(runtime, "@ai-sdk/google-vertex") !==
		locatorReference(vertex)
	) {
		throw new Error(
			"Copilot runtime does not bind the exact Google Vertex identity",
		);
	}
	validateExactReverseEdges(workspace, vertex, [snapshotEdge(runtime)]);
	validateRuntimeRoots(workspace, runtime);
}

describe("dependency security lock receipt", () => {
	it("pins the dedicated config boundary, TSX include, and app-local browser mappings", async () => {
		const vitestConfig = (await import("./vitest.config.ts")).default;
		const config = vitestConfig;
		const testConfig = requireRecord(config.test, "vitest config test block");
		expect(config.root).toBe(repositoryRoot);
		expect(testConfig.environment).toBe("node");
		expect(testConfig.testTimeout).toBe(30_000);
		expect(testConfig.hookTimeout).toBe(30_000);
		expect(testConfig.include).toEqual([
			"test/security-dependencies/**/*.test.ts",
			"test/security-dependencies/**/*.test.tsx",
		]);
		expect(testConfig.env).toEqual({
			GH_TOKEN: "",
			GITHUB_TOKEN: "",
			NODE_AUTH_TOKEN: "",
			NPM_TOKEN: "",
		});

		const tsconfig = requireRecord(
			JSON.parse(readFileSync(resolve(testDirectory, "tsconfig.json"), "utf8")),
			"security tsconfig",
		);
		const compilerOptions = requireRecord(
			tsconfig.compilerOptions,
			"security tsconfig compilerOptions",
		);
		expect(compilerOptions.jsx).toBe("react-jsx");
		expect(compilerOptions.allowImportingTsExtensions).toBe(true);
		expect(compilerOptions.lib).toEqual(["ES2022", "DOM", "DOM.Iterable"]);
		expect(compilerOptions.noEmit).toBe(true);
		expect(compilerOptions.paths).toEqual({
			"@copilotkit/react-core/v2": [
				"../../examples/chat/web/node_modules/@copilotkit/react-core/dist/v2/index.d.mts",
			],
			react: ["../../examples/chat/web/node_modules/@types/react/index.d.ts"],
			"react/jsx-runtime": [
				"../../examples/chat/web/node_modules/@types/react/jsx-runtime.d.ts",
			],
			"react-dom": [
				"../../examples/chat/web/node_modules/@types/react-dom/index.d.ts",
			],
			"react-dom/client": [
				"../../examples/chat/web/node_modules/@types/react-dom/client.d.ts",
			],
		});
	});

	it("keeps exactly seven baseline overrides and the three reviewed replacements", () => {
		const workspace = readWorkspace();
		expect(() =>
			validateOverridePolicy(workspace.manifestOverrides),
		).not.toThrow();
		expect(
			Object.fromEntries(
				Object.entries(workspace.manifestOverrides).filter(([selector]) =>
					Object.hasOwn(expectedUnrelatedOverrides, selector),
				),
			),
		).toEqual(expectedUnrelatedOverrides);
	});

	it("contains no targeted snapshot below its advisory floor", () => {
		expect(floorFailures(readWorkspace())).toEqual([]);
	});

	it("binds the complete deterministic target package and snapshot sets", () => {
		expect(() => validateExactSnapshotSets(readWorkspace())).not.toThrow();
	});

	it("resolves one node-server 2.1.0 identity through CLI, CopilotKit, and MCP", () => {
		expect(() => validateNodeServerGraph(readWorkspace())).not.toThrow();
	});

	it("retains provider-utils 3.0.28 only below private-example CopilotKit Google Vertex", () => {
		const workspace = readWorkspace();
		expect(() => validateProviderUtilsPath(workspace)).not.toThrow();
		for (const [relativePath, name] of [
			["examples/chat/web/package.json", "@dawn-example/chat-web"],
			["examples/research/web/package.json", "@dawn-example/research-web"],
		] as const) {
			const manifest = requireRecord(
				JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8")),
				relativePath,
			);
			expect(manifest).toMatchObject({ name, private: true });
		}
	});

	it("fails closed on malformed structure and ambiguous package identities", () => {
		expect(() => parseManifest("{")).toThrow("valid JSON");
		expect(() =>
			parseLockfile("lockfileVersion: 9\nsettings: false\n"),
		).toThrow("pnpm-lock.yaml");
		expect(() =>
			parseLockfile("lockfileVersion: '9.0'\nlockfileVersion: '9.0'\n"),
		).toThrow("parse without errors");

		const ambiguous = {
			"@hono/node-server@2.1.0(hono@4.13.1)": { dependencies: {} },
			"@hono/node-server@2.1.0(hono@4.13.2)": { dependencies: {} },
		};
		expect(() =>
			uniqueLocator(ambiguous, "@hono/node-server", "2.1.0"),
		).toThrow("exactly one");
	});

	it("rejects old/new mixtures, missing targets, and wrong override selectors", () => {
		const workspace = readWorkspace();
		const safeSnapshots = structuredClone(workspace.snapshots);
		const safePackages = structuredClone(workspace.packages);
		for (const name of Object.keys(expectedSnapshotVersions)) {
			for (const locator of locatorsFor(safeSnapshots, name, "snapshots")) {
				delete safeSnapshots[locator.key];
			}
			for (const locator of locatorsFor(safePackages, name, "packages")) {
				delete safePackages[locator.key];
			}
			for (const version of expectedSnapshotVersions[
				name as keyof typeof expectedSnapshotVersions
			]) {
				safeSnapshots[`${name}@${version}`] = {};
				safePackages[`${name}@${version}`] = {};
			}
		}
		const safeWorkspace = {
			...workspace,
			packages: safePackages,
			snapshots: safeSnapshots,
		};
		expect(floorFailures(safeWorkspace)).toEqual([]);
		expect(() => validateExactSnapshotSets(safeWorkspace)).not.toThrow();

		const mixedWorkspace = structuredClone(safeWorkspace);
		mixedWorkspace.snapshots["postcss@8.5.10"] = {};
		expect(floorFailures(mixedWorkspace)).toContain(
			"postcss@8.5.10 is below 8.5.23",
		);
		expect(() => validateExactSnapshotSets(mixedWorkspace)).toThrow();

		const missingWorkspace = structuredClone(safeWorkspace);
		delete missingWorkspace.snapshots["mermaid@11.16.1"];
		expect(() => validateExactSnapshotSets(missingWorkspace)).toThrow();

		const wrongSelector = {
			...expectedOverrides,
			"@hono/node-server": "2.1.0",
		};
		delete (wrongSelector as Record<string, string>)[
			"@hono/node-server@<2.0.10"
		];
		expect(() => validateOverridePolicy(wrongSelector)).toThrow();
		expect(() =>
			validateOverridePolicy({
				...expectedOverrides,
				"hono@<4.13.1": "4.13.1",
			}),
		).toThrow();

		const malformedProviderWorkspace = structuredClone(workspace);
		const vertex = uniqueLocator(
			malformedProviderWorkspace.snapshots,
			"@ai-sdk/google-vertex",
			"3.0.146",
		);
		requireRecord(vertex.value.dependencies, "Vertex dependencies")[
			"@ai-sdk/provider-utils"
		] = 3028;
		expect(() => validateProviderUtilsPath(malformedProviderWorkspace)).toThrow(
			"must be a non-empty string",
		);

		const extraProviderParentWorkspace = structuredClone(workspace);
		const mcp = uniqueLocator(
			extraProviderParentWorkspace.snapshots,
			"@modelcontextprotocol/sdk",
			"1.29.0",
		);
		requireRecord(mcp.value.dependencies, "MCP dependencies")[
			"@ai-sdk/provider-utils"
		] = "3.0.28(zod@3.25.76)";
		expect(() =>
			validateProviderUtilsPath(extraProviderParentWorkspace),
		).toThrow("unexpected total reverse-edge set");

		const missingRuntimeReferenceWorkspace = structuredClone(workspace);
		const runtime = uniqueLocator(
			missingRuntimeReferenceWorkspace.snapshots,
			"@copilotkit/runtime",
			"1.66.4",
		);
		delete requireRecord(runtime.value.dependencies, "runtime dependencies")[
			"@modelcontextprotocol/sdk"
		];
		expect(() =>
			dependencyVersion(runtime, "@modelcontextprotocol/sdk"),
		).toThrow("must be a non-empty string");

		const danglingPeerMutations: Array<readonly [string, ParsedWorkspace]> = [];

		const wrongVertexChildPeer = structuredClone(workspace);
		const wrongVertex = uniqueLocator(
			wrongVertexChildPeer.snapshots,
			"@ai-sdk/google-vertex",
			"3.0.146",
		);
		requireRecord(wrongVertex.value.dependencies, "Vertex dependencies")[
			"@ai-sdk/anthropic"
		] = "2.0.85(zod@0.0.0)";
		danglingPeerMutations.push(["Vertex child peer", wrongVertexChildPeer]);

		const wrongProviderPeer = structuredClone(workspace);
		const anthropic = uniqueLocator(
			wrongProviderPeer.snapshots,
			"@ai-sdk/anthropic",
			"2.0.85",
		);
		requireRecord(anthropic.value.dependencies, "Anthropic dependencies")[
			"@ai-sdk/provider-utils"
		] = "3.0.28(zod@0.0.0)";
		danglingPeerMutations.push(["provider peer", wrongProviderPeer]);

		const directVertexImporter = structuredClone(workspace);
		const cliImporter = requireRecord(
			directVertexImporter.importers["packages/cli"],
			"CLI importer",
		);
		requireRecord(cliImporter.dependencies, "CLI dependencies")[
			"@ai-sdk/google-vertex"
		] = {
			specifier: "3.0.146",
			version: locatorReference(vertex),
		};
		danglingPeerMutations.push([
			"direct Vertex importer",
			directVertexImporter,
		]);

		const directAnthropicImporter = structuredClone(workspace);
		const anthropicCliImporter = requireRecord(
			directAnthropicImporter.importers["packages/cli"],
			"CLI importer",
		);
		requireRecord(anthropicCliImporter.dependencies, "CLI dependencies")[
			"@ai-sdk/anthropic"
		] = {
			specifier: "2.0.85",
			version: locatorReference(
				uniqueLocator(
					directAnthropicImporter.snapshots,
					"@ai-sdk/anthropic",
					"2.0.85",
				),
			),
		};
		danglingPeerMutations.push([
			"direct Anthropic importer",
			directAnthropicImporter,
		]);

		const optionalProviderParent = structuredClone(workspace);
		const optionalMcp = uniqueLocator(
			optionalProviderParent.snapshots,
			"@modelcontextprotocol/sdk",
			"1.29.0",
		);
		if (optionalMcp.value.optionalDependencies === undefined) {
			optionalMcp.value.optionalDependencies = {};
		}
		const optionalDependencies = requireRecord(
			optionalMcp.value.optionalDependencies,
			"MCP optional dependencies",
		);
		optionalDependencies["@ai-sdk/provider-utils"] = locatorReference(
			uniqueLocator(
				optionalProviderParent.snapshots,
				"@ai-sdk/provider-utils",
				"3.0.28",
			),
		);
		danglingPeerMutations.push([
			"optional provider parent",
			optionalProviderParent,
		]);

		const acceptedProviderMutations = danglingPeerMutations.flatMap(
			([label, mutant]) => {
				try {
					validateProviderUtilsPath(mutant);
					return [label];
				} catch {
					return [];
				}
			},
		);
		expect(acceptedProviderMutations).toEqual([]);

		const safeNodeWorkspace = structuredClone(workspace);
		for (const locator of locatorsFor(
			safeNodeWorkspace.packages,
			"@hono/node-server",
			"packages",
		)) {
			delete safeNodeWorkspace.packages[locator.key];
		}
		for (const locator of locatorsFor(
			safeNodeWorkspace.snapshots,
			"@hono/node-server",
			"snapshots",
		)) {
			delete safeNodeWorkspace.snapshots[locator.key];
		}
		safeNodeWorkspace.packages["@hono/node-server@2.1.0"] = {};
		safeNodeWorkspace.snapshots["@hono/node-server@2.1.0(hono@4.13.1)"] = {
			dependencies: { hono: "4.13.1" },
		};
		importerDependency(
			safeNodeWorkspace,
			"packages/cli",
			"devDependencies",
			"@hono/node-server",
		);
		const cliNodeEntry = requireRecord(
			requireRecord(
				requireRecord(
					safeNodeWorkspace.importers["packages/cli"],
					"CLI importer",
				).devDependencies,
				"CLI devDependencies",
			)["@hono/node-server"],
			"CLI node-server",
		);
		cliNodeEntry.version = "2.1.0(hono@4.13.1)";
		for (const [name, version] of [
			["@copilotkit/runtime", "1.66.4"],
			["@modelcontextprotocol/sdk", "1.29.0"],
		] as const) {
			const parent = uniqueLocator(safeNodeWorkspace.snapshots, name, version);
			requireRecord(parent.value.dependencies, `${name} dependencies`)[
				"@hono/node-server"
			] = "2.1.0(hono@4.13.1)";
		}
		expect(() => validateNodeServerGraph(safeNodeWorkspace)).not.toThrow();

		const extraNodeParentWorkspace = structuredClone(safeNodeWorkspace);
		const nodeParent = uniqueLocator(
			extraNodeParentWorkspace.snapshots,
			"@ai-sdk/google-vertex",
			"3.0.146",
		);
		nodeParent.value.optionalDependencies = {
			"@hono/node-server": "2.1.0(hono@4.13.1)",
		};
		expect(() => validateNodeServerGraph(extraNodeParentWorkspace)).toThrow();
	});
});
