import { isExactSemver } from "../semver.mjs"

// Every observation is a JSON-safe envelope with status, operation, httpStatus, and code.
// PRESENT package observations additionally include the exact registry identity and evidence.
const OPERATIONS = new Set(["package-version", "package-metadata", "provenance"])
const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u

export function createNpmReader({
  registryUrl = "https://registry.npmjs.org",
  fetchImpl = fetch,
} = {}) {
  const registry = normalizeRegistryUrl(registryUrl)
  if (typeof fetchImpl !== "function") {
    throw new TypeError("npm fetch implementation must be a function")
  }

  return {
    observePackageVersion({ name, version }) {
      assertPackageName(name)
      if (!isExactSemver(version)) {
        throw new TypeError(`Invalid exact SemVer: ${String(version)}`)
      }
      return observePackageVersion({ registry, fetchImpl, name, version })
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
  if (response.ok === true || (httpStatus >= 200 && httpStatus < 300)) {
    return failure("PRESENT", operation, httpStatus, null)
  }

  const registryCode = safeRegistryCode(body?.code) ?? `HTTP_${httpStatus}`
  if (operation === "package-version" && httpStatus === 404 && registryCode === "E404") {
    return failure("ABSENT", operation, httpStatus, registryCode)
  }
  return failure("AMBIGUOUS", operation, httpStatus, registryCode)
}

async function observePackageVersion({ registry, fetchImpl, name, version }) {
  const encodedName = encodeURIComponent(name)
  const encodedVersion = encodeURIComponent(version)
  const versionResult = await getJson({
    fetchImpl,
    url: new URL(`${encodedName}/${encodedVersion}`, registry),
    operation: "package-version",
    accept: "application/json",
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
    fetchImpl,
    url: new URL(encodedName, registry),
    operation: "package-metadata",
    accept: "application/vnd.npm.install-v1+json",
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
      fetchImpl,
      url: new URL(versionDocument.provenanceUrl),
      operation: "provenance",
      accept: "application/json",
    })
    if (provenanceResult.status !== "PRESENT") {
      return withoutBody(provenanceResult)
    }
    provenance = normalizeProvenance(provenanceResult.body, versionDocument.provenanceUrl)
    if (provenance === null) {
      return failure("ERROR", "provenance", provenanceResult.httpStatus, "MALFORMED_SCHEMA")
    }
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

async function getJson({ fetchImpl, url, operation, accept }) {
  let response
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      headers: { Accept: accept },
    })
  } catch (error) {
    return failure(
      "AMBIGUOUS",
      operation,
      null,
      error?.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR",
    )
  }

  if (
    response === null ||
    typeof response !== "object" ||
    !Number.isInteger(response.status) ||
    typeof response.json !== "function"
  ) {
    return failure("ERROR", operation, null, "MALFORMED_RESPONSE")
  }

  const httpClassification = classifyRegistryResponse({ operation, response, body: null })
  if (httpClassification.status !== "PRESENT") {
    let body = null
    try {
      body = await response.json()
    } catch {
      // The status code remains ambiguous; an error page must never become absence.
    }
    return classifyRegistryResponse({ operation, response, body })
  }

  if (!isJsonContentType(response.headers?.get?.("content-type"))) {
    return failure("ERROR", operation, response.status, "UNEXPECTED_CONTENT_TYPE")
  }
  try {
    return { ...httpClassification, body: await response.json() }
  } catch {
    return failure("ERROR", operation, response.status, "MALFORMED_JSON")
  }
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
    typeof integrity !== "string" ||
    !INTEGRITY_PATTERN.test(integrity)
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
    provenanceUrl = sameOriginUrl(value.dist.attestations.url, registry)
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
      ? left.sig.localeCompare(right.sig)
      : left.keyid.localeCompare(right.keyid),
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
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))
}

function normalizeProvenance(value, url) {
  if (!isObject(value) || !Array.isArray(value.attestations)) {
    return null
  }
  const predicateTypes = new Set()
  let workflow = null
  let commitSha = null
  for (const attestation of value.attestations) {
    if (!isObject(attestation) || typeof attestation.predicateType !== "string") {
      return null
    }
    predicateTypes.add(attestation.predicateType)
    const payload = attestation.bundle?.dsseEnvelope?.payload
    if (payload === undefined) {
      continue
    }
    const statement = decodeStatement(payload)
    if (statement === null) {
      return null
    }
    if (typeof statement.predicateType === "string") {
      predicateTypes.add(statement.predicateType)
    }
    workflow ??= provenanceWorkflow(statement)
    commitSha ??= provenanceCommit(statement)
  }
  return {
    status: "PRESENT",
    url,
    predicateTypes: [...predicateTypes].sort(),
    workflow,
    commitSha,
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

function provenanceWorkflow(statement) {
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow
  if (typeof workflow === "string") {
    return workflow
  }
  return typeof workflow?.path === "string" ? workflow.path : null
}

function provenanceCommit(statement) {
  const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies
  if (!Array.isArray(dependencies)) {
    return null
  }
  for (const dependency of dependencies) {
    const commitSha = dependency?.digest?.gitCommit
    if (typeof commitSha === "string" && SHA_PATTERN.test(commitSha)) {
      return commitSha
    }
  }
  return null
}

function normalizeRegistryUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Invalid npm registry URL")
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
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

function assertPackageName(value) {
  if (typeof value !== "string" || !PACKAGE_NAME_PATTERN.test(value)) {
    throw new TypeError(`Invalid npm package name: ${String(value)}`)
  }
}

function safeRegistryCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_-]{0,63}$/u.test(value) ? value : null
}

function isJsonContentType(value) {
  return typeof value === "string" && /(?:\/json|\+json)(?:;|$)/iu.test(value)
}

function failure(status, operation, httpStatus, code) {
  return { status, operation, httpStatus, code }
}

function withoutBody(result) {
  return failure(result.status, result.operation, result.httpStatus, result.code)
}

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}
