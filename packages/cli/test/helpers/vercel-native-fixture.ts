import { randomBytes } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"

export const REQUIRED_VERCEL_ENV = [
  "DAWN_VERCEL_TOKEN",
  "DAWN_VERCEL_ORG_ID",
  "DAWN_VERCEL_PROJECT_ID",
  "DAWN_VERCEL_DATABASE_URL",
] as const

export interface NativeLaneEnvironment {
  readonly artifactDir: string
  readonly databaseUrl: string
  readonly orgId: string
  readonly projectId: string
  readonly token: string
}

export function nativeLaneEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  if (value === "1") return true
  throw new Error('DAWN_TEST_VERCEL must be exactly "1" when present')
}

export function readNativeLaneEnvironment(
  env: NodeJS.ProcessEnv,
  nodeVersion = process.versions.node,
): NativeLaneEnvironment {
  const failures: string[] = []
  if (nodeVersion.split(".", 1)[0] !== "24") failures.push(`Node 24 (received ${nodeVersion})`)

  const artifactDir = env.DAWN_VERCEL_ARTIFACT_DIR
  if (!artifactDir) failures.push("DAWN_VERCEL_ARTIFACT_DIR")
  else if (!isAbsolute(artifactDir)) failures.push("DAWN_VERCEL_ARTIFACT_DIR (absolute path)")

  for (const name of REQUIRED_VERCEL_ENV) {
    if (!env[name]) failures.push(name)
  }
  if (env.DAWN_VERCEL_ORG_ID && !/^team_[A-Za-z0-9]+$/.test(env.DAWN_VERCEL_ORG_ID)) {
    failures.push("DAWN_VERCEL_ORG_ID (team_* identifier)")
  }
  if (env.DAWN_VERCEL_PROJECT_ID && !/^prj_[A-Za-z0-9]+$/.test(env.DAWN_VERCEL_PROJECT_ID)) {
    failures.push("DAWN_VERCEL_PROJECT_ID (prj_* identifier)")
  }
  if (failures.length > 0) {
    throw new Error(`native Vercel lane input validation failed: ${failures.join(", ")}`)
  }

  return {
    artifactDir: artifactDir as string,
    databaseUrl: env.DAWN_VERCEL_DATABASE_URL as string,
    orgId: env.DAWN_VERCEL_ORG_ID as string,
    projectId: env.DAWN_VERCEL_PROJECT_ID as string,
    token: env.DAWN_VERCEL_TOKEN as string,
  }
}

function assertGrammar(name: string, value: string, grammar: RegExp): string {
  if (!grammar.test(value)) throw new Error(`${name} does not match ${grammar.source}`)
  return value
}

export function assertDeploymentId(value: string): string {
  return assertGrammar("deployment ID", value, /^dpl_[A-Za-z0-9]+$/)
}

export function assertReconciliationMarker(value: string): string {
  return assertGrammar("reconciliation marker", value, /^vclrun_[a-f0-9]{32}$/)
}

export function assertThreadId(value: string): string {
  return assertGrammar("thread ID", value, /^t-vcl-[a-f0-9]{32}$/)
}

export function assertBarrierId(value: string): string {
  return assertGrammar("barrier ID", value, /^b-vcl-[a-f0-9]{32}$/)
}

export function assertLogMarker(value: string): string {
  return assertGrammar("log marker", value, /^log-vcl-[a-f0-9]{32}$/)
}

const VERCEL_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+vercel\.app$/

export function canonicalizeVercelOrigin(value: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error("Vercel deployment origin must be a nonempty value without whitespace")
  }
  const bareHostname = /^[A-Za-z0-9.-]+$/.test(value) ? value : undefined
  const absoluteMatch = /^https:\/\/([A-Za-z0-9.-]+)\/?$/.exec(value)
  const hostnameInput = bareHostname ?? absoluteMatch?.[1]
  if (
    !hostnameInput ||
    hostnameInput.length > 253 ||
    !VERCEL_HOSTNAME.test(hostnameInput.toLowerCase())
  ) {
    throw new Error(
      "Vercel deployment origin must be a bare hostname or an exact root HTTPS URL on *.vercel.app",
    )
  }

  let parsed: URL
  try {
    parsed = new URL(absoluteMatch ? value : `https://${value}`)
  } catch (error) {
    throw new Error("Vercel deployment origin is malformed", { cause: error })
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Vercel deployment origin must be an HTTPS root origin")
  }
  const hostname = parsed.hostname.toLowerCase()
  if (!VERCEL_HOSTNAME.test(hostname)) {
    throw new Error("Vercel deployment origin must use a valid *.vercel.app hostname")
  }
  return `https://${hostname}`
}

export interface SecretRedactor {
  readonly assertSafe: (label: string, value: unknown) => void
  readonly redact: (value: string) => string
  readonly redactValue: (value: unknown) => unknown
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function projectError(value: Error): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.entries(value)),
    name: value.name,
    message: value.message,
    ...(value.stack ? { stack: value.stack } : {}),
    ...(value.cause !== undefined ? { cause: value.cause } : {}),
    ...(value instanceof AggregateError ? { errors: value.errors } : {}),
  }
}

function mapStrings(
  value: unknown,
  transform: (value: string) => string,
  active = new WeakSet<object>(),
  jsonKey = "",
): unknown {
  if (typeof value === "string") return transform(value)
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    if (active.has(value)) throw new Error("evidence contains a reference cycle")
    active.add(value)
    try {
      const toJSON = (value as { readonly toJSON?: unknown }).toJSON
      if (typeof toJSON === "function") {
        return mapStrings(toJSON.call(value, jsonKey), transform, active, jsonKey)
      }
      if (value instanceof Error) return mapStrings(projectError(value), transform, active, jsonKey)
      if (Array.isArray(value)) {
        return value.map((entry, index) => mapStrings(entry, transform, active, String(index)))
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          transform(key),
          mapStrings(entry, transform, active, key),
        ]),
      )
    } finally {
      active.delete(value)
    }
  }
  return value
}

function collectRawJsonStrings(
  value: unknown,
  strings: string[] = [],
  active = new WeakSet<object>(),
  jsonKey = "",
): string[] {
  if (typeof value === "string") {
    strings.push(value)
    return strings
  }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return strings
  if (active.has(value)) throw new Error("evidence contains a reference cycle")
  active.add(value)
  try {
    const toJSON = (value as { readonly toJSON?: unknown }).toJSON
    if (typeof toJSON === "function") {
      collectRawJsonStrings(toJSON.call(value, jsonKey), strings, active, jsonKey)
    }
    if (value instanceof Error) {
      collectRawJsonStrings(projectError(value), strings, active, jsonKey)
      return strings
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        collectRawJsonStrings(entry, strings, active, String(index))
      }
      return strings
    }
    for (const [key, entry] of Object.entries(value)) {
      strings.push(key)
      collectRawJsonStrings(entry, strings, active, key)
    }
    return strings
  } finally {
    active.delete(value)
  }
}

function secretScanSurfaces(value: unknown): readonly string[] {
  if (typeof value === "string") return [value]
  try {
    const rawStrings = collectRawJsonStrings(value)
    const projectedJson = JSON.stringify(mapStrings(value, (entry) => entry))
    return projectedJson === undefined ? rawStrings : [...rawStrings, projectedJson]
  } catch (error) {
    void error
    throw new Error("evidence could not be traversed for protected-value scanning")
  }
}

function assertPlainJsonValue(value: unknown, path = "$", active = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`)
    return
  }
  if (typeof value !== "object") {
    throw new Error(`${path} must contain only plain JSON values`)
  }
  if (active.has(value)) throw new Error(`${path} contains a JSON reference cycle`)
  active.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`${path} must contain only plain JSON arrays`)
      }
      const enumerableKeys = Object.keys(value)
      if (
        enumerableKeys.length !== value.length ||
        enumerableKeys.some((key, index) => key !== String(index))
      ) {
        throw new Error(`${path} must not contain sparse arrays or extra array properties`)
      }
      const allowedKeys = new Set<PropertyKey>([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ])
      if (Reflect.ownKeys(value).some((key) => !allowedKeys.has(key))) {
        throw new Error(`${path} must not contain hidden array properties`)
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error(`${path}[${index}] must be an enumerable JSON data property`)
        }
        assertPlainJsonValue(descriptor.value, `${path}[${index}]`, active)
      }
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error(`${path} must not contain symbol keys`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`${path} must contain only enumerable JSON data properties`)
      }
      assertPlainJsonValue(descriptor.value, `${path} property`, active)
    }
  } finally {
    active.delete(value)
  }
}

function cloneOwnJsonData(value: unknown, path = "$", active = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") return value
  if (active.has(value)) throw new Error(`${path} contains a reference cycle`)
  active.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`${path} must contain only plain arrays`)
      }
      const allowedKeys = new Set<PropertyKey>([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ])
      if (Reflect.ownKeys(value).some((key) => !allowedKeys.has(key))) {
        throw new Error(`${path} must not contain sparse or extra array properties`)
      }
      const clone: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error(`${path}[${index}] must be an enumerable data property`)
        }
        clone.push(cloneOwnJsonData(descriptor.value, `${path}[${index}]`, active))
      }
      return clone
    }
    const clone: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) {
        throw new Error(`${path} must contain only data properties`)
      }
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneOwnJsonData(descriptor.value, `${path} property`, active),
        writable: true,
      })
    }
    return clone
  } finally {
    active.delete(value)
  }
}

export function createSecretRedactor(protectedValues: readonly string[]): SecretRedactor {
  if (protectedValues.some((value) => value.length === 0)) {
    throw new Error("protected values must be nonempty")
  }
  const variants = [
    ...new Set(protectedValues.flatMap((value) => [value, encodeURIComponent(value)])),
  ].sort((left, right) => right.length - left.length)
  const matchers = variants.map((value) => ({
    raw: value,
    matcher: new RegExp(escapeRegExp(value), value.includes("%") ? "gi" : "g"),
  }))
  const redact = (value: string): string => {
    let result = value
    for (const { matcher } of matchers) result = result.replace(matcher, "[REDACTED]")
    return result
  }
  return {
    assertSafe: (label, value) => {
      const surfaces = secretScanSurfaces(value)
      const leaked = matchers.find(({ raw, matcher }) => {
        const matched = surfaces.some((surface) => {
          matcher.lastIndex = 0
          const found = matcher.test(surface)
          matcher.lastIndex = 0
          return found
        })
        return matched && raw.length > 0
      })
      if (leaked) throw new Error(`${label} contains a protected value`)
    },
    redact,
    redactValue: (value) => {
      try {
        return mapStrings(value, redact)
      } catch (error) {
        void error
        throw new Error("evidence could not be redacted safely")
      }
    },
  }
}

export function sanitizeChildEnvironment(
  inherited: NodeJS.ProcessEnv,
  allowedAdditions: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue
    if (
      name.startsWith("DAWN_VERCEL_") ||
      name.startsWith("VERCEL_") ||
      name.startsWith("NOW_") ||
      name === "DATABASE_URL" ||
      name.toUpperCase().includes("RELEASE")
    ) {
      continue
    }
    sanitized[name] = value
  }
  for (const [name, value] of Object.entries(allowedAdditions)) sanitized[name] = value
  return sanitized
}

export interface AtomicJsonFileOps {
  readonly randomSuffix: () => string
  readonly remove: (path: string) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly writeFile: (path: string, contents: string) => Promise<void>
}

const DEFAULT_ATOMIC_JSON_FILE_OPS: AtomicJsonFileOps = {
  randomSuffix: () => randomBytes(8).toString("hex"),
  remove: async (path) => rm(path, { force: true }),
  rename,
  writeFile: async (path, contents) =>
    writeFile(path, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
}

export async function writeAtomicJson(
  path: string,
  value: unknown,
  fileOps: AtomicJsonFileOps = DEFAULT_ATOMIC_JSON_FILE_OPS,
): Promise<void> {
  assertPlainJsonValue(value)
  const encoded = JSON.stringify(value, null, 2)
  if (encoded === undefined) throw new Error("atomic JSON value is not JSON-serializable")
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${fileOps.randomSuffix()}.tmp`,
  )
  try {
    await fileOps.writeFile(tempPath, `${encoded}\n`)
    await fileOps.rename(tempPath, path)
  } catch (error) {
    await fileOps.remove(tempPath).catch(() => undefined)
    throw error
  }
}

export interface VercelNativeReceiptV1 {
  readonly schemaVersion: 1
  readonly cliVersion: "58.9.0"
  readonly projectBindingVerified: true
  readonly kinds: readonly ["source", "prebuilt"]
  readonly deployments: readonly [
    VercelDeploymentReceiptV1<"source">,
    VercelDeploymentReceiptV1<"prebuilt">,
  ]
}

export interface VercelDeploymentReceiptV1<Kind extends "source" | "prebuilt"> {
  readonly kind: Kind
  readonly deploymentId: string
  readonly canonicalOrigin: string
  readonly apiBindingVerified: true
  readonly config: { readonly fluid: true; readonly sha256: string }
  readonly readyState: "READY"
  readonly routes: {
    readonly unknownRoute404: true
    readonly state: true
    readonly stream: true
    readonly release: true
  }
  readonly state: {
    readonly visits: readonly [1, 2]
    readonly markersInOrder: true
    readonly generatedReadMatched: true
    readonly physicalCheckpoint: true
  }
  readonly middleware: {
    readonly missingHeader401: true
    readonly wrongHeader401: true
    readonly selectiveRelease: true
    readonly sentinelUnreleased: true
  }
  readonly stream: {
    readonly status: 200
    readonly contentType: "text/event-stream"
    readonly noRedirect: true
    readonly beforeFrameIndex: number
    readonly preReleaseQuietMs: 1000
    readonly authorizedReleaseAfterBeforeFrame: true
    readonly afterFrameIndex: number
    readonly doneFrameIndex: number
    readonly eofAfterDone: true
  }
  readonly laterRequest: { readonly succeeded: true; readonly logMarkerSeen: true }
  readonly logs: {
    readonly pollIntervalMs: 2000
    readonly quietIntervalMs: 30000
    readonly queryStartIso: string
    readonly queryEndIso: string
    readonly uniqueRowVersions: number
    readonly exactDeploymentOnly: true
    readonly noTruncation: true
    readonly noErrors: true
  }
  readonly reconciliation: {
    readonly markerPersistedBeforeSpawn: true
    readonly apiBindingVerified: true
    readonly expectedCardinality: true
  }
  readonly cleanup: { readonly deploymentAbsent: true; readonly databaseRowsAbsent: true }
  readonly provenance: Kind extends "source"
    ? {
        readonly cleanSource: true
        readonly prebuiltOutputAbsent: true
        readonly remoteBuildObserved: true
      }
    : {
        readonly localOutputValidated: true
        readonly prebuiltDeployObserved: true
        readonly remoteSourceBuildAbsent: true
      }
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected)
  const missing = expected.filter((key) => !Object.hasOwn(value, key))
  const additional = Object.keys(value).filter((key) => !expectedSet.has(key))
  if (missing.length > 0 || additional.length > 0) {
    throw new Error(
      `${path} has invalid keys` +
        `${missing.length > 0 ? `; missing ${missing.length}` : ""}` +
        `${additional.length > 0 ? `; additional ${additional.length}` : ""}`,
    )
  }
}

function exactLiteral(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) throw new Error(`${path} must be ${JSON.stringify(expected)}`)
}

function exactTuple(value: unknown, expected: readonly unknown[], path: string): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`${path} must be an array of length ${expected.length}`)
  }
  for (const [index, item] of expected.entries())
    exactLiteral(value[index], item, `${path}[${index}]`)
}

function nonnegativeIndex(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a finite nonnegative integer`)
  }
  return value as number
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive integer`)
  }
  return value as number
}

function isoTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be an ISO timestamp`)
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${path} must be a canonical ISO timestamp`)
  }
  return value
}

function validateTrueObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = recordAt(value, path)
  exactKeys(record, path, keys)
  for (const key of keys) exactLiteral(record[key], true, `${path}.${key}`)
  return record
}

function validateDeployment(value: unknown, kind: "source" | "prebuilt", path: string): void {
  const deployment = recordAt(value, path)
  exactKeys(deployment, path, [
    "kind",
    "deploymentId",
    "canonicalOrigin",
    "apiBindingVerified",
    "config",
    "readyState",
    "routes",
    "state",
    "middleware",
    "stream",
    "laterRequest",
    "logs",
    "reconciliation",
    "cleanup",
    "provenance",
  ])
  exactLiteral(deployment.kind, kind, `${path}.kind`)
  if (typeof deployment.deploymentId !== "string")
    throw new Error(`${path}.deploymentId must be a string`)
  assertDeploymentId(deployment.deploymentId)
  if (typeof deployment.canonicalOrigin !== "string") {
    throw new Error(`${path}.canonicalOrigin must be a string`)
  }
  if (canonicalizeVercelOrigin(deployment.canonicalOrigin) !== deployment.canonicalOrigin) {
    throw new Error(`${path}.canonicalOrigin must already be canonical`)
  }
  exactLiteral(deployment.apiBindingVerified, true, `${path}.apiBindingVerified`)
  exactLiteral(deployment.readyState, "READY", `${path}.readyState`)

  const config = recordAt(deployment.config, `${path}.config`)
  exactKeys(config, `${path}.config`, ["fluid", "sha256"])
  exactLiteral(config.fluid, true, `${path}.config.fluid`)
  if (typeof config.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(config.sha256)) {
    throw new Error(`${path}.config.sha256 must be 64 lowercase hexadecimal characters`)
  }

  validateTrueObject(deployment.routes, `${path}.routes`, [
    "unknownRoute404",
    "state",
    "stream",
    "release",
  ])
  const state = recordAt(deployment.state, `${path}.state`)
  exactKeys(state, `${path}.state`, [
    "visits",
    "markersInOrder",
    "generatedReadMatched",
    "physicalCheckpoint",
  ])
  exactTuple(state.visits, [1, 2], `${path}.state.visits`)
  for (const key of ["markersInOrder", "generatedReadMatched", "physicalCheckpoint"] as const) {
    exactLiteral(state[key], true, `${path}.state.${key}`)
  }
  validateTrueObject(deployment.middleware, `${path}.middleware`, [
    "missingHeader401",
    "wrongHeader401",
    "selectiveRelease",
    "sentinelUnreleased",
  ])

  const stream = recordAt(deployment.stream, `${path}.stream`)
  exactKeys(stream, `${path}.stream`, [
    "status",
    "contentType",
    "noRedirect",
    "beforeFrameIndex",
    "preReleaseQuietMs",
    "authorizedReleaseAfterBeforeFrame",
    "afterFrameIndex",
    "doneFrameIndex",
    "eofAfterDone",
  ])
  exactLiteral(stream.status, 200, `${path}.stream.status`)
  exactLiteral(stream.contentType, "text/event-stream", `${path}.stream.contentType`)
  exactLiteral(stream.noRedirect, true, `${path}.stream.noRedirect`)
  exactLiteral(stream.preReleaseQuietMs, 1000, `${path}.stream.preReleaseQuietMs`)
  exactLiteral(
    stream.authorizedReleaseAfterBeforeFrame,
    true,
    `${path}.stream.authorizedReleaseAfterBeforeFrame`,
  )
  exactLiteral(stream.eofAfterDone, true, `${path}.stream.eofAfterDone`)
  const before = nonnegativeIndex(stream.beforeFrameIndex, `${path}.stream.beforeFrameIndex`)
  const after = nonnegativeIndex(stream.afterFrameIndex, `${path}.stream.afterFrameIndex`)
  const done = nonnegativeIndex(stream.doneFrameIndex, `${path}.stream.doneFrameIndex`)
  if (!(before < after && after < done)) {
    throw new Error(`${path}.stream frame indexes must satisfy before < after < done`)
  }

  validateTrueObject(deployment.laterRequest, `${path}.laterRequest`, [
    "succeeded",
    "logMarkerSeen",
  ])
  const logs = recordAt(deployment.logs, `${path}.logs`)
  exactKeys(logs, `${path}.logs`, [
    "pollIntervalMs",
    "quietIntervalMs",
    "queryStartIso",
    "queryEndIso",
    "uniqueRowVersions",
    "exactDeploymentOnly",
    "noTruncation",
    "noErrors",
  ])
  exactLiteral(logs.pollIntervalMs, 2000, `${path}.logs.pollIntervalMs`)
  exactLiteral(logs.quietIntervalMs, 30000, `${path}.logs.quietIntervalMs`)
  const start = isoTimestamp(logs.queryStartIso, `${path}.logs.queryStartIso`)
  const end = isoTimestamp(logs.queryEndIso, `${path}.logs.queryEndIso`)
  if (Date.parse(start) > Date.parse(end)) throw new Error(`${path}.logs ISO bounds are reversed`)
  positiveInteger(logs.uniqueRowVersions, `${path}.logs.uniqueRowVersions`)
  for (const key of ["exactDeploymentOnly", "noTruncation", "noErrors"] as const) {
    exactLiteral(logs[key], true, `${path}.logs.${key}`)
  }
  validateTrueObject(deployment.reconciliation, `${path}.reconciliation`, [
    "markerPersistedBeforeSpawn",
    "apiBindingVerified",
    "expectedCardinality",
  ])
  validateTrueObject(deployment.cleanup, `${path}.cleanup`, [
    "deploymentAbsent",
    "databaseRowsAbsent",
  ])

  const provenance = recordAt(deployment.provenance, `${path}.provenance`)
  const provenanceKeys =
    kind === "source"
      ? (["cleanSource", "prebuiltOutputAbsent", "remoteBuildObserved"] as const)
      : (["localOutputValidated", "prebuiltDeployObserved", "remoteSourceBuildAbsent"] as const)
  exactKeys(provenance, `${path}.provenance`, provenanceKeys)
  for (const key of provenanceKeys) exactLiteral(provenance[key], true, `${path}.provenance.${key}`)
}

export function parseNativeReceipt(value: unknown): VercelNativeReceiptV1 {
  const projectedValue = cloneOwnJsonData(value, "receipt")
  const receipt = recordAt(projectedValue, "receipt")
  exactKeys(receipt, "receipt", [
    "schemaVersion",
    "cliVersion",
    "projectBindingVerified",
    "kinds",
    "deployments",
  ])
  exactLiteral(receipt.schemaVersion, 1, "receipt.schemaVersion")
  exactLiteral(receipt.cliVersion, "58.9.0", "receipt.cliVersion")
  exactLiteral(receipt.projectBindingVerified, true, "receipt.projectBindingVerified")
  exactTuple(receipt.kinds, ["source", "prebuilt"], "receipt.kinds")
  if (!Array.isArray(receipt.deployments) || receipt.deployments.length !== 2) {
    throw new Error("receipt.deployments must be a two-item tuple")
  }
  validateDeployment(receipt.deployments[0], "source", "receipt.deployments[0]")
  validateDeployment(receipt.deployments[1], "prebuilt", "receipt.deployments[1]")
  const source = recordAt(receipt.deployments[0], "receipt.deployments[0]")
  const prebuilt = recordAt(receipt.deployments[1], "receipt.deployments[1]")
  if (source.deploymentId === prebuilt.deploymentId) {
    throw new Error("source and prebuilt receipt deploymentId values must differ")
  }
  if (source.canonicalOrigin === prebuilt.canonicalOrigin) {
    throw new Error("source and prebuilt receipt canonicalOrigin values must differ")
  }
  assertPlainJsonValue(projectedValue, "receipt")
  return projectedValue as VercelNativeReceiptV1
}

export async function writeFinalReceipt(
  path: string,
  value: unknown,
  protectedValues: readonly string[],
): Promise<void> {
  const receipt = parseNativeReceipt(value)
  createSecretRedactor(protectedValues).assertSafe("final Vercel receipt", receipt)
  await writeAtomicJson(path, receipt)
}
