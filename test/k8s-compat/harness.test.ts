import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, test, vi } from "vitest"
import {
  type ClusterPreflightResult,
  deriveClusterNames,
  registerOwnedResourceSignalCleanup,
  type SecureTokenKubeconfig,
} from "../../scripts/kubernetes-compat/cluster.ts"
import {
  type Command,
  CommandExecutionError,
  type CommandExecutionOptions,
  type CommandResult,
  executeCommand,
  helm,
} from "../../scripts/kubernetes-compat/command.ts"
import {
  type CompatibilityDiagnosticsInput,
  collectKubernetesCompatibilityDiagnostics,
  KUBERNETES_COMPAT_USAGE,
  type KubernetesCompatibilityHarnessDependencies,
  type KubernetesCompatibilityOptions,
  KubernetesCompatibilityRunError,
  KubernetesCompatibilityUsageError,
  parseKubernetesCompatibilityArgs,
  runKubernetesCompatibility,
  runKubernetesCompatibilityMain,
} from "../../scripts/kubernetes-compat/harness.ts"
import type { CompatibilityPolicy } from "../../scripts/kubernetes-compat/policy.ts"
import {
  KUBERNETES_COMPAT_PROBE_IDS,
  runNetworkControlProbe,
} from "../../scripts/kubernetes-compat/probes.ts"
import {
  ARTIFACT_DIRECTORY,
  assertExactStepAccounting,
  type CompatibilityReport,
  persistCompatibilityReport,
} from "../../scripts/kubernetes-compat/report.ts"

type Runner = (command: Command, options?: CommandExecutionOptions) => Promise<CommandResult>

const REPOSITORY_ROOT = resolve(__dirname, "../..")
const RUN_ID = "123e4567-e89b-12d3-a456-426614174000"
const CONTEXT = "kind-dawn"
const TARGET = "1.35"
const ORCHESTRATOR_TOKEN = "sensitive-token-material"
const NAMES = deriveClusterNames(RUN_ID)

const digest = (character: string): string =>
  `${character}.example/image@sha256:${character.repeat(64)}`

const POLICY: CompatibilityPolicy = {
  schemaVersion: 1,
  toolchain: {
    node: "24.19.0",
    pnpm: "10.33.0",
    helm: "v4.2.3",
    kind: "v0.32.0",
    kubectl: "v1.35.6",
  },
  targets: [
    {
      role: "lower",
      minor: "1.34",
      version: "v1.34.8",
      nodeImage: digest("a"),
    },
    {
      role: "canonical",
      minor: "1.35",
      version: "v1.35.5",
      nodeImage: digest("b"),
    },
    {
      role: "upper",
      minor: "1.36",
      version: "v1.36.1",
      nodeImage: digest("c"),
    },
  ],
  calico: {
    manifestUrl: "https://example.invalid/calico.yaml",
    sha256: "d".repeat(64),
    images: [{ source: "example.invalid/calico", occurrences: 1, target: digest("e") }],
  },
  images: {
    sandboxWorkload: digest("f"),
    packagedAppBase: digest("1"),
    placeholderApp: digest("2"),
    reachabilityProbe: digest("3"),
    admissionProbe: digest("4"),
    reaper: `example.invalid/reaper:v1.35.0@sha256:${"5".repeat(64)}`,
  },
}

const OPTIONS: KubernetesCompatibilityOptions = {
  target: TARGET,
  context: CONTEXT,
}

function result(command: Command, value: unknown = "", exitCode = 0): CommandResult {
  return {
    command,
    stdout: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
    stderr: Buffer.alloc(0),
    exitCode,
    signal: null,
    toJSON: () => ({ command, outcome: { kind: "exit", exitCode } }),
  }
}

function namespace(name: string, uid: string): unknown {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name,
      uid,
      labels: { "dawn.sh/compat-run": RUN_ID },
    },
  }
}

function flattenErrorMessages(error: unknown): readonly string[] {
  if (error instanceof KubernetesCompatibilityRunError && error.cause !== undefined) {
    return flattenErrorMessages(error.cause)
  }
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(flattenErrorMessages)]
  }
  return [error instanceof Error ? error.message : String(error)]
}

function deferred(): {
  readonly promise: Promise<void>
  resolve(): void
} {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(): void {
      resolvePromise?.()
    },
  }
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function waitForHarnessFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for harness process marker ${path}`)
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function stopHarnessProcess(pidPath: string): Promise<void> {
  let pid: number
  try {
    pid = Number(await readFile(pidPath, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !processIsRunning(pid))
    return
  process.kill(pid, "SIGKILL")
}

interface FixtureOptions {
  readonly failAt?: string
  readonly failTokenDestroy?: boolean
  readonly failNetworkCleanup?: boolean
  readonly failNetworkCleanupSynchronously?: boolean
  readonly failOwnershipVerification?: boolean
  readonly failClusterDestruction?: boolean
  readonly failFinalPersistence?: boolean
}

interface CommandCall {
  readonly command: Command
  readonly options: CommandExecutionOptions | undefined
}

interface HarnessFixture {
  readonly dependencies: KubernetesCompatibilityHarnessDependencies
  readonly events: string[]
  readonly commandCalls: CommandCall[]
  readonly reports: CompatibilityReport[]
  readonly cleanupInputs: unknown[]
  readonly providerRecords: { readonly phase: string; readonly reportPath: string }[]
  readonly tokenKubeconfigs: SecureTokenKubeconfig[]
  getSignalCleanup(): (() => Promise<void>) | undefined
}

function createHarnessFixture(options: FixtureOptions = {}): HarnessFixture {
  const events: string[] = []
  const commandCalls: CommandCall[] = []
  const reports: CompatibilityReport[] = []
  const cleanupInputs: unknown[] = []
  const providerRecords: { phase: string; reportPath: string }[] = []
  const tokenKubeconfigs: SecureTokenKubeconfig[] = []
  let signalCleanup: (() => Promise<void>) | undefined
  let tokenCount = 0
  let persistenceCount = 0

  const mark = (name: string): void => {
    events.push(name)
    if (options.failAt === name) throw new Error(`${name} failed`)
  }

  const execute = vi.fn<Runner>(async (command, executionOptions) => {
    commandCalls.push({ command, options: executionOptions })
    if (command.file === "pnpm") {
      const phase = command.args.some((argument) => argument.includes("provider-before-upgrade"))
        ? "provider-before-upgrade"
        : "provider-after-upgrade"
      mark(`provider.execute.${phase}`)
      return result(command)
    }

    const args = command.args
    if (
      command.file === "kubectl" &&
      args.includes("create") &&
      typeof executionOptions?.stdin === "string" &&
      executionOptions.stdin.includes('"kind":"Namespace"')
    ) {
      mark("management.create")
      return result(command, namespace(NAMES.managementNamespace, "management-uid"))
    }
    if (command.file === "kubectl" && args.includes("namespace")) {
      if (args.includes(NAMES.sandboxNamespace)) {
        mark("sandbox.capture")
        return result(command, namespace(NAMES.sandboxNamespace, "sandbox-uid"))
      }
      if (args.includes(NAMES.managementNamespace)) {
        mark("management.recover")
        return result(command, namespace(NAMES.managementNamespace, "management-uid"))
      }
    }
    return result(command, {})
  })

  const dependencies: KubernetesCompatibilityHarnessDependencies = {
    repositoryRoot: REPOSITORY_ROOT,
    expectedTestsPath: join(REPOSITORY_ROOT, "test/k8s-compat/expected-tests.json"),
    createRunId: () => RUN_ID,
    loadPolicy: async () => {
      mark("policy.load")
      return POLICY
    },
    preflight: async (): Promise<ClusterPreflightResult> => {
      mark("preflight")
      return {
        context: CONTEXT,
        observedServer: "v1.35.5",
        storageClass: "standard",
        names: NAMES,
        access: {
          server: "https://127.0.0.1:6443",
          certificateAuthorityData: "Y2E=",
        },
      }
    },
    assertPermissions: async () => {
      mark("permissions")
      return []
    },
    execute,
    requestToken: async () => {
      tokenCount += 1
      mark(`token.request.${tokenCount}`)
      return `${ORCHESTRATOR_TOKEN}-${tokenCount}`
    },
    createTokenKubeconfig: async () => {
      const tokenIndex = tokenCount
      mark(`token.create.${tokenIndex}`)
      const directory = `/secure/token-${tokenIndex}`
      let destroyed = false
      const secure: SecureTokenKubeconfig = {
        directory,
        path: `${directory}/kubeconfig.yaml`,
        async destroy(): Promise<void> {
          events.push(`token.destroy.${tokenIndex}`)
          if (options.failTokenDestroy) {
            throw new Error(`token destroy ${tokenIndex} failed`)
          }
          destroyed = true
        },
      }
      Object.defineProperty(secure, "destroyed", { get: () => destroyed })
      tokenKubeconfigs.push(secure)
      return secure
    },
    createProviderAccountingSession: async () => {
      mark("provider.accounting.create")
      return {
        async record(record): Promise<void> {
          mark(`provider.account.${record.phase}`)
          providerRecords.push(record)
        },
        finish(): void {
          mark("provider.finish")
        },
      }
    },
    assertStepAccounting: (expected, observed) => {
      mark("probe.accounting")
      assertExactStepAccounting(expected, observed)
    },
    persistReport: async (_root, _filename, report) => {
      mark("report.persist")
      persistenceCount += 1
      reports.push(report)
      if (options.failFinalPersistence === true && persistenceCount === 2) {
        throw new Error("final report persistence failed")
      }
      return join(REPOSITORY_ROOT, ARTIFACT_DIRECTORY, "compat-report.json")
    },
    collectDiagnostics: async () => {
      mark("diagnostics.collect")
      return { collected: true }
    },
    cleanupCluster: async (input) => {
      cleanupInputs.push(input)
      await input.removeTokenFiles()
      if (input.keepOnFailure === true && input.installedReleases.length === 0) {
        events.push("cleanup.verify")
        if (options.failOwnershipVerification) {
          throw new Error("ownership verification failed")
        }
        return { retained: true }
      }
      events.push("cleanup.destroy")
      if (options.failClusterDestruction) {
        throw new Error("cluster destruction failed")
      }
      return { retained: false }
    },
    registerSignalCleanup: (cleanup) => {
      mark("signal.register")
      signalCleanup = cleanup
      return {
        completion: new Promise(() => undefined),
        dispose(): void {
          events.push("signal.dispose")
        },
      }
    },
    probes: {
      installInfrastructure: async () => mark("infrastructure.install"),
      upgradeInfrastructure: async () => mark("probe.upgrade.infrastructure"),
      installApplication: async () => mark("application.install"),
      upgradeApplication: async () => mark("probe.upgrade.application"),
      sandboxSecretsEmpty: async () => mark("probe.namespace.sandbox-secrets-empty"),
      networkControl: async () => {
        mark("probe.network.control-ready")
        return {
          url: `http://network.${NAMES.sandboxNamespace}.svc.cluster.local:8080/`,
          cleanup(): Promise<void> {
            events.push("network.cleanup")
            if (options.failNetworkCleanupSynchronously) {
              throw new Error("network cleanup synchronously failed")
            }
            if (options.failNetworkCleanup) {
              return Promise.reject(new Error("network cleanup failed"))
            }
            return Promise.resolve()
          },
        }
      },
      resourceQuota: async () => mark("probe.admission.resource-quota"),
      limitRange: async () => mark("probe.admission.limit-range"),
      restrictedAdmission: async () => {
        const phase = tokenCount < 4 ? "before-upgrade" : "after-infra-upgrade"
        mark(`probe.admission.restricted.${phase}`)
      },
      secretReadDenied: async () => mark("probe.rbac.secret-read-denied"),
      roleMutationDenied: async () => mark("probe.rbac.role-mutation-denied"),
      outsideNamespaceDenied: async () => mark("probe.rbac.outside-namespace-denied"),
      reaperLifecycle: async () => {
        const phase = events.includes("probe.upgrade.infrastructure")
          ? "after-infra-upgrade"
          : "before-upgrade"
        mark(`probe.reaper.lifecycle.${phase}`)
      },
      applicationServiceReady: async () => {
        const phase = events.includes("probe.upgrade.application")
          ? "after-application-upgrade"
          : "before-upgrade"
        mark(`probe.app.service-ready.${phase}`)
      },
    },
  }

  return {
    dependencies,
    events,
    commandCalls,
    reports,
    cleanupInputs,
    providerRecords,
    tokenKubeconfigs,
    getSignalCleanup: () => signalCleanup,
  }
}

describe("Kubernetes compatibility CLI parser", () => {
  test("accepts only the documented run surface", () => {
    expect(
      parseKubernetesCompatibilityArgs([
        "--target",
        "1.35",
        "--context",
        "kind-dawn",
        "--storage-class",
        "standard-rwo",
        "--keep-on-failure",
      ]),
    ).toEqual({
      kind: "run",
      options: {
        target: "1.35",
        context: "kind-dawn",
        storageClass: "standard-rwo",
        keepOnFailure: true,
      },
    })
    expect(parseKubernetesCompatibilityArgs(["--help"])).toEqual({ kind: "help" })
  })

  test.each([
    ["missing all required flags", []],
    ["missing context", ["--target", "1.35"]],
    ["missing target", ["--context", "kind-dawn"]],
    ["unknown flag", ["--target", "1.35", "--context", "kind-dawn", "--namespace", "x"]],
    ["target duplicate", ["--target", "1.35", "--target", "1.35", "--context", "kind-dawn"]],
    ["context duplicate", ["--target", "1.35", "--context", "a", "--context", "b"]],
    [
      "storage duplicate",
      [
        "--target",
        "1.35",
        "--context",
        "kind-dawn",
        "--storage-class",
        "a",
        "--storage-class",
        "b",
      ],
    ],
    [
      "boolean duplicate",
      ["--target", "1.35", "--context", "kind-dawn", "--keep-on-failure", "--keep-on-failure"],
    ],
    ["missing target value", ["--target", "--context", "kind-dawn"]],
    ["missing context value", ["--target", "1.35", "--context"]],
    ["missing storage value", ["--target", "1.35", "--context", "kind-dawn", "--storage-class"]],
    ["positional argument", ["--target", "1.35", "--context", "kind-dawn", "extra"]],
    ["boolean value", ["--target", "1.35", "--context", "kind-dawn", "--keep-on-failure", "true"]],
    ["unsupported target", ["--target", "1.33", "--context", "kind-dawn"]],
    ["help with run flags", ["--help", "--target", "1.35", "--context", "kind-dawn"]],
    ["duplicate help", ["--help", "--help"]],
  ])("rejects %s", (_case, argv) => {
    expect(() => parseKubernetesCompatibilityArgs(argv)).toThrow(KubernetesCompatibilityUsageError)
  })

  test("returns exit 2 before policy or cluster access for every usage error", async () => {
    const loadPolicy = vi.fn(async () => POLICY)
    const preflight = vi.fn()
    let stderr = ""

    const exitCode = await runKubernetesCompatibilityMain(
      ["--target", "1.35", "--context", "kind-dawn", "--unknown"],
      {
        loadPolicy,
        preflight,
        writeStderr: (chunk) => {
          stderr += chunk
        },
      },
    )

    expect(exitCode).toBe(2)
    expect(stderr).toContain("Unknown flag")
    expect(stderr).toContain(KUBERNETES_COMPAT_USAGE.trim())
    expect(loadPolicy).not.toHaveBeenCalled()
    expect(preflight).not.toHaveBeenCalled()
  })

  test("prints help and exits zero without loading policy or cluster state", async () => {
    const loadPolicy = vi.fn(async () => POLICY)
    const preflight = vi.fn()
    let stdout = ""
    let stderr = ""

    const exitCode = await runKubernetesCompatibilityMain(["--help"], {
      loadPolicy,
      preflight,
      writeStdout: (chunk) => {
        stdout += chunk
      },
      writeStderr: (chunk) => {
        stderr += chunk
      },
    })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(KUBERNETES_COMPAT_USAGE)
    expect(stderr).toBe("")
    expect(loadPolicy).not.toHaveBeenCalled()
    expect(preflight).not.toHaveBeenCalled()
  })

  test("accepts exactly one leading pnpm argument separator at the main-wrapper boundary", async () => {
    let stdout = ""

    const exitCode = await runKubernetesCompatibilityMain(["--", "--help"], {
      writeStdout: (chunk) => {
        stdout += chunk
      },
    })

    expect(exitCode).toBe(0)
    expect(stdout).toBe(KUBERNETES_COMPAT_USAGE)
    expect(() => parseKubernetesCompatibilityArgs(["--", "--help"])).toThrow(
      KubernetesCompatibilityUsageError,
    )
  })
})

describe("portable compatibility lifecycle", () => {
  test("locks the required lifecycle and exact probe order", async () => {
    const fixture = createHarnessFixture()

    const outcome = await runKubernetesCompatibility(OPTIONS, fixture.dependencies)

    expect(outcome).toMatchObject({
      runId: RUN_ID,
      reportPath: expect.stringContaining(ARTIFACT_DIRECTORY),
    })
    expect(fixture.events).toEqual([
      "policy.load",
      "preflight",
      "permissions",
      "provider.accounting.create",
      "signal.register",
      "management.create",
      "infrastructure.install",
      "sandbox.capture",
      "probe.namespace.sandbox-secrets-empty",
      "probe.network.control-ready",
      "token.request.1",
      "token.create.1",
      "provider.execute.provider-before-upgrade",
      "provider.account.provider-before-upgrade",
      "token.destroy.1",
      "token.request.2",
      "token.create.2",
      "probe.admission.resource-quota",
      "probe.admission.limit-range",
      "probe.admission.restricted.before-upgrade",
      "probe.rbac.secret-read-denied",
      "probe.rbac.role-mutation-denied",
      "probe.rbac.outside-namespace-denied",
      "token.destroy.2",
      "probe.reaper.lifecycle.before-upgrade",
      "application.install",
      "probe.app.service-ready.before-upgrade",
      "probe.upgrade.infrastructure",
      "token.request.3",
      "token.create.3",
      "provider.execute.provider-after-upgrade",
      "provider.account.provider-after-upgrade",
      "token.destroy.3",
      "token.request.4",
      "token.create.4",
      "probe.admission.restricted.after-infra-upgrade",
      "token.destroy.4",
      "probe.reaper.lifecycle.after-infra-upgrade",
      "probe.upgrade.application",
      "probe.app.service-ready.after-application-upgrade",
      "provider.finish",
      "probe.accounting",
      "report.persist",
      "cleanup.verify",
      "network.cleanup",
      "cleanup.destroy",
      "report.persist",
      "signal.dispose",
    ])
    expect(fixture.reports).toHaveLength(2)
    expect(fixture.reports[0]?.cleanup).toMatchObject({
      status: "skipped",
      diagnostics: { pending: true },
    })
    expect(fixture.reports[1]?.cleanup).toMatchObject({
      status: "passed",
      diagnostics: { retained: false },
    })
  })

  test("creates and captures both exact run-labelled Namespaces through explicit-context JSON calls", async () => {
    const fixture = createHarnessFixture()

    await runKubernetesCompatibility(OPTIONS, fixture.dependencies)

    const managementCreate = fixture.commandCalls.find(
      ({ command, options }) =>
        command.file === "kubectl" &&
        command.args.includes("create") &&
        typeof options?.stdin === "string" &&
        options.stdin.includes('"kind":"Namespace"'),
    )
    expect(managementCreate?.command.args.slice(0, 2)).toEqual(["--context", CONTEXT])
    expect(managementCreate?.command.args).toContain("--output=json")
    expect(JSON.parse(String(managementCreate?.options?.stdin))).toEqual({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: NAMES.managementNamespace,
        labels: { "dawn.sh/compat-run": RUN_ID },
      },
    })

    const sandboxRead = fixture.commandCalls.find(({ command }) =>
      command.args.includes(NAMES.sandboxNamespace),
    )
    expect(sandboxRead?.command.args.slice(0, 2)).toEqual(["--context", CONTEXT])
    expect(sandboxRead?.command.args).toEqual(
      expect.arrayContaining(["get", "namespace", NAMES.sandboxNamespace, "--output=json"]),
    )

    const destructiveInput = fixture.cleanupInputs.at(-1) as {
      readonly ownership: readonly { readonly name: string; readonly uid: string }[]
      readonly installedReleases: readonly string[]
    }
    expect(destructiveInput.ownership).toEqual([
      { name: NAMES.managementNamespace, uid: "management-uid", runId: RUN_ID },
      { name: NAMES.sandboxNamespace, uid: "sandbox-uid", runId: RUN_ID },
    ])
    expect(destructiveInput.installedReleases).toEqual(["infrastructure", "application"])
  })

  test("runs every provider phase with an exact bounded command and fresh token-only material", async () => {
    const fixture = createHarnessFixture()

    await runKubernetesCompatibility(OPTIONS, fixture.dependencies)

    const providerCalls = fixture.commandCalls.filter(({ command }) => command.file === "pnpm")
    expect(providerCalls).toHaveLength(2)
    for (const [index, call] of providerCalls.entries()) {
      const phase = index === 0 ? "provider-before-upgrade" : "provider-after-upgrade"
      const secure = fixture.tokenKubeconfigs[index === 0 ? 0 : 2]
      expect(secure).toBeDefined()
      expect(call.command).toEqual({
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
          `--outputFile=${secure?.directory}/${phase}.json`,
        ],
      })
      expect(call.options?.cwd).toBe(REPOSITORY_ROOT)
      expect(call.options?.timeoutMs).toBe(12 * 60 * 1_000)
      expect(call.options?.stdoutLimitBytes).toBeGreaterThan(0)
      expect(call.options?.stderrLimitBytes).toBeGreaterThan(0)
      expect(call.options?.acceptedExitCodes).toEqual([1])
      expect(call.options?.terminateProcessTree).toBe(true)
      expect(call.options?.sensitiveOutput).toBe(true)
      expect(call.options?.env).toMatchObject({
        DAWN_TEST_K8S: "1",
        DAWN_TEST_K8S_NS: NAMES.sandboxNamespace,
        DAWN_TEST_K8S_IMAGE: POLICY.images.sandboxWorkload,
        DAWN_TEST_K8S_STORAGE_CLASS: "standard",
        DAWN_TEST_K8S_EGRESS_CONTROL_URL: `http://network.${NAMES.sandboxNamespace}.svc.cluster.local:8080/`,
        KUBECONFIG: secure?.path,
      })
      expect(JSON.stringify({ command: call.command, env: call.options?.env })).not.toContain(
        `${ORCHESTRATOR_TOKEN}-${index === 0 ? 1 : 3}`,
      )
      expect(fixture.providerRecords[index]).toEqual({
        phase,
        reportPath: `${secure?.directory}/${phase}.json`,
      })
      expect(fixture.events.indexOf(`provider.account.${phase}`)).toBeLessThan(
        fixture.events.indexOf(`token.destroy.${index === 0 ? 1 : 3}`),
      )
    }

    expect(fixture.tokenKubeconfigs.map(({ directory }) => directory)).toEqual([
      "/secure/token-1",
      "/secure/token-2",
      "/secure/token-3",
      "/secure/token-4",
    ])
    expect(fixture.events.filter((event) => event.startsWith("token.destroy."))).toEqual([
      "token.destroy.1",
      "token.destroy.2",
      "token.destroy.3",
      "token.destroy.4",
    ])
  })

  test("requires and passes the harness-selected StorageClass in the live provider suite", async () => {
    const source = await readFile(
      join(REPOSITORY_ROOT, "packages/sandbox/test/kube-sandbox.integration.test.ts"),
      "utf8",
    )

    expect(source).toContain('requiredLiveEnvironment("DAWN_TEST_K8S_STORAGE_CLASS")')
    expect(source).toMatch(/kubernetesSandbox\(\{[^}]*storageClass:\s*STORAGE_CLASS/s)
  })

  test("accounts production preflight in both live provider phases", async () => {
    const title = "production preflight validates the short-lived token permissions"
    const fullName = `kubernetesSandbox (real cluster) ${title}`
    const source = await readFile(
      join(REPOSITORY_ROOT, "packages/sandbox/test/kube-sandbox.integration.test.ts"),
      "utf8",
    )
    const manifest = JSON.parse(
      await readFile(join(REPOSITORY_ROOT, "test/k8s-compat/expected-tests.json"), "utf8"),
    ) as {
      readonly providerPhases: Readonly<Record<string, readonly string[]>>
    }

    expect(source).toContain(`test(${JSON.stringify(title)}`)
    expect(manifest.providerPhases["provider-before-upgrade"]).toContain(fullName)
    expect(manifest.providerPhases["provider-after-upgrade"]).toContain(fullName)
  })

  test("accounts both provider manifests before finish and exact probe IDs once in declaration order", async () => {
    const fixture = createHarnessFixture()
    const accounting = vi.fn((expected: readonly string[], observed: readonly unknown[]) => {
      fixture.events.push("probe.accounting")
      assertExactStepAccounting(
        expected,
        observed as readonly { readonly id: string; readonly status: "passed" }[],
      )
    })

    await runKubernetesCompatibility(OPTIONS, {
      ...fixture.dependencies,
      assertStepAccounting: accounting,
    })

    expect(fixture.providerRecords.map(({ phase }) => phase)).toEqual([
      "provider-before-upgrade",
      "provider-after-upgrade",
    ])
    expect(fixture.events.indexOf("provider.account.provider-after-upgrade")).toBeLessThan(
      fixture.events.indexOf("provider.finish"),
    )
    expect(accounting).toHaveBeenCalledOnce()
    expect(accounting.mock.calls[0]?.[0]).toEqual(KUBERNETES_COMPAT_PROBE_IDS)
    expect(accounting.mock.calls[0]?.[1]).toEqual(
      KUBERNETES_COMPAT_PROBE_IDS.map((id) => ({ id, status: "passed" })),
    )
    const finalReport = fixture.reports.at(-1)
    expect(finalReport?.steps).toHaveLength(KUBERNETES_COMPAT_PROBE_IDS.length)
    expect(finalReport?.steps.every(({ status }) => status === "passed")).toBe(true)
  })

  test("anchors relative chart commands to the repository when invoked outside it", async () => {
    const fixture = createHarnessFixture()
    const originalCwd = process.cwd()
    const outsideRepository = tmpdir()
    const explicitCommandCwd = join(REPOSITORY_ROOT, "packages/sandbox")
    const runChartCommand = async (
      event: string,
      verb: "install" | "upgrade",
      chart: string,
      runCommand: Runner | undefined,
    ): Promise<void> => {
      if (runCommand === undefined) throw new Error("Expected injected lifecycle executor")
      fixture.events.push(event)
      await runCommand(helm.command(CONTEXT, [verb, `${verb}-release`, chart]))
    }

    process.chdir(outsideRepository)
    try {
      await runKubernetesCompatibility(OPTIONS, {
        ...fixture.dependencies,
        probes: {
          ...fixture.dependencies.probes,
          installInfrastructure: async ({ execute }) =>
            runChartCommand(
              "infrastructure.install",
              "install",
              "charts/dawn-sandbox-infra",
              execute,
            ),
          upgradeInfrastructure: async ({ execute }) =>
            runChartCommand(
              "probe.upgrade.infrastructure",
              "upgrade",
              "charts/dawn-sandbox-infra",
              execute,
            ),
          installApplication: async ({ execute }) =>
            runChartCommand("application.install", "install", "charts/dawn-app", execute),
          upgradeApplication: async ({ execute }) =>
            runChartCommand("probe.upgrade.application", "upgrade", "charts/dawn-app", execute),
          sandboxSecretsEmpty: async ({ execute }) => {
            if (execute === undefined) throw new Error("Expected injected lifecycle executor")
            fixture.events.push("probe.namespace.sandbox-secrets-empty")
            await execute({ file: "safe-command", args: [] }, { cwd: explicitCommandCwd })
          },
        },
      })
    } finally {
      process.chdir(originalCwd)
    }

    const chartCalls = fixture.commandCalls.filter(({ command }) =>
      command.args.some((argument) => argument.startsWith("charts/")),
    )
    expect(chartCalls).toHaveLength(4)
    expect(chartCalls.map(({ options }) => options?.cwd)).toEqual([
      REPOSITORY_ROOT,
      REPOSITORY_ROOT,
      REPOSITORY_ROOT,
      REPOSITORY_ROOT,
    ])
    expect(chartCalls.every(({ options }) => options?.terminateProcessTree === undefined)).toBe(
      true,
    )
    const explicitCwdCall = fixture.commandCalls.find(
      ({ command }) => command.file === "safe-command",
    )
    expect(explicitCwdCall?.options?.cwd).toBe(explicitCommandCwd)
  })
})

describe("failure boundaries and cleanup", () => {
  const mutationBoundaries = [
    "management.create",
    "infrastructure.install",
    "sandbox.capture",
    "probe.namespace.sandbox-secrets-empty",
    "probe.network.control-ready",
    "token.request.1",
    "token.create.1",
    "provider.execute.provider-before-upgrade",
    "provider.account.provider-before-upgrade",
    "token.request.2",
    "token.create.2",
    "probe.admission.resource-quota",
    "probe.admission.limit-range",
    "probe.admission.restricted.before-upgrade",
    "probe.rbac.secret-read-denied",
    "probe.rbac.role-mutation-denied",
    "probe.rbac.outside-namespace-denied",
    "probe.reaper.lifecycle.before-upgrade",
    "application.install",
    "probe.app.service-ready.before-upgrade",
    "probe.upgrade.infrastructure",
    "token.request.3",
    "token.create.3",
    "provider.execute.provider-after-upgrade",
    "provider.account.provider-after-upgrade",
    "token.request.4",
    "token.create.4",
    "probe.admission.restricted.after-infra-upgrade",
    "probe.reaper.lifecycle.after-infra-upgrade",
    "probe.upgrade.application",
    "probe.app.service-ready.after-application-upgrade",
    "provider.finish",
    "probe.accounting",
  ] as const

  test.each(mutationBoundaries)("cleans safely when %s fails", async (boundary) => {
    const fixture = createHarnessFixture({ failAt: boundary })

    await expect(runKubernetesCompatibility(OPTIONS, fixture.dependencies)).rejects.toThrow(
      boundary,
    )

    expect(fixture.events).toContain("report.persist")
    if (
      fixture.events.includes("management.create") ||
      fixture.events.includes("management.recover")
    ) {
      expect(fixture.events).toContain("cleanup.verify")
      expect(fixture.events).toContain("cleanup.destroy")
    }
    if (
      fixture.events.includes("probe.network.control-ready") &&
      boundary !== "probe.network.control-ready"
    ) {
      expect(fixture.events).toContain("network.cleanup")
    }
    for (const { directory } of fixture.tokenKubeconfigs) {
      expect(fixture.events).toContain(`token.destroy.${directory.split("-").at(-1)}`)
    }
    expect(fixture.reports.at(-1)?.cleanup.status).not.toBe("failed")
  })

  test("recovers exact management ownership after a partial create before destructive cleanup", async () => {
    const fixture = createHarnessFixture({ failAt: "management.create" })

    const error = await runKubernetesCompatibility(OPTIONS, fixture.dependencies).catch(
      (cause: unknown) => cause,
    )

    expect(flattenErrorMessages(error)).toContain("management.create failed")
    expect(fixture.events.slice(0, 8)).toEqual([
      "policy.load",
      "preflight",
      "permissions",
      "provider.accounting.create",
      "signal.register",
      "management.create",
      "management.recover",
      "diagnostics.collect",
    ])
    const destructiveInput = fixture.cleanupInputs.at(-1) as {
      readonly ownership: readonly { readonly name: string }[]
    }
    expect(destructiveInput.ownership.map(({ name }) => name)).toEqual([NAMES.managementNamespace])
  })

  test("recovers the exact chart-created sandbox ownership when infrastructure install partially fails", async () => {
    const fixture = createHarnessFixture({ failAt: "infrastructure.install" })

    await expect(runKubernetesCompatibility(OPTIONS, fixture.dependencies)).rejects.toThrow(
      "infrastructure.install failed",
    )

    expect(fixture.events.indexOf("sandbox.capture")).toBeGreaterThan(
      fixture.events.indexOf("infrastructure.install"),
    )
    const destructiveInput = fixture.cleanupInputs.at(-1) as {
      readonly ownership: readonly { readonly name: string }[]
      readonly installedReleases: readonly string[]
    }
    expect(destructiveInput.ownership.map(({ name }) => name)).toEqual([
      NAMES.managementNamespace,
      NAMES.sandboxNamespace,
    ])
    expect(destructiveInput.installedReleases).toEqual(["infrastructure"])
  })

  test("keeps the infrastructure cleanup candidate when the first live ownership assertion fails", async () => {
    const fixture = createHarnessFixture()
    const baseExecute = fixture.dependencies.execute as Runner
    let sandboxReads = 0
    const execute = vi.fn<Runner>(async (command, options) => {
      if (
        command.file === "kubectl" &&
        command.args.includes("namespace") &&
        command.args.includes(NAMES.sandboxNamespace)
      ) {
        sandboxReads += 1
        if (sandboxReads === 1) {
          fixture.commandCalls.push({ command, options })
          fixture.events.push("sandbox.capture.invalid")
          return result(command, {
            apiVersion: "v1",
            kind: "Namespace",
            metadata: {
              name: NAMES.sandboxNamespace,
              uid: "sandbox-uid",
              labels: { "dawn.sh/compat-run": "another-run" },
            },
          })
        }
      }
      return baseExecute(command, options)
    })

    await expect(
      runKubernetesCompatibility(OPTIONS, { ...fixture.dependencies, execute }),
    ).rejects.toThrow(/ownership label/i)

    const destructiveInput = fixture.cleanupInputs.at(-1) as {
      readonly installedReleases: readonly string[]
    }
    expect(sandboxReads).toBe(2)
    expect(destructiveInput.installedReleases).toEqual(["infrastructure"])
  })

  test("keeps the application cleanup candidate when its Helm install mutates then fails", async () => {
    const fixture = createHarnessFixture({ failAt: "application.install" })
    let attemptedReleases: readonly string[] | undefined
    const collectDiagnostics = vi.fn(async (input: CompatibilityDiagnosticsInput) => {
      attemptedReleases = input.attemptedReleases
      return { collected: true }
    })

    await expect(
      runKubernetesCompatibility(OPTIONS, { ...fixture.dependencies, collectDiagnostics }),
    ).rejects.toThrow("application.install failed")

    const destructiveInput = fixture.cleanupInputs.at(-1) as {
      readonly installedReleases: readonly string[]
    }
    expect(destructiveInput.installedReleases).toEqual(["infrastructure", "application"])
    expect(new Set(destructiveInput.installedReleases).size).toBe(
      destructiveInput.installedReleases.length,
    )
    expect(collectDiagnostics).toHaveBeenCalledOnce()
    expect(attemptedReleases).toEqual(["infrastructure", "application"])
  })

  test("fails closed without an infrastructure uninstall when sandbox ownership cannot be recovered", async () => {
    const fixture = createHarnessFixture({ failAt: "infrastructure.install" })
    const baseExecute = fixture.dependencies.execute as Runner
    const execute = vi.fn<Runner>(async (command, options) => {
      if (
        command.file === "kubectl" &&
        command.args.includes("namespace") &&
        command.args.includes(NAMES.sandboxNamespace)
      ) {
        fixture.commandCalls.push({ command, options })
        fixture.events.push("sandbox.capture.missing")
        return result(command)
      }
      return baseExecute(command, options)
    })

    await expect(
      runKubernetesCompatibility(OPTIONS, { ...fixture.dependencies, execute }),
    ).rejects.toThrow("infrastructure.install failed")

    const destructiveInput = fixture.cleanupInputs.at(-1) as {
      readonly ownership: readonly { readonly name: string }[]
      readonly installedReleases: readonly string[]
    }
    expect(destructiveInput.ownership.map(({ name }) => name)).toEqual([NAMES.managementNamespace])
    expect(destructiveInput.installedReleases).toEqual([])
  })

  test("retains owned cluster resources only for a failed run while always cleaning local and network material", async () => {
    const failed = createHarnessFixture({ failAt: "probe.reaper.lifecycle.before-upgrade" })

    await expect(
      runKubernetesCompatibility({ ...OPTIONS, keepOnFailure: true }, failed.dependencies),
    ).rejects.toThrow("probe.reaper.lifecycle.before-upgrade failed")

    expect(failed.events).toContain("cleanup.verify")
    expect(failed.events).not.toContain("cleanup.destroy")
    expect(failed.events).toContain("network.cleanup")
    expect(failed.events).toContain("token.destroy.1")
    expect(failed.events).toContain("token.destroy.2")
    expect(failed.reports.at(-1)?.cleanup).toMatchObject({
      status: "passed",
      diagnostics: { retained: true },
    })

    const successful = createHarnessFixture()
    await runKubernetesCompatibility({ ...OPTIONS, keepOnFailure: true }, successful.dependencies)
    expect(successful.events).toContain("cleanup.destroy")
    expect(successful.reports.at(-1)?.cleanup).toMatchObject({
      status: "passed",
      diagnostics: { retained: false },
    })
  })

  test("fresh ownership failure blocks network and cluster cleanup without suppressing token cleanup", async () => {
    const fixture = createHarnessFixture({
      failAt: "probe.reaper.lifecycle.before-upgrade",
      failOwnershipVerification: true,
    })

    const error = await runKubernetesCompatibility(
      { ...OPTIONS, keepOnFailure: true },
      fixture.dependencies,
    ).catch((cause: unknown) => cause)

    expect(flattenErrorMessages(error)).toEqual(
      expect.arrayContaining([
        "probe.reaper.lifecycle.before-upgrade failed",
        "ownership verification failed",
      ]),
    )
    expect(fixture.events).not.toContain("network.cleanup")
    expect(fixture.events).toContain("token.destroy.1")
    expect(fixture.events).toContain("token.destroy.2")
    expect(fixture.events).not.toContain("cleanup.destroy")
    expect(fixture.reports.at(-1)?.cleanup.status).toBe("failed")
  })

  test("preserves a primary failure and every independent cleanup failure", async () => {
    const fixture = createHarnessFixture({
      failAt: "provider.execute.provider-before-upgrade",
      failTokenDestroy: true,
      failNetworkCleanup: true,
      failClusterDestruction: true,
    })

    const error = await runKubernetesCompatibility(OPTIONS, fixture.dependencies).catch(
      (cause: unknown) => cause,
    )
    const messages = flattenErrorMessages(error)

    expect(messages).toEqual(
      expect.arrayContaining([
        "provider.execute.provider-before-upgrade failed",
        "token destroy 1 failed",
        "network cleanup failed",
        "cluster destruction failed",
      ]),
    )
    expect(fixture.events.filter((event) => event === "network.cleanup")).toHaveLength(1)
    expect(fixture.events.filter((event) => event === "token.destroy.1").length).toBeGreaterThan(1)
    expect(fixture.reports.at(-1)?.cleanup.status).toBe("failed")
  })

  test("settles synchronous cleanup throws independently before destructive cleanup", async () => {
    const fixture = createHarnessFixture({
      failAt: "probe.reaper.lifecycle.before-upgrade",
      failNetworkCleanupSynchronously: true,
      failClusterDestruction: true,
    })

    const error = await runKubernetesCompatibility(OPTIONS, fixture.dependencies).catch(
      (cause: unknown) => cause,
    )

    expect(flattenErrorMessages(error)).toEqual(
      expect.arrayContaining([
        "probe.reaper.lifecycle.before-upgrade failed",
        "network cleanup synchronously failed",
        "cluster destruction failed",
      ]),
    )
    expect(fixture.events).toContain("cleanup.destroy")
    expect(fixture.reports.at(-1)?.cleanup.status).toBe("failed")
  })

  test("accounts a provider report before destroying its directory even when later accounting fails", async () => {
    const fixture = createHarnessFixture({ failAt: "provider.account.provider-before-upgrade" })

    await expect(runKubernetesCompatibility(OPTIONS, fixture.dependencies)).rejects.toThrow(
      "provider.account.provider-before-upgrade failed",
    )

    expect(fixture.events.indexOf("provider.account.provider-before-upgrade")).toBeLessThan(
      fixture.events.indexOf("token.destroy.1"),
    )
    expect(fixture.events).not.toContain("provider.finish")
  })

  test("accounts an exit-one provider JSON report and surfaces the named failed assertion", async () => {
    const fixture = createHarnessFixture()
    const manifest = JSON.parse(
      await readFile(join(REPOSITORY_ROOT, "test/k8s-compat/expected-tests.json"), "utf8"),
    ) as { readonly providerPhases: { readonly "provider-before-upgrade": readonly string[] } }
    const failedId = manifest.providerPhases["provider-before-upgrade"][0] as string
    const tokenDirectories: string[] = []
    let reportPath = ""
    let tokenIndex = 0
    const createTokenKubeconfig = vi.fn(async (): Promise<SecureTokenKubeconfig> => {
      tokenIndex += 1
      fixture.events.push(`token.create.${tokenIndex}`)
      const directory = await mkdtemp(join(tmpdir(), "dawn-harness-provider-"))
      tokenDirectories.push(directory)
      return {
        directory,
        path: join(directory, "kubeconfig.yaml"),
        async destroy(): Promise<void> {
          fixture.events.push(`token.destroy.${tokenIndex}`)
          await rm(directory, { recursive: true, force: true })
        },
      }
    })
    const baseExecute = fixture.dependencies.execute as Runner
    const execute = vi.fn<Runner>(async (command, options) => {
      if (command.file !== "pnpm") return baseExecute(command, options)
      fixture.commandCalls.push({ command, options })
      fixture.events.push("provider.execute.provider-before-upgrade")
      reportPath =
        command.args.find((argument) => argument.startsWith("--outputFile="))?.slice(13) ?? ""
      await writeFile(
        reportPath,
        JSON.stringify({
          success: false,
          numPendingTestSuites: 0,
          numPendingTests: 0,
          numTodoTests: 0,
          testResults: [
            {
              assertionResults: manifest.providerPhases["provider-before-upgrade"].map(
                (fullName, index) => ({ fullName, status: index === 0 ? "failed" : "passed" }),
              ),
            },
          ],
        }),
      )
      if (!options?.acceptedExitCodes?.includes(1)) {
        throw new Error("provider command exited with code 1")
      }
      expect(options.sensitiveOutput).toBe(true)
      return result(command, "", 1)
    })
    const {
      createProviderAccountingSession: _fakeAccounting,
      createTokenKubeconfig: _fakeTokenKubeconfig,
      ...dependencies
    } = fixture.dependencies
    let stderr = ""

    const exitCode = await runKubernetesCompatibilityMain(
      ["--target", TARGET, "--context", CONTEXT],
      {
        ...dependencies,
        createTokenKubeconfig,
        execute,
        writeStderr: (chunk) => {
          stderr += chunk
        },
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain(failedId)
    expect(stderr).not.toContain("provider command exited with code 1")
    expect(JSON.stringify(fixture.reports.at(-1))).toContain(failedId)
    expect(fixture.events.indexOf("provider.execute.provider-before-upgrade")).toBeLessThan(
      fixture.events.indexOf("token.destroy.1"),
    )
    expect(tokenDirectories).toHaveLength(1)
    await expect(readFile(reportPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test.each([
    {
      name: "abnormal exit",
      timeoutMs: 2_000,
      script: (stderr: string) => `process.stderr.write(${JSON.stringify(stderr)});process.exit(2)`,
      outcome: "exit",
    },
    {
      name: "timeout",
      timeoutMs: 75,
      script: (stderr: string) =>
        `process.stderr.write(${JSON.stringify(stderr)});setInterval(()=>{},1000)`,
      outcome: "timeout",
    },
  ])("never exposes provider stderr credentials on $name", async (testCase) => {
    const fixture = createHarnessFixture()
    const credentialValues = [
      "OPENAI_API_KEY=plain-api-key-value",
      "PASSWORD=hunter2",
      "postgres://user:pass@db.internal/dawn",
    ]
    const providerStderr = credentialValues.join("\n")
    const baseExecute = fixture.dependencies.execute as Runner
    let serializedCommandError = ""
    const execute = vi.fn<Runner>(async (command, options) => {
      if (command.file !== "pnpm") return baseExecute(command, options)
      fixture.commandCalls.push({ command, options })
      fixture.events.push("provider.execute.provider-before-upgrade")
      try {
        return await executeCommand(
          {
            file: process.execPath,
            args: ["-e", testCase.script(providerStderr)],
          },
          { ...options, timeoutMs: testCase.timeoutMs },
        )
      } catch (error) {
        serializedCommandError = JSON.stringify(error)
        throw error
      }
    })
    let stderr = ""

    const exitCode = await runKubernetesCompatibilityMain(
      ["--target", TARGET, "--context", CONTEXT],
      {
        ...fixture.dependencies,
        execute,
        writeStderr: (chunk) => {
          stderr += chunk
        },
      },
    )

    expect(exitCode).toBe(1)
    expect(serializedCommandError).toContain(`"kind":"${testCase.outcome}"`)
    for (const forbidden of credentialValues) {
      expect(serializedCommandError).not.toContain(forbidden)
      expect(JSON.stringify(fixture.reports)).not.toContain(forbidden)
      expect(stderr).not.toContain(forbidden)
    }
    expect(serializedCommandError).not.toContain("plain-api-key-value")
    expect(serializedCommandError).not.toContain("hunter2")
    expect(serializedCommandError).not.toContain("OPENAI_API_KEY")
    expect(serializedCommandError).not.toContain("PASSWORD")
    expect(serializedCommandError).not.toContain("postgres://")
    expect(stderr).not.toContain("plain-api-key-value")
    expect(stderr).not.toContain("hunter2")
  })

  test("fails explicitly after successful accounting when a provider command still exits one", async () => {
    const fixture = createHarnessFixture()
    const baseExecute = fixture.dependencies.execute as Runner
    const execute = vi.fn<Runner>(async (command, options) => {
      if (command.file !== "pnpm") return baseExecute(command, options)
      fixture.commandCalls.push({ command, options })
      fixture.events.push("provider.execute.provider-before-upgrade")
      return result(command, "", 1)
    })

    await expect(
      runKubernetesCompatibility(OPTIONS, { ...fixture.dependencies, execute }),
    ).rejects.toThrow(/provider-before-upgrade.*exit(?:ed)? with code 1/i)

    expect(fixture.events.indexOf("provider.account.provider-before-upgrade")).toBeLessThan(
      fixture.events.indexOf("token.destroy.1"),
    )
  })
})

describe("signal cleanup", () => {
  test.each([
    { name: "returns the accepted Namespace", rejectResponse: false },
    { name: "loses the response after API acceptance", rejectResponse: true },
  ])(
    "registers before management Namespace creation, waits when creation $name, and recovers ownership",
    async ({ rejectResponse }) => {
      const fixture = createHarnessFixture()
      const emitter = new EventEmitter()
      const createStarted = deferred()
      const releaseCreate = deferred()
      const terminated = deferred()
      let createSignal: AbortSignal | undefined
      const baseExecute = fixture.dependencies.execute as Runner
      const execute = vi.fn<Runner>(async (command, options) => {
        if (
          command.file === "kubectl" &&
          command.args.includes("create") &&
          typeof options?.stdin === "string" &&
          options.stdin.includes('"kind":"Namespace"')
        ) {
          fixture.commandCalls.push({ command, options })
          fixture.events.push("management.create.started")
          createSignal = options.signal
          createStarted.resolve()
          await releaseCreate.promise
          fixture.events.push("management.create.settled")
          if (rejectResponse) throw new Error("management Namespace response was lost")
          return result(command, namespace(NAMES.managementNamespace, "management-uid"))
        }
        if (
          command.file === "kubectl" &&
          command.args.includes("get") &&
          command.args.includes(NAMES.sandboxNamespace)
        ) {
          fixture.commandCalls.push({ command, options })
          return result(command, "")
        }
        return baseExecute(command, options)
      })
      const { registerSignalCleanup: _fakeRegistration, ...dependenciesWithoutFakeRegistration } =
        fixture.dependencies
      const run = runKubernetesCompatibility(OPTIONS, {
        ...dependenciesWithoutFakeRegistration,
        execute,
        registerSignalCleanup: registerOwnedResourceSignalCleanup,
        signalCleanupOptions: {
          emitter,
          terminate: (observedSignal) => {
            fixture.events.push(`terminate.${observedSignal}`)
            terminated.resolve()
          },
          timeoutMs: 5_000,
        },
      }).catch((error: unknown) => error)

      await createStarted.promise
      try {
        expect(emitter.listenerCount("SIGTERM")).toBe(1)
        emitter.emit("SIGTERM")
        await nextEventLoopTurn()
        expect(createSignal?.aborted).toBe(true)
        expect(fixture.events).not.toContain("terminate.SIGTERM")

        releaseCreate.resolve()
        await terminated.promise
        const error = await run

        expect(error).toBeInstanceOf(Error)
        expect(fixture.events.indexOf("management.create.settled")).toBeLessThan(
          fixture.events.lastIndexOf("management.recover"),
        )
        expect(fixture.events.lastIndexOf("management.recover")).toBeLessThan(
          fixture.events.indexOf("cleanup.verify"),
        )
        expect(fixture.events.indexOf("cleanup.verify")).toBeLessThan(
          fixture.events.indexOf("cleanup.destroy"),
        )
        expect(fixture.events.indexOf("cleanup.destroy")).toBeLessThan(
          fixture.events.indexOf("terminate.SIGTERM"),
        )
        expect(fixture.cleanupInputs.at(-1)).toMatchObject({
          ownership: [
            {
              name: NAMES.managementNamespace,
              uid: "management-uid",
              runId: RUN_ID,
            },
          ],
          installedReleases: [],
        })
      } finally {
        releaseCreate.resolve()
        await run
      }
    },
  )

  test.skipIf(process.platform === "win32")(
    "waits for confirmed detached provider descendants before token and cluster cleanup",
    async () => {
      const fixture = createHarnessFixture()
      const directory = await mkdtemp(join(tmpdir(), "dawn-harness-provider-tree-"))
      const pidPath = join(directory, "descendant-pid")
      const sentinelPath = join(directory, "descendant-sentinel")
      const emitter = new EventEmitter()
      const terminated = deferred()
      const descendantScript = [
        'const { writeFileSync } = require("node:fs")',
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
        'process.stdout.write("ready\\n")',
        `setTimeout(() => writeFileSync(${JSON.stringify(sentinelPath)}, "provider descendant survived"), 5_000)`,
        "setInterval(() => {}, 1_000)",
      ].join(";")
      const wrapperScript = [
        'const { spawn } = require("node:child_process")',
        `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { detached: true, stdio: ["ignore", "pipe", "ignore"] })`,
        'descendant.stdout.once("data", () => { process.stdout.write("provider-descendant-ready\\n"); descendant.stdout.destroy(); descendant.unref() })',
        "setInterval(() => {}, 1_000)",
      ].join(";")
      const baseExecute = fixture.dependencies.execute as Runner
      const execute = vi.fn<Runner>(async (command, options) => {
        if (command.file !== "pnpm") return baseExecute(command, options)
        fixture.commandCalls.push({ command, options })
        fixture.events.push("provider.execute.provider-before-upgrade")
        try {
          return await executeCommand(
            { file: process.execPath, args: ["-e", wrapperScript] },
            options,
          )
        } finally {
          const descendantPid = Number(await readFile(pidPath, "utf8"))
          fixture.events.push(
            processIsRunning(descendantPid) ? "provider.tree.alive" : "provider.tree.confirmed",
          )
        }
      })
      const { registerSignalCleanup: _fakeRegistration, ...dependenciesWithoutFakeRegistration } =
        fixture.dependencies

      try {
        const run = runKubernetesCompatibility(OPTIONS, {
          ...dependenciesWithoutFakeRegistration,
          execute,
          registerSignalCleanup: registerOwnedResourceSignalCleanup,
          signalCleanupOptions: {
            emitter,
            terminate: (observedSignal) => {
              fixture.events.push(`terminate.${observedSignal}`)
              terminated.resolve()
            },
            timeoutMs: 5_000,
          },
        }).catch((error: unknown) => error)

        await waitForHarnessFile(pidPath)
        emitter.emit("SIGTERM")
        await terminated.promise
        const error = await run

        expect(error).toBeInstanceOf(Error)
        expect(fixture.events).toContain("provider.tree.confirmed")
        expect(fixture.events).not.toContain("provider.tree.alive")
        expect(fixture.events.indexOf("provider.tree.confirmed")).toBeLessThan(
          fixture.events.indexOf("token.destroy.1"),
        )
        expect(fixture.events.indexOf("token.destroy.1")).toBeLessThan(
          fixture.events.indexOf("cleanup.destroy"),
        )
      } finally {
        await stopHarnessProcess(pidPath)
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  test.each([
    { name: "token destroy succeeds", failTokenDestroy: false },
    { name: "token destroy fails", failTokenDestroy: true },
  ])(
    "always attempts local $name while unconfirmed containment blocks remote cleanup",
    async ({ failTokenDestroy }) => {
      const fixture = createHarnessFixture({ failTokenDestroy })
      const emitter = new EventEmitter()
      const providerStarted = deferred()
      const terminated = deferred()
      const baseExecute = fixture.dependencies.execute as Runner
      const execute = vi.fn<Runner>(async (command, options) => {
        if (command.file !== "pnpm") return baseExecute(command, options)
        fixture.commandCalls.push({ command, options })
        fixture.events.push("provider.execute.provider-before-upgrade")
        providerStarted.resolve()
        await new Promise<void>((resolveAbort) => {
          if (options?.signal?.aborted === true) resolveAbort()
          else options?.signal?.addEventListener("abort", () => resolveAbort(), { once: true })
        })
        const error = new CommandExecutionError(
          "Command was aborted; process-tree termination failed: process tree termination could not be confirmed",
          command,
          { kind: "aborted" },
          { sensitiveOutput: true, processTreeTermination: "unconfirmed" },
        )
        throw error
      })
      const { registerSignalCleanup: _fakeRegistration, ...dependenciesWithoutFakeRegistration } =
        fixture.dependencies

      const run = runKubernetesCompatibility(OPTIONS, {
        ...dependenciesWithoutFakeRegistration,
        execute,
        registerSignalCleanup: registerOwnedResourceSignalCleanup,
        signalCleanupOptions: {
          emitter,
          terminate: (observedSignal) => {
            fixture.events.push(`terminate.${observedSignal}`)
            terminated.resolve()
          },
          timeoutMs: 5_000,
        },
      }).catch((error: unknown) => error)

      await providerStarted.promise
      emitter.emit("SIGINT")
      await terminated.promise
      const error = await run

      expect(error).toBeInstanceOf(Error)
      expect(fixture.events).toContain("token.destroy.1")
      if (failTokenDestroy) {
        expect(flattenErrorMessages(error)).toContain("token destroy 1 failed")
      }
      expect(flattenErrorMessages(error).join("\n")).toMatch(/process tree termination/i)
      expect(fixture.events).not.toContain("network.cleanup")
      expect(fixture.events).not.toContain("cleanup.verify")
      expect(fixture.events).not.toContain("cleanup.destroy")
      expect(fixture.events).toContain("terminate.SIGINT")
    },
  )

  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "cleans partial network setup with the raw executor before failing cluster cleanup on %s",
    async (signal) => {
      const fixture = createHarnessFixture({ failClusterDestruction: true })
      const emitter = new EventEmitter()
      const networkWaitStarted = deferred()
      const terminated = deferred()
      let networkWaitSignal: AbortSignal | undefined
      const baseExecute = fixture.dependencies.execute as Runner
      const execute = vi.fn<Runner>(async (command, options) => {
        if (
          command.file === "kubectl" &&
          command.args.includes("wait") &&
          command.args.includes("--for=condition=Ready")
        ) {
          fixture.commandCalls.push({ command, options })
          networkWaitSignal = options?.signal
          networkWaitStarted.resolve()
          await new Promise<never>((_resolve, reject) => {
            if (options?.signal?.aborted === true) {
              reject(new Error("network setup aborted"))
              return
            }
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("network setup aborted")),
              { once: true },
            )
          })
        }
        if (command.file === "kubectl" && command.args.includes("--selector")) {
          fixture.events.push("network.raw.cleanup")
        }
        return baseExecute(command, options)
      })
      const { registerSignalCleanup: _fakeRegistration, ...dependenciesWithoutFakeRegistration } =
        fixture.dependencies
      const run = runKubernetesCompatibility(OPTIONS, {
        ...dependenciesWithoutFakeRegistration,
        execute,
        registerSignalCleanup: registerOwnedResourceSignalCleanup,
        signalCleanupOptions: {
          emitter,
          terminate: (observedSignal) => {
            fixture.events.push(`terminate.${observedSignal}`)
            terminated.resolve()
          },
          timeoutMs: 5_000,
        },
        probes: {
          ...fixture.dependencies.probes,
          networkControl: runNetworkControlProbe,
        },
      }).catch((error: unknown) => error)

      await networkWaitStarted.promise
      emitter.emit(signal)
      await terminated.promise
      const error = await run

      expect(networkWaitSignal?.aborted).toBe(true)
      const rawCleanupCalls = fixture.commandCalls.filter(
        ({ command }) => command.file === "kubectl" && command.args.includes("--selector"),
      )
      expect(rawCleanupCalls).toHaveLength(3)
      expect(rawCleanupCalls.every(({ options }) => options?.signal === undefined)).toBe(true)
      expect(fixture.events.filter((event) => event === "network.raw.cleanup")).toHaveLength(3)
      const ownershipGuardCalls = fixture.commandCalls.filter(
        ({ command }) =>
          command.file === "kubectl" &&
          command.args.join(" ") ===
            `--context ${CONTEXT} get namespace ${NAMES.sandboxNamespace} --output=json`,
      )
      expect(ownershipGuardCalls).toHaveLength(3)
      expect(ownershipGuardCalls.every(({ options }) => options?.signal === undefined)).toBe(true)
      expect(flattenErrorMessages(error)).toEqual(
        expect.arrayContaining(["network setup aborted", "cluster destruction failed"]),
      )
      expect(fixture.events.indexOf("network.raw.cleanup")).toBeLessThan(
        fixture.events.indexOf("cleanup.destroy"),
      )
      expect(fixture.events.indexOf("cleanup.destroy")).toBeLessThan(
        fixture.events.indexOf(`terminate.${signal}`),
      )
    },
  )

  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "waits for an in-flight infrastructure install and recovers its ownership before %s cleanup",
    async (signal) => {
      const fixture = createHarnessFixture()
      const emitter = new EventEmitter()
      const installStarted = deferred()
      const releaseInstall = deferred()
      const terminated = deferred()
      let terminatedEarly = false
      let installSignal: AbortSignal | undefined
      const baseExecute = fixture.dependencies.execute as Runner
      const execute = vi.fn<Runner>(async (command, options) => {
        if (command.file === "helm" && command.args.includes("test-infrastructure-install")) {
          fixture.commandCalls.push({ command, options })
          fixture.events.push("infrastructure.install")
          installSignal = options?.signal
          installStarted.resolve()
          await releaseInstall.promise
          fixture.events.push("infrastructure.install.settled")
          throw new Error("infrastructure install stopped after signal")
        }
        return baseExecute(command, options)
      })
      const { registerSignalCleanup: _fakeRegistration, ...dependenciesWithoutFakeRegistration } =
        fixture.dependencies
      const run = runKubernetesCompatibility(OPTIONS, {
        ...dependenciesWithoutFakeRegistration,
        execute,
        registerSignalCleanup: registerOwnedResourceSignalCleanup,
        signalCleanupOptions: {
          emitter,
          terminate: (observedSignal) => {
            fixture.events.push(`terminate.${observedSignal}`)
            terminated.resolve()
          },
          timeoutMs: 5_000,
        },
        probes: {
          ...fixture.dependencies.probes,
          installInfrastructure: async ({ execute: runCommand }) => {
            if (runCommand === undefined) throw new Error("Expected injected lifecycle executor")
            await runCommand({ file: "helm", args: ["test-infrastructure-install"] })
          },
        },
      }).catch((error: unknown) => error)

      await installStarted.promise
      emitter.emit(signal)
      await nextEventLoopTurn()
      terminatedEarly = fixture.events.includes(`terminate.${signal}`)
      const abortedBeforeSettlement = installSignal?.aborted === true
      releaseInstall.resolve()
      await terminated.promise
      const error = await run

      expect(flattenErrorMessages(error)).toContain("infrastructure install stopped after signal")
      expect(terminatedEarly).toBe(false)
      expect(abortedBeforeSettlement).toBe(true)
      expect(fixture.events.indexOf("infrastructure.install.settled")).toBeLessThan(
        fixture.events.lastIndexOf("sandbox.capture"),
      )
      expect(fixture.events.lastIndexOf("sandbox.capture")).toBeLessThan(
        fixture.events.indexOf("cleanup.destroy"),
      )
      expect(fixture.events.indexOf("cleanup.destroy")).toBeLessThan(
        fixture.events.indexOf(`terminate.${signal}`),
      )
      expect(fixture.events).not.toContain("probe.namespace.sandbox-secrets-empty")
      const sandboxRecoveryCalls = fixture.commandCalls.filter(
        ({ command }) =>
          command.file === "kubectl" && command.args.includes(NAMES.sandboxNamespace),
      )
      expect(sandboxRecoveryCalls.length).toBeGreaterThan(0)
      expect(sandboxRecoveryCalls.every(({ options }) => options?.signal === undefined)).toBe(true)
      const destructiveInput = fixture.cleanupInputs.at(-1) as {
        readonly installedReleases: readonly string[]
      }
      expect(destructiveInput.installedReleases).toEqual(["infrastructure"])
    },
  )

  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "waits for an in-flight application install and includes its release in %s cleanup",
    async (signal) => {
      const fixture = createHarnessFixture()
      const emitter = new EventEmitter()
      const installStarted = deferred()
      const releaseInstall = deferred()
      const terminated = deferred()
      let installSignal: AbortSignal | undefined
      const baseExecute = fixture.dependencies.execute as Runner
      const execute = vi.fn<Runner>(async (command, options) => {
        if (command.file === "helm" && command.args.includes("test-application-install")) {
          fixture.commandCalls.push({ command, options })
          fixture.events.push("application.install")
          installSignal = options?.signal
          installStarted.resolve()
          await releaseInstall.promise
          fixture.events.push("application.install.settled")
          throw new Error("application install stopped after signal")
        }
        return baseExecute(command, options)
      })
      const { registerSignalCleanup: _fakeRegistration, ...dependenciesWithoutFakeRegistration } =
        fixture.dependencies
      const run = runKubernetesCompatibility(OPTIONS, {
        ...dependenciesWithoutFakeRegistration,
        execute,
        registerSignalCleanup: registerOwnedResourceSignalCleanup,
        signalCleanupOptions: {
          emitter,
          terminate: (observedSignal) => {
            fixture.events.push(`terminate.${observedSignal}`)
            terminated.resolve()
          },
          timeoutMs: 5_000,
        },
        probes: {
          ...fixture.dependencies.probes,
          installApplication: async ({ execute: runCommand }) => {
            if (runCommand === undefined) throw new Error("Expected injected lifecycle executor")
            await runCommand({ file: "helm", args: ["test-application-install"] })
          },
        },
      }).catch((error: unknown) => error)

      await installStarted.promise
      emitter.emit(signal)
      await nextEventLoopTurn()
      const terminatedEarly = fixture.events.includes(`terminate.${signal}`)
      const abortedBeforeSettlement = installSignal?.aborted === true
      releaseInstall.resolve()
      await terminated.promise
      const error = await run

      expect(flattenErrorMessages(error)).toContain("application install stopped after signal")
      expect(terminatedEarly).toBe(false)
      expect(abortedBeforeSettlement).toBe(true)
      expect(fixture.events.indexOf("application.install.settled")).toBeLessThan(
        fixture.events.indexOf("cleanup.destroy"),
      )
      expect(fixture.events.indexOf("cleanup.destroy")).toBeLessThan(
        fixture.events.indexOf(`terminate.${signal}`),
      )
      expect(fixture.events).not.toContain("probe.app.service-ready.before-upgrade")
      const destructiveInput = fixture.cleanupInputs.at(-1) as {
        readonly installedReleases: readonly string[]
      }
      expect(destructiveInput.installedReleases).toEqual(["infrastructure", "application"])
    },
  )

  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "waits for token kubeconfig creation, registers its destroyer, and stops before provider work on %s",
    async (signal) => {
      const fixture = createHarnessFixture()
      const emitter = new EventEmitter()
      const createStarted = deferred()
      const releaseCreate = deferred()
      const terminated = deferred()
      const baseExecute = fixture.dependencies.execute as Runner
      const execute = vi.fn<Runner>(async (command, options) => {
        if (command.file === "pnpm") {
          fixture.commandCalls.push({ command, options })
          fixture.events.push("provider.started-after-shutdown")
          throw new Error("provider started after shutdown")
        }
        return baseExecute(command, options)
      })
      const createTokenKubeconfig = vi.fn(async (): Promise<SecureTokenKubeconfig> => {
        fixture.events.push("token.create.1")
        createStarted.resolve()
        await releaseCreate.promise
        fixture.events.push("token.create.1.settled")
        return {
          directory: "/secure/token-signal",
          path: "/secure/token-signal/kubeconfig.yaml",
          async destroy(): Promise<void> {
            fixture.events.push("token.destroy.1")
          },
        }
      })
      const { registerSignalCleanup: _fakeRegistration, ...dependenciesWithoutFakeRegistration } =
        fixture.dependencies
      const run = runKubernetesCompatibility(OPTIONS, {
        ...dependenciesWithoutFakeRegistration,
        createTokenKubeconfig,
        execute,
        registerSignalCleanup: registerOwnedResourceSignalCleanup,
        signalCleanupOptions: {
          emitter,
          terminate: (observedSignal) => {
            fixture.events.push(`terminate.${observedSignal}`)
            terminated.resolve()
          },
          timeoutMs: 5_000,
        },
        probes: {
          ...fixture.dependencies.probes,
          networkControl: async ({ cleanupExecute }) => {
            if (cleanupExecute === undefined) {
              throw new Error("Expected injected network cleanup executor")
            }
            fixture.events.push("probe.network.control-ready")
            return {
              url: `http://network.${NAMES.sandboxNamespace}.svc.cluster.local:8080/`,
              async cleanup(): Promise<void> {
                fixture.events.push("network.cleanup")
                await cleanupExecute({ file: "kubectl", args: ["test-network-cleanup"] })
              },
            }
          },
        },
      }).catch((error: unknown) => error)

      await createStarted.promise
      emitter.emit(signal)
      await nextEventLoopTurn()
      const terminatedEarly = fixture.events.includes(`terminate.${signal}`)
      releaseCreate.resolve()
      await terminated.promise
      const error = await run

      expect(error).toBeInstanceOf(Error)
      expect(terminatedEarly).toBe(false)
      expect(fixture.events).not.toContain("provider.started-after-shutdown")
      expect(fixture.events.indexOf("token.create.1.settled")).toBeLessThan(
        fixture.events.indexOf("token.destroy.1"),
      )
      expect(fixture.events.indexOf("token.destroy.1")).toBeLessThan(
        fixture.events.indexOf(`terminate.${signal}`),
      )
      const leaseCleanupCall = fixture.commandCalls.find(({ command }) =>
        command.args.includes("test-network-cleanup"),
      )
      expect(leaseCleanupCall).toBeDefined()
      expect(leaseCleanupCall?.options?.signal).toBeUndefined()
    },
  )

  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "aborts and settles an in-flight provider command before token and cluster cleanup on %s",
    async (signal) => {
      const fixture = createHarnessFixture()
      const emitter = new EventEmitter()
      const providerStarted = deferred()
      const releaseProvider = deferred()
      const terminated = deferred()
      let providerSignal: AbortSignal | undefined
      const baseExecute = fixture.dependencies.execute as Runner
      const execute = vi.fn<Runner>(async (command, options) => {
        if (command.file === "pnpm") {
          fixture.commandCalls.push({ command, options })
          fixture.events.push("provider.execute.provider-before-upgrade")
          providerSignal = options?.signal
          providerStarted.resolve()
          await releaseProvider.promise
          fixture.events.push("provider.execute.provider-before-upgrade.settled")
          throw new Error("provider stopped after signal")
        }
        return baseExecute(command, options)
      })
      const { registerSignalCleanup: _fakeRegistration, ...dependenciesWithoutFakeRegistration } =
        fixture.dependencies
      const run = runKubernetesCompatibility(OPTIONS, {
        ...dependenciesWithoutFakeRegistration,
        execute,
        registerSignalCleanup: registerOwnedResourceSignalCleanup,
        signalCleanupOptions: {
          emitter,
          terminate: (observedSignal) => {
            fixture.events.push(`terminate.${observedSignal}`)
            terminated.resolve()
          },
          timeoutMs: 5_000,
        },
      }).catch((error: unknown) => error)

      await providerStarted.promise
      emitter.emit(signal)
      await nextEventLoopTurn()
      const terminatedEarly = fixture.events.includes(`terminate.${signal}`)
      const abortedBeforeSettlement = providerSignal?.aborted === true
      releaseProvider.resolve()
      await terminated.promise
      const error = await run

      expect(flattenErrorMessages(error)).toContain("provider stopped after signal")
      expect(terminatedEarly).toBe(false)
      expect(abortedBeforeSettlement).toBe(true)
      expect(
        fixture.events.indexOf("provider.execute.provider-before-upgrade.settled"),
      ).toBeLessThan(fixture.events.indexOf("token.destroy.1"))
      expect(fixture.events.indexOf("token.destroy.1")).toBeLessThan(
        fixture.events.indexOf("cleanup.destroy"),
      )
      expect(fixture.events.indexOf("cleanup.destroy")).toBeLessThan(
        fixture.events.indexOf(`terminate.${signal}`),
      )
      expect(fixture.events.filter((event) => event === "cleanup.destroy")).toHaveLength(1)
    },
  )

  test("registers after non-mutating gates and before the first cluster mutation", async () => {
    const fixture = createHarnessFixture({ failAt: "probe.network.control-ready" })

    await expect(runKubernetesCompatibility(OPTIONS, fixture.dependencies)).rejects.toThrow()

    expect(fixture.events.indexOf("provider.accounting.create")).toBeLessThan(
      fixture.events.indexOf("signal.register"),
    )
    expect(fixture.events.indexOf("signal.register")).toBeLessThan(
      fixture.events.indexOf("management.create"),
    )
    expect(fixture.getSignalCleanup()).toBeTypeOf("function")
  })
})

describe("failure reports and diagnostics", () => {
  test("does not mutate or collect cluster diagnostics for an exact-context preflight failure", async () => {
    const fixture = createHarnessFixture()
    let stderr = ""
    const exitCode = await runKubernetesCompatibilityMain(
      ["--target", TARGET, "--context", "definitely-not-current"],
      {
        ...fixture.dependencies,
        preflight: async () => {
          fixture.events.push("preflight")
          throw new Error("kubectl current-context is not set")
        },
        writeStderr: (chunk) => {
          stderr += chunk
        },
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Kubernetes preflight for supplied context "definitely-not-current"')
    expect(stderr).toContain("kubectl current-context is not set")
    expect(stderr).toContain(ARTIFACT_DIRECTORY)
    expect(fixture.events).toEqual(["policy.load", "preflight", "report.persist", "report.persist"])
    expect(fixture.commandCalls).toEqual([])
    expect(fixture.reports.at(-1)?.cleanup.status).toBe("skipped")
  })

  test("collects only bounded explicit-context namespaced diagnostics and records collection errors safely", async () => {
    const fixture = createHarnessFixture({ failAt: "probe.reaper.lifecycle.before-upgrade" })
    const baseExecute = fixture.dependencies.execute as Runner
    let diagnosticFailureInjected = false
    const execute = vi.fn<Runner>(async (command, options) => {
      if (
        command.file === "kubectl" &&
        command.args.includes("get") &&
        command.args.includes("pods")
      ) {
        fixture.commandCalls.push({ command, options })
        const namespaceName = command.args[command.args.indexOf("--namespace") + 1]
        return result(command, {
          apiVersion: "v1",
          kind: "PodList",
          items: [
            {
              metadata: { name: "diagnostic-pod", namespace: namespaceName },
            },
          ],
        })
      }
      if (
        !diagnosticFailureInjected &&
        command.file === "kubectl" &&
        command.args.includes("events")
      ) {
        diagnosticFailureInjected = true
        fixture.commandCalls.push({ command, options })
        throw new Error(`diagnostic failed with ${ORCHESTRATOR_TOKEN}`)
      }
      return baseExecute(command, options)
    })
    const { collectDiagnostics: _fakeCollector, ...dependenciesWithDefaultCollector } =
      fixture.dependencies

    await expect(
      runKubernetesCompatibility(OPTIONS, {
        ...dependenciesWithDefaultCollector,
        execute,
      }),
    ).rejects.toThrow("probe.reaper.lifecycle.before-upgrade failed")

    const diagnosticStart = fixture.commandCalls.findIndex(({ command }) =>
      command.args.includes("events"),
    )
    expect(diagnosticStart).toBeGreaterThan(0)
    const diagnosticCalls = fixture.commandCalls.slice(diagnosticStart)
    expect(diagnosticCalls.some(({ command }) => command.args.includes("events"))).toBe(true)
    expect(diagnosticCalls.some(({ command }) => command.args.includes("describe"))).toBe(false)
    expect(diagnosticCalls.some(({ command }) => command.args.includes("logs"))).toBe(true)
    expect(
      diagnosticCalls.some(
        ({ command }) => command.file === "helm" && command.args.includes("status"),
      ),
    ).toBe(true)

    for (const { command, options } of diagnosticCalls) {
      expect(options?.timeoutMs).toBeGreaterThan(0)
      expect(options?.stdoutLimitBytes).toBeGreaterThan(0)
      expect(options?.stderrLimitBytes).toBeGreaterThan(0)
      if (command.file === "kubectl") {
        expect(command.args.slice(0, 2)).toEqual(["--context", CONTEXT])
      } else {
        expect(command.args.slice(0, 2)).toEqual(["--kube-context", CONTEXT])
      }
      expect(command.args).toContain("--namespace")
      expect(
        command.args.some((argument) =>
          /secret|serviceaccount|token|kubeconfig|env/i.test(argument),
        ),
      ).toBe(false)
    }
    const serializedReport = JSON.stringify(fixture.reports.at(-1))
    expect(serializedReport).not.toContain(ORCHESTRATOR_TOKEN)
    expect(serializedReport).toContain("[REDACTED]")
  })

  test("collects unlabeled chart objects plus validated provider Pod summaries and logs inside live-owned Namespaces", async () => {
    const calls: CommandCall[] = []
    const execute = vi.fn<Runner>(async (command, options) => {
      calls.push({ command, options })
      const args = command.args
      if (command.file === "kubectl" && args.includes("get") && args.includes("namespace")) {
        const name = args[args.indexOf("namespace") + 1]
        return name === NAMES.managementNamespace
          ? result(command, namespace(NAMES.managementNamespace, "management-uid"))
          : result(command, namespace(NAMES.sandboxNamespace, "sandbox-uid"))
      }
      const namespaceName = args[args.indexOf("--namespace") + 1]
      if (command.file === "kubectl" && args.includes("get") && args.includes("pods")) {
        return result(command, {
          apiVersion: "v1",
          kind: "PodList",
          items: [
            {
              apiVersion: "v1",
              kind: "Pod",
              metadata: { name: "provider-unlabeled", namespace: namespaceName },
              status: {
                phase: "Failed",
                containerStatuses: [
                  {
                    name: "provider",
                    ready: false,
                    restartCount: 2,
                    state: { terminated: { exitCode: 1, reason: "Error" } },
                  },
                ],
              },
            },
          ],
        })
      }
      if (
        command.file === "kubectl" &&
        args.includes("get") &&
        args.some((arg) => arg.includes(","))
      ) {
        return result(command, {
          apiVersion: "v1",
          kind: "List",
          items:
            namespaceName === NAMES.managementNamespace
              ? [
                  {
                    apiVersion: "apps/v1",
                    kind: "Deployment",
                    metadata: { name: "helm-deployment", namespace: namespaceName },
                  },
                ]
              : [
                  {
                    apiVersion: "batch/v1",
                    kind: "CronJob",
                    metadata: { name: "helm-cronjob", namespace: namespaceName },
                  },
                ],
        })
      }
      if (command.file === "kubectl" && args.includes("logs")) {
        return result(command, "provider diagnostic log\n")
      }
      return result(command, {})
    })

    const diagnostics = await collectKubernetesCompatibilityDiagnostics({
      context: CONTEXT,
      runId: RUN_ID,
      names: NAMES,
      ownership: [
        { name: NAMES.managementNamespace, uid: "management-uid", runId: RUN_ID },
        { name: NAMES.sandboxNamespace, uid: "sandbox-uid", runId: RUN_ID },
      ],
      attemptedReleases: ["infrastructure", "application"],
      execute,
    })

    expect(JSON.stringify(diagnostics)).toContain("helm-deployment")
    expect(JSON.stringify(diagnostics)).toContain("helm-cronjob")
    expect(JSON.stringify(diagnostics)).toContain('"restartCount":2')
    const describeCalls = calls.filter(
      ({ command }) => command.file === "kubectl" && command.args.includes("describe"),
    )
    expect(describeCalls).toHaveLength(0)
    const logCalls = calls.filter(
      ({ command }) => command.file === "kubectl" && command.args.includes("logs"),
    )
    expect(logCalls).toHaveLength(2)
    for (const { command } of logCalls) {
      expect(command.args).toContain("pod/provider-unlabeled")
    }
    for (const { command, options } of calls) {
      expect(options?.timeoutMs).toBeGreaterThan(0)
      expect(options?.stdoutLimitBytes).toBeGreaterThan(0)
      expect(options?.stderrLimitBytes).toBeGreaterThan(0)
      if (command.file === "kubectl" && command.args.includes("namespace")) {
        expect(command.args).toEqual(
          expect.arrayContaining(["--context", CONTEXT, "--output=json"]),
        )
      } else {
        expect(command.args).toContain("--namespace")
      }
      expect(command.args).not.toContain("--selector")
      expect(command.args.some((argument) => /secret|\benv\b/i.test(argument))).toBe(false)
    }
  })

  test.each([
    {
      name: "replacement UID",
      live: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: NAMES.sandboxNamespace,
          uid: "replacement-uid",
          labels: { "dawn.sh/compat-run": RUN_ID },
        },
      },
    },
    {
      name: "replacement run label",
      live: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: NAMES.sandboxNamespace,
          uid: "sandbox-uid",
          labels: { "dawn.sh/compat-run": "another-run" },
        },
      },
    },
  ])(
    "gates namespaced diagnostics against a same-name Namespace with a $name",
    async ({ live }) => {
      const calls: CommandCall[] = []
      const execute = vi.fn<Runner>(async (command, options) => {
        calls.push({ command, options })
        const args = command.args
        if (command.file === "kubectl" && args.includes("get") && args.includes("namespace")) {
          const name = args[args.indexOf("namespace") + 1]
          return result(
            command,
            name === NAMES.managementNamespace
              ? namespace(NAMES.managementNamespace, "management-uid")
              : live,
          )
        }
        if (command.file === "kubectl" && args.includes("get") && args.includes("pods")) {
          const namespaceName = args[args.indexOf("--namespace") + 1]
          return result(command, { apiVersion: "v1", kind: "PodList", items: [], namespaceName })
        }
        return result(command, {})
      })

      const diagnostics = await collectKubernetesCompatibilityDiagnostics({
        context: CONTEXT,
        runId: RUN_ID,
        names: NAMES,
        ownership: [
          { name: NAMES.managementNamespace, uid: "management-uid", runId: RUN_ID },
          { name: NAMES.sandboxNamespace, uid: "sandbox-uid", runId: RUN_ID },
        ],
        attemptedReleases: ["infrastructure", "application"],
        execute,
      })

      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: `${NAMES.sandboxNamespace}.ownership`, status: "failed" }),
        ]),
      )
      const sandboxNamespacedCalls = calls.filter(({ command }) => {
        const namespaceIndex = command.args.indexOf("--namespace")
        return namespaceIndex >= 0 && command.args[namespaceIndex + 1] === NAMES.sandboxNamespace
      })
      expect(sandboxNamespacedCalls).toEqual([])
      const sandboxOwnershipRead = calls.find(
        ({ command }) =>
          command.file === "kubectl" &&
          command.args.includes("namespace") &&
          command.args.includes(NAMES.sandboxNamespace),
      )
      expect(sandboxOwnershipRead?.command.args).toEqual([
        "--context",
        CONTEXT,
        "get",
        "namespace",
        NAMES.sandboxNamespace,
        "--output=json",
      ])
    },
  )

  test("persists only allowlisted diagnostics when cluster text contains ordinary credentials", async () => {
    const credentialValues = [
      "PASSWORD=hunter2",
      "OPENAI_API_KEY=plain-api-key-value",
      "credential=opaque-value",
      "postgres://ordinary-user:ordinary-password@db.internal/dawn",
      "Bearer plain-bearer-secret",
      "ordinary-non-jwt-credential",
    ]
    const execute = vi.fn<Runner>(async (command) => {
      const args = command.args
      if (command.file === "helm") {
        return result(command, {
          name: "compatibility-release",
          namespace: NAMES.managementNamespace,
          version: 2,
          info: {
            status: "deployed",
            first_deployed: "2030-01-01T00:00:00-08:00",
            last_deployed: "2030-01-01T00:01:00Z",
            notes: credentialValues.join("\n"),
          },
          manifest: ["env:", "- name: DATABASE_URL", `  value: ${credentialValues[3]}`].join("\n"),
          config: { PLAIN_PASSWORD: credentialValues[5] },
        })
      }
      if (command.file === "kubectl" && args.includes("get") && args.includes("namespace")) {
        const name = args[args.indexOf("namespace") + 1]
        return name === NAMES.managementNamespace
          ? result(command, namespace(NAMES.managementNamespace, "management-uid"))
          : result(command, namespace(NAMES.sandboxNamespace, "sandbox-uid"))
      }
      if (command.file === "kubectl" && args.includes("get") && args.includes("pods")) {
        const namespaceName = args[args.indexOf("--namespace") + 1]
        return result(command, {
          apiVersion: "v1",
          kind: "PodList",
          items: [
            {
              metadata: {
                name: "provider-pod",
                namespace: namespaceName,
                uid: "pod-uid",
                annotations: { debugging: credentialValues.join(" ") },
              },
              spec: {
                containers: [
                  {
                    name: "provider",
                    command: ["sh", "-c"],
                    args: [credentialValues.join(" ")],
                    env: [
                      { name: "DATABASE_URL", value: credentialValues[3] },
                      { name: "OPENAI_API_KEY", value: credentialValues[1] },
                      { name: "PLAIN_PASSWORD", value: credentialValues[5] },
                    ],
                    envFrom: [{ secretRef: { name: "provider-secrets" } }],
                  },
                ],
              },
              status: {
                phase: "Failed",
                conditions: [{ type: "Ready", status: "False", reason: "PodFailed" }],
                containerStatuses: [
                  {
                    name: "provider",
                    ready: false,
                    restartCount: 1,
                    state: { terminated: { exitCode: 9, reason: "Error", signal: 9 } },
                  },
                ],
              },
            },
          ],
        })
      }
      if (command.file === "kubectl" && args.includes("events")) {
        const namespaceName = args[args.indexOf("--namespace") + 1]
        return result(command, {
          apiVersion: "v1",
          kind: "EventList",
          items: [
            {
              metadata: {
                name: "provider-failed.123",
                namespace: namespaceName,
                uid: "event-uid",
                annotations: { debugging: credentialValues.join(" ") },
              },
              type: "Warning",
              reason: "FailedScheduling",
              reportingController: "kubernetes.io/scheduler",
              count: 2,
              firstTimestamp: "2030-01-01T00:00:00Z",
              lastTimestamp: "2030-01-01T00:01:00Z",
              involvedObject: {
                apiVersion: "v1",
                kind: "Pod",
                namespace: namespaceName,
                name: "provider-pod",
                uid: "pod-uid",
              },
              message: credentialValues.join(" "),
              note: credentialValues.join(" "),
            },
          ],
        })
      }
      if (
        command.file === "kubectl" &&
        args.includes("get") &&
        args.some((argument) => argument.includes(","))
      ) {
        const namespaceName = args[args.indexOf("--namespace") + 1]
        return result(command, {
          apiVersion: "v1",
          kind: "List",
          items: [
            {
              apiVersion: "apps/v1",
              kind: "Deployment",
              metadata: {
                name: "application",
                namespace: namespaceName,
                uid: "deployment-uid",
                generation: 3,
                annotations: { debugging: credentialValues.join(" ") },
              },
              spec: {
                template: {
                  spec: {
                    containers: [
                      {
                        name: "application",
                        command: ["sh", "-c"],
                        args: [credentialValues.join(" ")],
                        env: [{ name: "DATABASE_URL", value: credentialValues[3] }],
                        envFrom: [{ secretRef: { name: "application-secrets" } }],
                      },
                    ],
                  },
                },
              },
              status: {
                observedGeneration: 3,
                replicas: 2,
                readyReplicas: 1,
                unavailableReplicas: 1,
                conditions: [
                  {
                    type: "Available",
                    status: "False",
                    reason: "MinimumReplicasUnavailable",
                    message: credentialValues.join(" "),
                  },
                ],
              },
            },
          ],
        })
      }
      if (command.file === "kubectl" && args.includes("logs")) {
        return result(command, `${credentialValues.join("\n")}\n`)
      }
      return result(command, {})
    })

    const diagnostics = await collectKubernetesCompatibilityDiagnostics({
      context: CONTEXT,
      runId: RUN_ID,
      names: NAMES,
      ownership: [
        { name: NAMES.managementNamespace, uid: "management-uid", runId: RUN_ID },
        { name: NAMES.sandboxNamespace, uid: "sandbox-uid", runId: RUN_ID },
      ],
      attemptedReleases: ["infrastructure", "application"],
      execute,
    })
    const report: CompatibilityReport = {
      schemaVersion: 1,
      target: TARGET,
      observedServer: "v1.35.5",
      runId: RUN_ID,
      startedAt: "2030-01-01T00:00:00.000Z",
      finishedAt: "2030-01-01T00:01:00.000Z",
      steps: [],
      cleanup: { status: "failed" },
      diagnostics,
    }
    const temporaryRepository = await mkdtemp(join(tmpdir(), "dawn-k8s-diagnostics-"))
    try {
      const reportPath = await persistCompatibilityReport(
        temporaryRepository,
        "environment-redaction.json",
        report,
      )
      const serialized = await readFile(reportPath, "utf8")

      expect(serialized).toContain("provider-pod")
      expect(serialized).toContain('"restartCount": 1')
      expect(serialized).toContain("FailedScheduling")
      expect(serialized).toContain("MinimumReplicasUnavailable")
      expect(serialized).toContain('"readyReplicas": 1')
      expect(serialized).toContain('"status": "deployed"')
      expect(serialized).toContain("2030-01-01T00:00:00-08:00")
      expect(serialized).toContain('"captured": true')
      expect(serialized).toMatch(/"sha256": "[a-f0-9]{64}"/)
      for (const forbidden of [
        ...credentialValues,
        "hunter2",
        "plain-api-key-value",
        "opaque-value",
        "plain-bearer-secret",
        "DATABASE_URL",
        "OPENAI_API_KEY",
        "PLAIN_PASSWORD",
        "annotations",
        '"command"',
        '"args"',
        "envFrom",
        '"message"',
        '"note"',
      ]) {
        expect(serialized).not.toContain(forbidden)
      }
    } finally {
      await rm(temporaryRepository, { recursive: true, force: true })
    }
  })

  test("does not advertise a checkpoint as final when cleanup and final persistence fail", async () => {
    const fixture = createHarnessFixture({
      failAt: "probe.reaper.lifecycle.before-upgrade",
      failClusterDestruction: true,
      failFinalPersistence: true,
    })
    let stderr = ""

    const exitCode = await runKubernetesCompatibilityMain(
      ["--target", TARGET, "--context", CONTEXT],
      {
        ...fixture.dependencies,
        writeStderr: (chunk) => {
          stderr += chunk
        },
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain("probe.reaper.lifecycle.before-upgrade failed")
    expect(stderr).toContain("cluster destruction failed")
    expect(stderr).toContain("final report persistence failed")
    expect(stderr).not.toContain("Report:")
    expect(fixture.reports).toHaveLength(2)
    expect(fixture.reports[0]?.cleanup.status).toBe("skipped")
    expect(fixture.reports[1]?.cleanup.status).toBe("failed")
  })

  test("returns runtime exit 1 with a redacted assertion and report path", async () => {
    const fixture = createHarnessFixture({ failAt: "provider.execute.provider-before-upgrade" })
    let stderr = ""

    const exitCode = await runKubernetesCompatibilityMain(
      ["--target", TARGET, "--context", CONTEXT],
      {
        ...fixture.dependencies,
        writeStderr: (chunk) => {
          stderr += chunk
        },
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain("provider.execute.provider-before-upgrade failed")
    expect(stderr).toContain(ARTIFACT_DIRECTORY)
    expect(stderr).not.toContain(ORCHESTRATOR_TOKEN)
  })
})

describe("root entrypoint", () => {
  test("is import-safe and re-exports the harness public API", async () => {
    const entrypoint = await import("../../scripts/kubernetes-compat.ts")

    expect(entrypoint.runKubernetesCompatibility).toBe(runKubernetesCompatibility)
    expect(entrypoint.runKubernetesCompatibilityMain).toBe(runKubernetesCompatibilityMain)
  })
})
