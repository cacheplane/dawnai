import { createHash } from "node:crypto"
import { deriveClusterNames } from "./cluster.js"
import {
  type Command,
  type CommandExecutionOptions,
  type CommandResult,
  executeCommand,
  helm,
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

export const KUBERNETES_COMPAT_PROBE_IDS = Object.freeze([
  ...ADMISSION_RBAC_NETWORK_PROBE_IDS,
  "reaper.lifecycle.before-upgrade",
  "app.service-ready.before-upgrade",
  "upgrade.infrastructure",
  "admission.restricted.after-infra-upgrade",
  "reaper.lifecycle.after-infra-upgrade",
  "upgrade.application",
  "app.service-ready.after-application-upgrade",
] as const)

export type KubernetesCompatProbeId = (typeof KUBERNETES_COMPAT_PROBE_IDS)[number]
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
const COMPONENT_LABEL = "dawn.sh/compat-component"
const QUOTA_NAME = "dawn-sandbox-quota"
const INFRASTRUCTURE_CHART = "charts/dawn-sandbox-infra"
const APPLICATION_CHART = "charts/dawn-app"
const REAPER_CRONJOB = "dawn-reaper"
const REAPER_COMPONENT = "reaper-lifecycle"
const SERVICE_COMPONENT = "app-service-ready"
const INITIAL_REAPER_SCHEDULE = "17 * * * *"
const UPGRADED_REAPER_SCHEDULE = "23 * * * *"
const REAPER_TTL_SECONDS = 168 * 60 * 60
const HELM_TIMEOUT = "5m"
const HELM_OUTER_TIMEOUT_MS = 6 * 60 * 1_000
const KUBECTL_LONG_WAIT_OUTER_TIMEOUT_MS = 150_000
const KUBECTL_DELETE_WAIT_OUTER_TIMEOUT_MS = 60_000
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

function commandJson(result: CommandResult, name: string): unknown {
  try {
    return JSON.parse(result.stdout.toString("utf8"))
  } catch (cause) {
    throw new Error(`${name} did not return valid JSON`, { cause })
  }
}

function objectMetadata(value: JsonObject, name: string): JsonObject {
  return expectObject(value.metadata, `${name}.metadata`)
}

function assertObjectIdentity(
  value: JsonObject,
  input: {
    readonly apiVersion: string
    readonly kind: string
    readonly name: string
    readonly namespace: string
  },
): void {
  const metadata = objectMetadata(value, input.kind)
  if (
    value.apiVersion !== input.apiVersion ||
    value.kind !== input.kind ||
    metadata.name !== input.name ||
    metadata.namespace !== input.namespace
  ) {
    throw new Error(
      `Expected live ${input.apiVersion} ${input.kind} ${input.namespace}/${input.name}`,
    )
  }
}

function digestImageParts(image: string): { readonly repository: string; readonly digest: string } {
  const match = /^(.+)@(sha256:[0-9a-f]{64})$/.exec(image)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error("Application image must be digest-pinned")
  }
  return { repository: match[1], digest: match[2] }
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
  readonly sandboxRelease: string
  readonly appRelease: string
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
    sandboxRelease: names.sandboxRelease,
    appRelease: names.appRelease,
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

function v1StatusCandidate(value: unknown): JsonObject | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as JsonObject).apiVersion !== "v1" ||
    (value as JsonObject).kind !== "Status"
  ) {
    return undefined
  }
  return value as JsonObject
}

function parseJsonCandidate(value: string): JsonObject | undefined {
  try {
    return v1StatusCandidate(JSON.parse(value))
  } catch {
    return undefined
  }
}

function structuredKlogStatus(line: string): JsonObject | undefined {
  const marker = '] "Response Body" body='
  const index = line.indexOf(marker)
  if (index === -1) return undefined

  const encodedBody = line.slice(index + marker.length)
  let decodedBody: unknown
  try {
    decodedBody = JSON.parse(encodedBody)
  } catch {
    return undefined
  }
  if (typeof decodedBody !== "string") return undefined
  return parseJsonCandidate(decodedBody)
}

function legacyKlogStatus(line: string): JsonObject | undefined {
  const marker = "Response Body: "
  const index = line.indexOf(marker)
  return index === -1 ? undefined : parseJsonCandidate(line.slice(index + marker.length))
}

function outputJson(result: CommandResult, name: string): unknown {
  const candidates: JsonObject[] = []
  const stdout = result.stdout.toString("utf8")
  if (stdout.length > 0) {
    const candidate = parseJsonCandidate(stdout)
    if (candidate !== undefined) candidates.push(candidate)
  }

  for (const line of result.stderr.toString("utf8").split("\n")) {
    const candidate = structuredKlogStatus(line) ?? legacyKlogStatus(line)
    if (candidate !== undefined) candidates.push(candidate)
  }
  const status = candidates.at(-1)
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
  readonly component?: string
}): Promise<void> {
  const selector = [
    `${RUN_LABEL}=${input.runId}`,
    ...(input.component !== undefined ? [`${COMPONENT_LABEL}=${input.component}`] : []),
  ].join(",")
  await input.execute(
    kubectl.command(input.context, [
      "delete",
      input.resourceTypes,
      "--namespace",
      input.namespace,
      "--selector",
      selector,
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
      { timeoutMs: KUBECTL_LONG_WAIT_OUTER_TIMEOUT_MS },
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
      { timeoutMs: KUBECTL_LONG_WAIT_OUTER_TIMEOUT_MS },
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
    labels: { [COMPONENT_LABEL]: role },
    ...(resources !== undefined ? { resources } : {}),
  })
}

async function runAdmissionPair(input: {
  readonly probe: TokenProbeInput
  readonly positive: JsonObject
  readonly negative: JsonObject
  readonly validate: (value: unknown) => void
  readonly name: string
  readonly component: string
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
        component: input.component,
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
    component: "quota-admission",
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
    component: "restricted-admission",
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
        component: "limit-range",
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

type ResolvedProbeState = ReturnType<typeof probeState>

async function assertHelmRelease(
  state: ResolvedProbeState,
  release: string,
  revision: number,
): Promise<void> {
  const result = await state.execute(
    helm.command(state.context, [
      "status",
      release,
      "--namespace",
      state.managementNamespace,
      "--output",
      "json",
    ]),
  )
  const status = expectObject(commandJson(result, `Helm release ${release}`), "Helm status")
  const info = expectObject(status.info, "Helm status.info")
  if (
    status.name !== release ||
    status.namespace !== state.managementNamespace ||
    info.status !== "deployed"
  ) {
    throw new Error(
      `Helm release ${state.managementNamespace}/${release} must have live deployed status`,
    )
  }
  if (status.version !== revision) {
    throw new Error(
      `Helm release ${state.managementNamespace}/${release} must be at revision ${revision}`,
    )
  }
}

async function readReaperCronJob(state: ResolvedProbeState): Promise<JsonObject> {
  const result = await state.execute(
    kubectl.command(state.context, [
      "get",
      `cronjob/${REAPER_CRONJOB}`,
      "--namespace",
      state.namespace,
      "--output",
      "json",
    ]),
  )
  const cronJob = expectObject(commandJson(result, "Reaper CronJob"), "Reaper CronJob")
  assertObjectIdentity(cronJob, {
    apiVersion: "batch/v1",
    kind: "CronJob",
    name: REAPER_CRONJOB,
    namespace: state.namespace,
  })
  return cronJob
}

async function assertReaperSchedule(
  state: ResolvedProbeState,
  expectedSchedule: string,
): Promise<void> {
  const cronJob = await readReaperCronJob(state)
  const schedule = expectObject(cronJob.spec, "Reaper CronJob.spec").schedule
  if (schedule !== expectedSchedule) {
    throw new Error(
      `Reaper CronJob schedule must be exactly ${JSON.stringify(expectedSchedule)}; observed ${JSON.stringify(schedule)}`,
    )
  }
}

function infrastructureChartValues(state: ResolvedProbeState): readonly string[] {
  return [
    "--set-string",
    `namespace.name=${state.namespace}`,
    "--set-string",
    `namespace.extraLabels.dawn\\.sh/compat-run=${state.runId}`,
  ]
}

export async function installInfrastructureChart(input: AdministrativeProbeInput): Promise<void> {
  const state = probeState(input)
  await state.execute(
    helm.command(state.context, [
      "install",
      state.sandboxRelease,
      INFRASTRUCTURE_CHART,
      "--namespace",
      state.managementNamespace,
      ...infrastructureChartValues(state),
      "--wait",
      "--timeout",
      HELM_TIMEOUT,
    ]),
    { timeoutMs: HELM_OUTER_TIMEOUT_MS },
  )
  await assertHelmRelease(state, state.sandboxRelease, 1)
  await assertReaperSchedule(state, INITIAL_REAPER_SCHEDULE)
}

export async function upgradeInfrastructureChart(input: AdministrativeProbeInput): Promise<void> {
  const state = probeState(input)
  await state.execute(
    helm.command(state.context, [
      "upgrade",
      state.sandboxRelease,
      INFRASTRUCTURE_CHART,
      "--namespace",
      state.managementNamespace,
      ...infrastructureChartValues(state),
      "--set-string",
      `reaper.schedule=${UPGRADED_REAPER_SCHEDULE}`,
      "--wait",
      "--timeout",
      HELM_TIMEOUT,
    ]),
    { timeoutMs: HELM_OUTER_TIMEOUT_MS },
  )
  await assertHelmRelease(state, state.sandboxRelease, 2)
  await assertReaperSchedule(state, UPGRADED_REAPER_SCHEDULE)
}

function applicationChartValues(
  state: ResolvedProbeState,
  policy: CompatibilityPolicy,
  replicas: number,
): readonly string[] {
  const image = digestImageParts(policy.images.placeholderApp)
  return [
    "--set-string",
    `image.repository=${image.repository}`,
    "--set-string",
    `image.digest=${image.digest}`,
    "--set",
    "containerPort=8080",
    "--set-string",
    "healthPath=/",
    "--set",
    `replicaCount=${replicas}`,
    "--set",
    "serviceAccount.create=true",
    "--set-string",
    `sandboxNamespace=${state.namespace}`,
  ]
}

function exactListItems(
  value: unknown,
  input: {
    readonly apiVersion: string
    readonly kind: string
    readonly name: string
  },
): readonly JsonObject[] {
  const list = expectObject(value, input.name)
  if (list.apiVersion !== input.apiVersion || list.kind !== input.kind) {
    throw new Error(`${input.name} must be a ${input.apiVersion} ${input.kind}`)
  }
  if (!Array.isArray(list.items)) throw new Error(`${input.name}.items must be an array`)
  return list.items.map((item, index) => expectObject(item, `${input.name}.items[${index}]`))
}

async function readApplicationDeployment(state: ResolvedProbeState): Promise<JsonObject> {
  const result = await state.execute(
    kubectl.command(state.context, [
      "get",
      "deployments",
      "--namespace",
      state.managementNamespace,
      "--selector",
      `app.kubernetes.io/instance=${state.appRelease}`,
      "--output",
      "json",
    ]),
  )
  const deployments = exactListItems(commandJson(result, "Application Deployment list"), {
    apiVersion: "apps/v1",
    kind: "DeploymentList",
    name: "Application Deployment list",
  })
  if (deployments.length !== 1) {
    throw new Error("Application Helm release must own exactly one live Deployment")
  }
  const deployment = deployments[0] as JsonObject
  const metadata = objectMetadata(deployment, "Application Deployment")
  const labels = expectObject(metadata.labels, "Application Deployment.metadata.labels")
  if (
    deployment.apiVersion !== "apps/v1" ||
    deployment.kind !== "Deployment" ||
    metadata.namespace !== state.managementNamespace ||
    labels["app.kubernetes.io/instance"] !== state.appRelease
  ) {
    throw new Error("Application Deployment does not belong to the expected Helm release")
  }
  return deployment
}

async function assertApplicationReplicas(
  state: ResolvedProbeState,
  desiredReplicas: number,
  availableReplicas?: number,
): Promise<void> {
  const deployment = await readApplicationDeployment(state)
  const desired = expectObject(deployment.spec, "Application Deployment.spec").replicas
  if (desired !== desiredReplicas) {
    throw new Error(`Application Deployment desired replicas must be exactly ${desiredReplicas}`)
  }
  if (availableReplicas !== undefined) {
    const available = expectObject(
      deployment.status,
      "Application Deployment.status",
    ).availableReplicas
    if (available !== availableReplicas) {
      throw new Error(
        `Application Deployment available replicas must be exactly ${availableReplicas}`,
      )
    }
  }
}

export async function installApplicationChart(input: PolicyProbeInput): Promise<void> {
  const state = probeState(input)
  await state.execute(
    helm.command(state.context, [
      "install",
      state.appRelease,
      APPLICATION_CHART,
      "--namespace",
      state.managementNamespace,
      ...applicationChartValues(state, input.policy, 1),
      "--wait",
      "--timeout",
      HELM_TIMEOUT,
    ]),
    { timeoutMs: HELM_OUTER_TIMEOUT_MS },
  )
  await assertHelmRelease(state, state.appRelease, 1)
  await assertApplicationReplicas(state, 1)
}

export async function upgradeApplicationChart(input: PolicyProbeInput): Promise<void> {
  const state = probeState(input)
  await state.execute(
    helm.command(state.context, [
      "upgrade",
      state.appRelease,
      APPLICATION_CHART,
      "--namespace",
      state.managementNamespace,
      ...applicationChartValues(state, input.policy, 2),
      "--wait",
      "--timeout",
      HELM_TIMEOUT,
    ]),
    { timeoutMs: HELM_OUTER_TIMEOUT_MS },
  )
  await assertHelmRelease(state, state.appRelease, 2)
  await assertApplicationReplicas(state, 2, 2)
}

function reaperFixtureLabels(runId: string): Readonly<Record<string, string>> {
  return {
    [RUN_LABEL]: runId,
    [COMPONENT_LABEL]: REAPER_COMPONENT,
    "app.kubernetes.io/managed-by": "dawn",
  }
}

function reaperPvc(input: {
  readonly name: string
  readonly namespace: string
  readonly runId: string
  readonly marker?: string
}): JsonObject {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: reaperFixtureLabels(input.runId),
      ...(input.marker !== undefined
        ? { annotations: { "dawn.sh/unbound-since": input.marker } }
        : {}),
    },
    spec: {
      storageClassName: "",
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "1Mi" } },
    },
  }
}

function addReaperLabelsToJobTemplate(spec: JsonObject, runId: string): void {
  const template = expectObject(spec.template, "Reaper Job.spec.template")
  const existingMetadata =
    template.metadata === undefined
      ? {}
      : expectObject(template.metadata, "Reaper Job.spec.template.metadata")
  const existingLabels =
    existingMetadata.labels === undefined
      ? {}
      : expectObject(existingMetadata.labels, "Reaper Job.spec.template.metadata.labels")
  template.metadata = {
    ...existingMetadata,
    labels: {
      ...existingLabels,
      [RUN_LABEL]: runId,
      [COMPONENT_LABEL]: REAPER_COMPONENT,
    },
  }
}

function reaperJob(cronJob: JsonObject, state: ResolvedProbeState, name: string): JsonObject {
  const cronSpec = expectObject(cronJob.spec, "Reaper CronJob.spec")
  const jobTemplate = expectObject(cronSpec.jobTemplate, "Reaper CronJob.spec.jobTemplate")
  const spec = structuredClone(expectObject(jobTemplate.spec, "Reaper Job template.spec"))
  addReaperLabelsToJobTemplate(spec, state.runId)
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: state.namespace,
      labels: {
        [RUN_LABEL]: state.runId,
        [COMPONENT_LABEL]: REAPER_COMPONENT,
      },
    },
    spec,
  }
}

function assertCompletedJob(value: unknown, state: ResolvedProbeState, name: string): void {
  const job = expectObject(value, "Reaper Job")
  assertObjectIdentity(job, {
    apiVersion: "batch/v1",
    kind: "Job",
    name,
    namespace: state.namespace,
  })
  const conditions = expectObject(job.status, "Reaper Job.status").conditions
  if (
    !Array.isArray(conditions) ||
    !conditions.some((condition) => {
      const item = expectObject(condition, "Reaper Job condition")
      return item.type === "Complete" && item.status === "True"
    })
  ) {
    throw new Error("Reaper Job must have a live Complete=True condition")
  }
}

function assertReaperPvcOutcomes(
  value: unknown,
  input: {
    readonly state: ResolvedProbeState
    readonly staleName: string
    readonly newName: string
    readonly referencedName: string
  },
): void {
  const claims = exactListItems(value, {
    apiVersion: "v1",
    kind: "PersistentVolumeClaimList",
    name: "Reaper PVC list",
  })
  const byName = new Map<string, JsonObject>()
  for (const claim of claims) {
    if (claim.apiVersion !== "v1" || claim.kind !== "PersistentVolumeClaim") {
      throw new Error("Reaper PVC list contained a non-PersistentVolumeClaim object")
    }
    const metadata = objectMetadata(claim, "Reaper PVC")
    const name = expectString(metadata.name, "Reaper PVC.metadata.name")
    if (metadata.namespace !== input.state.namespace || byName.has(name)) {
      throw new Error("Reaper PVC list contained an unexpected or duplicate object")
    }
    byName.set(name, claim)
  }
  if (byName.has(input.staleName)) throw new Error("Reaper stale PVC must be deleted")
  if (byName.size !== 2 || !byName.has(input.newName) || !byName.has(input.referencedName)) {
    throw new Error("Reaper must retain exactly the new and referenced PVCs")
  }
  const newMetadata = objectMetadata(byName.get(input.newName) as JsonObject, "Reaper new PVC")
  const newAnnotations =
    newMetadata.annotations === undefined
      ? {}
      : expectObject(newMetadata.annotations, "Reaper new PVC.metadata.annotations")
  const marker = newAnnotations["dawn.sh/unbound-since"]
  if (typeof marker !== "string" || !/^[1-9]\d*$/.test(marker)) {
    throw new Error("Reaper new PVC marker must be a positive integer")
  }
  const referencedMetadata = objectMetadata(
    byName.get(input.referencedName) as JsonObject,
    "Reaper referenced PVC",
  )
  const referencedAnnotations =
    referencedMetadata.annotations === undefined
      ? {}
      : expectObject(referencedMetadata.annotations, "Reaper referenced PVC.metadata.annotations")
  if (Object.hasOwn(referencedAnnotations, "dawn.sh/unbound-since")) {
    throw new Error("Reaper referenced PVC must be retained and unmarked")
  }
}

export async function runReaperLifecycleProbe(input: PolicyProbeInput): Promise<void> {
  const state = probeState(input)
  const staleName = resourceName(state.runId, "reaper-stale-pvc")
  const newName = resourceName(state.runId, "reaper-new-pvc")
  const referencedName = resourceName(state.runId, "reaper-referenced-pvc")
  const referencePodName = resourceName(state.runId, "reaper-reference-pod")
  const jobName = resourceName(state.runId, "reaper-job")
  const staleMarker = Math.floor(Date.now() / 1_000) - REAPER_TTL_SECONDS - 1
  if (!Number.isSafeInteger(staleMarker) || staleMarker <= 0) {
    throw new Error("Reaper stale PVC marker must be a positive safe integer")
  }
  const cleanup = (): Promise<void> =>
    cleanupByRunLabel({
      execute: state.execute,
      context: state.context,
      namespace: state.namespace,
      runId: state.runId,
      resourceTypes: "job,pod,persistentvolumeclaim",
      component: REAPER_COMPONENT,
    })

  await cleanup()
  await withCleanup(async () => {
    const fixtures = [
      reaperPvc({
        name: staleName,
        namespace: state.namespace,
        runId: state.runId,
        marker: String(staleMarker),
      }),
      reaperPvc({ name: newName, namespace: state.namespace, runId: state.runId }),
      reaperPvc({
        name: referencedName,
        namespace: state.namespace,
        runId: state.runId,
        marker: String(staleMarker),
      }),
    ]
    for (const fixture of fixtures) {
      await submitObject(
        state.execute,
        createObjectCommand(state.context, state.namespace),
        fixture,
      )
    }
    const referencePod = restrictedPod({
      name: referencePodName,
      namespace: state.namespace,
      runId: state.runId,
      image: input.policy.images.admissionProbe,
      labels: { [COMPONENT_LABEL]: REAPER_COMPONENT },
      volumes: [
        {
          name: "referenced",
          persistentVolumeClaim: { claimName: referencedName },
        },
      ],
      volumeMounts: [{ name: "referenced", mountPath: "/data", readOnly: true }],
    })
    await submitObject(
      state.execute,
      createObjectCommand(state.context, state.namespace),
      referencePod,
    )

    const cronJob = await readReaperCronJob(state)
    await submitObject(
      state.execute,
      createObjectCommand(state.context, state.namespace),
      reaperJob(cronJob, state, jobName),
    )
    await state.execute(
      kubectl.command(state.context, [
        "wait",
        "--namespace",
        state.namespace,
        "--for=condition=Complete",
        `job/${jobName}`,
        "--timeout=120s",
        "--output",
        "json",
      ]),
      { timeoutMs: KUBECTL_LONG_WAIT_OUTER_TIMEOUT_MS },
    )
    const observedJob = await state.execute(
      kubectl.command(state.context, [
        "get",
        `job/${jobName}`,
        "--namespace",
        state.namespace,
        "--output",
        "json",
      ]),
    )
    assertCompletedJob(commandJson(observedJob, "Reaper Job"), state, jobName)
    await state.execute(
      kubectl.command(state.context, [
        "wait",
        "--namespace",
        state.namespace,
        "--for=delete",
        `pvc/${staleName}`,
        "--timeout=30s",
      ]),
      { timeoutMs: KUBECTL_DELETE_WAIT_OUTER_TIMEOUT_MS },
    )

    const observedClaims = await state.execute(
      kubectl.command(state.context, [
        "get",
        "persistentvolumeclaims",
        "--namespace",
        state.namespace,
        "--selector",
        `${RUN_LABEL}=${state.runId},${COMPONENT_LABEL}=${REAPER_COMPONENT}`,
        "--output",
        "json",
      ]),
    )
    assertReaperPvcOutcomes(commandJson(observedClaims, "Reaper PVC list"), {
      state,
      staleName,
      newName,
      referencedName,
    })
  }, cleanup)
}

async function readApplicationService(state: ResolvedProbeState): Promise<{
  readonly name: string
  readonly port: number
}> {
  const result = await state.execute(
    kubectl.command(state.context, [
      "get",
      "services",
      "--namespace",
      state.managementNamespace,
      "--selector",
      `app.kubernetes.io/instance=${state.appRelease}`,
      "--output",
      "json",
    ]),
  )
  const services = exactListItems(commandJson(result, "Application Service list"), {
    apiVersion: "v1",
    kind: "ServiceList",
    name: "Application Service list",
  })
  if (services.length !== 1) {
    throw new Error("Application Helm release must own exactly one live Service")
  }
  const service = services[0] as JsonObject
  const metadata = objectMetadata(service, "Application Service")
  const labels = expectObject(metadata.labels, "Application Service.metadata.labels")
  if (
    service.apiVersion !== "v1" ||
    service.kind !== "Service" ||
    metadata.namespace !== state.managementNamespace ||
    labels["app.kubernetes.io/instance"] !== state.appRelease
  ) {
    throw new Error("Application Service does not belong to the expected Helm release")
  }
  const name = expectString(metadata.name, "Application Service.metadata.name")
  const ports = expectObject(service.spec, "Application Service.spec").ports
  if (!Array.isArray(ports) || ports.length !== 1) {
    throw new Error("Application Service must expose exactly one port")
  }
  const port = expectObject(ports[0], "Application Service port").port
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new Error("Application Service port must be a valid integer")
  }
  return { name, port: port as number }
}

function assertReachabilityPod(value: unknown, state: ResolvedProbeState, name: string): void {
  const pod = expectObject(value, "Application reachability Pod")
  assertObjectIdentity(pod, {
    apiVersion: "v1",
    kind: "Pod",
    name,
    namespace: state.managementNamespace,
  })
  const status = expectObject(pod.status, "Application reachability Pod.status")
  if (status.phase !== "Succeeded") {
    throw new Error("Application reachability Pod must have live phase Succeeded")
  }
  if (!Array.isArray(status.containerStatuses) || status.containerStatuses.length !== 1) {
    throw new Error("Application reachability Pod must have one live container status")
  }
  const containerStatus = expectObject(
    status.containerStatuses[0],
    "Application reachability Pod container status",
  )
  const stateValue = expectObject(
    containerStatus.state,
    "Application reachability Pod container state",
  )
  const terminated = expectObject(
    stateValue.terminated,
    "Application reachability Pod terminated state",
  )
  if (terminated.exitCode !== 0) {
    throw new Error("Application reachability Pod must terminate with exit code 0")
  }
}

export async function runApplicationServiceReadyProbe(input: PolicyProbeInput): Promise<void> {
  const state = probeState(input)
  const podName = resourceName(state.runId, SERVICE_COMPONENT)
  const cleanup = (): Promise<void> =>
    cleanupByRunLabel({
      execute: state.execute,
      context: state.context,
      namespace: state.managementNamespace,
      runId: state.runId,
      resourceTypes: "pod",
      component: SERVICE_COMPONENT,
    })

  await cleanup()
  await withCleanup(async () => {
    const service = await readApplicationService(state)
    const url = `http://${service.name}.${state.managementNamespace}.svc.cluster.local:${service.port}/`
    const pod = restrictedPod({
      name: podName,
      namespace: state.managementNamespace,
      runId: state.runId,
      image: input.policy.images.reachabilityProbe,
      labels: { [COMPONENT_LABEL]: SERVICE_COMPONENT },
      args: [
        "--fail",
        "--silent",
        "--show-error",
        "--retry",
        "30",
        "--retry-connrefused",
        "--retry-delay",
        "1",
        url,
      ],
    })
    await submitObject(
      state.execute,
      createObjectCommand(state.context, state.managementNamespace),
      pod,
    )
    await state.execute(
      kubectl.command(state.context, [
        "wait",
        "--namespace",
        state.managementNamespace,
        "--for=jsonpath={.status.phase}=Succeeded",
        `pod/${podName}`,
        "--timeout=120s",
        "--output",
        "json",
      ]),
      { timeoutMs: KUBECTL_LONG_WAIT_OUTER_TIMEOUT_MS },
    )
    const observed = await state.execute(
      kubectl.command(state.context, [
        "get",
        `pod/${podName}`,
        "--namespace",
        state.managementNamespace,
        "--output",
        "json",
      ]),
    )
    assertReachabilityPod(commandJson(observed, "Application reachability Pod"), state, podName)
  }, cleanup)
}
