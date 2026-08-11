import { EventEmitter } from "node:events"
import { readFile, stat } from "node:fs/promises"

import { afterEach, describe, expect, test, vi } from "vitest"
import { parse } from "yaml"
import {
  assertNamespacesAbsent,
  captureAdministrativeAccess,
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
  type SecureTokenKubeconfigDependencies,
  selectStorageClass,
  verifyNamespaceOwnership,
} from "../../scripts/kubernetes-compat/cluster.ts"
import type {
  Command,
  CommandExecutionOptions,
  CommandResult,
} from "../../scripts/kubernetes-compat/command.ts"

type Runner = (command: Command, options?: CommandExecutionOptions) => Promise<CommandResult>

const temporaryDirectories: string[] = []

function result(command: Command, value: unknown): CommandResult {
  return {
    command,
    stdout: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
    toJSON: () => ({ command, outcome: { kind: "exit", exitCode: 0 } }),
  }
}

function fakeRunner(responses: readonly unknown[]): ReturnType<typeof vi.fn<Runner>> {
  let index = 0
  return vi.fn(async (command: Command) => {
    const response = responses[index]
    index += 1
    if (response instanceof Error) throw response
    return result(command, response)
  })
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await import("node:fs/promises").then(({ rm }) =>
        rm(directory, { recursive: true, force: true }),
      )
    }),
  )
})

describe("cluster preflight", () => {
  test("fails when the exact supplied context is not current and performs no contextual call", async () => {
    const execute = fakeRunner(["kind-other\n"])

    await expect(
      preflightCluster(
        { context: "kind-dawn", targetMinor: "1.35", runId: "run-a" },
        { execute, executableExists: async () => true },
      ),
    ).rejects.toThrow(/current context.*kind-other.*kind-dawn/i)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toEqual({
      file: "kubectl",
      args: ["config", "current-context"],
    })
  })

  test("fails before cluster access when a required executable is absent", async () => {
    const execute = vi.fn<Runner>()

    await expect(
      preflightCluster(
        { context: "kind-dawn", targetMinor: "1.35", runId: "run-a" },
        {
          execute,
          executableExists: async (name) => name !== "helm",
        },
      ),
    ).rejects.toThrow(/missing required executable.*helm/i)
    expect(execute).not.toHaveBeenCalled()
  })

  test("rejects a server minor that differs from the selected target", async () => {
    const execute = fakeRunner([
      "kind-dawn\n",
      { serverVersion: { major: "1", minor: "34", gitVersion: "v1.34.9" } },
    ])

    await expect(
      preflightCluster(
        { context: "kind-dawn", targetMinor: "1.35", runId: "run-a" },
        { execute, executableExists: async () => true },
      ),
    ).rejects.toThrow(/server.*1\.34.*target.*1\.35/i)
    expect(execute.mock.calls[1]?.[0].args.slice(0, 2)).toEqual(["--context", "kind-dawn"])
  })

  test("returns immutable preflight data after context, server, storage, namespace, and access checks", async () => {
    const execute = fakeRunner([
      "kind-dawn\n",
      { serverVersion: { major: "1", minor: "35+", gitVersion: "v1.35.6" } },
      {
        items: [
          {
            metadata: {
              name: "standard",
              annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
            },
          },
        ],
      },
      { items: [] },
      {
        clusters: [
          {
            cluster: {
              server: "https://127.0.0.1:6443",
              "certificate-authority-data": "Y2E=",
            },
          },
        ],
      },
    ])

    const preflight = await preflightCluster(
      { context: "kind-dawn", targetMinor: "1.35", runId: "Run A" },
      { execute, executableExists: async () => true },
    )

    expect(preflight).toMatchObject({
      context: "kind-dawn",
      observedServer: "v1.35.6",
      storageClass: "standard",
      access: { server: "https://127.0.0.1:6443", certificateAuthorityData: "Y2E=" },
      names: deriveClusterNames("Run A"),
    })
    expect(Object.isFrozen(preflight)).toBe(true)
    expect(execute.mock.calls.slice(1).every(([command]) => command.args[0] === "--context")).toBe(
      true,
    )
  })
})

describe("storage, names, and namespace safety", () => {
  test("selects an exact override or one unambiguous annotated default", () => {
    const storageClasses = {
      items: [
        { metadata: { name: "fast" } },
        {
          metadata: {
            name: "standard",
            annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
          },
        },
      ],
    }
    expect(selectStorageClass(storageClasses, "fast")).toBe("fast")
    expect(selectStorageClass(storageClasses)).toBe("standard")
    expect(() => selectStorageClass(storageClasses, "missing")).toThrow(/missing/i)
    expect(() => selectStorageClass({ items: [{ metadata: { name: "fast" } }] })).toThrow(
      /default/i,
    )
  })

  test("derives deterministic DNS-safe bounded names without accepting caller names", () => {
    const names = deriveClusterNames("Feature/UPPER weird_value with a very long suffix 1234567890")
    expect(Object.keys(names).sort()).toEqual([
      "appRelease",
      "managementNamespace",
      "runName",
      "sandboxNamespace",
      "sandboxRelease",
    ])
    for (const name of Object.values(names)) {
      expect(name).toMatch(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/)
      expect(name.length).toBeLessThanOrEqual(63)
    }
    expect(deriveClusterNames("same input")).toEqual(deriveClusterNames("same input"))
    expect(deriveClusterNames("same-input")).not.toEqual(deriveClusterNames("same input"))
  })

  test("retains collision resistance when long normalized prefixes are identical", () => {
    const prefix = "very-long-compatibility-run-name-".repeat(4)

    const first = deriveClusterNames(`${prefix}first`)
    const second = deriveClusterNames(`${prefix}second`)

    expect(first.runName).not.toBe(second.runName)
    expect(first.managementNamespace).not.toBe(second.managementNamespace)
    expect(first.sandboxNamespace).not.toBe(second.sandboxNamespace)
    expect(first.sandboxRelease).not.toBe(second.sandboxRelease)
    expect(first.appRelease).not.toBe(second.appRelease)
  })

  test("rejects when either generated namespace already exists", () => {
    const names = deriveClusterNames("run-a")
    expect(() =>
      assertNamespacesAbsent({ items: [{ metadata: { name: names.managementNamespace } }] }, names),
    ).toThrow(names.managementNamespace)
    expect(() =>
      assertNamespacesAbsent({ items: [{ metadata: { name: names.sandboxNamespace } }] }, names),
    ).toThrow(names.sandboxNamespace)
  })
})

describe("administrative access and token kubeconfig", () => {
  test("captures exactly one server and CA pair from the minified context", () => {
    expect(
      captureAdministrativeAccess({
        clusters: [
          {
            cluster: {
              server: "https://cluster.example",
              "certificate-authority-data": "Y2VydA==",
            },
          },
        ],
      }),
    ).toEqual({
      server: "https://cluster.example",
      certificateAuthorityData: "Y2VydA==",
    })
    expect(() => captureAdministrativeAccess({ clusters: [] })).toThrow(/one cluster/i)
  })

  test("requests a 15-minute default-audience token with sensitive output", async () => {
    const execute = vi.fn(
      async (command: Command, _options?: CommandExecutionOptions): Promise<CommandResult> =>
        result(command, { status: { token: "secret-token" } }),
    )

    const token = await requestServiceAccountToken(
      {
        context: "kind-dawn",
        namespace: "dawn-sandbox",
        serviceAccount: "dawn-orchestrator",
      },
      execute,
    )

    expect(token).toBe("secret-token")
    expect(execute).toHaveBeenCalledWith(
      {
        file: "kubectl",
        args: [
          "--context",
          "kind-dawn",
          "create",
          "--raw",
          "/api/v1/namespaces/dawn-sandbox/serviceaccounts/dawn-orchestrator/token",
          "-f",
          "-",
        ],
      },
      expect.objectContaining({ sensitiveOutput: true }),
    )
    const body = JSON.parse(String(execute.mock.calls[0]?.[1]?.stdin))
    expect(body).toEqual({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenRequest",
      spec: { expirationSeconds: 900 },
    })
    expect(body.spec).not.toHaveProperty("audiences")
  })

  test("writes a private one-cluster, one-user, one-context token kubeconfig and always removes it", async () => {
    const material = await createSecureTokenKubeconfig({
      context: "kind-dawn",
      access: {
        server: "https://cluster.example",
        certificateAuthorityData: "Y2VydA==",
      },
      token: "secret-token",
    })
    temporaryDirectories.push(material.directory)

    expect((await stat(material.directory)).mode & 0o777).toBe(0o700)
    expect((await stat(material.path)).mode & 0o777).toBe(0o600)
    const kubeconfig = parse(await readFile(material.path, "utf8"))
    expect(kubeconfig.clusters).toHaveLength(1)
    expect(kubeconfig.users).toHaveLength(1)
    expect(kubeconfig.contexts).toHaveLength(1)
    expect(kubeconfig["current-context"]).toBe("kind-dawn")

    await material.destroy()
    await expect(stat(material.directory)).rejects.toMatchObject({ code: "ENOENT" })
    temporaryDirectories.pop()
  })

  test.each(["directory chmod", "write", "file chmod"] as const)(
    "removes the temporary directory when %s setup fails",
    async (failurePoint) => {
      const setupError = new Error(`${failurePoint} failed`)
      const chmod = vi.fn(async (path: string) => {
        if (
          failurePoint === "directory chmod" ||
          (failurePoint === "file chmod" && path.endsWith("kubeconfig.yaml"))
        ) {
          throw setupError
        }
      })
      const writeFile = vi.fn(async () => {
        if (failurePoint === "write") throw setupError
      })
      const rm = vi.fn(async () => {})
      const dependencies: SecureTokenKubeconfigDependencies = {
        mkdtemp: async () => "/secure/token-directory",
        chmod,
        writeFile,
        rm,
      }

      await expect(
        createSecureTokenKubeconfig(
          {
            context: "kind-dawn",
            access: {
              server: "https://cluster.example",
              certificateAuthorityData: "Y2VydA==",
            },
            token: "secret-token",
          },
          dependencies,
        ),
      ).rejects.toBe(setupError)
      expect(rm).toHaveBeenCalledWith("/secure/token-directory", {
        recursive: true,
        force: true,
      })
    },
  )

  test("preserves setup and cleanup failures when guarded setup cannot remove the directory", async () => {
    const setupError = new Error("directory chmod failed")
    const cleanupError = new Error("temporary directory removal failed")
    const rm = vi.fn(async () => Promise.reject(cleanupError))

    const error = await createSecureTokenKubeconfig(
      {
        context: "kind-dawn",
        access: {
          server: "https://cluster.example",
          certificateAuthorityData: "Y2VydA==",
        },
        token: "secret-token",
      },
      {
        mkdtemp: async () => "/secure/token-directory",
        chmod: async () => Promise.reject(setupError),
        writeFile: async () => {},
        rm,
      },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([setupError, cleanupError])
    expect(rm).toHaveBeenCalledTimes(1)
  })

  test("shares concurrent destroy work and remains idempotent after successful removal", async () => {
    let finishRemoval: (() => void) | undefined
    const rm = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finishRemoval = resolve
        }),
    )
    const material = await createSecureTokenKubeconfig(
      {
        context: "kind-dawn",
        access: {
          server: "https://cluster.example",
          certificateAuthorityData: "Y2VydA==",
        },
        token: "secret-token",
      },
      {
        mkdtemp: async () => "/secure/token-directory",
        chmod: async () => {},
        writeFile: async () => {},
        rm,
      },
    )

    const first = material.destroy()
    const second = material.destroy()
    expect(rm).toHaveBeenCalledTimes(1)
    finishRemoval?.()
    await Promise.all([first, second])
    await material.destroy()
    expect(rm).toHaveBeenCalledTimes(1)
  })

  test("retries destroy after a failed removal", async () => {
    const removalError = new Error("temporary directory removal failed")
    const rm = vi
      .fn<SecureTokenKubeconfigDependencies["rm"]>()
      .mockRejectedValueOnce(removalError)
      .mockResolvedValueOnce(undefined)
    const material = await createSecureTokenKubeconfig(
      {
        context: "kind-dawn",
        access: {
          server: "https://cluster.example",
          certificateAuthorityData: "Y2VydA==",
        },
        token: "secret-token",
      },
      {
        mkdtemp: async () => "/secure/token-directory",
        chmod: async () => {},
        writeFile: async () => {},
        rm,
      },
    )

    await expect(material.destroy()).rejects.toBe(removalError)
    await expect(material.destroy()).resolves.toBeUndefined()
    expect(rm).toHaveBeenCalledTimes(2)
  })
})

describe("namespace ownership and cleanup", () => {
  const runId = "run-a"
  const names = deriveClusterNames(runId)
  const management: NamespaceOwnership = {
    name: names.managementNamespace,
    uid: "uid-management",
    runId,
  }
  const sandbox: NamespaceOwnership = {
    name: names.sandboxNamespace,
    uid: "uid-sandbox",
    runId,
  }

  function namespace(ownership: NamespaceOwnership, label = ownership.runId, uid = ownership.uid) {
    return {
      metadata: { name: ownership.name, uid, labels: { "dawn.sh/compat-run": label } },
    }
  }

  test("captures and verifies exact UID plus run label", () => {
    expect(captureNamespaceOwnership(namespace(management), runId)).toEqual(management)
    expect(() =>
      verifyNamespaceOwnership(namespace(management, "run-a", "changed"), management),
    ).toThrow(/UID/i)
    expect(() => verifyNamespaceOwnership(namespace(management, "missing"), management)).toThrow(
      /label/i,
    )
  })

  test("exposes release roles rather than arbitrary release or namespace targets", () => {
    const input: OwnedClusterCleanupInput = {
      context: "kind-dawn",
      runId,
      ownership: [],
      installedReleases: ["infrastructure", "application"],
      removeTokenFiles: async () => {},
    }

    expect(input.installedReleases).toEqual(["infrastructure", "application"])
    expect(input).not.toHaveProperty("releases")
    // @ts-expect-error Raw release targets are intentionally absent from the cleanup API.
    const arbitrary: OwnedClusterCleanupInput = { ...input, releases: [] }
    void arbitrary
  })

  test.each([
    {
      name: "arbitrary namespace",
      ownership: [{ name: "kube-system", uid: "victim", runId }],
      installedReleases: [],
      message: /derived namespace/i,
    },
    {
      name: "duplicate ownership",
      ownership: [management, management],
      installedReleases: [],
      message: /duplicate.*ownership/i,
    },
    {
      name: "mismatched ownership run",
      ownership: [{ ...management, runId: "other-run" }],
      installedReleases: [],
      message: /run ID/i,
    },
    {
      name: "duplicate release role",
      ownership: [management, sandbox],
      installedReleases: ["infrastructure", "infrastructure"],
      message: /duplicate.*release role/i,
    },
  ] as const satisfies readonly {
    readonly name: string
    readonly ownership: readonly NamespaceOwnership[]
    readonly installedReleases: readonly InstalledReleaseRole[]
    readonly message: RegExp
  }[])("rejects $name before a cluster command", async (testCase) => {
    const execute = vi.fn<Runner>()
    const removeTokenFiles = vi.fn(async () => {})

    await expect(
      cleanupOwnedCluster(
        {
          context: "kind-dawn",
          runId,
          ownership: testCase.ownership,
          installedReleases: testCase.installedReleases,
          removeTokenFiles,
        },
        execute,
      ),
    ).rejects.toThrow(testCase.message)
    expect(removeTokenFiles).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  test("rejects an unknown release role before a cluster command", async () => {
    const execute = vi.fn<Runner>()
    const removeTokenFiles = vi.fn(async () => {})

    await expect(
      cleanupOwnedCluster(
        {
          context: "kind-dawn",
          runId,
          ownership: [management, sandbox],
          installedReleases: ["database"] as never,
          removeTokenFiles,
        },
        execute,
      ),
    ).rejects.toThrow(/unknown.*release role/i)
    expect(removeTokenFiles).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  test("requires captured ownership for both derived namespaces before release cleanup", async () => {
    const execute = vi.fn<Runner>()
    const removeTokenFiles = vi.fn(async () => {})

    await expect(
      cleanupOwnedCluster(
        {
          context: "kind-dawn",
          runId,
          ownership: [management],
          installedReleases: ["infrastructure"],
          removeTokenFiles,
        },
        execute,
      ),
    ).rejects.toThrow(/both derived namespaces/i)
    expect(removeTokenFiles).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  test("verifies every namespace before uninstall or deletion", async () => {
    const execute = fakeRunner([namespace(management), namespace(sandbox, "wrong")])
    const removeTokenFiles = vi.fn(async () => {})

    await expect(
      cleanupOwnedCluster(
        {
          context: "kind-dawn",
          runId,
          ownership: [management, sandbox],
          installedReleases: ["application", "infrastructure"],
          removeTokenFiles,
        },
        execute,
      ),
    ).rejects.toThrow(/label/i)
    expect(removeTokenFiles).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls.every(([command]) => command.args.includes("get"))).toBe(true)
  })

  test("keep-on-failure verifies ownership, retains cluster resources, and removes token files", async () => {
    const execute = fakeRunner([namespace(management), namespace(sandbox)])
    const removeTokenFiles = vi.fn(async () => {})

    const outcome = await cleanupOwnedCluster(
      {
        context: "kind-dawn",
        runId,
        ownership: [management, sandbox],
        installedReleases: ["infrastructure"],
        removeTokenFiles,
        keepOnFailure: true,
      },
      execute,
    )

    expect(outcome).toEqual({ retained: true })
    expect(removeTokenFiles).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  test("maps roles to exact derived Helm targets before deleting verified namespaces", async () => {
    const execute = fakeRunner([
      namespace(management),
      namespace(sandbox),
      {},
      {},
      namespace(management),
      namespace(sandbox),
      {},
      {},
    ])

    await cleanupOwnedCluster(
      {
        context: "kind-dawn",
        runId,
        ownership: [management, sandbox],
        installedReleases: ["application", "infrastructure"],
        removeTokenFiles: async () => {},
      },
      execute,
    )

    expect(execute.mock.calls.slice(2).map(([command]) => command)).toEqual([
      {
        file: "helm",
        args: [
          "--kube-context",
          "kind-dawn",
          "uninstall",
          names.sandboxRelease,
          "--namespace",
          names.managementNamespace,
        ],
      },
      {
        file: "helm",
        args: [
          "--kube-context",
          "kind-dawn",
          "uninstall",
          names.appRelease,
          "--namespace",
          names.managementNamespace,
        ],
      },
      {
        file: "kubectl",
        args: [
          "--context",
          "kind-dawn",
          "get",
          "namespace",
          management.name,
          "-o",
          "json",
          "--ignore-not-found",
        ],
      },
      {
        file: "kubectl",
        args: [
          "--context",
          "kind-dawn",
          "get",
          "namespace",
          sandbox.name,
          "-o",
          "json",
          "--ignore-not-found",
        ],
      },
      {
        file: "kubectl",
        args: ["--context", "kind-dawn", "delete", "namespace", management.name],
      },
      {
        file: "kubectl",
        args: ["--context", "kind-dawn", "delete", "namespace", sandbox.name],
      },
    ])
  })

  test("skips deletion when infrastructure uninstall removes its owned sandbox namespace", async () => {
    const execute = fakeRunner([
      namespace(management),
      namespace(sandbox),
      {},
      namespace(management),
      "",
      {},
    ])
    const removeTokenFiles = vi.fn(async () => {})

    await cleanupOwnedCluster(
      {
        context: "kind-dawn",
        runId,
        ownership: [management, sandbox],
        installedReleases: ["infrastructure"],
        removeTokenFiles,
      },
      execute,
    )

    expect(removeTokenFiles).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      {
        file: "kubectl",
        args: ["--context", "kind-dawn", "get", "namespace", management.name, "-o", "json"],
      },
      {
        file: "kubectl",
        args: ["--context", "kind-dawn", "get", "namespace", sandbox.name, "-o", "json"],
      },
      {
        file: "helm",
        args: [
          "--kube-context",
          "kind-dawn",
          "uninstall",
          names.sandboxRelease,
          "--namespace",
          names.managementNamespace,
        ],
      },
      {
        file: "kubectl",
        args: [
          "--context",
          "kind-dawn",
          "get",
          "namespace",
          management.name,
          "-o",
          "json",
          "--ignore-not-found",
        ],
      },
      {
        file: "kubectl",
        args: [
          "--context",
          "kind-dawn",
          "get",
          "namespace",
          sandbox.name,
          "-o",
          "json",
          "--ignore-not-found",
        ],
      },
      {
        file: "kubectl",
        args: ["--context", "kind-dawn", "delete", "namespace", management.name],
      },
    ])
  })

  test("refuses a namespace whose ownership changes between uninstall and final deletion", async () => {
    const execute = fakeRunner([
      namespace(management),
      namespace(sandbox),
      {},
      namespace(management, "other-run", "recreated-management"),
      namespace(sandbox),
    ])

    await expect(
      cleanupOwnedCluster(
        {
          context: "kind-dawn",
          runId,
          ownership: [management, sandbox],
          installedReleases: ["infrastructure"],
          removeTokenFiles: async () => {},
        },
        execute,
      ),
    ).rejects.toThrow(/UID|label/i)
    expect(execute.mock.calls.filter(([command]) => command.args.includes("delete"))).toHaveLength(
      0,
    )
  })

  test("verifies and deletes management-only ownership before any release exists", async () => {
    const execute = fakeRunner([namespace(management), namespace(management), {}])

    await cleanupOwnedCluster(
      {
        context: "kind-dawn",
        runId,
        ownership: [management],
        installedReleases: [],
        removeTokenFiles: async () => {},
      },
      execute,
    )

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      {
        file: "kubectl",
        args: ["--context", "kind-dawn", "get", "namespace", management.name, "-o", "json"],
      },
      {
        file: "kubectl",
        args: [
          "--context",
          "kind-dawn",
          "get",
          "namespace",
          management.name,
          "-o",
          "json",
          "--ignore-not-found",
        ],
      },
      {
        file: "kubectl",
        args: ["--context", "kind-dawn", "delete", "namespace", management.name],
      },
    ])
  })

  test("zero ownership removes token material without cluster commands", async () => {
    const execute = vi.fn<Runner>()
    const removeTokenFiles = vi.fn(async () => {})

    await expect(
      cleanupOwnedCluster(
        {
          context: "kind-dawn",
          runId,
          ownership: [],
          installedReleases: [],
          removeTokenFiles,
        },
        execute,
      ),
    ).resolves.toEqual({ retained: false })
    expect(removeTokenFiles).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "%s removes listeners, completes cleanup, and terminates with the same signal",
    async (signal) => {
      const processEvents = new EventEmitter()
      const terminate = vi.fn()
      const cleanup = vi.fn(async () => {
        for (const registeredSignal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
          expect(processEvents.listenerCount(registeredSignal)).toBe(0)
        }
      })
      const registration = registerOwnedResourceSignalCleanup([management], cleanup, {
        emitter: processEvents,
        terminate,
        timeoutMs: 100,
      })

      processEvents.emit(signal)
      await expect(registration.completion).resolves.toEqual({ signal, status: "passed" })
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(terminate).toHaveBeenCalledExactlyOnceWith(signal)
    },
  )

  test("removes listeners synchronously and ignores a second signal", async () => {
    const processEvents = new EventEmitter()
    const terminate = vi.fn()
    let finishCleanup: (() => void) | undefined
    const cleanup = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        }),
    )
    const registration = registerOwnedResourceSignalCleanup([management], cleanup, {
      emitter: processEvents,
      terminate,
      timeoutMs: 100,
    })

    expect(processEvents.emit("SIGINT")).toBe(true)
    expect(processEvents.emit("SIGTERM")).toBe(false)
    expect(cleanup).toHaveBeenCalledTimes(1)
    finishCleanup?.()
    await expect(registration.completion).resolves.toEqual({
      signal: "SIGINT",
      status: "passed",
    })
    expect(terminate).toHaveBeenCalledExactlyOnceWith("SIGINT")
  })

  test("retains cleanup rejection in a failed completion and terminates once", async () => {
    const processEvents = new EventEmitter()
    const terminate = vi.fn()
    const cleanupError = new Error("cleanup failed")
    const registration = registerOwnedResourceSignalCleanup(
      [management],
      async () => Promise.reject(cleanupError),
      { emitter: processEvents, terminate, timeoutMs: 100 },
    )

    processEvents.emit("SIGHUP")

    await expect(registration.completion).resolves.toEqual({
      signal: "SIGHUP",
      status: "failed",
      error: cleanupError,
    })
    expect(terminate).toHaveBeenCalledExactlyOnceWith("SIGHUP")
  })

  test("handles cleanup rejection after timeout without an unhandled rejection", async () => {
    vi.useFakeTimers()
    const processEvents = new EventEmitter()
    const terminate = vi.fn()
    const cleanupError = new Error("cleanup rejected after timeout")
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    let rejectCleanup: ((reason: unknown) => void) | undefined
    const registration = registerOwnedResourceSignalCleanup(
      [management],
      async () =>
        new Promise<void>((_resolve, reject) => {
          rejectCleanup = reject
        }),
      { emitter: processEvents, terminate, timeoutMs: 25 },
    )

    process.on("unhandledRejection", onUnhandledRejection)
    try {
      processEvents.emit("SIGTERM")
      await vi.advanceTimersByTimeAsync(25)

      await expect(registration.completion).resolves.toEqual({
        signal: "SIGTERM",
        status: "timed-out",
      })
      expect(terminate).toHaveBeenCalledExactlyOnceWith("SIGTERM")

      rejectCleanup?.(cleanupError)
      const nextTurn = new Promise<void>((resolve) => setImmediate(resolve))
      await vi.runAllTimersAsync()
      await nextTurn
      await Promise.resolve()

      expect(unhandledRejections).toEqual([])
      expect(terminate).toHaveBeenCalledTimes(1)
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
    }
  })

  test("dispose removes listeners and prevents cleanup or termination", async () => {
    const processEvents = new EventEmitter()
    const cleanup = vi.fn(async () => {})
    const terminate = vi.fn()
    const registration = registerOwnedResourceSignalCleanup([management], cleanup, {
      emitter: processEvents,
      terminate,
      timeoutMs: 100,
    })

    registration.dispose()
    registration.dispose()

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      expect(processEvents.listenerCount(signal)).toBe(0)
      expect(processEvents.emit(signal)).toBe(false)
    }
    expect(cleanup).not.toHaveBeenCalled()
    expect(terminate).not.toHaveBeenCalled()
    const state = await Promise.race([
      registration.completion.then(() => "settled"),
      Promise.resolve("pending"),
    ])
    expect(state).toBe("pending")
  })

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid signal cleanup timeout %s before registration",
    (timeoutMs) => {
      const processEvents = new EventEmitter()

      expect(() =>
        registerOwnedResourceSignalCleanup([management], async () => {}, {
          emitter: processEvents,
          terminate: vi.fn(),
          timeoutMs,
        }),
      ).toThrow(/timeout.*positive/i)
      expect(processEvents.eventNames()).toEqual([])
    },
  )
})
