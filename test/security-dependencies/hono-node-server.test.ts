import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../..");
const mcpStreamableHttpSubpath =
	"@modelcontextprotocol/sdk/server/streamableHttp.js";

const appAnchors = [
	{
		label: "chat",
		packagePath: resolve(repositoryRoot, "examples/chat/web/package.json"),
	},
	{
		label: "research",
		packagePath: resolve(repositoryRoot, "examples/research/web/package.json"),
	},
] as const;

type JsonRecord = Record<string, unknown>;

interface PackageIdentity {
	readonly exports: JsonRecord;
	readonly name: string;
	readonly packagePath: string;
	readonly version: string;
}

interface AnchorGraph {
	readonly copilotNodeServer: PackageIdentity;
	readonly honoPackage: PackageIdentity;
	readonly mcp: PackageIdentity;
	readonly mcpNodeServer: PackageIdentity;
	readonly runtime: PackageIdentity;
	readonly runtimeRequire: NodeJS.Require;
}

interface AdapterModule {
	readonly getRequestListener: (
		fetchCallback: FetchCallback,
		options?: {
			readonly autoCleanupIncoming?: boolean;
			readonly hostname?: string;
			readonly overrideGlobalObjects?: boolean;
		},
	) => (request: unknown, response: unknown) => Promise<void>;
	readonly serve: (
		options: {
			readonly fetch: FetchCallback;
			readonly hostname: string;
			readonly overrideGlobalObjects: boolean;
			readonly port: number;
		},
		listeningListener?: (info: { readonly port: number }) => void,
	) => Server;
}

interface HonoContext {
	readonly json: (value: unknown, status?: number) => Response;
	readonly req: {
		readonly json: () => Promise<unknown>;
	};
}

interface HonoApp {
	readonly fetch: FetchCallback;
	get(path: string, handler: (context: HonoContext) => Response): void;
	post(
		path: string,
		handler: (context: HonoContext) => Promise<Response>,
	): void;
}

interface ListenerHarness {
	readonly failure: Promise<never>;
	readonly server: Server;
}

interface CapturedFailure {
	readonly value: unknown;
}

type FetchCallback = (
	request: Request,
	environment?: unknown,
) => Promise<Response> | Response;

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

function requireFoundPackage(
	specifier: string,
	base: URL,
	label: string,
): string {
	const packagePath = findPackageJSON(specifier, base);
	if (!packagePath) throw new Error(`${label} package.json was not found`);
	return realpathSync(packagePath);
}

function readPackageIdentity(
	packagePath: string,
	expectedName: string,
): PackageIdentity {
	const packageJson = requireRecord(
		JSON.parse(readFileSync(packagePath, "utf8")),
		`${expectedName} package.json`,
	);
	const name = requireString(packageJson.name, `${expectedName} name`);
	if (name !== expectedName) {
		throw new Error(`expected ${expectedName} package, received ${name}`);
	}
	return {
		exports: requireRecord(packageJson.exports, `${expectedName} exports`),
		name,
		packagePath,
		version: requireString(packageJson.version, `${expectedName} version`),
	};
}

function isContainedFile(packagePath: string, targetPath: string): boolean {
	const packageDirectory = dirname(packagePath);
	const targetRelativePath = relative(packageDirectory, targetPath);
	return (
		targetRelativePath.length > 0 &&
		!targetRelativePath.startsWith("..") &&
		!isAbsolute(targetRelativePath)
	);
}

function selectExportBranch(
	exportsMap: JsonRecord,
	subpath: string,
): { readonly branch: unknown; readonly wildcard: string } {
	if (Object.hasOwn(exportsMap, subpath)) {
		return { branch: exportsMap[subpath], wildcard: "" };
	}
	const matchingPatterns = Object.keys(exportsMap).filter((pattern) => {
		const wildcardIndex = pattern.indexOf("*");
		if (wildcardIndex < 0 || pattern.indexOf("*", wildcardIndex + 1) >= 0) {
			return false;
		}
		return (
			subpath.startsWith(pattern.slice(0, wildcardIndex)) &&
			subpath.endsWith(pattern.slice(wildcardIndex + 1))
		);
	});
	if (matchingPatterns.length !== 1) {
		throw new Error(`${subpath} must match exactly one export branch`);
	}
	const pattern = matchingPatterns[0];
	if (!pattern) throw new Error(`${subpath} export pattern disappeared`);
	const wildcardIndex = pattern.indexOf("*");
	const wildcard = subpath.slice(
		wildcardIndex,
		subpath.length - (pattern.length - wildcardIndex - 1),
	);
	return { branch: exportsMap[pattern], wildcard };
}

function selectConditionTarget(
	branch: unknown,
	condition: "import" | "require",
): string {
	const conditions = requireRecord(branch, "package export branch");
	const conditionKeys = Object.keys(conditions).sort();
	if (
		JSON.stringify(conditionKeys) ===
		JSON.stringify(["import", "require", "types"])
	) {
		requireString(conditions.types, "types export target");
		return requireString(conditions[condition], `${condition} export target`);
	}
	if (JSON.stringify(conditionKeys) !== JSON.stringify(["import", "require"])) {
		throw new Error("package export branch has an unexpected condition shape");
	}

	const targets: Partial<Record<"import" | "require", string>> = {};
	for (const branchCondition of ["import", "require"] as const) {
		const nested = requireRecord(
			conditions[branchCondition],
			`${branchCondition} export condition`,
		);
		const nestedKeys = Object.keys(nested).sort();
		if (
			JSON.stringify(nestedKeys) !== JSON.stringify(["default", "types"]) ||
			typeof nested.types !== "string"
		) {
			throw new Error(
				`${branchCondition} export condition has an unexpected shape`,
			);
		}
		targets[branchCondition] = requireString(
			nested.default,
			`${branchCondition} default export target`,
		);
	}
	return requireString(
		targets[condition],
		`${condition} selected export target`,
	);
}

function resolveExportTarget(
	identity: PackageIdentity,
	subpath: string,
	condition: "import" | "require",
): string {
	const { branch, wildcard } = selectExportBranch(identity.exports, subpath);
	const selected = selectConditionTarget(branch, condition).replaceAll(
		"*",
		wildcard,
	);
	if (!selected.startsWith("./") || selected.includes("\\")) {
		throw new Error(
			`${identity.name} export target must be a relative POSIX path`,
		);
	}
	const targetPath = realpathSync(
		resolve(dirname(identity.packagePath), selected),
	);
	if (!isContainedFile(identity.packagePath, targetPath)) {
		throw new Error(`${identity.name} export target escaped its package`);
	}
	if (!statSync(targetPath).isFile()) {
		throw new Error(`${identity.name} export target is not a regular file`);
	}
	return targetPath;
}

function resolveAnchorGraph(packagePath: string): AnchorGraph {
	const appRequire = createRequire(packagePath);
	const runtimeEntry = realpathSync(appRequire.resolve("@copilotkit/runtime"));
	const runtime = readPackageIdentity(
		requireFoundPackage(
			"@copilotkit/runtime",
			pathToFileURL(packagePath),
			"Copilot runtime",
		),
		"@copilotkit/runtime",
	);
	if (!isContainedFile(runtime.packagePath, runtimeEntry)) {
		throw new Error("Copilot runtime entry escaped its resolved package");
	}

	// Nested pnpm dependencies are reachable only from the physical runtime path.
	const runtimeRequire = createRequire(runtime.packagePath);
	const mcpRequireEntry = realpathSync(
		runtimeRequire.resolve(mcpStreamableHttpSubpath),
	);
	const mcp = readPackageIdentity(
		requireFoundPackage(
			mcpStreamableHttpSubpath,
			pathToFileURL(runtime.packagePath),
			"MCP SDK",
		),
		"@modelcontextprotocol/sdk",
	);
	if (
		mcpRequireEntry !==
		resolveExportTarget(mcp, "./server/streamableHttp.js", "require")
	) {
		throw new Error("MCP require resolution disagrees with its export map");
	}

	const copilotNodeServer = readPackageIdentity(
		requireFoundPackage(
			"@hono/node-server",
			pathToFileURL(runtime.packagePath),
			"Copilot node-server",
		),
		"@hono/node-server",
	);
	const mcpNodeServer = readPackageIdentity(
		requireFoundPackage(
			"@hono/node-server",
			pathToFileURL(mcp.packagePath),
			"MCP node-server",
		),
		"@hono/node-server",
	);
	const honoPackage = readPackageIdentity(
		requireFoundPackage(
			"hono",
			pathToFileURL(copilotNodeServer.packagePath),
			"node-server Hono peer",
		),
		"hono",
	);

	return {
		copilotNodeServer,
		honoPackage,
		mcp,
		mcpNodeServer,
		runtime,
		runtimeRequire,
	};
}

function requireAdapterModule(value: unknown, label: string): AdapterModule {
	const module = requireRecord(value, label);
	if (
		typeof module.serve !== "function" ||
		typeof module.getRequestListener !== "function"
	) {
		throw new Error(`${label} lacks serve or getRequestListener`);
	}
	return module as unknown as AdapterModule;
}

async function loadAdapters(graph: AnchorGraph): Promise<{
	readonly commonJs: AdapterModule;
	readonly commonJsTarget: string;
	readonly esm: AdapterModule;
	readonly esmTarget: string;
}> {
	const commonJsTarget = resolveExportTarget(
		graph.copilotNodeServer,
		".",
		"require",
	);
	const esmTarget = resolveExportTarget(graph.copilotNodeServer, ".", "import");
	if (commonJsTarget === esmTarget) {
		throw new Error("node-server CJS and ESM targets must be distinct files");
	}
	const packageRequire = createRequire(graph.copilotNodeServer.packagePath);
	return {
		commonJs: requireAdapterModule(
			packageRequire(commonJsTarget),
			"node-server CJS target",
		),
		commonJsTarget,
		esm: requireAdapterModule(
			await import(pathToFileURL(esmTarget).href),
			"node-server ESM target",
		),
		esmTarget,
	};
}

function createHonoApp(graph: AnchorGraph): HonoApp {
	const honoRequire = createRequire(graph.copilotNodeServer.packagePath);
	const honoEntry = realpathSync(honoRequire.resolve("hono"));
	if (!isContainedFile(graph.honoPackage.packagePath, honoEntry)) {
		throw new Error("Hono entry escaped the node-server peer package");
	}
	const honoModule = requireRecord(honoRequire(honoEntry), "Hono CJS module");
	if (typeof honoModule.Hono !== "function") {
		throw new Error("Hono CJS module lacks its Hono constructor");
	}
	const Hono = honoModule.Hono as new () => HonoApp;
	const app = new Hono();
	app.get("/roundtrip", (context) => context.json({ method: "GET", ok: true }));
	app.post("/roundtrip", async (context) =>
		context.json({ body: await context.req.json(), method: "POST" }),
	);
	return app;
}

async function waitForServer(
	server: Server,
	timeoutMs = 5_000,
): Promise<number> {
	if (!server.listening) {
		await new Promise<void>((settle, reject) => {
			let finished = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const finish = (error?: Error): void => {
				if (finished) return;
				finished = true;
				if (timeout) clearTimeout(timeout);
				server.off("listening", onListening);
				server.off("error", onError);
				if (error) reject(error);
				else settle();
			};
			const onListening = (): void => finish();
			const onError = (error: Error): void => finish(error);
			server.once("listening", onListening);
			server.once("error", onError);
			// Close the gap where listening starts between the outer check and handlers above.
			if (server.listening) finish();
			if (!finished) {
				timeout = setTimeout(
					() =>
						finish(
							new Error(`loopback server did not start within ${timeoutMs}ms`),
						),
					timeoutMs,
				);
			}
		});
	}
	const address = server.address();
	if (address === null || typeof address === "string" || address.port <= 0) {
		throw new Error("loopback server did not expose a numeric port");
	}
	return address.port;
}

function isServerNotRunning(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ERR_SERVER_NOT_RUNNING"
	);
}

async function closeServer(server: Server, timeoutMs = 5_000): Promise<void> {
	const closing = new Promise<void>((settle, reject) => {
		const finish = (error?: Error): void => {
			if (error && !isServerNotRunning(error)) reject(error);
			else settle();
		};
		try {
			server.close(finish);
		} catch (error) {
			if (isServerNotRunning(error)) settle();
			else reject(error);
		} finally {
			server.closeAllConnections?.();
		}
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			closing,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() =>
						reject(
							new Error(`loopback server did not close within ${timeoutMs}ms`),
						),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function closeServers(
	servers: readonly (Server | undefined)[],
): Promise<void> {
	const results = await Promise.allSettled(
		servers
			.filter((server): server is Server => server !== undefined)
			.map((server) => closeServer(server)),
	);
	const errors = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (errors.length > 0) {
		throw new AggregateError(
			errors,
			"one or more loopback servers failed to close",
		);
	}
}

async function completeServerCleanup(
	servers: readonly (Server | undefined)[],
	primaryFailure?: CapturedFailure,
): Promise<void> {
	let cleanupFailure: CapturedFailure | undefined;
	try {
		await closeServers(servers);
	} catch (error) {
		cleanupFailure = { value: error };
	}
	if (primaryFailure) {
		if (cleanupFailure) {
			const cleanupErrors =
				cleanupFailure.value instanceof AggregateError
					? cleanupFailure.value.errors
					: [cleanupFailure.value];
			throw new AggregateError(
				[primaryFailure.value, ...cleanupErrors],
				"HTTP compatibility probe and cleanup both failed",
			);
		}
		throw primaryFailure.value;
	}
	if (cleanupFailure) throw cleanupFailure.value;
}

function createListenerServer(
	listener: (request: unknown, response: unknown) => Promise<void>,
): ListenerHarness {
	let rejectFailure: (error: Error) => void = () => {};
	const failure = new Promise<never>((_settle, reject) => {
		rejectFailure = reject;
	});
	return {
		failure,
		server: createServer((request, response) => {
			void listener(request, response).catch((error: unknown) => {
				const failureError =
					error instanceof Error ? error : new Error(String(error));
				rejectFailure(failureError);
				response.destroy(failureError);
			});
		}),
	};
}

async function requestJson(
	origin: string,
	path: string,
	init?: RequestInit,
	timeoutMs = 5_000,
): Promise<{ readonly body: unknown; readonly status: number }> {
	const response = await fetch(`${origin}${path}`, {
		...init,
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`loopback response was not JSON: ${text}`);
	}
	return { body, status: response.status };
}

async function exerciseHttpRoundtrip(graph: AnchorGraph): Promise<void> {
	const { commonJs, esm } = await loadAdapters(graph);
	const app = createHonoApp(graph);
	let serveServer: Server | undefined;
	let listenerServer: Server | undefined;
	let primaryFailure: CapturedFailure | undefined;
	try {
		serveServer = commonJs.serve({
			fetch: app.fetch.bind(app),
			hostname: "127.0.0.1",
			overrideGlobalObjects: false,
			port: 0,
		});
		const servePort = await waitForServer(serveServer);
		expect(
			await requestJson(`http://127.0.0.1:${servePort}`, "/roundtrip"),
		).toEqual({
			body: { method: "GET", ok: true },
			status: 200,
		});

		const listener = esm.getRequestListener(app.fetch.bind(app), {
			autoCleanupIncoming: true,
			hostname: "127.0.0.1",
			overrideGlobalObjects: false,
		});
		const listenerHarness = createListenerServer(listener);
		listenerServer = listenerHarness.server;
		listenerServer.listen(0, "127.0.0.1");
		const listenerPort = await waitForServer(listenerServer);
		expect(
			await Promise.race([
				requestJson(`http://127.0.0.1:${listenerPort}`, "/roundtrip", {
					body: JSON.stringify({ sentinel: "body-roundtrip" }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
				listenerHarness.failure,
			]),
		).toEqual({
			body: {
				body: { sentinel: "body-roundtrip" },
				method: "POST",
			},
			status: 200,
		});
	} catch (error) {
		primaryFailure = { value: error };
	}
	await completeServerCleanup([listenerServer, serveServer], primaryFailure);
}

async function exerciseMcpTransport(graph: AnchorGraph): Promise<void> {
	const esmTarget = resolveExportTarget(
		graph.mcp,
		"./server/streamableHttp.js",
		"import",
	);
	const module = requireRecord(
		await import(pathToFileURL(esmTarget).href),
		"MCP Streamable HTTP ESM target",
	);
	if (typeof module.StreamableHTTPServerTransport !== "function") {
		throw new Error("MCP Streamable HTTP module lacks its transport class");
	}
	const Transport = module.StreamableHTTPServerTransport as new (options: {
		readonly sessionIdGenerator: undefined;
	}) => {
		readonly close: () => Promise<void>;
		readonly sessionId: string | undefined;
		readonly start: () => Promise<void>;
	};
	const transport = new Transport({ sessionIdGenerator: undefined });
	try {
		expect(transport.sessionId).toBeUndefined();
		await transport.start();
	} finally {
		await transport.close();
	}
}

describe("app-anchored Hono node-server resolution", () => {
	for (const anchor of appAnchors) {
		it(`${anchor.label} Copilot runtime resolves the exact safe adapter`, () => {
			expect(
				resolveAnchorGraph(anchor.packagePath).copilotNodeServer.version,
			).toBe("2.1.0");
		});

		it(`${anchor.label} MCP SDK resolves the exact safe adapter`, () => {
			expect(resolveAnchorGraph(anchor.packagePath).mcpNodeServer.version).toBe(
				"2.1.0",
			);
		});

		it(`${anchor.label} loads true distinct CJS and ESM adapter targets`, async () => {
			const graph = resolveAnchorGraph(anchor.packagePath);
			expect(graph.runtime.version).toBe("1.66.4");
			expect(graph.mcp.version).toBe("1.29.0");
			expect(() =>
				graph.runtimeRequire.resolve("@hono/node-server/package.json"),
			).toThrow();
			const adapters = await loadAdapters(graph);
			expect(adapters.commonJsTarget).not.toBe(adapters.esmTarget);
			expect(typeof adapters.commonJs.serve).toBe("function");
			expect(typeof adapters.commonJs.getRequestListener).toBe("function");
			expect(typeof adapters.esm.serve).toBe("function");
			expect(typeof adapters.esm.getRequestListener).toBe("function");
		});

		it(`${anchor.label} serves a real GET and POST body roundtrip`, async () => {
			await exerciseHttpRoundtrip(resolveAnchorGraph(anchor.packagePath));
		});

		it(`${anchor.label} imports and constructs MCP Streamable HTTP`, async () => {
			await exerciseMcpTransport(resolveAnchorGraph(anchor.packagePath));
		});
	}

	it("rejects ambiguous, array, unknown, and types-only export maps", async () => {
		const packagePath = resolve(repositoryRoot, "package.json");
		const identity = (exportsMap: JsonRecord): PackageIdentity => ({
			exports: exportsMap,
			name: "fixture",
			packagePath,
			version: "1.0.0",
		});
		expect(
			resolveExportTarget(
				identity({
					".": {
						import: {
							default: "./package.json",
							types: "./package.json",
						},
						require: {
							default: "./package.json",
							types: "./package.json",
						},
					},
				}),
				".",
				"import",
			),
		).toBe(packagePath);
		expect(() =>
			resolveExportTarget(
				identity({
					".": {
						import: ["./package.json"],
						require: "./package.json",
						types: "./package.json",
					},
				}),
				".",
				"import",
			),
		).toThrow("must be a non-empty string");
		expect(() =>
			resolveExportTarget(
				identity({
					".": {
						import: {
							browser: "./package.json",
							default: "./package.json",
							types: "./package.json",
						},
						require: {
							default: "./package.json",
							types: "./package.json",
						},
					},
				}),
				".",
				"import",
			),
		).toThrow("unexpected shape");
		expect(() =>
			resolveExportTarget(
				identity({
					".": {
						import: { types: "./package.json" },
						require: {
							default: "./package.json",
							types: "./package.json",
						},
					},
				}),
				".",
				"import",
			),
		).toThrow("unexpected shape");
		expect(() =>
			resolveExportTarget(
				identity({
					"./*": { import: "./*" },
					"./server/*": { import: "./*" },
				}),
				"./server/value.js",
				"import",
			),
		).toThrow("exactly one export branch");

		const acceptedUnknownConditions = ["default", "node"].flatMap(
			(condition) => {
				try {
					resolveExportTarget(
						identity({
							".": {
								[condition]: "./package.json",
								import: "./package.json",
								require: "./package.json",
								types: "./package.json",
							},
						}),
						".",
						"import",
					);
					return [condition];
				} catch {
					return [];
				}
			},
		);
		expect(acceptedUnknownConditions).toEqual([]);

		const legacyBranch = (target: string): JsonRecord => ({
			".": {
				import: target,
				require: target,
				types: target,
			},
		});
		expect(() =>
			resolveExportTarget(
				{
					exports: legacyBranch("./../../package.json"),
					name: "lexical-escape-fixture",
					packagePath: resolve(testDirectory, "fixture-package.json"),
					version: "1.0.0",
				},
				".",
				"import",
			),
		).toThrow("escaped its package");
		expect(() =>
			resolveExportTarget(
				{
					exports: legacyBranch(
						"./node_modules/@copilotkit/runtime/package.json",
					),
					name: "symlink-escape-fixture",
					packagePath: resolve(
						repositoryRoot,
						"examples/chat/web/package.json",
					),
					version: "1.0.0",
				},
				".",
				"import",
			),
		).toThrow("escaped its package");

		const cleanupRegressions: string[] = [];
		const rejectingHarness = createListenerServer(async () => {
			throw new Error("sentinel listener rejection");
		});
		let rejectingPrimaryFailure: CapturedFailure | undefined;
		try {
			rejectingHarness.server.listen(0, "127.0.0.1");
			const rejectingPort = await waitForServer(rejectingHarness.server);
			let rejection: unknown;
			try {
				await Promise.race([
					requestJson(
						`http://127.0.0.1:${rejectingPort}`,
						"/reject",
						undefined,
						1_000,
					),
					rejectingHarness.failure,
				]);
			} catch (error) {
				rejection = error;
			}
			if (
				!(rejection instanceof Error) ||
				!rejection.message.includes("sentinel listener")
			) {
				cleanupRegressions.push("listener rejection was not causal");
			}
		} catch (error) {
			rejectingPrimaryFailure = { value: error };
		} finally {
			await completeServerCleanup(
				[rejectingHarness.server],
				rejectingPrimaryFailure,
			);
		}

		const neverListening = createServer();
		const baselineListeningListeners =
			neverListening.listenerCount("listening");
		const baselineErrorListeners = neverListening.listenerCount("error");
		const originalNeverClose = neverListening.close.bind(neverListening);
		let neverCloseAttempts = 0;
		neverListening.close = ((callback?: (error?: Error) => void) => {
			neverCloseAttempts += 1;
			return originalNeverClose(callback);
		}) as typeof neverListening.close;
		try {
			await waitForServer(neverListening, 10);
		} catch {
			// The bounded failure is the expected setup for the cleanup assertions.
		} finally {
			await closeServer(neverListening);
		}
		if (
			neverListening.listenerCount("listening") !==
				baselineListeningListeners ||
			neverListening.listenerCount("error") !== baselineErrorListeners
		) {
			cleanupRegressions.push("listen timeout retained event listeners");
		}
		if (neverCloseAttempts !== 1 || neverListening.address() !== null) {
			cleanupRegressions.push(
				"never-listening server was not actively canceled",
			);
		}

		const first = createServer((_request, response) => response.end("first"));
		const second = createServer((_request, response) => response.end("second"));
		const originalFirstClose = first.close.bind(first);
		const originalSecondClose = second.close.bind(second);
		let secondCloseAttempts = 0;
		first.close = ((callback?: (error?: Error) => void) =>
			originalFirstClose(() =>
				callback?.(new Error("sentinel cleanup failure")),
			)) as typeof first.close;
		second.close = ((callback?: (error?: Error) => void) => {
			secondCloseAttempts += 1;
			return originalSecondClose(callback);
		}) as typeof second.close;
		let combinedFailure: unknown;
		let startupFailure: CapturedFailure | undefined;
		try {
			first.listen(0, "127.0.0.1");
			second.listen(0, "127.0.0.1");
			await waitForServer(first);
			throw new Error("sentinel startup failure");
		} catch (error) {
			startupFailure = { value: error };
		} finally {
			try {
				await completeServerCleanup([first, second], startupFailure);
			} catch (error) {
				combinedFailure = error;
			} finally {
				if (first.listening) {
					await new Promise<void>((settle) =>
						originalFirstClose(() => settle()),
					);
				}
				if (second.listening) {
					await new Promise<void>((settle) =>
						originalSecondClose(() => settle()),
					);
				}
			}
		}
		if (secondCloseAttempts !== 1 || first.listening || second.listening) {
			cleanupRegressions.push("cleanup failure skipped a later server");
		}
		const combinedMessages =
			combinedFailure instanceof AggregateError
				? combinedFailure.errors.map((error) =>
						error instanceof Error ? error.message : String(error),
					)
				: [];
		if (
			!combinedMessages.includes("sentinel startup failure") ||
			!combinedMessages.includes("sentinel cleanup failure")
		) {
			cleanupRegressions.push(
				"cleanup aggregation lost primary or cleanup failure",
			);
		}
		expect(cleanupRegressions).toEqual([]);
	});
});

describe("example Copilot Next route controls", () => {
	const routes = [
		{
			label: "chat",
			load: () => import("../../examples/chat/web/app/api/copilotkit/route.ts"),
		},
		{
			label: "research",
			load: () =>
				import("../../examples/research/web/app/api/copilotkit/route.ts"),
		},
	] as const;

	for (const route of routes) {
		it(`${route.label} returns the exact missing-method response`, async () => {
			// biome-ignore lint/suspicious/noUndeclaredEnvVars: this third-party opt-out is set and restored inside the test.
			const previousTelemetry = process.env.COPILOTKIT_TELEMETRY_DISABLED;
			process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
			try {
				const module = await route.load();
				const response = await module.POST(
					new Request("http://127.0.0.1/api/copilotkit", {
						body: "{}",
						headers: { "content-type": "application/json" },
						method: "POST",
					}) as never,
				);
				expect(response.status).toBe(400);
				expect(await response.text()).toBe(
					'{"error":"invalid_request","message":"Missing method field"}',
				);
			} finally {
				if (previousTelemetry === undefined) {
					// biome-ignore lint/suspicious/noUndeclaredEnvVars: this restores the third-party opt-out to its prior state.
					delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
				} else {
					process.env.COPILOTKIT_TELEMETRY_DISABLED = previousTelemetry;
				}
			}
		});
	}
});
