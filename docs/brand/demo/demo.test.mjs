import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { script } from "../../../packages/testing/dist/index.js";
import {
	assertLoopbackModelBaseUrl,
	buildChildEnvironment,
	captureDemo,
	closeBrowserResources,
	createManagedChildRegistry,
	fillActiveWorkbenchComposer,
	generatedInstallCommand,
	generatedTestCommand,
	openReadyWorkbench,
	parseCaptureArguments,
	startWithAssignedPort,
} from "./capture.mjs";
import { normalizeLog } from "./normalize-log.mjs";
import {
	getAvailableLoopbackPort,
	spawnManaged,
	stopManaged,
	waitForHttp,
} from "./processes.mjs";
import { DEMO_FIXTURES, DEMO_PROMPT } from "./scenario.mjs";
import { renderStage } from "./stage.mjs";

const GENERATED_TREE = [
	"server/src/app/research/index.ts",
	"server/src/app/research/state.ts",
	"server/src/app/research/plan.md",
	"server/src/tools/searchCorpus.ts",
	"server/test/research.test.ts",
];

test("scenario exports the canonical prompt and deterministic research fixture", () => {
	assert.equal(DEMO_PROMPT, "What are common agent architectures?");
	assert.deepEqual(
		DEMO_FIXTURES,
		script()
			.user("What are common agent architectures?")
			.callsTool("searchCorpus", { query: "agent architectures" })
			.callsTool("readDoc", { path: "corpus/agent-architectures.md" })
			.replies(
				"ReAct and plan-and-execute are common. [corpus/agent-architectures.md]",
			)
			.build(),
	);
});

test("normalizeLog narrowly removes capture instability", () => {
	const temporaryRoot = "/tmp/dawn-demo-[42]";
	const raw = [
		`\u001B[32mPASS\u001B[39m ${temporaryRoot}/server/test/research.test.ts 143ms`,
		"✓ searches the corpus and writes a cited answer 1.27s",
		"command: npm test -- --seed=42",
		"7 passed, score 98.6, port 3002",
		"FAIL preserves this test name and exit code 17",
		"/tmp/dawn-demo-other/server 143widgets v1.27stable",
	].join("\n");

	assert.equal(
		normalizeLog(raw, { temporaryRoot }),
		[
			"PASS <workspace>/server/test/research.test.ts <time>",
			"✓ searches the corpus and writes a cited answer <time>",
			"command: npm test -- --seed=42",
			"7 passed, score 98.6, port 3002",
			"FAIL preserves this test name and exit code 17",
			"/tmp/dawn-demo-other/server 143widgets v1.27stable",
		].join("\n"),
	);
});

test("normalizeLog validates meaningful inputs", () => {
	assert.throws(
		() => normalizeLog(42, { temporaryRoot: "/tmp/demo" }),
		/log must be a string/,
	);
	assert.throws(
		() => normalizeLog("PASS", { temporaryRoot: "" }),
		/temporaryRoot/,
	);
});

test("stage exports a frozen canonical generated-path inventory", async () => {
	const { GENERATED_PATHS } = await import("./stage.mjs");
	assert.deepEqual(GENERATED_PATHS, [
		"server/src/app/research/index.ts",
		"server/src/app/research/state.ts",
		"server/src/app/research/plan.md",
		"server/src/tools/searchCorpus.ts",
		"server/test/research.test.ts",
	]);
	assert.equal(Object.isFrozen(GENERATED_PATHS), true);
});

test("author stage renders exactly the generated tree and escaped source", () => {
	const html = renderStage({
		act: "author",
		tree: GENERATED_TREE,
		primarySource: `const route = "<research>" && value > 1`,
		secondarySource: `return "<tool>" & result`,
		testLog: "unused",
	});

	assert.match(html, /^<!doctype html>/);
	assert.match(html, /Dawn/);
	for (const path of GENERATED_TREE)
		assert.match(html, new RegExp(path.replaceAll("/", "\\/")));
	assert.equal((html.match(/server\//g) ?? []).length, GENERATED_TREE.length);
	assert.match(html, /&lt;research&gt;/);
	assert.match(html, /value &gt; 1/);
	assert.match(html, /&lt;tool&gt;&quot; &amp; result/);
	assert.doesNotMatch(html, /<research>|<tool>/);
});

test("test stage renders escaped normalized npm test output", () => {
	const html = renderStage({
		act: "test",
		tree: GENERATED_TREE,
		primarySource: "unused",
		secondarySource: "unused",
		testLog: "PASS research <suite> & 7 tests",
	});

	assert.match(html, /Dawn/);
	assert.match(html, /npm test/);
	assert.match(
		html,
		/<pre><code>PASS research &lt;suite&gt; &amp; 7 tests<\/code><\/pre>/,
	);
	assert.doesNotMatch(html, /<suite>/);
});

test("close stage renders Dawn category, headline, and scaffold command", () => {
	const html = renderStage({
		act: "close",
		tree: GENERATED_TREE,
		primarySource: "unused",
		secondarySource: "unused",
		testLog: "unused",
	});

	assert.match(html, /TypeScript meta-framework for LangGraph\.js/);
	assert.match(html, /Build LangGraph agents like Next\.js apps/);
	assert.match(html, /npm create dawn-ai-app@latest my-agent/);
});

test("renderStage rejects unsupported acts and incomplete author input", () => {
	assert.throws(
		() =>
			renderStage({
				act: "intro",
				tree: GENERATED_TREE,
				primarySource: "a",
				secondarySource: "b",
			}),
		/act must be one of: author, test, close/,
	);
	assert.throws(
		() =>
			renderStage({
				act: "author",
				tree: [],
				primarySource: "a",
				secondarySource: "b",
			}),
		/tree must contain exactly/,
	);
});

class FakeChild extends EventEmitter {
	constructor(pid = 4321) {
		super();
		this.pid = pid;
		this.exitCode = null;
		this.signalCode = null;
	}

	exit(code = 0) {
		this.exitCode = code;
		this.emit("exit", code, null);
	}
}

class ExitDuringListenerChild extends FakeChild {
	once(event, listener) {
		if (event === "exit" && this.exitCode === null) this.exitCode = 23;
		return super.once(event, listener);
	}
}

function manualTimers() {
	const scheduled = [];
	return {
		scheduled,
		timers: {
			setTimeout(callback, delay) {
				const handle = { callback, delay, cleared: false };
				scheduled.push(handle);
				return handle;
			},
			clearTimeout(handle) {
				handle.cleared = true;
			},
		},
	};
}

test("spawnManaged delegates one command to the injected spawn function", () => {
	const child = new FakeChild();
	const calls = [];
	const result = spawnManaged("npm", ["test"], {
		spawn(command, args, options) {
			calls.push({ command, args, options });
			return child;
		},
		options: { cwd: "/tmp/demo" },
	});

	assert.equal(result, child);
	assert.deepEqual(calls, [
		{
			command: "npm",
			args: ["test"],
			options: { cwd: "/tmp/demo", stdio: "pipe" },
		},
	]);
});

test("waitForHttp resolves when the injected fetch reports readiness", async () => {
	const child = new FakeChild();
	const { timers } = manualTimers();
	const calls = [];
	await waitForHttp("http://127.0.0.1:3002/health", child, {
		fetch: async (url) => {
			calls.push(url);
			return { ok: true };
		},
		timers,
		timeoutMs: 500,
		intervalMs: 10,
	});
	assert.deepEqual(calls, ["http://127.0.0.1:3002/health"]);
});

test("waitForHttp rejects when the managed child exits before readiness", async () => {
	const child = new FakeChild();
	const { timers } = manualTimers();
	const readiness = waitForHttp("http://127.0.0.1:3002/health", child, {
		fetch: async () => {
			throw new Error("not ready");
		},
		timers,
		timeoutMs: 500,
		intervalMs: 10,
	});
	child.exit(1);
	await assert.rejects(readiness, /exited before .* became ready.*code 1/);
});

test("waitForHttp rejects when the managed child already exited by signal", async () => {
	const child = new FakeChild();
	child.signalCode = "SIGTERM";
	let fetchCalls = 0;
	await assert.rejects(
		waitForHttp("http://127.0.0.1:3002/health", child, {
			fetch: async () => {
				fetchCalls += 1;
				return { ok: true };
			},
		}),
		/already exited with signal SIGTERM/,
	);
	assert.equal(fetchCalls, 0);
});

test("waitForHttp catches exit state that changes while its listener is installed", async () => {
	const child = new ExitDuringListenerChild();
	let fetchCalls = 0;
	await assert.rejects(
		waitForHttp("http://127.0.0.1:3002/health", child, {
			fetch: async () => {
				fetchCalls += 1;
				return { ok: true };
			},
		}),
		/already exited with code 23/,
	);
	assert.equal(fetchCalls, 0);
});

test("waitForHttp rejects on the injected readiness timeout", async () => {
	const child = new FakeChild();
	const { scheduled, timers } = manualTimers();
	const readiness = waitForHttp("http://127.0.0.1:3002/health", child, {
		fetch: async () => {
			throw new Error("not ready");
		},
		timers,
		timeoutMs: 500,
		intervalMs: 10,
	});
	const timeout = scheduled.find(({ delay }) => delay === 500);
	assert.ok(timeout);
	timeout.callback();
	await assert.rejects(readiness, /Timed out after 500ms waiting for/);
});

test("stopManaged sends SIGTERM and clears its timeout when the child exits", async () => {
	const child = new FakeChild(4321);
	const { scheduled, timers } = manualTimers();
	const signals = [];
	const stopped = stopManaged(child, {
		kill(pid, signal) {
			signals.push([pid, signal]);
		},
		timers,
		timeoutMs: 250,
	});
	assert.deepEqual(signals, [[4321, "SIGTERM"]]);
	child.exit(0);
	await stopped;
	assert.equal(scheduled[0]?.cleared, true);
	assert.deepEqual(signals, [[4321, "SIGTERM"]]);
});

test("stopManaged does not signal a child that already exited by signal", async () => {
	const child = new FakeChild(4321);
	child.signalCode = "SIGTERM";
	const signals = [];
	await stopManaged(child, {
		kill(pid, signal) {
			signals.push([pid, signal]);
		},
	});
	assert.deepEqual(signals, []);
});

test("stopManaged catches exit state that changes while its listener is installed", async () => {
	const child = new ExitDuringListenerChild(4321);
	const signals = [];
	await stopManaged(child, {
		kill(pid, signal) {
			signals.push([pid, signal]);
		},
	});
	assert.deepEqual(signals, []);
});

test("stopManaged waits for confirmed child close after escalating its known PID", async () => {
	const child = new FakeChild(9876);
	const { scheduled, timers } = manualTimers();
	const signals = [];
	let settled = false;
	const stopped = stopManaged(child, {
		kill(pid, signal) {
			signals.push([pid, signal]);
		},
		timers,
		timeoutMs: 250,
		confirmationTimeoutMs: 100,
	});
	void stopped.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	assert.equal(scheduled[0]?.delay, 250);
	scheduled[0].callback();
	await Promise.resolve();
	assert.deepEqual(signals, [
		[9876, "SIGTERM"],
		[9876, "SIGKILL"],
	]);
	assert.equal(settled, false);
	assert.equal(scheduled[1]?.delay, 100);
	child.emit("close", null, "SIGKILL");
	await stopped;
	assert.equal(settled, true);
});

test("stopManaged rejects when SIGKILL termination is not confirmed in time", async () => {
	const child = new FakeChild(9876);
	const { scheduled, timers } = manualTimers();
	const stopped = stopManaged(child, {
		kill() {},
		timers,
		timeoutMs: 250,
		confirmationTimeoutMs: 100,
	});
	scheduled[0].callback();
	assert.equal(scheduled[1]?.delay, 100);
	scheduled[1].callback();
	await assert.rejects(
		stopped,
		/Managed child PID 9876 did not exit within 100ms after SIGKILL/,
	);
});

const EXPECTED_ANSWER =
	"ReAct and plan-and-execute are common. [corpus/agent-architectures.md]";

function orchestrationFixture({ failAt } = {}) {
	const operations = [];
	const writes = [];
	const stopped = [];
	const childEnvironments = [];
	const workspaceRoot = "/tmp/dawn-demo-unit-abc123";
	const appRoot = `${workspaceRoot}/my-agent`;
	const server = { name: "server" };
	const workbench = { name: "workbench" };
	const aimock = {
		baseUrl: "http://127.0.0.1:4040/v1",
		async close() {
			operations.push("close aimock");
		},
	};
	let assignedPort = 4100;

	const adapters = {
		commands: {
			async checkToolchain() {
				operations.push("check toolchain");
			},
			async build() {
				operations.push("build");
			},
			async scaffold(options) {
				operations.push("scaffold --mode internal");
				assert.equal(options.appRoot, appRoot);
			},
			async install(options) {
				operations.push("install");
				assert.equal(options.appRoot, appRoot);
			},
			async test(options) {
				operations.push("npm test");
				assert.equal(options.appRoot, appRoot);
				return {
					stdout: [
						`\u001B[32mPASS\u001B[39m ${appRoot}/server/test/research.test.ts 143ms`,
						"\u2713 searches the corpus and writes a cited answer 1.27s",
						"Tests 7 passed",
					].join("\n"),
					stderr: "",
					exitCode: 0,
				};
			},
		},
		filesystem: {
			async mkdtemp() {
				return workspaceRoot;
			},
			async mkdir() {},
			async writeFile(path, contents) {
				writes.push({ path, contents });
			},
			async readFile(path) {
				if (path.endsWith("server/src/app/research/index.ts")) {
					return "export default agent({ tools: [searchCorpus] })";
				}
				if (path.endsWith("server/src/tools/searchCorpus.ts")) {
					return "export default searchCorpus";
				}
				throw new Error(`unexpected read: ${path}`);
			},
			async rm(path) {
				operations.push(`remove ${path}`);
			},
		},
		processes: {
			async startAimock(fixtures) {
				operations.push("start aimock");
				assert.deepEqual(fixtures, DEMO_FIXTURES);
				return aimock;
			},
			async getPort(excluded) {
				const port = assignedPort++;
				assert.equal(excluded.has(port), false);
				operations.push(`assign port ${port}`);
				return port;
			},
			async startDawn(options) {
				operations.push("start Dawn server");
				assert.equal(options.cwd, `${appRoot}/server`);
				childEnvironments.push({ service: "server", env: options.env });
				return server;
			},
			async startWorkbench(options) {
				operations.push("start Workbench");
				assert.equal(options.cwd, `${appRoot}/web`);
				childEnvironments.push({ service: "workbench", env: options.env });
				return workbench;
			},
			async stop(child) {
				stopped.push(child);
				operations.push(`stop ${child.name}`);
			},
		},
		browser: {
			async open(options) {
				assert.deepEqual(options.viewport, { width: 1440, height: 810 });
				assert.match(
					options.recordingsDir,
					/docs\/brand\/demo\/raw-recordings$/,
				);
				return {
					async recordStage({ act, html }) {
						operations.push(`record ${act}`);
						if (act === "author") {
							for (const path of GENERATED_TREE)
								assert.match(html, new RegExp(path));
							assert.match(html, /export default agent\(\{/);
							assert.match(html, /searchCorpus/);
						}
						if (act === "test") {
							assert.match(
								html,
								/searches the corpus and writes a cited answer/,
							);
							assert.match(html, /Tests 7 passed/);
							assert.match(html, /&lt;workspace&gt;/);
							assert.doesNotMatch(html, /dawn-demo-unit-abc123/);
							assert.equal(html.includes("\u001B"), false);
						}
					},
					async runScenario(options) {
						operations.push("run Workbench scenario");
						assert.equal(options.prompt, DEMO_PROMPT);
						assert.deepEqual(options.tools, ["searchCorpus", "readDoc"]);
						assert.equal(options.answer, EXPECTED_ANSWER);
						if (failAt === "scenario") throw new Error("scenario failed");
						return { threadId: "thread-unit-1" };
					},
					async reloadAndRestore(options) {
						operations.push("reload");
						assert.equal(options.threadId, "thread-unit-1");
						assert.equal(options.answer, EXPECTED_ANSWER);
					},
					async recordRun() {
						operations.push("record run");
					},
					async close() {
						operations.push("close browser");
						return { videoPath: "/ignored/raw-recordings/demo.webm" };
					},
				};
			},
		},
	};

	return {
		adapters,
		aimock,
		appRoot,
		childEnvironments,
		operations,
		stopped,
		workspaceRoot,
		writes,
	};
}

test("capture orchestrates the real-product phases in exact order and cleans up", async () => {
	const fixture = orchestrationFixture();
	const result = await captureDemo({
		repoRoot: "/repo",
		parentEnv: { PATH: "/bin", HOME: "/home/test", LANG: "en_US.UTF-8" },
		adapters: fixture.adapters,
		recordOnly: true,
	});

	assert.deepEqual(fixture.operations, [
		"check toolchain",
		"build",
		"scaffold --mode internal",
		"install",
		"npm test",
		"start aimock",
		"assign port 4100",
		"start Dawn server",
		"assign port 4101",
		"start Workbench",
		"record author",
		"record test",
		"run Workbench scenario",
		"reload",
		"record run",
		"record close",
		"close browser",
		"stop workbench",
		"stop server",
		"close aimock",
		`remove ${fixture.workspaceRoot}`,
	]);
	assert.deepEqual(fixture.stopped, [
		{ name: "workbench" },
		{ name: "server" },
	]);
	assert.equal(result.threadId, "thread-unit-1");
	assert.equal(result.serverPort, 4100);
	assert.equal(result.workbenchPort, 4101);
});

test("capture stores raw test output only in ignored artifacts and stages normalized output", async () => {
	const fixture = orchestrationFixture();
	await captureDemo({
		repoRoot: "/repo",
		adapters: fixture.adapters,
		recordOnly: true,
	});

	const rawWrites = fixture.writes.filter(({ path }) =>
		/test\.(stdout|stderr|result)/.test(path),
	);
	assert.equal(rawWrites.length, 3);
	for (const write of rawWrites) {
		assert.match(write.path, /^\/repo\/docs\/brand\/demo\/artifacts\//);
	}
	assert.equal(
		fixture.writes.some(
			({ path }) => path.includes("raw-recordings") && path.endsWith(".log"),
		),
		false,
	);
});

test("capture finally closes owned resources and removes only its exact mkdtemp workspace", async () => {
	const fixture = orchestrationFixture({ failAt: "scenario" });
	await assert.rejects(
		captureDemo({
			repoRoot: "/repo",
			adapters: fixture.adapters,
			recordOnly: true,
		}),
		/scenario failed/,
	);
	assert.deepEqual(fixture.stopped, [
		{ name: "workbench" },
		{ name: "server" },
	]);
	assert.deepEqual(fixture.operations.slice(-5), [
		"close browser",
		"stop workbench",
		"stop server",
		"close aimock",
		`remove ${fixture.workspaceRoot}`,
	]);
	assert.equal(
		fixture.operations.some(
			(operation) =>
				operation.includes("/tmp") &&
				operation !== `remove ${fixture.workspaceRoot}`,
		),
		false,
	);
});

test("child environment preserves operations but strips provider credentials before exact overrides", () => {
	const environment = buildChildEnvironment(
		{
			PATH: "/toolchain/bin",
			HOME: "/home/test",
			LANG: "en_US.UTF-8",
			LC_ALL: "C.UTF-8",
			TMPDIR: "/tmp/unit",
			npm_config_cache: "/cache/npm",
			PNPM_HOME: "/cache/pnpm",
			OPENAI_API_KEY: "openai-parent",
			OPENAI_BASE_URL: "https://api.openai.com/v1",
			ANTHROPIC_API_KEY: "anthropic-parent",
			ANTHROPIC_BASE_URL: "https://api.anthropic.com",
			GOOGLE_API_KEY: "google-parent",
			GOOGLE_GENERATIVE_AI_BASE_URL: "https://google.example",
			AZURE_OPENAI_API_KEY: "azure-parent",
			AZURE_OPENAI_ENDPOINT: "https://azure.example",
			AWS_ACCESS_KEY_ID: "aws-parent",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			AWS_SESSION_TOKEN: "aws-token",
			AWS_BEDROCK_ENDPOINT: "https://bedrock.example",
			LANGCHAIN_TRACING_V2: "true",
			LANGSMITH_TRACING: "true",
		},
		"http://127.0.0.1:4040/v1",
	);

	for (const key of [
		"PATH",
		"HOME",
		"LANG",
		"LC_ALL",
		"TMPDIR",
		"npm_config_cache",
		"PNPM_HOME",
	]) {
		assert.ok(key in environment, `${key} must be preserved`);
	}
	assert.deepEqual(
		Object.fromEntries(
			[
				"OPENAI_BASE_URL",
				"OPENAI_API_KEY",
				"COPILOTKIT_TELEMETRY_DISABLED",
				"DO_NOT_TRACK",
			].map((key) => [key, environment[key]]),
		),
		{
			OPENAI_BASE_URL: "http://127.0.0.1:4040/v1",
			OPENAI_API_KEY: "test-not-used",
			COPILOTKIT_TELEMETRY_DISABLED: "true",
			DO_NOT_TRACK: "1",
		},
	);
	assert.equal(environment.npm_config_package, "@dawn-ai/cli");
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_BASE_URL",
		"GOOGLE_API_KEY",
		"GOOGLE_GENERATIVE_AI_BASE_URL",
		"AZURE_OPENAI_API_KEY",
		"AZURE_OPENAI_ENDPOINT",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_BEDROCK_ENDPOINT",
		"LANGCHAIN_TRACING_V2",
		"LANGSMITH_TRACING",
	]) {
		assert.equal(environment[key], undefined, `${key} must be stripped`);
	}
});

test("capture gives both services sanitized environments and only Dawn receives model overrides", async () => {
	const fixture = orchestrationFixture();
	await captureDemo({
		repoRoot: "/repo",
		parentEnv: {
			PATH: "/toolchain/bin",
			npm_config_userconfig: "/home/test/.npmrc",
			OPENAI_API_KEY: "parent-openai",
			ANTHROPIC_API_KEY: "parent-anthropic",
			GOOGLE_API_KEY: "parent-google",
			AZURE_OPENAI_API_KEY: "parent-azure",
			AWS_SECRET_ACCESS_KEY: "parent-aws",
		},
		adapters: fixture.adapters,
		recordOnly: true,
	});

	const serverEnvironment = fixture.childEnvironments.find(
		({ service }) => service === "server",
	)?.env;
	const workbenchEnvironment = fixture.childEnvironments.find(
		({ service }) => service === "workbench",
	)?.env;
	assert.deepEqual(
		Object.fromEntries(
			[
				"OPENAI_BASE_URL",
				"OPENAI_API_KEY",
				"COPILOTKIT_TELEMETRY_DISABLED",
				"DO_NOT_TRACK",
			].map((key) => [key, serverEnvironment?.[key]]),
		),
		{
			OPENAI_BASE_URL: "http://127.0.0.1:4040/v1",
			OPENAI_API_KEY: "test-not-used",
			COPILOTKIT_TELEMETRY_DISABLED: "true",
			DO_NOT_TRACK: "1",
		},
	);
	assert.equal(workbenchEnvironment?.DAWN_SERVER_URL, "http://127.0.0.1:4100");
	assert.equal(workbenchEnvironment?.NEXT_TELEMETRY_DISABLED, "1");
	assert.equal(serverEnvironment?.npm_config_package, "@dawn-ai/cli");
	assert.equal(workbenchEnvironment?.OPENAI_API_KEY, undefined);
	for (const environment of [serverEnvironment, workbenchEnvironment]) {
		assert.equal(environment?.PATH, "/toolchain/bin");
		assert.equal(environment?.npm_config_userconfig, "/home/test/.npmrc");
		for (const key of [
			"ANTHROPIC_API_KEY",
			"GOOGLE_API_KEY",
			"AZURE_OPENAI_API_KEY",
			"AWS_SECRET_ACCESS_KEY",
		]) {
			assert.equal(environment?.[key], undefined);
		}
	}
});

test("model base URL accepts loopback HTTP(S) and rejects public or unsafe URLs", () => {
	assert.equal(
		assertLoopbackModelBaseUrl("http://127.0.0.1:4040/v1").href,
		"http://127.0.0.1:4040/v1",
	);
	assert.equal(
		assertLoopbackModelBaseUrl("https://[::1]:4040/v1").hostname,
		"[::1]",
	);
	for (const unsafe of [
		"https://api.openai.com/v1",
		"http://192.168.1.20:4040/v1",
		"file:///tmp/mock",
		"not a URL",
	]) {
		assert.throws(
			() => assertLoopbackModelBaseUrl(unsafe),
			/loopback HTTP\(S\)/,
		);
	}
});

test("available-port helper asks node:net for an ephemeral loopback port", async () => {
	const calls = [];
	const fakeServer = new EventEmitter();
	fakeServer.unref = () => calls.push("unref");
	fakeServer.address = () => ({
		address: "127.0.0.1",
		family: "IPv4",
		port: 45678,
	});
	fakeServer.listen = (options, callback) => {
		calls.push(["listen", options]);
		callback();
	};
	fakeServer.close = (callback) => {
		calls.push("close");
		callback();
	};

	assert.equal(
		await getAvailableLoopbackPort({ createServer: () => fakeServer }),
		45678,
	);
	assert.deepEqual(calls, [
		["listen", { host: "127.0.0.1", port: 0, exclusive: true }],
		"unref",
		"close",
	]);
});

test("assigned-port startup retries only EADDRINUSE with fresh distinct ports", async () => {
	const assigned = [4100, 4101, 4102];
	const starts = [];
	const result = await startWithAssignedPort({
		service: "Dawn server",
		excludedPorts: new Set([3002, 3010]),
		getPort: async () => assigned.shift(),
		start: async (port) => {
			starts.push(port);
			if (starts.length < 3)
				throw Object.assign(new Error("address busy"), { code: "EADDRINUSE" });
			return { child: { name: "server" }, port };
		},
	});
	assert.deepEqual(starts, [4100, 4101, 4102]);
	assert.equal(result.port, 4102);
});

test("assigned-port startup never retries other errors or more than three bind races", async () => {
	let calls = 0;
	await assert.rejects(
		startWithAssignedPort({
			service: "Workbench",
			excludedPorts: new Set([3002, 3010]),
			getPort: async () => 4200 + calls,
			start: async () => {
				calls += 1;
				throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
			},
		}),
		/boom/,
	);
	assert.equal(calls, 1);

	calls = 0;
	await assert.rejects(
		startWithAssignedPort({
			service: "Workbench",
			excludedPorts: new Set([3002, 3010]),
			getPort: async () => 4300 + calls,
			start: async () => {
				calls += 1;
				throw Object.assign(new Error("address busy"), { code: "EADDRINUSE" });
			},
		}),
		/after 3 EADDRINUSE attempts/,
	);
	assert.equal(calls, 3);
});

test("capture CLI accepts pnpm's forwarded separator before --record-only", () => {
	assert.deepEqual(parseCaptureArguments(["--", "--record-only"]), {
		recordOnly: true,
	});
	assert.throws(
		() => parseCaptureArguments(["--", "--unexpected"]),
		/Unknown capture argument/,
	);
});

test("generated npm test command enables the real runner's verbose named-test output", () => {
	assert.deepEqual(generatedTestCommand(), {
		command: "npm",
		args: ["test", "--", "--", "--reporter=verbose"],
	});
});

test("internal scaffold installation uses its pnpm workspace so Workbench resolves local packages", () => {
	assert.deepEqual(generatedInstallCommand(), {
		command: "pnpm",
		args: ["install"],
	});
});

test("Workbench capture waits for the active rail row before filling the keyed composer", async () => {
	const calls = [];
	const page = {
		getByRole(role, options) {
			if (role === "button" && options.name === "New conversation") {
				return {
					async waitFor(waitOptions) {
						calls.push(["active row", waitOptions]);
					},
				};
			}
			if (role === "textbox" && options.name === "Message") {
				return {
					async fill(value) {
						calls.push(["fill", value]);
					},
				};
			}
			throw new Error(`unexpected locator: ${role} ${options.name}`);
		},
	};

	await fillActiveWorkbenchComposer(page, DEMO_PROMPT);
	assert.deepEqual(calls, [
		["active row", { state: "visible", timeout: 60_000 }],
		["fill", DEMO_PROMPT],
	]);
});

test("Workbench capture arms and verifies CopilotKit runtime readiness before interaction", async () => {
	const calls = [];
	let responsePredicate;
	const response = {
		ok: () => true,
		request: () => ({ method: () => "GET" }),
		url: () => "http://127.0.0.1:4101/api/copilotkit/info",
	};
	const page = {
		waitForResponse(predicate, options) {
			responsePredicate = predicate;
			calls.push(["arm response", options]);
			return Promise.resolve(response);
		},
		async goto(url, options) {
			calls.push(["goto", url, options]);
		},
	};

	await openReadyWorkbench(page, "http://127.0.0.1:4101");
	assert.equal(responsePredicate(response), true);
	assert.deepEqual(calls, [
		["arm response", { timeout: 60_000 }],
		["goto", "http://127.0.0.1:4101", { waitUntil: "domcontentloaded" }],
	]);
});

test("managed-child registry retains a child whose stop fails and retries it during final cleanup", async () => {
	const child = { name: "failed-start" };
	const unrelated = { name: "unrelated" };
	const calls = [];
	let attempt = 0;
	const registry = createManagedChildRegistry(async (candidate) => {
		calls.push(candidate);
		attempt += 1;
		if (attempt === 1) throw new Error("first stop failed");
	});
	registry.track(child);
	await assert.rejects(registry.stop(child), /first stop failed/);
	await registry.stopRemaining();
	assert.deepEqual(calls, [child, child]);
	assert.equal(calls.includes(unrelated), false);
});

test("browser cleanup always closes Chromium even when context finalization fails", async () => {
	const calls = [];
	await assert.rejects(
		closeBrowserResources({
			context: {
				async close() {
					calls.push("context");
					throw new Error("context failed");
				},
			},
			video: {
				async path() {
					calls.push("video");
					return "/ignored/demo.webm";
				},
			},
			browser: {
				async close() {
					calls.push("browser");
				},
			},
		}),
		/context failed/,
	);
	assert.deepEqual(calls, ["context", "video", "browser"]);
});
