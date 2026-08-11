import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { describe, expect, test, vi } from "vitest"
import {
  type ClusterPreflightResult,
  deriveClusterNames,
  registerOwnedResourceSignalCleanup,
  type SecureTokenKubeconfig,
} from "../../scripts/kubernetes-compat/cluster.ts"
import type {
  Command,
  CommandExecutionOptions,
  CommandResult,
} from "../../scripts/kubernetes-compat/command.ts"
import {
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
import { KUBERNETES_COMPAT_PROBE_IDS } from "../../scripts/kubernetes-compat/probes.ts"
import {
  ARTIFACT_DIRECTORY,
  assertExactStepAccounting,
  type CompatibilityReport,
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

function result(command: Command, value: unknown = ""): CommandResult {
  return {
    command,
    stdout: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
    toJSON: () => ({ command, outcome: { kind: "exit", exitCode: 0 } }),
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

interface FixtureOptions {
  readonly failAt?: string
  readonly failTokenDestroy?: boolean
  readonly failNetworkCleanup?: boolean
  readonly failNetworkCleanupSynchronously?: boolean
  readonly failOwnershipVerification?: boolean
  readonly failClusterDestruction?: boolean
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
      reports.push(report)
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
    registerSignalCleanup: (_ownership, cleanup) => {
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
      "management.create",
      "signal.register",
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
      expect(call.options?.env).toMatchObject({
        DAWN_TEST_K8S: "1",
        DAWN_TEST_K8S_NS: NAMES.sandboxNamespace,
        DAWN_TEST_K8S_IMAGE: POLICY.images.sandboxWorkload,
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
      "management.create",
      "management.recover",
      "signal.register",
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

  test("ownership verification gates retention and destructive cleanup without suppressing lease cleanup", async () => {
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
    expect(fixture.events).toContain("network.cleanup")
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
})

describe("signal cleanup", () => {
  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "cleans current ownership, releases, lease, and token material before preserving %s termination",
    async (signal) => {
      const fixture = createHarnessFixture()
      const emitter = new EventEmitter()
      let providerStartedResolve: (() => void) | undefined
      let releaseProviderResolve: (() => void) | undefined
      let terminatedResolve: (() => void) | undefined
      const providerStarted = new Promise<void>((resolve) => {
        providerStartedResolve = resolve
      })
      const releaseProvider = new Promise<void>((resolve) => {
        releaseProviderResolve = resolve
      })
      const terminated = new Promise<void>((resolve) => {
        terminatedResolve = resolve
      })
      const baseExecute = fixture.dependencies.execute as Runner
      const execute = vi.fn<Runner>(async (command, options) => {
        if (command.file === "pnpm") {
          fixture.commandCalls.push({ command, options })
          fixture.events.push("provider.execute.provider-before-upgrade")
          providerStartedResolve?.()
          await releaseProvider
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
            terminatedResolve?.()
          },
          timeoutMs: 1_000,
        },
      })

      await providerStarted
      emitter.emit(signal)
      await terminated
      releaseProviderResolve?.()
      await expect(run).rejects.toThrow("provider stopped after signal")

      expect(fixture.events.indexOf("cleanup.verify")).toBeLessThan(
        fixture.events.indexOf(`terminate.${signal}`),
      )
      expect(fixture.events.indexOf("network.cleanup")).toBeLessThan(
        fixture.events.indexOf(`terminate.${signal}`),
      )
      expect(fixture.events.indexOf("token.destroy.1")).toBeLessThan(
        fixture.events.indexOf(`terminate.${signal}`),
      )
      expect(fixture.events.indexOf("cleanup.destroy")).toBeLessThan(
        fixture.events.indexOf(`terminate.${signal}`),
      )
      expect(fixture.events.filter((event) => event === "cleanup.destroy")).toHaveLength(1)
    },
  )

  test("registers only after first UID ownership capture and closes over later state", async () => {
    const fixture = createHarnessFixture({ failAt: "probe.network.control-ready" })

    await expect(runKubernetesCompatibility(OPTIONS, fixture.dependencies)).rejects.toThrow()

    expect(fixture.events.indexOf("management.create")).toBeLessThan(
      fixture.events.indexOf("signal.register"),
    )
    expect(fixture.events.indexOf("signal.register")).toBeLessThan(
      fixture.events.indexOf("infrastructure.install"),
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
    expect(diagnosticCalls.some(({ command }) => command.args.includes("describe"))).toBe(true)
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

describe("shell supersession mapping", () => {
  const mapping = [
    {
      script: "test/k8s-smoke/setup-network-policy-control.sh",
      sha256: "928868766a2696e4813f601a82864851f07ce57920d4e393f5c72fbb598a7919",
      assertions: [
        {
          behavior: "server Pod becomes Ready",
          evidence: 'wait --for=condition=Ready "pod/$SERVER"',
          probeIds: ["network.control-ready"],
        },
        {
          behavior: "client Pod becomes Ready before the request",
          evidence: 'wait --for=condition=Ready "pod/$CLIENT"',
          probeIds: ["network.control-ready"],
        },
        {
          behavior: "the Service path returns exact HTTP 200",
          evidence: "expected HTTP 200",
          probeIds: ["network.control-ready"],
        },
        {
          behavior: "the stable in-cluster Service URL is exposed to provider tests",
          evidence: '"http://$SERVICE:8080/"',
          probeIds: ["network.control-ready"],
        },
      ],
    },
    {
      script: "test/k8s-smoke/assert-reaper.sh",
      sha256: "f476484111bc85f75742965ef01f56acdabf57509f4e0815a4d58ee632680aef",
      assertions: [
        {
          behavior: "a manual Job is created from the installed CronJob and completes",
          evidence: 'create job --from=cronjob/dawn-reaper "$JOB"',
          probeIds: ["reaper.lifecycle.before-upgrade", "reaper.lifecycle.after-infra-upgrade"],
        },
        {
          behavior: "the stale unreferenced PVC is deleted",
          evidence: 'wait --for=delete "pvc/$STALE_PVC"',
          probeIds: ["reaper.lifecycle.before-upgrade", "reaper.lifecycle.after-infra-upgrade"],
        },
        {
          behavior: "the new unreferenced PVC receives a positive marker",
          evidence: "new PVC marker is not a positive integer",
          probeIds: ["reaper.lifecycle.before-upgrade", "reaper.lifecycle.after-infra-upgrade"],
        },
        {
          behavior: "the referenced PVC remains live",
          evidence: 'get pvc "$REFERENCED_PVC" >/dev/null',
          probeIds: ["reaper.lifecycle.before-upgrade", "reaper.lifecycle.after-infra-upgrade"],
        },
        {
          behavior: "the retained referenced PVC has no unbound marker",
          evidence: "referenced PVC marker was not cleared",
          probeIds: ["reaper.lifecycle.before-upgrade", "reaper.lifecycle.after-infra-upgrade"],
        },
      ],
    },
  ] as const

  test("maps every locked shell assertion to the structured network and repeated reaper probes", async () => {
    const requiredBehaviors = [
      "server Pod becomes Ready",
      "client Pod becomes Ready before the request",
      "the Service path returns exact HTTP 200",
      "the stable in-cluster Service URL is exposed to provider tests",
      "a manual Job is created from the installed CronJob and completes",
      "the stale unreferenced PVC is deleted",
      "the new unreferenced PVC receives a positive marker",
      "the referenced PVC remains live",
      "the retained referenced PVC has no unbound marker",
    ]
    expect(mapping.flatMap(({ assertions }) => assertions.map(({ behavior }) => behavior))).toEqual(
      requiredBehaviors,
    )

    for (const entry of mapping) {
      const source = await readFile(join(REPOSITORY_ROOT, entry.script), "utf8")
      expect(createHash("sha256").update(source).digest("hex")).toBe(entry.sha256)
      for (const assertion of entry.assertions) {
        expect(source).toContain(assertion.evidence)
        for (const probeId of assertion.probeIds) {
          expect(KUBERNETES_COMPAT_PROBE_IDS).toContain(probeId)
        }
      }
    }
  })
})

describe("root entrypoint", () => {
  test("is import-safe and re-exports the harness public API", async () => {
    const entrypoint = await import("../../scripts/kubernetes-compat.ts")

    expect(entrypoint.runKubernetesCompatibility).toBe(runKubernetesCompatibility)
    expect(entrypoint.runKubernetesCompatibilityMain).toBe(runKubernetesCompatibilityMain)
  })
})
