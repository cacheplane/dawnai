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
  type NamespaceOwnership,
  preflightCluster,
  registerOwnedResourceSignalCleanup,
  requestServiceAccountToken,
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
})

describe("namespace ownership and cleanup", () => {
  const management: NamespaceOwnership = {
    name: "dawn-management-a",
    uid: "uid-management",
    runId: "run-a",
  }
  const sandbox: NamespaceOwnership = {
    name: "dawn-sandbox-a",
    uid: "uid-sandbox",
    runId: "run-a",
  }

  function namespace(ownership: NamespaceOwnership, label = ownership.runId, uid = ownership.uid) {
    return {
      metadata: { name: ownership.name, uid, labels: { "dawn.sh/compat-run": label } },
    }
  }

  test("captures and verifies exact UID plus run label", () => {
    expect(captureNamespaceOwnership(namespace(management), "run-a")).toEqual(management)
    expect(() =>
      verifyNamespaceOwnership(namespace(management, "run-a", "changed"), management),
    ).toThrow(/UID/i)
    expect(() => verifyNamespaceOwnership(namespace(management, "missing"), management)).toThrow(
      /label/i,
    )
  })

  test("verifies every namespace before uninstall or deletion", async () => {
    const execute = fakeRunner([namespace(management), namespace(sandbox, "wrong")])
    const removeTokenFiles = vi.fn(async () => {})

    await expect(
      cleanupOwnedCluster(
        {
          context: "kind-dawn",
          ownership: [management, sandbox],
          releases: [
            { name: "dawn-app-a", namespace: management.name },
            { name: "dawn-sandbox-a", namespace: management.name },
          ],
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
        ownership: [management, sandbox],
        releases: [{ name: "dawn-sandbox-a", namespace: management.name }],
        removeTokenFiles,
        keepOnFailure: true,
      },
      execute,
    )

    expect(outcome).toEqual({ retained: true })
    expect(removeTokenFiles).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  test("uninstalls exact releases before deleting surviving namespaces", async () => {
    const execute = fakeRunner([namespace(management), namespace(sandbox), {}, {}, {}, {}])

    await cleanupOwnedCluster(
      {
        context: "kind-dawn",
        ownership: [management, sandbox],
        releases: [
          { name: "dawn-app-a", namespace: management.name },
          { name: "dawn-sandbox-a", namespace: management.name },
        ],
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
          "dawn-app-a",
          "--namespace",
          management.name,
        ],
      },
      {
        file: "helm",
        args: [
          "--kube-context",
          "kind-dawn",
          "uninstall",
          "dawn-sandbox-a",
          "--namespace",
          management.name,
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

  test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "%s enters one cleanup path after an owned resource exists",
    async (signal) => {
      const processEvents = new EventEmitter()
      const cleanup = vi.fn(async () => {})
      const unregister = registerOwnedResourceSignalCleanup([management], cleanup, processEvents)

      processEvents.emit(signal)
      processEvents.emit(signal)
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
      unregister()
      expect(processEvents.listenerCount(signal)).toBe(0)
    },
  )
})
