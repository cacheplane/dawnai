import { isExactSemver } from "../semver.mjs"
import { createHttpGet } from "./http.mjs"

// Every observation is a JSON-safe envelope with status, operation, httpStatus, and code.
// PRESENT package observations additionally include the exact registry identity and evidence.
const OPERATIONS = new Set(["package-version", "package-metadata", "provenance"])
const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const DEFAULT_REGISTRY_ORIGIN = "https://registry.npmjs.org"
const MAX_REGISTRY_URL_BYTES = 2_048
const MAX_PACKAGE_NAME_BYTES = 256
const MAX_VERSION_BYTES = 256

export function createNpmReader({
  registryUrl = "https://registry.npmjs.org",
  fetchImpl = fetch,
  timeoutMs,
  maxResponseBytes,
  trustedRegistryOrigins,
} = {}) {
  assertInputByteLength(registryUrl, MAX_REGISTRY_URL_BYTES, "npm registry URL")
  const registry = normalizeRegistryUrl(registryUrl)
  const trustedOrigins = normalizeTrustedRegistryOrigins(trustedRegistryOrigins)
  if (!trustedOrigins.has(registry.origin)) {
    throw npmInputError("npm registry origin is not trusted", "UNTRUSTED_REGISTRY_ORIGIN")
  }
  const http = createHttpGet({
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  })

  return {
    observePackageVersion({ name, version, signal }) {
      assertPackageName(name)
      assertInputByteLength(version, MAX_VERSION_BYTES, "exact SemVer")
      if (!isExactSemver(version)) {
        throw new TypeError("Invalid exact SemVer")
      }
      return observePackageVersion({ registry, http, name, version, signal })
    },
  }
}

export function classifyRegistryResponse({ operation, response, body }) {
  if (!OPERATIONS.has(operation)) {
    throw new TypeError(`Unknown npm registry operation: ${String(operation)}`)
  }
  const httpStatus = response?.status
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    return failure("ERROR", operation, null, "MALFORMED_RESPONSE")
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    return failure("PRESENT", operation, httpStatus, null)
  }

  const registryCode = safeRegistryCode(body?.code) ?? `HTTP_${httpStatus}`
  if (operation === "package-version" && httpStatus === 404 && registryCode === "E404") {
    return failure("ABSENT", operation, httpStatus, registryCode)
  }
  return failure("AMBIGUOUS", operation, httpStatus, registryCode)
}

async function observePackageVersion({ registry, http, name, version, signal }) {
  const encodedName = encodeURIComponent(name)
  const encodedVersion = encodeURIComponent(version)
  const versionResult = await getJson({
    http,
    url: new URL(`${encodedName}/${encodedVersion}`, registry),
    operation: "package-version",
    accept: "application/json",
    signal,
  })
  if (versionResult.status !== "PRESENT") {
    return versionResult
  }

  const versionDocument = normalizeVersionDocument(versionResult.body, {
    registry,
    name,
    version,
  })
  if (versionDocument === null) {
    return failure("ERROR", "package-version", versionResult.httpStatus, "MALFORMED_SCHEMA")
  }
  if (versionDocument.unsafeUrl === true) {
    return failure("ERROR", "package-version", versionResult.httpStatus, "UNSAFE_REGISTRY_URL")
  }

  const metadataResult = await getJson({
    http,
    url: new URL(encodedName, registry),
    operation: "package-metadata",
    accept: "application/vnd.npm.install-v1+json",
    signal,
  })
  if (metadataResult.status !== "PRESENT") {
    return withoutBody(metadataResult)
  }
  const distTags = normalizeDistTags(metadataResult.body?.["dist-tags"])
  if (distTags === null) {
    return failure("ERROR", "package-metadata", metadataResult.httpStatus, "MALFORMED_SCHEMA")
  }

  let provenance = {
    status: "ABSENT",
    url: null,
    predicateTypes: [],
    workflow: null,
    commitSha: null,
  }
  if (versionDocument.provenanceUrl !== null) {
    const provenanceResult = await getJson({
      http,
      url: versionDocument.provenanceUrl,
      operation: "provenance",
      accept: "application/json",
      signal,
    })
    if (provenanceResult.status !== "PRESENT") {
      return withoutBody(provenanceResult)
    }
    const normalized = normalizeProvenance(provenanceResult.body, versionDocument.provenanceUrl, {
      name,
      version,
      integrity: versionDocument.integrity,
    })
    if (!normalized.ok) {
      return failure(normalized.status, "provenance", provenanceResult.httpStatus, normalized.code)
    }
    provenance = normalized.value
  }

  return {
    status: "PRESENT",
    operation: "package-version",
    httpStatus: versionResult.httpStatus,
    code: null,
    package: {
      name,
      version,
      tarballUrl: versionDocument.tarballUrl,
      shasum: versionDocument.shasum,
      integrity: versionDocument.integrity,
      signatures: versionDocument.signatures,
      distTags,
      latest: distTags.latest ?? null,
      provenance,
    },
  }
}

async function getJson({ http, url, operation, accept, signal }) {
  const response = await http.getJson({
    url,
    headers: { Accept: accept },
    ...(signal === undefined ? {} : { signal }),
  })
  if (response.status !== "OK" && response.status !== "HTTP_ERROR") {
    return failure(transportFailureStatus(response), operation, response.httpStatus, response.code)
  }

  const httpClassification = classifyRegistryResponse({
    operation,
    response: { status: response.httpStatus },
    body: response.body,
  })
  if (httpClassification.status !== "PRESENT") {
    return httpClassification
  }
  return { ...httpClassification, body: response.body }
}

function normalizeVersionDocument(value, { registry, name, version }) {
  if (
    !isObject(value) ||
    value.name !== name ||
    value.version !== version ||
    !isObject(value.dist)
  ) {
    return null
  }
  const { tarball, shasum, integrity } = value.dist
  const tarballUrl = sameOriginUrl(tarball, registry)
  if (tarballUrl === null) {
    return { unsafeUrl: true }
  }
  if (
    typeof shasum !== "string" ||
    !SHA_PATTERN.test(shasum) ||
    canonicalIntegritySha512(integrity) === null
  ) {
    return null
  }
  const signatures = normalizeSignatures(value.dist.signatures)
  if (signatures === null) {
    return null
  }

  let provenanceUrl = null
  if (value.dist.attestations !== undefined) {
    if (!isObject(value.dist.attestations)) {
      return null
    }
    const expectedUrl = exactProvenanceUrl(registry, name, version)
    provenanceUrl = exactUrl(value.dist.attestations.url, expectedUrl)
    if (provenanceUrl === null) {
      return { unsafeUrl: true }
    }
  }
  return { tarballUrl, shasum, integrity, signatures, provenanceUrl }
}

function normalizeSignatures(value) {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    return null
  }
  const signatures = []
  for (const item of value) {
    if (!isObject(item) || typeof item.keyid !== "string" || typeof item.sig !== "string") {
      return null
    }
    signatures.push({ keyid: item.keyid, sig: item.sig })
  }
  return signatures.sort((left, right) =>
    left.keyid === right.keyid
      ? compareStrings(left.sig, right.sig)
      : compareStrings(left.keyid, right.keyid),
  )
}

function normalizeDistTags(value) {
  if (!isObject(value)) {
    return null
  }
  const entries = []
  for (const [tag, version] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(tag) || !isExactSemver(version)) {
      return null
    }
    entries.push([tag, version])
  }
  return Object.fromEntries(entries.sort(([left], [right]) => compareStrings(left, right)))
}

function normalizeProvenance(value, url, { name, version, integrity }) {
  if (!isObject(value) || !Array.isArray(value.attestations)) {
    return invalidProvenance("ERROR", "MALFORMED_SCHEMA")
  }
  const predicateTypes = new Set()
  const identities = []
  const expected = {
    subjectName: npmSubjectName(name, version),
    subjectSha512: integritySha512(integrity),
  }
  if (expected.subjectSha512 === null) {
    return invalidProvenance("ERROR", "MALFORMED_PROVENANCE_IDENTITY")
  }
  for (const attestation of value.attestations) {
    if (!isObject(attestation) || typeof attestation.predicateType !== "string") {
      return invalidProvenance("ERROR", "MALFORMED_SCHEMA")
    }
    predicateTypes.add(attestation.predicateType)
    const payload = attestation.bundle?.dsseEnvelope?.payload
    if (payload === undefined) {
      if (attestation.predicateType === "https://slsa.dev/provenance/v1") {
        return invalidProvenance("ERROR", "MALFORMED_PROVENANCE_IDENTITY")
      }
      continue
    }
    const statement = decodeStatement(payload)
    if (statement === null) {
      return invalidProvenance("ERROR", "MALFORMED_SCHEMA")
    }
    if (
      typeof statement.predicateType !== "string" ||
      statement.predicateType !== attestation.predicateType
    ) {
      return invalidProvenance("ERROR", "MALFORMED_SCHEMA")
    }
    predicateTypes.add(statement.predicateType)
    if (statement.predicateType !== "https://slsa.dev/provenance/v1") {
      continue
    }
    const identity = provenanceIdentity(statement, expected)
    if (identity === null) {
      return invalidProvenance("ERROR", "MALFORMED_PROVENANCE_IDENTITY")
    }
    identities.push(identity)
  }
  if (identities.length === 0) {
    return invalidProvenance("ERROR", "MALFORMED_PROVENANCE_IDENTITY")
  }
  const canonicalIdentity = JSON.stringify(identities[0])
  if (identities.some((identity) => JSON.stringify(identity) !== canonicalIdentity)) {
    return invalidProvenance("AMBIGUOUS", "PROVENANCE_IDENTITY_CONFLICT")
  }
  return {
    ok: true,
    value: {
      status: "PRESENT",
      url,
      predicateTypes: [...predicateTypes].sort(),
      workflow: identities[0].workflow,
      commitSha: identities[0].commitSha,
    },
  }
}

function decodeStatement(payload) {
  if (typeof payload !== "string") {
    return null
  }
  try {
    const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"))
    return isObject(statement) ? statement : null
  } catch {
    return null
  }
}

function provenanceIdentity(statement, expected) {
  const subjects = statement.subject
  if (
    !Array.isArray(subjects) ||
    subjects.length !== 1 ||
    subjects[0]?.name !== expected.subjectName ||
    subjects[0]?.digest?.sha512 !== expected.subjectSha512
  ) {
    return null
  }
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow
  if (
    !isObject(workflow) ||
    typeof workflow.path !== "string" ||
    workflow.path.length === 0 ||
    typeof workflow.repository !== "string" ||
    !isSafeGitHubRepositoryUrl(workflow.repository) ||
    typeof workflow.ref !== "string" ||
    !/^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(workflow.ref)
  ) {
    return null
  }
  const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies
  if (!Array.isArray(dependencies)) {
    return null
  }
  const expectedUri = `git+${workflow.repository}@${workflow.ref}`
  const commits = new Set()
  for (const dependency of dependencies) {
    const commitSha = dependency?.digest?.gitCommit
    if (
      dependency?.uri === expectedUri &&
      typeof commitSha === "string" &&
      SHA_PATTERN.test(commitSha)
    ) {
      commits.add(commitSha)
    }
  }
  if (commits.size !== 1) {
    return null
  }
  return {
    workflow: workflow.path,
    commitSha: [...commits][0],
    repository: workflow.repository,
    ref: workflow.ref,
    subjectName: expected.subjectName,
    subjectSha512: expected.subjectSha512,
  }
}

function npmSubjectName(name, version) {
  if (!name.startsWith("@")) {
    return `pkg:npm/${name}@${version}`
  }
  const [scope, packageName] = name.split("/")
  return `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${version}`
}

function integritySha512(integrity) {
  return canonicalIntegritySha512(integrity)?.toString("hex") ?? null
}

function isSafeGitHubRepositoryUrl(value) {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(url.pathname)
    )
  } catch {
    return false
  }
}

function invalidProvenance(status, code) {
  return { ok: false, status, code }
}

function normalizeRegistryUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Invalid npm registry URL")
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Invalid npm registry URL")
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`
  return url
}

function sameOriginUrl(value, registry) {
  if (typeof value !== "string") {
    return null
  }
  try {
    const url = new URL(value)
    return url.origin === registry.origin &&
      ["http:", "https:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
      ? url.href
      : null
  } catch {
    return null
  }
}

function exactProvenanceUrl(registry, name, version) {
  return new URL(
    `/-/npm/v1/attestations/${npmAttestationName(name)}@${encodeURIComponent(version)}`,
    `${registry.origin}/`,
  ).href
}

function npmAttestationName(name) {
  const slash = name.indexOf("/")
  return slash === -1
    ? encodeURIComponent(name)
    : `${name.slice(0, slash)}%2f${name.slice(slash + 1)}`
}

function exactUrl(value, expected) {
  if (typeof value !== "string") {
    return null
  }
  try {
    const url = new URL(value)
    return url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.href === expected
      ? url.href
      : null
  } catch {
    return null
  }
}

function canonicalIntegritySha512(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) {
    return null
  }
  const encoded = value.slice("sha512-".length)
  const bytes = Buffer.from(encoded, "base64")
  return bytes.length === 64 && bytes.toString("base64") === encoded ? bytes : null
}

function assertPackageName(value) {
  assertInputByteLength(value, MAX_PACKAGE_NAME_BYTES, "npm package name")
  if (typeof value !== "string" || !PACKAGE_NAME_PATTERN.test(value)) {
    throw new TypeError("Invalid npm package name")
  }
}

function normalizeTrustedRegistryOrigins(value) {
  if (value === undefined) {
    return new Set([DEFAULT_REGISTRY_ORIGIN])
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid trusted npm registry origins")
  }
  const origins = new Set([DEFAULT_REGISTRY_ORIGIN])
  for (const origin of value) {
    assertInputByteLength(origin, MAX_REGISTRY_URL_BYTES, "trusted npm registry origin")
    let url
    try {
      url = new URL(origin)
    } catch {
      throw new TypeError("Invalid trusted npm registry origin")
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.origin !== origin
    ) {
      throw new TypeError("Invalid trusted npm registry origin")
    }
    origins.add(origin)
  }
  return origins
}

function assertInputByteLength(value, maximum, label) {
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > maximum) {
    throw npmInputError(`${label} exceeds byte limit`, "INPUT_TOO_LONG")
  }
}

function npmInputError(message, code) {
  const error = new TypeError(message)
  error.code = code
  return error
}

function safeRegistryCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_-]{0,63}$/u.test(value) ? value : null
}

function failure(status, operation, httpStatus, code) {
  return { status, operation, httpStatus, code }
}

function transportFailureStatus(result) {
  if (result.code === "MALFORMED_RESPONSE") {
    return "ERROR"
  }
  if (["ABORTED", "NETWORK_ERROR", "TIMEOUT"].includes(result.code)) {
    return "AMBIGUOUS"
  }
  if (
    result.code !== "REDIRECT" &&
    result.httpStatus !== null &&
    (result.httpStatus < 200 || result.httpStatus >= 300)
  ) {
    return "AMBIGUOUS"
  }
  return "ERROR"
}

function withoutBody(result) {
  return failure(result.status, result.operation, result.httpStatus, result.code)
}

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function compareStrings(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
