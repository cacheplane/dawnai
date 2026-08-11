import { createHash } from "node:crypto"
import { deriveClusterNames } from "./cluster.js"
import {
  type Command,
  type CommandExecutionOptions,
  type CommandResult,
  executeCommand,
  kubectl,
} from "./command.js"
import type { CompatibilityPolicy } from "./policy.js"

export const ADMISSION_RBAC_NETWORK_PROBE_IDS = Object.freeze([
  "namespace.sandbox-secrets-empty",
  "network.control-ready",
  "admission.resource-quota",
  "admission.limit-range",
  "admission.restricted.before-upgrade",
  "rbac.secret-read-denied",
  "rbac.role-mutation-denied",
  "rbac.outside-namespace-denied",
] as const)

export type AdmissionRbacNetworkProbeId = (typeof ADMISSION_RBAC_NETWORK_PROBE_IDS)[number]

export type ProbeCommandRunner = (
  command: Command,
  options?: CommandExecutionOptions,
) => Promise<CommandResult>

export interface AdministrativeProbeInput {
  readonly context: string
  readonly runId: string
  readonly execute?: ProbeCommandRunner
}

export interface PolicyProbeInput extends AdministrativeProbeInput {
  readonly policy: CompatibilityPolicy
}

export interface TokenKubeconfigProbeInput extends AdministrativeProbeInput {
  readonly kubeconfig: string
}

export interface TokenProbeInput extends PolicyProbeInput, TokenKubeconfigProbeInput {}

export interface RbacRejectionExpectation {
  readonly verb: string
  readonly resource: string
  readonly apiGroup: string
  readonly namespace: string
}

export interface NetworkControlLease {
  readonly url: string
  cleanup(): Promise<void>
}

type JsonObject = Record<string, unknown>

const RUN_LABEL = "dawn.sh/compat-run"
const QUOTA_NAME = "dawn-sandbox-quota"
const DEFAULT_LIMITS = Object.freeze({
  limits: Object.freeze({ cpu: "1", memory: "512Mi" }),
  requests: Object.freeze({ cpu: "100m", memory: "128Mi" }),
})
const REJECTION_EXIT_CODES = Object.freeze([1] as const)
const DNS_NAME_PATTERN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/
const LABEL_VALUE_PATTERN = /^(?:[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/

function expectNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function expectRunId(value: string): string {
  const runId = expectNonEmpty(value, "Compatibility run ID")
  if (runId.length > 63 || !LABEL_VALUE_PATTERN.test(runId)) {
    throw new Error("Compatibility run ID must be a valid Kubernetes label value")
  }
  return runId
}

function expectObject(value: unknown, name: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as JsonObject
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function resourceName(runId: string, role: string): string {
  const suffix = createHash("sha256").update(`${runId}:${role}`).digest("hex").slice(0, 8)
  const normalizedRole = role
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
  if (normalizedRole.length === 0 || !DNS_NAME_PATTERN.test(normalizedRole)) {
    throw new Error(`Probe resource role is not DNS-safe: ${role}`)
  }
  const prefix = `dawn-compat-${normalizedRole}`
  return `${prefix.slice(0, 63 - suffix.length - 1).replaceAll(/-+$/g, "")}-${suffix}`
}

function probeState(input: AdministrativeProbeInput): {
  readonly context: string
  readonly runId: string
  readonly namespace: string
  readonly managementNamespace: string
  readonly execute: ProbeCommandRunner
} {
  const context = expectNonEmpty(input.context, "Kubernetes context")
  const runId = expectRunId(input.runId)
  const names = deriveClusterNames(runId)
  return {
    context,
    runId,
    namespace: names.sandboxNamespace,
    managementNamespace: names.managementNamespace,
    execute: input.execute ?? executeCommand,
  }
}

function restrictedPod(input: {
  readonly name: string
  readonly namespace: string
  readonly runId: string
  readonly image: string
  readonly command?: readonly string[]
  readonly args?: readonly string[]
  readonly labels?: Readonly<Record<string, string>>
  readonly resources?: JsonObject
  readonly volumes?: readonly JsonObject[]
  readonly volumeMounts?: readonly JsonObject[]
}): JsonObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: { [RUN_LABEL]: input.runId, ...input.labels },
    },
    spec: {
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65532,
        runAsGroup: 65532,
        fsGroup: 65532,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "probe",
          image: input.image,
          imagePullPolicy: "IfNotPresent",
          ...(input.command !== undefined ? { command: [...input.command] } : {}),
          ...(input.args !== undefined ? { args: [...input.args] } : {}),
          ...(input.resources !== undefined ? { resources: input.resources } : {}),
          ...(input.volumeMounts !== undefined ? { volumeMounts: input.volumeMounts } : {}),
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
      ...(input.volumes !== undefined ? { volumes: input.volumes } : {}),
    },
  }
}

function createObjectCommand(
  context: string,
  namespace: string,
  options: { readonly kubeconfig?: string } = {},
): Command {
  return kubectl.command(
    context,
    ["create", "--namespace", namespace, "--filename", "-", "--output", "json"],
    options.kubeconfig === undefined ? {} : { kubeconfig: options.kubeconfig },
  )
}

function rawPodCreateCommand(
  context: string,
  namespace: string,
  kubeconfig: string,
  verbose: boolean,
): Command {
  return kubectl.command(
    context,
    [
      ...(verbose ? ["--v=8"] : []),
      "create",
      "--raw",
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?dryRun=All`,
      "--filename",
      "-",
    ],
    { kubeconfig },
  )
}

async function submitObject(
  execute: ProbeCommandRunner,
  command: Command,
  manifest: JsonObject,
  acceptedExitCodes?: readonly number[],
  sensitiveOutput = false,
): Promise<CommandResult> {
  return execute(command, {
    stdin: JSON.stringify(manifest),
    ...(acceptedExitCodes !== undefined ? { acceptedExitCodes } : {}),
    ...(sensitiveOutput ? { sensitiveOutput: true } : {}),
  })
}

function outputJson(result: CommandResult, name: string): unknown {
  const stdout = result.stdout.toString("utf8")
  try {
    if (stdout.length > 0) return JSON.parse(stdout)
  } catch {}

  const responseBodies = result.stderr
    .toString("utf8")
    .split("\n")
    .flatMap((line) => {
      const marker = "Response Body: "
      const index = line.indexOf(marker)
      if (index === -1) return []
      try {
        return [JSON.parse(line.slice(index + marker.length))]
      } catch {
        return []
      }
    })
    .filter(
      (value): value is JsonObject =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        value.kind === "Status",
    )
  const status = responseBodies.at(-1)
  if (status !== undefined) return status
  throw new Error(`${name} did not return valid Kubernetes Status JSON`)
}

function statusObject(value: unknown): JsonObject {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch (cause) {
      throw new Error("Expected valid Kubernetes Status JSON", { cause })
    }
  }
  const status = expectObject(parsed, "Kubernetes Status")
  if (status.apiVersion !== "v1" || status.kind !== "Status" || status.status !== "Failure") {
    throw new Error("Expected a Kubernetes v1 failure Status object")
  }
  if (status.code !== 403 || status.reason !== "Forbidden") {
    throw new Error("Expected Kubernetes HTTP 403 with reason Forbidden")
  }
  return status
}

function escapeRegularExpression(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function assertQuotaRejection(value: unknown, quotaName: string): void {
  const expectedQuota = expectNonEmpty(quotaName, "ResourceQuota name")
  const status = statusObject(value)
  const message = expectString(status.message, "Kubernetes Status.message")
  const details = expectObject(status.details, "Status.details")
  const exactQuotaDetail = new RegExp(
    `exceeded quota:\\s*${escapeRegularExpression(expectedQuota)}(?:,|\\s|$)`,
    "i",
  )
  if (!exactQuotaDetail.test(message) || details.kind !== "pods") {
    throw new Error(`Expected quota-specific rejection for ${expectedQuota}`)
  }
}

export function assertPodSecurityRejection(value: unknown): void {
  const status = statusObject(value)
  const message = expectString(status.message, "Kubernetes Status.message")
  if (
    !/violates PodSecurity\s+"restricted(?::[^"]*)?"/i.test(message) ||
    !/runAsNonRoot/i.test(message)
  ) {
    throw new Error("Expected restricted Pod Security runAsNonRoot rejection")
  }
}

export function assertRbacRejection(value: unknown, expectation: RbacRejectionExpectation): void {
  const status = statusObject(value)
  const message = expectString(status.message, "Kubernetes Status.message")
  const required = [
    `cannot ${expectNonEmpty(expectation.verb, "RBAC verb")}`,
    `resource "${expectNonEmpty(expectation.resource, "RBAC resource")}"`,
    `API group "${expectation.apiGroup}"`,
    `namespace "${expectNonEmpty(expectation.namespace, "RBAC namespace")}"`,
  ]
  if (
    !/\bis forbidden:\s*User\s+"[^"]+"\s+cannot\s+/i.test(message) ||
    required.some((part) => !message.includes(part)) ||
    /admission|validating(?:admission)?policy|webhook/i.test(message)
  ) {
    throw new Error(`Expected authorization denial: ${required.sort().join(", ")}`)
  }
}

function assertRejectedResult(
  result: CommandResult,
  name: string,
  validate: (value: unknown) => void,
): void {
  if (result.exitCode !== 1) {
    throw new Error(`${name} must exit with the expected kubectl rejection code`)
  }
  validate(outputJson(result, name))
}

async function cleanupByRunLabel(input: {
  readonly execute: ProbeCommandRunner
  readonly context: string
  readonly namespace: string
  readonly runId: string
  readonly resourceTypes: string
}): Promise<void> {
  await input.execute(
    kubectl.command(input.context, [
      "delete",
      input.resourceTypes,
      "--namespace",
      input.namespace,
      "--selector",
      `${RUN_LABEL}=${input.runId}`,
      "--ignore-not-found=true",
      "--wait=true",
      "--output",
      "json",
    ]),
  )
}

async function cleanupByName(input: {
  readonly execute: ProbeCommandRunner
  readonly context: string
  readonly namespace: string
  readonly resourceType: string
  readonly name: string
}): Promise<void> {
  await input.execute(
    kubectl.command(input.context, [
      "delete",
      `${input.resourceType}/${input.name}`,
      "--namespace",
      input.namespace,
      "--ignore-not-found=true",
      "--wait=true",
      "--output",
      "json",
    ]),
  )
}

function createNetworkControlLease(input: {
  readonly execute: ProbeCommandRunner
  readonly context: string
  readonly namespace: string
  readonly runId: string
  readonly serviceName: string
}): NetworkControlLease {
  let cleaned = false
  let inFlight: Promise<void> | undefined
  return Object.freeze({
    url: `http://${input.serviceName}.${input.namespace}.svc.cluster.local:8080/`,
    cleanup(): Promise<void> {
      if (cleaned) return Promise.resolve()
      if (inFlight !== undefined) return inFlight
      inFlight = (async () => {
        try {
          await cleanupByRunLabel({
            execute: input.execute,
            context: input.context,
            namespace: input.namespace,
            runId: input.runId,
            resourceTypes: "pod,service",
          })
          cleaned = true
        } finally {
          inFlight = undefined
        }
      })()
      return inFlight
    },
  })
}

async function withCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result: T
  try {
    result = await operation()
  } catch (primary) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        "Kubernetes probe and exact-label cleanup both failed",
      )
    }
    throw primary
  }
  await cleanup()
  return result
}

export async function runSandboxSecretsEmptyProbe(input: AdministrativeProbeInput): Promise<void> {
  const state = probeState(input)
  const result = await state.execute(
    kubectl.command(state.context, [
      "get",
      "secrets",
      "--namespace",
      state.namespace,
      "--output",
      "json",
    ]),
  )
  let value: unknown
  try {
    value = JSON.parse(result.stdout.toString("utf8"))
  } catch (cause) {
    throw new Error("Sandbox Secret list did not return valid JSON", { cause })
  }
  const list = expectObject(value, "Sandbox Secret list")
  if (!Array.isArray(list.items) || list.items.length !== 0) {
    throw new Error("Sandbox namespace must contain exactly zero Secret objects before token issue")
  }
}

export async function runNetworkControlProbe(
  input: PolicyProbeInput,
): Promise<NetworkControlLease> {
  const state = probeState(input)
  const serverName = resourceName(state.runId, "network-server")
  const serviceName = resourceName(state.runId, "network-service")
  const clientName = resourceName(state.runId, "network-client")
  const componentLabel = "dawn.sh/compat-component"
  const server = restrictedPod({
    name: serverName,
    namespace: state.namespace,
    runId: state.runId,
    image: input.policy.images.sandboxWorkload,
    labels: { [componentLabel]: serverName },
    command: ["node"],
    args: [
      "-e",
      'require("node:http").createServer((_request,response)=>response.end("ready")).listen(8080,"0.0.0.0")',
    ],
  })
  const service: JsonObject = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: serviceName,
      namespace: state.namespace,
      labels: { [RUN_LABEL]: state.runId, [componentLabel]: serviceName },
    },
    spec: {
      selector: { [componentLabel]: serverName },
      ports: [{ name: "http", port: 8080, targetPort: 8080 }],
    },
  }
  const client = restrictedPod({
    name: clientName,
    namespace: state.namespace,
    runId: state.runId,
    image: input.policy.images.sandboxWorkload,
    labels: { [componentLabel]: clientName },
    command: ["node"],
    args: [
      "-e",
      [
        'const http=require("node:http")',
        "let attempts=0",
        `const url=${JSON.stringify(`http://${serviceName}:8080/`)}`,
        "const fail=()=>{if(++attempts>=30)process.exit(1);setTimeout(run,1000)}",
        'const run=()=>http.get(url,(response)=>{response.resume();response.statusCode===200?(console.log("DAWN_NETWORK_CONTROL=reachable"),process.exit(0)):fail()}).on("error",fail)',
        "run()",
      ].join(";"),
    ],
  })

  try {
    await submitObject(state.execute, createObjectCommand(state.context, state.namespace), server)
    await submitObject(state.execute, createObjectCommand(state.context, state.namespace), service)
    await state.execute(
      kubectl.command(state.context, [
        "wait",
        "--namespace",
        state.namespace,
        "--for=condition=Ready",
        `pod/${serverName}`,
        "--timeout=120s",
        "--output",
        "json",
      ]),
    )
    await submitObject(state.execute, createObjectCommand(state.context, state.namespace), client)
    await state.execute(
      kubectl.command(state.context, [
        "wait",
        "--namespace",
        state.namespace,
        "--for=jsonpath={.status.phase}=Succeeded",
        `pod/${clientName}`,
        "--timeout=120s",
        "--output",
        "json",
      ]),
    )
    const observed = await state.execute(
      kubectl.command(state.context, [
        "get",
        `pod/${clientName}`,
        "--namespace",
        state.namespace,
        "--output",
        "json",
      ]),
    )
    const observedPod = expectObject(
      JSON.parse(observed.stdout.toString("utf8")),
      "Network client Pod",
    )
    if (expectObject(observedPod.status, "Network client status").phase !== "Succeeded") {
      throw new Error("Network client Pod did not succeed")
    }
    const logs = await state.execute(
      kubectl.command(state.context, ["logs", `pod/${clientName}`, "--namespace", state.namespace]),
    )
    if (logs.stdout.toString("utf8") !== "DAWN_NETWORK_CONTROL=reachable\n") {
      throw new Error("Network control did not emit the exact reachability marker")
    }
    await cleanupByName({
      execute: state.execute,
      context: state.context,
      namespace: state.namespace,
      resourceType: "pod",
      name: clientName,
    })
    return createNetworkControlLease({
      execute: state.execute,
      context: state.context,
      namespace: state.namespace,
      runId: state.runId,
      serviceName,
    })
  } catch (primary) {
    try {
      await cleanupByRunLabel({
        execute: state.execute,
        context: state.context,
        namespace: state.namespace,
        runId: state.runId,
        resourceTypes: "pod,service",
      })
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        "Network control setup and exact-label cleanup both failed",
      )
    }
    throw primary
  }
}

function admissionPod(input: TokenProbeInput, role: string, resources?: JsonObject): JsonObject {
  const state = probeState(input)
  return restrictedPod({
    name: resourceName(state.runId, role),
    namespace: state.namespace,
    runId: state.runId,
    image: input.policy.images.admissionProbe,
    ...(resources !== undefined ? { resources } : {}),
  })
}

async function runAdmissionPair(input: {
  readonly probe: TokenProbeInput
  readonly positive: JsonObject
  readonly negative: JsonObject
  readonly validate: (value: unknown) => void
  readonly name: string
}): Promise<void> {
  const state = probeState(input.probe)
  const kubeconfig = expectNonEmpty(input.probe.kubeconfig, "Token kubeconfig")
  await withCleanup(
    async () => {
      await submitObject(
        state.execute,
        rawPodCreateCommand(state.context, state.namespace, kubeconfig, false),
        input.positive,
      )
      const rejected = await submitObject(
        state.execute,
        rawPodCreateCommand(state.context, state.namespace, kubeconfig, true),
        input.negative,
        REJECTION_EXIT_CODES,
        true,
      )
      assertRejectedResult(rejected, input.name, input.validate)
    },
    () =>
      cleanupByRunLabel({
        execute: state.execute,
        context: state.context,
        namespace: state.namespace,
        runId: state.runId,
        resourceTypes: "pod",
      }),
  )
}

export async function runResourceQuotaProbe(input: TokenProbeInput): Promise<void> {
  const resources = {
    requests: { cpu: "100m", memory: "32Mi" },
    limits: { cpu: "100m", memory: "32Mi" },
  }
  const positive = admissionPod(input, "quota-admission", resources)
  const negative = structuredClone(positive)
  const container = (expectObject(negative.spec, "Pod spec").containers as JsonObject[])[0]
  if (container === undefined) throw new Error("Quota probe Pod has no container")
  container.resources = {
    requests: { cpu: "9", memory: "32Mi" },
    limits: { cpu: "9", memory: "32Mi" },
  }
  await runAdmissionPair({
    probe: input,
    positive,
    negative,
    name: "ResourceQuota probe",
    validate: (value) => assertQuotaRejection(value, QUOTA_NAME),
  })
}

export async function runRestrictedAdmissionProbe(input: TokenProbeInput): Promise<void> {
  const positive = admissionPod(input, "restricted-admission")
  const negative = structuredClone(positive)
  expectObject(
    expectObject(negative.spec, "Pod spec").securityContext,
    "Pod securityContext",
  ).runAsNonRoot = false
  await runAdmissionPair({
    probe: input,
    positive,
    negative,
    name: "restricted Pod Security probe",
    validate: assertPodSecurityRejection,
  })
}

export async function runLimitRangeProbe(input: TokenProbeInput): Promise<void> {
  const state = probeState(input)
  const kubeconfig = expectNonEmpty(input.kubeconfig, "Token kubeconfig")
  const pod = admissionPod(input, "limit-range")
  const podName = expectString(expectObject(pod.metadata, "Pod metadata").name, "Pod name")
  await withCleanup(
    async () => {
      await submitObject(
        state.execute,
        createObjectCommand(state.context, state.namespace, { kubeconfig }),
        pod,
      )
      const observed = await state.execute(
        kubectl.command(
          state.context,
          ["get", `pod/${podName}`, "--namespace", state.namespace, "--output", "json"],
          { kubeconfig },
        ),
      )
      const observedPod = expectObject(
        JSON.parse(observed.stdout.toString("utf8")),
        "LimitRange admitted Pod",
      )
      const containers = expectObject(observedPod.spec, "Pod spec").containers
      if (!Array.isArray(containers) || containers.length !== 1) {
        throw new Error("LimitRange admitted Pod must contain exactly one container")
      }
      const resources = expectObject(
        expectObject(containers[0], "Pod container").resources,
        "Pod resources",
      )
      const limits = expectObject(resources.limits, "Pod resource limits")
      const requests = expectObject(resources.requests, "Pod resource requests")
      const mismatches = [
        ...Object.entries(DEFAULT_LIMITS.limits).flatMap(([name, expected]) =>
          limits[name] === expected
            ? []
            : [`limits.${name}: expected ${expected}, observed ${String(limits[name])}`],
        ),
        ...Object.entries(DEFAULT_LIMITS.requests).flatMap(([name, expected]) =>
          requests[name] === expected
            ? []
            : [`requests.${name}: expected ${expected}, observed ${String(requests[name])}`],
        ),
      ].sort()
      if (mismatches.length > 0) {
        throw new Error(
          `LimitRange CPU/memory defaults differ:\n${mismatches.map((item) => `- ${item}`).join("\n")}`,
        )
      }
    },
    () =>
      cleanupByRunLabel({
        execute: state.execute,
        context: state.context,
        namespace: state.namespace,
        runId: state.runId,
        resourceTypes: "pod",
      }),
  )
}

async function runRbacDeniedProbe(input: {
  readonly probe: TokenKubeconfigProbeInput
  readonly path: string
  readonly expectation: RbacRejectionExpectation
  readonly body?: JsonObject
  readonly name: string
  readonly cleanup?: {
    readonly namespace: string
    readonly resourceTypes: string
  }
}): Promise<void> {
  const state = probeState(input.probe)
  const kubeconfig = expectNonEmpty(input.probe.kubeconfig, "Token kubeconfig")
  const args =
    input.body === undefined
      ? ["--v=8", "get", "--raw", input.path]
      : ["--v=8", "create", "--raw", input.path, "--filename", "-"]
  const operation = async (): Promise<void> => {
    const result = await state.execute(kubectl.command(state.context, args, { kubeconfig }), {
      ...(input.body !== undefined ? { stdin: JSON.stringify(input.body) } : {}),
      acceptedExitCodes: REJECTION_EXIT_CODES,
      sensitiveOutput: true,
    })
    assertRejectedResult(result, input.name, (value) =>
      assertRbacRejection(value, input.expectation),
    )
  }
  if (input.cleanup === undefined) {
    await operation()
    return
  }
  const cleanup = input.cleanup
  await withCleanup(operation, () =>
    cleanupByRunLabel({
      execute: state.execute,
      context: state.context,
      namespace: cleanup.namespace,
      runId: state.runId,
      resourceTypes: cleanup.resourceTypes,
    }),
  )
}

export async function runSecretReadDeniedProbe(input: TokenKubeconfigProbeInput): Promise<void> {
  const state = probeState(input)
  await runRbacDeniedProbe({
    probe: input,
    path: `/api/v1/namespaces/${encodeURIComponent(state.namespace)}/secrets`,
    name: "Secret read RBAC probe",
    expectation: { verb: "list", resource: "secrets", apiGroup: "", namespace: state.namespace },
  })
}

export async function runRoleMutationDeniedProbe(input: TokenKubeconfigProbeInput): Promise<void> {
  const state = probeState(input)
  const name = resourceName(state.runId, "rbac-role")
  await runRbacDeniedProbe({
    probe: input,
    path: `/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(state.namespace)}/roles`,
    name: "Role mutation RBAC probe",
    expectation: {
      verb: "create",
      resource: "roles",
      apiGroup: "rbac.authorization.k8s.io",
      namespace: state.namespace,
    },
    body: {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: {
        name,
        namespace: state.namespace,
        labels: { [RUN_LABEL]: state.runId },
      },
      rules: [],
    },
    cleanup: { namespace: state.namespace, resourceTypes: "role" },
  })
}

export async function runOutsideNamespaceDeniedProbe(
  input: TokenKubeconfigProbeInput,
): Promise<void> {
  const state = probeState(input)
  const name = resourceName(state.runId, "outside-configmap")
  await runRbacDeniedProbe({
    probe: input,
    path: `/api/v1/namespaces/${encodeURIComponent(state.managementNamespace)}/configmaps`,
    name: "outside-namespace RBAC probe",
    expectation: {
      verb: "create",
      resource: "configmaps",
      apiGroup: "",
      namespace: state.managementNamespace,
    },
    body: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name,
        namespace: state.managementNamespace,
        labels: { [RUN_LABEL]: state.runId },
      },
      data: { probe: "denied" },
    },
    cleanup: { namespace: state.managementNamespace, resourceTypes: "configmap" },
  })
}
