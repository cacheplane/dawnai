import { randomUUID } from "node:crypto"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  type ClusterNames,
  type ClusterPreflightInput,
  type ClusterPreflightResult,
  captureNamespaceOwnership,
  cleanupOwnedCluster,
  createSecureTokenKubeconfig,
  deriveClusterNames,
  type InstalledReleaseRole,
  type NamespaceOwnership,
  type OwnedClusterCleanupInput,
  preflightCluster,
  registerOwnedResourceSignalCleanup,
  requestServiceAccountToken,
  type SecureTokenKubeconfig,
  type SecureTokenKubeconfigInput,
  type SignalCleanupOptions,
  type SignalCleanupRegistration,
} from "./cluster.js"
import {
  type CommandExecutionOptions,
  type CommandExecutor,
  type CommandResult,
  executeCommand,
  helm,
  kubectl,
} from "./command.js"
import {
  type AdministrativePermissionPreflightInput,
  assertAdministrativePermissions,
} from "./permissions.js"
import { type CompatibilityPolicy, getTargetByMinor, loadCompatibilityPolicy } from "./policy.js"
import {
  installApplicationChart,
  installInfrastructureChart,
  KUBERNETES_COMPAT_PROBE_IDS,
  type NetworkControlLease,
  type ProbeCommandRunner,
  runApplicationServiceReadyProbe,
  runLimitRangeProbe,
  runNetworkControlProbe,
  runOutsideNamespaceDeniedProbe,
  runReaperLifecycleProbe,
  runResourceQuotaProbe,
  runRestrictedAdmissionProbe,
  runRoleMutationDeniedProbe,
  runSandboxSecretsEmptyProbe,
  runSecretReadDeniedProbe,
  upgradeApplicationChart,
  upgradeInfrastructureChart,
} from "./probes.js"
import {
  type AccountedStep,
  assertExactStepAccounting,
  type CleanupResult,
  type CompatibilityReport,
  type CompatibilityReportRecorder,
  createCompatibilityReport,
  createVitestProviderAccountingSession,
  persistCompatibilityReport,
  redactSensitive,
  type VitestProviderAccountingSession,
} from "./report.js"

export const KUBERNETES_COMPAT_USAGE = `Usage:
  pnpm verify:k8s:compat -- --target <1.34|1.35|1.36> --context <exact-context> [--storage-class <name>] [--keep-on-failure]
  pnpm verify:k8s:compat -- --help
`

const DEFAULT_REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const DEFAULT_EXPECTED_TESTS_PATH = resolve(
  DEFAULT_REPOSITORY_ROOT,
  "test/k8s-compat/expected-tests.json",
)
const SUPPORTED_TARGETS = new Set(["1.34", "1.35", "1.36"])
const RUN_LABEL = "dawn.sh/compat-run"
const ORCHESTRATOR_SERVICE_ACCOUNT = "dawn-orchestrator"
const PROVIDER_TIMEOUT_MS = 12 * 60 * 1_000
const PROVIDER_STDOUT_LIMIT_BYTES = 64 * 1_024
const PROVIDER_STDERR_LIMIT_BYTES = 1024 * 1_024
const NAMESPACE_COMMAND_TIMEOUT_MS = 30_000
const NAMESPACE_STDOUT_LIMIT_BYTES = 256 * 1_024
const DIAGNOSTIC_TIMEOUT_MS = 20_000
const DIAGNOSTIC_STDOUT_LIMIT_BYTES = 512 * 1_024
const DIAGNOSTIC_STDERR_LIMIT_BYTES = 64 * 1_024

export interface KubernetesCompatibilityOptions {
  readonly target: string
  readonly context: string
  readonly storageClass?: string
  readonly keepOnFailure?: boolean
}

export type ParsedKubernetesCompatibilityArgs =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly options: KubernetesCompatibilityOptions }

export interface KubernetesCompatibilityRunResult {
  readonly runId: string
  readonly reportPath: string
  readonly report: CompatibilityReport
}

export interface KubernetesCompatibilityProbeDependencies {
  readonly installInfrastructure: typeof installInfrastructureChart
  readonly upgradeInfrastructure: typeof upgradeInfrastructureChart
  readonly installApplication: typeof installApplicationChart
  readonly upgradeApplication: typeof upgradeApplicationChart
  readonly sandboxSecretsEmpty: typeof runSandboxSecretsEmptyProbe
  readonly networkControl: typeof runNetworkControlProbe
  readonly resourceQuota: typeof runResourceQuotaProbe
  readonly limitRange: typeof runLimitRangeProbe
  readonly restrictedAdmission: typeof runRestrictedAdmissionProbe
  readonly secretReadDenied: typeof runSecretReadDeniedProbe
  readonly roleMutationDenied: typeof runRoleMutationDeniedProbe
  readonly outsideNamespaceDenied: typeof runOutsideNamespaceDeniedProbe
  readonly reaperLifecycle: typeof runReaperLifecycleProbe
  readonly applicationServiceReady: typeof runApplicationServiceReadyProbe
}

export interface CompatibilityDiagnosticsInput {
  readonly context: string
  readonly runId: string
  readonly names: ClusterNames
  readonly ownership: readonly NamespaceOwnership[]
  readonly attemptedReleases: readonly InstalledReleaseRole[]
  readonly execute: CommandExecutor
}

export interface KubernetesCompatibilityHarnessDependencies {
  readonly repositoryRoot?: string
  readonly expectedTestsPath?: string
  readonly createRunId?: () => string
  readonly loadPolicy?: () => Promise<CompatibilityPolicy>
  readonly execute?: CommandExecutor
  readonly executableExists?: (name: string) => Promise<boolean>
  readonly preflight?: (input: ClusterPreflightInput) => Promise<ClusterPreflightResult>
  readonly assertPermissions?: (input: AdministrativePermissionPreflightInput) => Promise<unknown>
  readonly requestToken?: (
    input: {
      readonly context: string
      readonly namespace: string
      readonly serviceAccount: string
    },
    execute?: CommandExecutor,
  ) => Promise<string>
  readonly createTokenKubeconfig?: (
    input: SecureTokenKubeconfigInput,
  ) => Promise<SecureTokenKubeconfig>
  readonly createProviderAccountingSession?: (input: {
    readonly manifestPath: string
  }) => Promise<VitestProviderAccountingSession>
  readonly assertStepAccounting?: (
    expectedIds: readonly string[],
    observed: readonly AccountedStep[],
  ) => void
  readonly persistReport?: (
    repositoryRoot: string,
    filename: string,
    report: CompatibilityReport,
  ) => Promise<string>
  readonly collectDiagnostics?: (input: CompatibilityDiagnosticsInput) => Promise<unknown>
  readonly cleanupCluster?: (
    input: OwnedClusterCleanupInput,
  ) => Promise<{ readonly retained: boolean }>
  readonly registerSignalCleanup?: typeof registerOwnedResourceSignalCleanup
  readonly signalCleanupOptions?: SignalCleanupOptions
  readonly probes?: Partial<KubernetesCompatibilityProbeDependencies>
  readonly clock?: () => Date
}

export interface KubernetesCompatibilityMainDependencies
  extends KubernetesCompatibilityHarnessDependencies {
  readonly writeStdout?: (chunk: string) => void
  readonly writeStderr?: (chunk: string) => void
}

interface ResolvedHarnessDependencies {
  readonly repositoryRoot: string
  readonly expectedTestsPath: string
  readonly createRunId: () => string
  readonly loadPolicy: () => Promise<CompatibilityPolicy>
  readonly execute: CommandExecutor
  readonly preflight: (input: ClusterPreflightInput) => Promise<ClusterPreflightResult>
  readonly assertPermissions: (input: AdministrativePermissionPreflightInput) => Promise<unknown>
  readonly requestToken: NonNullable<KubernetesCompatibilityHarnessDependencies["requestToken"]>
  readonly createTokenKubeconfig: NonNullable<
    KubernetesCompatibilityHarnessDependencies["createTokenKubeconfig"]
  >
  readonly createProviderAccountingSession: NonNullable<
    KubernetesCompatibilityHarnessDependencies["createProviderAccountingSession"]
  >
  readonly assertStepAccounting: NonNullable<
    KubernetesCompatibilityHarnessDependencies["assertStepAccounting"]
  >
  readonly persistReport: NonNullable<KubernetesCompatibilityHarnessDependencies["persistReport"]>
  readonly collectDiagnostics: NonNullable<
    KubernetesCompatibilityHarnessDependencies["collectDiagnostics"]
  >
  readonly cleanupCluster: NonNullable<KubernetesCompatibilityHarnessDependencies["cleanupCluster"]>
  readonly registerSignalCleanup: typeof registerOwnedResourceSignalCleanup
  readonly signalCleanupOptions: SignalCleanupOptions
  readonly probes: KubernetesCompatibilityProbeDependencies
  readonly clock?: () => Date
}

interface CleanupExecution {
  readonly result: CleanupResult
  readonly error?: Error
}

interface DiagnosticRequest {
  readonly id: string
  readonly command: ReturnType<typeof kubectl.command> | ReturnType<typeof helm.command>
  readonly format: "json" | "text"
}

interface DiagnosticResult {
  readonly id: string
  readonly status: "passed" | "failed"
  readonly output?: unknown
  readonly error?: unknown
}

export class KubernetesCompatibilityUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KubernetesCompatibilityUsageError"
  }
}

export class KubernetesCompatibilityRunError extends Error {
  readonly reportPath?: string

  constructor(cause: unknown, reportPath?: string) {
    super(primaryErrorMessage(cause), {
      cause: cause instanceof Error ? cause : new Error(String(cause)),
    })
    this.name = "KubernetesCompatibilityRunError"
    if (reportPath !== undefined) this.reportPath = reportPath
  }
}

function expectCliValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
    throw new KubernetesCompatibilityUsageError(`Missing value for flag: ${flag}`)
  }
  return value
}

export function parseKubernetesCompatibilityArgs(
  argv: readonly string[],
): ParsedKubernetesCompatibilityArgs {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) {
    throw new KubernetesCompatibilityUsageError("Arguments must be strings")
  }

  const values = new Map<string, string>()
  const booleans = new Set<string>()
  const valueFlags = new Set(["--target", "--context", "--storage-class"])
  const booleanFlags = new Set(["--keep-on-failure", "--help"])

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string
    if (!flag.startsWith("--")) {
      throw new KubernetesCompatibilityUsageError(`Unexpected positional argument: ${flag}`)
    }
    if (!valueFlags.has(flag) && !booleanFlags.has(flag)) {
      throw new KubernetesCompatibilityUsageError(`Unknown flag: ${flag}`)
    }
    if (values.has(flag) || booleans.has(flag)) {
      throw new KubernetesCompatibilityUsageError(`Duplicate flag: ${flag}`)
    }
    if (booleanFlags.has(flag)) {
      booleans.add(flag)
      continue
    }
    const value = expectCliValue(argv, index, flag)
    values.set(flag, value)
    index += 1
  }

  if (booleans.has("--help")) {
    if (argv.length !== 1) {
      throw new KubernetesCompatibilityUsageError("--help must be used alone")
    }
    return Object.freeze({ kind: "help" })
  }

  const target = values.get("--target")
  if (target === undefined) {
    throw new KubernetesCompatibilityUsageError("Missing required flag: --target")
  }
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new KubernetesCompatibilityUsageError(`Unsupported target value: ${target}`)
  }
  const context = values.get("--context")
  if (context === undefined) {
    throw new KubernetesCompatibilityUsageError("Missing required flag: --context")
  }
  const storageClass = values.get("--storage-class")
  return Object.freeze({
    kind: "run",
    options: Object.freeze({
      target,
      context,
      ...(storageClass !== undefined ? { storageClass } : {}),
      ...(booleans.has("--keep-on-failure") ? { keepOnFailure: true } : {}),
    }),
  })
}

function resolveDependencies(
  dependencies: KubernetesCompatibilityHarnessDependencies,
): ResolvedHarnessDependencies {
  const repositoryRoot = resolve(dependencies.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT)
  const expectedTestsPath = resolve(dependencies.expectedTestsPath ?? DEFAULT_EXPECTED_TESTS_PATH)
  const execute = dependencies.execute ?? executeCommand
  const probes: KubernetesCompatibilityProbeDependencies = {
    installInfrastructure: installInfrastructureChart,
    upgradeInfrastructure: upgradeInfrastructureChart,
    installApplication: installApplicationChart,
    upgradeApplication: upgradeApplicationChart,
    sandboxSecretsEmpty: runSandboxSecretsEmptyProbe,
    networkControl: runNetworkControlProbe,
    resourceQuota: runResourceQuotaProbe,
    limitRange: runLimitRangeProbe,
    restrictedAdmission: runRestrictedAdmissionProbe,
    secretReadDenied: runSecretReadDeniedProbe,
    roleMutationDenied: runRoleMutationDeniedProbe,
    outsideNamespaceDenied: runOutsideNamespaceDeniedProbe,
    reaperLifecycle: runReaperLifecycleProbe,
    applicationServiceReady: runApplicationServiceReadyProbe,
    ...dependencies.probes,
  }

  return {
    repositoryRoot,
    expectedTestsPath,
    createRunId: dependencies.createRunId ?? randomUUID,
    loadPolicy: dependencies.loadPolicy ?? (() => loadCompatibilityPolicy()),
    execute,
    preflight:
      dependencies.preflight ??
      ((input) =>
        preflightCluster(input, {
          execute,
          ...(dependencies.executableExists !== undefined
            ? { executableExists: dependencies.executableExists }
            : {}),
        })),
    assertPermissions:
      dependencies.assertPermissions ??
      ((input) => assertAdministrativePermissions(input, execute)),
    requestToken:
      dependencies.requestToken ??
      ((input, commandExecutor = execute) => requestServiceAccountToken(input, commandExecutor)),
    createTokenKubeconfig:
      dependencies.createTokenKubeconfig ?? ((input) => createSecureTokenKubeconfig(input)),
    createProviderAccountingSession:
      dependencies.createProviderAccountingSession ?? createVitestProviderAccountingSession,
    assertStepAccounting: dependencies.assertStepAccounting ?? assertExactStepAccounting,
    persistReport: dependencies.persistReport ?? persistCompatibilityReport,
    collectDiagnostics:
      dependencies.collectDiagnostics ?? collectKubernetesCompatibilityDiagnostics,
    cleanupCluster: dependencies.cleanupCluster ?? ((input) => cleanupOwnedCluster(input, execute)),
    registerSignalCleanup: dependencies.registerSignalCleanup ?? registerOwnedResourceSignalCleanup,
    signalCleanupOptions: dependencies.signalCleanupOptions ?? {},
    probes,
    ...(dependencies.clock !== undefined ? { clock: dependencies.clock } : {}),
  }
}

function expectNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function validateRunOptions(options: KubernetesCompatibilityOptions): void {
  expectNonEmpty(options.target, "Kubernetes target")
  expectNonEmpty(options.context, "Kubernetes context")
  if (!SUPPORTED_TARGETS.has(options.target)) {
    throw new Error(`Unsupported Kubernetes target: ${options.target}`)
  }
  if (options.storageClass !== undefined) {
    expectNonEmpty(options.storageClass, "StorageClass override")
  }
  if (options.keepOnFailure !== undefined && options.keepOnFailure !== true) {
    throw new Error("keepOnFailure must be true when supplied")
  }
}

function assertPreflightNames(observed: ClusterNames, expected: ClusterNames): void {
  for (const key of Object.keys(expected) as (keyof ClusterNames)[]) {
    if (observed[key] !== expected[key]) {
      throw new Error(`Cluster preflight returned a non-derived ${key}`)
    }
  }
}

function parseCommandJson(result: CommandResult, name: string): unknown {
  try {
    return JSON.parse(result.stdout.toString("utf8"))
  } catch (cause) {
    throw new Error(`${name} returned invalid JSON`, { cause })
  }
}

function normalizeError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback, { cause })
}

function aggregateErrors(errors: readonly unknown[], message: string): Error | undefined {
  const normalized = errors.map((error) => normalizeError(error, message))
  if (normalized.length === 0) return undefined
  if (normalized.length === 1) return normalized[0]
  return new AggregateError(normalized, message)
}

function primaryErrorMessage(cause: unknown): string {
  if (cause instanceof AggregateError) {
    const first = cause.errors[0]
    return first === undefined ? cause.message : primaryErrorMessage(first)
  }
  return cause instanceof Error ? cause.message : String(cause)
}

function errorDiagnostics(cause: unknown): unknown {
  if (cause instanceof AggregateError) {
    return redactSensitive({
      name: cause.name,
      message: cause.message,
      errors: cause.errors.map(errorDiagnostics),
    })
  }
  if (cause instanceof Error) {
    return redactSensitive({ name: cause.name, message: cause.message })
  }
  return redactSensitive({ message: String(cause) })
}

function namespaceCommandOptions(stdin?: string): CommandExecutionOptions {
  return {
    timeoutMs: NAMESPACE_COMMAND_TIMEOUT_MS,
    stdoutLimitBytes: NAMESPACE_STDOUT_LIMIT_BYTES,
    stderrLimitBytes: DIAGNOSTIC_STDERR_LIMIT_BYTES,
    ...(stdin !== undefined ? { stdin } : {}),
  }
}

function diagnosticCommandOptions(): CommandExecutionOptions {
  return {
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    stdoutLimitBytes: DIAGNOSTIC_STDOUT_LIMIT_BYTES,
    stderrLimitBytes: DIAGNOSTIC_STDERR_LIMIT_BYTES,
  }
}

function diagnosticOutput(result: CommandResult, format: DiagnosticRequest["format"]): unknown {
  const text = result.stdout.toString("utf8")
  if (format === "text") return redactSensitive(text)
  try {
    return redactSensitive(JSON.parse(text))
  } catch {
    return redactSensitive(text)
  }
}

const DIAGNOSTIC_POD_NAME_PATTERN =
  /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/

function diagnosticPodNames(result: CommandResult, namespace: string): readonly string[] {
  const value = parseCommandJson(result, `Pod list for Namespace ${namespace}`)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Pod list for Namespace ${namespace} must be an object`)
  }
  const items = (value as { readonly items?: unknown }).items
  if (!Array.isArray(items)) {
    throw new Error(`Pod list for Namespace ${namespace} must contain items`)
  }
  const names = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Pod list item ${index} for Namespace ${namespace} must be an object`)
    }
    const metadata = (item as { readonly metadata?: unknown }).metadata
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      throw new Error(`Pod list item ${index} for Namespace ${namespace} is missing metadata`)
    }
    const podName = (metadata as { readonly name?: unknown }).name
    const podNamespace = (metadata as { readonly namespace?: unknown }).namespace
    if (
      typeof podName !== "string" ||
      podName.length > 253 ||
      !DIAGNOSTIC_POD_NAME_PATTERN.test(podName)
    ) {
      throw new Error(`Pod list item ${index} for Namespace ${namespace} has an invalid name`)
    }
    if (podNamespace !== namespace) {
      throw new Error(`Pod list item ${podName} does not belong to Namespace ${namespace}`)
    }
    names.add(podName)
  }
  return Object.freeze([...names])
}

async function settleDiagnosticRequests(
  requests: readonly DiagnosticRequest[],
  execute: CommandExecutor,
): Promise<DiagnosticResult[]> {
  const settled = await Promise.allSettled(
    requests.map(async (request): Promise<DiagnosticResult> => {
      const commandResult = await execute(request.command, diagnosticCommandOptions())
      return Object.freeze({
        id: request.id,
        status: "passed",
        output: diagnosticOutput(commandResult, request.format),
      })
    }),
  )
  return settled.map((outcome, index): DiagnosticResult => {
    const request = requests[index]
    const id = request?.id ?? `diagnostic-${index}`
    return outcome.status === "fulfilled"
      ? outcome.value
      : Object.freeze({ id, status: "failed", error: errorDiagnostics(outcome.reason) })
  })
}

export async function collectKubernetesCompatibilityDiagnostics(
  input: CompatibilityDiagnosticsInput,
): Promise<readonly DiagnosticResult[]> {
  const ownedNames = new Set(input.ownership.map(({ name }) => name))
  const ownedNamespaces = [input.names.managementNamespace, input.names.sandboxNamespace].filter(
    (namespace) => ownedNames.has(namespace),
  )
  const requests: DiagnosticRequest[] = []
  const addNamespaceDiagnostics = (namespace: string, resources: string): void => {
    if (!ownedNames.has(namespace)) return
    requests.push(
      {
        id: `${namespace}.events`,
        command: kubectl.command(input.context, [
          "get",
          "events",
          "--namespace",
          namespace,
          "--output=json",
          "--sort-by=.metadata.creationTimestamp",
        ]),
        format: "json",
      },
      {
        id: `${namespace}.objects`,
        command: kubectl.command(input.context, [
          "get",
          resources,
          "--namespace",
          namespace,
          "--output=json",
        ]),
        format: "json",
      },
      {
        id: `${namespace}.pod-descriptions`,
        command: kubectl.command(input.context, ["describe", "pods", "--namespace", namespace]),
        format: "text",
      },
    )
  }

  addNamespaceDiagnostics(input.names.managementNamespace, "services,deployments,replicasets")
  addNamespaceDiagnostics(
    input.names.sandboxNamespace,
    "services,jobs,cronjobs,resourcequotas,limitranges,networkpolicies,persistentvolumeclaims",
  )

  if (ownedNames.has(input.names.managementNamespace)) {
    for (const role of new Set(input.attemptedReleases)) {
      const release =
        role === "infrastructure" ? input.names.sandboxRelease : input.names.appRelease
      requests.push({
        id: `helm.${role}`,
        command: helm.command(input.context, [
          "status",
          release,
          "--namespace",
          input.names.managementNamespace,
          "--output=json",
        ]),
        format: "json",
      })
    }
  }

  const results = await settleDiagnosticRequests(requests, input.execute)
  const podLists = await Promise.allSettled(
    ownedNamespaces.map(async (namespace) => {
      const commandResult = await input.execute(
        kubectl.command(input.context, ["get", "pods", "--namespace", namespace, "--output=json"]),
        diagnosticCommandOptions(),
      )
      return { namespace, commandResult, names: diagnosticPodNames(commandResult, namespace) }
    }),
  )
  const logRequests: DiagnosticRequest[] = []
  for (const [index, outcome] of podLists.entries()) {
    const namespace = ownedNamespaces[index] as string
    if (outcome.status === "rejected") {
      results.push(
        Object.freeze({
          id: `${namespace}.pods`,
          status: "failed",
          error: errorDiagnostics(outcome.reason),
        }),
      )
      continue
    }
    results.push(
      Object.freeze({
        id: `${namespace}.pods`,
        status: "passed",
        output: diagnosticOutput(outcome.value.commandResult, "json"),
      }),
    )
    for (const podName of outcome.value.names) {
      logRequests.push({
        id: `${namespace}.pod-logs.${podName}`,
        command: kubectl.command(input.context, [
          "logs",
          `pod/${podName}`,
          "--namespace",
          namespace,
          "--all-containers=true",
          "--prefix=true",
          "--tail=200",
        ]),
        format: "text",
      })
    }
  }
  results.push(...(await settleDiagnosticRequests(logRequests, input.execute)))
  return Object.freeze(results)
}

function reportDiagnostics(
  failure: unknown | undefined,
  diagnostics: unknown | undefined,
): unknown | undefined {
  if (failure === undefined && diagnostics === undefined) return undefined
  return {
    ...(failure !== undefined ? { failure: errorDiagnostics(failure) } : {}),
    ...(diagnostics !== undefined ? { cluster: diagnostics } : {}),
  }
}

function completeReport(
  checkpoint: CompatibilityReport,
  cleanup: CleanupResult,
  diagnostics: unknown | undefined,
): CompatibilityReport {
  return Object.freeze({
    schemaVersion: checkpoint.schemaVersion,
    target: checkpoint.target,
    observedServer: checkpoint.observedServer,
    runId: checkpoint.runId,
    startedAt: checkpoint.startedAt,
    finishedAt: checkpoint.finishedAt,
    steps: checkpoint.steps,
    cleanup,
    ...(diagnostics !== undefined ? { diagnostics: redactSensitive(diagnostics) } : {}),
  })
}

function safeReportFilename(target: string, names: ClusterNames): string {
  return `kubernetes-compat-${target.replaceAll(".", "-")}-${names.runName}.json`
}

function displayErrorMessages(cause: unknown): readonly string[] {
  if (cause instanceof KubernetesCompatibilityRunError && cause.cause !== undefined) {
    return displayErrorMessages(cause.cause)
  }
  if (cause instanceof AggregateError) {
    return cause.errors.flatMap(displayErrorMessages)
  }
  const message = cause instanceof Error ? cause.message : String(cause)
  const redacted = redactSensitive(message)
  return [typeof redacted === "string" ? redacted : String(redacted)]
}

export async function runKubernetesCompatibility(
  options: KubernetesCompatibilityOptions,
  dependencies: KubernetesCompatibilityHarnessDependencies = {},
): Promise<KubernetesCompatibilityRunResult> {
  validateRunOptions(options)
  const resolved = resolveDependencies(dependencies)
  if (!isAbsolute(resolved.repositoryRoot) || !isAbsolute(resolved.expectedTestsPath)) {
    throw new Error("Compatibility repository and expected-test paths must be absolute")
  }
  const runId = expectNonEmpty(resolved.createRunId(), "Generated compatibility run ID")
  const derivedNames = deriveClusterNames(runId)
  const ownership: NamespaceOwnership[] = []
  const releaseCleanupCandidates = new Set<InstalledReleaseRole>()
  const tokenDestroyers = new Set<() => Promise<void>>()
  const observedProbes: AccountedStep[] = []
  const lifecycleAbort = new AbortController()
  const inFlightLifecyclePhases = new Set<Promise<unknown>>()
  let networkLease: NetworkControlLease | undefined
  let signalRegistration: SignalCleanupRegistration | undefined
  let reportRecorder: CompatibilityReportRecorder | undefined
  let observedServer = "unavailable"
  let cleanupOperation: Promise<CleanupExecution> | undefined
  let shutdownRecoveryOperation: Promise<void> | undefined
  let shutdownRequested = false
  let preflight: ClusterPreflightResult | undefined

  const assertLifecycleActive = (operation: string): void => {
    if (shutdownRequested || lifecycleAbort.signal.aborted) {
      throw new Error(`Compatibility shutdown requested before ${operation}`)
    }
  }

  const lifecycleExecute: CommandExecutor = (command, executionOptions = {}) => {
    assertLifecycleActive(`starting ${command.file}`)
    const signal =
      executionOptions.signal === undefined
        ? lifecycleAbort.signal
        : AbortSignal.any([lifecycleAbort.signal, executionOptions.signal])
    return resolved.execute(command, { ...executionOptions, signal })
  }

  const runTrackedLifecyclePhase = <T>(
    name: string,
    operation: (execute: ProbeCommandRunner) => Promise<T>,
  ): Promise<T> => {
    let phaseActive = true
    const phaseExecute: ProbeCommandRunner = (command, executionOptions) =>
      phaseActive
        ? lifecycleExecute(command, executionOptions)
        : resolved.execute(command, executionOptions)
    const tracked = Promise.resolve().then(async () => {
      assertLifecycleActive(`starting ${name}`)
      try {
        const value = await operation(phaseExecute)
        assertLifecycleActive(`completing ${name}`)
        return value
      } finally {
        phaseActive = false
      }
    })
    inFlightLifecyclePhases.add(tracked)
    void tracked.then(
      () => inFlightLifecyclePhases.delete(tracked),
      () => inFlightLifecyclePhases.delete(tracked),
    )
    return tracked
  }

  const waitForTrackedLifecyclePhases = async (): Promise<void> => {
    while (inFlightLifecyclePhases.size > 0) {
      await Promise.allSettled([...inFlightLifecyclePhases])
    }
  }

  const registerReleaseCleanupCandidate = (role: InstalledReleaseRole): void => {
    assertLifecycleActive(`registering ${role} Helm install`)
    releaseCleanupCandidates.add(role)
  }

  const cleanupCurrentState = (retainClusterResources: boolean): Promise<CleanupExecution> => {
    if (cleanupOperation !== undefined) return cleanupOperation
    cleanupOperation = (async () => {
      const hadWork =
        ownership.length > 0 ||
        releaseCleanupCandidates.size > 0 ||
        networkLease !== undefined ||
        tokenDestroyers.size > 0
      if (!hadWork) return { result: Object.freeze({ status: "skipped" }) }

      const errors: Error[] = []
      if (shutdownRecoveryOperation !== undefined) {
        try {
          await shutdownRecoveryOperation
        } catch (error) {
          errors.push(normalizeError(error, "Signal ownership recovery failed"))
        }
      }
      let ownershipVerified = ownership.length === 0
      if (ownership.length > 0) {
        try {
          await resolved.cleanupCluster({
            context: options.context,
            runId,
            ownership: [...ownership],
            installedReleases: [],
            removeTokenFiles: async () => undefined,
            keepOnFailure: true,
          })
          ownershipVerified = true
        } catch (error) {
          errors.push(normalizeError(error, "Namespace ownership verification failed"))
        }
      }

      const localActions: (() => Promise<void>)[] = [
        ...(networkLease !== undefined ? [() => networkLease?.cleanup() ?? Promise.resolve()] : []),
        ...tokenDestroyers,
      ]
      const localResults = await Promise.allSettled(
        localActions.map((action) => Promise.resolve().then(action)),
      )
      for (const outcome of localResults) {
        if (outcome.status === "rejected") {
          errors.push(normalizeError(outcome.reason, "Local compatibility cleanup failed"))
        }
      }

      const retained = retainClusterResources && ownershipVerified && ownership.length > 0
      if (ownershipVerified && !retained && ownership.length > 0) {
        const hasBothNamespaceOwnership = [
          derivedNames.managementNamespace,
          derivedNames.sandboxNamespace,
        ].every((namespace) => ownership.some(({ name }) => name === namespace))
        try {
          await resolved.cleanupCluster({
            context: options.context,
            runId,
            ownership: [...ownership],
            installedReleases: hasBothNamespaceOwnership ? [...releaseCleanupCandidates] : [],
            removeTokenFiles: async () => undefined,
          })
        } catch (error) {
          errors.push(normalizeError(error, "Owned cluster cleanup failed"))
        }
      }

      const cleanupError = aggregateErrors(errors, "Kubernetes compatibility cleanup failed")
      const result: CleanupResult = Object.freeze({
        status: cleanupError === undefined ? "passed" : "failed",
        diagnostics: redactSensitive({
          retained,
          ...(cleanupError !== undefined ? { errors: errorDiagnostics(cleanupError) } : {}),
        }),
      })
      return {
        result,
        ...(cleanupError !== undefined ? { error: cleanupError } : {}),
      }
    })()
    return cleanupOperation
  }

  const signalCleanup = async (): Promise<void> => {
    if (shutdownRecoveryOperation === undefined) {
      shutdownRequested = true
      lifecycleAbort.abort()
      shutdownRecoveryOperation = (async () => {
        await waitForTrackedLifecyclePhases()
        const recoveries = await Promise.allSettled([
          recoverNamespaceOwnership(derivedNames.managementNamespace),
          recoverNamespaceOwnership(derivedNames.sandboxNamespace),
        ])
        const recoveryError = aggregateErrors(
          recoveries.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])),
          "Signal ownership recovery failed",
        )
        if (recoveryError !== undefined) throw recoveryError
      })()
    }
    const cleanup = await cleanupCurrentState(false)
    if (cleanup.error !== undefined) throw cleanup.error
  }

  const ensureSignalRegistration = (): void => {
    if (signalRegistration !== undefined || ownership.length === 0) return
    const first = ownership[0]
    if (first === undefined) return
    signalRegistration = resolved.registerSignalCleanup(
      [first, ...ownership.slice(1)],
      signalCleanup,
      resolved.signalCleanupOptions,
    )
  }

  const trackOwnership = (candidate: NamespaceOwnership, expectedName: string): void => {
    if (candidate.name !== expectedName) {
      throw new Error(
        `Captured Namespace ${candidate.name} does not match derived Namespace ${expectedName}`,
      )
    }
    const existing = ownership.find(({ name }) => name === candidate.name)
    if (existing !== undefined) {
      if (existing.uid !== candidate.uid || existing.runId !== candidate.runId) {
        throw new Error(`Namespace ${candidate.name} ownership changed during capture`)
      }
      return
    }
    ownership.push(candidate)
    ensureSignalRegistration()
  }

  const recoverNamespaceOwnership = async (name: string): Promise<void> => {
    const response = await resolved.execute(
      kubectl.command(options.context, [
        "get",
        "namespace",
        name,
        "--output=json",
        "--ignore-not-found=true",
      ]),
      namespaceCommandOptions(),
    )
    if (response.stdout.toString("utf8").trim().length === 0) return
    trackOwnership(
      captureNamespaceOwnership(parseCommandJson(response, `Namespace ${name}`), runId),
      name,
    )
  }

  const failAfterRecovery = async (primary: unknown, namespaceName: string): Promise<never> => {
    try {
      await recoverNamespaceOwnership(namespaceName)
    } catch (recoveryError) {
      throw new AggregateError(
        [primary, recoveryError],
        `Compatibility mutation failed and ${namespaceName} ownership recovery failed`,
      )
    }
    throw primary
  }

  const createManagementNamespace = async (): Promise<void> => {
    const manifest = JSON.stringify({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: derivedNames.managementNamespace,
        labels: { [RUN_LABEL]: runId },
      },
    })
    try {
      const response = await resolved.execute(
        kubectl.command(options.context, ["create", "-f", "-", "--output=json"]),
        namespaceCommandOptions(manifest),
      )
      trackOwnership(
        captureNamespaceOwnership(
          parseCommandJson(response, "Management Namespace creation"),
          runId,
        ),
        derivedNames.managementNamespace,
      )
    } catch (error) {
      await failAfterRecovery(error, derivedNames.managementNamespace)
    }
  }

  const withTokenKubeconfig = async <T>(
    operation: (secure: SecureTokenKubeconfig, execute: ProbeCommandRunner) => Promise<T>,
  ): Promise<T> =>
    runTrackedLifecyclePhase("token-scoped phase", async (execute) => {
      if (preflight === undefined) {
        throw new Error("Token phase requires completed cluster preflight")
      }
      const token = await resolved.requestToken(
        {
          context: options.context,
          namespace: derivedNames.sandboxNamespace,
          serviceAccount: ORCHESTRATOR_SERVICE_ACCOUNT,
        },
        execute,
      )
      assertLifecycleActive("creating token kubeconfig")
      const secure = await resolved.createTokenKubeconfig({
        context: options.context,
        access: preflight.access,
        token,
      })
      let destroyInFlight: Promise<void> | undefined
      const destroy = (): Promise<void> => {
        destroyInFlight ??= Promise.resolve()
          .then(() => secure.destroy())
          .then(() => {
            tokenDestroyers.delete(destroy)
          })
        return destroyInFlight.finally(() => {
          destroyInFlight = undefined
        })
      }
      tokenDestroyers.add(destroy)

      const operationOutcome = await Promise.resolve()
        .then(() => {
          assertLifecycleActive("starting token-scoped operation")
          return operation(secure, execute)
        })
        .then(
          (value) => ({ status: "fulfilled", value }) as const,
          (reason: unknown) => ({ status: "rejected", reason }) as const,
        )
      const destroyOutcome = await destroy().then(
        () => ({ status: "fulfilled" }) as const,
        (reason: unknown) => ({ status: "rejected", reason }) as const,
      )
      const failures = [
        ...(operationOutcome.status === "rejected" ? [operationOutcome.reason] : []),
        ...(destroyOutcome.status === "rejected" ? [destroyOutcome.reason] : []),
      ]
      const failure = aggregateErrors(failures, "Token-scoped compatibility phase failed")
      if (failure !== undefined) throw failure
      if (operationOutcome.status !== "fulfilled") {
        throw new Error("Token-scoped compatibility phase did not produce a result")
      }
      return operationOutcome.value
    })

  const recordProbe = async <T>(
    id: string,
    operation: (execute: ProbeCommandRunner) => Promise<T>,
  ): Promise<T> => {
    if (reportRecorder === undefined) throw new Error("Probe recording requires cluster preflight")
    try {
      const value = await reportRecorder.runStep(id, () =>
        runTrackedLifecyclePhase(`probe ${id}`, operation),
      )
      observedProbes.push({ id, status: "passed" })
      return value
    } catch (error) {
      observedProbes.push({ id, status: "failed" })
      throw error
    }
  }

  let primaryFailure: unknown
  let collectedDiagnostics: unknown
  try {
    const activePolicy = await resolved.loadPolicy()
    getTargetByMinor(activePolicy, options.target)
    try {
      preflight = await resolved.preflight({
        context: options.context,
        targetMinor: options.target,
        runId,
        ...(options.storageClass !== undefined ? { storageClass: options.storageClass } : {}),
      })
    } catch (error) {
      throw new Error(
        `Kubernetes preflight for supplied context ${JSON.stringify(options.context)} failed: ${primaryErrorMessage(error)}`,
        { cause: error },
      )
    }
    assertPreflightNames(preflight.names, derivedNames)
    const selectedStorageClass = expectNonEmpty(
      preflight.storageClass,
      "Preflight-selected StorageClass",
    )
    observedServer = preflight.observedServer
    reportRecorder = createCompatibilityReport({
      target: options.target,
      observedServer,
      runId,
      ...(resolved.clock !== undefined ? { clock: resolved.clock } : {}),
    })
    await resolved.assertPermissions({
      context: options.context,
      managementNamespace: derivedNames.managementNamespace,
      sandboxNamespace: derivedNames.sandboxNamespace,
    })
    const providerAccounting = await resolved.createProviderAccountingSession({
      manifestPath: resolved.expectedTestsPath,
    })
    await createManagementNamespace()

    registerReleaseCleanupCandidate("infrastructure")
    try {
      await runTrackedLifecyclePhase("infrastructure Helm install", (execute) =>
        resolved.probes.installInfrastructure({ context: options.context, runId, execute }),
      )
    } catch (error) {
      await failAfterRecovery(error, derivedNames.sandboxNamespace)
    }
    try {
      await recoverNamespaceOwnership(derivedNames.sandboxNamespace)
      if (!ownership.some(({ name }) => name === derivedNames.sandboxNamespace)) {
        throw new Error("Infrastructure chart did not create the derived sandbox Namespace")
      }
    } catch (error) {
      await failAfterRecovery(error, derivedNames.sandboxNamespace)
    }

    await recordProbe("namespace.sandbox-secrets-empty", (execute) =>
      resolved.probes.sandboxSecretsEmpty({ context: options.context, runId, execute }),
    )
    const networkControlLease = await recordProbe("network.control-ready", (execute) =>
      resolved.probes.networkControl({
        context: options.context,
        runId,
        policy: activePolicy,
        execute,
      }),
    )
    networkLease = networkControlLease

    const runProviderPhase = async (
      phase: "provider-before-upgrade" | "provider-after-upgrade",
    ): Promise<void> => {
      await withTokenKubeconfig(async (secure, execute) => {
        const reportPath = join(secure.directory, `${phase}.json`)
        const providerResult = await execute(
          {
            file: "pnpm",
            args: [
              "--filter",
              "@dawn-ai/sandbox",
              "exec",
              "vitest",
              "--run",
              "--config",
              "vitest.config.ts",
              "test/kube-sandbox.integration.test.ts",
              "--reporter=json",
              `--outputFile=${reportPath}`,
            ],
          },
          {
            cwd: resolved.repositoryRoot,
            timeoutMs: PROVIDER_TIMEOUT_MS,
            stdoutLimitBytes: PROVIDER_STDOUT_LIMIT_BYTES,
            stderrLimitBytes: PROVIDER_STDERR_LIMIT_BYTES,
            acceptedExitCodes: [1],
            env: {
              ...process.env,
              DAWN_TEST_K8S: "1",
              DAWN_TEST_K8S_NS: derivedNames.sandboxNamespace,
              DAWN_TEST_K8S_IMAGE: activePolicy.images.sandboxWorkload,
              DAWN_TEST_K8S_STORAGE_CLASS: selectedStorageClass,
              DAWN_TEST_K8S_EGRESS_CONTROL_URL: networkControlLease.url,
              KUBECONFIG: secure.path,
            },
          },
        )
        await providerAccounting.record({ reportPath, phase })
        if (providerResult.exitCode !== 0) {
          throw new Error(`${phase} provider command exited with code ${providerResult.exitCode}`)
        }
      })
    }

    await runProviderPhase("provider-before-upgrade")
    await withTokenKubeconfig(async (secure) => {
      const tokenProbe = (execute: ProbeCommandRunner) => ({
        context: options.context,
        runId,
        policy: activePolicy,
        kubeconfig: secure.path,
        execute,
      })
      await recordProbe("admission.resource-quota", (execute) =>
        resolved.probes.resourceQuota(tokenProbe(execute)),
      )
      await recordProbe("admission.limit-range", (execute) =>
        resolved.probes.limitRange(tokenProbe(execute)),
      )
      await recordProbe("admission.restricted.before-upgrade", (execute) =>
        resolved.probes.restrictedAdmission(tokenProbe(execute)),
      )
      await recordProbe("rbac.secret-read-denied", (execute) =>
        resolved.probes.secretReadDenied(tokenProbe(execute)),
      )
      await recordProbe("rbac.role-mutation-denied", (execute) =>
        resolved.probes.roleMutationDenied(tokenProbe(execute)),
      )
      await recordProbe("rbac.outside-namespace-denied", (execute) =>
        resolved.probes.outsideNamespaceDenied(tokenProbe(execute)),
      )
    })

    await recordProbe("reaper.lifecycle.before-upgrade", (execute) =>
      resolved.probes.reaperLifecycle({
        context: options.context,
        runId,
        policy: activePolicy,
        execute,
      }),
    )
    registerReleaseCleanupCandidate("application")
    await runTrackedLifecyclePhase("application Helm install", (execute) =>
      resolved.probes.installApplication({
        context: options.context,
        runId,
        policy: activePolicy,
        execute,
      }),
    )
    await recordProbe("app.service-ready.before-upgrade", (execute) =>
      resolved.probes.applicationServiceReady({
        context: options.context,
        runId,
        policy: activePolicy,
        execute,
      }),
    )

    await recordProbe("upgrade.infrastructure", (execute) =>
      resolved.probes.upgradeInfrastructure({ context: options.context, runId, execute }),
    )
    await runProviderPhase("provider-after-upgrade")
    await withTokenKubeconfig(async (secure) => {
      await recordProbe("admission.restricted.after-infra-upgrade", (execute) =>
        resolved.probes.restrictedAdmission({
          context: options.context,
          runId,
          policy: activePolicy,
          kubeconfig: secure.path,
          execute,
        }),
      )
    })
    await recordProbe("reaper.lifecycle.after-infra-upgrade", (execute) =>
      resolved.probes.reaperLifecycle({
        context: options.context,
        runId,
        policy: activePolicy,
        execute,
      }),
    )

    await recordProbe("upgrade.application", (execute) =>
      resolved.probes.upgradeApplication({
        context: options.context,
        runId,
        policy: activePolicy,
        execute,
      }),
    )
    await recordProbe("app.service-ready.after-application-upgrade", (execute) =>
      resolved.probes.applicationServiceReady({
        context: options.context,
        runId,
        policy: activePolicy,
        execute,
      }),
    )
    assertLifecycleActive("final provider and probe accounting")
    providerAccounting.finish()
    resolved.assertStepAccounting(KUBERNETES_COMPAT_PROBE_IDS, observedProbes)
  } catch (error) {
    primaryFailure = error
  }

  if (reportRecorder === undefined) {
    reportRecorder = createCompatibilityReport({
      target: options.target,
      observedServer,
      runId,
      ...(resolved.clock !== undefined ? { clock: resolved.clock } : {}),
    })
  }

  if (primaryFailure !== undefined && ownership.length > 0) {
    try {
      collectedDiagnostics = await resolved.collectDiagnostics({
        context: options.context,
        runId,
        names: derivedNames,
        ownership: [...ownership],
        attemptedReleases: [...releaseCleanupCandidates],
        execute: resolved.execute,
      })
    } catch (diagnosticError) {
      collectedDiagnostics = { collectionError: errorDiagnostics(diagnosticError) }
    }
  }

  const checkpointDiagnostics = reportDiagnostics(primaryFailure, collectedDiagnostics)
  const checkpointReport = reportRecorder.finish({
    cleanup: { status: "skipped", diagnostics: { pending: true } },
    ...(checkpointDiagnostics !== undefined ? { diagnostics: checkpointDiagnostics } : {}),
  })
  const reportFilename = safeReportFilename(options.target, derivedNames)
  try {
    await resolved.persistReport(resolved.repositoryRoot, reportFilename, checkpointReport)
  } catch (persistenceError) {
    primaryFailure = aggregateErrors(
      [...(primaryFailure !== undefined ? [primaryFailure] : []), persistenceError],
      "Kubernetes compatibility checkpoint report persistence failed",
    )
  }

  const cleanup = await cleanupCurrentState(
    primaryFailure !== undefined && options.keepOnFailure === true,
  )
  let finalFailure = aggregateErrors(
    [
      ...(primaryFailure !== undefined ? [primaryFailure] : []),
      ...(cleanup.error !== undefined ? [cleanup.error] : []),
    ],
    "Kubernetes compatibility run and cleanup failed",
  )

  if (primaryFailure === undefined && cleanup.error !== undefined && ownership.length > 0) {
    try {
      collectedDiagnostics = await resolved.collectDiagnostics({
        context: options.context,
        runId,
        names: derivedNames,
        ownership: [...ownership],
        attemptedReleases: [...releaseCleanupCandidates],
        execute: resolved.execute,
      })
    } catch (diagnosticError) {
      collectedDiagnostics = { collectionError: errorDiagnostics(diagnosticError) }
    }
  }

  const report = completeReport(
    checkpointReport,
    cleanup.result,
    reportDiagnostics(finalFailure, collectedDiagnostics),
  )
  let finalReportPath: string | undefined
  try {
    finalReportPath = await resolved.persistReport(resolved.repositoryRoot, reportFilename, report)
  } catch (persistenceError) {
    finalFailure = aggregateErrors(
      [...(finalFailure !== undefined ? [finalFailure] : []), persistenceError],
      "Kubernetes compatibility report persistence failed",
    )
  } finally {
    signalRegistration?.dispose()
  }

  if (finalFailure !== undefined) {
    throw new KubernetesCompatibilityRunError(finalFailure, finalReportPath)
  }
  if (finalReportPath === undefined) {
    throw new KubernetesCompatibilityRunError("Compatibility report path was not returned")
  }
  return Object.freeze({ runId, reportPath: finalReportPath, report })
}

export async function runKubernetesCompatibilityMain(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: KubernetesCompatibilityMainDependencies = {},
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((chunk: string) => process.stdout.write(chunk))
  const writeStderr = dependencies.writeStderr ?? ((chunk: string) => process.stderr.write(chunk))
  const parserArgv = argv[0] === "--" ? argv.slice(1) : argv
  let parsed: ParsedKubernetesCompatibilityArgs
  try {
    parsed = parseKubernetesCompatibilityArgs(parserArgv)
  } catch (error) {
    if (error instanceof KubernetesCompatibilityUsageError) {
      writeStderr(`${error.message}\n${KUBERNETES_COMPAT_USAGE}`)
      return 2
    }
    writeStderr("Invalid Kubernetes compatibility arguments\n")
    return 2
  }

  if (parsed.kind === "help") {
    writeStdout(KUBERNETES_COMPAT_USAGE)
    return 0
  }

  try {
    await runKubernetesCompatibility(parsed.options, dependencies)
    return 0
  } catch (error) {
    const messages = displayErrorMessages(error)
    const first = messages[0] ?? "Unknown compatibility failure"
    writeStderr(`Kubernetes compatibility failed: ${first}\n`)
    for (const message of messages.slice(1)) writeStderr(`- ${message}\n`)
    if (error instanceof KubernetesCompatibilityRunError && error.reportPath !== undefined) {
      writeStderr(`Report: ${error.reportPath}\n`)
    }
    return 1
  }
}
