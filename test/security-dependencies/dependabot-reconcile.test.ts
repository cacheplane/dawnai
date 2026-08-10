import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import {
	loadDependabotExpectation,
	normalizeDependabotAlert,
	readDependabotOpen,
	reconcileDependabot,
	sealReconciliationReceipt,
	validateDependabotExpectation,
	validateReconciliationReceipt,
} from "../../scripts/security/dependabot-reconcile.mjs";
import { validateAuditExpectation } from "../../scripts/security/dependency-audit-evidence.mjs";
import {
	canonicalJsonBytes,
	createEvidenceBudget,
	createGitHubReader,
} from "../../scripts/security/github-evidence.mjs";
import { INVENTORY_PACKAGES } from "../../scripts/security/publication-containment.mjs";
import { validateReconciliationFileInputs } from "../../scripts/security/reconciliation-receipt.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, "../..");
const fixturePath = resolve(testDir, "fixtures/dependabot-baseline.json");
const execFileAsync = promisify(execFile);
const defaultSha = "3887079d400bdf019d3ff90bc89599c1899fa422";
const expectedNumbers = [
	122, 123, 124, 125, 160, 162, 163, 164, 170, 171, 172, 176, 178, 179, 180,
	181, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201,
];

const sharedSchemaMutationCorpus = [
	{
		name: "exact JSON value",
		mutateAudit: (value: any) => structuredClone(value),
		mutateDependabot: (value: any) => structuredClone(value),
	},
	{
		name: "normalizable audit ordering and invalid alert ordering",
		mutateAudit: (value: any) => {
			const changed = structuredClone(value);
			changed.full.records.reverse();
			changed.production.records.reverse();
			return changed;
		},
		mutateDependabot: (value: any) => {
			const changed = structuredClone(value);
			changed.open.reverse();
			return changed;
		},
	},
	{
		name: "unknown root field",
		mutateAudit: (value: any) => ({ ...structuredClone(value), extra: true }),
		mutateDependabot: (value: any) => ({
			...structuredClone(value),
			extra: true,
		}),
	},
	{
		name: "invalid mode or state correlation",
		mutateAudit: (value: any) => {
			const changed = structuredClone(value);
			changed.full.muted = [{ reason: "not-reviewed" }];
			return changed;
		},
		mutateDependabot: (value: any) => {
			const changed = structuredClone(value);
			changed.open[0].fixedAt = "2026-08-08T00:00:00Z";
			return changed;
		},
	},
	{
		name: "duplicate identity",
		mutateAudit: (value: any) => {
			const changed = structuredClone(value);
			changed.full.records[1] = structuredClone(changed.full.records[0]);
			return changed;
		},
		mutateDependabot: (value: any) => {
			const changed = structuredClone(value);
			changed.open[1] = structuredClone(changed.open[0]);
			return changed;
		},
	},
	{
		name: "invalid record identity",
		mutateAudit: (value: any) => {
			const changed = structuredClone(value);
			changed.production.records[0].ghsa = "CVE-2026-1";
			return changed;
		},
		mutateDependabot: (value: any) => {
			const changed = structuredClone(value);
			changed.open[0].manifest = "../pnpm-lock.yaml";
			return changed;
		},
	},
] as const;

describe("shared reconciliation input schemas", () => {
	it.each(sharedSchemaMutationCorpus)(
		"keeps collection and reconciliation schema outcomes identical for $name",
		({ mutateAudit, mutateDependabot }) => {
			const auditCandidate = mutateAudit(schemaAuditExpectation());
			const collectionAudit = schemaOutcome(() =>
				validateAuditExpectation(auditCandidate),
			);
			const auditForReceipt = collectionAudit.accepted
				? JSON.parse(collectionAudit.bytes)
				: schemaAuditExpectation();
			const auditInputs = reconciliationFileInputs(defaultSha);
			const reconciliationAudit = schemaOutcome(() => {
				const result = validateReconciliationFileInputs({
					...auditInputs,
					auditExpectationFixtureBytes: canonicalJsonBytes(auditCandidate),
					auditReceiptBytes: canonicalJsonBytes(
						auditReceiptFromExpectation(auditForReceipt),
					),
					expectedReviewedBaseSha: defaultSha,
				});
				return {
					full: { muted: [], records: result.audit.full.records },
					production: { muted: [], records: result.audit.production.records },
					schemaVersion: 1,
				};
			});
			expect(reconciliationAudit).toEqual(collectionAudit);

			const dependabotCandidate = mutateDependabot(
				schemaDependabotExpectation(),
			);
			const collectionDependabot = schemaOutcome(() =>
				validateDependabotExpectation(dependabotCandidate),
			);
			const dependabotInputs = reconciliationFileInputs(
				defaultSha,
				dependabotCandidate,
			);
			const reconciliationDependabot = schemaOutcome(
				() =>
					validateReconciliationFileInputs({
						...dependabotInputs,
						expectedReviewedBaseSha: defaultSha,
					}).dependabotIdentities,
			);
			expect(reconciliationDependabot).toEqual(collectionDependabot);
		},
	);
});

describe("Dependabot baseline identities", () => {
	it("loads the exact complete 27-alert fixture", async () => {
		const fixture = await loadDependabotExpectation(fixturePath, {
			root: repositoryRoot,
		});
		expect(fixture.defaultSha).toBe(defaultSha);
		expect(fixture.open.map((alert: any) => alert.number)).toEqual(
			expectedNumbers,
		);
		expect(
			new Set(fixture.open.map((alert: any) => alert.number)),
		).toHaveLength(27);
		expect(fixture.open.every((alert: any) => alert.dismissal === null)).toBe(
			true,
		);
	});

	it.each([
		{},
		{ schemaVersion: 1, repository: "cacheplane/dawnai", defaultSha, open: [] },
		{
			schemaVersion: 1,
			repository: "cacheplane/other",
			defaultSha,
			open: [normalizedAlert()],
		},
		{
			schemaVersion: 1,
			repository: "cacheplane/dawnai",
			defaultSha,
			open: [normalizedAlert(), normalizedAlert()],
		},
	])("rejects malformed or duplicate fixture %#", (value) => {
		expect(() => validateDependabotExpectation(value)).toThrow(/UNPROVABLE/u);
	});
});

describe("Dependabot alert normalization", () => {
	it("binds the complete stable alert identity", () => {
		expect(normalizeDependabotAlert(rawAlert())).toEqual(normalizedAlert());
	});

	it("normalizes a complete dismissal without retaining remote objects", () => {
		const alert = rawAlert();
		alert.state = "dismissed";
		alert.dismissed_at = "2026-08-08T00:00:00Z";
		alert.dismissed_by = {
			avatar_url: "https://example.invalid/avatar",
			login: "reviewer",
		};
		alert.dismissed_comment = "reviewed";
		alert.dismissed_reason = "tolerable_risk";
		expect(normalizeDependabotAlert(alert).dismissal).toEqual({
			at: "2026-08-08T00:00:00Z",
			by: "reviewer",
			comment: "reviewed",
			reason: "tolerable_risk",
		});
	});

	it.each([
		["missing package", (value: any) => delete value.dependency.package.name],
		["missing GHSA", (value: any) => delete value.security_advisory.ghsa_id],
		[
			"severity",
			(value: any) => (value.security_advisory.severity = "moderate"),
		],
		[
			"partial dismissal",
			(value: any) => (value.dismissed_at = "2026-08-08T00:00:00Z"),
		],
		["bad timestamp", (value: any) => (value.updated_at = "yesterday")],
		["missing scope", (value: any) => delete value.dependency.scope],
		[
			"unsafe manifest",
			(value: any) => (value.dependency.manifest_path = "../pnpm-lock.yaml"),
		],
	])("rejects %s identity", (_name, mutate) => {
		const alert = rawAlert();
		mutate(alert);
		expect(() => normalizeDependabotAlert(alert)).toThrow(/UNPROVABLE/u);
	});
});

describe("complete open-set reader", () => {
	it("uses cursor-only pagination and binds fixture plus expected numbers", async () => {
		const fixture = await loadDependabotExpectation(fixturePath, {
			root: repositoryRoot,
		});
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 100,
				maxRequests: 10,
			}),
			repo: "cacheplane/dawnai",
			transport: async () => jsonResponse(fixture.open.map(rawFromNormalized)),
		});
		await expect(
			readDependabotOpen({
				expectedDefaultSha: defaultSha,
				expectedNumbers,
				fixture,
				github,
			}),
		).resolves.toEqual(fixture.open);
	});

	it("rejects a fixture captured from a different default head before reading alerts", async () => {
		const fixture = await loadDependabotExpectation(fixturePath, {
			root: repositoryRoot,
		});
		let requests = 0;
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 100,
				maxRequests: 10,
			}),
			repo: "cacheplane/dawnai",
			transport: async () => {
				requests += 1;
				return jsonResponse(fixture.open.map(rawFromNormalized));
			},
		});
		await expect(
			readDependabotOpen({
				expectedDefaultSha: "0".repeat(40),
				expectedNumbers,
				fixture,
				github,
			}),
		).rejects.toThrow(/UNPROVABLE: DEPENDABOT_BASELINE_PROVENANCE_MISMATCH/u);
		expect(requests).toBe(0);
	});

	it.each([
		["open A", "openA", { fixedCalls: 0, mainCalls: 1 }],
		["the first fixed alert", "fixed", { fixedCalls: 1, mainCalls: 1 }],
		["open B", "openB", { fixedCalls: 2, mainCalls: 1 }],
	])(
		"does not start later GitHub I/O when %s returns at the deadline",
		async (_name, phase, expectedCounts) => {
			const baseSha = "a".repeat(40);
			const headSha = "b".repeat(40);
			const mergeSha = "c".repeat(40);
			const mergedAt = "2026-08-10T18:00:00Z";
			const audit = auditReceipt();
			let clock = 0;
			const boundary = reconciliationBoundaryGitHub({
				advanceDeadline: () => {
					clock = 100;
				},
				baseSha,
				headSha,
				mergeSha,
				mergedAt,
				phase,
			});
			await expect(
				reconcileDependabot({
					...reconciliationEvidenceArgs(
						baseSha,
						mergeSha,
						reconciliationFixtureWithThree(baseSha),
					),
					expectedFixedNumbers: [2, 3],
					expectedMergeSha: mergeSha,
					expectedObservationHeadSha: mergeSha,
					expectedOpenNumbers: [1],
					expectedReviewedBaseSha: baseSha,
					expectedReviewedHeadSha: headSha,
					github: boundary.github,
					intervalMs: 15,
					maxAttempts: 61,
					now: () => clock,
					prNumber: 42,
					repo: "cacheplane/dawnai",
					sleep: async () => {},
					timeoutMs: 100,
				}),
			).rejects.toThrow(/UNPROVABLE: DEPENDABOT_RECONCILIATION_TIMEOUT/u);
			expect(boundary.counts()).toEqual(expectedCounts);
		},
	);

	it.each([
		["missing", (alerts: any[]) => alerts.pop()],
		["extra", (alerts: any[]) => alerts.push(rawAlert({ number: 999 }))],
		[
			"reassigned identity",
			(alerts: any[]) =>
				([alerts[0].security_advisory, alerts[1].security_advisory] = [
					alerts[1].security_advisory,
					alerts[0].security_advisory,
				]),
		],
		[
			"severity drift",
			(alerts: any[]) => (alerts[0].security_advisory.severity = "high"),
		],
		[
			"timestamp drift",
			(alerts: any[]) => (alerts[0].updated_at = "2026-08-09T00:00:00Z"),
		],
	])("rejects %s open snapshot", async (_name, mutate) => {
		const fixture = await loadDependabotExpectation(fixturePath, {
			root: repositoryRoot,
		});
		const alerts = fixture.open.map(rawFromNormalized);
		mutate(alerts);
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 100,
				maxRequests: 10,
			}),
			repo: "cacheplane/dawnai",
			transport: async () => jsonResponse(alerts),
		});
		await expect(
			readDependabotOpen({
				expectedDefaultSha: defaultSha,
				expectedNumbers,
				fixture,
				github,
			}),
		).rejects.toThrow(/UNPROVABLE/u);
	});
});

describe("merged-head reconciliation", () => {
	const baseSha = "a".repeat(40);
	const headSha = "b".repeat(40);
	const mergeSha = "c".repeat(40);
	const observationSha = "d".repeat(40);
	const mergedAt = "2026-08-10T18:00:00Z";

	it("produces the complete bracketed canonical reconciliation receipt", async () => {
		const audit = auditReceipt();
		const fileInputs = reconciliationFileInputs(baseSha);
		let publicationReads = 0;
		let clock = Date.parse("2026-08-10T18:01:00Z") + 347;
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 20,
				maxRecords: 100,
				maxRequests: 30,
			}),
			repo: "cacheplane/dawnai",
			transport: reconcileTransport({
				baseSha,
				headSha,
				mergeSha,
				mergedAt,
				observationSha,
			}),
		});
		const receipt = await reconcileDependabot({
			...fileInputs,
			collectPublication: async () => {
				publicationReads += 1;
				return publicationSnapshot(observationSha, observationSha);
			},
			expectedFixedNumbers: [2],
			expectedMergeSha: mergeSha,
			expectedObservationHeadSha: observationSha,
			expectedOpenNumbers: [1],
			expectedReviewedBaseSha: baseSha,
			expectedReviewedHeadSha: headSha,
			github,
			intervalMs: 15,
			maxAttempts: 61,
			now: () => clock++,
			prNumber: 42,
			repo: "cacheplane/dawnai",
			sleep: async () => {},
			timeoutMs: 15 * 60_000,
		});

		expect(Object.keys(receipt).sort()).toEqual(
			[
				"audit",
				"dependabot",
				"digests",
				"kind",
				"observation",
				"observationHead",
				"pr",
				"publication",
				"repository",
				"schemaVersion",
				"verificationRuns",
			].sort(),
		);
		expect(receipt.observation).toEqual({
			completedAt: expect.any(String),
			startedAt: "2026-08-10T18:01:00Z",
		});
		expect(Date.parse(receipt.observation.completedAt)).toBeGreaterThanOrEqual(
			Date.parse(receipt.observation.startedAt),
		);
		expect(receipt.pr.mergeParentShas).toEqual([baseSha, headSha]);
		expect(receipt.verificationRuns).toHaveLength(6);
		expect(receipt.verificationRuns).toEqual(
			[...receipt.verificationRuns].sort((left: any, right: any) =>
				`${left.headSha}\0${left.workflowPath}`.localeCompare(
					`${right.headSha}\0${right.workflowPath}`,
				),
			),
		);
		expect(receipt.digests.inputs).toEqual({
			auditExpectationFixtureSha256: sha256Bytes(
				fileInputs.auditExpectationFixtureBytes,
			),
			auditReceiptSha256: sha256Bytes(fileInputs.auditReceiptBytes),
			baselineReceiptSha256: sha256Bytes(fileInputs.baselineReceiptBytes),
			dependabotIdentitiesFixtureSha256: sha256Bytes(
				fileInputs.dependabotIdentitiesFixtureBytes,
			),
		});
		expect(receipt.audit.digest).toBe(
			receipt.digests.inputs.auditReceiptSha256,
		);
		expect(receipt.digests.outputs).toEqual({
			fixedAlertsSha256: digest(receipt.dependabot.fixed),
			openSnapshotASha256: digest(receipt.dependabot.open),
			openSnapshotBSha256: digest(receipt.dependabot.open),
			publicationAfterSha256: digest(receipt.publication),
			publicationBeforeSha256: digest(receipt.publication),
		});
		expect(publicationReads).toBe(2);
		expect(validateReconciliationReceipt(receipt)).toEqual(receipt);

		const sealRoot = await mkdtemp(resolve(tmpdir(), "dawn-produced-receipt-"));
		try {
			const receiptBytes = canonicalJsonBytes(receipt);
			await expect(
				sealReconciliationReceipt({
					expectedMainSha: observationSha,
					expectedMergeSha: mergeSha,
					expectedPrNumber: 42,
					expectedRepository: "cacheplane/dawnai",
					expectedReviewedBaseSha: baseSha,
					expectedReviewedHeadSha: headSha,
					outputDirectory: resolve(sealRoot, "sealed"),
					outputRoot: sealRoot,
					receiptBase64: receiptBytes.toString("base64"),
					receiptSha256: sha256Bytes(receiptBytes),
					runAttempt: 1,
					runId: 31_500_000_000,
				}),
			).resolves.toBeTruthy();
		} finally {
			await rm(sealRoot, { force: true, recursive: true });
		}
	});

	it("does not start a second verification-run query after the first returns at deadline", async () => {
		const fileInputs = reconciliationFileInputs(baseSha);
		let clock = 0;
		let verificationRequests = 0;
		const innerTransport = reconcileTransport({
			baseSha,
			headSha,
			mergeSha,
			mergedAt,
			observationSha,
		});
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 20,
				maxRecords: 100,
				maxRequests: 30,
			}),
			repo: "cacheplane/dawnai",
			transport: async (request: any) => {
				const response = await innerTransport(request);
				if (
					decodeURIComponent(new URL(request.url).pathname).includes(
						"/actions/workflows/",
					)
				) {
					verificationRequests += 1;
					if (verificationRequests === 1) clock = 100;
				}
				return response;
			},
		});
		await expect(
			reconcileDependabot({
				...fileInputs,
				collectPublication: async () =>
					publicationSnapshot(observationSha, observationSha),
				expectedFixedNumbers: [2],
				expectedMergeSha: mergeSha,
				expectedObservationHeadSha: observationSha,
				expectedOpenNumbers: [1],
				expectedReviewedBaseSha: baseSha,
				expectedReviewedHeadSha: headSha,
				github,
				now: () => clock,
				prNumber: 42,
				repo: "cacheplane/dawnai",
				timeoutMs: 100,
			}),
		).rejects.toThrow(/UNPROVABLE: DEPENDABOT_RECONCILIATION_TIMEOUT/u);
		expect(verificationRequests).toBe(1);
	});

	it("rejects an internally inconsistent observation interval before returning a receipt", async () => {
		const futureMerge = "2026-08-10T18:02:00Z";
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 20,
				maxRecords: 100,
				maxRequests: 30,
			}),
			repo: "cacheplane/dawnai",
			transport: reconcileTransport({
				baseSha,
				headSha,
				mergeSha,
				mergedAt: futureMerge,
			}),
		});
		await expect(
			reconcileDependabot({
				...reconciliationEvidenceArgs(baseSha, mergeSha),
				expectedFixedNumbers: [2],
				expectedMergeSha: mergeSha,
				expectedObservationHeadSha: mergeSha,
				expectedOpenNumbers: [1],
				expectedReviewedBaseSha: baseSha,
				expectedReviewedHeadSha: headSha,
				github,
				now: () => Date.parse("2026-08-10T18:01:00Z"),
				prNumber: 42,
				repo: "cacheplane/dawnai",
			}),
		).rejects.toThrow(/UNPROVABLE: INVALID_RECONCILIATION_RECEIPT/u);
	});

	it("keeps the merge identity distinct from the observation head", async () => {
		const audit = auditReceipt();
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 100,
				maxRequests: 20,
			}),
			repo: "cacheplane/dawnai",
			transport: reconcileTransport({
				baseSha,
				headSha,
				mergeSha,
				mergedAt,
				observationSha,
			}),
		});
		const receipt = await reconcileDependabot({
			...reconciliationEvidenceArgs(baseSha, observationSha),
			expectedFixedNumbers: [2],
			expectedMergeSha: mergeSha,
			expectedObservationHeadSha: observationSha,
			expectedOpenNumbers: [1],
			expectedReviewedBaseSha: baseSha,
			expectedReviewedHeadSha: headSha,
			github,
			intervalMs: 15,
			maxAttempts: 61,
			now: () => Date.parse("2026-08-10T18:01:00Z"),
			prNumber: 42,
			repo: "cacheplane/dawnai",
			sleep: async () => {},
			timeoutMs: 15 * 60_000,
		});

		expect(receipt.pr.mergeSha).toBe(mergeSha);
		expect(receipt.observationHead).toBe(observationSha);
		expect(receipt.publication.defaultSha).toBe(observationSha);
		expect(receipt.publication.sourceSha).toBe(observationSha);
	});

	it.each([
		["missing", undefined],
		["malformed", "not-a-sha"],
	])(
		"rejects a %s observation head before reading GitHub",
		async (_name, candidate) => {
			const audit = auditReceipt();
			let requests = 0;
			await expect(
				reconcileDependabot({
					...reconciliationEvidenceArgs(baseSha, observationSha),
					expectedFixedNumbers: [2],
					expectedMergeSha: mergeSha,
					expectedObservationHeadSha: candidate,
					expectedOpenNumbers: [1],
					expectedReviewedBaseSha: baseSha,
					expectedReviewedHeadSha: headSha,
					github: {
						list: async () => {
							requests += 1;
							return [];
						},
						object: async () => {
							requests += 1;
							return {};
						},
					},
					prNumber: 42,
					repo: "cacheplane/dawnai",
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECONCILIATION_REQUEST/u);
			expect(requests).toBe(0);
		},
	);

	it.each([
		"all",
		"auditExpectationFixtureBytes",
		"auditReceiptBytes",
		"baselineReceiptBytes",
		"dependabotIdentitiesFixtureBytes",
		"collectPublication",
	])(
		"requires complete provenance input %s before GitHub I/O",
		async (missing) => {
			const evidence: any = reconciliationEvidenceArgs(baseSha, observationSha);
			const keys = [
				"auditExpectationFixtureBytes",
				"auditReceiptBytes",
				"baselineReceiptBytes",
				"dependabotIdentitiesFixtureBytes",
				"collectPublication",
			];
			for (const key of missing === "all" ? keys : [missing])
				delete evidence[key];
			let requests = 0;
			await expect(
				reconcileDependabot({
					...evidence,
					expectedFixedNumbers: [2],
					expectedMergeSha: mergeSha,
					expectedObservationHeadSha: observationSha,
					expectedOpenNumbers: [1],
					expectedReviewedBaseSha: baseSha,
					expectedReviewedHeadSha: headSha,
					github: {
						list: async () => {
							requests += 1;
							return [];
						},
						object: async () => {
							requests += 1;
							return {};
						},
					},
					prNumber: 42,
					repo: "cacheplane/dawnai",
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECONCILIATION_REQUEST/u);
			expect(requests).toBe(0);
		},
	);

	it.each([
		["mismatch", { observationSha: "e".repeat(40) }, "DEFAULT_HEAD_MISMATCH"],
		[
			"drift",
			{ headAfter: "e".repeat(40), observationSha },
			"DEFAULT_HEAD_DRIFT",
		],
	])("rejects observation-head %s", async (_name, transportOptions, code) => {
		const audit = auditReceipt();
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 100,
				maxRequests: 20,
			}),
			repo: "cacheplane/dawnai",
			transport: reconcileTransport({
				baseSha,
				headSha,
				mergeSha,
				mergedAt,
				...transportOptions,
			}),
		});
		await expect(
			reconcileDependabot({
				...reconciliationEvidenceArgs(baseSha, observationSha),
				expectedFixedNumbers: [2],
				expectedMergeSha: mergeSha,
				expectedObservationHeadSha: observationSha,
				expectedOpenNumbers: [1],
				expectedReviewedBaseSha: baseSha,
				expectedReviewedHeadSha: headSha,
				github,
				intervalMs: 15,
				maxAttempts: 61,
				now: () => Date.parse("2026-08-10T18:01:00Z"),
				prNumber: 42,
				repo: "cacheplane/dawnai",
				sleep: async () => {},
				timeoutMs: 15 * 60_000,
			}),
		).rejects.toThrow(new RegExp(`UNPROVABLE: ${code}`, "u"));
	});

	it("binds PR/parents, stable open A/fixed/open B, audit, and containment", async () => {
		const audit = auditReceipt();
		const baseline = reconciliationFixture(baseSha);
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 100,
				maxRequests: 20,
			}),
			repo: "cacheplane/dawnai",
			transport: reconcileTransport({ baseSha, headSha, mergeSha, mergedAt }),
		});
		const receipt = await reconcileDependabot({
			...reconciliationEvidenceArgs(baseSha, mergeSha, baseline),
			expectedFixedNumbers: [2],
			expectedMergeSha: mergeSha,
			expectedObservationHeadSha: mergeSha,
			expectedOpenNumbers: [1],
			expectedReviewedBaseSha: baseSha,
			expectedReviewedHeadSha: headSha,
			github,
			intervalMs: 15,
			maxAttempts: 61,
			now: () => Date.parse("2026-08-10T18:01:00Z"),
			prNumber: 42,
			repo: "cacheplane/dawnai",
			sleep: async () => {},
			timeoutMs: 15 * 60_000,
		});
		expect(receipt.pr).toEqual({
			mergeParentShas: [baseSha, headSha],
			mergeSha,
			mergedAt,
			number: 42,
			reviewedBaseSha: baseSha,
			reviewedHeadSha: headSha,
		});
		expect(receipt.dependabot.open.map((alert: any) => alert.number)).toEqual([
			1,
		]);
		expect(receipt.dependabot.fixed.map((alert: any) => alert.number)).toEqual([
			2,
		]);
		expect(receipt.audit.digest).toBe(digest(audit));
		expect(receipt.audit.evidence).toEqual(audit);
		expect(receipt.observationHead).toBe(mergeSha);
		expect(canonicalJsonBytes(receipt)).toBeInstanceOf(Buffer);
	});

	it("rejects a deadline crossed during final receipt capture", async () => {
		const audit = auditReceipt();
		let clockReads = 0;
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 100,
				maxRequests: 20,
			}),
			repo: "cacheplane/dawnai",
			transport: reconcileTransport({ baseSha, headSha, mergeSha, mergedAt }),
		});
		await expect(
			reconcileDependabot({
				...reconciliationEvidenceArgs(baseSha, mergeSha),
				expectedFixedNumbers: [2],
				expectedMergeSha: mergeSha,
				expectedObservationHeadSha: mergeSha,
				expectedOpenNumbers: [1],
				expectedReviewedBaseSha: baseSha,
				expectedReviewedHeadSha: headSha,
				github,
				intervalMs: 15,
				maxAttempts: 61,
				now: () => (clockReads++ < 8 ? 0 : 100),
				prNumber: 42,
				repo: "cacheplane/dawnai",
				sleep: async () => {},
				timeoutMs: 100,
			}),
		).rejects.toThrow(/UNPROVABLE: DEPENDABOT_RECONCILIATION_TIMEOUT/u);
	});

	it("accepts the target state on the final permitted polling attempt", async () => {
		let clock = Date.parse("2026-08-10T18:01:00Z");
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 100,
				maxRequests: 20,
			}),
			repo: "cacheplane/dawnai",
			transport: reconcileTransport({
				baseSha,
				headSha,
				mergeSha,
				mergedAt,
				pendingAttempts: 2,
			}),
		});
		const receipt = await reconcileDependabot({
			...reconciliationEvidenceArgs(baseSha, mergeSha),
			expectedFixedNumbers: [2],
			expectedMergeSha: mergeSha,
			expectedObservationHeadSha: mergeSha,
			expectedOpenNumbers: [1],
			expectedReviewedBaseSha: baseSha,
			expectedReviewedHeadSha: headSha,
			github,
			intervalMs: 15,
			maxAttempts: 3,
			now: () => clock,
			prNumber: 42,
			repo: "cacheplane/dawnai",
			sleep: async (milliseconds) => {
				clock += milliseconds;
			},
			timeoutMs: 46,
		});
		expect(receipt.dependabot.fixed.map((alert: any) => alert.number)).toEqual([
			2,
		]);
	});

	it("polls through partial fixed-alert convergence", async () => {
		let sleeps = 0;
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 20,
				maxRecords: 100,
				maxRequests: 40,
			}),
			repo: "cacheplane/dawnai",
			transport: reconcileTransport({
				baseSha,
				headSha,
				mergeSha,
				mergedAt,
				partialConvergence: true,
			}),
		});
		const receipt = await reconcileDependabot({
			...reconciliationFileInputs(
				baseSha,
				reconciliationFixtureWithThree(baseSha),
			),
			collectPublication: async () => publicationSnapshot(mergeSha, mergeSha),
			expectedFixedNumbers: [2, 3],
			expectedMergeSha: mergeSha,
			expectedObservationHeadSha: mergeSha,
			expectedOpenNumbers: [1],
			expectedReviewedBaseSha: baseSha,
			expectedReviewedHeadSha: headSha,
			github,
			intervalMs: 15,
			maxAttempts: 3,
			now: () => Date.parse("2026-08-10T18:01:00Z"),
			prNumber: 42,
			repo: "cacheplane/dawnai",
			sleep: async () => {
				sleeps += 1;
			},
			timeoutMs: 100,
		});
		expect(sleeps).toBe(1);
		expect(receipt.dependabot.fixed.map((alert: any) => alert.number)).toEqual([
			2, 3,
		]);
		expect(receipt.dependabot.open.map((alert: any) => alert.number)).toEqual([
			1,
		]);
	});

	it("times out without sleeping when the remaining deadline equals the interval", async () => {
		const audit = auditReceipt();
		let clock = 0;
		let sleeps = 0;
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 100,
				maxRequests: 20,
			}),
			repo: "cacheplane/dawnai",
			transport: reconcileTransport({
				baseSha,
				headSha,
				mergeSha,
				mergedAt,
				pendingAttempts: 10,
			}),
		});
		await expect(
			reconcileDependabot({
				...reconciliationEvidenceArgs(baseSha, mergeSha),
				expectedFixedNumbers: [2],
				expectedMergeSha: mergeSha,
				expectedObservationHeadSha: mergeSha,
				expectedOpenNumbers: [1],
				expectedReviewedBaseSha: baseSha,
				expectedReviewedHeadSha: headSha,
				github,
				intervalMs: 15,
				maxAttempts: 61,
				now: () => clock,
				prNumber: 42,
				repo: "cacheplane/dawnai",
				sleep: async (milliseconds) => {
					sleeps += 1;
					clock += milliseconds;
				},
				timeoutMs: 30,
			}),
		).rejects.toThrow(/UNPROVABLE: DEPENDABOT_RECONCILIATION_TIMEOUT/u);
		expect(sleeps).toBe(1);
	});

	it.each([
		["NaN", () => Number.NaN],
		["outside the JavaScript Date range", () => Number.MAX_SAFE_INTEGER],
		[
			"backwards",
			(() => {
				const samples = [1_000, 999];
				return () => samples.shift() ?? 999;
			})(),
		],
	])("rejects a %s clock before GitHub I/O", async (_name, now) => {
		const audit = auditReceipt();
		let requests = 0;
		await expect(
			reconcileDependabot({
				...reconciliationEvidenceArgs(baseSha, mergeSha),
				expectedFixedNumbers: [2],
				expectedMergeSha: mergeSha,
				expectedObservationHeadSha: mergeSha,
				expectedOpenNumbers: [1],
				expectedReviewedBaseSha: baseSha,
				expectedReviewedHeadSha: headSha,
				github: {
					list: async () => {
						requests += 1;
						return [];
					},
					object: async () => {
						requests += 1;
						return {};
					},
				},
				now,
				prNumber: 42,
				repo: "cacheplane/dawnai",
			}),
		).rejects.toThrow(/UNPROVABLE: DEPENDABOT_RECONCILIATION_TIMEOUT/u);
		expect(requests).toBe(0);
	});

	it("keeps the default polling timer alive through attempt two", async () => {
		const moduleUrl = new URL(
			"../../scripts/security/dependabot-reconcile.mjs",
			import.meta.url,
		).href;
		const script = [
			`import { sleepForReconciliation } from ${JSON.stringify(moduleUrl)}`,
			"let attempts = 1",
			"await sleepForReconciliation(20)",
			"attempts += 1",
			"process.stdout.write(`attempts=${attempts}\\n`)",
		].join("\n");
		const result = await execFileAsync(
			process.execPath,
			["--input-type=module", "-e", script],
			{
				cwd: repositoryRoot,
				timeout: 2_000,
			},
		);
		expect(result.stdout).toBe("attempts=2\n");
	});

	it.each([
		["PR base", { pullBase: "d".repeat(40) }],
		["PR head", { pullHead: "d".repeat(40) }],
		["merge parent", { secondParent: "d".repeat(40) }],
		["default head drift", { headAfter: "d".repeat(40) }],
		["open snapshot drift", { openAfter: [] }],
		["fixed identity drift", { fixedPackage: "other" }],
		["fixed before merge", { fixedAt: "2026-08-10T17:59:59Z" }],
		["dismissed fixed", { fixedDismissed: true }],
		["baseline provenance", { baselineSha: "d".repeat(40) }],
	])("rejects %s", async (_name, options) => {
		const audit = auditReceipt();
		const expectedBaselineSha =
			"baselineSha" in options ? options.baselineSha : baseSha;
		const github = createGitHubReader({
			budget: createEvidenceBudget({
				maxPages: 10,
				maxRecords: 100,
				maxRequests: 20,
			}),
			repo: "cacheplane/dawnai",
			transport: reconcileTransport({
				baseSha,
				headSha,
				mergeSha,
				mergedAt,
				...options,
			}),
		});
		await expect(
			reconcileDependabot({
				...reconciliationEvidenceArgs(expectedBaselineSha, mergeSha),
				expectedFixedNumbers: [2],
				expectedMergeSha: mergeSha,
				expectedObservationHeadSha: mergeSha,
				expectedOpenNumbers: [1],
				expectedReviewedBaseSha: baseSha,
				expectedReviewedHeadSha: headSha,
				github,
				intervalMs: 15,
				maxAttempts: 61,
				now: () => Date.parse("2026-08-10T18:01:00Z"),
				prNumber: 42,
				repo: "cacheplane/dawnai",
				sleep: async () => {},
				timeoutMs: 15 * 60_000,
			}),
		).rejects.toThrow(/UNPROVABLE/u);
	});

	it("rejects non-canonical audit bytes and schema drift without a free digest", async () => {
		const audit = auditReceipt();
		const common = {
			...reconciliationEvidenceArgs(baseSha, mergeSha),
			expectedFixedNumbers: [2],
			expectedMergeSha: mergeSha,
			expectedObservationHeadSha: mergeSha,
			expectedOpenNumbers: [1],
			expectedReviewedBaseSha: baseSha,
			expectedReviewedHeadSha: headSha,
			intervalMs: 15,
			maxAttempts: 61,
			now: () => Date.parse("2026-08-10T18:01:00Z"),
			prNumber: 42,
			repo: "cacheplane/dawnai",
			sleep: async () => {},
			timeoutMs: 15 * 60_000,
		};
		const github = () =>
			createGitHubReader({
				budget: createEvidenceBudget({
					maxPages: 10,
					maxRecords: 100,
					maxRequests: 20,
				}),
				repo: "cacheplane/dawnai",
				transport: reconcileTransport({ baseSha, headSha, mergeSha, mergedAt }),
			});
		await expect(
			reconcileDependabot({
				...common,
				auditReceiptBytes: Buffer.concat([
					common.auditReceiptBytes,
					Buffer.from(" "),
				]),
				github: github(),
			}),
		).rejects.toThrow(/UNPROVABLE/u);
		const malformed: any = structuredClone(audit);
		delete malformed.full.muted;
		await expect(
			reconcileDependabot({
				...common,
				auditReceiptBytes: canonicalJsonBytes(malformed),
				github: github(),
			}),
		).rejects.toThrow(/UNPROVABLE/u);
	});
});

describe("offline reconciliation receipt sealing", () => {
	it("validates the exact complete reconciliation schema and correlations", () => {
		const receipt = completeReconciliationReceipt();
		expect(validateReconciliationReceipt(receipt)).toEqual(receipt);
	});

	it.each([
		["missing top-level field", (value: any) => delete value.verificationRuns],
		["extra top-level field", (value: any) => (value.extra = true)],
		["missing merge parents", (value: any) => delete value.pr.mergeParentShas],
		[
			"wrong first merge parent",
			(value: any) => (value.pr.mergeParentShas[0] = "e".repeat(40)),
		],
		[
			"observation before merge",
			(value: any) => (value.observation.startedAt = "2026-08-10T17:59:59Z"),
		],
		[
			"completion before start",
			(value: any) => (value.observation.completedAt = "2026-08-10T18:00:59Z"),
		],
		[
			"fractional observation timestamp",
			(value: any) =>
				(value.observation.completedAt = "2026-08-10T18:01:01.123Z"),
		],
		[
			"missing run event",
			(value: any) => delete value.verificationRuns[0].event,
		],
		[
			"wrong run event",
			(value: any) => (value.verificationRuns[0].event = "schedule"),
		],
		[
			"wrong run branch",
			(value: any) => (value.verificationRuns[0].headBranch = "feature"),
		],
		[
			"wrong run head",
			(value: any) => (value.verificationRuns[0].headSha = "e".repeat(40)),
		],
		[
			"wrong run status",
			(value: any) => (value.verificationRuns[0].status = "queued"),
		],
		[
			"wrong run conclusion",
			(value: any) => (value.verificationRuns[0].conclusion = "failure"),
		],
		[
			"duplicate run ID",
			(value: any) =>
				(value.verificationRuns[1].runId = value.verificationRuns[0].runId),
		],
		["unsorted runs", (value: any) => value.verificationRuns.reverse()],
		[
			"missing workflow/head product",
			(value: any) => value.verificationRuns.pop(),
		],
		[
			"publication head mismatch",
			(value: any) => (value.observationHead = "e".repeat(40)),
		],
		[
			"audit digest mutation",
			(value: any) => (value.audit.digest = "0".repeat(64)),
		],
		[
			"audit input digest mutation",
			(value: any) =>
				(value.digests.inputs.auditReceiptSha256 = "0".repeat(64)),
		],
		[
			"fixed output digest mutation",
			(value: any) =>
				(value.digests.outputs.fixedAlertsSha256 = "0".repeat(64)),
		],
		[
			"open A output digest mutation",
			(value: any) =>
				(value.digests.outputs.openSnapshotASha256 = "0".repeat(64)),
		],
		[
			"open B output digest mutation",
			(value: any) =>
				(value.digests.outputs.openSnapshotBSha256 = "0".repeat(64)),
		],
		[
			"publication-before digest mutation",
			(value: any) =>
				(value.digests.outputs.publicationBeforeSha256 = "0".repeat(64)),
		],
		[
			"publication-after digest mutation",
			(value: any) =>
				(value.digests.outputs.publicationAfterSha256 = "0".repeat(64)),
		],
	])("rejects %s", (_name, mutate) => {
		const receipt = completeReconciliationReceipt();
		mutate(receipt);
		expect(() => validateReconciliationReceipt(receipt)).toThrow(
			/UNPROVABLE: INVALID_RECONCILIATION_RECEIPT/u,
		);
	});

	for (const section of ["inputs", "outputs"] as const) {
		const keys = Object.keys(completeReconciliationReceipt().digests[section]);
		it.each(keys)(
			`rejects a missing or malformed ${section} digest %s`,
			(key) => {
				for (const mutation of ["missing", "malformed"]) {
					const receipt = completeReconciliationReceipt();
					if (mutation === "missing") delete receipt.digests[section][key];
					else receipt.digests[section][key] = "not-a-digest";
					expect(() => validateReconciliationReceipt(receipt)).toThrow(
						/UNPROVABLE: INVALID_RECONCILIATION_RECEIPT/u,
					);
				}
			},
		);
	}

	it("writes the exact receipt and a separate canonical uploader manifest", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-seal-"));
		try {
			const receipt = reconciliationReceipt();
			const receiptBytes = canonicalJsonBytes(receipt);
			const receiptSha256 = createHash("sha256")
				.update(receiptBytes)
				.digest("hex");
			const outputDirectory = resolve(root, "sealed");
			const result = await sealReconciliationReceipt({
				expectedMainSha: receipt.observationHead,
				expectedMergeSha: receipt.pr.mergeSha,
				expectedPrNumber: receipt.pr.number,
				expectedRepository: receipt.repository,
				expectedReviewedBaseSha: receipt.pr.reviewedBaseSha,
				expectedReviewedHeadSha: receipt.pr.reviewedHeadSha,
				outputDirectory,
				outputRoot: root,
				receiptBase64: receiptBytes.toString("base64"),
				receiptSha256,
				runAttempt: 2,
				runId: 31360000000,
			});

			expect(await readdir(outputDirectory)).toEqual([
				"dependency-security-reconciliation.json",
				"uploader-manifest.json",
			]);
			expect(await readFile(result.receiptPath)).toEqual(receiptBytes);
			expect(await readFile(result.manifestPath)).toEqual(
				canonicalJsonBytes(result.manifest),
			);
			expect((await stat(result.receiptPath)).mode & 0o777).toBe(0o600);
			expect((await stat(result.manifestPath)).mode & 0o777).toBe(0o600);
			expect(result.manifest).toEqual({
				kind: "dependency-security-receipt-uploader",
				observationHead: receipt.observationHead,
				receiptSha256,
				repository: "cacheplane/dawnai",
				runAttempt: 2,
				runId: 31360000000,
				schemaVersion: 1,
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it.each([
		["non-base64 input", (args: any) => ({ ...args, receiptBase64: "***" })],
		[
			"oversized decoded input",
			(args: any) => ({
				...args,
				receiptBase64: Buffer.alloc(32 * 1024 + 1).toString("base64"),
			}),
		],
		[
			"wrong digest",
			(args: any) => ({ ...args, receiptSha256: "0".repeat(64) }),
		],
		[
			"wrong main",
			(args: any) => ({ ...args, expectedMainSha: "d".repeat(40) }),
		],
		[
			"wrong merge",
			(args: any) => ({ ...args, expectedMergeSha: "d".repeat(40) }),
		],
		["wrong PR", (args: any) => ({ ...args, expectedPrNumber: 43 })],
		[
			"wrong base",
			(args: any) => ({ ...args, expectedReviewedBaseSha: "d".repeat(40) }),
		],
		[
			"wrong head",
			(args: any) => ({ ...args, expectedReviewedHeadSha: "d".repeat(40) }),
		],
		[
			"wrong repository",
			(args: any) => ({ ...args, expectedRepository: "cacheplane/other" }),
		],
		["zero run id", (args: any) => ({ ...args, runId: 0 })],
		["zero run attempt", (args: any) => ({ ...args, runAttempt: 0 })],
	])("rejects %s without creating output", async (_name, mutate) => {
		const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-reject-"));
		try {
			const args = mutate(sealArguments(root));
			await expect(sealReconciliationReceipt(args)).rejects.toThrow(
				/UNPROVABLE/u,
			);
			await expect(readdir(resolve(root, "sealed"))).rejects.toThrow();
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("rejects non-canonical JSON and invalid UTF-8 even with matching digests", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-bytes-"));
		try {
			const receipt = reconciliationReceipt();
			const nonCanonical = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
			await expect(
				sealReconciliationReceipt({
					...sealArguments(root),
					receiptBase64: nonCanonical.toString("base64"),
					receiptSha256: createHash("sha256")
						.update(nonCanonical)
						.digest("hex"),
				}),
			).rejects.toThrow(/UNPROVABLE: NON_CANONICAL_RECONCILIATION_RECEIPT/u);

			const invalidUtf8 = Buffer.from([0xc3, 0x28]);
			await expect(
				sealReconciliationReceipt({
					...sealArguments(root),
					receiptBase64: invalidUtf8.toString("base64"),
					receiptSha256: createHash("sha256").update(invalidUtf8).digest("hex"),
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECONCILIATION_RECEIPT/u);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("rejects output escape, an existing directory, and a symlink target", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-output-"));
		const external = await mkdtemp(resolve(tmpdir(), "dawn-receipt-external-"));
		try {
			await expect(
				sealReconciliationReceipt({
					...sealArguments(root),
					outputDirectory: resolve(root, "..", "escaped"),
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);

			await mkdir(resolve(root, "sealed"));
			await expect(
				sealReconciliationReceipt(sealArguments(root)),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
			await rm(resolve(root, "sealed"), { recursive: true });

			await writeFile(resolve(root, "sealed"), "preserve-me");
			await expect(
				sealReconciliationReceipt(sealArguments(root)),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
			await expect(readFile(resolve(root, "sealed"), "utf8")).resolves.toBe(
				"preserve-me",
			);
			await rm(resolve(root, "sealed"));

			await symlink(external, resolve(root, "sealed"), "dir");
			await expect(
				sealReconciliationReceipt(sealArguments(root)),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
		} finally {
			await rm(root, { force: true, recursive: true });
			await rm(external, { force: true, recursive: true });
		}
	});

	it("rejects hostile reconciliation accessors without invoking them", () => {
		const receipt = reconciliationReceipt();
		let invoked = false;
		Object.defineProperty(receipt, "repository", {
			enumerable: true,
			get() {
				invoked = true;
				throw new Error("secret_token_value");
			},
		});
		expect(() => validateReconciliationReceipt(receipt)).toThrow(/UNPROVABLE/u);
		expect(invoked).toBe(false);
	});

	it.each(["startedAt", "mergedAt"])(
		"rejects an invalid calendar value in %s without writing output",
		async (field) => {
			const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-timestamp-"));
			try {
				const receipt = reconciliationReceipt();
				if (field === "startedAt") {
					receipt.observation.startedAt = "2026-99-99T99:99:99Z";
				} else receipt.pr.mergedAt = "2026-99-99T99:99:99Z";
				const receiptBytes = canonicalJsonBytes(receipt);
				await expect(
					sealReconciliationReceipt({
						...sealArguments(root),
						receiptBase64: receiptBytes.toString("base64"),
						receiptSha256: createHash("sha256")
							.update(receiptBytes)
							.digest("hex"),
					}),
				).rejects.toThrow(/UNPROVABLE: INVALID_RECONCILIATION_RECEIPT/u);
				await expect(readdir(resolve(root, "sealed"))).rejects.toThrow();
			} finally {
				await rm(root, { force: true, recursive: true });
			}
		},
	);

	it("rejects an extra staged file before publishing the output directory", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-extra-"));
		try {
			await expect(
				sealReconciliationReceipt({
					...sealArguments(root),
					writerCheckpoint: async (name: string, context: any) => {
						if (name === "beforeClose") {
							await writeFile(
								resolve(context.outputDirectory, "extra.txt"),
								"extra",
							);
						}
					},
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("rejects a target inserted immediately before the atomic directory reservation", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-target-race-"));
		try {
			await expect(
				sealReconciliationReceipt({
					...sealArguments(root),
					writerCheckpoint: async (name: string, context: any) => {
						if (name === "beforeMkdir") {
							await mkdir(context.outputDirectory);
							await writeFile(
								resolve(context.outputDirectory, "preserve.txt"),
								"preserve-me",
							);
						}
					},
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
			await expect(
				readFile(resolve(root, "sealed/preserve.txt"), "utf8"),
			).resolves.toBe("preserve-me");
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("rejects a deterministic root swap before the atomic directory reservation", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-root-swap-"));
		const movedRoot = `${root}-moved`;
		try {
			await expect(
				sealReconciliationReceipt({
					...sealArguments(root),
					writerCheckpoint: async (name: string) => {
						if (name === "beforeMkdir") {
							await rename(root, movedRoot);
							await mkdir(root, { mode: 0o700 });
						}
					},
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
		} finally {
			await rm(root, { force: true, recursive: true });
			await rm(movedRoot, { force: true, recursive: true });
		}
	});

	it("rejects root swaps after directory creation and before closing proof", async () => {
		for (const checkpoint of ["afterMkdir", "beforeClose"]) {
			const root = await mkdtemp(
				resolve(tmpdir(), `dawn-receipt-root-${checkpoint}-`),
			);
			const movedRoot = `${root}-moved`;
			try {
				await expect(
					sealReconciliationReceipt({
						...sealArguments(root),
						writerCheckpoint: async (name: string) => {
							if (name === checkpoint) {
								await rename(root, movedRoot);
								await mkdir(root, { mode: 0o700 });
							}
						},
					}),
				).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
			} finally {
				await rm(root, { force: true, recursive: true });
				await rm(movedRoot, { force: true, recursive: true });
			}
		}
	});

	it("rejects a deterministic output swap before closing proof", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-output-swap-"));
		const external = await mkdtemp(
			resolve(tmpdir(), "dawn-receipt-output-external-"),
		);
		const movedOutput = resolve(root, "moved-output");
		try {
			await expect(
				sealReconciliationReceipt({
					...sealArguments(root),
					writerCheckpoint: async (name: string, context: any) => {
						if (name === "beforeClose") {
							await rename(context.outputDirectory, movedOutput);
							await symlink(external, context.outputDirectory, "dir");
						}
					},
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
		} finally {
			await rm(root, { force: true, recursive: true });
			await rm(external, { force: true, recursive: true });
		}
	});

	it.each(["replacement", "symlink", "hardlink"])(
		"rejects a %s attack on a sealed file before closing proof",
		async (attack) => {
			const root = await mkdtemp(
				resolve(tmpdir(), `dawn-receipt-file-${attack}-`),
			);
			const displaced = resolve(root, "displaced.json");
			const external = resolve(root, "external.json");
			try {
				await writeFile(external, "external");
				await expect(
					sealReconciliationReceipt({
						...sealArguments(root),
						writerCheckpoint: async (name: string, context: any) => {
							if (name !== "beforeClose") return;
							const receiptPath = resolve(
								context.outputDirectory,
								"dependency-security-reconciliation.json",
							);
							if (attack === "hardlink") {
								await link(receiptPath, displaced);
								return;
							}
							await rename(receiptPath, displaced);
							if (attack === "symlink") await symlink(external, receiptPath);
							else await writeFile(receiptPath, "replacement");
						},
					}),
				).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
			} finally {
				await rm(root, { force: true, recursive: true });
			}
		},
	);

	it("enforces the trusted-root contract and accepts only a protected sticky ancestor", async () => {
		const parent = await mkdtemp(resolve(tmpdir(), "dawn-receipt-parent-"));
		const root = resolve(parent, "root");
		const rootLink = `${root}-link`;
		try {
			await mkdir(root, { mode: 0o700 });
			await chmod(root, 0o770);
			await expect(
				sealReconciliationReceipt(sealArguments(root)),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
			await chmod(root, 0o700);

			await symlink(root, rootLink, "dir");
			await expect(
				sealReconciliationReceipt(sealArguments(rootLink)),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
			await rm(rootLink);

			await chmod(parent, 0o777);
			await expect(
				sealReconciliationReceipt(sealArguments(root)),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
			await chmod(parent, 0o1777);
			await expect(
				sealReconciliationReceipt(sealArguments(root)),
			).resolves.toBeTruthy();
		} finally {
			await chmod(parent, 0o700).catch(() => {});
			await rm(parent, { force: true, recursive: true });
			await rm(rootLink, { force: true, recursive: true });
		}
	});

	it("rejects closing proof when a trusted ancestor changes", async () => {
		const parent = await mkdtemp(
			resolve(tmpdir(), "dawn-receipt-ancestor-drift-"),
		);
		const root = resolve(parent, "root");
		try {
			await chmod(parent, 0o1777);
			await mkdir(root, { mode: 0o700 });
			await expect(
				sealReconciliationReceipt({
					...sealArguments(root),
					writerCheckpoint: async (name: string) => {
						if (name === "beforeClose") await chmod(parent, 0o777);
					},
				}),
			).rejects.toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
		} finally {
			await chmod(parent, 0o700).catch(() => {});
			await rm(parent, { force: true, recursive: true });
		}
	});

	it.each([0o755, 0o1777])(
		"rejects an attacker-owned canonical ancestor with mode %s",
		async (mode) => {
			const module = await import(
				"../../scripts/security/dependabot-reconcile.mjs"
			);
			expect(() =>
				module.validateTrustedAncestorPolicy(mode, 777, 501, 501),
			).toThrow(/UNPROVABLE: INVALID_RECEIPT_OUTPUT/u);
		},
	);

	it("writes exact modes even under a fully restrictive umask", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-umask-"));
		const previousUmask = process.umask(0o777);
		try {
			const result = await sealReconciliationReceipt(sealArguments(root));
			expect((await stat(resolve(root, "sealed"))).mode & 0o777).toBe(0o700);
			expect((await stat(result.receiptPath)).mode & 0o777).toBe(0o600);
			expect((await stat(result.manifestPath)).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(previousUmask);
			await rm(root, { force: true, recursive: true });
		}
	});

	it("maps a disappearing trusted root to the fixed output error", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "dawn-receipt-root-missing-"));
		const movedRoot = `${root}-moved`;
		try {
			await expect(
				sealReconciliationReceipt({
					...sealArguments(root),
					writerCheckpoint: async (name: string) => {
						if (name === "beforeMkdir") await rename(root, movedRoot);
					},
				}),
			).rejects.toThrow(/^UNPROVABLE: INVALID_RECEIPT_OUTPUT$/u);
		} finally {
			await rm(root, { force: true, recursive: true });
			await rm(movedRoot, { force: true, recursive: true });
		}
	});
});

type SchemaOutcome = { accepted: false } | { accepted: true; bytes: string };

function schemaOutcome(operation: () => unknown): SchemaOutcome {
	try {
		return {
			accepted: true,
			bytes: canonicalJsonBytes(operation()).toString("utf8"),
		};
	} catch {
		return { accepted: false };
	}
}

function schemaAuditExpectation() {
	const records = [
		{
			ghsa: "GHSA-866g-f22w-33x8",
			package: "@ai-sdk/provider-utils",
			severity: "low",
			version: "3.0.28",
		},
		{
			ghsa: "GHSA-54fx-42gc-7vw4",
			package: "hono",
			severity: "moderate",
			version: "4.12.28",
		},
	];
	return {
		full: { muted: [], records: structuredClone(records) },
		production: { muted: [], records: structuredClone(records) },
		schemaVersion: 1,
	};
}

function auditReceiptFromExpectation(expectation: any) {
	const auditMode = (value: any) => {
		const severityTotals = {
			critical: 0,
			high: 0,
			info: 0,
			low: 0,
			moderate: 0,
		};
		for (const record of value.records) {
			severityTotals[record.severity as keyof typeof severityTotals] += 1;
		}
		return {
			exitCode: value.records.length === 0 ? 0 : 1,
			muted: [],
			records: structuredClone(value.records),
			severityTotals,
			status: value.records.length === 0 ? "clean" : "findings",
		};
	};
	return {
		full: auditMode(expectation.full),
		kind: "pnpm-audit",
		production: auditMode(expectation.production),
		schemaVersion: 1,
	};
}

function schemaDependabotExpectation() {
	return {
		defaultSha,
		open: [
			normalizedAlert(),
			normalizedAlert({ number: 2, package: "second" }),
		],
		repository: "cacheplane/dawnai",
		schemaVersion: 1,
	};
}

function normalizedAlert(overrides: Record<string, unknown> = {}) {
	return {
		autoDismissedAt: null,
		createdAt: "2026-08-07T00:00:00Z",
		dismissal: null,
		ecosystem: "npm",
		fixedAt: null,
		ghsa: "GHSA-2345-6789-cfgh",
		manifest: "pnpm-lock.yaml",
		number: 1,
		package: "example",
		relationship: "transitive",
		scope: "runtime",
		severity: "high",
		state: "open",
		updatedAt: "2026-08-07T00:00:00Z",
		...overrides,
	};
}

function rawAlert(overrides: Record<string, unknown> = {}): any {
	return {
		auto_dismissed_at: null,
		created_at: "2026-08-07T00:00:00Z",
		dependency: {
			manifest_path: "pnpm-lock.yaml",
			package: { ecosystem: "npm", name: "example" },
			relationship: "transitive",
			scope: "runtime",
		},
		dismissed_at: null,
		dismissed_by: null,
		dismissed_comment: null,
		dismissed_reason: null,
		fixed_at: null,
		number: 1,
		security_advisory: { ghsa_id: "GHSA-2345-6789-cfgh", severity: "high" },
		state: "open",
		updated_at: "2026-08-07T00:00:00Z",
		...overrides,
	};
}

function rawFromNormalized(value: any) {
	return {
		auto_dismissed_at: value.autoDismissedAt,
		created_at: value.createdAt,
		dependency: {
			manifest_path: value.manifest,
			package: { ecosystem: value.ecosystem, name: value.package },
			relationship: value.relationship,
			scope: value.scope,
		},
		dismissed_at: value.dismissal?.at ?? null,
		dismissed_by:
			value.dismissal === null ? null : { login: value.dismissal.by },
		dismissed_comment: value.dismissal?.comment ?? null,
		dismissed_reason: value.dismissal?.reason ?? null,
		fixed_at: value.fixedAt,
		number: value.number,
		security_advisory: { ghsa_id: value.ghsa, severity: value.severity },
		state: value.state,
		updated_at: value.updatedAt,
	};
}

function jsonResponse(body: unknown) {
	return {
		body,
		bodyBytes: Buffer.byteLength(JSON.stringify(body)) + 64,
		link: null,
		status: 200,
	};
}

function reconciliationFixture(defaultSha: string) {
	return validateDependabotExpectation({
		defaultSha,
		open: [
			normalizedAlert(),
			normalizedAlert({ number: 2, package: "second" }),
		],
		repository: "cacheplane/dawnai",
		schemaVersion: 1,
	});
}

function reconciliationFixtureWithThree(defaultSha: string) {
	return validateDependabotExpectation({
		defaultSha,
		open: [
			normalizedAlert(),
			normalizedAlert({ number: 2, package: "second" }),
			normalizedAlert({ number: 3, package: "third" }),
		],
		repository: "cacheplane/dawnai",
		schemaVersion: 1,
	});
}

function auditReceipt() {
	const record = {
		ghsa: "GHSA-866g-f22w-33x8",
		package: "@ai-sdk/provider-utils",
		severity: "low",
		version: "3.0.28",
	};
	const mode = {
		exitCode: 1,
		muted: [],
		records: [record],
		severityTotals: { critical: 0, high: 0, info: 0, low: 1, moderate: 0 },
		status: "findings",
	};
	return {
		full: mode,
		kind: "pnpm-audit",
		production: structuredClone(mode),
		schemaVersion: 1,
	};
}

function digest(value: unknown) {
	return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

function sha256Bytes(value: Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

function reconciliationFileInputs(
	baseSha: string,
	fixture = reconciliationFixture(baseSha),
) {
	const audit = auditReceipt();
	const auditExpectation = {
		full: { muted: [], records: audit.full.records },
		production: { muted: [], records: audit.production.records },
		schemaVersion: 1,
	};
	const baselineReceipt = {
		capturedAt: "2026-08-10T17:00:00Z",
		dependabot: { defaultSha: baseSha, open: fixture.open },
		kind: "dependency-security-baseline",
		publication: publicationSnapshot(baseSha, "f".repeat(40)),
		repository: "cacheplane/dawnai",
		schemaVersion: 1,
		sourceSha: "f".repeat(40),
	};
	return {
		auditExpectationFixtureBytes: canonicalJsonBytes(auditExpectation),
		auditReceiptBytes: canonicalJsonBytes(audit),
		baselineReceiptBytes: canonicalJsonBytes(baselineReceipt),
		dependabotIdentitiesFixtureBytes: canonicalJsonBytes(fixture),
	};
}

function reconciliationEvidenceArgs(
	baseSha: string,
	observationSha: string,
	fixture = reconciliationFixture(baseSha),
) {
	return {
		...reconciliationFileInputs(baseSha, fixture),
		collectPublication: async () =>
			publicationSnapshot(observationSha, observationSha),
	};
}

function reconcileTransport(options: any) {
	const openBefore = [rawAlert()];
	const openAfter = options.openAfter ?? [rawAlert()];
	let openReads = 0;
	let fixedReads = 0;
	let headReads = 0;
	let verificationReads = 0;
	return async ({ url }: { url: string }) => {
		const api = new URL(url);
		const path = `${api.pathname}${api.search}`;
		if (path.endsWith("/pulls/42")) {
			return jsonResponse({
				base: { sha: options.pullBase ?? options.baseSha },
				head: { sha: options.pullHead ?? options.headSha },
				merge_commit_sha: options.mergeSha,
				merged: true,
				merged_at: options.mergedAt,
				number: 42,
				state: "closed",
			});
		}
		if (path.endsWith(`/commits/${options.mergeSha}`)) {
			return jsonResponse({
				parents: [
					{ sha: options.baseSha },
					{ sha: options.secondParent ?? options.headSha },
				],
				sha: options.mergeSha,
			});
		}
		if (path.endsWith("/commits/main")) {
			const expected = options.observationSha ?? options.mergeSha;
			const sha =
				headReads++ === 0 ? expected : (options.headAfter ?? expected);
			return jsonResponse({ sha });
		}
		const decodedPath = decodeURIComponent(api.pathname);
		const workflowPrefix = "/repos/cacheplane/dawnai/actions/workflows/";
		if (
			decodedPath.startsWith(workflowPrefix) &&
			decodedPath.endsWith("/runs")
		) {
			const workflowPath = decodedPath.slice(
				workflowPrefix.length,
				-"/runs".length,
			);
			const runId = 31_400_000_000 + verificationReads++;
			return jsonResponse({
				total_count: 1,
				workflow_runs: [
					{
						conclusion: options.verificationConclusion ?? "success",
						event: options.verificationEvent ?? "push",
						head_branch: options.verificationBranch ?? "main",
						head_sha:
							options.verificationHead ?? api.searchParams.get("head_sha"),
						id: options.duplicateVerificationId ?? runId,
						path: options.verificationPath ?? workflowPath,
						run_attempt: options.verificationAttempt ?? 1,
						status: options.verificationStatus ?? "completed",
					},
				],
			});
		}
		if (path.includes("/dependabot/alerts?state=open")) {
			if (options.partialConvergence) {
				if (openReads++ === 0) {
					const third = rawAlert({ number: 3 });
					third.dependency.package.name = "third";
					return jsonResponse([rawAlert(), third]);
				}
				return jsonResponse([rawAlert()]);
			}
			if (openReads++ < (options.pendingAttempts ?? 0)) {
				const second = rawAlert({ number: 2 });
				second.dependency.package.name = "second";
				return jsonResponse([rawAlert(), second]);
			}
			return jsonResponse(
				options.pendingAttempts === undefined && openReads === 1
					? openBefore
					: openAfter,
			);
		}
		if (path.endsWith("/dependabot/alerts/2")) {
			const alert = rawAlert({ number: 2 });
			alert.dependency.package.name = options.fixedPackage ?? "second";
			if (fixedReads++ < (options.pendingAttempts ?? 0))
				return jsonResponse(alert);
			alert.state = "fixed";
			alert.fixed_at = options.fixedAt ?? options.mergedAt;
			alert.updated_at = options.fixedAt ?? options.mergedAt;
			if (options.fixedDismissed) {
				alert.dismissed_at = options.mergedAt;
				alert.dismissed_by = { login: "reviewer" };
				alert.dismissed_comment = "dismissed";
				alert.dismissed_reason = "tolerable_risk";
			}
			return jsonResponse(alert);
		}
		if (path.endsWith("/dependabot/alerts/3")) {
			const alert = rawAlert({ number: 3 });
			alert.dependency.package.name = "third";
			if (options.partialConvergence && fixedReads++ === 1)
				return jsonResponse(alert);
			alert.state = "fixed";
			alert.fixed_at = options.mergedAt;
			alert.updated_at = options.mergedAt;
			return jsonResponse(alert);
		}
		throw new Error(`unexpected reconcile request ${path}`);
	};
}

function reconciliationBoundaryGitHub(options: any) {
	let fixedCalls = 0;
	let mainCalls = 0;
	let openCalls = 0;
	let verificationCalls = 0;
	return {
		counts: () => ({ fixedCalls, mainCalls }),
		github: {
			list: async (path: string) => {
				if (path.startsWith("actions/workflows/")) {
					const [encodedWorkflowPath] = path
						.slice("actions/workflows/".length)
						.split("/runs?");
					if (encodedWorkflowPath === undefined) {
						throw new Error("missing workflow path");
					}
					const headSha = new URL(
						`https://example.test/?${path.split("?")[1]}`,
					).searchParams.get("head_sha");
					return [
						{
							conclusion: "success",
							event: "push",
							head_branch: "main",
							head_sha: headSha,
							id: 31_600_000_000 + verificationCalls++,
							path: decodeURIComponent(encodedWorkflowPath),
							run_attempt: 1,
							status: "completed",
						},
					];
				}
				openCalls += 1;
				if (
					(options.phase === "openA" && openCalls === 1) ||
					(options.phase === "openB" && openCalls === 2)
				) {
					options.advanceDeadline();
				}
				return [rawAlert()];
			},
			object: async (path: string) => {
				if (path === "pulls/42") {
					return {
						base: { sha: options.baseSha },
						head: { sha: options.headSha },
						merge_commit_sha: options.mergeSha,
						merged: true,
						merged_at: options.mergedAt,
						number: 42,
						state: "closed",
					};
				}
				if (path === `commits/${options.mergeSha}`) {
					return {
						parents: [{ sha: options.baseSha }, { sha: options.headSha }],
						sha: options.mergeSha,
					};
				}
				if (path === "commits/main") {
					mainCalls += 1;
					return { sha: options.mergeSha };
				}
				const match = /^dependabot\/alerts\/(2|3)$/u.exec(path);
				if (match !== null) {
					fixedCalls += 1;
					const number = Number(match[1]);
					const alert = rawAlert({
						fixed_at: options.mergedAt,
						number,
						state: "fixed",
						updated_at: options.mergedAt,
					});
					alert.dependency.package.name = number === 2 ? "second" : "third";
					if (options.phase === "fixed" && fixedCalls === 1)
						options.advanceDeadline();
					return alert;
				}
				throw new Error(`unexpected boundary request ${path}`);
			},
		},
	};
}

function publicationSnapshot(defaultHead: string, source: string) {
	return {
		candidateAbsence: { artifacts: true, releases: true, tags: true },
		defaultSha: defaultHead,
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
			sourceSha: source,
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
		sourceSha: source,
		workflows: {
			chart: {
				completeRuns: 1,
				id: 309127405,
				nonCompleted: 0,
				path: ".github/workflows/publish-chart.yml",
				retrievedRuns: 1,
				sourceShaRuns: 0,
				state: "disabled_manually",
				totalRuns: 1,
			},
			release: {
				completeRuns: 3,
				id: 260503756,
				nonCompleted: 0,
				path: ".github/workflows/release.yml",
				retrievedRuns: 3,
				sourceShaRuns: 0,
				state: "disabled_manually",
				totalRuns: 3,
			},
		},
	};
}

function reconciliationReceipt() {
	return completeReconciliationReceipt();
}

function completeReconciliationReceipt() {
	const reviewedBaseSha = "a".repeat(40);
	const reviewedHeadSha = "b".repeat(40);
	const mergeSha = "c".repeat(40);
	const mergedAt = "2026-08-10T18:00:00Z";
	const fixed = normalizedAlert({
		fixedAt: mergedAt,
		number: 2,
		package: "second",
		state: "fixed",
		updatedAt: mergedAt,
	});
	const open = [normalizedAlert()];
	const fixedAlerts = [fixed];
	const audit = auditReceipt();
	const publication = publicationSnapshot(mergeSha, mergeSha);
	const verificationRuns = [
		".github/workflows/ci.yml",
		".github/workflows/codeql.yml",
		".github/workflows/scorecard.yml",
	].map((workflowPath, index) => ({
		conclusion: "success",
		event: "push",
		headBranch: "main",
		headSha: mergeSha,
		runAttempt: 1,
		runId: 31_410_949_598 + index,
		status: "completed",
		workflowPath,
	}));
	return {
		audit: { digest: digest(audit), evidence: audit },
		dependabot: { fixed: fixedAlerts, open },
		digests: {
			inputs: {
				auditExpectationFixtureSha256: "d".repeat(64),
				auditReceiptSha256: digest(audit),
				baselineReceiptSha256: "e".repeat(64),
				dependabotIdentitiesFixtureSha256: "f".repeat(64),
			},
			outputs: {
				fixedAlertsSha256: digest(fixedAlerts),
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
		observationHead: mergeSha,
		pr: {
			mergeParentShas: [reviewedBaseSha, reviewedHeadSha],
			mergeSha,
			mergedAt,
			number: 42,
			reviewedBaseSha,
			reviewedHeadSha,
		},
		publication,
		repository: "cacheplane/dawnai",
		schemaVersion: 1,
		verificationRuns,
	};
}

function sealArguments(root: string) {
	const receipt = reconciliationReceipt();
	const receiptBytes = canonicalJsonBytes(receipt);
	return {
		expectedMainSha: receipt.observationHead,
		expectedMergeSha: receipt.pr.mergeSha,
		expectedPrNumber: receipt.pr.number,
		expectedRepository: receipt.repository,
		expectedReviewedBaseSha: receipt.pr.reviewedBaseSha,
		expectedReviewedHeadSha: receipt.pr.reviewedHeadSha,
		outputDirectory: resolve(root, "sealed"),
		outputRoot: root,
		receiptBase64: receiptBytes.toString("base64"),
		receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"),
		runAttempt: 2,
		runId: 31360000000,
	};
}
