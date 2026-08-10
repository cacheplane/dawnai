import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
	canonicalJsonBytes,
	createEvidenceBudget,
	createGhApiTransport,
	createGitHubReader,
	parseGhIncludedResponse,
	parseNextLink,
	runBoundedProcess,
	safeEvidenceError,
} from "../../scripts/security/github-evidence.mjs";

const repo = "cacheplane/dawnai";
const alertsUrl =
	"https://api.github.com/repos/cacheplane/dawnai/dependabot/alerts?state=open&per_page=100";

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			Reflect.get(error, "code") === "ESRCH"
		) {
			return false;
		}
		throw error;
	}
}

async function waitForPid(path: string): Promise<number> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			const value = Number((await readFile(path, "utf8")).trim());
			if (Number.isSafeInteger(value) && value > 0) return value;
		} catch (error) {
			if (
				error === null ||
				typeof error !== "object" ||
				Reflect.get(error, "code") !== "ENOENT"
			) {
				throw error;
			}
		}
		await delay(20);
	}
	throw new Error("process-tree fixture did not report its descendant");
}

async function stopProcess(pid: number): Promise<void> {
	if (processIsRunning(pid)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if (
				error === null ||
				typeof error !== "object" ||
				Reflect.get(error, "code") !== "ESRCH"
			) {
				throw error;
			}
		}
	}
	const deadline = Date.now() + 2_000;
	while (processIsRunning(pid) && Date.now() < deadline) await delay(20);
}

describe("canonical evidence", () => {
	it("sorts object keys and emits one trailing newline", () => {
		expect(
			canonicalJsonBytes({ z: 1, a: [{ y: true, x: null }] }).toString(),
		).toBe(
			'{\n  "a": [\n    {\n      "x": null,\n      "y": true\n    }\n  ],\n  "z": 1\n}\n',
		);
	});

	it("rejects accessors without invoking them", () => {
		let invoked = false;
		const hostile = Object.defineProperty({}, "value", {
			enumerable: true,
			get() {
				invoked = true;
				throw new Error("github_pat_leak");
			},
		});

		expect(() => canonicalJsonBytes(hostile)).toThrow(
			/UNPROVABLE: INVALID_JSON_VALUE/u,
		);
		expect(invoked).toBe(false);
	});

	it.each<{ value: unknown }>([
		{ value: undefined },
		{ value: Number.NaN },
		{ value: Number.POSITIVE_INFINITY },
		{ value: 1n },
		{ value: { constructor: "pollution" } },
		{ value: { token: "github_pat_secret" } },
	])("rejects non-JSON or secret-shaped input %#", ({ value }) => {
		expect(() => canonicalJsonBytes(value)).toThrow(/UNPROVABLE/u);
	});

	it("redacts token-like values from unexpected errors", () => {
		const safe = safeEvidenceError(
			new Error(
				"Authorization: Bearer github_pat_abcdefghijklmnopqrstuvwxyz token=npm_abcdefghijklmnopqrstuvwxyz",
			),
		);
		expect(safe).toBe("UNPROVABLE: EVIDENCE_OPERATION_FAILED");
		expect(safe).not.toMatch(/github_pat|npm_|Bearer/iu);
	});
});

describe("gh --include parsing", () => {
	it("parses a bounded JSON response and retains only Link", () => {
		const raw = [
			"HTTP/2.0 200 OK",
			"Content-Type: application/json; charset=utf-8",
			`Link: <${alertsUrl}&after=opaque>; rel="next"`,
			"Authorization: Bearer github_pat_never-retained",
			"",
			'[{"number":1}]',
		].join("\r\n");
		const response = parseGhIncludedResponse(raw, "json");
		expect(response).toEqual({
			body: [{ number: 1 }],
			bodyBytes: Buffer.byteLength(raw),
			link: `<${alertsUrl}&after=opaque>; rel="next"`,
			status: 200,
		});
	});

	it("parses text logs without retaining headers or raw errors", () => {
		const raw =
			"HTTP/1.1 200 OK\nContent-Type: text/plain\n\nchart 0.1.0 already published, skipping\n";
		const response = parseGhIncludedResponse(raw, "text");
		expect(response).toEqual({
			body: "chart 0.1.0 already published, skipping\n",
			bodyBytes: Buffer.byteLength(raw),
			link: null,
			status: 200,
		});
	});

	it.each([
		"not-http\n\n{}",
		"HTTP/1.1 500 Internal Server Error\n\n{}",
		"HTTP/1.1 200 OK\nLink: <a>; rel=next\nLink: <b>; rel=next\n\n[]",
		"HTTP/1.1 200 OK\n\n{",
	])("rejects malformed or ambiguous response %#", (raw) => {
		expect(() => parseGhIncludedResponse(raw, "json")).toThrow(/UNPROVABLE/u);
	});
});

describe("shared evidence budget clock", () => {
	it.each([
		["NaN", () => Number.NaN],
		["unsafe deadline", () => Number.MAX_SAFE_INTEGER],
		[
			"throwing clock",
			() => {
				throw new Error("clock secret");
			},
		],
	])("rejects an invalid initial %s clock", (_name, now) => {
		expect(() => createEvidenceBudget({ now, timeoutMs: 100 })).toThrow(
			/UNPROVABLE: INVALID_CLOCK/u,
		);
	});

	it.each([
		["backwards", () => [100, 99]],
		["throwing", () => [100, new Error("clock secret")]],
	])(
		"rejects a %s reserve sample before transport",
		async (_name, createSamples) => {
			const samples = createSamples();
			let calls = 0;
			const reader = createGitHubReader({
				budget: createEvidenceBudget({
					now: () => {
						const sample = samples.shift();
						if (sample instanceof Error) throw sample;
						return sample;
					},
					timeoutMs: 100,
				}),
				repo,
				transport: async () => {
					calls += 1;
					return {
						body: { sha: "a".repeat(40) },
						bodyBytes: 64,
						link: null,
						status: 200,
					};
				},
			});

			await expect(reader.object("commits/main")).rejects.toThrow(
				/UNPROVABLE: INVALID_CLOCK/u,
			);
			expect(calls).toBe(0);
		},
	);

	it("samples once per request reservation and derives the exact remaining timeout", async () => {
		let clock = 0;
		const timeouts: number[] = [];
		const reader = createGitHubReader({
			budget: createEvidenceBudget({ now: () => clock++, timeoutMs: 10 }),
			repo,
			transport: async ({ timeoutMs }: { timeoutMs: number }) => {
				timeouts.push(timeoutMs);
				return {
					body: { sha: "a".repeat(40) },
					bodyBytes: 64,
					link: null,
					status: 200,
				};
			},
		});

		await expect(reader.object("commits/main")).resolves.toEqual({
			sha: "a".repeat(40),
		});
		expect(timeouts).toEqual([9]);
		expect(clock).toBe(4);
	});
});

describe("GitHub evidence pagination", () => {
	it("accepts one same-repository opaque after cursor", () => {
		expect(
			parseNextLink(`<${alertsUrl}&after=opaque>; rel="next"`, {
				cursorOnly: true,
				initialUrl: alertsUrl,
				seen: new Set([alertsUrl]),
			}),
		).toBe(`${alertsUrl}&after=opaque`);
	});

	it("accepts GitHub's exact numeric-repository workflow-runs next link", () => {
		const initial =
			"https://api.github.com/repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100";
		expect(
			parseNextLink(
				'<https://api.github.com/repositories/1210070282/actions/workflows/260503756/runs?per_page=100&page=2>; rel="next"',
				{ cursorOnly: false, initialUrl: initial, seen: new Set([initial]) },
			),
		).toBe(
			"https://api.github.com/repositories/1210070282/actions/workflows/260503756/runs?per_page=100&page=2",
		);
	});

	it("rejects a numeric-repository next link with the wrong repository ID", () => {
		const initial =
			"https://api.github.com/repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100";
		expect(() =>
			parseNextLink(
				'<https://api.github.com/repositories/999/actions/workflows/260503756/runs?per_page=100&page=2>; rel="next"',
				{ cursorOnly: false, initialUrl: initial, seen: new Set([initial]) },
			),
		).toThrow(/UNPROVABLE: UNSAFE_PAGINATION_URL/u);
	});

	it.each([
		`<${alertsUrl}&page=2>; rel="next"`,
		`<${alertsUrl}&before=a&after=b>; rel="next"`,
		`<${alertsUrl}&after=a&after=b>; rel="next"`,
		`<${alertsUrl}&after=a&extra=1>; rel="next"`,
		`<https://evil.example/repos/cacheplane/dawnai/dependabot/alerts?state=open&per_page=100&after=a>; rel="next"`,
		`<https://user:secret@api.github.com/repos/cacheplane/dawnai/dependabot/alerts?state=open&per_page=100&after=a>; rel="next"`,
		`<https://api.github.com/repos/cacheplane/other/dependabot/alerts?state=open&per_page=100&after=a>; rel="next"`,
		`<${alertsUrl}&after=a>; rel="next", <${alertsUrl}&after=b>; rel="next"`,
		`<${alertsUrl}&after=a>; rel="next prev"`,
		`<${alertsUrl}&after=a>; rel="next"; rel="next"`,
		`garbage`,
	])("rejects cursor and Link attack %#", (link) => {
		expect(() =>
			parseNextLink(link, {
				cursorOnly: true,
				initialUrl: alertsUrl,
				seen: new Set([alertsUrl]),
			}),
		).toThrow(/UNPROVABLE/u);
	});

	it("rejects a pagination cycle", () => {
		const next = `${alertsUrl}&after=opaque`;
		expect(() =>
			parseNextLink(`<${next}>; rel="next"`, {
				cursorOnly: true,
				initialUrl: alertsUrl,
				seen: new Set([alertsUrl, next]),
			}),
		).toThrow(/UNPROVABLE: PAGINATION_CYCLE/u);
	});

	it.each([
		[
			"before cursor",
			`<${alertsUrl}&before=opaque>; rel="next"`,
			alertsUrl,
			new Set([alertsUrl]),
		],
		[
			"pagination on initial cursor URL",
			`<${alertsUrl}&after=second>; rel="next"`,
			`${alertsUrl}&after=first`,
			new Set([`${alertsUrl}&after=first`]),
		],
		[
			"uppercase relation",
			`<${alertsUrl}&after=opaque>; rel="NEXT"`,
			alertsUrl,
			new Set([alertsUrl]),
		],
		[
			"backwards page",
			`<https://api.github.com/repos/cacheplane/dawnai/actions/artifacts?per_page=100&page=2>; rel="next"`,
			"https://api.github.com/repos/cacheplane/dawnai/actions/artifacts?per_page=100",
			new Set([
				"https://api.github.com/repos/cacheplane/dawnai/actions/artifacts?per_page=100",
				"https://api.github.com/repos/cacheplane/dawnai/actions/artifacts?per_page=100&page=2",
				"https://api.github.com/repos/cacheplane/dawnai/actions/artifacts?per_page=100&page=3",
			]),
		],
	])("rejects %s", (_name, link, initialUrl, seen) => {
		expect(() =>
			parseNextLink(link, {
				cursorOnly: initialUrl.includes("dependabot"),
				initialUrl,
				seen,
			}),
		).toThrow(/UNPROVABLE/u);
	});

	it("rejects a reordered percent-encoded semantic cursor cycle", () => {
		const encoded = `${alertsUrl}&after=%6fpaque`;
		expect(() =>
			parseNextLink(`<${encoded}>; rel="next"`, {
				cursorOnly: true,
				initialUrl: alertsUrl,
				seen: new Set([alertsUrl, `${alertsUrl}&after=opaque`]),
			}),
		).toThrow(/UNPROVABLE: PAGINATION_CYCLE/u);
	});

	it("follows a partial page and terminates only when next is absent", async () => {
		const calls: string[] = [];
		const reader = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 10,
				maxRequests: 10,
			}),
			repo,
			transport: async ({ url }: { url: string }) => {
				calls.push(url);
				return url === alertsUrl
					? {
							body: [{ number: 2 }],
							bodyBytes: 14,
							link: `<${alertsUrl}&after=second>; rel="next"`,
							status: 200,
						}
					: { body: [{ number: 1 }], bodyBytes: 14, link: null, status: 200 };
			},
		});

		await expect(
			reader.list("dependabot/alerts?state=open&per_page=100", {
				cursorOnly: true,
				uniqueKey: "number",
			}),
		).resolves.toEqual([{ number: 1 }, { number: 2 }]);
		expect(calls).toEqual([alertsUrl, `${alertsUrl}&after=second`]);
	});

	it("enforces ten pages per list independently from the aggregate budget", async () => {
		let calls = 0;
		const reader = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 20,
				maxRecords: 20,
				maxRequests: 20,
			}),
			repo,
			transport: async ({ url }: { url: string }) => {
				calls += 1;
				const current = new URL(url);
				const page = Number(current.searchParams.get("after") ?? "0");
				const next = page + 1;
				return {
					body: [{ number: next }],
					bodyBytes: 16,
					link: `<${alertsUrl}&after=${next}>; rel="next"`,
					status: 200,
				};
			},
		});
		await expect(
			reader.list("dependabot/alerts?state=open&per_page=100", {
				cursorOnly: true,
				pageLimit: 10,
				uniqueKey: "number",
			}),
		).rejects.toThrow(/UNPROVABLE: PAGE_LIMIT/u);
		expect(calls).toBe(10);
	});

	it("allows separate bounded lists while retaining one aggregate page budget", async () => {
		const makeReader = (maxPages: number) => {
			let calls = 0;
			const reader = createGitHubReader({
				budget: createEvidenceBudget({
					maxPages,
					maxRecords: 10,
					maxRequests: 10,
				}),
				repo,
				transport: async ({ url }: { url: string }) => {
					calls += 1;
					const current = new URL(url);
					const state = current.searchParams.get("state");
					const hasCursor = current.searchParams.has("after");
					return {
						body: [{ number: calls }],
						bodyBytes: 16,
						link: hasCursor ? null : `<${url}&after=${state}>; rel="next"`,
						status: 200,
					};
				},
			});
			return { calls: () => calls, reader };
		};

		const within = makeReader(4);
		await within.reader.list("dependabot/alerts?state=open&per_page=100", {
			cursorOnly: true,
			pageLimit: 2,
			uniqueKey: "number",
		});
		await within.reader.list("dependabot/alerts?state=fixed&per_page=100", {
			cursorOnly: true,
			pageLimit: 2,
			uniqueKey: "number",
		});
		expect(within.calls()).toBe(4);

		const exhausted = makeReader(3);
		await exhausted.reader.list("dependabot/alerts?state=open&per_page=100", {
			cursorOnly: true,
			pageLimit: 2,
			uniqueKey: "number",
		});
		await expect(
			exhausted.reader.list("dependabot/alerts?state=fixed&per_page=100", {
				cursorOnly: true,
				pageLimit: 2,
				uniqueKey: "number",
			}),
		).rejects.toThrow(/UNPROVABLE: PAGE_LIMIT/u);
		expect(exhausted.calls()).toBe(3);
	});

	it.each(["page=1", "after=opaque", "before=opaque"])(
		"rejects caller-supplied initial pagination before transport: %s",
		async (pagination) => {
			let invoked = false;
			const reader = createGitHubReader({
				budget: createEvidenceBudget(),
				repo,
				transport: async () => {
					invoked = true;
					return { body: [], bodyBytes: 2, link: null, status: 200 };
				},
			});
			await expect(
				reader.list(`dependabot/alerts?state=open&per_page=100&${pagination}`, {
					cursorOnly: true,
					uniqueKey: "number",
				}),
			).rejects.toThrow(/UNPROVABLE: UNSAFE_PAGINATION_URL/u);
			expect(invoked).toBe(false);
		},
	);

	it("rejects duplicate record identity and page/record budgets", async () => {
		const duplicateReader = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 2,
				maxRecords: 2,
				maxRequests: 2,
			}),
			repo,
			transport: async ({ url }: { url: string }) => ({
				body: [{ number: 1 }],
				bodyBytes: 14,
				link: url === alertsUrl ? `<${alertsUrl}&after=x>; rel="next"` : null,
				status: 200,
			}),
		});
		await expect(
			duplicateReader.list("dependabot/alerts?state=open&per_page=100", {
				cursorOnly: true,
				uniqueKey: "number",
			}),
		).rejects.toThrow(/UNPROVABLE: DUPLICATE_RECORD/u);

		const pageReader = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 1,
				maxRecords: 10,
				maxRequests: 2,
			}),
			repo,
			transport: async () => ({
				body: [{ number: 1 }],
				bodyBytes: 14,
				link: `<${alertsUrl}&after=x>; rel="next"`,
				status: 200,
			}),
		});
		await expect(
			pageReader.list("dependabot/alerts?state=open&per_page=100", {
				cursorOnly: true,
				uniqueKey: "number",
			}),
		).rejects.toThrow(/UNPROVABLE: PAGE_LIMIT/u);
	});

	it("requires stable total_count and exact retrieved count", async () => {
		const first =
			"https://api.github.com/repos/cacheplane/dawnai/actions/artifacts?per_page=100";
		const reader = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 3,
				maxRecords: 10,
				maxRequests: 3,
			}),
			repo,
			transport: async ({ url }: { url: string }) =>
				url === first
					? {
							body: { artifacts: [{ id: 1 }], total_count: 3 },
							bodyBytes: 50,
							link: `<${first}&page=2>; rel="next"`,
							status: 200,
						}
					: {
							body: { artifacts: [{ id: 2 }], total_count: 2 },
							bodyBytes: 50,
							link: null,
							status: 200,
						},
		});
		await expect(
			reader.list("actions/artifacts?per_page=100", {
				field: "artifacts",
				totalCount: true,
				uniqueKey: "id",
			}),
		).rejects.toThrow(/UNPROVABLE: TOTAL_COUNT_DRIFT/u);
	});

	it("fails when a response arrives at the exact deadline", async () => {
		let clock = 0;
		const reader = createGitHubReader({
			budget: createEvidenceBudget({
				maxBytes: 1024,
				now: () => clock,
				timeoutMs: 10,
			}),
			repo,
			transport: async () => {
				clock = 10;
				return {
					body: { sha: "a".repeat(40) },
					bodyBytes: 64,
					link: null,
					status: 200,
				};
			},
		});
		await expect(reader.object("commits/main")).rejects.toThrow(
			/UNPROVABLE: EVIDENCE_TIMEOUT/u,
		);
	});

	it("charges response headers against the aggregate byte budget", async () => {
		const raw =
			"HTTP/2.0 200 OK\nContent-Type: application/json\nX-Padding: " +
			"x".repeat(128) +
			"\n\n{}";
		const transport = createGhApiTransport({
			runProcess: async () => ({ exitCode: 0, stderr: "", stdout: raw }),
		});
		const reader = createGitHubReader({
			budget: createEvidenceBudget({ maxBytes: 32, maxRequests: 1 }),
			repo,
			transport,
		});
		await expect(reader.object("commits/main")).rejects.toThrow(
			/UNPROVABLE: BYTE_LIMIT/u,
		);
	});
});

describe("bounded fixed-argv subprocess transport", () => {
	it("uses one fixed gh argv and never places credentials in arguments", async () => {
		const observed: unknown[] = [];
		const transport = createGhApiTransport({
			runProcess: async (request: unknown) => {
				observed.push(request);
				return {
					exitCode: 0,
					stderr: "",
					stdout: "HTTP/2.0 200 OK\nContent-Type: application/json\n\n{}",
				};
			},
		});
		await transport({
			maxBytes: 1024,
			responseType: "json",
			timeoutMs: 1000,
			url: "https://api.github.com/repos/cacheplane/dawnai/commits/main",
		});
		expect(observed).toEqual([
			{
				args: [
					"api",
					"--hostname",
					"github.com",
					"--method",
					"GET",
					"--include",
					"-H",
					"Accept: application/vnd.github+json",
					"-H",
					"X-GitHub-Api-Version: 2022-11-28",
					"repos/cacheplane/dawnai/commits/main",
				],
				command: "gh",
				maxBytes: 1024,
				timeoutMs: 1000,
			},
		]);
		expect(JSON.stringify(observed)).not.toMatch(
			/token|authorization|secret/iu,
		);
	});

	it.each([
		"https://api.github.com/repos/cacheplane/dawnai/commits/main?access_token=secret",
		"https://api.github.com/repos/cacheplane/dawnai/commits/main?authorization=secret",
		"https://api.github.com/repos/cacheplane/dawnai/commits/main?token=secret",
	])("rejects credential-shaped query before invoking gh: %s", async (url) => {
		let invoked = false;
		const transport = createGhApiTransport({
			runProcess: async () => {
				invoked = true;
				throw new Error("must not run");
			},
		});
		await expect(
			transport({ maxBytes: 1024, responseType: "json", timeoutMs: 1000, url }),
		).rejects.toThrow(/UNPROVABLE: INVALID_GITHUB_URL/u);
		expect(invoked).toBe(false);
	});

	it("terminates a process at timeout", async () => {
		await expect(
			runBoundedProcess({
				args: ["-e", "setInterval(() => {}, 1000)"],
				command: process.execPath,
				maxBytes: 1024,
				timeoutMs: 50,
			}),
		).rejects.toThrow(/UNPROVABLE: PROCESS_TIMEOUT/u);
	});

	it.runIf(process.platform !== "win32")(
		"terminates a timed-out POSIX process group before inherited pipes can hang settlement",
		async ({ task }) => {
			const temporary = await mkdtemp(
				resolve(tmpdir(), `dawn-evidence-process-tree-${task.id}-`),
			);
			const readyPath = resolve(temporary, "descendant.pid");
			const leaderSource = [
				'const { spawn } = require("node:child_process");',
				'const { writeFileSync } = require("node:fs");',
				'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });',
				'if (descendant.pid === undefined) throw new Error("missing descendant pid");',
				'writeFileSync(process.argv[1], String(descendant.pid), "utf8");',
				"setInterval(() => {}, 1000);",
			].join("");
			let descendantPid: number | undefined;
			const startedAt = Date.now();
			const processResult = runBoundedProcess({
				args: ["-e", leaderSource, readyPath],
				command: process.execPath,
				maxBytes: 1024,
				timeoutMs: 750,
			});
			const observedResult = processResult.then(
				() => ({ status: "resolved" as const }),
				(error: unknown) => ({ error, status: "rejected" as const }),
			);
			try {
				descendantPid = await waitForPid(readyPath);
				const outcome = await Promise.race([
					observedResult,
					delay(2_000).then(() => ({ status: "watchdog" as const })),
				]);
				expect(outcome.status).toBe("rejected");
				if (outcome.status === "rejected") {
					expect(outcome.error).toMatchObject({
						message: "UNPROVABLE: PROCESS_TIMEOUT",
					});
				}
				expect(Date.now() - startedAt).toBeLessThan(2_000);
				expect(processIsRunning(descendantPid)).toBe(false);
			} finally {
				if (descendantPid !== undefined) await stopProcess(descendantPid);
				await Promise.race([observedResult, delay(1_000)]);
				await rm(temporary, { force: true, recursive: true });
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"does not settle when the leader exits until a signal-resistant descendant is dead",
		async ({ task }) => {
			const temporary = await mkdtemp(
				resolve(tmpdir(), `dawn-evidence-resistant-tree-${task.id}-`),
			);
			const readyPath = resolve(temporary, "descendant.pid");
			const descendantSource = [
				'const { writeFileSync } = require("node:fs");',
				'process.on("SIGTERM", () => {});',
				'writeFileSync(process.argv[1], String(process.pid), "utf8");',
				"setInterval(() => {}, 1000);",
			].join("");
			const leaderSource = [
				'const { spawn } = require("node:child_process");',
				`spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}, process.argv[1]], { stdio: "ignore" });`,
				"setInterval(() => {}, 1000);",
			].join("");
			let descendantPid: number | undefined;
			const startedAt = Date.now();
			const processResult = runBoundedProcess({
				args: ["-e", leaderSource, readyPath],
				command: process.execPath,
				maxBytes: 1024,
				timeoutMs: 750,
			});
			const observedResult = processResult.then(
				() => ({ status: "resolved" as const }),
				(error: unknown) => ({ error, status: "rejected" as const }),
			);
			try {
				descendantPid = await waitForPid(readyPath);
				const outcome = await Promise.race([
					observedResult,
					delay(2_000).then(() => ({ status: "watchdog" as const })),
				]);
				expect(outcome.status).toBe("rejected");
				if (outcome.status === "rejected") {
					expect(outcome.error).toMatchObject({
						message: "UNPROVABLE: PROCESS_TIMEOUT",
					});
				}
				expect(Date.now() - startedAt).toBeLessThan(2_000);
				expect(processIsRunning(descendantPid)).toBe(false);
			} finally {
				if (descendantPid !== undefined) await stopProcess(descendantPid);
				await Promise.race([observedResult, delay(1_000)]);
				await rm(temporary, { force: true, recursive: true });
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"uses one bounded taskkill tree request on Windows",
		async ({ task }) => {
			const temporary = await mkdtemp(
				resolve(tmpdir(), `dawn-evidence-taskkill-${task.id}-`),
			);
			const readyPath = resolve(temporary, "leader.pid");
			const source = [
				'const { writeFileSync } = require("node:fs");',
				'writeFileSync(process.argv[1], String(process.pid), "utf8");',
				"setInterval(() => {}, 1000);",
			].join("");
			let leaderPid: number | undefined;
			let taskkillRequest: unknown;
			try {
				const processResult = runBoundedProcess({
					args: ["-e", source, readyPath],
					command: process.execPath,
					maxBytes: 1024,
					platform: "win32",
					runTaskkill: async (request: any) => {
						taskkillRequest = request;
						process.kill(Number(request.args[1]), "SIGKILL");
					},
					timeoutMs: 500,
				});
				leaderPid = await waitForPid(readyPath);
				await expect(processResult).rejects.toThrow(
					/UNPROVABLE: PROCESS_TIMEOUT/u,
				);
				expect(taskkillRequest).toEqual({
					args: ["/PID", String(leaderPid), "/T", "/F"],
					command: "taskkill.exe",
					maxBytes: 64 * 1024,
					timeoutMs: 500,
				});
				expect(processIsRunning(leaderPid)).toBe(false);
			} finally {
				if (leaderPid !== undefined) await stopProcess(leaderPid);
				await rm(temporary, { force: true, recursive: true });
			}
		},
	);

	it("terminates a process when either output cap is exceeded", async () => {
		await expect(
			runBoundedProcess({
				args: ["-e", 'process.stdout.write("x".repeat(4096))'],
				command: process.execPath,
				maxBytes: 64,
				timeoutMs: 2000,
			}),
		).rejects.toThrow(/UNPROVABLE: PROCESS_OUTPUT_LIMIT/u);
	});
});
