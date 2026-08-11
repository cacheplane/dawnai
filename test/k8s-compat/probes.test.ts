import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, test, vi } from "vitest"
import { deriveClusterNames } from "../../scripts/kubernetes-compat/cluster.ts"
import type {
  Command,
  CommandExecutionOptions,
  CommandResult,
} from "../../scripts/kubernetes-compat/command.ts"
import { loadCompatibilityPolicy } from "../../scripts/kubernetes-compat/policy.ts"
import {
  ADMISSION_RBAC_NETWORK_PROBE_IDS,
  assertPodSecurityRejection,
  assertQuotaRejection,
  assertRbacRejection,
  type ProbeCommandRunner,
  runLimitRangeProbe,
  runNetworkControlProbe,
  runOutsideNamespaceDeniedProbe,
  runResourceQuotaProbe,
  runRestrictedAdmissionProbe,
  runRoleMutationDeniedProbe,
  runSandboxSecretsEmptyProbe,
  runSecretReadDeniedProbe,
} from "../../scripts/kubernetes-compat/probes.ts"

type JsonObject = Record<string, unknown>

const context = "kind-dawn"
const kubeconfig = "/secure/token-kubeconfig"
const runId = "run-a"
const names = deriveClusterNames(runId)

function commandResult(command: Command, value: unknown, exitCode = 0): CommandResult {
  const output = typeof value === "string" ? value : JSON.stringify(value)
  return {
    command,
    stdout: Buffer.from(output),
    stderr: Buffer.alloc(0),
    exitCode,
    signal: null,
    toJSON: () => ({ command, outcome: { kind: "exit", exitCode } }),
  }
}

function commandResultWithStderr(
  command: Command,
  stderr: string,
  exitCode: number,
): CommandResult {
  return {
    command,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(stderr),
    exitCode,
    signal: null,
    toJSON: () => ({ command, outcome: { kind: "exit", exitCode } }),
  }
}

function fakeRunner(
  handler: (
    command: Command,
    options: CommandExecutionOptions,
    index: number,
  ) => unknown | Promise<unknown>,
): ReturnType<typeof vi.fn<ProbeCommandRunner>> {
  let index = 0
  return vi.fn(async (command, options = {}) => {
    const response = await handler(command, options, index)
    index += 1
    if (response instanceof Error) throw response
    if (
      typeof response === "object" &&
      response !== null &&
      "exitCode" in response &&
      typeof response.exitCode === "number" &&
      "body" in response
    ) {
      if ("stderr" in response && typeof response.stderr === "string") {
        return commandResultWithStderr(command, response.stderr, response.exitCode)
      }
      return commandResult(command, response.body, response.exitCode)
    }
    return commandResult(command, response)
  })
}

function stdinObject(options: CommandExecutionOptions): JsonObject {
  const stdin = options.stdin
  if (typeof stdin !== "string" && !(stdin instanceof Uint8Array)) {
    throw new Error("Expected JSON stdin")
  }
  const text = typeof stdin === "string" ? stdin : Buffer.from(stdin).toString()
  return JSON.parse(text) as JsonObject
}

function allManifests(execute: ReturnType<typeof vi.fn<ProbeCommandRunner>>): JsonObject[] {
  return execute.mock.calls.flatMap(([, options]) => {
    if (options?.stdin === undefined) return []
    const value = stdinObject(options)
    return value.kind === "Pod" || value.kind === "Service" ? [value] : []
  })
}

function metadata(value: JsonObject): JsonObject {
  return value.metadata as JsonObject
}

function podSpec(value: JsonObject): JsonObject {
  return value.spec as JsonObject
}

function podContainer(value: JsonObject): JsonObject {
  return (podSpec(value).containers as JsonObject[])[0] as JsonObject
}

function expectRestrictedPod(pod: JsonObject, image: string): void {
  expect(pod.kind).toBe("Pod")
  expect(metadata(pod).namespace).toBe(names.sandboxNamespace)
  expect(metadata(pod).labels).toMatchObject({ "dawn.sh/compat-run": runId })
  const spec = podSpec(pod)
  expect(spec.automountServiceAccountToken).toBe(false)
  expect(spec.securityContext).toMatchObject({
    runAsNonRoot: true,
    runAsUser: 65532,
    seccompProfile: { type: "RuntimeDefault" },
  })
  expect((spec.securityContext as JsonObject).runAsUser).not.toBe(0)
  expect(podContainer(pod)).toMatchObject({
    image,
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
  })
  expect(podContainer(pod).image as string).toMatch(/@sha256:[0-9a-f]{64}$/)
}

function successPod(pod: JsonObject): JsonObject {
  return {
    ...pod,
    status: { phase: "Succeeded" },
  }
}

function forbidden(message: string, details: JsonObject = {}): JsonObject {
  return {
    apiVersion: "v1",
    kind: "Status",
    status: "Failure",
    message,
    reason: "Forbidden",
    details,
    code: 403,
  }
}

describe("probe manifest", () => {
  test("lists the exact stable probe IDs in plan order", () => {
    expect(ADMISSION_RBAC_NETWORK_PROBE_IDS).toEqual([
      "namespace.sandbox-secrets-empty",
      "network.control-ready",
      "admission.resource-quota",
      "admission.limit-range",
      "admission.restricted.before-upgrade",
      "rbac.secret-read-denied",
      "rbac.role-mutation-denied",
      "rbac.outside-namespace-denied",
    ])
  })

  test("matches the checked-in expected probe manifest exactly", async () => {
    const manifest = JSON.parse(
      await readFile(resolve("test/k8s-compat/expected-tests.json"), "utf8"),
    ) as { probeIds: unknown }

    expect(manifest.probeIds).toEqual(ADMISSION_RBAC_NETWORK_PROBE_IDS)
  })
})

describe("positive and negative pod fixtures", () => {
  test("all positive probes submit digest-pinned restricted Pods and run-labeled objects", async () => {
    const policy = await loadCompatibilityPolicy()
    let clientPod: JsonObject | undefined
    const execute = fakeRunner((command, options) => {
      const manifest = options.stdin === undefined ? undefined : stdinObject(options)
      if (manifest?.kind === "Pod") {
        clientPod = manifest
        return manifest
      }
      if (command.args.includes("get") && command.args.some((arg) => arg.startsWith("pod/"))) {
        return successPod(clientPod as JsonObject)
      }
      if (command.args.includes("logs")) return "DAWN_NETWORK_CONTROL=reachable\n"
      return {}
    })

    await runNetworkControlProbe({ context, runId, policy, execute })

    const manifests = allManifests(execute)
    const pods = manifests.filter((item) => item.kind === "Pod")
    expect(pods).toHaveLength(2)
    for (const pod of pods) expectRestrictedPod(pod, policy.images.sandboxWorkload)
    for (const manifest of manifests) {
      expect(metadata(manifest).labels).toMatchObject({ "dawn.sh/compat-run": runId })
    }
    const service = manifests.find((item) => item.kind === "Service")
    if (service === undefined) throw new Error("Expected network control Service manifest")
    expect(metadata(service).labels).not.toHaveProperty("app.kubernetes.io/managed-by", "dawn")
    expect((service.spec as JsonObject).selector).not.toHaveProperty(
      "app.kubernetes.io/managed-by",
      "dawn",
    )
    expect(execute.mock.calls.at(-1)?.[0].args).toEqual(
      expect.arrayContaining([
        "delete",
        "pod,service",
        "--selector",
        `dawn.sh/compat-run=${runId}`,
      ]),
    )
  })

  test("quota negative differs from its positive fixture only by requests and limits cpu", async () => {
    const policy = await loadCompatibilityPolicy()
    const submitted: JsonObject[] = []
    const execute = fakeRunner((_command, options, index) => {
      if (options.stdin !== undefined) submitted.push(stdinObject(options))
      if (index === 1) {
        return {
          exitCode: 1,
          body: forbidden(
            'pods "quota-negative" is forbidden: exceeded quota: dawn-sandbox-quota, requested: requests.cpu=9',
            {
              kind: "pods",
              causes: [
                {
                  reason: "FieldValueForbidden",
                  message: "exceeded quota: dawn-sandbox-quota, requested: requests.cpu=9",
                },
              ],
            },
          ),
        }
      }
      return submitted.at(-1) ?? {}
    })

    await runResourceQuotaProbe({ context, kubeconfig, runId, policy, execute })

    const [positive, negative] = submitted
    expectRestrictedPod(positive as JsonObject, policy.images.admissionProbe)
    const expected = structuredClone(positive) as JsonObject
    const expectedContainer = podContainer(expected)
    expectedContainer.resources = {
      requests: { cpu: "9", memory: "32Mi" },
      limits: { cpu: "9", memory: "32Mi" },
    }
    expect(negative).toEqual(expected)
    const admissionCommands = execute.mock.calls.slice(0, 2)
    for (const [command] of admissionCommands) {
      expect(command.args).toEqual(
        expect.arrayContaining([
          "--kubeconfig",
          kubeconfig,
          "--context",
          context,
          "create",
          "--raw",
          `/api/v1/namespaces/${names.sandboxNamespace}/pods?dryRun=All`,
        ]),
      )
    }
    expect(admissionCommands[0]?.[0].args).not.toContain("--v=8")
    expect(admissionCommands[1]?.[0].args).toContain("--v=8")
    expect(admissionCommands[1]?.[1]?.sensitiveOutput).toBe(true)
  })

  test("restricted negative differs from its positive fixture only by runAsNonRoot false", async () => {
    const policy = await loadCompatibilityPolicy()
    const submitted: JsonObject[] = []
    const execute = fakeRunner((_command, options, index) => {
      if (options.stdin !== undefined) submitted.push(stdinObject(options))
      if (index === 1) {
        return {
          exitCode: 1,
          body: forbidden(
            'pods "restricted-negative" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true',
            { kind: "pods" },
          ),
        }
      }
      return submitted.at(-1) ?? {}
    })

    await runRestrictedAdmissionProbe({ context, kubeconfig, runId, policy, execute })

    const [positive, negative] = submitted
    expectRestrictedPod(positive as JsonObject, policy.images.admissionProbe)
    const expected = structuredClone(positive) as JsonObject
    ;(podSpec(expected).securityContext as JsonObject).runAsNonRoot = false
    expect(negative).toEqual(expected)
  })

  test("LimitRange omits resources then requires exact admitted defaults", async () => {
    const policy = await loadCompatibilityPolicy()
    let submitted: JsonObject | undefined
    const execute = fakeRunner((_command, options, index) => {
      if (options.stdin !== undefined) submitted = stdinObject(options)
      if (index === 1) {
        const admitted = structuredClone(submitted) as JsonObject
        podContainer(admitted).resources = {
          limits: { cpu: "1", memory: "512Mi", "ephemeral-storage": "1Gi" },
          requests: { cpu: "100m", memory: "128Mi" },
        }
        return admitted
      }
      return submitted ?? {}
    })

    await runLimitRangeProbe({ context, kubeconfig, runId, policy, execute })

    expectRestrictedPod(submitted as JsonObject, policy.images.admissionProbe)
    expect(podContainer(submitted as JsonObject)).not.toHaveProperty("resources")
  })

  test("accepts LimitRange defaults independent of JSON object key order", async () => {
    const policy = await loadCompatibilityPolicy()
    let submitted: JsonObject | undefined
    const execute = fakeRunner((_command, options, index) => {
      if (options.stdin !== undefined) submitted = stdinObject(options)
      if (index === 1) {
        const admitted = structuredClone(submitted) as JsonObject
        podContainer(admitted).resources = {
          requests: { memory: "128Mi", "ephemeral-storage": "1Gi", cpu: "100m" },
          limits: { memory: "512Mi", "ephemeral-storage": "1Gi", cpu: "1" },
        }
        return admitted
      }
      return submitted ?? {}
    })

    await expect(
      runLimitRangeProbe({ context, kubeconfig, runId, policy, execute }),
    ).resolves.toBeUndefined()
  })
})

describe("structured rejection validation", () => {
  const quotaStatus = forbidden(
    'pods "probe" is forbidden: exceeded quota: dawn-sandbox-quota, requested: requests.cpu=9',
    {
      kind: "pods",
      causes: [
        {
          reason: "FieldValueForbidden",
          message: "exceeded quota: dawn-sandbox-quota, requested: requests.cpu=9",
        },
      ],
    },
  )
  const pssStatus = forbidden(
    'pods "probe" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true',
  )
  const rbacStatus = forbidden(
    'roles.rbac.authorization.k8s.io "probe" is forbidden: User "system:serviceaccount:ns:dawn-orchestrator" cannot create resource "roles" in API group "rbac.authorization.k8s.io" in the namespace "ns"',
  )

  test("accepts only quota-specific Forbidden Status objects", () => {
    expect(() => assertQuotaRejection(quotaStatus, "dawn-sandbox-quota")).not.toThrow()
    for (const invalid of [
      { ...quotaStatus, code: 404 },
      { ...quotaStatus, reason: "Unauthorized" },
      { ...quotaStatus, message: "exceeded quota: another-quota" },
      {
        ...quotaStatus,
        message: "exceeded quota: dawn-sandbox-quota-shadow, requested: requests.cpu=9",
      },
      { ...quotaStatus, details: { causes: [{ message: "generic admission denial" }] } },
      pssStatus,
      "not-json",
    ]) {
      expect(() => assertQuotaRejection(invalid, "dawn-sandbox-quota")).toThrow()
    }
  })

  test("accepts the standard quota Status shape without nonstandard cause entries", () => {
    expect(() =>
      assertQuotaRejection(
        forbidden(
          'pods "probe" is forbidden: exceeded quota: dawn-sandbox-quota, requested: requests.cpu=9',
          { name: "probe", kind: "pods" },
        ),
        "dawn-sandbox-quota",
      ),
    ).not.toThrow()
    expect(() =>
      assertQuotaRejection(
        forbidden(
          'pods "probe" is forbidden: exceeded quota: dawn-sandbox-quota, requested: requests.cpu=9',
          { name: "probe", kind: "deployments" },
        ),
        "dawn-sandbox-quota",
      ),
    ).toThrow(/quota-specific/i)
  })

  test("accepts only restricted runAsNonRoot Forbidden Status objects", () => {
    expect(() => assertPodSecurityRejection(pssStatus)).not.toThrow()
    for (const invalid of [
      { ...pssStatus, code: 404 },
      { ...pssStatus, reason: "Unauthorized" },
      { ...pssStatus, message: "restricted policy denied hostNetwork" },
      quotaStatus,
      "{malformed",
    ]) {
      expect(() => assertPodSecurityRejection(invalid)).toThrow()
    }
  })

  test("accepts only authorization-attributable Forbidden Status objects", () => {
    expect(() =>
      assertRbacRejection(rbacStatus, {
        verb: "create",
        resource: "roles",
        apiGroup: "rbac.authorization.k8s.io",
        namespace: "ns",
      }),
    ).not.toThrow()
    for (const invalid of [
      { ...rbacStatus, code: 404 },
      { ...rbacStatus, reason: "Unauthorized" },
      pssStatus,
      quotaStatus,
      "malformed",
    ]) {
      expect(() =>
        assertRbacRejection(invalid, {
          verb: "create",
          resource: "roles",
          apiGroup: "rbac.authorization.k8s.io",
          namespace: "ns",
        }),
      ).toThrow()
    }
  })
})

describe("probe command routing, evidence, and cleanup", () => {
  test("checks exact empty Secrets through admin context before token issuance", async () => {
    const execute = fakeRunner(() => ({ items: [] }))

    await runSandboxSecretsEmptyProbe({ context, runId, execute })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toEqual({
      file: "kubectl",
      args: [
        "--context",
        context,
        "get",
        "secrets",
        "--namespace",
        names.sandboxNamespace,
        "--output",
        "json",
      ],
    })

    await expect(
      runSandboxSecretsEmptyProbe({
        context,
        runId,
        execute: fakeRunner(() => ({ items: [{ metadata: { name: "unexpected" } }] })),
      }),
    ).rejects.toThrow(/zero Secret/i)
  })

  test("all RBAC operations are concrete raw API requests through token-only kubeconfig", async () => {
    const execute = fakeRunner((command) => {
      if (command.args.includes("delete")) return {}
      const pathIndex = command.args.indexOf("--raw") + 1
      const path = command.args[pathIndex] ?? ""
      const message = path.endsWith("/secrets")
        ? `secrets is forbidden: User cannot get resource "secrets" in API group "" in the namespace "${names.sandboxNamespace}"`
        : path.endsWith("/roles")
          ? `roles.rbac.authorization.k8s.io is forbidden: User cannot create resource "roles" in API group "rbac.authorization.k8s.io" in the namespace "${names.sandboxNamespace}"`
          : `configmaps is forbidden: User cannot create resource "configmaps" in API group "" in the namespace "${names.managementNamespace}"`
      return { exitCode: 1, body: forbidden(message) }
    })

    await runSecretReadDeniedProbe({ context, kubeconfig, runId, execute })
    await runRoleMutationDeniedProbe({ context, kubeconfig, runId, execute })
    await runOutsideNamespaceDeniedProbe({ context, kubeconfig, runId, execute })

    const requests = execute.mock.calls.filter(([command]) => command.args.includes("--raw"))
    expect(requests).toHaveLength(3)
    for (const [command, options] of requests) {
      expect(command.args.slice(0, 4)).toEqual(["--kubeconfig", kubeconfig, "--context", context])
      expect(command.args).toContain("--raw")
      expect(options?.acceptedExitCodes).toEqual([1])
    }
    expect(requests[1]?.[1]?.stdin).toEqual(expect.any(String))
    expect(requests[2]?.[1]?.stdin).toEqual(expect.any(String))
    const role = stdinObject(requests[1]?.[1] ?? {})
    const outside = stdinObject(requests[2]?.[1] ?? {})
    expect(metadata(role)).toMatchObject({
      namespace: names.sandboxNamespace,
      labels: { "dawn.sh/compat-run": runId },
    })
    expect(metadata(outside)).toMatchObject({
      namespace: names.managementNamespace,
      labels: { "dawn.sh/compat-run": runId },
    })
  })

  test("classifies command failures separately from structured Kubernetes rejection evidence", async () => {
    const transport = new Error("connection refused")

    await expect(
      runSecretReadDeniedProbe({
        context,
        kubeconfig,
        runId,
        execute: fakeRunner(() => transport),
      }),
    ).rejects.toThrow(/connection refused/)

    await expect(
      runSecretReadDeniedProbe({
        context,
        kubeconfig,
        runId,
        execute: fakeRunner(() => ({ exitCode: 1, body: "not-json" })),
      }),
    ).rejects.toThrow(/valid Kubernetes Status JSON/i)
  })

  test("extracts the structured Status response body from bounded kubectl diagnostics", async () => {
    const status = forbidden(
      `secrets is forbidden: User cannot get resource "secrets" in API group "" in the namespace "${names.sandboxNamespace}"`,
      { kind: "secrets" },
    )
    const stderr = [
      'I0810 request.go: Response Body: {"kind":"APIResourceList"}',
      `I0810 request.go: Response Body: ${JSON.stringify(status)}`,
      `Error from server (Forbidden): ${String(status.message)}`,
      "",
    ].join("\n")
    const execute = fakeRunner(() => ({ exitCode: 1, body: "", stderr }))

    await runSecretReadDeniedProbe({ context, kubeconfig, runId, execute })

    const [command, options] = execute.mock.calls[0] ?? []
    expect(command?.args).toContain("--v=8")
    expect(options?.sensitiveOutput).toBe(true)
  })

  test("cleans a run-labeled RBAC object if mutation unexpectedly succeeds", async () => {
    const execute = fakeRunner((command) => {
      if (command.args.includes("--raw")) return { exitCode: 0, body: {} }
      return {}
    })

    await expect(
      runRoleMutationDeniedProbe({ context, kubeconfig, runId, execute }),
    ).rejects.toThrow(/expected kubectl rejection code/i)

    expect(execute.mock.calls.at(-1)?.[0].args).toEqual(
      expect.arrayContaining([
        "delete",
        "role",
        "--namespace",
        names.sandboxNamespace,
        "--selector",
        `dawn.sh/compat-run=${runId}`,
      ]),
    )
  })

  test("cleans partial objects by exact run label and preserves primary plus cleanup failures", async () => {
    const policy = await loadCompatibilityPolicy()
    const primary = new Error("create failed")
    const cleanup = new Error("cleanup failed")
    const execute = fakeRunner((command, _options, index) => {
      if (command.args.includes("delete")) return cleanup
      if (index === 1) return primary
      return {}
    })

    const error = await runNetworkControlProbe({ context, runId, policy, execute }).catch(
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([primary, cleanup])
    const cleanupCommand = execute.mock.calls.at(-1)?.[0]
    expect(cleanupCommand?.args).toEqual(
      expect.arrayContaining([
        "--context",
        context,
        "delete",
        "pod,service",
        "--namespace",
        names.sandboxNamespace,
        "--selector",
        `dawn.sh/compat-run=${runId}`,
      ]),
    )
  })
})
