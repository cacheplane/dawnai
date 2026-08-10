import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  canonicalJsonBytes,
  createEvidenceBudget,
  createGitHubReader,
} from "../../scripts/security/github-evidence.mjs"
import { INVENTORY_PACKAGES } from "../../scripts/security/publication-containment.mjs"
import {
  loadDependabotExpectation,
  normalizeDependabotAlert,
  readDependabotOpen,
  reconcileDependabot,
  validateDependabotExpectation,
} from "../../scripts/security/dependabot-reconcile.mjs"

const testDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDir, "../..")
const fixturePath = resolve(testDir, "fixtures/dependabot-baseline.json")
const defaultSha = "71dfab04e99efe303bd22e36394d68c5862cf502"
const expectedNumbers = [
  122, 123, 124, 125, 160, 162, 163, 164, 170, 171, 172, 176, 178, 179, 180, 181,
  191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201,
]

describe("Dependabot baseline identities", () => {
  it("loads the exact complete 27-alert fixture", async () => {
    const fixture = await loadDependabotExpectation(fixturePath, { root: repositoryRoot })
    expect(fixture.defaultSha).toBe(defaultSha)
    expect(fixture.open.map((alert: any) => alert.number)).toEqual(expectedNumbers)
    expect(new Set(fixture.open.map((alert: any) => alert.number))).toHaveLength(27)
    expect(fixture.open.every((alert: any) => alert.dismissal === null)).toBe(true)
  })

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
    expect(() => validateDependabotExpectation(value)).toThrow(/UNPROVABLE/u)
  })
})

describe("Dependabot alert normalization", () => {
  it("binds the complete stable alert identity", () => {
    expect(normalizeDependabotAlert(rawAlert())).toEqual(normalizedAlert())
  })

  it("normalizes a complete dismissal without retaining remote objects", () => {
    const alert = rawAlert()
    alert.state = "dismissed"
    alert.dismissed_at = "2026-08-08T00:00:00Z"
    alert.dismissed_by = { avatar_url: "https://example.invalid/avatar", login: "reviewer" }
    alert.dismissed_comment = "reviewed"
    alert.dismissed_reason = "tolerable_risk"
    expect(normalizeDependabotAlert(alert).dismissal).toEqual({
      at: "2026-08-08T00:00:00Z",
      by: "reviewer",
      comment: "reviewed",
      reason: "tolerable_risk",
    })
  })

  it.each([
    ["missing package", (value: any) => delete value.dependency.package.name],
    ["missing GHSA", (value: any) => delete value.security_advisory.ghsa_id],
    ["severity", (value: any) => (value.security_advisory.severity = "moderate")],
    ["partial dismissal", (value: any) => (value.dismissed_at = "2026-08-08T00:00:00Z")],
    ["bad timestamp", (value: any) => (value.updated_at = "yesterday")],
    ["missing scope", (value: any) => delete value.dependency.scope],
    ["unsafe manifest", (value: any) => (value.dependency.manifest_path = "../pnpm-lock.yaml")],
  ])("rejects %s identity", (_name, mutate) => {
    const alert = rawAlert()
    mutate(alert)
    expect(() => normalizeDependabotAlert(alert)).toThrow(/UNPROVABLE/u)
  })
})

describe("complete open-set reader", () => {
  it("uses cursor-only pagination and binds fixture plus expected numbers", async () => {
    const fixture = await loadDependabotExpectation(fixturePath, { root: repositoryRoot })
    const github = createGitHubReader({
      budget: createEvidenceBudget({ maxPages: 10, maxRecords: 100, maxRequests: 10 }),
      repo: "cacheplane/dawnai",
      transport: async () => jsonResponse(fixture.open.map(rawFromNormalized)),
    })
    await expect(
      readDependabotOpen({ expectedNumbers, fixture, github }),
    ).resolves.toEqual(fixture.open)
  })

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
    ["severity drift", (alerts: any[]) => (alerts[0].security_advisory.severity = "high")],
    ["timestamp drift", (alerts: any[]) => (alerts[0].updated_at = "2026-08-09T00:00:00Z")],
  ])("rejects %s open snapshot", async (_name, mutate) => {
    const fixture = await loadDependabotExpectation(fixturePath, { root: repositoryRoot })
    const alerts = fixture.open.map(rawFromNormalized)
    mutate(alerts)
    const github = createGitHubReader({
      budget: createEvidenceBudget({ maxPages: 10, maxRecords: 100, maxRequests: 10 }),
      repo: "cacheplane/dawnai",
      transport: async () => jsonResponse(alerts),
    })
    await expect(readDependabotOpen({ expectedNumbers, fixture, github })).rejects.toThrow(
      /UNPROVABLE/u,
    )
  })
})

describe("merged-head reconciliation", () => {
  const baseSha = "a".repeat(40)
  const headSha = "b".repeat(40)
  const mergeSha = "c".repeat(40)
  const mergedAt = "2026-08-10T18:00:00Z"

  it("binds PR/parents, stable open A/fixed/open B, audit, and containment", async () => {
    const audit = auditReceipt()
    const baseline = reconciliationFixture(baseSha)
    const github = createGitHubReader({
      budget: createEvidenceBudget({ maxPages: 10, maxRecords: 100, maxRequests: 20 }),
      repo: "cacheplane/dawnai",
      transport: reconcileTransport({ baseSha, headSha, mergeSha, mergedAt }),
    })
    const receipt = await reconcileDependabot({
      auditReceipt: audit,
      auditReceiptDigest: digest(audit),
      baselineFixture: baseline,
      expectedFixedNumbers: [2],
      expectedMergeSha: mergeSha,
      expectedOpenNumbers: [1],
      expectedReviewedBaseSha: baseSha,
      expectedReviewedHeadSha: headSha,
      github,
      intervalMs: 15,
      maxAttempts: 61,
      now: () => Date.parse("2026-08-10T18:01:00Z"),
      prNumber: 42,
      publication: publicationSnapshot(mergeSha, mergeSha),
      repo: "cacheplane/dawnai",
      sleep: async () => {},
      timeoutMs: 15 * 60_000,
    })
    expect(receipt.pr).toEqual({
      mergeSha,
      mergedAt,
      number: 42,
      reviewedBaseSha: baseSha,
      reviewedHeadSha: headSha,
    })
    expect(receipt.dependabot.open.map((alert: any) => alert.number)).toEqual([1])
    expect(receipt.dependabot.fixed.map((alert: any) => alert.number)).toEqual([2])
    expect(receipt.audit.digest).toBe(digest(audit))
    expect(receipt.audit.evidence).toEqual(audit)
    expect(receipt.observationHead).toBe(mergeSha)
    expect(canonicalJsonBytes(receipt)).toBeInstanceOf(Buffer)
  })

  it.each([
    ["PR base", { pullBase: "d".repeat(40) }],
    ["PR head", { pullHead: "d".repeat(40) }],
    ["merge parent", { secondParent: "d".repeat(40) }],
    ["default head drift", { headAfter: "d".repeat(40) }],
    ["open snapshot drift", { openAfter: [] }],
    ["fixed identity drift", { fixedPackage: "other" }],
    ["fixed before merge", { fixedAt: "2026-08-10T17:59:59Z" }],
    ["dismissed fixed", { fixedDismissed: true }],
  ])("rejects %s", async (_name, options) => {
    const audit = auditReceipt()
    const github = createGitHubReader({
      budget: createEvidenceBudget({ maxPages: 10, maxRecords: 100, maxRequests: 20 }),
      repo: "cacheplane/dawnai",
      transport: reconcileTransport({ baseSha, headSha, mergeSha, mergedAt, ...options }),
    })
    await expect(
      reconcileDependabot({
        auditReceipt: audit,
        auditReceiptDigest: digest(audit),
        baselineFixture: reconciliationFixture(baseSha),
        expectedFixedNumbers: [2],
        expectedMergeSha: mergeSha,
        expectedOpenNumbers: [1],
        expectedReviewedBaseSha: baseSha,
        expectedReviewedHeadSha: headSha,
        github,
        intervalMs: 15,
        maxAttempts: 61,
        now: () => Date.parse("2026-08-10T18:01:00Z"),
        prNumber: 42,
        publication: publicationSnapshot(mergeSha, mergeSha),
        repo: "cacheplane/dawnai",
        sleep: async () => {},
        timeoutMs: 15 * 60_000,
      }),
    ).rejects.toThrow(/UNPROVABLE/u)
  })

  it("rejects audit digest/schema drift", async () => {
    const audit = auditReceipt()
    const common = {
      auditReceipt: audit,
      baselineFixture: reconciliationFixture(baseSha),
      expectedFixedNumbers: [2],
      expectedMergeSha: mergeSha,
      expectedOpenNumbers: [1],
      expectedReviewedBaseSha: baseSha,
      expectedReviewedHeadSha: headSha,
      intervalMs: 15,
      maxAttempts: 61,
      now: () => Date.parse("2026-08-10T18:01:00Z"),
      prNumber: 42,
      publication: publicationSnapshot(mergeSha, mergeSha),
      repo: "cacheplane/dawnai",
      sleep: async () => {},
      timeoutMs: 15 * 60_000,
    }
    const github = () =>
      createGitHubReader({
        budget: createEvidenceBudget({ maxPages: 10, maxRecords: 100, maxRequests: 20 }),
        repo: "cacheplane/dawnai",
        transport: reconcileTransport({ baseSha, headSha, mergeSha, mergedAt }),
      })
    await expect(
      reconcileDependabot({ ...common, auditReceiptDigest: "0".repeat(64), github: github() }),
    ).rejects.toThrow(/UNPROVABLE: AUDIT_RECEIPT_DIGEST_MISMATCH/u)
    const malformed = structuredClone(audit)
    delete malformed.full.muted
    await expect(
      reconcileDependabot({
        ...common,
        auditReceipt: malformed,
        auditReceiptDigest: digest(malformed),
        github: github(),
      }),
    ).rejects.toThrow(/UNPROVABLE/u)
  })
})

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
  }
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
  }
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
    dismissed_by: value.dismissal === null ? null : { login: value.dismissal.by },
    dismissed_comment: value.dismissal?.comment ?? null,
    dismissed_reason: value.dismissal?.reason ?? null,
    fixed_at: value.fixedAt,
    number: value.number,
    security_advisory: { ghsa_id: value.ghsa, severity: value.severity },
    state: value.state,
    updated_at: value.updatedAt,
  }
}

function jsonResponse(body: unknown) {
  return { body, bodyBytes: Buffer.byteLength(JSON.stringify(body)) + 64, link: null, status: 200 }
}

function reconciliationFixture(defaultSha: string) {
  return validateDependabotExpectation({
    defaultSha,
    open: [normalizedAlert(), normalizedAlert({ number: 2, package: "second" })],
    repository: "cacheplane/dawnai",
    schemaVersion: 1,
  })
}

function auditReceipt() {
  const record = {
    ghsa: "GHSA-866g-f22w-33x8",
    package: "@ai-sdk/provider-utils",
    severity: "low",
    version: "3.0.28",
  }
  const mode = {
    exitCode: 1,
    muted: [],
    records: [record],
    severityTotals: { critical: 0, high: 0, info: 0, low: 1, moderate: 0 },
    status: "findings",
  }
  return { full: mode, kind: "pnpm-audit", production: structuredClone(mode), schemaVersion: 1 }
}

function digest(value: unknown) {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")
}

function reconcileTransport(options: any) {
  const openBefore = [rawAlert()]
  const openAfter = options.openAfter ?? [rawAlert()]
  let openReads = 0
  let headReads = 0
  return async ({ url }: { url: string }) => {
    const api = new URL(url)
    const path = `${api.pathname}${api.search}`
    if (path.endsWith("/pulls/42")) {
      return jsonResponse({
        base: { sha: options.pullBase ?? options.baseSha },
        head: { sha: options.pullHead ?? options.headSha },
        merge_commit_sha: options.mergeSha,
        merged: true,
        merged_at: options.mergedAt,
        number: 42,
        state: "closed",
      })
    }
    if (path.endsWith(`/commits/${options.mergeSha}`)) {
      return jsonResponse({
        parents: [{ sha: options.baseSha }, { sha: options.secondParent ?? options.headSha }],
        sha: options.mergeSha,
      })
    }
    if (path.endsWith("/commits/main")) {
      const sha = headReads++ === 0 ? options.mergeSha : options.headAfter ?? options.mergeSha
      return jsonResponse({ sha })
    }
    if (path.includes("/dependabot/alerts?state=open")) {
      return jsonResponse(openReads++ === 0 ? openBefore : openAfter)
    }
    if (path.endsWith("/dependabot/alerts/2")) {
      const alert = rawAlert({ number: 2 })
      alert.dependency.package.name = options.fixedPackage ?? "second"
      alert.state = "fixed"
      alert.fixed_at = options.fixedAt ?? options.mergedAt
      alert.updated_at = options.fixedAt ?? options.mergedAt
      if (options.fixedDismissed) {
        alert.dismissed_at = options.mergedAt
        alert.dismissed_by = { login: "reviewer" }
        alert.dismissed_comment = "dismissed"
        alert.dismissed_reason = "tolerable_risk"
      }
      return jsonResponse(alert)
    }
    throw new Error(`unexpected reconcile request ${path}`)
  }
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
          { conclusion: "success", digest: "a".repeat(64), name: "publish (dawn-app)", noOp: true },
          { conclusion: "success", digest: "b".repeat(64), name: "publish (dawn-sandbox-infra)", noOp: true },
        ],
        status: "completed",
      },
      release: [
        { conclusion: "cancelled", headSha: "3f4e3f9f62a3b48030a385bd0e7d720b8b26afdb", id: 31356780088, jobs: 1, publishStepsSkipped: true, status: "completed", steps: 20 },
        { conclusion: "cancelled", headSha: "b6adaa982b25adf5fac61733a13ac65320c70bcd", id: 31356940801, jobs: 0, publishStepsSkipped: true, status: "completed", steps: 0 },
        { conclusion: "cancelled", headSha: "cfa55478cf8e35dc8a00ae7041c0c12479fda2d9", id: 31357014583, jobs: 1, publishStepsSkipped: true, status: "completed", steps: 0 },
      ],
    },
    inventory: { currentVersion: "0.8.21", packages: [...INVENTORY_PACKAGES], ref: "HEAD", sourceSha: source, targetVersion: "0.8.22" },
    npm: {
      packages: INVENTORY_PACKAGES.map((name) => ({ latest: "0.8.21", name, packumentName: name, targetAttestationAbsent: true, targetDocumentAbsent: true })),
      requestCount: 63,
    },
    repository: "cacheplane/dawnai",
    schemaVersion: 1,
    sourceSha: source,
    workflows: {
      chart: { completeRuns: 1, id: 309127405, nonCompleted: 0, path: ".github/workflows/publish-chart.yml", retrievedRuns: 1, sourceShaRuns: 0, state: "disabled_manually", totalRuns: 1 },
      release: { completeRuns: 3, id: 260503756, nonCompleted: 0, path: ".github/workflows/release.yml", retrievedRuns: 3, sourceShaRuns: 0, state: "disabled_manually", totalRuns: 3 },
    },
  }
}
import { createHash } from "node:crypto"
