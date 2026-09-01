import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { script } from "../../../packages/testing/dist/index.js";
import { normalizeLog } from "./normalize-log.mjs";
import { spawnManaged, stopManaged, waitForHttp } from "./processes.mjs";
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
