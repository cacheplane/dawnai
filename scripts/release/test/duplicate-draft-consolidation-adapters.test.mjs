import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";

import {
	createDuplicateDraftConsolidationAdapters,
	createExactDuplicateDeleteEffect,
} from "../duplicate-draft-consolidation-adapters.mjs";
import {
	claimConsolidationTransitionFacade,
	invokeConsolidationTransition,
} from "../duplicate-draft-consolidation-transition.mjs";
import { createAuthorizedDeleteHarness } from "./support/duplicate-draft-consolidation-authorized-delete.mjs";

const REPOSITORY = "cacheplane/dawnai";
const API_ORIGIN = "https://api.github.com";
const BASE = `${API_ORIGIN}/repos/${REPOSITORY}`;
const SURVIVOR = "379991871";
const DUPLICATES = Object.freeze(["379982100", "379986168"]);
const TOKEN = "github_test_token_123456789";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const TAG_OBJECT_SHA = "123456789abcdef0123456789abcdef012345678";
const USER_AGENT = "dawn-duplicate-draft-consolidation/1";
const NOW = "2026-09-01T12:34:56.789Z";
const TEMPORARY_ROOTS = [];
test.after(async () => {
	await Promise.all(
		TEMPORARY_ROOTS.map((root) => rm(root, { recursive: true, force: true })),
	);
});

test("composition resolves an injected token in memory and sends it only in trusted headers", async () => {
	const recording = recordingFetch([
		jsonResponse({
			id: 1_210_070_282,
			full_name: REPOSITORY,
			default_branch: "main",
		}),
	]);
	const commandCalls = [];
	const adapters = await createAdapters({
		token: TOKEN,
		fetchImpl: recording.fetchImpl,
		run: commandRunner(commandCalls),
	});

	assert.deepEqual(await adapters.github.getRepository(), {
		name: REPOSITORY,
		id: "1210070282",
		defaultBranch: "main",
	});
	assert.equal(
		commandCalls.some(
			([command, args]) => command === "gh" && args[0] === "auth",
		),
		false,
	);
	assert.equal(recording.calls.length, 1);
	assert.deepEqual(recording.calls[0].init.headers, githubHeaders());
	assert.equal(recording.calls[0].url, `${BASE}`);
	assert.equal(JSON.stringify(adapters).includes(TOKEN), false);
	assert.deepEqual(Object.keys(adapters).sort(), [
		"attestations",
		"github",
		"local",
		"npm",
		"writer",
	]);
	assert.equal(Object.isFrozen(adapters.authorityEpoch), true);
	assert.deepEqual(Object.keys(adapters.authorityEpoch), []);
	assert.equal(JSON.stringify(adapters).includes("authorityEpoch"), false);
	assert.throws(
		() => JSON.stringify(adapters.authorityEpoch),
		/serial|capability|epoch/iu,
	);
});

test("workflow-run reads require and return the exact frozen executed query", async () => {
	const recording = recordingFetch([
		jsonResponse({ total_count: 0, workflow_runs: [] }),
	]);
	const adapters = await createAdapters({
		fetchImpl: recording.fetchImpl,
		run: commandRunner([]),
	});
	const query = workflowQuery();
	const result = await adapters.github.listNonterminalWorkflowRuns(query);
	assert.deepEqual(result, { query: workflowQuery(), runs: [] });
	assert.notEqual(result.query, query);
	assert.notEqual(result.query.statuses, query.statuses);
	assert.equal(Object.isFrozen(result), true);
	assert.equal(Object.isFrozen(result.query), true);
	assert.equal(Object.isFrozen(result.query.statuses), true);
	assert.equal(new URL(recording.calls[0].url).search, "?per_page=100&page=1");

	for (const invalid of [
		undefined,
		{ ...query },
		Object.freeze({ ...query, statuses: [...query.statuses] }),
		Object.freeze({ ...query, perPage: 99 }),
		Object.freeze({ ...query, maximumPages: 99 }),
		Object.freeze({
			...query,
			statuses: Object.freeze(query.statuses.slice(1)),
		}),
		Object.freeze({ ...query, statuses: new Proxy(query.statuses, {}) }),
	]) {
		await assert.rejects(
			adapters.github.listNonterminalWorkflowRuns(invalid),
			/query|frozen|status|page|option|exact/iu,
		);
	}
	assert.equal(recording.calls.length, 1);
});

test("terminal target methods bind exact options to the declared Release ID before request", async (t) => {
	for (const method of ["getRelease", "listReleaseAssets"]) {
		for (const invalid of [
			undefined,
			{},
			{ releaseId: Number(DUPLICATES[0]) },
			{ releaseId: DUPLICATES[1] },
			{ releaseId: DUPLICATES[0], extra: true },
		]) {
			await t.test(`${method} rejects ${JSON.stringify(invalid)}`, async () => {
				let releaseRequests = 0;
				let assetRequests = 0;
				const adapters = await createTerminalAdapters({
					async getRelease() {
						releaseRequests += 1;
						return present("release", {});
					},
					async listReleaseAssets() {
						assetRequests += 1;
						return present("release-assets", []);
					},
				});
				const terminal = adapters.authorityEpoch.beginTerminalRead({
					releaseId: DUPLICATES[0],
				});
				if (method === "listReleaseAssets") {
					await terminal.github.getRelease({ releaseId: DUPLICATES[0] });
				}
				await assert.rejects(
					terminal.github[method](invalid),
					/terminal|release|option|canonical|target|invalid/iu,
				);
				assert.equal(releaseRequests, method === "getRelease" ? 0 : 1);
				assert.equal(assetRequests, 0);
				await assert.rejects(
					terminal.github[method]({ releaseId: DUPLICATES[0] }),
					/terminal|invalid|order|epoch/iu,
				);
				assert.equal(releaseRequests, method === "getRelease" ? 0 : 1);
				assert.equal(assetRequests, 0);
				assert.throws(() => terminal.seal(), /terminal|complete|invalid/iu);
			});
		}
	}
});

test("targetless final epochs validate but cannot mint any delete permit", async () => {
	let fetches = 0;
	const adapters = await createTerminalAdapters({
		fetchImpl: async () => {
			fetches += 1;
			return new Response(null, { status: 204 });
		},
	});
	const epoch = adapters.authorityEpoch.sealWithoutTarget();
	assert.doesNotThrow(() => epoch.validate());
	assert.equal(Object.hasOwn(epoch, "issueDeletePermit"), false);
	await assert.rejects(
		adapters.writer.deleteDuplicate({
			releaseId: DUPLICATES[0],
			permit: Object.freeze({}),
		}),
		/permit|guard|one-use|valid/iu,
	);
	assert.equal(fetches, 0);
});

test("terminal authority exposes no publicly callable permit issuer", async () => {
	let fetches = 0;
	const adapters = await createTerminalAdapters({
		fetchImpl: async () => {
			fetches += 1;
			return new Response(null, { status: 204 });
		},
	});
	const terminal = adapters.authorityEpoch.beginTerminalRead({
		releaseId: DUPLICATES[0],
	});
	await terminal.github.getRelease({ releaseId: DUPLICATES[0] });
	await terminal.github.listReleaseAssets({ releaseId: DUPLICATES[0] });
	const epoch = terminal.seal();
	assert.equal(Object.hasOwn(epoch, "issueDeletePermit"), false);
	assert.equal(Object.hasOwn(epoch, "mintPermit"), false);
	assert.deepEqual(Reflect.ownKeys(epoch), [
		"now",
		"journalPath",
		"validate",
		"toJSON",
	]);
	await assert.rejects(
		adapters.writer.deleteDuplicate({
			releaseId: DUPLICATES[0],
			permit: Object.freeze({}),
		}),
		/permit|guard|one-use|valid/iu,
	);
	assert.equal(fetches, 0);
});

test("the internal handshake never reveals a raw arming callback", async () => {
	let fetches = 0;
	const adapters = await createTerminalAdapters({
		fetchImpl: async () => {
			fetches += 1;
			return new Response(null, { status: 204 });
		},
	});
	const terminal = adapters.authorityEpoch.beginTerminalRead({
		releaseId: DUPLICATES[0],
	});
	await terminal.github.getRelease({ releaseId: DUPLICATES[0] });
	await terminal.github.listReleaseAssets({ releaseId: DUPLICATES[0] });
	terminal.seal();

	const capability = claimConsolidationTransitionFacade(adapters);
	assert.equal(typeof capability, "object");
	assert.equal(Object.getPrototypeOf(capability), null);
	assert.equal(Object.isFrozen(capability), true);
	assert.deepEqual(Reflect.ownKeys(capability), []);
	assert.throws(
		() => invokeConsolidationTransition(capability, {}),
		/transition|target|option|invalid/iu,
	);
	assert.throws(
		() => invokeConsolidationTransition(capability, {}),
		/absent|consumed|untrusted/iu,
	);
	await assert.rejects(
		adapters.writer.deleteDuplicate({
			releaseId: DUPLICATES[0],
			permit: Object.freeze({}),
		}),
		/permit|guard|one-use|valid/iu,
	);
	assert.equal(fetches, 0);
});

test("terminal steps reserve synchronously and concurrent calls invalidate the session", async (t) => {
	for (const race of ["two GETs", "GET and assets"]) {
		await t.test(race, async () => {
			let releaseGet;
			let entered;
			let releaseRequests = 0;
			let assetRequests = 0;
			const getEntered = new Promise((resolve) => {
				entered = resolve;
			});
			const getGate = new Promise((resolve) => {
				releaseGet = resolve;
			});
			const adapters = await createTerminalAdapters({
				async getRelease() {
					releaseRequests += 1;
					entered();
					await getGate;
					return present("release", {});
				},
				async listReleaseAssets() {
					assetRequests += 1;
					return present("release-assets", []);
				},
			});
			const terminal = adapters.authorityEpoch.beginTerminalRead({
				releaseId: DUPLICATES[0],
			});
			const first = terminal.github.getRelease({ releaseId: DUPLICATES[0] });
			await getEntered;
			const concurrent =
				race === "two GETs"
					? terminal.github.getRelease({ releaseId: DUPLICATES[0] })
					: terminal.github.listReleaseAssets({ releaseId: DUPLICATES[0] });
			await assert.rejects(concurrent, /terminal|concurrent|order|invalid/iu);
			assert.equal(releaseRequests, 1);
			assert.equal(assetRequests, 0);
			releaseGet();
			await assert.rejects(first, /terminal|concurrent|order|invalid/iu);
			assert.throws(() => terminal.seal(), /terminal|complete|invalid/iu);
		});
	}
});

test("a failed terminal step cannot be retried, sealed, or used to mint", async (t) => {
	for (const failedStep of ["GET", "assets"]) {
		await t.test(failedStep, async () => {
			let releaseRequests = 0;
			let assetRequests = 0;
			const adapters = await createTerminalAdapters({
				async getRelease() {
					releaseRequests += 1;
					if (failedStep === "GET") throw new Error("cancelled target GET");
					return present("release", {});
				},
				async listReleaseAssets() {
					assetRequests += 1;
					throw new Error("cancelled target asset list");
				},
			});
			const terminal = adapters.authorityEpoch.beginTerminalRead({
				releaseId: DUPLICATES[0],
			});
			if (failedStep === "assets") {
				await terminal.github.getRelease({ releaseId: DUPLICATES[0] });
			}
			const method = failedStep === "GET" ? "getRelease" : "listReleaseAssets";
			await assert.rejects(
				terminal.github[method]({ releaseId: DUPLICATES[0] }),
				/cancelled|failed|terminal/iu,
			);
			await assert.rejects(
				terminal.github[method]({ releaseId: DUPLICATES[0] }),
				/terminal|order|invalid/iu,
			);
			assert.equal(releaseRequests, 1);
			assert.equal(assetRequests, failedStep === "assets" ? 1 : 0);
			assert.throws(() => terminal.seal(), /terminal|complete|invalid/iu);
		});
	}
});

test("composition resolves safe environment credentials before gh auth token", async () => {
	for (const [name, value] of [
		["GH_TOKEN", "gh_environment_token"],
		["GITHUB_TOKEN", "github_environment_token"],
	]) {
		const recording = recordingFetch([
			jsonResponse({
				id: 1_210_070_282,
				full_name: REPOSITORY,
				default_branch: "main",
			}),
		]);
		const calls = [];
		const adapters = await createAdapters({
			token: undefined,
			environment: { HOME: "/home/release", PATH: "/tools", [name]: value },
			fetchImpl: recording.fetchImpl,
			run: commandRunner(calls),
		});

		await adapters.github.getRepository();
		assert.equal(
			calls.some(([command, args]) => command === "gh" && args[0] === "auth"),
			false,
		);
		assert.equal(
			recording.calls[0].init.headers.Authorization,
			`Bearer ${value}`,
		);
		assert.equal(JSON.stringify(calls).includes(value), false);
		assert.equal(JSON.stringify(adapters).includes(value), false);
	}
});

test("composition falls back to one bounded non-shell gh auth token command", async () => {
	const calls = [];
	const recording = recordingFetch([
		jsonResponse({
			id: 1_210_070_282,
			full_name: REPOSITORY,
			default_branch: "main",
		}),
	]);
	const adapters = await createAdapters({
		token: undefined,
		environment: {
			HOME: "/home/release",
			PATH: "/tools",
			NODE_OPTIONS: "--require /tmp/unsafe.cjs",
			UNRELATED_SECRET: "must-not-leak",
		},
		fetchImpl: recording.fetchImpl,
		run: commandRunner(calls, { authToken: TOKEN }),
	});

	await adapters.github.getRepository();
	assert.deepEqual(calls[0], [
		"gh",
		["auth", "token"],
		{
			cwd: "/workspace",
			env: { HOME: "/home/release", PATH: "/tools", NO_COLOR: "1" },
		},
	]);
	assert.equal(calls[0][2].shell, undefined);
	assert.equal(JSON.stringify(calls).includes(TOKEN), false);
	assert.equal(JSON.stringify(calls).includes("must-not-leak"), false);
	assert.equal(JSON.stringify(calls).includes("unsafe"), false);
	assert.equal(
		recording.calls[0].init.headers.Authorization,
		`Bearer ${TOKEN}`,
	);
});

test("command environment canonicalizes bounded Windows runtime aliases", async () => {
	const calls = [];
	const environment = {
		ci: "true",
		ColorTerm: "truecolor",
		ComSpec: "C:\\Windows\\System32\\cmd.exe",
		Force_Color: "1",
		Github_Actions: "true",
		Home: "C:\\Users\\release",
		lang: "en_US.UTF-8",
		Lc_All: "C",
		Path: "C:\\tools",
		path: "C:\\tools",
		PathExt: ".COM;.EXE;.BAT;.CMD",
		SystemRoot: "C:\\Windows",
		Temp: "C:\\Temp",
		term: "xterm-256color",
		tmp: "C:\\Tmp",
		TmpDir: "C:\\TmpDir",
		UserProfile: "C:\\Users\\release",
		Gh_ToKeN: "must-not-be-a-token",
		Node_Options: "--require C:\\unsafe.cjs",
		Unrelated_Secret: "must-not-leak",
	};
	const adapters = await createAdapters({
		token: undefined,
		environment,
		fetchImpl: assert.fail,
		run: commandRunner(calls, { authToken: TOKEN }),
	});

	await adapters.local.readState();
	const expectedEnvironment = {
		CI: "true",
		COLORTERM: "truecolor",
		COMSPEC: "C:\\Windows\\System32\\cmd.exe",
		FORCE_COLOR: "1",
		GITHUB_ACTIONS: "true",
		HOME: "C:\\Users\\release",
		LANG: "en_US.UTF-8",
		LC_ALL: "C",
		PATH: "C:\\tools",
		PATHEXT: ".COM;.EXE;.BAT;.CMD",
		SYSTEMROOT: "C:\\Windows",
		TEMP: "C:\\Temp",
		TERM: "xterm-256color",
		TMP: "C:\\Tmp",
		TMPDIR: "C:\\TmpDir",
		USERPROFILE: "C:\\Users\\release",
		NO_COLOR: "1",
	};
	for (const [, , options] of calls) {
		assert.deepEqual(options.env, expectedEnvironment);
		assert.equal(Object.hasOwn(options.env, "Path"), false);
		assert.equal(
			JSON.stringify(options.env).includes("must-not-be-a-token"),
			false,
		);
		assert.equal(JSON.stringify(options.env).includes("unsafe"), false);
		assert.equal(JSON.stringify(options.env).includes("must-not-leak"), false);
	}
});

test("Windows environment rejects conflicting case aliases before command invocation", async () => {
	const logicalNames = [
		"CI",
		"COLORTERM",
		"COMSPEC",
		"FORCE_COLOR",
		"GITHUB_ACTIONS",
		"HOME",
		"LANG",
		"LC_ALL",
		"PATH",
		"PATHEXT",
		"SYSTEMROOT",
		"TEMP",
		"TERM",
		"TMP",
		"TMPDIR",
		"USERPROFILE",
	];
	for (const name of logicalNames) {
		const commandCalls = [];
		const fetchCalls = [];
		const alias = name === "PATH" ? "Path" : name.toLowerCase();
		const environment = {
			ComSpec: "C:\\Windows\\System32\\cmd.exe",
			PathExt: ".COM;.EXE;.BAT;.CMD",
			SystemRoot: "C:\\Windows",
			[name]: "first",
			[alias]: "second",
		};

		await assert.rejects(
			createAdapters({
				environment,
				fetchImpl: (...args) => fetchCalls.push(args),
				run: async (...args) => {
					commandCalls.push(args);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			}),
			/environment|alias|conflict|duplicate|unsafe/iu,
			name,
		);
		assert.equal(commandCalls.length, 0, name);
		assert.equal(fetchCalls.length, 0, name);
	}
});

test("POSIX environment keeps approved names case-sensitive", async () => {
	const calls = [];
	const adapters = await createAdapters({
		token: undefined,
		environment: {
			HOME: "/home/release",
			home: "/unsafe-home",
			PATH: "/usr/bin",
			Path: "/opt/legacy-bin",
			path: "/unsafe-bin",
			SYSTEMROOT: "posix-data",
			temp: "/unsafe-temp",
			Gh_ToKeN: "must-not-be-a-token",
		},
		fetchImpl: assert.fail,
		run: commandRunner(calls, { authToken: TOKEN }),
	});

	await adapters.local.readState();
	for (const [, , options] of calls) {
		assert.deepEqual(options.env, {
			HOME: "/home/release",
			PATH: "/usr/bin",
			SYSTEMROOT: "posix-data",
			NO_COLOR: "1",
		});
	}

	const pathOnlyCalls = [];
	const pathOnly = await createAdapters({
		environment: { HOME: "/home/release", Path: "/opt/legacy-bin" },
		fetchImpl: assert.fail,
		run: commandRunner(pathOnlyCalls),
	});
	await pathOnly.local.readState();
	for (const [, , options] of pathOnlyCalls) {
		assert.deepEqual(options.env, {
			HOME: "/home/release",
			Path: "/opt/legacy-bin",
			NO_COLOR: "1",
		});
	}
});

test("token inputs and command output are strictly bounded and never echoed in errors", async () => {
	for (const token of [
		null,
		42,
		"",
		"bad\ntoken",
		"bad\u0000token",
		"x".repeat(4_097),
	]) {
		await assert.rejects(
			createAdapters({ token, fetchImpl: assert.fail, run: assert.fail }),
			(error) =>
				typeof token !== "string" ||
				token.length === 0 ||
				!String(error).includes(token),
		);
	}

	for (const stdout of ["", "bad\ntoken\n", `${"x".repeat(4_097)}\n`]) {
		await assert.rejects(
			createAdapters({
				token: undefined,
				fetchImpl: assert.fail,
				run: async () => ({ exitCode: 0, stdout, stderr: TOKEN }),
			}),
			(error) =>
				(stdout.length === 0 || !String(error).includes(stdout)) &&
				!String(error).includes(TOKEN),
		);
	}

	const source = await readFile(
		new URL("../duplicate-draft-consolidation-adapters.mjs", import.meta.url),
		"utf8",
	);
	assert.equal(source.includes(TOKEN), false);
});

test("options and dependencies are exact descriptor-safe snapshots", async () => {
	let invoked = 0;
	const accessor = {};
	Object.defineProperty(accessor, "token", {
		enumerable: true,
		get() {
			invoked += 1;
			return TOKEN;
		},
	});
	await assert.rejects(
		createDuplicateDraftConsolidationAdapters(accessor),
		/accessor|descriptor|option|unsafe/iu,
	);
	assert.equal(invoked, 0);

	const dependencyAccessor = {};
	Object.defineProperty(dependencyAccessor, "fetchImpl", {
		enumerable: true,
		get() {
			invoked += 1;
			return assert.fail;
		},
	});
	await assert.rejects(
		createDuplicateDraftConsolidationAdapters({
			cwd: "/workspace",
			token: TOKEN,
			dependencies: dependencyAccessor,
		}),
		/dependenc|accessor|descriptor|unsafe/iu,
	);
	assert.equal(invoked, 0);

	for (const value of [
		{ cwd: "/workspace", token: TOKEN, extra: true },
		Object.assign(Object.create({ inherited: true }), {
			cwd: "/workspace",
			token: TOKEN,
		}),
		Object.assign(
			{ cwd: "/workspace", token: TOKEN },
			{ [Symbol("hidden")]: true },
		),
	]) {
		await assert.rejects(createDuplicateDraftConsolidationAdapters(value));
	}

	const hidden = { cwd: "/workspace", token: TOKEN };
	Object.defineProperty(hidden, "extra", { value: true });
	await assert.rejects(createDuplicateDraftConsolidationAdapters(hidden));

	const proxy = new Proxy(
		{ cwd: "/workspace", token: TOKEN },
		{
			ownKeys() {
				invoked += 1;
				return ["cwd", "token"];
			},
		},
	);
	await assert.rejects(
		createDuplicateDraftConsolidationAdapters(proxy),
		/proxy|unsafe|option/iu,
	);
	assert.equal(invoked, 0);

	await assert.rejects(
		createDuplicateDraftConsolidationAdapters({
			cwd: "/workspace",
			token: TOKEN,
			dependencies: { fetchImpl: undefined },
		}),
		/dependenc|fetch|function|invalid/iu,
	);
	for (const dependencies of [null, undefined]) {
		await assert.rejects(
			createDuplicateDraftConsolidationAdapters({
				cwd: "/workspace",
				token: TOKEN,
				dependencies,
			}),
			/dependenc|plain object|invalid/iu,
		);
	}
});

test("tokens reject whitespace even when it is not an HTTP control character", async () => {
	for (const token of [
		"bad token",
		" leading",
		"trailing ",
		"bad\u00a0token",
	]) {
		await assert.rejects(
			createAdapters({ token, fetchImpl: assert.fail, run: assert.fail }),
			/token|invalid/iu,
		);
	}
});

test("composition delegates to the required factories with fixed bounded identities", async () => {
	const calls = [];
	const github = githubBoundary();
	const npm = { observePackageVersion: async (input) => input };
	const attestations = { verify: async (input) => input };
	const owner = { git: { headSha: async () => HEAD_SHA } };
	const adapters = await createDuplicateDraftConsolidationAdapters({
		cwd: "/workspace",
		token: TOKEN,
		environment: { HOME: "/home/release", PATH: "/tools" },
		dependencies: {
			fetchImpl: assert.fail,
			run: commandRunner([]),
			now: () => NOW,
			createGitHubReader(options) {
				calls.push(["github", options]);
				return github;
			},
			createOwnerPreflightAdapters(options) {
				calls.push(["owner", options]);
				return owner;
			},
			createNpmReader(options) {
				calls.push(["npm", options]);
				return npm;
			},
			createCliAttestationVerifier(options) {
				calls.push(["attestations", options]);
				return attestations;
			},
		},
	});

	assert.deepEqual(Object.keys(calls[0][1]).sort(), [
		"apiOrigin",
		"fetchImpl",
		"maxPages",
		"maxRecords",
		"now",
		"owner",
		"repo",
		"token",
	]);
	assert.equal(calls[0][1].owner, "cacheplane");
	assert.equal(calls[0][1].repo, "dawnai");
	assert.equal(calls[0][1].apiOrigin, API_ORIGIN);
	assert.equal(calls[0][1].maxPages, 100);
	assert.equal(calls[0][1].maxRecords, 10_000);
	assert.equal(calls[1][0], "owner");
	assert.deepEqual(Object.keys(calls[1][1]).sort(), [
		"cwd",
		"environment",
		"run",
	]);
	assert.equal(calls[2][0], "npm");
	assert.deepEqual(Object.keys(calls[2][1]).sort(), ["fetchImpl"]);
	assert.equal(calls[3][0], "attestations");
	assert.deepEqual(Object.keys(calls[3][1]).sort(), [
		"repository",
		"runGh",
		"token",
	]);
	assert.notEqual(adapters.github.listReleases, github.listReleases);
	assert.notEqual(
		adapters.npm.observePackageVersion,
		npm.observePackageVersion,
	);
	assert.notEqual(adapters.attestations.verify, attestations.verify);
});

test("GitHub reads use exact trusted endpoints, headers, pagination, and normalized evidence", async () => {
	const secondReleasePage = `${BASE}/releases?per_page=100&page=2`;
	const recording = recordingFetch([
		jsonResponse({
			id: 1_210_070_282,
			full_name: REPOSITORY,
			default_branch: "main",
		}),
		jsonResponse({ id: 61_436, login: "blove" }),
		jsonResponse({
			ref: "refs/heads/main",
			object: { type: "commit", sha: HEAD_SHA },
		}),
		jsonResponse({
			id: 12_345,
			path: ".github/workflows/release.yml",
			state: "disabled_manually",
		}),
		jsonResponse({ total_count: 1, workflow_runs: [workflowRun()] }),
		jsonResponse({
			ref: "refs/tags/v0.8.22",
			object: { type: "tag", sha: TAG_OBJECT_SHA },
		}),
		jsonResponse({
			sha: TAG_OBJECT_SHA,
			tag: "v0.8.22",
			object: { type: "commit", sha: HEAD_SHA },
		}),
		jsonResponse([{ id: 2, name: "second" }], 200, {
			Link: `<${secondReleasePage}>; rel="next"`,
		}),
		jsonResponse([{ id: 1, name: "first" }]),
		jsonResponse({ id: Number(SURVIVOR), draft: true }),
		jsonResponse([{ id: 91, name: "manifest.json" }]),
		binaryResponse(Buffer.from("asset")),
	]);
	const adapters = await createAdapters({
		fetchImpl: recording.fetchImpl,
		run: commandRunner([]),
	});

	assert.deepEqual(await adapters.github.getRepository(), {
		name: REPOSITORY,
		id: "1210070282",
		defaultBranch: "main",
	});
	assert.deepEqual(await adapters.github.getAuthenticatedUser(), {
		login: "blove",
		id: "61436",
	});
	assert.equal(await adapters.github.getDefaultBranchSha(), HEAD_SHA);
	assert.deepEqual(await adapters.github.getWorkflowState(), {
		workflowId: "12345",
		path: ".github/workflows/release.yml",
		state: "disabled_manually",
	});
	assert.deepEqual(
		await adapters.github.listNonterminalWorkflowRuns(workflowQuery()),
		{
			query: workflowQuery(),
			runs: [normalizedWorkflowRun()],
		},
	);
	assert.deepEqual(await adapters.github.getAnnotatedTag({ name: "v0.8.22" }), {
		name: "v0.8.22",
		objectSha: TAG_OBJECT_SHA,
		targetSha: HEAD_SHA,
		objectType: "tag",
		observedAt: NOW,
	});
	assert.deepEqual((await adapters.github.listReleases()).value, [
		{ id: 1, name: "first" },
		{ id: 2, name: "second" },
	]);
	assert.equal(
		(await adapters.github.getRelease({ releaseId: SURVIVOR })).value.id,
		Number(SURVIVOR),
	);
	assert.equal(
		(await adapters.github.listReleaseAssets({ releaseId: SURVIVOR })).value[0]
			.id,
		91,
	);
	assert.equal(
		Buffer.from(
			(
				await adapters.github.downloadReleaseAsset({
					assetId: "91",
					maximumBytes: 5,
				})
			).contentBase64,
			"base64",
		).toString(),
		"asset",
	);

	assert.deepEqual(
		recording.calls.map(({ url }) => url),
		[
			BASE,
			`${API_ORIGIN}/user`,
			`${BASE}/git/ref/heads%2Fmain`,
			`${BASE}/actions/workflows/release.yml`,
			`${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=1`,
			`${BASE}/git/ref/tags%2Fv0.8.22`,
			`${BASE}/git/tags/${TAG_OBJECT_SHA}`,
			`${BASE}/releases?per_page=100`,
			secondReleasePage,
			`${BASE}/releases/${SURVIVOR}`,
			`${BASE}/releases/${SURVIVOR}/assets?per_page=100`,
			`${BASE}/releases/assets/91`,
		],
	);
	for (const { init } of recording.calls) {
		assert.equal(init.redirect, "manual");
		assert.equal(init.headers["User-Agent"], USER_AGENT);
		assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
		assert.equal(
			init.headers.Accept,
			init.method === "GET" &&
				init.headers.Accept === "application/octet-stream"
				? "application/octet-stream"
				: "application/vnd.github+json",
		);
		assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28");
	}
});

test("asset downloads preserve the production one-hop signed-host boundary", async () => {
	const signedUrl =
		"https://release-assets.githubusercontent.com/github-production-release-asset/1210070282/91/manifest.json?sp=r&sv=2025-01-05&sig=exact-signature";
	const recording = recordingFetch([
		redirectResponse(signedUrl),
		binaryResponse(Buffer.from("asset")),
	]);
	const adapters = await createAdapters({
		fetchImpl: recording.fetchImpl,
		run: commandRunner([]),
	});

	assert.equal(
		Buffer.from(
			(
				await adapters.github.downloadReleaseAsset({
					assetId: "91",
					maximumBytes: 5,
				})
			).contentBase64,
			"base64",
		).toString(),
		"asset",
	);
	assert.deepEqual(recording.calls, [
		{
			url: `${BASE}/releases/assets/91`,
			init: {
				method: "GET",
				headers: {
					Accept: "application/octet-stream",
					Authorization: `Bearer ${TOKEN}`,
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": USER_AGENT,
				},
				redirect: "manual",
				signal: recording.calls[0].init.signal,
			},
		},
		{
			url: signedUrl,
			init: {
				method: "GET",
				headers: { "User-Agent": USER_AGENT },
				redirect: "manual",
				signal: recording.calls[1].init.signal,
			},
		},
	]);
	assert.equal(
		recording.calls[0].init.headers.Authorization,
		`Bearer ${TOKEN}`,
	);
	assert.equal(
		Object.hasOwn(recording.calls[1].init.headers, "Authorization"),
		false,
	);

	for (const location of [
		"https://evil.example/github-production-release-asset/1210070282/91/manifest.json?sig=x",
		"https://release-assets.githubusercontent.com.evil.example/asset?sig=x",
		"https://release-assets.githubusercontent.com/asset#fragment",
	]) {
		const unsafe = recordingFetch([redirectResponse(location)]);
		const unsafeAdapters = await createAdapters({
			fetchImpl: unsafe.fetchImpl,
			run: commandRunner([]),
		});
		const result = await unsafeAdapters.github.downloadReleaseAsset({
			assetId: "91",
			maximumBytes: 5,
		});
		assert.equal(result.status, "ERROR");
		assert.equal(result.code, "UNSAFE_DOWNLOAD_URL");
		assert.equal(unsafe.calls.length, 1);
	}

	const extraHop = recordingFetch([
		redirectResponse(signedUrl),
		redirectResponse(`${signedUrl}&retry=1`),
	]);
	const extraHopAdapters = await createAdapters({
		fetchImpl: extraHop.fetchImpl,
		run: commandRunner([]),
	});
	const extraHopResult = await extraHopAdapters.github.downloadReleaseAsset({
		assetId: "91",
		maximumBytes: 5,
	});
	assert.equal(extraHopResult.status, "ERROR");
	assert.equal(extraHopResult.code, "REDIRECT");
	assert.equal(extraHop.calls.length, 2);
	assert.equal(
		Object.hasOwn(extraHop.calls[1].init.headers, "Authorization"),
		false,
	);

	const source = await readFile(
		new URL("../duplicate-draft-consolidation-adapters.mjs", import.meta.url),
		"utf8",
	);
	for (const duplicatedAuthority of [
		"objects.githubusercontent.com",
		"release-assets.githubusercontent.com",
		"productionresultssa",
	]) {
		assert.equal(source.includes(duplicatedAuthority), false);
	}
});

test("signed download transport rejects caller-driven second hops", async () => {
	const calls = [];
	const signedUrl =
		"https://release-assets.githubusercontent.com/github-production-release-asset/1210070282/91/manifest.json?sig=exact";
	const adapters = await createDuplicateDraftConsolidationAdapters({
		cwd: "/workspace",
		token: TOKEN,
		environment: { HOME: "/home/release", PATH: "/tools" },
		dependencies: {
			fetchImpl: async (...args) => {
				calls.push(args);
				return binaryResponse(Buffer.from("asset"));
			},
			run: commandRunner([]),
			now: () => NOW,
			createGitHubReader({ fetchImpl }) {
				return {
					...githubBoundary(),
					async downloadReleaseAsset() {
						await fetchImpl(signedUrl, {
							method: "GET",
							headers: {},
							redirect: "manual",
						});
						return {
							status: "PRESENT",
							operation: "release-asset-download",
							httpStatus: 200,
							code: null,
							contentBase64: "YXNzZXQ=",
						};
					},
				};
			},
		},
	});

	await assert.rejects(
		() =>
			adapters.github.downloadReleaseAsset({ assetId: "91", maximumBytes: 5 }),
		/flow|hop|origin|trusted|download/iu,
	);
	assert.equal(calls.length, 0);

	const seeded = recordingFetch([
		redirectResponse(signedUrl),
		binaryResponse(Buffer.from("asset")),
	]);
	const seededAdapters = await createDuplicateDraftConsolidationAdapters({
		cwd: "/workspace",
		token: TOKEN,
		environment: { HOME: "/home/release", PATH: "/tools" },
		dependencies: {
			fetchImpl: seeded.fetchImpl,
			run: commandRunner([]),
			now: () => NOW,
			createGitHubReader({ fetchImpl }) {
				return {
					...githubBoundary(),
					async downloadReleaseAsset() {
						await fetchImpl(`${BASE}/releases/assets/91`, {
							method: "GET",
							headers: {},
							redirect: "manual",
						});
						await fetchImpl(signedUrl, {
							method: "GET",
							headers: {},
							redirect: "manual",
						});
						return {
							status: "PRESENT",
							operation: "release-asset-download",
							httpStatus: 200,
							code: null,
							contentBase64: "YXNzZXQ=",
						};
					},
				};
			},
		},
	});
	await assert.rejects(
		() =>
			seededAdapters.github.downloadReleaseAsset({
				assetId: "91",
				maximumBytes: 5,
			}),
		/flow|hop|origin|trusted|download/iu,
	);
	assert.equal(seeded.calls.length, 1);
});

test("authorized download hops strip credentials at the transport boundary", async () => {
	const signedUrl =
		"https://release-assets.githubusercontent.com/github-production-release-asset/1210070282/91/manifest.json?sig=exact";
	const recording = recordingFetch([
		redirectResponse(signedUrl),
		binaryResponse(Buffer.from("asset")),
	]);
	const adapters = await createDuplicateDraftConsolidationAdapters({
		cwd: "/workspace",
		token: TOKEN,
		environment: { HOME: "/home/release", PATH: "/tools" },
		dependencies: {
			fetchImpl: recording.fetchImpl,
			run: commandRunner([]),
			now: () => NOW,
			createGitHubReader({ fetchImpl }) {
				return {
					...githubBoundary(),
					async downloadReleaseAsset() {
						const first = await fetchImpl(`${BASE}/releases/assets/91`, {
							method: "GET",
							headers: {
								Accept: "application/octet-stream",
								Authorization: `Bearer ${TOKEN}`,
								"X-GitHub-Api-Version": "2022-11-28",
							},
							redirect: "manual",
						});
						await fetchImpl(first.headers.get("location"), {
							method: "GET",
							headers: {
								Accept: "application/octet-stream",
								Authorization: `Bearer ${TOKEN}`,
							},
							redirect: "manual",
						});
						return {
							status: "PRESENT",
							operation: "release-asset-download",
							httpStatus: 200,
							code: null,
							contentBase64: "YXNzZXQ=",
						};
					},
				};
			},
		},
	});

	assert.equal(
		(
			await adapters.github.downloadReleaseAsset({
				assetId: "91",
				maximumBytes: 5,
			})
		).contentBase64,
		"YXNzZXQ=",
	);
	assert.equal(recording.calls.length, 2);
	assert.equal(
		Object.hasOwn(recording.calls[1].init.headers, "Authorization"),
		false,
	);
	assert.equal(
		recording.calls[1].init.headers.Accept,
		"application/octet-stream",
	);
	assert.equal(recording.calls[1].init.headers["User-Agent"], USER_AGENT);
});

test("release and asset readers reject duplicate numeric identities across pages", async () => {
	for (const [method, firstUrl, secondUrl, invoke, code] of [
		[
			"release",
			`${BASE}/releases?per_page=100`,
			`${BASE}/releases?per_page=100&page=2`,
			(github) => github.listReleases(),
			"DUPLICATE_RELEASE_ID",
		],
		[
			"asset",
			`${BASE}/releases/${SURVIVOR}/assets?per_page=100`,
			`${BASE}/releases/${SURVIVOR}/assets?per_page=100&page=2`,
			(github) => github.listReleaseAssets({ releaseId: SURVIVOR }),
			"DUPLICATE_ASSET_ID",
		],
	]) {
		const recording = recordingFetch([
			jsonResponse([{ id: 7, name: `${method}-one` }], 200, {
				Link: `<${secondUrl}>; rel="next"`,
			}),
			jsonResponse([{ id: 7, name: `${method}-two` }]),
		]);
		const adapters = await createAdapters({
			fetchImpl: recording.fetchImpl,
			run: commandRunner([]),
		});
		assert.deepEqual(await invoke(adapters.github), {
			status: "ERROR",
			operation: method === "release" ? "releases" : "release-assets",
			httpStatus: 200,
			code,
		});
		assert.deepEqual(
			recording.calls.map(({ url }) => url),
			[firstUrl, secondUrl],
		);
	}
});

test("release and asset pagination accept compatible shared Link targets", async () => {
	for (const [operation, firstUrl, secondUrl, invoke] of [
		[
			"releases",
			`${BASE}/releases?per_page=100&page=1`,
			`${BASE}/releases?per_page=100&page=2`,
			(github) => github.listReleases(),
		],
		[
			"release-assets",
			`${BASE}/releases/${SURVIVOR}/assets?per_page=100&page=1`,
			`${BASE}/releases/${SURVIVOR}/assets?per_page=100&page=2`,
			(github) => github.listReleaseAssets({ releaseId: SURVIVOR }),
		],
	]) {
		const recording = recordingFetch([
			jsonResponse([{ id: 2, name: "second" }], 200, {
				Link: `<${secondUrl}>; rel="next", <${secondUrl}>; rel="last"`,
			}),
			jsonResponse([{ id: 1, name: "first" }], 200, {
				Link: `<${firstUrl}>; rel="prev", <${firstUrl}>; rel="first"`,
			}),
		]);
		const adapters = await createAdapters({
			fetchImpl: recording.fetchImpl,
			run: commandRunner([]),
		});
		assert.deepEqual(await invoke(adapters.github), {
			status: "PRESENT",
			operation,
			httpStatus: 200,
			code: null,
			value: [
				{ id: 1, name: "first" },
				{ id: 2, name: "second" },
			],
		});
		assert.equal(recording.calls.length, 2);
	}
});

test("release and asset pagination reject incompatible complete Link graphs", async () => {
	for (const [operation, page2, page3, invoke] of [
		[
			"releases",
			`${BASE}/releases?per_page=100&page=2`,
			`${BASE}/releases?per_page=100&page=3`,
			(github) => github.listReleases(),
		],
		[
			"release-assets",
			`${BASE}/releases/${SURVIVOR}/assets?per_page=100&page=2`,
			`${BASE}/releases/${SURVIVOR}/assets?per_page=100&page=3`,
			(github) => github.listReleaseAssets({ releaseId: SURVIVOR }),
		],
	]) {
		for (const link of [
			`<${page2}>; rel="next", <${page2}>; rel="prev"`,
			`<${page2}>; rel="next", <${page2}>; rel="first"`,
			`<${page2}>; rel="last", <${page2}>; rel="prev"`,
			`<${page2}>; rel="last", <${page2}>; rel="first"`,
			`<${page2}>; rel="next", <${page3}>; rel="next"`,
			`<${page2}>; rel="next last"`,
		]) {
			const recording = recordingFetch([jsonResponse([], 200, { Link: link })]);
			const adapters = await createAdapters({
				fetchImpl: recording.fetchImpl,
				run: commandRunner([]),
			});
			assert.deepEqual(await invoke(adapters.github), {
				status: "ERROR",
				operation,
				httpStatus: 200,
				code: "MALFORMED_LINK_HEADER",
			});
			assert.equal(recording.calls.length, 1);
		}
	}
});

test("GitHub reader preserves fail-closed pagination and transport classifications", async () => {
	const unsafeNext = [
		`https://evil.example/repos/cacheplane/dawnai/releases?per_page=100&page=2`,
		`${BASE}/issues?per_page=100&page=2`,
		`${BASE}/releases?per_page=100&page=2&extra=true`,
	];
	for (const next of unsafeNext) {
		const adapters = await createAdapters({
			fetchImpl: async () =>
				jsonResponse([], 200, { Link: `<${next}>; rel="next"` }),
			run: commandRunner([]),
		});
		assert.equal(
			(await adapters.github.listReleases()).code,
			"UNSAFE_PAGINATION_URL",
		);
	}

	const repeated = `${BASE}/releases?per_page=100&page=2`;
	const adapters = await createAdapters({
		fetchImpl: async () =>
			jsonResponse([], 200, { Link: `<${repeated}>; rel="next"` }),
		run: commandRunner([]),
	});
	assert.equal((await adapters.github.listReleases()).code, "PAGINATION_LOOP");

	for (const response of [
		jsonResponse({ message: "forbidden" }, 403),
		jsonResponse({ message: "rate limited" }, 429),
		jsonResponse({ message: "server" }, 503),
		new Response("not-json", {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
		new Response(null, {
			status: 302,
			headers: { location: `${BASE}/releases` },
		}),
	]) {
		const reader = await createAdapters({
			fetchImpl: async () => response,
			run: commandRunner([]),
		});
		assert.notEqual((await reader.github.listReleases()).status, "PRESENT");
	}
});

test("workflow-run enumeration rejects unstable totals, duplicate IDs, and bounds", async () => {
	const page = Array.from({ length: 100 }, (_unused, index) =>
		workflowRun(index + 1),
	);
	const next = `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=2`;
	for (const responses of [
		[
			jsonResponse({ total_count: 101, workflow_runs: page }, 200, {
				Link: `<${next}>; rel="next"`,
			}),
			jsonResponse({ total_count: 102, workflow_runs: [workflowRun(101)] }),
		],
		[
			jsonResponse({ total_count: 101, workflow_runs: page }, 200, {
				Link: `<${next}>; rel="next"`,
			}),
			jsonResponse({ total_count: 101, workflow_runs: [workflowRun(1)] }),
		],
		[jsonResponse({ total_count: 10_001, workflow_runs: [] })],
	]) {
		const recording = recordingFetch(responses);
		const adapters = await createAdapters({
			fetchImpl: recording.fetchImpl,
			run: commandRunner([]),
		});
		await assert.rejects(
			adapters.github.listNonterminalWorkflowRuns(workflowQuery()),
			/total|duplicate|record|bound/iu,
		);
	}
});

test("workflow-run enumeration requires one exact trusted Link next relation", async () => {
	const page = Array.from({ length: 100 }, (_unused, index) =>
		workflowRun(index + 1),
	);
	const endpoint = `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=2`;
	for (const link of [
		null,
		`<https://evil.example/repos/cacheplane/dawnai/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=2>; rel="next"`,
		`<${BASE}/issues?per_page=100&page=2>; rel="next"`,
		`<${endpoint}&extra=true>; rel="next"`,
		`<${endpoint}>; rel="next prev"`,
		`<${endpoint}>; rel="next", <${endpoint}>; rel="prev"`,
		`<${endpoint}>; rel="next", <${endpoint}>; rel="first"`,
		`<${endpoint}>; rel="last", <${endpoint}>; rel="prev"`,
		`<${endpoint}>; rel="last", <${endpoint}>; rel="first"`,
		`<${endpoint}>; rel="next last"`,
		`<${endpoint}>; rel="next", <${endpoint}>; rel="next"`,
		`<${endpoint}>; rel="next", malformed`,
	]) {
		const first = jsonResponse(
			{ total_count: 101, workflow_runs: page },
			200,
			link === null ? {} : { Link: link },
		);
		const adapters = await createAdapters({
			fetchImpl: recordingFetch([first]).fetchImpl,
			run: commandRunner([]),
		});
		await assert.rejects(
			adapters.github.listNonterminalWorkflowRuns(workflowQuery()),
			/Link|pagination|next|trusted|URL/iu,
		);
	}
});

test("workflow-run pagination accepts compatible next-last and prev-first aliases", async () => {
	const firstPageUrl = `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=1`;
	const secondPageUrl = `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=2`;
	const page = Array.from({ length: 100 }, (_unused, index) =>
		workflowRun(index + 1),
	);
	const recording = recordingFetch([
		jsonResponse({ total_count: 101, workflow_runs: page }, 200, {
			Link: `<${secondPageUrl}>; rel="next", <${secondPageUrl}>; rel="last"`,
		}),
		jsonResponse({ total_count: 101, workflow_runs: [workflowRun(101)] }, 200, {
			Link: `<${firstPageUrl}>; rel="prev", <${firstPageUrl}>; rel="first"`,
		}),
	]);
	const adapters = await createAdapters({
		fetchImpl: recording.fetchImpl,
		run: commandRunner([]),
	});

	const result = await adapters.github.listNonterminalWorkflowRuns(
		workflowQuery(),
	);
	assert.deepEqual(result.query, workflowQuery());
	assert.equal(result.runs.length, 101);
	assert.deepEqual(result.runs[0], normalizedWorkflowRun("1"));
	assert.deepEqual(result.runs.at(-1), normalizedWorkflowRun("101"));
	assert.deepEqual(
		recording.calls.map(({ url }) => url),
		[firstPageUrl, secondPageUrl],
	);
});

test("workflow-run pagination enforces one cumulative raw-byte budget", async () => {
	const firstPage = Array.from({ length: 100 }, (_unused, index) =>
		workflowRun(index + 1),
	);
	const secondPage = [workflowRun(101)];
	const secondPageUrl = `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=2`;
	const padding = "x".repeat(4_500_000);
	const recording = recordingFetch([
		jsonResponse({ total_count: 101, workflow_runs: firstPage, padding }, 200, {
			Link: `<${secondPageUrl}>; rel="next"`,
		}),
		jsonResponse({ total_count: 101, workflow_runs: secondPage, padding }),
	]);
	const adapters = await createAdapters({
		fetchImpl: recording.fetchImpl,
		run: commandRunner([]),
	});

	await assert.rejects(
		adapters.github.listNonterminalWorkflowRuns(workflowQuery()),
		/byte|size|large|budget|failed closed/iu,
	);
	assert.equal(recording.calls.length, 2);
});

test("workflow-run pagination enforces one cumulative wall-clock deadline", async () => {
	const firstPage = Array.from({ length: 100 }, (_unused, index) =>
		workflowRun(index + 1),
	);
	const secondPageUrl = `${BASE}/actions/workflows/.github%2Fworkflows%2Frelease.yml/runs?per_page=100&page=2`;
	let clockMillis = Date.parse(NOW);
	const recording = recordingFetch([
		jsonResponse({ total_count: 101, workflow_runs: firstPage }, 200, {
			Link: `<${secondPageUrl}>; rel="next"`,
		}),
		jsonResponse({ total_count: 101, workflow_runs: [workflowRun(101)] }),
	]);
	const fetchImpl = async (...args) => {
		const response = await recording.fetchImpl(...args);
		clockMillis += 15_001;
		return response;
	};
	const adapters = await createAdapters({
		fetchImpl,
		run: commandRunner([]),
		now: () => new Date(clockMillis).toISOString(),
	});

	await assert.rejects(
		adapters.github.listNonterminalWorkflowRuns(workflowQuery()),
		/deadline|time|budget|failed closed/iu,
	);
	assert.equal(recording.calls.length, 1);
});

test("local Git reads use exact argv arrays and reject detached, dirty, or malformed output", async () => {
	const calls = [];
	const adapters = await createAdapters({
		fetchImpl: assert.fail,
		run: commandRunner(calls),
	});
	assert.deepEqual(await adapters.local.readState(), {
		headSha: HEAD_SHA,
		branch: "main",
		porcelainStatus: "",
		originMainSha: HEAD_SHA,
	});
	assert.deepEqual(
		calls.map(([command, args]) => [command, args]),
		[
			["git", ["rev-parse", "--verify", "HEAD^{commit}"]],
			["git", ["symbolic-ref", "--quiet", "--short", "HEAD"]],
			["git", ["status", "--porcelain=v1", "--untracked-files=all"]],
			["git", ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]],
		],
	);
	for (const [, , options] of calls) {
		assert.equal(options.cwd, "/workspace");
		assert.equal(options.shell, undefined);
		assert.equal(options.env.GH_TOKEN, undefined);
	}

	for (const overrides of [
		{ branch: "" },
		{ branch: "main\nforged" },
		{ status: "?? secret.txt\n" },
		{ originMainSha: HEAD_SHA.toUpperCase() },
	]) {
		const invalid = await createAdapters({
			fetchImpl: assert.fail,
			run: commandRunner([], overrides),
		});
		await assert.rejects(
			invalid.local.readState(),
			/branch|clean|status|SHA|malformed/iu,
		);
	}
});

test("npm and attestation operations delegate through owned narrow wrappers", async () => {
	const npmResult = {
		status: "ABSENT",
		operation: "package-version",
		httpStatus: 404,
		code: "E404",
	};
	const attestationResult = {
		status: "VERIFIED",
		subjects: [{ name: "manifest.json", sha256: "a".repeat(64) }],
	};
	const calls = [];
	const adapters = await createDuplicateDraftConsolidationAdapters({
		cwd: "/workspace",
		token: TOKEN,
		dependencies: {
			fetchImpl: assert.fail,
			run: commandRunner([]),
			createNpmReader() {
				return {
					async observePackageVersion(input) {
						calls.push(["npm", input]);
						return npmResult;
					},
				};
			},
			createCliAttestationVerifier() {
				return {
					async verify(input) {
						calls.push(["attestations", input]);
						return attestationResult;
					},
				};
			},
		},
	});
	const npmInput = { name: "@dawn-ai/sdk", version: "0.8.22" };
	const attestationInput = {
		source: "escrow",
		record: {},
		subjects: [],
		files: [],
		bundles: [],
	};
	const observedNpm = await adapters.npm.observePackageVersion(npmInput);
	const observedAttestations =
		await adapters.attestations.verify(attestationInput);
	assert.deepEqual(observedNpm, npmResult);
	assert.deepEqual(observedAttestations, attestationResult);
	assert.notEqual(observedNpm, npmResult);
	assert.notEqual(observedAttestations, attestationResult);
	assert.equal(deeplyFrozen(observedNpm), true);
	assert.equal(deeplyFrozen(observedAttestations), true);
	assert.deepEqual(calls, [
		["npm", npmInput],
		["attestations", attestationInput],
	]);
	assert.deepEqual(Object.keys(adapters.npm), ["observePackageVersion"]);
	assert.deepEqual(Object.keys(adapters.attestations), ["verify"]);
});

test("delegated npm and attestation results reject hostile mutable evidence", async () => {
	let invoked = 0;
	const npmAccessor = {};
	Object.defineProperty(npmAccessor, "status", {
		enumerable: true,
		get() {
			invoked += 1;
			return "ABSENT";
		},
	});
	const attestationAccessor = {};
	Object.defineProperty(attestationAccessor, "status", {
		enumerable: true,
		get() {
			invoked += 1;
			return "VERIFIED";
		},
	});
	const adapters = await createDuplicateDraftConsolidationAdapters({
		cwd: "/workspace",
		token: TOKEN,
		dependencies: {
			fetchImpl: assert.fail,
			run: commandRunner([]),
			createNpmReader: () => ({
				observePackageVersion: async () => npmAccessor,
			}),
			createCliAttestationVerifier: () => ({
				verify: async () => attestationAccessor,
			}),
		},
	});
	assert.deepEqual(await adapters.npm.observePackageVersion({}), {
		status: "ERROR",
		operation: "malformed-envelope",
		httpStatus: null,
		code: "MALFORMED_ENVELOPE",
	});
	await assert.rejects(
		adapters.attestations.verify({}),
		/attestation|evidence|malformed/iu,
	);
	assert.equal(invoked, 0);

	for (const result of [
		{ status: "VERIFIED", subjects: [], extra: true },
		{
			status: "VERIFIED",
			subjects: [{ name: "manifest.json", sha256: "A".repeat(64) }],
		},
		new Proxy({ status: "INVALID", subjects: [] }, {}),
	]) {
		const hostile = await createDuplicateDraftConsolidationAdapters({
			cwd: "/workspace",
			token: TOKEN,
			dependencies: {
				fetchImpl: assert.fail,
				run: commandRunner([]),
				createCliAttestationVerifier: () => ({ verify: async () => result }),
			},
		});
		await assert.rejects(
			hostile.attestations.verify({}),
			/attestation|evidence|malformed/iu,
		);
	}
});

test("delete boundary rejects every non-approved construction or call before fetch", async () => {
	const invalidConstructions = [
		{ repository: "cacheplane/other" },
		{ apiOrigin: "http://api.github.com" },
		{ apiOrigin: "https://evil.example" },
		{ survivorId: DUPLICATES[0] },
		{ survivorId: Number(SURVIVOR) },
		{ duplicateIds: [...DUPLICATES].reverse() },
		{ duplicateIds: [Number(DUPLICATES[0]), DUPLICATES[1]] },
		{ duplicateIds: [DUPLICATES[0], Number(DUPLICATES[1])] },
		{ duplicateIds: [DUPLICATES[0]] },
		{ duplicateIds: [...DUPLICATES, "1"] },
		{ duplicateIds: [DUPLICATES[0], DUPLICATES[0]] },
		{ duplicateIds: [DUPLICATES[0], SURVIVOR] },
		{ token: "bad\ntoken" },
	];
	for (const override of invalidConstructions) {
		const fetchCalls = [];
		assert.throws(
			() =>
				createWriter({
					...override,
					fetchImpl: (...args) => fetchCalls.push(args),
				}),
			/approved|canonical|duplicate|survivor|repository|origin|token|invalid/iu,
		);
		assert.equal(fetchCalls.length, 0);
	}

	const fetchCalls = [];
	const writer = await createGuardedWriter({
		fetchImpl: (...args) => fetchCalls.push(args),
	});
	await assert.rejects(
		() => writer.deleteDuplicate({ releaseId: "379991871" }),
		/survivor|approved duplicate|permit/iu,
	);
	assert.equal(fetchCalls.length, 0);
	for (const releaseId of [
		379982100,
		"0379982100",
		"+379982100",
		"379982100 ",
		"1",
		null,
	]) {
		await assert.rejects(
			() => writer.deleteDuplicate({ releaseId }),
			/canonical|approved|duplicate|invalid|permit/iu,
		);
		assert.equal(fetchCalls.length, 0);
	}
	await assert.rejects(
		() => writer.deleteDuplicate({ releaseId: DUPLICATES[0], extra: true }),
		/field|option|invalid/iu,
	);
	assert.equal(fetchCalls.length, 0);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() =>
			writer.deleteDuplicate({
				releaseId: DUPLICATES[0],
				signal: controller.signal,
			}),
		/abort/iu,
	);
	assert.equal(fetchCalls.length, 0);
});

test("standalone delete effects reject without a guard-minted permit before fetch", async () => {
	let fetches = 0;
	const writer = createWriter({
		fetchImpl: async () => {
			fetches += 1;
			return new Response(null, { status: 204 });
		},
	});
	await assert.rejects(
		writer.deleteDuplicate({ releaseId: DUPLICATES[0] }),
		/guard|permit|one-use/iu,
	);
	assert.equal(fetches, 0);
});

test("delete performs exactly one bodyless non-redirected DELETE and classifies actual 204", async () => {
	const calls = [];
	const writer = await createGuardedWriter({
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return { status: 204, ok: false, headers: new Headers(), body: null };
		},
	});
	assert.deepEqual(await writer.deleteDuplicate({ releaseId: DUPLICATES[0] }), {
		classification: "confirmed-204",
		httpStatus: 204,
		observedAt: NOW,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `${BASE}/releases/${DUPLICATES[0]}`);
	assert.equal(calls[0].init.method, "DELETE");
	assert.equal(calls[0].init.redirect, "manual");
	assert.equal(Object.hasOwn(calls[0].init, "body"), false);
	assert.deepEqual(calls[0].init.headers, githubHeaders());
	assert.equal(calls[0].init.signal instanceof AbortSignal, true);
});

test("delete classifies received 404 and cancels any response body", async () => {
	let cancelled = 0;
	const writer = await createGuardedWriter({
		fetchImpl: async () => ({
			status: 404,
			ok: true,
			headers: new Headers({ "content-type": "application/json" }),
			body: {
				cancel: async () => {
					cancelled += 1;
				},
			},
		}),
	});
	assert.deepEqual(await writer.deleteDuplicate({ releaseId: DUPLICATES[0] }), {
		classification: "response-404-ambiguous",
		httpStatus: 404,
		observedAt: NOW,
	});
	assert.equal(cancelled, 1);
});

test("delete cancels bodies on 204 and hard HTTP failure responses", async () => {
	for (const status of [204, 500]) {
		let cancelled = 0;
		const writer = await createGuardedWriter({
			fetchImpl: async () => ({
				status,
				headers: new Headers(),
				body: {
					cancel: async () => {
						cancelled += 1;
					},
				},
			}),
		});
		if (status === 204) {
			assert.equal(
				(await writer.deleteDuplicate({ releaseId: DUPLICATES[0] })).httpStatus,
				204,
			);
		} else {
			await assert.rejects(
				writer.deleteDuplicate({ releaseId: DUPLICATES[0] }),
				/HTTP 500/iu,
			);
		}
		assert.equal(cancelled, 1);
	}
});

test("delete fails closed when a response body cannot be boundedly canceled", async () => {
	const malformed = await createGuardedWriter({
		fetchImpl: async () => ({ status: 204, headers: new Headers(), body: {} }),
	});
	await assert.rejects(
		() => malformed.deleteDuplicate({ releaseId: DUPLICATES[0] }),
		/body|cancel|malformed|response/iu,
	);

	for (const status of [204, 404, 500]) {
		for (const cancel of [
			async () => {
				throw new Error(`${TOKEN} cancel failed`);
			},
		]) {
			const writer = await createGuardedWriter({
				fetchImpl: async () => ({
					status,
					headers: new Headers(),
					body: { cancel },
				}),
			});
			await assert.rejects(
				() => writer.deleteDuplicate({ releaseId: DUPLICATES[0] }),
				(error) =>
					/body|cancel|failed|deadline|timeout/iu.test(String(error)) &&
					!String(error).includes(TOKEN),
			);
		}
	}
});

test("delete classifies caller abort after send and transport loss as ambiguous", async () => {
	const controller = new AbortController();
	let sent = false;
	let signalSent;
	const sentPromise = new Promise((resolve) => {
		signalSent = resolve;
	});
	const aborted = await createGuardedWriter({
		fetchImpl: async (_url, init) => {
			sent = true;
			signalSent();
			return new Promise((_resolve, reject) => {
				init.signal.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});
		},
	});
	const pending = aborted.deleteDuplicate({
		releaseId: DUPLICATES[0],
		signal: controller.signal,
	});
	await sentPromise;
	assert.equal(sent, true);
	controller.abort();
	assert.equal((await pending).classification, "transport-ambiguous");

	const lost = await createGuardedWriter({
		fetchImpl: async () => {
			throw new Error(`${TOKEN} socket lost`);
		},
	});
	const outcome = await lost.deleteDuplicate({ releaseId: DUPLICATES[0] });
	assert.deepEqual(outcome, {
		classification: "transport-ambiguous",
		httpStatus: null,
		observedAt: NOW,
	});
	assert.equal(JSON.stringify(outcome).includes(TOKEN), false);
});

test("delete fails closed on explicit HTTP failures, redirects, and malformed responses", async () => {
	for (const response of [
		{ status: 403, ok: false, headers: new Headers(), body: null },
		{ status: 429, ok: false, headers: new Headers(), body: null },
		{ status: 500, ok: false, headers: new Headers(), body: null },
		{
			status: 302,
			ok: false,
			headers: new Headers({ location: `${BASE}/releases/1` }),
			body: null,
		},
		{ status: "204", ok: true, headers: new Headers(), body: null },
		null,
	]) {
		const writer = await createGuardedWriter({
			fetchImpl: async () => response,
		});
		await assert.rejects(
			() => writer.deleteDuplicate({ releaseId: DUPLICATES[0] }),
			/HTTP|response|malformed|redirect|failed/iu,
		);
	}
});

test("delete outcomes require a canonical clock value", async () => {
	for (const now of [
		() => "2026-09-01T12:34:56Z",
		() => "invalid",
		() => 0,
		() => {
			throw new Error(TOKEN);
		},
	]) {
		let fetchCalls = 0;
		const writer = await createGuardedWriter({
			fetchImpl: async () => {
				fetchCalls += 1;
				return { status: 204, headers: new Headers(), body: null };
			},
			now,
		});
		await assert.rejects(
			() => writer.deleteDuplicate({ releaseId: DUPLICATES[0] }),
			(error) => !String(error).includes(TOKEN),
		);
		assert.equal(fetchCalls, 0);
	}
});

test("delete rechecks authority and prevalidates outcome time immediately before send", async () => {
	let clockCalls = 0;
	let fetchCalls = 0;
	const writer = await createGuardedWriter({
		now: () => {
			clockCalls += 1;
			if (clockCalls > 3) throw new Error("clock must not run after send");
			return NOW;
		},
		fetchImpl: async () => {
			fetchCalls += 1;
			assert.equal(clockCalls, 3);
			return { status: 204, headers: new Headers(), body: null };
		},
	});

	assert.deepEqual(await writer.deleteDuplicate({ releaseId: DUPLICATES[0] }), {
		classification: "confirmed-204",
		httpStatus: 204,
		observedAt: NOW,
	});
	assert.equal(fetchCalls, 1);
	assert.equal(clockCalls, 3);
});

test("composition and delete writer are deeply frozen owned capability sets", async () => {
	const adapters = await createAdapters({
		fetchImpl: assert.fail,
		run: commandRunner([]),
	});
	assert.equal(deeplyFrozen(adapters), true);
	assert.equal(deeplyFrozen(adapters.writer), true);
	assert.deepEqual(Object.keys(adapters.writer), ["deleteDuplicate"]);
	assert.deepEqual(Object.keys(adapters.github).sort(), [
		"downloadReleaseAsset",
		"getAnnotatedTag",
		"getAuthenticatedUser",
		"getDefaultBranchSha",
		"getRelease",
		"getRepository",
		"getWorkflowState",
		"listNonterminalWorkflowRuns",
		"listReleaseAssets",
		"listReleases",
	]);
	assert.equal(JSON.stringify(adapters).includes(TOKEN), false);
	assert.equal(JSON.stringify(adapters).includes("function"), false);
});

function createAdapters(options = {}) {
	const {
		environment = { HOME: "/home/release", PATH: "/tools" },
		fetchImpl,
		run,
		now = () => NOW,
	} = options;
	return createDuplicateDraftConsolidationAdapters({
		cwd: "/workspace",
		...(Object.hasOwn(options, "token")
			? options.token === undefined
				? {}
				: { token: options.token }
			: { token: TOKEN }),
		environment,
		dependencies: {
			fetchImpl,
			run,
			now,
		},
	});
}

function createWriter(overrides = {}) {
	return createExactDuplicateDeleteEffect({
		repository: REPOSITORY,
		apiOrigin: API_ORIGIN,
		survivorId: SURVIVOR,
		duplicateIds: DUPLICATES,
		token: TOKEN,
		fetchImpl: async () => ({
			status: 204,
			headers: new Headers(),
			body: null,
		}),
		timeoutMs: 100,
		now: () => NOW,
		...overrides,
	});
}

function createTerminalAdapters({
	fetchImpl = assert.fail,
	getRelease = async () => present("release", {}),
	listReleaseAssets = async () => present("release-assets", []),
} = {}) {
	return createDuplicateDraftConsolidationAdapters({
		cwd: "/workspace",
		token: TOKEN,
		environment: { HOME: "/home/release", PATH: "/tools" },
		dependencies: {
			fetchImpl,
			run: commandRunner([]),
			now: () => NOW,
			createGitHubReader: () => ({
				...githubBoundary(),
				getRelease,
				listReleaseAssets,
			}),
		},
	});
}

async function createGuardedWriter(overrides = {}) {
	const fetchImpl =
		overrides.fetchImpl ?? (async () => new Response(null, { status: 204 }));
	const now = overrides.now ?? (() => NOW);
	return Object.freeze({
		async deleteDuplicate(input) {
			const harness = await createAuthorizedDeleteHarness({
				fetchImpl,
				deleteNow: now,
			});
			TEMPORARY_ROOTS.push(harness.root);
			return harness.adapters.writer.deleteDuplicate({
				...input,
				permit: harness.permit,
			});
		},
	});
}

function workflowQuery() {
	return Object.freeze({
		statuses: Object.freeze([
			"in_progress",
			"pending",
			"queued",
			"requested",
			"waiting",
		]),
		perPage: 100,
		maximumPages: 100,
	});
}

function githubBoundary() {
	return {
		getRef: async () => present("ref", {}),
		getGitTag: async () => present("git-tag", {}),
		getWorkflow: async () => present("workflow", {}),
		listReleases: async () => present("releases", []),
		getRelease: async () => present("release", {}),
		listReleaseAssets: async () => present("release-assets", []),
		downloadReleaseAsset: async () => ({
			status: "PRESENT",
			operation: "release-asset-download",
			httpStatus: 200,
			code: null,
			contentBase64: "",
		}),
	};
}

function present(operation, value) {
	return { status: "PRESENT", operation, httpStatus: 200, code: null, value };
}

function commandRunner(calls, overrides = {}) {
	return async (command, args, options) => {
		if (command === "gh" && args[0] === "auth") {
			const token = overrides.authToken ?? TOKEN;
			calls.push([command, args, options]);
			return { exitCode: 0, stdout: `${token}\n`, stderr: "" };
		}
		calls.push([command, args, options]);
		if (args[0] === "rev-parse" && args.at(-1).startsWith("HEAD")) {
			return {
				exitCode: 0,
				stdout: `${overrides.headSha ?? HEAD_SHA}\n`,
				stderr: "",
			};
		}
		if (args[0] === "symbolic-ref") {
			return {
				exitCode: 0,
				stdout: `${overrides.branch ?? "main"}\n`,
				stderr: "",
			};
		}
		if (args[0] === "status") {
			return { exitCode: 0, stdout: overrides.status ?? "", stderr: "" };
		}
		if (
			args[0] === "rev-parse" &&
			args.at(-1).startsWith("refs/remotes/origin/main")
		) {
			return {
				exitCode: 0,
				stdout: `${overrides.originMainSha ?? HEAD_SHA}\n`,
				stderr: "",
			};
		}
		throw new Error(`Unexpected command ${command}`);
	};
}

function recordingFetch(responses) {
	const calls = [];
	let index = 0;
	return {
		calls,
		async fetchImpl(url, init) {
			calls.push({ url, init });
			const response = responses[index];
			index += 1;
			if (response === undefined) throw new Error(`Unexpected fetch ${url}`);
			return response;
		},
	};
}

function jsonResponse(value, status = 200, headers = {}) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function binaryResponse(value, status = 200) {
	return new Response(value, {
		status,
		headers: { "content-type": "application/octet-stream" },
	});
}

function redirectResponse(location) {
	return new Response(null, { status: 302, headers: { location } });
}

function githubHeaders() {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${TOKEN}`,
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": USER_AGENT,
	};
}

function workflowRun(id = 41) {
	return {
		id,
		run_attempt: 2,
		status: "queued",
		event: "workflow_dispatch",
		head_sha: HEAD_SHA,
		head_branch: "main",
	};
}

function normalizedWorkflowRun(id = "41") {
	return {
		id,
		runAttempt: 2,
		status: "queued",
		event: "workflow_dispatch",
		headSha: HEAD_SHA,
		headBranch: "main",
	};
}

function deeplyFrozen(value, seen = new Set()) {
	if (
		(typeof value !== "object" && typeof value !== "function") ||
		value === null ||
		seen.has(value)
	) {
		return true;
	}
	seen.add(value);
	if (!Object.isFrozen(value)) return false;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			descriptor !== undefined &&
			"value" in descriptor &&
			!deeplyFrozen(descriptor.value, seen)
		) {
			return false;
		}
	}
	return true;
}
