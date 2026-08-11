import { randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

export const REPORT_SCHEMA_VERSION = 1 as const
export const ARTIFACT_DIRECTORY = "artifacts/testing/kubernetes-compat"

export type RecordedStepStatus = "passed" | "failed"
export type AccountedStepStatus = RecordedStepStatus | "skipped" | "pending" | "todo"
export type CleanupStatus = "passed" | "failed" | "skipped"

export interface RecordedStep {
  readonly id: string
  readonly status: RecordedStepStatus
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly diagnostics?: unknown
}

export interface CleanupResult {
  readonly status: CleanupStatus
  readonly diagnostics?: unknown
}

export interface CompatibilityReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION
  readonly target: string
  readonly observedServer: string
  readonly runId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly steps: readonly RecordedStep[]
  readonly cleanup: CleanupResult
  readonly diagnostics?: unknown
}

export interface CompatibilityReportOptions {
  readonly target: string
  readonly observedServer: string
  readonly runId: string
  readonly clock?: () => Date
}

export interface FinishReportOptions {
  readonly cleanup: CleanupResult
  readonly diagnostics?: unknown
}

export interface CompatibilityReportRecorder {
  runStep<T>(id: string, operation: () => T | Promise<T>): Promise<T>
  finish(options: FinishReportOptions): CompatibilityReport
}

export interface AccountedStep {
  readonly id: string
  readonly status: AccountedStepStatus
}

export interface StepAccountingDiagnostics {
  readonly missing: readonly string[]
  readonly unexpected: readonly string[]
  readonly failed: readonly string[]
  readonly skipped: readonly string[]
  readonly pending: readonly string[]
  readonly todo: readonly string[]
}

export interface ProviderAccountingInput {
  readonly expectedIds: readonly string[]
  readonly observed: readonly AccountedStep[]
  readonly suiteCounts: {
    readonly skipped: number
    readonly pending: number
    readonly todo: number
  }
}

export type ProviderPhase = "provider-before-upgrade" | "provider-after-upgrade"

export interface VitestProviderAccountingOptions {
  readonly reportPath: string
  readonly manifestPath: string
  readonly phase: ProviderPhase
}

export interface ReportPersistenceDependencies {
  readonly rename?: (oldPath: string, newPath: string) => Promise<void>
  readonly tempId?: () => string
}

const REDACTED = "[REDACTED]"
const CIRCULAR = "[Circular]"
const SENSITIVE_KEY_PATTERN =
  /(?:token|authorization|secret|kubeconfig|^env$|environment|processenv)/i
const SENSITIVE_STRING_PATTERN =
  /(?:token|authorization|secret|kubeconfig|bearer\s+\S+|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,})/i
const ACCOUNTING_CATEGORIES = [
  "missing",
  "unexpected",
  "failed",
  "skipped",
  "pending",
  "todo",
] as const
const ACCOUNTED_STEP_STATUSES = new Set<AccountedStepStatus>([
  "passed",
  "failed",
  "skipped",
  "pending",
  "todo",
])
const PROVIDER_PHASES = ["provider-before-upgrade", "provider-after-upgrade"] as const
const PROVIDER_PHASE_SET = new Set<string>(PROVIDER_PHASES)

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function expectNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function readClock(clock: () => Date): Date {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Report clock must return a valid Date")
  }
  return value
}

function durationMs(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime())
}

function redactValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return SENSITIVE_STRING_PATTERN.test(value) ? REDACTED : value
  }
  if (typeof value === "bigint") {
    return value.toString(10)
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value
  }
  if (value instanceof Date) {
    return new Date(value.getTime())
  }
  if (Buffer.isBuffer(value)) {
    return SENSITIVE_STRING_PATTERN.test(value.toString("utf8")) ? REDACTED : Buffer.from(value)
  }
  if (typeof value !== "object") {
    return String(value)
  }

  if (ancestors.has(value)) {
    return CIRCULAR
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors))
    }

    const redacted: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(item, ancestors)
    }
    return redacted
  } finally {
    ancestors.delete(value)
  }
}

export function redactSensitive(value: unknown): unknown {
  return redactValue(value, new WeakSet())
}

function errorDiagnostics(error: unknown): unknown {
  if (error instanceof Error) {
    return redactSensitive({ error: { name: error.name, message: error.message } })
  }
  return redactSensitive({ error })
}

class DefaultCompatibilityReportRecorder implements CompatibilityReportRecorder {
  readonly #target: string
  readonly #observedServer: string
  readonly #runId: string
  readonly #clock: () => Date
  readonly #startedAt: Date
  readonly #stepIds = new Set<string>()
  readonly #steps: RecordedStep[] = []
  #activeSteps = 0
  #finished = false

  constructor(options: CompatibilityReportOptions) {
    this.#target = expectNonEmptyString(options.target, "Report target")
    this.#observedServer = expectNonEmptyString(options.observedServer, "Observed server")
    this.#runId = expectNonEmptyString(options.runId, "Report run ID")
    this.#clock = options.clock ?? (() => new Date())
    this.#startedAt = readClock(this.#clock)
  }

  async runStep<T>(id: string, operation: () => T | Promise<T>): Promise<T> {
    if (this.#finished) {
      throw new Error("Cannot record a step after the report is finished")
    }
    const stableId = expectNonEmptyString(id, "Report step ID")
    if (this.#stepIds.has(stableId)) {
      throw new Error(`Duplicate step ID: ${stableId}`)
    }
    this.#stepIds.add(stableId)
    this.#activeSteps += 1
    const startedAt = readClock(this.#clock)

    try {
      const result = await operation()
      const finishedAt = readClock(this.#clock)
      this.#steps.push(
        Object.freeze({
          id: stableId,
          status: "passed",
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: durationMs(startedAt, finishedAt),
        }),
      )
      return result
    } catch (error) {
      const finishedAt = readClock(this.#clock)
      this.#steps.push(
        Object.freeze({
          id: stableId,
          status: "failed",
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: durationMs(startedAt, finishedAt),
          diagnostics: errorDiagnostics(error),
        }),
      )
      throw error
    } finally {
      this.#activeSteps -= 1
    }
  }

  finish(options: FinishReportOptions): CompatibilityReport {
    if (this.#finished) {
      throw new Error("Compatibility report is already finished")
    }
    if (this.#activeSteps !== 0) {
      throw new Error("Cannot finish a compatibility report while steps are running")
    }
    this.#finished = true
    const finishedAt = readClock(this.#clock)
    const steps = Object.freeze(
      [...this.#steps].sort((left, right) => compareStrings(left.id, right.id)),
    )
    const cleanup = Object.freeze({
      status: options.cleanup.status,
      ...(options.cleanup.diagnostics !== undefined
        ? { diagnostics: redactSensitive(options.cleanup.diagnostics) }
        : {}),
    })
    return Object.freeze({
      schemaVersion: REPORT_SCHEMA_VERSION,
      target: this.#target,
      observedServer: this.#observedServer,
      runId: this.#runId,
      startedAt: this.#startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      steps,
      cleanup,
      ...(options.diagnostics !== undefined
        ? { diagnostics: redactSensitive(options.diagnostics) }
        : {}),
    })
  }
}

export function createCompatibilityReport(
  options: CompatibilityReportOptions,
): CompatibilityReportRecorder {
  return new DefaultCompatibilityReportRecorder(options)
}

function duplicateIds(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const id of ids) {
    expectNonEmptyString(id, "Accounting step ID")
    if (seen.has(id)) {
      duplicates.add(id)
    }
    seen.add(id)
  }
  return [...duplicates].sort(compareStrings)
}

function assertNoDuplicateIds(ids: readonly string[], kind: "expected" | "observed"): void {
  const duplicates = duplicateIds(ids)
  if (duplicates.length > 0) {
    throw new Error(`Duplicate ${kind} step IDs: ${duplicates.join(", ")}`)
  }
}

function freezeSorted(values: Iterable<string>): readonly string[] {
  return Object.freeze([...values].sort(compareStrings))
}

export function getStepAccountingDiagnostics(
  expectedIds: readonly string[],
  observed: readonly AccountedStep[],
): StepAccountingDiagnostics {
  assertNoDuplicateIds(expectedIds, "expected")
  assertNoDuplicateIds(
    observed.map((step) => step.id),
    "observed",
  )
  for (const step of observed) {
    if (!ACCOUNTED_STEP_STATUSES.has(step.status)) {
      throw new Error(`Unsupported observed status for ${step.id}: ${String(step.status)}`)
    }
  }
  const expectedSet = new Set(expectedIds)
  const observedSet = new Set(observed.map((step) => step.id))
  const byStatus = (status: Exclude<AccountedStepStatus, "passed">): readonly string[] =>
    freezeSorted(observed.filter((step) => step.status === status).map((step) => step.id))

  return Object.freeze({
    missing: freezeSorted(expectedIds.filter((id) => !observedSet.has(id))),
    unexpected: freezeSorted([...observedSet].filter((id) => !expectedSet.has(id))),
    failed: byStatus("failed"),
    skipped: byStatus("skipped"),
    pending: byStatus("pending"),
    todo: byStatus("todo"),
  })
}

export class StepAccountingError extends Error {
  readonly diagnostics: StepAccountingDiagnostics

  constructor(diagnostics: StepAccountingDiagnostics) {
    const detail = ACCOUNTING_CATEGORIES.filter((category) => diagnostics[category].length > 0).map(
      (category) => `${category}: ${diagnostics[category].join(", ")}`,
    )
    super(["Kubernetes compatibility step accounting failed", ...detail].join("\n"))
    this.name = "StepAccountingError"
    this.diagnostics = diagnostics
  }
}

export function assertExactStepAccounting(
  expectedIds: readonly string[],
  observed: readonly AccountedStep[],
): void {
  const diagnostics = getStepAccountingDiagnostics(expectedIds, observed)
  if (ACCOUNTING_CATEGORIES.some((category) => diagnostics[category].length > 0)) {
    throw new StepAccountingError(diagnostics)
  }
}

function expectNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

export function assertProviderAccounting(input: ProviderAccountingInput): void {
  if (input.observed.length === 0) {
    throw new Error("Provider observed set must not be empty")
  }
  const skipped = expectNonNegativeInteger(input.suiteCounts.skipped, "Provider skipped count")
  const pending = expectNonNegativeInteger(input.suiteCounts.pending, "Provider pending count")
  const todo = expectNonNegativeInteger(input.suiteCounts.todo, "Provider todo count")
  if (skipped !== 0 || pending !== 0 || todo !== 0) {
    throw new Error(
      `Provider suite counts must be zero: skipped=${skipped}, pending=${pending}, todo=${todo}`,
    )
  }
  assertExactStepAccounting(input.expectedIds, input.observed)
}

function expectObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function expectStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`)
  }
  return value.map((item, index) => expectNonEmptyString(item, `${name}[${index}]`))
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${name} must contain valid JSON`, { cause: error })
  }
}

async function readJsonFile(path: string, name: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    const missing =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    throw new Error(`${name} file is ${missing ? "missing" : "unreadable"}: ${path}`, {
      cause: error,
    })
  }
  return parseJson(text, name)
}

function parseExpectedProviderIds(value: unknown, phase: ProviderPhase): readonly string[] {
  const manifest = expectObject(value, "Expected-test manifest")
  const providerPhases = expectObject(
    manifest.providerPhases,
    "Expected-test manifest providerPhases",
  )
  for (const providerPhase of PROVIDER_PHASES) {
    const ids = expectStringArray(
      providerPhases[providerPhase],
      `Expected-test manifest ${providerPhase}`,
    )
    assertNoDuplicateIds(ids, "expected")
  }
  expectStringArray(manifest.probeIds, "Expected-test manifest probeIds")
  return expectStringArray(providerPhases[phase], `Expected-test manifest ${phase}`)
}

function parseVitestProviderReport(value: unknown): {
  readonly observed: readonly AccountedStep[]
  readonly suiteCounts: ProviderAccountingInput["suiteCounts"]
} {
  const report = expectObject(value, "Vitest output")
  if (report.success !== true) {
    throw new Error("Vitest output success must be true")
  }
  if (!Array.isArray(report.testResults)) {
    throw new Error("Vitest output testResults must be an array")
  }

  const observed: AccountedStep[] = []
  for (const [resultIndex, resultValue] of report.testResults.entries()) {
    const result = expectObject(resultValue, `Vitest output testResults[${resultIndex}]`)
    if (!Array.isArray(result.assertionResults)) {
      throw new Error(`Vitest output testResults[${resultIndex}].assertionResults must be an array`)
    }
    for (const [assertionIndex, assertionValue] of result.assertionResults.entries()) {
      const assertionName = `Vitest output testResults[${resultIndex}].assertionResults[${assertionIndex}]`
      const assertion = expectObject(assertionValue, assertionName)
      const id = expectNonEmptyString(assertion.fullName, `${assertionName}.fullName`)
      const status = assertion.status
      if (
        typeof status !== "string" ||
        !ACCOUNTED_STEP_STATUSES.has(status as AccountedStepStatus)
      ) {
        throw new Error(`${assertionName}.status is unsupported: ${String(status)}`)
      }
      observed.push({ id, status: status as AccountedStepStatus })
    }
  }
  if (observed.length === 0) {
    throw new Error("Vitest output assertionResults must not be empty")
  }

  return {
    observed,
    suiteCounts: {
      skipped: expectNonNegativeInteger(
        report.numPendingTestSuites as number,
        "Vitest output numPendingTestSuites",
      ),
      pending: expectNonNegativeInteger(
        report.numPendingTests as number,
        "Vitest output numPendingTests",
      ),
      todo: expectNonNegativeInteger(report.numTodoTests as number, "Vitest output numTodoTests"),
    },
  }
}

export async function assertVitestProviderAccounting(
  options: VitestProviderAccountingOptions,
): Promise<void> {
  if (!PROVIDER_PHASE_SET.has(options.phase)) {
    throw new Error(`Unknown provider phase: ${String(options.phase)}`)
  }
  const phase = options.phase as ProviderPhase
  const [report, manifest] = await Promise.all([
    readJsonFile(options.reportPath, "Vitest output"),
    readJsonFile(options.manifestPath, "Expected-test manifest"),
  ])
  const expectedIds = parseExpectedProviderIds(manifest, phase)
  const parsedReport = parseVitestProviderReport(report)
  assertProviderAccounting({ expectedIds, ...parsedReport })
}

function expectSafeFilename(filename: string): string {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new Error("Report filename must be non-empty")
  }
  if (isAbsolute(filename)) {
    throw new Error("Report filename must not be absolute")
  }
  if (filename === "." || filename === "..") {
    throw new Error("Report filename must not contain traversal")
  }
  if (filename.includes("/") || filename.includes("\\") || filename.includes(sep)) {
    throw new Error("Report filename must not contain a path separator")
  }
  return filename
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate)
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== ".." &&
      !isAbsolute(pathFromParent))
  )
}

function expectSafeTempId(value: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(value)) {
    throw new Error("Report temporary ID must contain only letters, numbers, and hyphens")
  }
  return value
}

function reportForPersistence(report: CompatibilityReport): CompatibilityReport {
  return {
    schemaVersion: report.schemaVersion,
    target: report.target,
    observedServer: report.observedServer,
    runId: report.runId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    steps: report.steps.map((step) => ({
      id: step.id,
      status: step.status,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      durationMs: step.durationMs,
      ...(step.diagnostics !== undefined ? { diagnostics: redactSensitive(step.diagnostics) } : {}),
    })),
    cleanup: {
      status: report.cleanup.status,
      ...(report.cleanup.diagnostics !== undefined
        ? { diagnostics: redactSensitive(report.cleanup.diagnostics) }
        : {}),
    },
    ...(report.diagnostics !== undefined
      ? { diagnostics: redactSensitive(report.diagnostics) }
      : {}),
  }
}

export async function persistCompatibilityReport(
  repositoryRoot: string,
  filename: string,
  report: CompatibilityReport,
  dependencies: ReportPersistenceDependencies = {},
): Promise<string> {
  const safeFilename = expectSafeFilename(filename)
  const root = resolve(repositoryRoot)
  const artifactRoot = resolve(root, ARTIFACT_DIRECTORY)
  const reportPath = resolve(artifactRoot, safeFilename)
  if (!isWithin(root, artifactRoot) || !isWithin(artifactRoot, reportPath)) {
    throw new Error("Resolved report path escapes the repository artifact directory")
  }

  await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  const [realRoot, realArtifactRoot] = await Promise.all([realpath(root), realpath(artifactRoot)])
  if (!isWithin(realRoot, realArtifactRoot)) {
    throw new Error("Resolved artifact directory escapes the repository")
  }

  const tempId = expectSafeTempId((dependencies.tempId ?? randomUUID)())
  const temporaryPath = resolve(artifactRoot, `.${safeFilename}.${tempId}.tmp`)
  if (!isWithin(artifactRoot, temporaryPath)) {
    throw new Error("Resolved temporary report path escapes the artifact directory")
  }

  const serialized = `${JSON.stringify(reportForPersistence(report), null, 2)}\n`
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await (dependencies.rename ?? rename)(temporaryPath, reportPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  return reportPath
}
