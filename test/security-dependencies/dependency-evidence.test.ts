import { readFile, symlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  collectAuditEvidence,
  loadAuditExpectation,
  normalizeAuditDocument,
  validateAuditExpectation,
} from "../../scripts/security/dependency-evidence.mjs"

const testDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDir, "../..")
const baselinePath = resolve(testDir, "fixtures/audit-baseline.json")
const providerOnlyPath = resolve(testDir, "fixtures/audit-provider-utils-only.json")

describe("audit expectation fixtures", () => {
  it("binds the exact reviewed full and production multisets", async () => {
    const expectation = await loadAuditExpectation(baselinePath, { root: repositoryRoot })
    expect(expectation.full.records).toHaveLength(30)
    expect(expectation.production.records).toHaveLength(27)
    expect(expectation.full.muted).toEqual([])
    expect(expectation.production.muted).toEqual([])
    expect(countSeverity(expectation.full.records)).toEqual({
      critical: 0,
      high: 13,
      info: 0,
      low: 5,
      moderate: 12,
    })
    expect(countSeverity(expectation.production.records)).toEqual({
      critical: 0,
      high: 10,
      info: 0,
      low: 5,
      moderate: 12,
    })
  })

  it("pins the after-state to provider-utils only in both modes", async () => {
    const expectation = await loadAuditExpectation(providerOnlyPath, { root: repositoryRoot })
    expect(expectation.full).toEqual(expectation.production)
    expect(expectation.full.records).toEqual([
      {
        ghsa: "GHSA-866g-f22w-33x8",
        package: "@ai-sdk/provider-utils",
        severity: "low",
        version: "3.0.28",
      },
    ])
  })

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
          { ghsa: "GHSA-2345-6789-cfgh", package: "x", severity: "high", version: "1" },
          { ghsa: "GHSA-2345-6789-cfgh", package: "x", severity: "high", version: "1" },
        ],
      },
      production: { muted: [], records: [] },
    },
  ])("rejects malformed, muted, or duplicate fixture %#", (value) => {
    expect(() => validateAuditExpectation(value)).toThrow(/UNPROVABLE/u)
  })

  it("rejects a fixture path outside the repository and a symlink", async ({ task }) => {
    await expect(
      loadAuditExpectation("/tmp/outside.json", { root: repositoryRoot }),
    ).rejects.toThrow(/UNPROVABLE/u)
    const link = resolve(testDir, `fixtures/${task.id}.json`)
    await symlink(providerOnlyPath, link)
    try {
      await expect(loadAuditExpectation(link, { root: repositoryRoot })).rejects.toThrow(
        /UNPROVABLE/u,
      )
    } finally {
      await import("node:fs/promises").then(({ unlink }) => unlink(link))
    }
  })
})

describe("dependency audit normalization", () => {
  it("normalizes an exact finding exit into a redacted identity receipt", () => {
    const expectation = mode([
      {
        ghsa: "GHSA-2345-6789-cfgh",
        package: "example",
        severity: "high",
        version: "1.2.3",
      },
    ])
    expect(normalizeAuditDocument(auditDocument(expectation), expectation, 1)).toEqual({
      exitCode: 1,
      muted: [],
      records: expectation.records,
      severityTotals: { critical: 0, high: 1, info: 0, low: 0, moderate: 0 },
      status: "findings",
    })
  })

  it("accepts exit zero only for an exact empty mode", () => {
    const expectation = mode([])
    expect(normalizeAuditDocument(auditDocument(expectation), expectation, 0).status).toBe(
      "clean",
    )
    expect(() => normalizeAuditDocument(auditDocument(expectation), expectation, 1)).toThrow(
      /UNPROVABLE: AUDIT_EXIT_MISMATCH/u,
    )
  })

  it.each([
    ["exit 0 with findings", (doc: any) => doc, 0],
    ["exit 2", (doc: any) => doc, 2],
    ["error envelope", (doc: any) => ({ ...doc, error: { code: "ERR" } }), 1],
    ["missing muted", (doc: any) => without(doc, "muted"), 1],
    ["nonempty muted", (doc: any) => ({ ...doc, muted: [{ id: 1 }] }), 1],
    [
      "missing GHSA",
      (doc: any) => {
        const changed = structuredClone(doc)
        delete changed.advisories["1"].github_advisory_id
        return changed
      },
      1,
    ],
    [
      "missing version",
      (doc: any) => {
        const changed = structuredClone(doc)
        delete changed.advisories["1"].findings[0].version
        return changed
      },
      1,
    ],
    [
      "duplicate identity",
      (doc: any) => ({
        ...doc,
        advisories: { ...doc.advisories, "2": structuredClone(doc.advisories["1"]) },
        metadata: {
          vulnerabilities: { critical: 0, high: 2, info: 0, low: 0, moderate: 0 },
        },
      }),
      1,
    ],
    [
      "contradictory totals",
      (doc: any) => ({
        ...doc,
        metadata: {
          vulnerabilities: { critical: 0, high: 0, info: 0, low: 1, moderate: 0 },
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
          vulnerabilities: { critical: 0, high: 0, info: 0, low: 0, moderate: 1 },
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
    ])
    expect(() =>
      normalizeAuditDocument(mutate(auditDocument(expectation)), expectation, exitCode),
    ).toThrow(/UNPROVABLE/u)
  })
})

describe("fixed audit subprocess contract", () => {
  it("uses exact full/production argv under one deadline", async () => {
    const expectation = validateAuditExpectation({
      schemaVersion: 1,
      full: mode([]),
      production: mode([]),
    })
    const observed: unknown[] = []
    let clock = 100
    const result = await collectAuditEvidence({
      cwd: repositoryRoot,
      expectation,
      maxBytes: 4096,
      now: () => clock,
      runProcess: async (request: unknown) => {
        observed.push(request)
        clock += 25
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(auditDocument(mode([]))),
        }
      },
      timeoutMs: 100,
    })
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
    ])
    expect(result.full.status).toBe("clean")
    expect(result.production.status).toBe("clean")
    for (const request of observed as Array<{ env: Record<string, string> }>) {
      expect(request.env.GH_TOKEN).toBeUndefined()
      expect(request.env.GITHUB_TOKEN).toBeUndefined()
      expect(request.env.NPM_TOKEN).toBeUndefined()
      expect(request.env.NODE_AUTH_TOKEN).toBeUndefined()
    }
  })

  it("rejects malformed JSON and a shared-deadline boundary", async () => {
    const expectation = validateAuditExpectation({
      schemaVersion: 1,
      full: mode([]),
      production: mode([]),
    })
    await expect(
      collectAuditEvidence({
        cwd: repositoryRoot,
        expectation,
        runProcess: async () => ({ exitCode: 0, stderr: "npm_token_secret", stdout: "{" }),
      }),
    ).rejects.toThrow(/UNPROVABLE: MALFORMED_AUDIT_JSON/u)

    let calls = 0
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
    ).rejects.toThrow(/UNPROVABLE: AUDIT_TIMEOUT/u)
  })

  it("keeps the checked-in fixture parseable as ordinary JSON", async () => {
    await expect(readFile(baselinePath, "utf8").then(JSON.parse)).resolves.toBeTruthy()
  })
})

function mode(records: Array<Record<string, string>>) {
  return { muted: [], records }
}

function auditDocument(expectation: ReturnType<typeof mode>) {
  const advisories = Object.fromEntries(
    expectation.records.map((record, index) => [
      String(index + 1),
      {
        findings: [{ paths: [`root>${record.package}`], version: record.version }],
        github_advisory_id: record.ghsa,
        module_name: record.package,
        severity: record.severity,
      },
    ]),
  )
  return {
    actions: [],
    advisories,
    metadata: { vulnerabilities: countSeverity(expectation.records) },
    muted: [],
  }
}

function countSeverity(records: Array<Record<string, string>>) {
  const result = { critical: 0, high: 0, info: 0, low: 0, moderate: 0 }
  for (const record of records) result[record.severity as keyof typeof result] += 1
  return result
}

function without<T extends Record<string, unknown>>(value: T, key: keyof T) {
  const copy = { ...value }
  delete copy[key]
  return copy
}
