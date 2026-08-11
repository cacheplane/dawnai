import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

import { afterEach, describe, expect, test, vi } from "vitest"
import {
  ARTIFACT_DIRECTORY,
  assertExactStepAccounting,
  assertProviderAccounting,
  type CompatibilityReport,
  createCompatibilityReport,
  getStepAccountingDiagnostics,
  persistCompatibilityReport,
  REPORT_SCHEMA_VERSION,
  redactSensitive,
  StepAccountingError,
} from "../../scripts/kubernetes-compat/report.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function sequenceClock(...timestamps: readonly string[]): () => Date {
  let index = 0
  return () => {
    const timestamp = timestamps[index]
    index += 1
    if (timestamp === undefined) {
      throw new Error("Deterministic test clock exhausted")
    }
    return new Date(timestamp)
  }
}

function thrownError(action: () => unknown): Error {
  try {
    action()
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
    throw new Error("Expected rejection to be an Error", { cause: error })
  }
  throw new Error("Expected action to throw")
}

function sampleReport(diagnostics?: unknown): CompatibilityReport {
  const report = createCompatibilityReport({
    target: "1.34",
    observedServer: "v1.34.8",
    runId: "run-123",
    clock: sequenceClock("2026-08-10T10:00:00.000Z", "2026-08-10T10:00:01.000Z"),
  })
  return report.finish({
    cleanup: { status: "passed" },
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  })
}

describe("compatibility report steps", () => {
  test("records deterministic passed and failed steps, rethrowing the original failure", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkYXduIn0.signature-value"
    const failure = new Error(`Bearer ${jwt}`)
    const recorder = createCompatibilityReport({
      target: "1.34",
      observedServer: "v1.34.8",
      runId: "run-123",
      clock: sequenceClock(
        "2026-08-10T10:00:00.000Z",
        "2026-08-10T10:00:01.000Z",
        "2026-08-10T10:00:01.250Z",
        "2026-08-10T10:00:02.000Z",
        "2026-08-10T10:00:02.500Z",
        "2026-08-10T10:00:03.000Z",
      ),
    })

    await expect(recorder.runStep("probe.zeta", async () => 42)).resolves.toBe(42)
    await expect(recorder.runStep("probe.alpha", async () => Promise.reject(failure))).rejects.toBe(
      failure,
    )

    const report = recorder.finish({
      cleanup: { status: "passed" },
      diagnostics: { note: "token value must be hidden", harmless: 7 },
    })
    expect(report).toEqual({
      schemaVersion: REPORT_SCHEMA_VERSION,
      target: "1.34",
      observedServer: "v1.34.8",
      runId: "run-123",
      startedAt: "2026-08-10T10:00:00.000Z",
      finishedAt: "2026-08-10T10:00:03.000Z",
      steps: [
        {
          id: "probe.alpha",
          status: "failed",
          startedAt: "2026-08-10T10:00:02.000Z",
          finishedAt: "2026-08-10T10:00:02.500Z",
          durationMs: 500,
          diagnostics: { error: { name: "Error", message: "[REDACTED]" } },
        },
        {
          id: "probe.zeta",
          status: "passed",
          startedAt: "2026-08-10T10:00:01.000Z",
          finishedAt: "2026-08-10T10:00:01.250Z",
          durationMs: 250,
        },
      ],
      cleanup: { status: "passed" },
      diagnostics: { note: "[REDACTED]", harmless: 7 },
    })
  })

  test("reserves explicit step IDs before execution and rejects duplicates", async () => {
    const recorder = createCompatibilityReport({
      target: "1.36",
      observedServer: "v1.36.1",
      runId: "run-duplicate",
      clock: sequenceClock(
        "2026-08-10T10:00:00.000Z",
        "2026-08-10T10:00:01.000Z",
        "2026-08-10T10:00:02.000Z",
      ),
    })
    let release: (() => void) | undefined
    const pending = recorder.runStep(
      "probe.same",
      () =>
        new Promise<void>((resolvePromise) => {
          release = resolvePromise
        }),
    )

    await expect(recorder.runStep("probe.same", async () => undefined)).rejects.toThrow(
      /duplicate step ID.*probe\.same/i,
    )
    release?.()
    await pending
    await expect(recorder.runStep("probe.same", async () => undefined)).rejects.toThrow(
      /duplicate step ID.*probe\.same/i,
    )
  })

  test.each(["", " ", "\n\t"])("rejects empty stable step ID %#", async (id) => {
    const recorder = createCompatibilityReport({
      target: "1.34",
      observedServer: "v1.34.8",
      runId: "run-empty",
      clock: sequenceClock("2026-08-10T10:00:00.000Z"),
    })

    await expect(recorder.runStep(id, async () => undefined)).rejects.toThrow(/step ID.*non-empty/i)
  })
})

describe("exact step accounting", () => {
  test("returns deterministic sorted mismatch diagnostics", () => {
    const expectedIds = [
      "expected.todo",
      "expected.pass",
      "expected.missing",
      "expected.failed",
      "expected.skipped",
      "expected.pending",
    ]
    const observed = [
      { id: "unexpected.zeta", status: "passed" },
      { id: "expected.todo", status: "todo" },
      { id: "expected.pass", status: "passed" },
      { id: "expected.failed", status: "failed" },
      { id: "unexpected.alpha", status: "passed" },
      { id: "expected.skipped", status: "skipped" },
      { id: "expected.pending", status: "pending" },
    ] as const

    const diagnostics = getStepAccountingDiagnostics(expectedIds, observed)
    expect(diagnostics).toEqual({
      missing: ["expected.missing"],
      unexpected: ["unexpected.alpha", "unexpected.zeta"],
      failed: ["expected.failed"],
      skipped: ["expected.skipped"],
      pending: ["expected.pending"],
      todo: ["expected.todo"],
    })

    const error = thrownError(() => assertExactStepAccounting(expectedIds, observed))
    expect(error).toBeInstanceOf(StepAccountingError)
    expect(error.message).toBe(
      [
        "Kubernetes compatibility step accounting failed",
        "missing: expected.missing",
        "unexpected: unexpected.alpha, unexpected.zeta",
        "failed: expected.failed",
        "skipped: expected.skipped",
        "pending: expected.pending",
        "todo: expected.todo",
      ].join("\n"),
    )
  })

  test("accepts only the exact all-passed ID set", () => {
    expect(() =>
      assertExactStepAccounting(
        ["provider.beta", "provider.alpha"],
        [
          { id: "provider.alpha", status: "passed" },
          { id: "provider.beta", status: "passed" },
        ],
      ),
    ).not.toThrow()
  })

  test("rejects an unknown observed status instead of treating it as passed", () => {
    expect(() =>
      getStepAccountingDiagnostics(
        ["provider.alpha"],
        [{ id: "provider.alpha", status: "unknown" } as never],
      ),
    ).toThrow("Unsupported observed status for provider.alpha: unknown")
  })

  test("rejects duplicate expected and observed IDs deterministically", () => {
    expect(() => getStepAccountingDiagnostics(["zeta", "alpha", "zeta", "alpha"], [])).toThrow(
      "Duplicate expected step IDs: alpha, zeta",
    )
    expect(() =>
      getStepAccountingDiagnostics(
        ["alpha"],
        [
          { id: "zeta", status: "passed" },
          { id: "alpha", status: "passed" },
          { id: "zeta", status: "failed" },
          { id: "alpha", status: "failed" },
        ],
      ),
    ).toThrow("Duplicate observed step IDs: alpha, zeta")
  })

  test("provider accounting rejects an empty observed set", () => {
    expect(() =>
      assertProviderAccounting({
        expectedIds: [],
        observed: [],
        suiteCounts: { skipped: 0, pending: 0, todo: 0 },
      }),
    ).toThrow(/observed set must not be empty/i)
  })

  test("provider accounting requires zero skipped, pending, and todo suite counts", () => {
    expect(() =>
      assertProviderAccounting({
        expectedIds: ["provider.alpha"],
        observed: [{ id: "provider.alpha", status: "passed" }],
        suiteCounts: { skipped: 3, pending: 2, todo: 1 },
      }),
    ).toThrow("Provider suite counts must be zero: skipped=3, pending=2, todo=1")
  })

  test("provider accounting accepts a nonempty exact all-passed suite", () => {
    expect(() =>
      assertProviderAccounting({
        expectedIds: ["provider.alpha"],
        observed: [{ id: "provider.alpha", status: "passed" }],
        suiteCounts: { skipped: 0, pending: 0, todo: 0 },
      }),
    ).not.toThrow()
  })
})

describe("report redaction", () => {
  test("recursively redacts sensitive keys and strings while preserving harmless values and types", () => {
    const createdAt = new Date("2026-08-10T10:00:00.000Z")
    const input = {
      harmless: "ready",
      count: 3,
      enabled: true,
      nullable: null,
      nested: {
        apiToken: "plain-value",
        Authorization: "Basic credentials",
        SecretRef: { name: "cluster-secret" },
        kubeconfigPath: "/tmp/private-config",
        environment: { PATH: "/private/bin", HOME: "/private/home" },
        createdAt,
        values: [
          "harmless value",
          "contains token material",
          "Bearer abc.def.ghi",
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkYXduIn0.signature-value",
        ],
      },
    }

    const redacted = redactSensitive(input)

    expect(redacted).toEqual({
      harmless: "ready",
      count: 3,
      enabled: true,
      nullable: null,
      nested: {
        apiToken: "[REDACTED]",
        Authorization: "[REDACTED]",
        SecretRef: "[REDACTED]",
        kubeconfigPath: "[REDACTED]",
        environment: "[REDACTED]",
        createdAt,
        values: ["harmless value", "[REDACTED]", "[REDACTED]", "[REDACTED]"],
      },
    })
    expect(input.nested.apiToken).toBe("plain-value")
    expect((redacted as typeof input).nested.createdAt).toBeInstanceOf(Date)
  })

  test("converts bigint and circular diagnostic graphs to deterministic JSON-safe data", () => {
    const direct: Record<string, unknown> = {
      label: "direct",
      apiToken: "must-not-survive",
    }
    direct.self = direct
    const indirect: Record<string, unknown> = { label: "outer" }
    const nested: Record<string, unknown> = { label: "inner", parent: indirect }
    indirect.nested = nested
    const repeated = { count: 9n }

    const redacted = redactSensitive({
      large: 12_345_678_901_234_567_890n,
      negative: -42n,
      direct,
      indirect,
      repeated: [repeated, repeated],
    })

    expect(redacted).toEqual({
      large: "12345678901234567890",
      negative: "-42",
      direct: {
        label: "direct",
        apiToken: "[REDACTED]",
        self: "[Circular]",
      },
      indirect: {
        label: "outer",
        nested: { label: "inner", parent: "[Circular]" },
      },
      repeated: [{ count: "9" }, { count: "9" }],
    })
    const repeatedResult = (redacted as { repeated: unknown[] }).repeated
    expect(repeatedResult[0]).not.toBe(repeatedResult[1])
    expect(() => JSON.stringify(redacted)).not.toThrow()
  })
})

describe("atomic report persistence", () => {
  test("writes a redacted report beneath the repository artifact directory", async () => {
    const repositoryRoot = await createTemporaryDirectory("dawn-k8s-report-")
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkYXduIn0.signature-value"
    const report: CompatibilityReport = {
      ...sampleReport(),
      diagnostics: {
        harmless: "retained",
        apiToken: "token-value-must-not-persist",
        command: "kubectl --kubeconfig /tmp/private",
        credential: `Bearer ${jwt}`,
        environment: { PATH: "/private/bin", SECRET_VALUE: "environment-dump" },
      },
    }

    const reportPath = await persistCompatibilityReport(repositoryRoot, "run-123.json", report)
    const artifactRoot = resolve(repositoryRoot, ARTIFACT_DIRECTORY)
    const serialized = await readFile(reportPath, "utf8")
    const persisted = JSON.parse(serialized)

    expect(reportPath).toBe(join(artifactRoot, "run-123.json"))
    expect(isAbsolute(reportPath)).toBe(true)
    expect(relative(artifactRoot, reportPath)).toBe("run-123.json")
    expect(persisted).toMatchObject({
      schemaVersion: REPORT_SCHEMA_VERSION,
      target: "1.34",
      observedServer: "v1.34.8",
      runId: "run-123",
      cleanup: { status: "passed" },
      diagnostics: {
        harmless: "retained",
        apiToken: "[REDACTED]",
        command: "[REDACTED]",
        credential: "[REDACTED]",
        environment: "[REDACTED]",
      },
    })
    for (const sensitiveValue of [
      "token-value-must-not-persist",
      "/tmp/private",
      jwt,
      "signature-value",
      "/private/bin",
      "environment-dump",
    ]) {
      expect(serialized).not.toContain(sensitiveValue)
    }
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600)
    expect(await readdir(artifactRoot)).toEqual(["run-123.json"])
  })

  test("persists bigint diagnostics as decimal strings", async () => {
    const repositoryRoot = await createTemporaryDirectory("dawn-k8s-report-bigint-")
    const report: CompatibilityReport = {
      ...sampleReport(),
      diagnostics: { large: 12_345_678_901_234_567_890n, negative: -42n },
    }

    const reportPath = await persistCompatibilityReport(repositoryRoot, "bigint.json", report)
    const persisted = JSON.parse(await readFile(reportPath, "utf8"))

    expect(persisted.diagnostics).toEqual({
      large: "12345678901234567890",
      negative: "-42",
    })
  })

  test("persists direct and indirect circular diagnostics with stable markers", async () => {
    const repositoryRoot = await createTemporaryDirectory("dawn-k8s-report-circular-")
    const direct: Record<string, unknown> = { label: "direct" }
    direct.self = direct
    const indirect: Record<string, unknown> = { label: "outer" }
    const nested: Record<string, unknown> = { label: "inner", parent: indirect }
    indirect.nested = nested
    const report: CompatibilityReport = {
      ...sampleReport(),
      diagnostics: { direct, indirect },
    }

    const reportPath = await persistCompatibilityReport(repositoryRoot, "circular.json", report)
    const persisted = JSON.parse(await readFile(reportPath, "utf8"))

    expect(persisted.diagnostics).toEqual({
      direct: { label: "direct", self: "[Circular]" },
      indirect: {
        label: "outer",
        nested: { label: "inner", parent: "[Circular]" },
      },
    })
  })

  test.each([
    "",
    " ",
    "/tmp/report.json",
    "../report.json",
    "nested/report.json",
    "nested\\report.json",
    "..",
    ".",
  ])("rejects unsafe report filename %#", async (filename) => {
    const repositoryRoot = await createTemporaryDirectory("dawn-k8s-report-path-")

    await expect(
      persistCompatibilityReport(repositoryRoot, filename, sampleReport()),
    ).rejects.toThrow(/filename|absolute|traversal|separator/i)
  })

  test.skipIf(process.platform === "win32")(
    "rejects an artifact-directory symlink that escapes the repository after resolution",
    async () => {
      const repositoryRoot = await createTemporaryDirectory("dawn-k8s-report-symlink-")
      const outside = await createTemporaryDirectory("dawn-k8s-report-outside-")
      const artifactParent = join(repositoryRoot, "artifacts", "testing")
      await mkdir(artifactParent, { recursive: true })
      await symlink(outside, join(artifactParent, "kubernetes-compat"), "dir")

      await expect(
        persistCompatibilityReport(repositoryRoot, "report.json", sampleReport()),
      ).rejects.toThrow(/artifact directory.*repository/i)
      expect(await readdir(outside)).toEqual([])
    },
  )

  test("preserves an existing report and removes the sibling temp file after atomic failure", async () => {
    const repositoryRoot = await createTemporaryDirectory("dawn-k8s-report-failure-")
    const artifactRoot = resolve(repositoryRoot, ARTIFACT_DIRECTORY)
    const reportPath = join(artifactRoot, "existing.json")
    await mkdir(artifactRoot, { recursive: true })
    await writeFile(reportPath, "existing-report\n", { mode: 0o600 })
    const rename = vi.fn(async () => Promise.reject(new Error("simulated rename failure")))

    await expect(
      persistCompatibilityReport(repositoryRoot, "existing.json", sampleReport(), {
        rename,
        tempId: () => "controlled-temp-id",
      }),
    ).rejects.toThrow("simulated rename failure")

    await expect(readFile(reportPath, "utf8")).resolves.toBe("existing-report\n")
    expect(rename).toHaveBeenCalledTimes(1)
    expect(await readdir(artifactRoot)).toEqual(["existing.json"])
  })
})
