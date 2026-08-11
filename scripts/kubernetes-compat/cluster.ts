import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { stringify } from "yaml"

import {
  type Command,
  type CommandExecutionOptions,
  type CommandResult,
  executeCommand,
  helm,
  kubectl,
} from "./command.js"

export type ClusterCommandRunner = (
  command: Command,
  options?: CommandExecutionOptions,
) => Promise<CommandResult>

export interface ClusterNames {
  readonly runName: string
  readonly managementNamespace: string
  readonly sandboxNamespace: string
  readonly sandboxRelease: string
  readonly appRelease: string
}

export interface AdministrativeAccess {
  readonly server: string
  readonly certificateAuthorityData: string
}

export interface ClusterPreflightInput {
  readonly context: string
  readonly targetMinor: string
  readonly runId: string
  readonly storageClass?: string
}

export interface ClusterPreflightResult {
  readonly context: string
  readonly observedServer: string
  readonly storageClass: string
  readonly names: ClusterNames
  readonly access: AdministrativeAccess
}

export interface ClusterPreflightDependencies {
  readonly execute?: ClusterCommandRunner
  readonly executableExists?: (name: string) => Promise<boolean>
}

export interface TokenRequestInput {
  readonly context: string
  readonly namespace: string
  readonly serviceAccount: string
}

export interface SecureTokenKubeconfigInput {
  readonly context: string
  readonly access: AdministrativeAccess
  readonly token: string
}

export interface SecureTokenKubeconfig {
  readonly directory: string
  readonly path: string
  destroy(): Promise<void>
}

export interface NamespaceOwnership {
  readonly name: string
  readonly uid: string
  readonly runId: string
}

export type InstalledReleaseRole = "infrastructure" | "application"

export interface OwnedClusterCleanupInput {
  readonly context: string
  readonly runId: string
  readonly ownership: readonly NamespaceOwnership[]
  readonly installedReleases: readonly InstalledReleaseRole[]
  readonly removeTokenFiles: () => Promise<void>
  readonly keepOnFailure?: boolean
}

export interface SignalEmitter {
  on(event: NodeJS.Signals, listener: () => void): unknown
  off(event: NodeJS.Signals, listener: () => void): unknown
}

interface JsonObject {
  readonly [key: string]: unknown
}

const REQUIRED_EXECUTABLES = ["kubectl", "helm", "pnpm"] as const
const DEFAULT_STORAGE_ANNOTATION = "storageclass.kubernetes.io/is-default-class"
const RUN_LABEL = "dawn.sh/compat-run"
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const
const RELEASE_ROLES = ["infrastructure", "application"] as const
const TARGET_MINOR_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function expectNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

function expectObject(value: unknown, name: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as JsonObject
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function parseJson(result: CommandResult, name: string): unknown {
  try {
    return JSON.parse(result.stdout.toString("utf8"))
  } catch (cause) {
    throw new Error(`${name} returned invalid JSON`, { cause })
  }
}

async function defaultExecutableExists(name: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, name), constants.X_OK)
      return true
    } catch {}
  }
  return false
}

export async function validateRequiredExecutables(
  executableExists: (name: string) => Promise<boolean> = defaultExecutableExists,
): Promise<void> {
  const settled = await Promise.all(
    REQUIRED_EXECUTABLES.map(async (name) => ({ name, exists: await executableExists(name) })),
  )
  const missing = settled.filter((entry) => !entry.exists).map((entry) => entry.name)
  if (missing.length > 0) {
    throw new Error(`Missing required executable(s): ${missing.sort().join(", ")}`)
  }
}

function hashSuffix(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 8)
}

function dnsComponent(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
}

function boundedName(base: string, suffix: string): string {
  const maximumBase = 63 - suffix.length - 1
  const bounded = base.slice(0, maximumBase).replaceAll(/-+$/g, "")
  return `${bounded}-${suffix}`
}

export function deriveClusterNames(runId: string): ClusterNames {
  const rawRunId = expectNonEmpty(runId, "Compatibility run ID")
  const slug = dnsComponent(rawRunId)
  if (slug.length === 0) throw new Error("Compatibility run ID must contain a letter or number")
  const hash = hashSuffix(rawRunId)
  const base = `dawn-${slug}`
  const name = (role: string): string => boundedName(base, `${role}-${hash}`)
  return Object.freeze({
    runName: boundedName(base, hash),
    managementNamespace: name("management"),
    sandboxNamespace: name("sandbox"),
    sandboxRelease: name("infra"),
    appRelease: name("app"),
  })
}

interface StorageClassList {
  readonly items?: readonly unknown[]
}

function metadata(value: unknown, name: string): JsonObject {
  return expectObject(expectObject(value, name).metadata, `${name}.metadata`)
}

export function selectStorageClass(value: unknown, override?: string): string {
  const list = expectObject(value, "StorageClass list") as StorageClassList
  if (!Array.isArray(list.items)) throw new Error("StorageClass list.items must be an array")
  const classes = list.items.map((item, index) => {
    const itemMetadata = metadata(item, `StorageClass list.items[${index}]`)
    const name = expectString(itemMetadata.name, `StorageClass list.items[${index}].metadata.name`)
    const annotations =
      itemMetadata.annotations === undefined
        ? {}
        : expectObject(
            itemMetadata.annotations,
            `StorageClass list.items[${index}].metadata.annotations`,
          )
    return { name, isDefault: annotations[DEFAULT_STORAGE_ANNOTATION] === "true" }
  })
  if (override !== undefined) {
    const requested = expectNonEmpty(override, "StorageClass override")
    if (!classes.some((entry) => entry.name === requested)) {
      throw new Error(`Requested StorageClass is missing: ${requested}`)
    }
    return requested
  }
  const defaults = classes
    .filter((entry) => entry.isDefault)
    .map((entry) => entry.name)
    .sort()
  if (defaults.length !== 1) {
    throw new Error(
      defaults.length === 0
        ? "No annotated default StorageClass exists"
        : `Multiple annotated default StorageClasses exist: ${defaults.join(", ")}`,
    )
  }
  return defaults[0] as string
}

export function assertNamespacesAbsent(value: unknown, names: ClusterNames): void {
  const list = expectObject(value, "Namespace list") as { readonly items?: readonly unknown[] }
  if (!Array.isArray(list.items)) throw new Error("Namespace list.items must be an array")
  const existing = new Set(
    list.items.map((item, index) =>
      expectString(metadata(item, `Namespace list.items[${index}]`).name, "Namespace name"),
    ),
  )
  for (const name of [names.managementNamespace, names.sandboxNamespace]) {
    if (existing.has(name)) throw new Error(`Generated Namespace already exists: ${name}`)
  }
}

export function captureAdministrativeAccess(value: unknown): AdministrativeAccess {
  const config = expectObject(value, "minified kubeconfig") as {
    readonly clusters?: readonly unknown[]
  }
  if (!Array.isArray(config.clusters) || config.clusters.length !== 1) {
    throw new Error("Minified kubeconfig must contain exactly one cluster")
  }
  const entry = expectObject(config.clusters[0], "minified kubeconfig cluster")
  const cluster = expectObject(entry.cluster, "minified kubeconfig cluster data")
  return Object.freeze({
    server: expectString(cluster.server, "Kubernetes API server"),
    certificateAuthorityData: expectString(
      cluster["certificate-authority-data"],
      "Kubernetes certificate authority data",
    ),
  })
}

function parseServerVersion(value: unknown, targetMinor: string): string {
  const targetMatch = TARGET_MINOR_PATTERN.exec(targetMinor)
  if (targetMatch === null) throw new Error("Target minor must use major.minor format")
  const root = expectObject(value, "kubectl version response")
  const server = expectObject(root.serverVersion, "kubectl version serverVersion")
  const major = expectString(server.major, "Kubernetes server major")
  const minor = expectString(server.minor, "Kubernetes server minor").replaceAll(/\D+$/g, "")
  const observedMinor = `${major}.${minor}`
  if (observedMinor !== targetMinor) {
    throw new Error(`Kubernetes server ${observedMinor} does not match target ${targetMinor}`)
  }
  return expectString(server.gitVersion, "Kubernetes server gitVersion")
}

export async function preflightCluster(
  input: ClusterPreflightInput,
  dependencies: ClusterPreflightDependencies = {},
): Promise<ClusterPreflightResult> {
  const context = expectNonEmpty(input.context, "Kubernetes context")
  const execute = dependencies.execute ?? executeCommand
  await validateRequiredExecutables(dependencies.executableExists ?? defaultExecutableExists)

  const current = (
    await execute(kubectl.currentContextCommand(), { stdoutLimitBytes: 16 * 1_024 })
  ).stdout
    .toString("utf8")
    .trim()
  if (current !== context) {
    throw new Error(
      `Current context ${current || "<empty>"} does not match supplied context ${context}`,
    )
  }

  const observedServer = parseServerVersion(
    parseJson(
      await execute(kubectl.command(context, ["version", "-o", "json"])),
      "kubectl version",
    ),
    input.targetMinor,
  )
  const storageClass = selectStorageClass(
    parseJson(
      await execute(kubectl.command(context, ["get", "storageclasses", "-o", "json"])),
      "StorageClass list",
    ),
    input.storageClass,
  )
  const names = deriveClusterNames(input.runId)
  assertNamespacesAbsent(
    parseJson(
      await execute(kubectl.command(context, ["get", "namespaces", "-o", "json"])),
      "Namespace list",
    ),
    names,
  )
  const accessData = parseJson(
    await execute(kubectl.command(context, ["config", "view", "--raw", "--minify", "-o", "json"]), {
      sensitiveOutput: true,
    }),
    "minified kubeconfig",
  )
  const capturedAccess = captureAdministrativeAccess(accessData)
  return Object.freeze({ context, observedServer, storageClass, names, access: capturedAccess })
}

export async function requestServiceAccountToken(
  input: TokenRequestInput,
  execute: ClusterCommandRunner = executeCommand,
): Promise<string> {
  const context = expectNonEmpty(input.context, "Kubernetes context")
  const namespace = expectNonEmpty(input.namespace, "ServiceAccount namespace")
  const serviceAccount = expectNonEmpty(input.serviceAccount, "ServiceAccount name")
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/serviceaccounts/${encodeURIComponent(
    serviceAccount,
  )}/token`
  const body = JSON.stringify({
    apiVersion: "authentication.k8s.io/v1",
    kind: "TokenRequest",
    spec: { expirationSeconds: 900 },
  })
  const response = parseJson(
    await execute(kubectl.command(context, ["create", "--raw", path, "-f", "-"]), {
      stdin: body,
      sensitiveOutput: true,
    }),
    "ServiceAccount TokenRequest",
  )
  return expectString(
    expectObject(response, "ServiceAccount TokenRequest response").status === undefined
      ? undefined
      : expectObject(
          expectObject(response, "ServiceAccount TokenRequest response").status,
          "ServiceAccount TokenRequest status",
        ).token,
    "ServiceAccount token",
  )
}

export async function createSecureTokenKubeconfig(
  input: SecureTokenKubeconfigInput,
): Promise<SecureTokenKubeconfig> {
  const context = expectNonEmpty(input.context, "Kubernetes context")
  const token = expectNonEmpty(input.token, "ServiceAccount token")
  const directory = await mkdtemp(join(tmpdir(), "dawn-kubernetes-compat-"))
  await chmod(directory, 0o700)
  const path = join(directory, "kubeconfig.yaml")
  const config = {
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: "cluster",
        cluster: {
          server: input.access.server,
          "certificate-authority-data": input.access.certificateAuthorityData,
        },
      },
    ],
    users: [{ name: "orchestrator", user: { token } }],
    contexts: [
      {
        name: context,
        context: { cluster: "cluster", user: "orchestrator" },
      },
    ],
    "current-context": context,
  }
  try {
    await writeFile(path, stringify(config), { encoding: "utf8", flag: "wx", mode: 0o600 })
    await chmod(path, 0o600)
  } catch (cause) {
    await rm(directory, { recursive: true, force: true })
    throw cause
  }
  let destroyed = false
  return Object.freeze({
    directory,
    path,
    async destroy(): Promise<void> {
      if (destroyed) return
      destroyed = true
      await rm(directory, { recursive: true, force: true })
    },
  })
}

export function captureNamespaceOwnership(value: unknown, runId: string): NamespaceOwnership {
  const expectedRunId = expectNonEmpty(runId, "Compatibility run ID")
  const namespaceMetadata = metadata(value, "Namespace")
  const labels = expectObject(namespaceMetadata.labels, "Namespace metadata.labels")
  if (labels[RUN_LABEL] !== expectedRunId) {
    throw new Error(`Namespace is missing exact ${RUN_LABEL}=${expectedRunId} ownership label`)
  }
  return Object.freeze({
    name: expectString(namespaceMetadata.name, "Namespace name"),
    uid: expectString(namespaceMetadata.uid, "Namespace UID"),
    runId: expectedRunId,
  })
}

export function verifyNamespaceOwnership(value: unknown, expected: NamespaceOwnership): void {
  const namespaceMetadata = metadata(value, `Namespace ${expected.name}`)
  const name = expectString(namespaceMetadata.name, "Namespace name")
  const uid = expectString(namespaceMetadata.uid, "Namespace UID")
  const labels = expectObject(namespaceMetadata.labels, "Namespace metadata.labels")
  if (name !== expected.name)
    throw new Error(`Namespace name changed from ${expected.name} to ${name}`)
  if (uid !== expected.uid) throw new Error(`Namespace ${expected.name} UID changed`)
  if (labels[RUN_LABEL] !== expected.runId) {
    throw new Error(
      `Namespace ${expected.name} is missing exact ${RUN_LABEL}=${expected.runId} label`,
    )
  }
}

interface ResolvedClusterCleanup {
  readonly ownership: readonly NamespaceOwnership[]
  readonly releases: readonly {
    readonly name: string
    readonly namespace: string
  }[]
}

function isInstalledReleaseRole(value: unknown): value is InstalledReleaseRole {
  return value === "infrastructure" || value === "application"
}

function resolveClusterCleanup(input: OwnedClusterCleanupInput): ResolvedClusterCleanup {
  const runId = expectNonEmpty(input.runId, "Compatibility run ID")
  const names = deriveClusterNames(runId)
  const derivedNamespaceNames = new Set([names.managementNamespace, names.sandboxNamespace])
  const ownershipByName = new Map<string, NamespaceOwnership>()

  for (const ownership of input.ownership) {
    if (ownership.runId !== runId) {
      throw new Error(
        `Namespace ownership run ID ${ownership.runId} does not match cleanup run ID ${runId}`,
      )
    }
    if (!derivedNamespaceNames.has(ownership.name)) {
      throw new Error(`Namespace ownership target is not a derived namespace: ${ownership.name}`)
    }
    if (ownershipByName.has(ownership.name)) {
      throw new Error(`Duplicate Namespace ownership target: ${ownership.name}`)
    }
    ownershipByName.set(ownership.name, ownership)
  }

  const installedRoles = new Set<InstalledReleaseRole>()
  for (const role of input.installedReleases as readonly unknown[]) {
    if (!isInstalledReleaseRole(role)) {
      throw new Error(`Unknown installed release role: ${String(role)}`)
    }
    if (installedRoles.has(role)) {
      throw new Error(`Duplicate installed release role: ${role}`)
    }
    installedRoles.add(role)
  }

  if (
    installedRoles.size > 0 &&
    (!ownershipByName.has(names.managementNamespace) ||
      !ownershipByName.has(names.sandboxNamespace))
  ) {
    throw new Error(
      "Cleanup of an installed release requires captured ownership for both derived namespaces",
    )
  }

  const ownership = [names.managementNamespace, names.sandboxNamespace].flatMap((name) => {
    const entry = ownershipByName.get(name)
    return entry === undefined ? [] : [entry]
  })
  const releases = RELEASE_ROLES.filter((role) => installedRoles.has(role)).map((role) => ({
    name: role === "infrastructure" ? names.sandboxRelease : names.appRelease,
    namespace: names.managementNamespace,
  }))
  return { ownership, releases }
}

export async function cleanupOwnedCluster(
  input: OwnedClusterCleanupInput,
  execute: ClusterCommandRunner = executeCommand,
): Promise<{ readonly retained: boolean }> {
  await input.removeTokenFiles()
  const cleanup = resolveClusterCleanup(input)
  if (cleanup.ownership.length === 0) return { retained: false }

  const liveNamespaces = await Promise.all(
    cleanup.ownership.map(async (ownership) => ({
      ownership,
      value: parseJson(
        await execute(
          kubectl.command(input.context, ["get", "namespace", ownership.name, "-o", "json"]),
        ),
        `Namespace ${ownership.name}`,
      ),
    })),
  )
  for (const entry of liveNamespaces) verifyNamespaceOwnership(entry.value, entry.ownership)
  if (input.keepOnFailure === true) return { retained: true }

  for (const release of cleanup.releases) {
    await execute(
      helm.command(input.context, ["uninstall", release.name, "--namespace", release.namespace]),
    )
  }
  const survivingOwnership = (
    await Promise.all(
      cleanup.ownership.map(async (ownership) => {
        const result = await execute(
          kubectl.command(input.context, [
            "get",
            "namespace",
            ownership.name,
            "-o",
            "json",
            "--ignore-not-found",
          ]),
        )
        if (result.stdout.toString("utf8").trim().length === 0) return undefined
        const value = parseJson(result, `Namespace ${ownership.name}`)
        verifyNamespaceOwnership(value, ownership)
        return ownership
      }),
    )
  ).filter((ownership) => ownership !== undefined)
  for (const ownership of survivingOwnership) {
    await execute(kubectl.command(input.context, ["delete", "namespace", ownership.name]))
  }
  return { retained: false }
}

export function registerOwnedResourceSignalCleanup(
  ownership: readonly [NamespaceOwnership, ...NamespaceOwnership[]],
  cleanup: () => Promise<void>,
  emitter: SignalEmitter = process,
): () => void {
  if (ownership.length === 0) {
    throw new Error("Signal cleanup requires at least one owned resource")
  }
  let started = false
  const onSignal = (): void => {
    if (started) return
    started = true
    void cleanup().catch(() => undefined)
  }
  for (const signal of SIGNALS) emitter.on(signal, onSignal)
  return () => {
    for (const signal of SIGNALS) emitter.off(signal, onSignal)
  }
}
