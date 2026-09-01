import { spawn as nodeSpawn } from "node:child_process";
import {
	mkdir as nodeMkdir,
	mkdtemp as nodeMkdtemp,
	readFile as nodeReadFile,
	rm as nodeRm,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createAimock } from "../../../packages/testing/dist/index.js";
import { normalizeLog } from "./normalize-log.mjs";
import {
	getAvailableLoopbackPort,
	spawnManaged,
	stopManaged,
	waitForHttp,
} from "./processes.mjs";
import { DEMO_FIXTURES, DEMO_PROMPT } from "./scenario.mjs";
import { GENERATED_PATHS, renderStage } from "./stage.mjs";

const EXPECTED_TOOLS = DEMO_FIXTURES.flatMap(
	(fixture) =>
		fixture.response.toolCalls?.map((toolCall) => toolCall.name) ?? [],
);
const EXPECTED_ANSWER = DEMO_FIXTURES.findLast(
	(fixture) => typeof fixture.response.content === "string",
)?.response.content;
if (typeof EXPECTED_ANSWER !== "string") {
	throw new Error("Canonical demo fixtures must end in a text answer");
}
const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, "../../..");
const DEFAULT_SCAFFOLD_PORTS = new Set([3002, 3010]);
const TOOLCHAIN = Object.freeze({ node: "v24.19.0", pnpm: "10.33.0" });
const VIEWPORT = Object.freeze({ width: 1440, height: 810 });
const PROVIDER_PREFIX =
	/^(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|VERTEX|AZURE|AWS|BEDROCK)(?:_|$)/i;
const PROVIDER_SETTING =
	/(?:^|_)(?:API_KEY|BASE_URL|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/i;
const TRACING_SETTING = /^(?:LANGCHAIN|LANGSMITH)(?:_|$)/i;

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function requireString(value, name) {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
}

function assertCommandSucceeded(result, label) {
	if (result.exitCode === 0) return result;
	const transcript = [result.stdout, result.stderr].filter(Boolean).join("\n");
	throw new Error(
		`${label} failed with exit code ${result.exitCode}${transcript ? `\n${transcript}` : ""}`,
	);
}

export function generatedTestCommand() {
	return {
		command: "npm",
		// The first separator reaches the generated root script; the second makes
		// its inner workspace `npm run` forward Vitest's reporter flag.
		args: ["test", "--", "--", "--reporter=verbose"],
	};
}

export function generatedInstallCommand() {
	return { command: "pnpm", args: ["install"] };
}

export function sanitizeOperationalEnvironment(
	parentEnvironment = process.env,
) {
	if (!parentEnvironment || typeof parentEnvironment !== "object") {
		throw new TypeError("parentEnvironment must be an object");
	}
	return Object.fromEntries(
		Object.entries(parentEnvironment).filter(
			([key, value]) =>
				typeof value === "string" &&
				!PROVIDER_PREFIX.test(key) &&
				!PROVIDER_SETTING.test(key) &&
				!TRACING_SETTING.test(key),
		),
	);
}

export function assertLoopbackModelBaseUrl(value) {
	requireString(value, "model base URL");
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("model base URL must be a loopback HTTP(S) URL");
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const ipFamily = isIP(hostname);
	const isLoopback =
		(ipFamily === 4 && hostname.split(".")[0] === "127") ||
		(ipFamily === 6 && hostname === "::1");
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		!isLoopback ||
		url.username !== "" ||
		url.password !== ""
	) {
		throw new TypeError("model base URL must be a loopback HTTP(S) URL");
	}
	return url;
}

export function buildChildEnvironment(parentEnvironment, modelBaseUrl) {
	const url = assertLoopbackModelBaseUrl(modelBaseUrl);
	return {
		...sanitizeOperationalEnvironment(parentEnvironment),
		// `npm exec -- dawn ...` otherwise resolves the unrelated registry package
		// when dependencies were laid out by pnpm instead of npm.
		npm_config_package: "@dawn-ai/cli",
		OPENAI_BASE_URL: url.href,
		OPENAI_API_KEY: "test-not-used",
		COPILOTKIT_TELEMETRY_DISABLED: "true",
		DO_NOT_TRACK: "1",
	};
}

export async function startWithAssignedPort({
	service,
	excludedPorts = new Set(),
	getPort,
	start,
	maxAttempts = 3,
}) {
	requireString(service, "service");
	if (!(excludedPorts instanceof Set)) {
		throw new TypeError("excludedPorts must be a Set");
	}
	if (typeof getPort !== "function")
		throw new TypeError("getPort must be a function");
	if (typeof start !== "function")
		throw new TypeError("start must be a function");
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
		throw new TypeError("maxAttempts must be a positive integer");
	}

	const attemptedPorts = new Set(excludedPorts);
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const port = await getPort(attemptedPorts);
		if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
			throw new Error(`${service} port allocator returned an invalid port`);
		}
		if (attemptedPorts.has(port)) {
			throw new Error(
				`${service} port allocator returned excluded port ${port}`,
			);
		}
		attemptedPorts.add(port);
		try {
			const started = await start(port);
			if (
				started &&
				typeof started === "object" &&
				Object.hasOwn(started, "child")
			) {
				return { ...started, port };
			}
			return { child: started, port };
		} catch (error) {
			if (error?.code !== "EADDRINUSE") throw error;
			if (attempt === maxAttempts) {
				throw new Error(
					`${service} failed after ${maxAttempts} EADDRINUSE attempts`,
					{
						cause: error,
					},
				);
			}
		}
	}
	throw new Error(`${service} failed to start`);
}

export function createManagedChildRegistry(stopChild) {
	if (typeof stopChild !== "function") {
		throw new TypeError("stopChild must be a function");
	}
	const children = new Set();
	return {
		track(child) {
			children.add(child);
			return child;
		},
		async stop(child) {
			if (!children.has(child)) return;
			await stopChild(child);
			children.delete(child);
		},
		async stopRemaining() {
			const errors = [];
			for (const child of [...children].reverse()) {
				try {
					await stopChild(child);
					children.delete(child);
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length > 0) {
				throw new AggregateError(errors, "Managed child cleanup failed");
			}
		},
	};
}

function runCommand(command, args, { cwd, env, spawn = nodeSpawn } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawnManaged(command, args, {
			spawn,
			options: { cwd, env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			resolvePromise({
				stdout,
				stderr,
				exitCode: code ?? (signal === null ? 1 : 128),
				...(signal !== null ? { signal } : {}),
			});
		});
	});
}

function createCommandAdapter({ repoRoot, parentEnvironment }) {
	const environment = sanitizeOperationalEnvironment(parentEnvironment);
	return {
		async checkToolchain() {
			const [nodeResult, pnpmResult] = await Promise.all([
				runCommand("node", ["--version"], { cwd: repoRoot, env: environment }),
				runCommand("pnpm", ["--version"], { cwd: repoRoot, env: environment }),
			]);
			assertCommandSucceeded(nodeResult, "node --version");
			assertCommandSucceeded(pnpmResult, "pnpm --version");
			const actual = {
				node: nodeResult.stdout.trim(),
				pnpm: pnpmResult.stdout.trim(),
			};
			if (actual.node !== TOOLCHAIN.node || actual.pnpm !== TOOLCHAIN.pnpm) {
				throw new Error(
					`Capture requires Node ${TOOLCHAIN.node} and pnpm ${TOOLCHAIN.pnpm}; received Node ${actual.node} and pnpm ${actual.pnpm}`,
				);
			}
		},
		async build() {
			assertCommandSucceeded(
				await runCommand("pnpm", ["build"], {
					cwd: repoRoot,
					env: environment,
				}),
				"pnpm build",
			);
		},
		async scaffold({ appRoot }) {
			assertCommandSucceeded(
				await runCommand(
					"node",
					[
						join(repoRoot, "packages/create-dawn-app/dist/bin.js"),
						appRoot,
						"--mode",
						"internal",
					],
					{ cwd: repoRoot, env: environment },
				),
				"internal scaffold",
			);
		},
		async install({ appRoot }) {
			const installCommand = generatedInstallCommand();
			assertCommandSucceeded(
				await runCommand(installCommand.command, installCommand.args, {
					cwd: appRoot,
					env: environment,
				}),
				"pnpm install",
			);
		},
		test({ appRoot }) {
			const testCommand = generatedTestCommand();
			return runCommand(testCommand.command, testCommand.args, {
				cwd: appRoot,
				env: environment,
			});
		},
	};
}

async function startHttpService({
	command,
	args,
	cwd,
	env,
	readyUrl,
	service,
	childRegistry,
}) {
	const child = childRegistry.track(
		spawnManaged(command, args, { options: { cwd, env } }),
	);
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		await waitForHttp(readyUrl, child, { timeoutMs: 90_000, intervalMs: 150 });
		return child;
	} catch (error) {
		let cleanupError;
		try {
			await childRegistry.stop(child);
		} catch (caught) {
			cleanupError = caught;
		}
		const transcript = [stdout, stderr]
			.filter(Boolean)
			.join("\n")
			.slice(-8_000);
		const wrapped = new Error(
			`${service} did not become ready: ${errorMessage(error)}${transcript ? `\n${transcript}` : ""}`,
			{ cause: error },
		);
		if (/EADDRINUSE/.test(transcript) || error?.code === "EADDRINUSE") {
			wrapped.code = "EADDRINUSE";
		}
		if (cleanupError !== undefined) wrapped.cleanupError = cleanupError;
		throw wrapped;
	}
}

function createProcessAdapter() {
	const childRegistry = createManagedChildRegistry((child) =>
		stopManaged(child, {
			timeoutMs: 5_000,
			confirmationTimeoutMs: 2_000,
		}),
	);
	return {
		startAimock(fixtures) {
			return createAimock({ fixtures });
		},
		async getPort(excludedPorts) {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				const port = await getAvailableLoopbackPort();
				if (!excludedPorts.has(port)) return port;
			}
			throw new Error("Could not assign a distinct loopback port");
		},
		startDawn({ cwd, port, env }) {
			return startHttpService({
				command: "npm",
				args: ["exec", "--", "dawn", "dev", "--port", String(port)],
				cwd,
				env,
				readyUrl: `http://127.0.0.1:${port}/healthz`,
				service: "Dawn server",
				childRegistry,
			});
		},
		startWorkbench({ cwd, port, env }) {
			return startHttpService({
				command: "npm",
				args: [
					"exec",
					"--",
					"next",
					"dev",
					"--hostname",
					"127.0.0.1",
					"-p",
					String(port),
				],
				cwd,
				env,
				readyUrl: `http://127.0.0.1:${port}`,
				service: "Workbench",
				childRegistry,
			});
		},
		stop(child) {
			return childRegistry.stop(child);
		},
		stopRemaining() {
			return childRegistry.stopRemaining();
		},
	};
}

function createFilesystemAdapter() {
	return {
		mkdtemp: nodeMkdtemp,
		mkdir: nodeMkdir,
		readFile: nodeReadFile,
		rm: nodeRm,
		writeFile: nodeWriteFile,
	};
}

export async function openReadyWorkbench(page, url) {
	const origin = new URL(url).origin;
	const runtimeReady = page.waitForResponse(
		(response) => {
			const responseUrl = new URL(response.url());
			return (
				response.request().method() === "GET" &&
				responseUrl.origin === origin &&
				responseUrl.pathname === "/api/copilotkit/info"
			);
		},
		{ timeout: 60_000 },
	);
	await page.goto(url, { waitUntil: "domcontentloaded" });
	const response = await runtimeReady;
	if (!response.ok()) {
		throw new Error(
			`CopilotKit runtime readiness failed with HTTP ${response.status()}`,
		);
	}
}

export async function fillActiveWorkbenchComposer(page, prompt) {
	requireString(prompt, "prompt");
	await page
		.getByRole("button", { name: "New conversation", exact: true })
		.waitFor({ state: "visible", timeout: 60_000 });
	const messageBox = page.getByRole("textbox", { name: "Message" });
	await messageBox.fill(prompt);
}

export async function closeBrowserResources({ context, video, browser }) {
	const errors = [];
	let videoPath;
	try {
		await context.close();
	} catch (error) {
		errors.push(error);
	}
	if (video !== null) {
		try {
			videoPath = await video.path();
		} catch (error) {
			errors.push(error);
		}
	}
	try {
		await browser.close();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) {
		throw new AggregateError(
			errors,
			`Browser cleanup failed: ${errors.map(errorMessage).join("; ")}`,
		);
	}
	return videoPath === undefined ? {} : { videoPath };
}

function createBrowserAdapter() {
	return {
		async open({ recordingsDir, viewport }) {
			const { chromium } = await import("@playwright/test");
			const browser = await chromium.launch({ headless: true });
			const context = await browser.newContext({
				viewport,
				recordVideo: { dir: recordingsDir, size: viewport },
			});
			const page = await context.newPage();
			const video = page.video();
			let closePromise;
			return {
				async recordStage({ html }) {
					await page.setContent(html, { waitUntil: "load" });
					await page.locator("body").waitFor({ state: "visible" });
					await page.waitForTimeout(1_400);
				},
				async runScenario({ url, prompt, tools, answer }) {
					await openReadyWorkbench(page, url);
					await fillActiveWorkbenchComposer(page, prompt);
					await page.getByRole("button", { name: "Send", exact: true }).click();
					for (const tool of tools) {
						await page.getByText(tool, { exact: true }).last().waitFor({
							state: "visible",
							timeout: 120_000,
						});
					}
					await page.getByText(answer, { exact: true }).last().waitFor({
						state: "visible",
						timeout: 120_000,
					});
					const threadId = await page.evaluate((title) => {
						const raw = localStorage.getItem("dawn.workbench.threads");
						const threads = raw === null ? [] : JSON.parse(raw);
						const thread = threads.find((entry) => entry?.title === title);
						return typeof thread?.id === "string" ? thread.id : undefined;
					}, prompt);
					if (threadId === undefined) {
						throw new Error("Workbench did not persist the active thread id");
					}
					return { threadId };
				},
				async reloadAndRestore({ threadId, prompt, answer }) {
					const statePath = `/api/dawn/threads/${encodeURIComponent(threadId)}/state`;
					const stateResponsePromise = page.waitForResponse(
						(response) => {
							const url = new URL(response.url());
							return (
								response.request().method() === "GET" &&
								url.pathname === statePath
							);
						},
						{ timeout: 120_000 },
					);
					await page.reload({ waitUntil: "domcontentloaded" });
					const row = page.getByRole("button", { name: prompt, exact: true });
					await row.waitFor({ state: "visible", timeout: 60_000 });
					if ((await row.getAttribute("aria-current")) !== "true") {
						throw new Error(
							`Reload did not select the captured thread ${threadId}`,
						);
					}
					const response = await stateResponsePromise;
					if (!response.ok()) {
						throw new Error(
							`Thread restoration failed with HTTP ${response.status()}`,
						);
					}
					await response.finished();
					await page.getByText(answer, { exact: true }).last().waitFor({
						state: "visible",
						timeout: 120_000,
					});
					return { stateUrl: response.url() };
				},
				async recordRun() {
					await page.waitForTimeout(1_800);
				},
				async close() {
					closePromise ??= closeBrowserResources({ context, video, browser });
					return closePromise;
				},
			};
		},
	};
}

function mergeAdapters(defaults, overrides = {}) {
	return {
		commands: { ...defaults.commands, ...overrides.commands },
		filesystem: { ...defaults.filesystem, ...overrides.filesystem },
		processes: { ...defaults.processes, ...overrides.processes },
		browser: { ...defaults.browser, ...overrides.browser },
	};
}

async function cleanupResource(action, errors) {
	try {
		await action();
	} catch (error) {
		errors.push(error);
	}
}

export async function captureDemo({
	repoRoot = DEFAULT_REPO_ROOT,
	parentEnv = process.env,
	adapters: adapterOverrides,
	recordOnly = false,
} = {}) {
	requireString(repoRoot, "repoRoot");
	const artifactsDir = join(repoRoot, "docs/brand/demo/artifacts");
	const recordingsDir = join(repoRoot, "docs/brand/demo/raw-recordings");
	const defaults = {
		commands: createCommandAdapter({ repoRoot, parentEnvironment: parentEnv }),
		filesystem: createFilesystemAdapter(),
		processes: createProcessAdapter(),
		browser: createBrowserAdapter(),
	};
	const adapters = mergeAdapters(defaults, adapterOverrides);
	let workspaceRoot;
	let aimock;
	let serverChild;
	let workbenchChild;
	let browserSession;
	let browserResult = {};
	let result;
	let primaryError;

	try {
		await adapters.commands.checkToolchain({ repoRoot });
		await adapters.commands.build({ repoRoot });
		workspaceRoot = await adapters.filesystem.mkdtemp(
			join(tmpdir(), "dawn-brand-demo-"),
		);
		const appRoot = join(workspaceRoot, "my-agent");
		await adapters.commands.scaffold({ repoRoot, appRoot });
		await adapters.commands.install({ appRoot });
		const testResult = await adapters.commands.test({ appRoot });
		await Promise.all([
			adapters.filesystem.mkdir(artifactsDir, { recursive: true }),
			adapters.filesystem.mkdir(recordingsDir, { recursive: true }),
		]);
		await Promise.all([
			adapters.filesystem.writeFile(
				join(artifactsDir, "test.stdout.log"),
				testResult.stdout,
				"utf8",
			),
			adapters.filesystem.writeFile(
				join(artifactsDir, "test.stderr.log"),
				testResult.stderr,
				"utf8",
			),
			adapters.filesystem.writeFile(
				join(artifactsDir, "test.result.json"),
				`${JSON.stringify({ exitCode: testResult.exitCode }, null, 2)}\n`,
				"utf8",
			),
		]);
		assertCommandSucceeded(testResult, "generated npm test");
		const rawTestLog = [testResult.stdout, testResult.stderr]
			.filter(Boolean)
			.join("\n");
		if (
			!rawTestLog.includes("searches the corpus and writes a cited answer") ||
			!/(?:Tests?\s+.*passed|\d+\s+passed)/i.test(rawTestLog)
		) {
			throw new Error(
				"Generated npm test output did not contain the named research scenario and passing summary",
			);
		}
		const normalizedTestLog = normalizeLog(rawTestLog, {
			temporaryRoot: workspaceRoot,
		});

		aimock = await adapters.processes.startAimock(DEMO_FIXTURES);
		assertLoopbackModelBaseUrl(aimock.baseUrl);
		const serverEnvironment = buildChildEnvironment(parentEnv, aimock.baseUrl);
		const serverStart = await startWithAssignedPort({
			service: "Dawn server",
			excludedPorts: new Set(DEFAULT_SCAFFOLD_PORTS),
			getPort: adapters.processes.getPort,
			start: (port) =>
				adapters.processes.startDawn({
					cwd: join(appRoot, "server"),
					port,
					env: serverEnvironment,
				}),
		});
		serverChild = serverStart.child;

		const workbenchEnvironment = {
			...sanitizeOperationalEnvironment(parentEnv),
			COPILOTKIT_TELEMETRY_DISABLED: "true",
			DO_NOT_TRACK: "1",
			NEXT_TELEMETRY_DISABLED: "1",
			DAWN_SERVER_URL: `http://127.0.0.1:${serverStart.port}`,
		};
		const workbenchStart = await startWithAssignedPort({
			service: "Workbench",
			excludedPorts: new Set([...DEFAULT_SCAFFOLD_PORTS, serverStart.port]),
			getPort: adapters.processes.getPort,
			start: (port) =>
				adapters.processes.startWorkbench({
					cwd: join(appRoot, "web"),
					port,
					env: workbenchEnvironment,
				}),
		});
		workbenchChild = workbenchStart.child;

		const [primarySource, secondarySource] = await Promise.all([
			adapters.filesystem.readFile(
				join(appRoot, "server/src/app/research/index.ts"),
				"utf8",
			),
			adapters.filesystem.readFile(
				join(appRoot, "server/src/tools/searchCorpus.ts"),
				"utf8",
			),
		]);
		const authorHtml = renderStage({
			act: "author",
			tree: GENERATED_PATHS,
			primarySource,
			secondarySource,
		});
		for (const generatedPath of GENERATED_PATHS) {
			if (!authorHtml.includes(generatedPath)) {
				throw new Error(`Author compositor is missing ${generatedPath}`);
			}
		}
		if (
			!authorHtml.includes("export default agent({") ||
			!authorHtml.includes("searchCorpus")
		) {
			throw new Error("Author compositor is missing the canonical Dawn source");
		}
		const testHtml = renderStage({ act: "test", testLog: normalizedTestLog });
		browserSession = await adapters.browser.open({
			recordingsDir,
			viewport: { ...VIEWPORT },
		});
		await browserSession.recordStage({ act: "author", html: authorHtml });
		await browserSession.recordStage({ act: "test", html: testHtml });
		const scenario = await browserSession.runScenario({
			url: `http://127.0.0.1:${workbenchStart.port}`,
			prompt: DEMO_PROMPT,
			tools: EXPECTED_TOOLS,
			answer: EXPECTED_ANSWER,
		});
		const restoration = await browserSession.reloadAndRestore({
			threadId: scenario.threadId,
			prompt: DEMO_PROMPT,
			answer: EXPECTED_ANSWER,
		});
		await browserSession.recordRun();
		await browserSession.recordStage({
			act: "close",
			html: renderStage({ act: "close" }),
		});
		result = {
			status: "captured",
			recordOnly,
			threadId: scenario.threadId,
			serverPort: serverStart.port,
			workbenchPort: workbenchStart.port,
			...(restoration?.stateUrl !== undefined
				? { stateUrl: restoration.stateUrl }
				: {}),
		};
	} catch (error) {
		primaryError = error;
	}

	const cleanupErrors = [];
	if (browserSession !== undefined) {
		await cleanupResource(async () => {
			browserResult = await browserSession.close();
		}, cleanupErrors);
	}
	if (workbenchChild !== undefined) {
		await cleanupResource(
			() => adapters.processes.stop(workbenchChild),
			cleanupErrors,
		);
	}
	if (serverChild !== undefined) {
		await cleanupResource(
			() => adapters.processes.stop(serverChild),
			cleanupErrors,
		);
	}
	if (typeof adapters.processes.stopRemaining === "function") {
		await cleanupResource(
			() => adapters.processes.stopRemaining(),
			cleanupErrors,
		);
	}
	if (aimock !== undefined) {
		await cleanupResource(() => aimock.close(), cleanupErrors);
	}
	if (workspaceRoot !== undefined) {
		await cleanupResource(
			() =>
				adapters.filesystem.rm(workspaceRoot, { recursive: true, force: true }),
			cleanupErrors,
		);
	}

	if (primaryError !== undefined) {
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[primaryError, ...cleanupErrors],
				`${errorMessage(primaryError)}; cleanup also failed`,
			);
		}
		throw primaryError;
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, "Capture cleanup failed");
	}

	const summary = { ...result, ...browserResult };
	const summaryPath = join(artifactsDir, "capture-summary.json");
	await adapters.filesystem.writeFile(
		summaryPath,
		`${JSON.stringify(summary, null, 2)}\n`,
		"utf8",
	);
	return { ...summary, summaryPath };
}

function isMainModule() {
	return (
		process.argv[1] !== undefined &&
		pathToFileURL(resolve(process.argv[1])).href === import.meta.url
	);
}

export function parseCaptureArguments(args) {
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
		throw new TypeError("capture arguments must be an array of strings");
	}
	const forwarded = args.filter((arg) => arg !== "--");
	const unknown = forwarded.filter((arg) => arg !== "--record-only");
	if (unknown.length > 0) {
		throw new Error(`Unknown capture argument(s): ${unknown.join(", ")}`);
	}
	return { recordOnly: forwarded.includes("--record-only") };
}

if (isMainModule()) {
	let cliOptions;
	try {
		cliOptions = parseCaptureArguments(process.argv.slice(2));
	} catch (error) {
		console.error(errorMessage(error));
		process.exitCode = 1;
	}
	if (cliOptions !== undefined) {
		captureDemo(cliOptions).then(
			(summary) => {
				console.log(JSON.stringify(summary, null, 2));
			},
			(error) => {
				console.error(error instanceof Error ? error.stack : error);
				process.exitCode = 1;
			},
		);
	}
}
