import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { afterEach, describe, expect, test, vi } from "vitest"
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
  installApplicationChart,
  installInfrastructureChart,
  KUBERNETES_COMPAT_PROBE_IDS,
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
} from "../../scripts/kubernetes-compat/probes.ts"

type JsonObject = Record<string, unknown>

const context = "kind-dawn"
const kubeconfig = "/secure/token-kubeconfig"
const runId = "run-a"
const names = deriveClusterNames(runId)
const REAPER_TEST_EPOCH_SECONDS = 2_000_000_000
const REAPER_CRONJOB_UID = "11111111-1111-4111-8111-111111111111"

afterEach(() => {
  vi.restoreAllMocks()
})

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

function expectRestrictedPod(
  pod: JsonObject,
  image: string,
  namespace = names.sandboxNamespace,
): void {
  expect(pod.kind).toBe("Pod")
  expect(metadata(pod).namespace).toBe(namespace)
  expect(metadata(pod).labels).toMatchObject({ "dawn.sh/compat-run": runId })
  const spec = podSpec(pod)
  expect(spec.automountServiceAccountToken).toBe(false)
  expect(spec.securityContext).toMatchObject({
    runAsNonRoot: true,
    runAsUser: 65532,
    runAsGroup: 65532,
    fsGroup: 65532,
    fsGroupChangePolicy: "OnRootMismatch",
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
  const allowedVolumes = new Set([
    "configMap",
    "csi",
    "downwardAPI",
    "emptyDir",
    "ephemeral",
    "persistentVolumeClaim",
    "projected",
    "secret",
  ])
  for (const volume of (spec.volumes as JsonObject[] | undefined) ?? []) {
    const sources = Object.keys(volume).filter((key) => key !== "name")
    expect(sources).toHaveLength(1)
    expect(allowedVolumes.has(sources[0] as string)).toBe(true)
  }
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

function structuredResponseLog(value: unknown): string {
  return `I0810 21:35:57.561354   55712 round_trippers.go:577] "Response Body" body=${JSON.stringify(JSON.stringify(value))}\n`
}

function helmStatus(release: string, revision: number): JsonObject {
  return {
    name: release,
    namespace: names.managementNamespace,
    version: revision,
    info: { status: "deployed" },
  }
}

function reaperCronJob(
  schedule: string,
  options: {
    readonly suspend?: boolean
    readonly active?: readonly JsonObject[]
    readonly uid?: string | null
  } = {},
): JsonObject {
  const uid = options.uid === undefined ? REAPER_CRONJOB_UID : options.uid
  return {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: {
      name: "dawn-reaper",
      namespace: names.sandboxNamespace,
      ...(uid !== null ? { uid } : {}),
    },
    spec: {
      schedule,
      ...(options.suspend !== undefined ? { suspend: options.suspend } : {}),
      jobTemplate: {
        spec: {
          template: {
            metadata: { labels: { "app.kubernetes.io/name": "dawn-sandbox-infra" } },
            spec: {
              restartPolicy: "Never",
              containers: [
                {
                  name: "reaper",
                  image: `example.invalid/reaper@sha256:${"a".repeat(64)}`,
                },
              ],
            },
          },
        },
      },
    },
    ...(options.active !== undefined ? { status: { active: options.active } } : {}),
  }
}

function scheduledReaperJob(input: {
  readonly name: string
  readonly uid: string
  readonly status?: "unfinished" | "complete" | "failed"
  readonly ownerUid?: string | null
}): JsonObject {
  const ownerUid = input.ownerUid === undefined ? REAPER_CRONJOB_UID : input.ownerUid
  const conditions =
    input.status === "complete"
      ? [{ type: "Complete", status: "True" }]
      : input.status === "failed"
        ? [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }]
        : []
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: input.name,
      namespace: names.sandboxNamespace,
      uid: input.uid,
      ...(ownerUid !== null
        ? {
            ownerReferences: [
              {
                apiVersion: "batch/v1",
                kind: "CronJob",
                name: "dawn-reaper",
                uid: ownerUid,
                controller: true,
              },
            ],
          }
        : {}),
    },
    status: { conditions },
  }
}

function jobList(items: readonly JsonObject[]): JsonObject {
  return { apiVersion: "batch/v1", kind: "JobList", items }
}

function activeJobReference(job: JsonObject): JsonObject {
  const jobMetadata = metadata(job)
  return {
    apiVersion: job.apiVersion,
    kind: job.kind,
    name: jobMetadata.name,
    namespace: jobMetadata.namespace,
    uid: jobMetadata.uid,
  }
}

function deploymentList(
  replicas: number,
  availableReplicas: number,
  containers: readonly JsonObject[],
): JsonObject {
  return {
    apiVersion: "apps/v1",
    kind: "DeploymentList",
    items: [
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: `${names.appRelease}-dawn-app`,
          namespace: names.managementNamespace,
          labels: { "app.kubernetes.io/instance": names.appRelease },
        },
        spec: { replicas, template: { spec: { containers } } },
        status: { availableReplicas },
      },
    ],
  }
}

function serviceList(): JsonObject {
  return {
    apiVersion: "v1",
    kind: "ServiceList",
    items: [
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: {
          name: `${names.appRelease}-dawn-app`,
          namespace: names.managementNamespace,
          labels: { "app.kubernetes.io/instance": names.appRelease },
        },
        spec: { ports: [{ name: "http", port: 80, targetPort: "http" }] },
      },
    ],
  }
}

interface ReaperRunnerOptions {
  readonly retainStale?: boolean
  readonly markNew?: boolean
  readonly markReferenced?: boolean
  readonly deletingNew?: boolean
  readonly deletingReferenced?: boolean
  readonly newMarker?: string
  readonly initialSuspend?: boolean
  readonly activeReferences?: readonly JsonObject[]
  readonly cronJobUid?: string | null
  readonly suspendedCronJobUid?: string | null
  readonly jobSnapshots?: readonly (readonly JsonObject[])[]
  readonly delay?: (milliseconds: number) => Promise<void>
  readonly activeWaitError?: Error
  readonly cleanupError?: Error
  readonly restoreError?: Error
}

function createReaperRunner(options: ReaperRunnerOptions = {}): {
  readonly execute: ReturnType<typeof vi.fn<ProbeCommandRunner>>
  readonly submitted: JsonObject[]
  readonly delay: ReturnType<typeof vi.fn<(milliseconds: number) => Promise<void>>>
} {
  vi.spyOn(Date, "now").mockReturnValue(REAPER_TEST_EPOCH_SECONDS * 1_000)
  const submitted: JsonObject[] = []
  const completedScheduledJobUids = new Set<string>()
  let cleanupCalls = 0
  let patchCalls = 0
  let jobListCalls = 0
  let suspendPresent = options.initialSuspend !== undefined
  let suspend = options.initialSuspend
  const activeReferences = options.activeReferences ?? []
  const cronJobUid = options.cronJobUid === undefined ? REAPER_CRONJOB_UID : options.cronJobUid
  const scheduledJobForActiveReference = (reference: JsonObject, index: number): JsonObject => {
    const name =
      typeof reference.name === "string" && reference.name.length > 0
        ? reference.name
        : `invalid-active-name-${index}`
    const uid =
      typeof reference.uid === "string" && reference.uid.length > 0
        ? reference.uid
        : `invalid-active-uid-${index}`
    return scheduledReaperJob({
      name,
      uid,
      ...(completedScheduledJobUids.has(uid) ? { status: "complete" as const } : {}),
      ...(cronJobUid !== null ? { ownerUid: cronJobUid } : { ownerUid: null }),
    })
  }
  const defaultScheduledJobs = (): readonly JsonObject[] =>
    activeReferences.map(scheduledJobForActiveReference)
  const explicitScheduledJobs = (options.jobSnapshots ?? []).flat()
  const knownScheduledJob = (name: string): JsonObject | undefined =>
    [...explicitScheduledJobs, ...defaultScheduledJobs()].find((job) => metadata(job).name === name)
  const currentCronJob = (): JsonObject =>
    reaperCronJob("17 * * * *", {
      ...(suspendPresent ? { suspend: suspend as boolean } : {}),
      ...(activeReferences.length > 0 ? { active: activeReferences } : {}),
      uid:
        suspend === true && options.suspendedCronJobUid !== undefined
          ? options.suspendedCronJobUid
          : cronJobUid,
    })
  const delay = vi.fn(async (milliseconds: number) => {
    await options.delay?.(milliseconds)
  })
  const execute = fakeRunner((command, commandOptions) => {
    if (command.args.includes("delete") && command.args.includes("job,pod,persistentvolumeclaim")) {
      cleanupCalls += 1
      if (cleanupCalls > 1 && options.cleanupError !== undefined) return options.cleanupError
      return {}
    }
    if (command.args.includes("patch") && command.args.includes("cronjob/dawn-reaper")) {
      patchCalls += 1
      if (patchCalls > 1 && options.restoreError !== undefined) return options.restoreError
      const patchIndex = command.args.indexOf("--patch")
      const patch = JSON.parse(command.args[patchIndex + 1] as string) as JsonObject
      const requested = ((patch.spec as JsonObject).suspend ?? null) as boolean | null
      if (requested === null) {
        suspendPresent = false
        suspend = undefined
      } else {
        suspendPresent = true
        suspend = requested
      }
      return currentCronJob()
    }
    if (commandOptions.stdin !== undefined) {
      const manifest = stdinObject(commandOptions)
      submitted.push(manifest)
      return manifest
    }
    if (command.args.includes("cronjob/dawn-reaper")) return currentCronJob()
    if (command.args.includes("get") && command.args.includes("jobs")) {
      let jobs: readonly JsonObject[]
      if (options.jobSnapshots === undefined) {
        jobs = defaultScheduledJobs()
      } else if (options.jobSnapshots.length === 0) {
        jobs = []
      } else {
        jobs = options.jobSnapshots[Math.min(jobListCalls, options.jobSnapshots.length - 1)] ?? []
      }
      jobListCalls += 1
      return jobList(jobs)
    }
    if (command.args.some((argument) => argument.startsWith("job/"))) {
      const requestedName = (
        command.args.find((argument) => argument.startsWith("job/")) as string
      ).slice("job/".length)
      const scheduledJob = knownScheduledJob(requestedName)
      if (scheduledJob !== undefined && options.activeWaitError !== undefined) {
        return options.activeWaitError
      }
      if (scheduledJob !== undefined) {
        const observed = structuredClone(scheduledJob)
        const uid = metadata(observed).uid
        if (typeof uid === "string") completedScheduledJobUids.add(uid)
        return {
          ...observed,
          status: { conditions: [{ type: "Complete", status: "True" }] },
        }
      }
      const job = submitted.find((manifest) => manifest.kind === "Job")
      if (job === undefined) throw new Error("Expected submitted reaper Job")
      return {
        ...job,
        status: { conditions: [{ type: "Complete", status: "True" }] },
      }
    }
    if (command.args.includes("persistentvolumeclaims")) {
      const claims = submitted.filter((manifest) => manifest.kind === "PersistentVolumeClaim")
      const referencePod = submitted.find((manifest) => manifest.kind === "Pod")
      if (claims.length !== 3 || referencePod === undefined) {
        throw new Error("Expected complete reaper fixtures")
      }
      const volume = (podSpec(referencePod).volumes as JsonObject[])[0] as JsonObject
      const referenceName = (volume.persistentVolumeClaim as JsonObject).claimName
      const referenced = claims.find((claim) => metadata(claim).name === referenceName)
      const stale = claims.find(
        (claim) =>
          metadata(claim).name !== referenceName && metadata(claim).annotations !== undefined,
      )
      const fresh = claims.find((claim) => metadata(claim).annotations === undefined)
      if (referenced === undefined || stale === undefined || fresh === undefined) {
        throw new Error("Expected stale, fresh, and referenced claims")
      }
      const observedFresh = structuredClone(fresh)
      if (options.markNew !== false) {
        metadata(observedFresh).annotations = {
          "dawn.sh/unbound-since": options.newMarker ?? String(REAPER_TEST_EPOCH_SECONDS),
        }
      }
      if (options.deletingNew === true) {
        metadata(observedFresh).deletionTimestamp = "2033-05-18T03:33:20Z"
      }
      const observedReferenced = structuredClone(referenced)
      metadata(observedReferenced).annotations =
        options.markReferenced === true
          ? { "dawn.sh/unbound-since": String(REAPER_TEST_EPOCH_SECONDS) }
          : {}
      if (options.deletingReferenced === true) {
        metadata(observedReferenced).deletionTimestamp = "2033-05-18T03:33:20Z"
      }
      return {
        apiVersion: "v1",
        kind: "PersistentVolumeClaimList",
        items: [
          ...(options.retainStale === true ? [structuredClone(stale)] : []),
          observedFresh,
          observedReferenced,
        ],
      }
    }
    return {}
  })
  return { execute, submitted, delay }
}

describe("probe manifest", () => {
  test("lists the exact stable probe IDs in plan order", () => {
    expect(KUBERNETES_COMPAT_PROBE_IDS).toEqual([
      "namespace.sandbox-secrets-empty",
      "network.control-ready",
      "admission.resource-quota",
      "admission.limit-range",
      "admission.restricted.before-upgrade",
      "rbac.secret-read-denied",
      "rbac.role-mutation-denied",
      "rbac.outside-namespace-denied",
      "reaper.lifecycle.before-upgrade",
      "app.service-ready.before-upgrade",
      "upgrade.infrastructure",
      "admission.restricted.after-infra-upgrade",
      "reaper.lifecycle.after-infra-upgrade",
      "upgrade.application",
      "app.service-ready.after-application-upgrade",
    ])
    expect(ADMISSION_RBAC_NETWORK_PROBE_IDS).toEqual(KUBERNETES_COMPAT_PROBE_IDS.slice(0, 8))
  })

  test("matches the checked-in expected probe manifest exactly", async () => {
    const manifest = JSON.parse(
      await readFile(resolve("test/k8s-compat/expected-tests.json"), "utf8"),
    ) as { probeIds: unknown }

    expect(manifest.probeIds).toEqual(KUBERNETES_COMPAT_PROBE_IDS)
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

    const lease = await runNetworkControlProbe({ context, runId, policy, execute })

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
    const clientName = metadata(pods[1] as JsonObject).name
    expect(execute.mock.calls.at(-1)?.[0].args).toEqual(
      expect.arrayContaining(["delete", `pod/${String(clientName)}`]),
    )
    expect(execute.mock.calls.some(([command]) => command.args.includes("pod,service"))).toBe(false)
    expect(lease.url).toBe(
      `http://${String(metadata(service).name)}.${names.sandboxNamespace}.svc.cluster.local:8080/`,
    )
    const networkWaits = execute.mock.calls.filter(([command]) => command.args.includes("wait"))
    expect(networkWaits).toHaveLength(2)
    for (const [command, options] of networkWaits) {
      expect(command.args).toContain("--timeout=120s")
      expect(options?.timeoutMs).toBe(150_000)
    }

    await Promise.all([lease.cleanup(), lease.cleanup()])
    expect(execute.mock.calls.at(-1)?.[0].args).toEqual(
      expect.arrayContaining([
        "delete",
        "pod,service",
        "--selector",
        `dawn.sh/compat-run=${runId}`,
      ]),
    )
    expect(
      execute.mock.calls.filter(([command]) => command.args.includes("--selector")),
    ).toHaveLength(1)
    const callsAfterCleanup = execute.mock.calls.length
    await lease.cleanup()
    expect(execute).toHaveBeenCalledTimes(callsAfterCleanup)
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

  test("scopes admission cleanup so retained network-control Pods survive later phases", async () => {
    const policy = await loadCompatibilityPolicy()
    const quotaStatus = forbidden(
      'pods "probe" is forbidden: exceeded quota: dawn-sandbox-quota, requested: requests.cpu=9',
      { kind: "pods" },
    )
    const podSecurityStatus = forbidden(
      'pods "probe" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true',
      { kind: "pods" },
    )
    const pairRunner = (status: JsonObject) =>
      fakeRunner((_command, options, index) =>
        index === 0 ? stdinObject(options) : index === 1 ? { exitCode: 1, body: status } : {},
      )
    const quota = pairRunner(quotaStatus)
    const restricted = pairRunner(podSecurityStatus)
    let submitted: JsonObject | undefined
    const limitRange = fakeRunner((_command, options, index) => {
      if (options.stdin !== undefined) submitted = stdinObject(options)
      if (index === 1) {
        const admitted = structuredClone(submitted) as JsonObject
        podContainer(admitted).resources = {
          limits: { cpu: "1", memory: "512Mi" },
          requests: { cpu: "100m", memory: "128Mi" },
        }
        return admitted
      }
      return submitted ?? {}
    })

    await runResourceQuotaProbe({ context, kubeconfig, runId, policy, execute: quota })
    await runRestrictedAdmissionProbe({
      context,
      kubeconfig,
      runId,
      policy,
      execute: restricted,
    })
    await runLimitRangeProbe({ context, kubeconfig, runId, policy, execute: limitRange })

    expect(quota.mock.calls.at(-1)?.[0].args).toContain(
      `dawn.sh/compat-run=${runId},dawn.sh/compat-component=quota-admission`,
    )
    expect(restricted.mock.calls.at(-1)?.[0].args).toContain(
      `dawn.sh/compat-run=${runId},dawn.sh/compat-component=restricted-admission`,
    )
    expect(limitRange.mock.calls.at(-1)?.[0].args).toContain(
      `dawn.sh/compat-run=${runId},dawn.sh/compat-component=limit-range`,
    )
  })
})

describe("same-candidate chart operations", () => {
  test("installs and upgrades infrastructure with live schedule and revision evidence", async () => {
    let revision = 1
    let schedule = "17 * * * *"
    const execute = fakeRunner((command) => {
      if (command.file === "helm" && command.args.includes("status")) {
        return helmStatus(names.sandboxRelease, revision)
      }
      if (command.args.includes("cronjob/dawn-reaper")) return reaperCronJob(schedule)
      return {}
    })

    await installInfrastructureChart({ context, runId, execute })
    revision = 2
    schedule = "23 * * * *"
    await upgradeInfrastructureChart({ context, runId, execute })

    const install = execute.mock.calls.find((call) => call[0].args.includes("install"))?.[0]
    const upgrade = execute.mock.calls.find((call) => call[0].args.includes("upgrade"))?.[0]
    if (install === undefined || upgrade === undefined) {
      throw new Error("Expected infrastructure Helm install and upgrade")
    }
    const installIndex = install.args.indexOf("install")
    const upgradeIndex = upgrade.args.indexOf("upgrade")
    expect(install.args[installIndex + 1]).toBe(names.sandboxRelease)
    expect(upgrade.args[upgradeIndex + 1]).toBe(names.sandboxRelease)
    expect(install.args[installIndex + 2]).toBe("charts/dawn-sandbox-infra")
    expect(upgrade.args[upgradeIndex + 2]).toBe(install.args[installIndex + 2])
    for (const command of [install, upgrade]) {
      expect(command.args).toEqual(
        expect.arrayContaining([
          "--namespace",
          names.managementNamespace,
          "--set-string",
          `namespace.name=${names.sandboxNamespace}`,
          "--set-string",
          `namespace.extraLabels.dawn\\.sh/compat-run=${runId}`,
        ]),
      )
    }
    expect(install.args).not.toContain("reaper.schedule=17 * * * *")
    expect(upgrade.args).toEqual(
      expect.arrayContaining(["--set-string", "reaper.schedule=23 * * * *"]),
    )
    const helmMutations = execute.mock.calls.filter(
      ([command]) =>
        command.file === "helm" &&
        (command.args.includes("install") || command.args.includes("upgrade")),
    )
    expect(helmMutations).toHaveLength(2)
    for (const [command, options] of helmMutations) {
      expect(command.args).toEqual(expect.arrayContaining(["--timeout", "5m"]))
      expect(options?.timeoutMs).toBe(360_000)
    }

    const statuses = execute.mock.calls
      .map(([command]) => command)
      .filter((command) => command.file === "helm" && command.args.includes("status"))
    expect(statuses).toHaveLength(2)
    for (const status of statuses) {
      expect(status.args).toEqual([
        "--kube-context",
        context,
        "status",
        names.sandboxRelease,
        "--namespace",
        names.managementNamespace,
        "--output",
        "json",
      ])
    }
    const cronChecks = execute.mock.calls.filter(([command]) =>
      command.args.includes("cronjob/dawn-reaper"),
    )
    expect(cronChecks).toHaveLength(2)
    for (const [command] of cronChecks) {
      expect(command.args).toEqual([
        "--context",
        context,
        "get",
        "cronjob/dawn-reaper",
        "--namespace",
        names.sandboxNamespace,
        "--output",
        "json",
      ])
    }
  })

  test("rejects a successful infrastructure install with a non-default live schedule", async () => {
    const execute = fakeRunner((command) =>
      command.file === "helm" && command.args.includes("status")
        ? helmStatus(names.sandboxRelease, 1)
        : command.args.includes("cronjob/dawn-reaper")
          ? reaperCronJob("18 * * * *")
          : {},
    )

    await expect(installInfrastructureChart({ context, runId, execute })).rejects.toThrow(
      /17 \* \* \* \*/,
    )
  })

  test.each([
    ["revision", 1, "23 * * * *", /revision 2/i],
    ["live schedule", 2, "17 * * * *", /23 \* \* \* \*/],
  ])(
    "rejects a successful infrastructure upgrade without the required %s evidence",
    async (_case, observedRevision, observedSchedule, expectedError) => {
      const execute = fakeRunner((command) =>
        command.file === "helm" && command.args.includes("status")
          ? helmStatus(names.sandboxRelease, observedRevision)
          : command.args.includes("cronjob/dawn-reaper")
            ? reaperCronJob(observedSchedule)
            : {},
      )

      await expect(upgradeInfrastructureChart({ context, runId, execute })).rejects.toThrow(
        expectedError,
      )
    },
  )

  test("installs and upgrades the application with live replica evidence", async () => {
    const policy = await loadCompatibilityPolicy()
    let revision = 1
    let desired = 1
    let available = 1
    const execute = fakeRunner((command) => {
      if (command.file === "helm" && command.args.includes("status")) {
        return helmStatus(names.appRelease, revision)
      }
      if (command.args.includes("deployments")) {
        return deploymentList(desired, available, [
          { name: "app", image: policy.images.placeholderApp },
        ])
      }
      return {}
    })

    await installApplicationChart({ context, runId, policy, execute })
    revision = 2
    desired = 2
    available = 2
    await upgradeApplicationChart({ context, runId, policy, execute })

    const install = execute.mock.calls.find((call) => call[0].args.includes("install"))?.[0]
    const upgrade = execute.mock.calls.find((call) => call[0].args.includes("upgrade"))?.[0]
    if (install === undefined || upgrade === undefined) {
      throw new Error("Expected application Helm install and upgrade")
    }
    const installIndex = install.args.indexOf("install")
    const upgradeIndex = upgrade.args.indexOf("upgrade")
    expect(install.args[installIndex + 1]).toBe(names.appRelease)
    expect(upgrade.args[upgradeIndex + 1]).toBe(names.appRelease)
    expect(install.args[installIndex + 2]).toBe("charts/dawn-app")
    expect(upgrade.args[upgradeIndex + 2]).toBe(install.args[installIndex + 2])
    const [repository, digest] = policy.images.placeholderApp.split("@")
    for (const command of [install, upgrade]) {
      expect(command.args).toEqual(
        expect.arrayContaining([
          "--namespace",
          names.managementNamespace,
          "--set-string",
          `image.repository=${repository}`,
          "--set-string",
          `image.digest=${digest}`,
          "--set",
          "containerPort=8080",
          "--set-string",
          "healthPath=/",
          "--set",
          "serviceAccount.create=true",
          "--set-string",
          `sandboxNamespace=${names.sandboxNamespace}`,
        ]),
      )
    }
    expect(install.args).toEqual(expect.arrayContaining(["--set", "replicaCount=1"]))
    expect(upgrade.args).toEqual(expect.arrayContaining(["--set", "replicaCount=2"]))
    const helmMutations = execute.mock.calls.filter(
      ([command]) =>
        command.file === "helm" &&
        (command.args.includes("install") || command.args.includes("upgrade")),
    )
    expect(helmMutations).toHaveLength(2)
    for (const [command, options] of helmMutations) {
      expect(command.args).toEqual(expect.arrayContaining(["--timeout", "5m"]))
      expect(options?.timeoutMs).toBe(360_000)
    }

    const statuses = execute.mock.calls
      .map(([command]) => command)
      .filter((command) => command.file === "helm" && command.args.includes("status"))
    expect(statuses).toHaveLength(2)
    for (const status of statuses) {
      expect(status.args).toEqual([
        "--kube-context",
        context,
        "status",
        names.appRelease,
        "--namespace",
        names.managementNamespace,
        "--output",
        "json",
      ])
    }
    const deploymentChecks = execute.mock.calls.filter(([command]) =>
      command.args.includes("deployments"),
    )
    expect(deploymentChecks).toHaveLength(2)
    for (const [command] of deploymentChecks) {
      expect(command.args).toEqual([
        "--context",
        context,
        "get",
        "deployments",
        "--namespace",
        names.managementNamespace,
        "--selector",
        `app.kubernetes.io/instance=${names.appRelease}`,
        "--output",
        "json",
      ])
    }
  })

  test.each(["install", "upgrade"] as const)(
    "rejects a successful application %s when the live Deployment image is wrong",
    async (operation) => {
      const policy = await loadCompatibilityPolicy()
      const revision = operation === "install" ? 1 : 2
      const replicas = operation === "install" ? 1 : 2
      const wrongImage = `example.invalid/wrong@sha256:${"f".repeat(64)}`
      const execute = fakeRunner((command) =>
        command.file === "helm" && command.args.includes("status")
          ? helmStatus(names.appRelease, revision)
          : command.args.includes("deployments")
            ? deploymentList(replicas, replicas, [{ name: "app", image: wrongImage }])
            : {},
      )

      const result =
        operation === "install"
          ? installApplicationChart({ context, runId, policy, execute })
          : upgradeApplicationChart({ context, runId, policy, execute })
      await expect(result).rejects.toThrow(/Deployment container image/i)

      const mutation = execute.mock.calls.find(
        ([command]) => command.file === "helm" && command.args.includes(operation),
      )?.[0]
      const [repository, digest] = policy.images.placeholderApp.split("@")
      expect(mutation?.args).toEqual(
        expect.arrayContaining([
          "--set-string",
          `image.repository=${repository}`,
          "--set-string",
          `image.digest=${digest}`,
        ]),
      )
    },
  )

  test.each([
    ["missing", []],
    [
      "multiple",
      [
        { name: "app", image: "placeholder" },
        { name: "sidecar", image: "placeholder" },
      ],
    ],
  ])("rejects a live Deployment with %s containers", async (_case, containers) => {
    const policy = await loadCompatibilityPolicy()
    const liveContainers = containers.map((container) => ({
      ...container,
      image: policy.images.placeholderApp,
    }))
    const execute = fakeRunner((command) =>
      command.file === "helm" && command.args.includes("status")
        ? helmStatus(names.appRelease, 1)
        : command.args.includes("deployments")
          ? deploymentList(1, 1, liveContainers)
          : {},
    )

    await expect(installApplicationChart({ context, runId, policy, execute })).rejects.toThrow(
      /exactly one.*container/i,
    )
  })

  test("rejects a successful application install with the wrong live replica count", async () => {
    const policy = await loadCompatibilityPolicy()
    const execute = fakeRunner((command) =>
      command.file === "helm" && command.args.includes("status")
        ? helmStatus(names.appRelease, 1)
        : command.args.includes("deployments")
          ? deploymentList(2, 2, [{ name: "app", image: policy.images.placeholderApp }])
          : {},
    )

    await expect(installApplicationChart({ context, runId, policy, execute })).rejects.toThrow(
      /replicas.*1/i,
    )
  })

  test.each([
    ["revision", 1, 2, 2, /revision 2/i],
    ["desired replicas", 2, 1, 2, /desired replicas.*2/i],
    ["available replicas", 2, 2, 1, /available replicas.*2/i],
  ])(
    "rejects a successful application upgrade without the required %s evidence",
    async (_case, observedRevision, desiredReplicas, availableReplicas, expectedError) => {
      const policy = await loadCompatibilityPolicy()
      const execute = fakeRunner((command) =>
        command.file === "helm" && command.args.includes("status")
          ? helmStatus(names.appRelease, observedRevision)
          : command.args.includes("deployments")
            ? deploymentList(desiredReplicas, availableReplicas, [
                { name: "app", image: policy.images.placeholderApp },
              ])
            : {},
      )

      await expect(upgradeApplicationChart({ context, runId, policy, execute })).rejects.toThrow(
        expectedError,
      )
    },
  )
})

describe("reaper and application Service probes", () => {
  test.each([
    ["absent", undefined, null],
    ["false", false, false],
    ["true", true, true],
  ])(
    "restores an originally %s CronJob suspend field exactly after success",
    async (_case, initialSuspend, restoredSuspend) => {
      const policy = await loadCompatibilityPolicy()
      const { execute, delay } = createReaperRunner({
        ...(initialSuspend !== undefined ? { initialSuspend } : {}),
      })

      await runReaperLifecycleProbe({ context, runId, policy, execute }, { delay })

      const patches = execute.mock.calls.filter(
        ([command]) =>
          command.args.includes("patch") && command.args.includes("cronjob/dawn-reaper"),
      )
      expect(patches).toHaveLength(2)
      expect(patches[0]?.[0].args).toEqual([
        "--context",
        context,
        "patch",
        "cronjob/dawn-reaper",
        "--namespace",
        names.sandboxNamespace,
        "--type=merge",
        "--patch",
        JSON.stringify({ spec: { suspend: true } }),
        "--output",
        "json",
      ])
      expect(patches[1]?.[0].args).toEqual([
        "--context",
        context,
        "patch",
        "cronjob/dawn-reaper",
        "--namespace",
        names.sandboxNamespace,
        "--type=merge",
        "--patch",
        JSON.stringify({ spec: { suspend: restoredSuspend } }),
        "--output",
        "json",
      ])
    },
  )

  test("requires a concrete UID on the live suspended CronJob before fixture creation", async () => {
    const policy = await loadCompatibilityPolicy()
    const { execute, submitted, delay } = createReaperRunner({ suspendedCronJobUid: null })

    await expect(
      runReaperLifecycleProbe({ context, runId, policy, execute }, { delay }),
    ).rejects.toThrow(/Reaper CronJob.*metadata\.uid/i)

    expect(submitted).toHaveLength(0)
    expect(
      execute.mock.calls.filter(
        ([command]) =>
          command.args.includes("patch") && command.args.includes("cronjob/dawn-reaper"),
      ),
    ).toHaveLength(2)
  })

  test("drains a late owned Job found after an initially empty suspended snapshot", async () => {
    const policy = await loadCompatibilityPolicy()
    const lateJob = scheduledReaperJob({
      name: "dawn-reaper-late",
      uid: "44444444-4444-4444-8444-444444444444",
    })
    let submitted: readonly JsonObject[] = []
    const runner = createReaperRunner({
      jobSnapshots: [[], [lateJob], [], []],
      delay: async (milliseconds) => {
        expect(milliseconds).toBeGreaterThan(0)
        expect(milliseconds).toBeLessThanOrEqual(5_000)
        expect(
          submitted.some(
            (manifest) => manifest.kind === "PersistentVolumeClaim" || manifest.kind === "Pod",
          ),
        ).toBe(false)
      },
    })
    submitted = runner.submitted

    await runReaperLifecycleProbe(
      { context, runId, policy, execute: runner.execute },
      { delay: runner.delay },
    )

    expect(runner.delay).toHaveBeenCalledTimes(2)
    const jobLists = runner.execute.mock.calls.filter(
      ([command]) => command.args.includes("get") && command.args.includes("jobs"),
    )
    expect(jobLists).toHaveLength(4)
    for (const [command, options] of jobLists) {
      expect(command.args).toEqual([
        "--context",
        context,
        "get",
        "jobs",
        "--namespace",
        names.sandboxNamespace,
        "--output",
        "json",
      ])
      expect(options?.timeoutMs).toBe(30_000)
    }
    const lateWaitIndex = runner.execute.mock.calls.findIndex(([command]) =>
      command.args.includes("job/dawn-reaper-late"),
    )
    const lateWait = runner.execute.mock.calls[lateWaitIndex]
    expect(lateWait?.[0].args).toContain("--timeout=120s")
    expect(lateWait?.[1]?.timeoutMs).toBe(150_000)
    const firstFixture = runner.execute.mock.calls.findIndex(([, options]) => {
      if (options?.stdin === undefined) return false
      const kind = stdinObject(options).kind
      return kind === "PersistentVolumeClaim" || kind === "Pod"
    })
    expect(lateWaitIndex).toBeGreaterThan(-1)
    expect(lateWaitIndex).toBeLessThan(firstFixture)
  })

  test.each([
    [
      "UID",
      (job: JsonObject) => {
        metadata(job).uid = "55555555-5555-4555-8555-555555555555"
        return job
      },
    ],
    [
      "name",
      (job: JsonObject) => {
        metadata(job).name = "dawn-reaper-other"
        return job
      },
    ],
    [
      "namespace",
      (job: JsonObject) => {
        metadata(job).namespace = names.managementNamespace
        return job
      },
    ],
    [
      "apiVersion",
      (job: JsonObject) => {
        job.apiVersion = "v1"
        return job
      },
    ],
    [
      "kind",
      (job: JsonObject) => {
        job.kind = "Pod"
        return job
      },
    ],
    [
      "controller owner reference",
      (job: JsonObject) => {
        const ownerReferences = metadata(job).ownerReferences as JsonObject[]
        const controller = ownerReferences[0] as JsonObject
        controller.controller = false
        return job
      },
    ],
  ])(
    "rejects an active reference whose %s does not exactly match its fetched owned Job",
    async (_case, mutateJob) => {
      const policy = await loadCompatibilityPolicy()
      const matchingJob = scheduledReaperJob({
        name: "dawn-reaper-active",
        uid: "22222222-2222-4222-8222-222222222222",
      })
      const activeReference = activeJobReference(matchingJob)
      const fetchedJob = mutateJob(structuredClone(matchingJob))
      const { execute, submitted, delay } = createReaperRunner({
        activeReferences: [activeReference],
        jobSnapshots: [[fetchedJob]],
      })

      await expect(
        runReaperLifecycleProbe({ context, runId, policy, execute }, { delay }),
      ).rejects.toThrow(/active CronJob reference.*exactly match.*owned Job/i)

      expect(submitted).toHaveLength(0)
    },
  )

  test("ignores unfinished Jobs without the exact CronJob controller UID", async () => {
    const policy = await loadCompatibilityPolicy()
    const differentOwner = scheduledReaperJob({
      name: "unrelated-different-owner",
      uid: "66666666-6666-4666-8666-666666666666",
      ownerUid: "77777777-7777-4777-8777-777777777777",
    })
    const noOwner = scheduledReaperJob({
      name: "unrelated-no-owner",
      uid: "88888888-8888-4888-8888-888888888888",
      ownerUid: null,
    })
    const { execute, submitted, delay } = createReaperRunner({
      jobSnapshots: [
        [differentOwner, noOwner],
        [differentOwner, noOwner],
      ],
    })

    await runReaperLifecycleProbe({ context, runId, policy, execute }, { delay })

    expect(submitted.some((manifest) => manifest.kind === "PersistentVolumeClaim")).toBe(true)
    expect(delay).toHaveBeenCalledTimes(1)
    expect(
      execute.mock.calls.filter(
        ([command]) => command.args.includes("get") && command.args.includes("jobs"),
      ),
    ).toHaveLength(2)
    for (const unrelatedName of ["unrelated-different-owner", "unrelated-no-owner"]) {
      expect(
        execute.mock.calls.some(([command]) => command.args.includes(`job/${unrelatedName}`)),
      ).toBe(false)
    }
  })

  test("treats completed owned Jobs as drained without waiting", async () => {
    const policy = await loadCompatibilityPolicy()
    const completed = scheduledReaperJob({
      name: "dawn-reaper-completed",
      uid: "99999999-9999-4999-8999-999999999999",
      status: "complete",
    })
    const { execute, submitted, delay } = createReaperRunner({
      jobSnapshots: [[completed], [completed]],
    })

    await runReaperLifecycleProbe({ context, runId, policy, execute }, { delay })

    expect(submitted.some((manifest) => manifest.kind === "PersistentVolumeClaim")).toBe(true)
    expect(delay).toHaveBeenCalledTimes(1)
    expect(
      execute.mock.calls.filter(
        ([command]) => command.args.includes("get") && command.args.includes("jobs"),
      ),
    ).toHaveLength(2)
    expect(
      execute.mock.calls.some(([command]) => command.args.includes("job/dawn-reaper-completed")),
    ).toBe(false)
  })

  test("fails explicitly when an owned scheduled Job has failed", async () => {
    const policy = await loadCompatibilityPolicy()
    const failed = scheduledReaperJob({
      name: "dawn-reaper-failed",
      uid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "failed",
    })
    const { execute, submitted, delay } = createReaperRunner({ jobSnapshots: [[failed]] })

    await expect(
      runReaperLifecycleProbe({ context, runId, policy, execute }, { delay }),
    ).rejects.toThrow(/owned Reaper Job.*failed/i)

    expect(submitted).toHaveLength(0)
    expect(
      execute.mock.calls.some(([command]) => command.args.includes("job/dawn-reaper-failed")),
    ).toBe(false)
  })

  test("fails within a finite number of snapshots when scheduled Jobs never quiesce", async () => {
    const policy = await loadCompatibilityPolicy()
    const unfinished = scheduledReaperJob({
      name: "dawn-reaper-never-quiescent",
      uid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })
    const { execute, submitted, delay } = createReaperRunner({
      jobSnapshots: Array.from({ length: 12 }, () => [structuredClone(unfinished)]),
    })

    await expect(
      runReaperLifecycleProbe({ context, runId, policy, execute }, { delay }),
    ).rejects.toThrow(/scheduled Reaper Jobs.*quiescent/i)

    const listCalls = execute.mock.calls.filter(
      ([command]) => command.args.includes("get") && command.args.includes("jobs"),
    )
    expect(listCalls.length).toBeGreaterThan(1)
    expect(listCalls.length).toBeLessThanOrEqual(10)
    expect(submitted).toHaveLength(0)
  })

  test("suspends the CronJob and drains live active Jobs before creating fixtures", async () => {
    const policy = await loadCompatibilityPolicy()
    const activeReferences = [
      {
        apiVersion: "batch/v1",
        kind: "Job",
        name: "dawn-reaper-existing-a",
        namespace: names.sandboxNamespace,
        uid: "22222222-2222-4222-8222-222222222222",
      },
      {
        apiVersion: "batch/v1",
        kind: "Job",
        name: "dawn-reaper-existing-b",
        namespace: names.sandboxNamespace,
        uid: "33333333-3333-4333-8333-333333333333",
      },
    ]
    const { execute, delay } = createReaperRunner({ activeReferences })

    await runReaperLifecycleProbe({ context, runId, policy, execute }, { delay })

    const calls = execute.mock.calls
    const cronReads = calls.flatMap(([command], index) =>
      command.args.includes("get") && command.args.includes("cronjob/dawn-reaper") ? [index] : [],
    )
    const patches = calls.flatMap(([command], index) =>
      command.args.includes("patch") && command.args.includes("cronjob/dawn-reaper") ? [index] : [],
    )
    const firstFixture = calls.findIndex(([, options]) => {
      if (options?.stdin === undefined) return false
      const kind = stdinObject(options).kind
      return kind === "PersistentVolumeClaim" || kind === "Pod"
    })
    expect(cronReads).toHaveLength(2)
    expect(patches).toHaveLength(2)
    expect(cronReads[0]).toBeLessThan(patches[0] as number)
    expect(patches[0]).toBeLessThan(cronReads[1] as number)

    for (const reference of activeReferences) {
      const waitIndex = calls.findIndex(([command]) =>
        command.args.includes(`job/${String(reference.name)}`),
      )
      expect(waitIndex).toBeGreaterThan(cronReads[1] as number)
      expect(waitIndex).toBeLessThan(firstFixture)
      expect(calls[waitIndex]?.[0].args).toEqual([
        "--context",
        context,
        "wait",
        "--namespace",
        names.sandboxNamespace,
        "--for=condition=Complete",
        `job/${String(reference.name)}`,
        "--timeout=120s",
        "--output",
        "json",
      ])
      expect(calls[waitIndex]?.[1]?.timeoutMs).toBe(150_000)
    }
    expect(firstFixture).toBeGreaterThan(cronReads[1] as number)
    expect(patches[1]).toBeGreaterThan(firstFixture)
  })

  test.each([
    [
      "apiVersion",
      {
        apiVersion: "v1",
        kind: "Job",
        name: "dawn-reaper-existing",
        namespace: names.sandboxNamespace,
        uid: "22222222-2222-4222-8222-222222222222",
      },
    ],
    [
      "kind",
      {
        apiVersion: "batch/v1",
        kind: "Pod",
        name: "dawn-reaper-existing",
        namespace: names.sandboxNamespace,
        uid: "22222222-2222-4222-8222-222222222222",
      },
    ],
    [
      "namespace",
      {
        apiVersion: "batch/v1",
        kind: "Job",
        name: "dawn-reaper-existing",
        namespace: names.managementNamespace,
        uid: "22222222-2222-4222-8222-222222222222",
      },
    ],
    [
      "name",
      {
        apiVersion: "batch/v1",
        kind: "Job",
        name: "",
        namespace: names.sandboxNamespace,
        uid: "22222222-2222-4222-8222-222222222222",
      },
    ],
    [
      "uid",
      {
        apiVersion: "batch/v1",
        kind: "Job",
        name: "dawn-reaper-existing",
        namespace: names.sandboxNamespace,
        uid: "",
      },
    ],
  ])(
    "rejects an invalid active CronJob reference %s before fixture creation and restores suspension",
    async (_case, activeReference) => {
      const policy = await loadCompatibilityPolicy()
      const { execute, submitted, delay } = createReaperRunner({
        activeReferences: [activeReference],
      })

      await expect(
        runReaperLifecycleProbe({ context, runId, policy, execute }, { delay }),
      ).rejects.toThrow(/active.*batch\/v1 Job/i)

      expect(submitted).toHaveLength(0)
      expect(
        execute.mock.calls.filter(
          ([command]) =>
            command.args.includes("patch") && command.args.includes("cronjob/dawn-reaper"),
        ),
      ).toHaveLength(2)
    },
  )

  test("attempts fixture cleanup and suspension restoration when active Job draining fails", async () => {
    const policy = await loadCompatibilityPolicy()
    const activeWaitError = new Error("active reaper Job did not finish")
    const { execute, submitted, delay } = createReaperRunner({
      activeReferences: [
        {
          apiVersion: "batch/v1",
          kind: "Job",
          name: "dawn-reaper-existing",
          namespace: names.sandboxNamespace,
          uid: "22222222-2222-4222-8222-222222222222",
        },
      ],
      activeWaitError,
    })

    await expect(
      runReaperLifecycleProbe({ context, runId, policy, execute }, { delay }),
    ).rejects.toBe(activeWaitError)

    expect(submitted).toHaveLength(0)
    expect(
      execute.mock.calls.filter(
        ([command]) =>
          command.args.includes("delete") && command.args.includes("job,pod,persistentvolumeclaim"),
      ),
    ).toHaveLength(1)
    expect(
      execute.mock.calls.filter(
        ([command]) =>
          command.args.includes("patch") && command.args.includes("cronjob/dawn-reaper"),
      ),
    ).toHaveLength(2)
  })

  test("proves stale deletion, fresh marking, and referenced retention with restricted fixtures", async () => {
    const policy = await loadCompatibilityPolicy()
    const { execute, submitted, delay } = createReaperRunner()

    await runReaperLifecycleProbe({ context, runId, policy, execute }, { delay })

    const claims = submitted.filter((manifest) => manifest.kind === "PersistentVolumeClaim")
    const referencePod = submitted.find((manifest) => manifest.kind === "Pod")
    const job = submitted.find((manifest) => manifest.kind === "Job")
    expect(claims).toHaveLength(3)
    if (referencePod === undefined || job === undefined) {
      throw new Error("Expected reaper reference Pod and Job")
    }
    expectRestrictedPod(referencePod, policy.images.admissionProbe)
    const referenceVolume = (podSpec(referencePod).volumes as JsonObject[])[0] as JsonObject
    const referenceClaim = (referenceVolume.persistentVolumeClaim as JsonObject).claimName
    expect(referenceClaim).toEqual(expect.any(String))
    const staleClaim = claims.find(
      (claim) =>
        metadata(claim).name !== referenceClaim && metadata(claim).annotations !== undefined,
    )
    expect(staleClaim).toBeDefined()
    expect(podContainer(referencePod).volumeMounts).toEqual([
      { name: "referenced", mountPath: "/data", readOnly: true },
    ])
    for (const claim of claims) {
      expect(metadata(claim).namespace).toBe(names.sandboxNamespace)
      expect(metadata(claim).labels).toMatchObject({
        "app.kubernetes.io/managed-by": "dawn",
        "dawn.sh/compat-run": runId,
      })
      expect((claim.spec as JsonObject).storageClassName).toBe("")
    }
    expect(
      execute.mock.calls.some(([command]) =>
        command.args.includes(`pvc/${String(metadata(staleClaim as JsonObject).name)}`),
      ),
    ).toBe(true)
    const completeWait = execute.mock.calls.find(([command]) =>
      command.args.includes("--for=condition=Complete"),
    )
    expect(completeWait?.[0].args).toContain("--timeout=120s")
    expect(completeWait?.[1]?.timeoutMs).toBe(150_000)
    const staleWait = execute.mock.calls.find(([command]) =>
      command.args.includes(`pvc/${String(metadata(staleClaim as JsonObject).name)}`),
    )
    expect(staleWait?.[0].args).toEqual([
      "--context",
      context,
      "wait",
      "--namespace",
      names.sandboxNamespace,
      "--for=delete",
      `pvc/${String(metadata(staleClaim as JsonObject).name)}`,
      "--timeout=30s",
    ])
    expect(staleWait?.[1]?.timeoutMs).toBe(60_000)
    expect(metadata(job)).toMatchObject({
      namespace: names.sandboxNamespace,
      labels: { "dawn.sh/compat-run": runId },
    })
    expect(metadata((job.spec as JsonObject).template as JsonObject).labels).toMatchObject({
      "dawn.sh/compat-run": runId,
    })

    const cleanup = execute.mock.calls.filter(
      ([command]) =>
        command.args.includes("delete") && command.args.includes("job,pod,persistentvolumeclaim"),
    )
    expect(cleanup).toHaveLength(2)
    for (const [command] of cleanup) {
      expect(command.args).toEqual(
        expect.arrayContaining([
          "--namespace",
          names.sandboxNamespace,
          "--selector",
          `dawn.sh/compat-run=${runId},dawn.sh/compat-component=reaper-lifecycle`,
          "--ignore-not-found=true",
          "--wait=true",
          "--output",
          "json",
        ]),
      )
    }
  })

  test.each([
    ["stale PVC is retained", { retainStale: true }, /stale PVC.*deleted/i],
    ["new PVC is unmarked", { markNew: false }, /new PVC.*marker/i],
    ["referenced PVC remains marked", { markReferenced: true }, /referenced PVC.*unmarked/i],
    ["new PVC is terminating", { deletingNew: true }, /new PVC.*deletionTimestamp/i],
    [
      "referenced PVC is terminating",
      { deletingReferenced: true },
      /referenced PVC.*deletionTimestamp/i,
    ],
    ["new PVC marker is ancient", { newMarker: "1" }, /new PVC marker.*execution window/i],
    [
      "new PVC marker is far in the future",
      { newMarker: "4000000000" },
      /new PVC marker.*execution window/i,
    ],
  ])("rejects completed reaper Jobs when the %s", async (_case, options, expectedError) => {
    const policy = await loadCompatibilityPolicy()
    const { execute, delay } = createReaperRunner(options)

    await expect(
      runReaperLifecycleProbe({ context, runId, policy, execute }, { delay }),
    ).rejects.toThrow(expectedError)
  })

  test("preserves the primary, fixture cleanup, and suspension restoration failures", async () => {
    const policy = await loadCompatibilityPolicy()
    const cleanupError = new Error("reaper cleanup failed")
    const restoreError = new Error("reaper suspension restore failed")
    const { execute, delay } = createReaperRunner({ markNew: false, cleanupError, restoreError })

    const error = await runReaperLifecycleProbe(
      { context, runId, policy, execute },
      { delay },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    const errors = (error as AggregateError).errors
    expect(errors).toHaveLength(3)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toMatch(/new PVC.*marker/i)
    expect(errors[1]).toBe(cleanupError)
    expect(errors[2]).toBe(restoreError)
  })

  test("reruns chart Service reachability with digest-pinned restricted Pods that exit zero", async () => {
    const policy = await loadCompatibilityPolicy()
    let submittedPod: JsonObject | undefined
    const execute = fakeRunner((command, options) => {
      if (command.args.includes("services")) return serviceList()
      if (options.stdin !== undefined) {
        submittedPod = stdinObject(options)
        return submittedPod
      }
      if (command.args.some((argument) => argument.startsWith("pod/"))) {
        if (submittedPod === undefined) throw new Error("Expected reachability Pod")
        return {
          ...submittedPod,
          status: {
            phase: "Succeeded",
            containerStatuses: [
              { name: "probe", state: { terminated: { exitCode: 0, reason: "Completed" } } },
            ],
          },
        }
      }
      return {}
    })

    await runApplicationServiceReadyProbe({ context, runId, policy, execute })
    await runApplicationServiceReadyProbe({ context, runId, policy, execute })

    expectRestrictedPod(
      submittedPod as JsonObject,
      policy.images.reachabilityProbe,
      names.managementNamespace,
    )
    expect(podContainer(submittedPod as JsonObject).args).toEqual(
      expect.arrayContaining([
        `http://${names.appRelease}-dawn-app.${names.managementNamespace}.svc.cluster.local:80/`,
      ]),
    )
    const serviceCheck = execute.mock.calls.find(([command]) =>
      command.args.includes("services"),
    )?.[0]
    expect(serviceCheck?.args).toEqual([
      "--context",
      context,
      "get",
      "services",
      "--namespace",
      names.managementNamespace,
      "--selector",
      `app.kubernetes.io/instance=${names.appRelease}`,
      "--output",
      "json",
    ])
    expect(
      execute.mock.calls.some(
        ([command]) =>
          command.args.includes("get") &&
          command.args.some((argument) => argument.startsWith("pod/")) &&
          command.args.includes("--output") &&
          command.args.includes("json"),
      ),
    ).toBe(true)
    const submittedPods = execute.mock.calls.filter(([, options]) => {
      if (options?.stdin === undefined) return false
      return stdinObject(options).kind === "Pod"
    })
    expect(submittedPods).toHaveLength(2)
    const serviceWaits = execute.mock.calls.filter(([command]) =>
      command.args.includes("--for=jsonpath={.status.phase}=Succeeded"),
    )
    expect(serviceWaits).toHaveLength(2)
    for (const [command, options] of serviceWaits) {
      expect(command.args).toContain("--timeout=120s")
      expect(options?.timeoutMs).toBe(150_000)
    }
    const cleanup = execute.mock.calls.filter(
      ([command]) =>
        command.args.includes("delete") &&
        command.args.includes(
          `dawn.sh/compat-run=${runId},dawn.sh/compat-component=app-service-ready`,
        ),
    )
    expect(cleanup).toHaveLength(4)
  })

  test("rejects a successful reachability wait when the live Pod did not exit zero", async () => {
    const policy = await loadCompatibilityPolicy()
    let submittedPod: JsonObject | undefined
    const execute = fakeRunner((command, options) => {
      if (command.args.includes("services")) return serviceList()
      if (options.stdin !== undefined) {
        submittedPod = stdinObject(options)
        return submittedPod
      }
      if (command.args.some((argument) => argument.startsWith("pod/"))) {
        return {
          ...submittedPod,
          status: {
            phase: "Succeeded",
            containerStatuses: [
              { name: "probe", state: { terminated: { exitCode: 7, reason: "Error" } } },
            ],
          },
        }
      }
      return {}
    })

    await expect(
      runApplicationServiceReadyProbe({ context, runId, policy, execute }),
    ).rejects.toThrow(/exit code 0/i)
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

  test("rejects a different Pod Security violation when only nested details mention runAsNonRoot", () => {
    const counterexample = forbidden(
      'pods "probe" is forbidden: violates PodSecurity "restricted:latest": hostNetwork=true',
      {
        kind: "pods",
        causes: [
          {
            reason: "FieldValueForbidden",
            message: "unrelated diagnostic mentions runAsNonRoot",
          },
        ],
      },
    )

    expect(() => assertPodSecurityRejection(counterexample)).toThrow(/runAsNonRoot/i)
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

  test("rejects validating-policy denial when only nested details resemble RBAC", () => {
    const expectation = {
      verb: "create",
      resource: "roles",
      apiGroup: "rbac.authorization.k8s.io",
      namespace: "ns",
    }
    const counterexample = forbidden(
      'roles.rbac.authorization.k8s.io "probe" is forbidden: ValidatingAdmissionPolicy "guard" denied request',
      {
        causes: [
          {
            message:
              'User "nested" cannot create resource "roles" in API group "rbac.authorization.k8s.io" in the namespace "ns"',
          },
        ],
      },
    )

    expect(() => assertRbacRejection(counterexample, expectation)).toThrow(/authorization denial/i)
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
        ? `secrets is forbidden: User "system:serviceaccount:${names.sandboxNamespace}:dawn-orchestrator" cannot list resource "secrets" in API group "" in the namespace "${names.sandboxNamespace}"`
        : path.endsWith("/roles")
          ? `roles.rbac.authorization.k8s.io is forbidden: User "system:serviceaccount:${names.sandboxNamespace}:dawn-orchestrator" cannot create resource "roles" in API group "rbac.authorization.k8s.io" in the namespace "${names.sandboxNamespace}"`
          : `configmaps is forbidden: User "system:serviceaccount:${names.sandboxNamespace}:dawn-orchestrator" cannot create resource "configmaps" in API group "" in the namespace "${names.managementNamespace}"`
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
      `secrets is forbidden: User "system:serviceaccount:${names.sandboxNamespace}:dawn-orchestrator" cannot list resource "secrets" in API group "" in the namespace "${names.sandboxNamespace}"`,
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

  test("routes v1.35 structured response bodies through quota, Pod Security, and RBAC validators", async () => {
    const policy = await loadCompatibilityPolicy()
    const quotaStatus = forbidden(
      'pods "probe" is forbidden: exceeded quota: dawn-sandbox-quota, requested: requests.cpu=9',
      { name: "probe", kind: "pods" },
    )
    const podSecurityStatus = forbidden(
      'pods "probe" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true',
      { name: "probe", kind: "pods" },
    )
    const secretStatus = forbidden(
      `secrets is forbidden: User "system:serviceaccount:${names.sandboxNamespace}:dawn-orchestrator" cannot list resource "secrets" in API group "" in the namespace "${names.sandboxNamespace}"`,
      { kind: "secrets" },
    )
    const admissionRunner = (status: JsonObject) =>
      fakeRunner((_command, options, index) =>
        index === 0
          ? stdinObject(options)
          : index === 1
            ? { exitCode: 1, body: "", stderr: structuredResponseLog(status) }
            : {},
      )

    await runResourceQuotaProbe({
      context,
      kubeconfig,
      runId,
      policy,
      execute: admissionRunner(quotaStatus),
    })
    await runRestrictedAdmissionProbe({
      context,
      kubeconfig,
      runId,
      policy,
      execute: admissionRunner(podSecurityStatus),
    })
    await runSecretReadDeniedProbe({
      context,
      kubeconfig,
      runId,
      execute: fakeRunner(() => ({
        exitCode: 1,
        body: "",
        stderr: structuredResponseLog(secretStatus),
      })),
    })
  })

  test("selects the final v1 Status from structured response body candidates", async () => {
    const unrelated = forbidden(
      'pods "probe" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true',
      { kind: "pods" },
    )
    const expected = forbidden(
      `secrets is forbidden: User "system:serviceaccount:${names.sandboxNamespace}:dawn-orchestrator" cannot list resource "secrets" in API group "" in the namespace "${names.sandboxNamespace}"`,
      { kind: "secrets" },
    )

    await expect(
      runSecretReadDeniedProbe({
        context,
        kubeconfig,
        runId,
        execute: fakeRunner(() => ({
          exitCode: 1,
          body: "",
          stderr: `${structuredResponseLog(unrelated)}${structuredResponseLog(expected)}${structuredResponseLog({ apiVersion: "v2", kind: "Status" })}`,
        })),
      }),
    ).resolves.toBeUndefined()
  })

  test.each([
    [
      "unterminated body",
      'I0810 round_trippers.go:577] "Response Body" body="{\\"kind\\":\\"Status\\"}\n',
    ],
    [
      "unquoted body",
      'I0810 round_trippers.go:577] "Response Body" body={"apiVersion":"v1","kind":"Status"}\n',
    ],
    [
      "invalid decoded JSON",
      `I0810 round_trippers.go:577] "Response Body" body=${JSON.stringify("{not-json")}\n`,
    ],
    [
      "trailing fields",
      `${structuredResponseLog(
        forbidden(
          `secrets is forbidden: User "system:serviceaccount:${names.sandboxNamespace}:dawn-orchestrator" cannot list resource "secrets" in API group "" in the namespace "${names.sandboxNamespace}"`,
          { kind: "secrets" },
        ),
      ).trimEnd()} extra="value"\n`,
    ],
  ])("rejects malformed structured klog %s", async (_name, stderr) => {
    await expect(
      runSecretReadDeniedProbe({
        context,
        kubeconfig,
        runId,
        execute: fakeRunner(() => ({ exitCode: 1, body: "", stderr })),
      }),
    ).rejects.toThrow(/valid Kubernetes Status JSON/i)
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

  test("allows a failed network lease cleanup to be retried", async () => {
    const policy = await loadCompatibilityPolicy()
    let clientPod: JsonObject | undefined
    let retainedCleanupAttempts = 0
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
      if (command.args.includes("--selector")) {
        retainedCleanupAttempts += 1
        if (retainedCleanupAttempts === 1) return new Error("retained cleanup failed")
      }
      return {}
    })
    const lease = await runNetworkControlProbe({ context, runId, policy, execute })

    await expect(lease.cleanup()).rejects.toThrow(/retained cleanup failed/i)
    await expect(lease.cleanup()).resolves.toBeUndefined()
    expect(retainedCleanupAttempts).toBe(2)
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
