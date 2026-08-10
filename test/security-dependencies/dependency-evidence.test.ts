import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
	collectAuditEvidence,
	createBaselineReceipt,
	formatUtcSeconds,
	loadAuditExpectation,
	normalizeAuditDocument,
	parseDependencyEvidenceArguments,
	runDependencyEvidenceCli,
	validateAuditExpectation,
} from "../../scripts/security/dependency-evidence.mjs";
import { canonicalJsonBytes } from "../../scripts/security/github-evidence.mjs";
import { INVENTORY_PACKAGES } from "../../scripts/security/publication-containment.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, "../..");
const baselinePath = resolve(testDir, "fixtures/audit-baseline.json");
const providerOnlyPath = resolve(
	testDir,
	"fixtures/audit-provider-utils-only.json",
);

describe("audit expectation fixtures", () => {
	it("binds the exact reviewed full and production multisets", async () => {
		const expectation = await loadAuditExpectation(baselinePath, {
			root: repositoryRoot,
		});
		expect(expectation.full.records).toHaveLength(30);
		expect(expectation.production.records).toHaveLength(27);
		expect(expectation.full.muted).toEqual([]);
		expect(expectation.production.muted).toEqual([]);
		expect(countSeverity(expectation.full.records)).toEqual({
			critical: 0,
			high: 13,
			info: 0,
			low: 5,
			moderate: 12,
		});
		expect(countSeverity(expectation.production.records)).toEqual({
			critical: 0,
			high: 10,
			info: 0,
			low: 5,
			moderate: 12,
		});
	});

	it("pins the after-state to provider-utils only in both modes", async () => {
		const expectation = await loadAuditExpectation(providerOnlyPath, {
			root: repositoryRoot,
		});
		expect(expectation.full).toEqual(expectation.production);
		expect(expectation.full.records).toEqual([
			{
				ghsa: "GHSA-866g-f22w-33x8",
				package: "@ai-sdk/provider-utils",
				severity: "low",
				version: "3.0.28",
			},
		]);
	});

	it.each([
		{},
		{ schemaVersion: 1, full: { muted: [], records: [] } },
		{
			schemaVersion: 1,
			full: { records: [] },
			production: { muted: [], records: [] },
		},
		{
			schemaVersion: 1,
			full: { muted: [{ reason: "ignored" }], records: [] },
			production: { muted: [], records: [] },
		},
		{
			schemaVersion: 1,
			full: {
				muted: [],
				records: [
					{
						ghsa: "GHSA-2345-6789-cfgh",
						package: "x",
						severity: "high",
						version: "1",
					},
					{
						ghsa: "GHSA-2345-6789-cfgh",
						package: "x",
						severity: "high",
						version: "1",
					},
				],
			},
			production: { muted: [], records: [] },
		},
	])("rejects malformed, muted, or duplicate fixture %#", (value) => {
		expect(() => validateAuditExpectation(value)).toThrow(/UNPROVABLE/u);
	});

	it("rejects a fixture path outside the repository and a symlink", async ({
		task,
	}) => {
		await expect(
			loadAuditExpectation("/tmp/outside.json", { root: repositoryRoot }),
		).rejects.toThrow(/UNPROVABLE/u);
		const link = resolve(testDir, `fixtures/${task.id}.json`);
		await symlink(providerOnlyPath, link);
		try {
			await expect(
				loadAuditExpectation(link, { root: repositoryRoot }),
			).rejects.toThrow(/UNPROVABLE/u);
		} finally {
			await import("node:fs/promises").then(({ unlink }) => unlink(link));
		}
	});
});

describe("dependency audit normalization", () => {
	it("normalizes an exact finding exit into a redacted identity receipt", () => {
		const expectation = mode([
			{
				ghsa: "GHSA-2345-6789-cfgh",
				package: "example",
				severity: "high",
				version: "1.2.3",
			},
		]);
		expect(
			normalizeAuditDocument(auditDocument(expectation), expectation, 1),
		).toEqual({
			exitCode: 1,
			muted: [],
			records: expectation.records,
			severityTotals: { critical: 0, high: 1, info: 0, low: 0, moderate: 0 },
			status: "findings",
		});
	});

	it("accepts exit zero only for an exact empty mode", () => {
		const expectation = mode([]);
		expect(
			normalizeAuditDocument(auditDocument(expectation), expectation, 0).status,
		).toBe("clean");
		expect(() =>
			normalizeAuditDocument(auditDocument(expectation), expectation, 1),
		).toThrow(/UNPROVABLE: AUDIT_EXIT_MISMATCH/u);
	});

	it.each([
		["exit 0 with findings", (doc: any) => doc, 0],
		["exit 2", (doc: any) => doc, 2],
		["error envelope", (doc: any) => ({ ...doc, error: { code: "ERR" } }), 1],
		["missing muted", (doc: any) => without(doc, "muted"), 1],
		["nonempty muted", (doc: any) => ({ ...doc, muted: [{ id: 1 }] }), 1],
		[
			"missing GHSA",
			(doc: any) => {
				const changed = structuredClone(doc);
				delete changed.advisories["1"].github_advisory_id;
				return changed;
			},
			1,
		],
		[
			"missing version",
			(doc: any) => {
				const changed = structuredClone(doc);
				delete changed.advisories["1"].findings[0].version;
				return changed;
			},
			1,
		],
		[
			"duplicate identity",
			(doc: any) => ({
				...doc,
				advisories: {
					...doc.advisories,
					"2": structuredClone(doc.advisories["1"]),
				},
				metadata: {
					vulnerabilities: {
						critical: 0,
						high: 2,
						info: 0,
						low: 0,
						moderate: 0,
					},
				},
			}),
			1,
		],
		[
			"contradictory totals",
			(doc: any) => ({
				...doc,
				metadata: {
					vulnerabilities: {
						critical: 0,
						high: 0,
						info: 0,
						low: 1,
						moderate: 0,
					},
				},
			}),
			1,
		],
		[
			"reported severity drift",
			(doc: any) => ({
				...doc,
				advisories: {
					"1": { ...doc.advisories["1"], severity: "moderate" },
				},
				metadata: {
					vulnerabilities: {
						critical: 0,
						high: 0,
						info: 0,
						low: 0,
						moderate: 1,
					},
				},
			}),
			1,
		],
	])("rejects %s", (_name, mutate, exitCode) => {
		const expectation = mode([
			{
				ghsa: "GHSA-2345-6789-cfgh",
				package: "example",
				severity: "high",
				version: "1.2.3",
			},
		]);
		expect(() =>
			normalizeAuditDocument(
				mutate(auditDocument(expectation)),
				expectation,
				exitCode,
			),
		).toThrow(/UNPROVABLE/u);
	});
});

describe("fixed audit subprocess contract", () => {
	it.each([
		["NaN", () => Number.NaN],
		["unsafe deadline", () => Number.MAX_SAFE_INTEGER],
		[
			"throwing clock",
			() => {
				throw new Error("clock secret");
			},
		],
	])(
		"rejects an invalid %s clock before starting a subprocess",
		async (_name, now) => {
			let calls = 0;
			await expect(
				collectAuditEvidence({
					expectation: validateAuditExpectation({
						full: mode([]),
						production: mode([]),
						schemaVersion: 1,
					}),
					now,
					runProcess: async () => {
						calls += 1;
						return cleanAuditProcessResult();
					},
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_CLOCK/u);
			expect(calls).toBe(0);
		},
	);

	it.each([0, 64 * 1024 * 1024 + 1, 1.5, Number.NaN])(
		"rejects invalid audit byte cap %s before starting a subprocess",
		async (maxBytes) => {
			let calls = 0;
			await expect(
				collectAuditEvidence({
					expectation: validateAuditExpectation({
						full: mode([]),
						production: mode([]),
						schemaVersion: 1,
					}),
					maxBytes,
					runProcess: async () => {
						calls += 1;
						return cleanAuditProcessResult();
					},
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_AUDIT_BYTES/u);
			expect(calls).toBe(0);
		},
	);

	it("rejects a backwards clock after full audit without starting production", async () => {
		const samples = [100, 100, 99];
		let calls = 0;
		await expect(
			collectAuditEvidence({
				expectation: validateAuditExpectation({
					full: mode([]),
					production: mode([]),
					schemaVersion: 1,
				}),
				now: () => samples.shift(),
				runProcess: async () => {
					calls += 1;
					return cleanAuditProcessResult();
				},
				timeoutMs: 100,
			}),
		).rejects.toThrow(/UNPROVABLE: INVALID_CLOCK/u);
		expect(calls).toBe(1);
	});

	it.each([
		["full", [0, 0, 100], 1],
		["production", [0, 0, 1, 1, 100], 2],
	])(
		"rejects %s returning at the exact deadline and performs no later I/O",
		async (_mode, samples, expectedCalls) => {
			let calls = 0;
			await expect(
				collectAuditEvidence({
					expectation: validateAuditExpectation({
						full: mode([]),
						production: mode([]),
						schemaVersion: 1,
					}),
					now: () => samples.shift(),
					runProcess: async () => {
						calls += 1;
						return cleanAuditProcessResult();
					},
					timeoutMs: 100,
				}),
			).rejects.toThrow(/UNPROVABLE: AUDIT_TIMEOUT/u);
			expect(calls).toBe(expectedCalls);
		},
	);

	it("uses exact full/production argv under one deadline", async () => {
		const expectation = validateAuditExpectation({
			schemaVersion: 1,
			full: mode([]),
			production: mode([]),
		});
		const observed: unknown[] = [];
		let clock = 100;
		const result = await collectAuditEvidence({
			cwd: repositoryRoot,
			expectation,
			maxBytes: 4096,
			now: () => clock,
			runProcess: async (request: unknown) => {
				observed.push(request);
				clock += 25;
				return {
					exitCode: 0,
					stderr: "",
					stdout: JSON.stringify(auditDocument(mode([]))),
				};
			},
			timeoutMs: 100,
		});
		expect(observed).toEqual([
			{
				args: ["audit", "--json"],
				command: "pnpm",
				cwd: repositoryRoot,
				env: expect.any(Object),
				maxBytes: 4096,
				timeoutMs: 100,
			},
			{
				args: ["audit", "--json", "--prod"],
				command: "pnpm",
				cwd: repositoryRoot,
				env: expect.any(Object),
				maxBytes: 4096,
				timeoutMs: 75,
			},
		]);
		expect(result.full.status).toBe("clean");
		expect(result.production.status).toBe("clean");
		for (const request of observed as Array<{ env: Record<string, string> }>) {
			expect(request.env.GH_TOKEN).toBeUndefined();
			expect(request.env.GITHUB_TOKEN).toBeUndefined();
			expect(request.env.NPM_TOKEN).toBeUndefined();
			expect(request.env.NODE_AUTH_TOKEN).toBeUndefined();
		}
	});

	it("rejects malformed JSON and a shared-deadline boundary", async () => {
		const expectation = validateAuditExpectation({
			schemaVersion: 1,
			full: mode([]),
			production: mode([]),
		});
		await expect(
			collectAuditEvidence({
				cwd: repositoryRoot,
				expectation,
				runProcess: async () => ({
					exitCode: 0,
					stderr: "npm_token_secret",
					stdout: "{",
				}),
			}),
		).rejects.toThrow(/UNPROVABLE: MALFORMED_AUDIT_JSON/u);

		let calls = 0;
		await expect(
			collectAuditEvidence({
				cwd: repositoryRoot,
				expectation,
				now: () => (calls++ === 0 ? 0 : 100),
				runProcess: async () => ({
					exitCode: 0,
					stderr: "",
					stdout: JSON.stringify(auditDocument(mode([]))),
				}),
				timeoutMs: 100,
			}),
		).rejects.toThrow(/UNPROVABLE: AUDIT_TIMEOUT/u);
	});

	it("keeps the checked-in fixture parseable as ordinary JSON", async () => {
		await expect(
			readFile(baselinePath, "utf8").then(JSON.parse),
		).resolves.toBeTruthy();
	});
});

describe("dependency evidence CLI", () => {
	it("formats live clock samples as canonical UTC seconds and rejects out-of-range dates", () => {
		expect(formatUtcSeconds(Date.parse("2026-08-10T18:00:00Z") + 347)).toBe(
			"2026-08-10T18:00:00Z",
		);
		expect(() => formatUtcSeconds(Number.MAX_SAFE_INTEGER)).toThrow(
			/UNPROVABLE: INVALID_CLOCK/u,
		);
	});

	it("assembles a canonical baseline only from matching provenance and exact identities", async () => {
		const fixture = await import(
			"../../scripts/security/dependabot-reconcile.mjs"
		).then(({ loadDependabotExpectation }) =>
			loadDependabotExpectation(
				resolve(testDir, "fixtures/dependabot-baseline.json"),
				{ root: repositoryRoot },
			),
		);
		const sourceSha = "a".repeat(40);
		const receipt = createBaselineReceipt({
			capturedAt: "2026-08-10T18:00:00Z",
			expectedDefaultSha: fixture.defaultSha,
			fixture,
			open: fixture.open,
			publication: publicationReceiptFixture(fixture.defaultSha, sourceSha),
			repository: "cacheplane/dawnai",
			sourceSha,
		});
		expect(receipt.dependabot.open).toHaveLength(27);
		expect(receipt.publication.npm.requestCount).toBe(63);

		const wrongFixture = structuredClone(fixture);
		wrongFixture.defaultSha = "b".repeat(40);
		expect(() =>
			createBaselineReceipt({
				capturedAt: "2026-08-10T18:00:00Z",
				expectedDefaultSha: fixture.defaultSha,
				fixture: wrongFixture,
				open: fixture.open,
				publication: publicationReceiptFixture(fixture.defaultSha, sourceSha),
				repository: "cacheplane/dawnai",
				sourceSha,
			}),
		).toThrow(/UNPROVABLE/u);
	});

	it.each<[string, string[]]>([
		["audit", ["--expected", "expected.json", "--output", "audit.json"]],
		[
			"baseline",
			[
				"--repo",
				"cacheplane/dawnai",
				"--inventory-ref",
				"HEAD",
				"--source-sha",
				"a".repeat(40),
				"--expected-default-sha",
				"b".repeat(40),
				"--current-version",
				"0.8.21",
				"--target-version",
				"0.8.22",
				"--expected-identities",
				"dependabot.json",
				"--expected-open",
				"1,2",
				"--output",
				"baseline.json",
			],
		],
		[
			"reconcile",
			[
				"--repo",
				"cacheplane/dawnai",
				"--pr",
				"42",
				"--reviewed-base-sha",
				"a".repeat(40),
				"--reviewed-head-sha",
				"b".repeat(40),
				"--merge-sha",
				"c".repeat(40),
				"--observation-head-sha",
				"c".repeat(40),
				"--inventory-ref",
				"HEAD",
				"--current-version",
				"0.8.21",
				"--target-version",
				"0.8.22",
				"--expected-identities",
				"dependabot.json",
				"--expected-fixed",
				"2",
				"--expected-open",
				"1",
				"--baseline-receipt",
				"baseline.json",
				"--audit-expectation",
				"audit-expectation.json",
				"--audit-receipt",
				"audit.json",
				"--wait-timeout-ms",
				"900000",
				"--poll-interval-ms",
				"15000",
				"--max-attempts",
				"61",
				"--output",
				"reconciliation.json",
			],
		],
		[
			"seal-receipt",
			[
				"--expected-main-sha",
				"a".repeat(40),
				"--expected-pr-number",
				"42",
				"--expected-reviewed-base-sha",
				"b".repeat(40),
				"--expected-reviewed-head-sha",
				"c".repeat(40),
				"--expected-merge-sha",
				"d".repeat(40),
				"--receipt-base64",
				"e30K",
				"--receipt-sha256",
				"e".repeat(64),
				"--output-root",
				"/tmp",
				"--output-directory",
				"/tmp/sealed",
			],
		],
	])("accepts only the exact %s flag set", (operation, flags) => {
		expect(parseDependencyEvidenceArguments([operation, ...flags])).toEqual({
			operation,
			options: Object.fromEntries(
				Array.from({ length: flags.length / 2 }, (_, index) => [
					flags[index * 2]?.slice(2),
					flags[index * 2 + 1],
				]),
			),
		});
	});

	it.each<{ argv: string[] }>([
		{ argv: [] },
		{ argv: ["audit", "--expected", "expected.json"] },
		{ argv: ["audit", "--expected", "a", "--expected", "b"] },
		{ argv: ["audit", "--expected", "a", "--output", "b", "--extra", "c"] },
		{ argv: ["audit", "expected.json", "--output", "b"] },
	])("rejects malformed or ambiguous argv %#", ({ argv }) => {
		expect(() => parseDependencyEvidenceArguments(argv)).toThrow(/UNPROVABLE/u);
	});

	it("writes one canonical audit receipt and prints only a bounded summary", async () => {
		const outputRoot = await mkdtemp(resolve(tmpdir(), "dawn-audit-cli-"));
		try {
			const output = resolve(outputRoot, "audit.json");
			const expectation = await loadAuditExpectation(baselinePath, {
				root: repositoryRoot,
			});
			const stdout: string[] = [];
			let calls = 0;
			await runDependencyEvidenceCli({
				argv: ["audit", "--expected", baselinePath, "--output", output],
				cwd: repositoryRoot,
				runProcess: async () => {
					const modeExpectation =
						calls++ === 0 ? expectation.full : expectation.production;
					return {
						exitCode: 1,
						stderr: "npm_token_secret",
						stdout: JSON.stringify(auditDocument(modeExpectation)),
					};
				},
				writeStdout: (value: string) => stdout.push(value),
			});

			const bytes = await readFile(output);
			expect(bytes.at(-1)).toBe(0x0a);
			const receipt = JSON.parse(bytes.toString("utf8"));
			expect(receipt.full.records).toHaveLength(30);
			expect(receipt.production.records).toHaveLength(27);
			expect(stdout.join("")).toMatch(/audit receipt .*full=30 production=27/u);
			expect(stdout.join("")).not.toContain("GHSA-");
			expect(stdout.join("")).not.toContain("npm_token_secret");
		} finally {
			await rm(outputRoot, { force: true, recursive: true });
		}
	});

	it("writes exclusively through a symlinked parent to its canonical directory", async () => {
		const outputRoot = await mkdtemp(
			resolve(tmpdir(), "dawn-audit-symlink-parent-"),
		);
		try {
			const canonicalParent = resolve(outputRoot, "canonical");
			const requestedParent = resolve(outputRoot, "requested");
			await mkdir(canonicalParent, { mode: 0o700 });
			await symlink(canonicalParent, requestedParent);
			const expectation = await loadAuditExpectation(providerOnlyPath, {
				root: repositoryRoot,
			});
			let calls = 0;
			const result = await runDependencyEvidenceCli({
				argv: [
					"audit",
					"--expected",
					providerOnlyPath,
					"--output",
					resolve(requestedParent, "audit.json"),
				],
				cwd: repositoryRoot,
				runProcess: async () => ({
					exitCode: 1,
					stderr: "",
					stdout: JSON.stringify(
						auditDocument(
							calls++ === 0 ? expectation.full : expectation.production,
						),
					),
				}),
				writeStdout: () => {},
			});

			expect(result.output).toBe(
				resolve(await realpath(canonicalParent), "audit.json"),
			);
			await expect(
				readFile(result.output, "utf8").then(JSON.parse),
			).resolves.toMatchObject({
				kind: "pnpm-audit",
				schemaVersion: 1,
			});
		} finally {
			await rm(outputRoot, { force: true, recursive: true });
		}
	});

	it("dispatches reconcile with exact typed identities and bounded file bytes", async () => {
		const temporary = await mkdtemp(
			resolve(testDir, ".dependency-reconcile-cli-"),
		);
		try {
			const dependabotFixture = resolve(
				testDir,
				"fixtures/dependabot-baseline.json",
			);
			const auditExpectation = providerOnlyPath;
			const baselineReceipt = resolve(temporary, "baseline.json");
			const auditReceipt = resolve(temporary, "audit.json");
			const output = resolve(temporary, "reconciliation.json");
			await writeFile(baselineReceipt, '{"baseline":true}\n');
			await writeFile(auditReceipt, '{"audit":true}\n');
			const reviewedBaseSha = "d42774ecbc4295e9135ba74e8aab7520c3edd7d2";
			const reviewedHeadSha = "b".repeat(40);
			const mergeSha = "c".repeat(40);
			const observationHeadSha = "d".repeat(40);
			let request: any;
			const stdout: string[] = [];
			const receipt = {
				dependabot: { fixed: [{ number: 2 }], open: [{ number: 1 }] },
				kind: "dependency-security-reconciliation",
				schemaVersion: 1,
			};

			const result = await runDependencyEvidenceCli({
				argv: [
					"reconcile",
					"--repo",
					"cacheplane/dawnai",
					"--pr",
					"42",
					"--reviewed-base-sha",
					reviewedBaseSha,
					"--reviewed-head-sha",
					reviewedHeadSha,
					"--merge-sha",
					mergeSha,
					"--observation-head-sha",
					observationHeadSha,
					"--inventory-ref",
					"HEAD",
					"--current-version",
					"0.8.21",
					"--target-version",
					"0.8.22",
					"--expected-identities",
					dependabotFixture,
					"--expected-fixed",
					"2",
					"--expected-open",
					"1",
					"--baseline-receipt",
					baselineReceipt,
					"--audit-expectation",
					auditExpectation,
					"--audit-receipt",
					auditReceipt,
					"--wait-timeout-ms",
					"900000",
					"--poll-interval-ms",
					"15000",
					"--max-attempts",
					"61",
					"--output",
					output,
				],
				cwd: repositoryRoot,
				gitProcess: async () => ({
					exitCode: 0,
					stderr: "",
					stdout: `${observationHeadSha}\n`,
				}),
				githubTransport: async () => {
					throw new Error("transport must remain lazy");
				},
				now: () => Date.parse("2026-08-10T18:01:00Z"),
				reconcile: async (value: unknown) => {
					request = value;
					return receipt;
				},
				writeStdout: (value: string) => stdout.push(value),
			});

			expect(request).toMatchObject({
				expectedFixedNumbers: [2],
				expectedMergeSha: mergeSha,
				expectedObservationHeadSha: observationHeadSha,
				expectedOpenNumbers: [1],
				expectedReviewedBaseSha: reviewedBaseSha,
				expectedReviewedHeadSha: reviewedHeadSha,
				intervalMs: 15_000,
				maxAttempts: 61,
				prNumber: 42,
				repo: "cacheplane/dawnai",
				timeoutMs: 900_000,
			});
			expect(request.auditExpectationFixtureBytes).toEqual(
				await readFile(auditExpectation),
			);
			expect(request.auditReceiptBytes).toEqual(await readFile(auditReceipt));
			expect(request.baselineReceiptBytes).toEqual(
				await readFile(baselineReceipt),
			);
			expect(request.dependabotIdentitiesFixtureBytes).toEqual(
				await readFile(dependabotFixture),
			);
			expect(typeof request.github.object).toBe("function");
			expect(typeof request.github.list).toBe("function");
			expect(typeof request.collectPublication).toBe("function");
			expect(result).toEqual({ output: await realpath(output), receipt });
			expect(JSON.parse(await readFile(output, "utf8"))).toEqual(receipt);
			expect(stdout.join("")).toMatch(
				/reconciliation receipt .*fixed=1 open=1/u,
			);
			expect(stdout.join("")).not.toContain(JSON.stringify(receipt));
		} finally {
			await rm(temporary, { force: true, recursive: true });
		}
	});

	it.each([
		["wait-timeout-ms", "899999"],
		["poll-interval-ms", "14999"],
		["max-attempts", "60"],
	])(
		"rejects a noncanonical reconcile %s before local or remote I/O",
		async (key, value) => {
			let gitCalls = 0;
			let reconcileCalls = 0;
			await expect(
				runDependencyEvidenceCli({
					argv: reconcileCliArguments({ [key]: value }),
					cwd: repositoryRoot,
					gitProcess: async () => {
						gitCalls += 1;
						return { exitCode: 0, stderr: "", stdout: `${"d".repeat(40)}\n` };
					},
					reconcile: async () => {
						reconcileCalls += 1;
						return {};
					},
					writeStdout: () => {},
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECONCILIATION_CLI_REQUEST/u);
			expect(gitCalls).toBe(0);
			expect(reconcileCalls).toBe(0);
		},
	);

	it("rejects outside, symlinked, and oversized reconciliation inputs before dispatch", async () => {
		const internal = await mkdtemp(
			resolve(testDir, ".dependency-input-boundary-"),
		);
		const external = await mkdtemp(
			resolve(tmpdir(), "dawn-dependency-input-boundary-"),
		);
		try {
			const outside = resolve(external, "baseline.json");
			const oversized = resolve(external, "audit.json");
			const symlinked = resolve(internal, "audit-expectation.json");
			await writeFile(outside, "{}\n");
			await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20));
			await symlink(providerOnlyPath, symlinked);
			let reconcileCalls = 0;
			for (const [index, override] of [
				{ "baseline-receipt": outside },
				{ "audit-expectation": symlinked },
				{ "audit-receipt": oversized },
			].entries()) {
				await expect(
					runDependencyEvidenceCli({
						argv: reconcileCliArguments({
							output: resolve(internal, `result-${index}.json`),
							...override,
						}),
						cwd: repositoryRoot,
						gitProcess: async () => ({
							exitCode: 0,
							stderr: "",
							stdout: `${"d".repeat(40)}\n`,
						}),
						reconcile: async () => {
							reconcileCalls += 1;
							return {};
						},
						writeStdout: () => {},
					}),
				).rejects.toThrow(/UNPROVABLE: INVALID_RECONCILIATION_INPUT/u);
			}
			expect(reconcileCalls).toBe(0);
		} finally {
			await rm(internal, { force: true, recursive: true });
			await rm(external, { force: true, recursive: true });
		}
	});

	it("reads an external audit receipt through a canonical symlinked parent", async () => {
		const internal = await mkdtemp(
			resolve(testDir, ".dependency-external-input-"),
		);
		const external = await mkdtemp(
			resolve(tmpdir(), "dawn-dependency-external-input-"),
		);
		try {
			const canonicalParent = resolve(external, "canonical");
			const requestedParent = resolve(external, "requested");
			await mkdir(canonicalParent, { mode: 0o700 });
			await symlink(canonicalParent, requestedParent);
			const canonicalReceipt = resolve(canonicalParent, "audit.json");
			const requestedReceipt = resolve(requestedParent, "audit.json");
			const receiptBytes = Buffer.from('{"audit":"external"}\n');
			await writeFile(canonicalReceipt, receiptBytes);
			const output = resolve(internal, "result.json");
			let observed: Buffer | undefined;
			const receipt = {
				dependabot: { fixed: [{ number: 2 }], open: [{ number: 1 }] },
				kind: "dependency-security-reconciliation",
				schemaVersion: 1,
			};
			await runDependencyEvidenceCli({
				argv: reconcileCliArguments({
					"audit-receipt": requestedReceipt,
					output,
				}),
				cwd: repositoryRoot,
				gitProcess: async () => ({
					exitCode: 0,
					stderr: "",
					stdout: `${"d".repeat(40)}\n`,
				}),
				reconcile: async (value: any) => {
					observed = value.auditReceiptBytes;
					return receipt;
				},
				writeStdout: () => {},
			});
			expect(observed).toEqual(receiptBytes);
		} finally {
			await rm(internal, { force: true, recursive: true });
			await rm(external, { force: true, recursive: true });
		}
	});

	it("seals a canonical receipt offline and logs no payload", async () => {
		const outputRoot = await mkdtemp(
			resolve(tmpdir(), "dawn-dependency-seal-cli-"),
		);
		await chmod(outputRoot, 0o700);
		try {
			const fixture = await import(
				"../../scripts/security/dependabot-reconcile.mjs"
			).then(({ loadDependabotExpectation }) =>
				loadDependabotExpectation(
					resolve(testDir, "fixtures/dependabot-baseline.json"),
					{ root: repositoryRoot },
				),
			);
			const receipt = sealableReconciliationReceipt(fixture.open);
			const receiptBytes = canonicalJsonBytes(receipt);
			const receiptSha256 = createHash("sha256")
				.update(receiptBytes)
				.digest("hex");
			const outputDirectory = resolve(outputRoot, "sealed");
			const stdout: string[] = [];
			const result = await runDependencyEvidenceCli({
				argv: [
					"seal-receipt",
					"--expected-main-sha",
					receipt.observationHead,
					"--expected-pr-number",
					String(receipt.pr.number),
					"--expected-reviewed-base-sha",
					receipt.pr.reviewedBaseSha,
					"--expected-reviewed-head-sha",
					receipt.pr.reviewedHeadSha,
					"--expected-merge-sha",
					receipt.pr.mergeSha,
					"--receipt-base64",
					receiptBytes.toString("base64"),
					"--receipt-sha256",
					receiptSha256,
					"--output-root",
					outputRoot,
					"--output-directory",
					outputDirectory,
				],
				environment: {
					GITHUB_RUN_ATTEMPT: "2",
					GITHUB_RUN_ID: "31360000000",
				},
				writeStdout: (value: string) => stdout.push(value),
			});

			expect(await readFile(result.receiptPath)).toEqual(receiptBytes);
			expect(
				JSON.parse(await readFile(result.manifestPath, "utf8")),
			).toMatchObject({
				receiptSha256,
				runAttempt: 2,
				runId: 31360000000,
			});
			expect(stdout.join("")).toContain(`digest=${receiptSha256}`);
			expect(stdout.join("")).not.toContain(receiptBytes.toString("base64"));
			expect(stdout.join("")).not.toContain("GHSA-");
		} finally {
			await rm(outputRoot, { force: true, recursive: true });
		}
	});
});

function mode(records: Array<Record<string, string>>) {
	return { muted: [], records };
}

function auditDocument(expectation: ReturnType<typeof mode>) {
	const advisories = Object.fromEntries(
		expectation.records.map((record, index) => [
			String(index + 1),
			{
				findings: [
					{ paths: [`root>${record.package}`], version: record.version },
				],
				github_advisory_id: record.ghsa,
				module_name: record.package,
				severity: record.severity,
			},
		]),
	);
	return {
		actions: [],
		advisories,
		metadata: { vulnerabilities: countSeverity(expectation.records) },
		muted: [],
	};
}

function cleanAuditProcessResult() {
	return {
		exitCode: 0,
		stderr: "",
		stdout: JSON.stringify(auditDocument(mode([]))),
	};
}

function countSeverity(records: Array<Record<string, string>>) {
	const result = { critical: 0, high: 0, info: 0, low: 0, moderate: 0 };
	for (const record of records)
		result[record.severity as keyof typeof result] += 1;
	return result;
}

function without<T extends Record<string, unknown>>(value: T, key: keyof T) {
	const copy = { ...value };
	delete copy[key];
	return copy;
}

function publicationReceiptFixture(defaultSha: string, sourceSha: string) {
	return {
		candidateAbsence: { artifacts: true, releases: true, tags: true },
		defaultSha,
		incidents: {
			chart: {
				headSha: "3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb",
				id: 31356780047,
				jobs: [
					{
						conclusion: "success",
						digest: "a".repeat(64),
						name: "publish (dawn-app)",
						noOp: true,
					},
					{
						conclusion: "success",
						digest: "b".repeat(64),
						name: "publish (dawn-sandbox-infra)",
						noOp: true,
					},
				],
				status: "completed",
			},
			release: [
				{
					conclusion: "cancelled",
					headSha: "3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb",
					id: 31356780088,
					jobs: 1,
					publishStepsSkipped: true,
					status: "completed",
					steps: 20,
				},
				{
					conclusion: "cancelled",
					headSha: "b6adaa982b25adf5fac61733a13ac65320c70bcd",
					id: 31356940801,
					jobs: 0,
					publishStepsSkipped: true,
					status: "completed",
					steps: 0,
				},
				{
					conclusion: "cancelled",
					headSha: "cfa55478cf8e35dc8a00ae7041c0c12479fda2d9",
					id: 31357014583,
					jobs: 1,
					publishStepsSkipped: true,
					status: "completed",
					steps: 0,
				},
			],
		},
		inventory: {
			currentVersion: "0.8.21",
			packages: [...INVENTORY_PACKAGES],
			ref: "HEAD",
			sourceSha,
			targetVersion: "0.8.22",
		},
		npm: {
			packages: INVENTORY_PACKAGES.map((name) => ({
				latest: "0.8.21",
				name,
				packumentName: name,
				targetAttestationAbsent: true,
				targetDocumentAbsent: true,
			})),
			requestCount: 63,
		},
		repository: "cacheplane/dawnai",
		schemaVersion: 1,
		sourceSha,
		workflows: {
			chart: {
				completeRuns: 19,
				id: 309127405,
				nonCompleted: 0,
				path: ".github/workflows/publish-chart.yml",
				retrievedRuns: 19,
				sourceShaRuns: 0,
				state: "disabled_manually",
				totalRuns: 19,
			},
			release: {
				completeRuns: 452,
				id: 260503756,
				nonCompleted: 0,
				path: ".github/workflows/release.yml",
				retrievedRuns: 452,
				sourceShaRuns: 0,
				state: "disabled_manually",
				totalRuns: 452,
			},
		},
	};
}

function reconcileCliArguments(overrides: Record<string, string> = {}) {
	const values = {
		"audit-expectation": providerOnlyPath,
		"audit-receipt": resolve(
			testDir,
			"fixtures/audit-provider-utils-only.json",
		),
		"baseline-receipt": resolve(
			testDir,
			"fixtures/audit-provider-utils-only.json",
		),
		"current-version": "0.8.21",
		"expected-fixed": "2",
		"expected-identities": resolve(
			testDir,
			"fixtures/dependabot-baseline.json",
		),
		"expected-open": "1",
		"inventory-ref": "HEAD",
		"max-attempts": "61",
		"merge-sha": "c".repeat(40),
		"observation-head-sha": "d".repeat(40),
		output: resolve(testDir, ".unused-reconciliation.json"),
		"poll-interval-ms": "15000",
		pr: "42",
		repo: "cacheplane/dawnai",
		"reviewed-base-sha": "a".repeat(40),
		"reviewed-head-sha": "b".repeat(40),
		"target-version": "0.8.22",
		"wait-timeout-ms": "900000",
		...overrides,
	};
	return [
		"reconcile",
		...Object.entries(values).flatMap(([key, item]) => [`--${key}`, item]),
	];
}

function sealableReconciliationReceipt(baselineOpen: any[]) {
	const reviewedBaseSha = "a".repeat(40);
	const reviewedHeadSha = "b".repeat(40);
	const observationHead = "c".repeat(40);
	const mergedAt = "2026-08-10T18:00:00Z";
	const fixed = structuredClone(baselineOpen[1]);
	fixed.fixedAt = mergedAt;
	fixed.state = "fixed";
	fixed.updatedAt = mergedAt;
	const open = [structuredClone(baselineOpen[0])];
	const auditRecord = {
		ghsa: "GHSA-866g-f22w-33x8",
		package: "@ai-sdk/provider-utils",
		severity: "low",
		version: "3.0.28",
	};
	const auditMode = {
		exitCode: 1,
		muted: [],
		records: [auditRecord],
		severityTotals: { critical: 0, high: 0, info: 0, low: 1, moderate: 0 },
		status: "findings",
	};
	const audit = {
		full: auditMode,
		kind: "pnpm-audit",
		production: structuredClone(auditMode),
		schemaVersion: 1,
	};
	const publication = publicationReceiptFixture(
		observationHead,
		observationHead,
	);
	const digest = (value: unknown) =>
		createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
	return {
		audit: { digest: digest(audit), evidence: audit },
		dependabot: { fixed: [fixed], open },
		digests: {
			inputs: {
				auditExpectationFixtureSha256: "d".repeat(64),
				auditReceiptSha256: digest(audit),
				baselineReceiptSha256: "e".repeat(64),
				dependabotIdentitiesFixtureSha256: "f".repeat(64),
			},
			outputs: {
				fixedAlertsSha256: digest([fixed]),
				openSnapshotASha256: digest(open),
				openSnapshotBSha256: digest(open),
				publicationAfterSha256: digest(publication),
				publicationBeforeSha256: digest(publication),
			},
		},
		kind: "dependency-security-reconciliation",
		observation: {
			completedAt: "2026-08-10T18:01:01Z",
			startedAt: "2026-08-10T18:01:00Z",
		},
		observationHead,
		pr: {
			mergeParentShas: [reviewedBaseSha, reviewedHeadSha],
			mergeSha: observationHead,
			mergedAt,
			number: 42,
			reviewedBaseSha,
			reviewedHeadSha,
		},
		publication,
		repository: "cacheplane/dawnai",
		schemaVersion: 1,
		verificationRuns: [
			".github/workflows/ci.yml",
			".github/workflows/codeql.yml",
			".github/workflows/scorecard.yml",
		].map((workflowPath, index) => ({
			conclusion: "success",
			event: "push",
			headBranch: "main",
			headSha: observationHead,
			runAttempt: 1,
			runId: 31_410_949_598 + index,
			status: "completed",
			workflowPath,
		})),
	};
}
