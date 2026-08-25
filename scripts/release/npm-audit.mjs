import * as defaultFileSystem from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { snapshotJson } from "./adapter-normalize.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"

const PUBLIC_REGISTRY_ORIGIN = "https://registry.npmjs.org"
const PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1"
const PROVENANCE_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1"
const GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted"
const EXPECTED_REPOSITORY = "https://github.com/cacheplane/dawnai"
const STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA512_PATTERN = /^[0-9a-f]{128}$/u
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]{0,19}$/u
const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })
const AUDIT_ROOT_FIELDS = Object.freeze(["invalid", "missing", "verified"])
const VERIFIED_FIELDS = Object.freeze([
  "name",
  "version",
  "location",
  "registry",
  "attestations",
  "attestationBundles",
])

export const NPM_AUDIT_OUTPUT_MAX_BYTES = 2 * 1024 * 1024
export const NPM_AUDIT_VERIFIER = "npm-audit-signatures@11"

export function parseNpmAuditSignatures(output, { entry, candidate } = {}) {
  const identity = validateAuditContext(entry, candidate)
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output, "utf8") < 1 ||
    Buffer.byteLength(output, "utf8") > NPM_AUDIT_OUTPUT_MAX_BYTES
  ) {
    throw new Error("npm audit signatures output is missing or exceeds its byte limit")
  }
  let audit
  try {
    audit = snapshotJson(JSON.parse(output))
  } catch (error) {
    throw new Error("npm audit signatures output is malformed", { cause: error })
  }
  assertExactFields(audit, AUDIT_ROOT_FIELDS, "npm audit signatures output")
  if (
    !Array.isArray(audit.invalid) ||
    !Array.isArray(audit.missing) ||
    !Array.isArray(audit.verified)
  ) {
    throw new Error("npm audit signatures output is malformed")
  }
  if (audit.invalid.length > 0) {
    throw new Error(
      `npm audit signatures reported invalid evidence for ${auditNames(audit.invalid)}`,
    )
  }
  if (audit.missing.length > 0) {
    throw new Error(
      `npm audit signatures reported missing signatures for ${auditNames(audit.missing)}`,
    )
  }

  const sameName = audit.verified.filter((item) => item?.name === identity.entry.name)
  if (sameName.length === 0) return deepFreeze({ status: "pending" })
  if (sameName.length !== 1) {
    throw new Error(`npm audit signatures contains duplicate ${identity.entry.name}`)
  }
  const verified = sameName[0]
  assertExactFields(verified, VERIFIED_FIELDS, "npm audit signatures verified entry")
  if (
    verified.version !== identity.entry.version ||
    verified.location !== `node_modules/${identity.entry.name}`
  ) {
    throw new Error(
      `npm audit signatures did not verify exact ${identity.entry.name}@${identity.entry.version}`,
    )
  }
  assertPublicRegistry(verified.registry)
  validateAttestationDescriptor(verified.attestations, identity)
  // npm 11 populates attestationBundles only after Pacote/Sigstore verifies them. Decode the
  // already-verified signed payload only to bind its release identity; this is not a verifier.
  const statement = verifiedProvenanceStatement(verified.attestationBundles)
  const provenance = validateProvenanceStatement(statement, identity)
  return deepFreeze({
    status: "verified",
    signature: { status: "valid", verifier: NPM_AUDIT_VERIFIER },
    provenance,
  })
}

export async function createNpmAuditVerifier({
  runNpm,
  fileSystem = defaultFileSystem,
  environment = process.env,
  signal,
} = {}) {
  if (
    typeof runNpm !== "function" ||
    environment === null ||
    Array.isArray(environment) ||
    typeof environment !== "object" ||
    !isAbortSignal(signal)
  ) {
    throw new TypeError("npm audit verifier dependencies are invalid")
  }
  for (const method of ["mkdir", "mkdtemp", "readFile", "realpath", "rm", "writeFile"]) {
    if (typeof fileSystem?.[method] !== "function") {
      throw new TypeError(`npm audit verifier file system must expose ${method}`)
    }
  }

  const createdRoot = await fileSystem.mkdtemp(path.join(os.tmpdir(), "dawn-npm-audit-"))
  const root = await fileSystem.realpath(createdRoot)
  const auditHome = path.join(root, "audit-home")
  const auditCache = path.join(root, "audit-cache")
  const publishHome = path.join(root, "publish-home")
  const publishCache = path.join(root, "publish-cache")
  const consumersRoot = path.join(root, "consumers")
  const consumers = new Map()
  let disposed = false
  try {
    await Promise.all(
      [auditHome, auditCache, publishHome, publishCache, consumersRoot].map((directory) =>
        fileSystem.mkdir(directory, { mode: 0o700 }),
      ),
    )
    await Promise.all([
      writeEmptyNpmConfigs(fileSystem, auditHome),
      writeEmptyNpmConfigs(fileSystem, publishHome),
    ])
    const auditEnvironment = npmEnvironment(environment, {
      home: auditHome,
      cache: auditCache,
      preserveOidc: false,
    })
    const versionResult = await runNpm("npm", ["--version"], {
      cwd: auditHome,
      env: auditEnvironment,
      signal,
    })
    assertNpm11Version(versionResult?.stdout)

    return {
      root,
      publisherEnvironment({ candidate } = {}) {
        if (disposed) throw new Error("npm audit verifier has been disposed")
        const provenanceEnvironment = validatePublisherProvenanceEnvironment(environment, candidate)
        return npmEnvironment(environment, {
          home: publishHome,
          cache: publishCache,
          preserveOidc: true,
          additionalEnvironment: provenanceEnvironment,
        })
      },
      async verifyPackage({ entry, candidate }) {
        if (disposed) throw new Error("npm audit verifier has been disposed")
        const identity = validateAuditContext(entry, candidate)
        let consumer = consumers.get(identity.entry.name)
        if (consumer === undefined) {
          const directory = path.join(
            consumersRoot,
            `package-${String(consumers.size + 1).padStart(2, "0")}`,
          )
          await fileSystem.mkdir(directory, { mode: 0o700 })
          const packageJson = Buffer.from(
            `${JSON.stringify({
              name: "dawn-release-audit-consumer",
              version: "0.0.0",
              private: true,
              dependencies: { [identity.entry.name]: identity.entry.version },
            })}\n`,
            "utf8",
          )
          const packageJsonPath = path.join(directory, "package.json")
          await fileSystem.writeFile(packageJsonPath, packageJson, { flag: "wx", mode: 0o600 })
          consumer = { directory, packageJson, packageJsonPath, installed: false }
          consumers.set(identity.entry.name, consumer)
        }
        const currentPackageJson = await fileSystem.readFile(consumer.packageJsonPath)
        if (!Buffer.from(currentPackageJson).equals(consumer.packageJson)) {
          throw new Error(`npm audit consumer identity changed for ${identity.entry.name}`)
        }
        if (!consumer.installed) {
          await runNpm(
            "npm",
            [
              "install",
              "--ignore-scripts",
              "--package-lock=true",
              "--omit=dev",
              "--no-audit",
              "--no-fund",
              "--registry",
              `${PUBLIC_REGISTRY_ORIGIN}/`,
            ],
            {
              cwd: consumer.directory,
              env: auditEnvironment,
              signal,
            },
          )
          consumer.installed = true
        }
        const auditResult = await runNpm(
          "npm",
          ["audit", "signatures", "--json", "--include-attestations"],
          {
            cwd: consumer.directory,
            env: auditEnvironment,
            signal,
            acceptedExitCodes: [0, 1],
          },
        )
        return parseNpmAuditSignatures(auditResult?.stdout, identity)
      },
      async dispose() {
        if (disposed) return
        disposed = true
        consumers.clear()
        await fileSystem.rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await fileSystem.rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function validateAuditContext(entry, candidate) {
  const value = snapshotJson({ entry, candidate })
  if (
    value.entry === null ||
    Array.isArray(value.entry) ||
    typeof value.entry !== "object" ||
    !PACKAGE_NAME_PATTERN.test(value.entry.name) ||
    !isReleaseVersion(value.entry.version) ||
    !SHA512_PATTERN.test(value.entry.sha512) ||
    value.entry.npmIntegrity !== sha512Integrity(value.entry.sha512) ||
    value.candidate === null ||
    Array.isArray(value.candidate) ||
    typeof value.candidate !== "object" ||
    value.candidate.version !== value.entry.version ||
    !SHA_PATTERN.test(value.candidate.commitSha) ||
    value.candidate.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("npm audit verification context is invalid")
  }
  return value
}

function validateAttestationDescriptor(value, identity) {
  assertExactFields(value, ["url", "provenance"], "npm audit attestation descriptor")
  assertExactFields(value.provenance, ["predicateType"], "npm audit provenance descriptor")
  if (
    value.provenance.predicateType !== PROVENANCE_PREDICATE_TYPE ||
    !isExactAttestationUrl(value.url, identity.entry.name, identity.entry.version)
  ) {
    throw new Error("npm audit signatures lacks exact verified provenance")
  }
}

function verifiedProvenanceStatement(bundles) {
  if (!Array.isArray(bundles) || bundles.length < 1 || bundles.length > 8) {
    throw new Error("npm audit attestation bundles are malformed")
  }
  const provenance = []
  for (const wrapper of bundles) {
    assertExactFields(
      wrapper,
      ["predicateType", "bundle", "signedAccessSignatureUrl"],
      "npm audit attestation bundle",
    )
    if (
      typeof wrapper.predicateType !== "string" ||
      typeof wrapper.signedAccessSignatureUrl !== "string" ||
      wrapper.bundle === null ||
      Array.isArray(wrapper.bundle) ||
      typeof wrapper.bundle !== "object"
    ) {
      throw new Error("npm audit attestation bundle is malformed")
    }
    if (wrapper.predicateType !== PROVENANCE_PREDICATE_TYPE) continue
    provenance.push(decodeVerifiedStatement(wrapper.bundle))
  }
  if (provenance.length !== 1) {
    throw new Error("npm audit provenance bundle is missing, duplicate, or ambiguous")
  }
  return provenance[0]
}

function decodeVerifiedStatement(bundle) {
  assertExactFields(
    bundle,
    ["mediaType", "verificationMaterial", "dsseEnvelope"],
    "npm audit Sigstore bundle",
  )
  if (
    ![
      "application/vnd.dev.sigstore.bundle.v0.3+json",
      "application/vnd.dev.sigstore.bundle+json;version=0.2",
    ].includes(bundle.mediaType) ||
    bundle.verificationMaterial === null ||
    Array.isArray(bundle.verificationMaterial) ||
    typeof bundle.verificationMaterial !== "object"
  ) {
    throw new Error("npm audit Sigstore bundle is malformed")
  }
  assertExactFields(
    bundle.dsseEnvelope,
    ["payload", "payloadType", "signatures"],
    "npm audit DSSE envelope",
  )
  if (
    bundle.dsseEnvelope.payloadType !== DSSE_PAYLOAD_TYPE ||
    typeof bundle.dsseEnvelope.payload !== "string" ||
    !Array.isArray(bundle.dsseEnvelope.signatures) ||
    bundle.dsseEnvelope.signatures.length < 1
  ) {
    throw new Error("npm audit DSSE envelope is malformed")
  }
  const bytes = Buffer.from(bundle.dsseEnvelope.payload, "base64")
  if (bytes.length < 1 || bytes.toString("base64") !== bundle.dsseEnvelope.payload) {
    throw new Error("npm audit DSSE payload is malformed")
  }
  try {
    return snapshotJson(JSON.parse(UTF8_DECODER.decode(bytes)))
  } catch (error) {
    throw new Error("npm audit DSSE statement is malformed", { cause: error })
  }
}

function validateProvenanceStatement(statement, identity) {
  assertExactFields(
    statement,
    ["_type", "subject", "predicateType", "predicate"],
    "npm audit provenance statement",
  )
  if (
    statement._type !== STATEMENT_TYPE ||
    statement.predicateType !== PROVENANCE_PREDICATE_TYPE ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1
  ) {
    throw new Error("npm audit provenance predicate or subject is invalid")
  }
  const subject = statement.subject[0]
  assertExactFields(subject, ["name", "digest"], "npm audit provenance subject")
  assertExactFields(subject.digest, ["sha512"], "npm audit provenance subject digest")
  if (
    subject.name !== npmSubjectName(identity.entry.name, identity.entry.version) ||
    subject.digest.sha512 !== identity.entry.sha512
  ) {
    throw new Error("npm audit provenance subject or integrity does not match the package")
  }
  assertExactFields(
    statement.predicate,
    ["buildDefinition", "runDetails"],
    "npm audit provenance predicate",
  )
  const build = statement.predicate.buildDefinition
  assertExactFields(
    build,
    ["buildType", "externalParameters", "internalParameters", "resolvedDependencies"],
    "npm audit provenance build definition",
  )
  if (build.buildType !== PROVENANCE_BUILD_TYPE) {
    throw new Error("npm audit provenance build type is invalid")
  }
  assertExactFields(build.externalParameters, ["workflow"], "npm audit external parameters")
  const workflow = build.externalParameters.workflow
  assertExactFields(workflow, ["ref", "repository", "path"], "npm audit provenance workflow")
  const expectedRef = `refs/tags/v${identity.candidate.version}`
  if (workflow.repository !== EXPECTED_REPOSITORY) {
    throw new Error("npm audit provenance repository does not match the release")
  }
  if (workflow.path !== identity.candidate.publisherWorkflow) {
    throw new Error("npm audit provenance workflow does not match the release")
  }
  if (workflow.ref !== expectedRef) {
    throw new Error("npm audit provenance ref does not match the exact release tag")
  }
  if (!Array.isArray(build.resolvedDependencies) || build.resolvedDependencies.length !== 1) {
    throw new Error("npm audit provenance resolved dependency is ambiguous")
  }
  const dependency = build.resolvedDependencies[0]
  assertExactFields(dependency, ["uri", "digest"], "npm audit provenance dependency")
  assertExactFields(dependency.digest, ["gitCommit"], "npm audit provenance commit")
  if (
    dependency.uri !== `git+${EXPECTED_REPOSITORY}@${expectedRef}` ||
    dependency.digest.gitCommit !== identity.candidate.commitSha
  ) {
    throw new Error("npm audit provenance commit does not match the release")
  }
  assertExactFields(
    statement.predicate.runDetails,
    ["builder", "metadata"],
    "npm audit provenance run details",
  )
  assertExactFields(statement.predicate.runDetails.builder, ["id"], "npm audit provenance builder")
  if (statement.predicate.runDetails.builder.id !== GITHUB_HOSTED_BUILDER) {
    throw new Error("npm audit provenance builder is invalid")
  }
  return {
    predicateType: PROVENANCE_PREDICATE_TYPE,
    workflow: workflow.path,
    commitSha: dependency.digest.gitCommit,
    repository: workflow.repository,
    ref: workflow.ref,
  }
}

function validatePublisherProvenanceEnvironment(source, candidate) {
  let identity
  try {
    identity = snapshotJson(candidate)
  } catch {
    throw new TypeError("npm publish provenance environment is invalid")
  }
  if (
    identity === null ||
    Array.isArray(identity) ||
    typeof identity !== "object" ||
    !isReleaseVersion(identity.version) ||
    !SHA_PATTERN.test(identity.commitSha) ||
    identity.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("npm publish provenance environment is invalid")
  }
  const ref = `refs/tags/v${identity.version}`
  const expected = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: ref,
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_SHA: identity.commitSha,
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/${identity.publisherWorkflow}@${ref}`,
    RUNNER_ENVIRONMENT: "github-hosted",
  }
  for (const [name, value] of Object.entries(expected)) {
    if (source[name] !== value) {
      throw new Error("npm publish provenance environment does not match the release candidate")
    }
  }
  for (const name of [
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
  ]) {
    if (typeof source[name] !== "string" || !POSITIVE_DECIMAL_PATTERN.test(source[name])) {
      throw new Error("npm publish provenance environment does not match the release candidate")
    }
  }
  return Object.fromEntries(
    [
      ...Object.keys(expected),
      "GITHUB_REPOSITORY_ID",
      "GITHUB_REPOSITORY_OWNER_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
    ].map((name) => [name, source[name]]),
  )
}

function npmEnvironment(source, { home, cache, preserveOidc, additionalEnvironment = {} }) {
  const inheritedNames = [
    "CI",
    "COLORTERM",
    "COMSPEC",
    "FORCE_COLOR",
    "GITHUB_ACTIONS",
    "LANG",
    "LC_ALL",
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
  ]
  if (preserveOidc) {
    inheritedNames.push("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL")
  }
  const environment = Object.fromEntries(
    inheritedNames.flatMap((name) =>
      typeof source[name] === "string" ? [[name, source[name]]] : [],
    ),
  )
  return {
    ...environment,
    ...additionalEnvironment,
    HOME: home,
    USERPROFILE: home,
    npm_config_audit: "false",
    npm_config_cache: cache,
    npm_config_fund: "false",
    npm_config_globalconfig: path.join(home, "global.npmrc"),
    npm_config_ignore_scripts: "true",
    npm_config_registry: `${PUBLIC_REGISTRY_ORIGIN}/`,
    npm_config_update_notifier: "false",
    npm_config_userconfig: path.join(home, ".npmrc"),
  }
}

async function writeEmptyNpmConfigs(fileSystem, home) {
  await Promise.all([
    fileSystem.writeFile(path.join(home, ".npmrc"), "", { flag: "wx", mode: 0o600 }),
    fileSystem.writeFile(path.join(home, "global.npmrc"), "", { flag: "wx", mode: 0o600 }),
  ])
}

function assertNpm11Version(output) {
  if (typeof output !== "string" || !/^11\.[0-9]+\.[0-9]+\n?$/u.test(output)) {
    throw new Error("The release publisher requires an exact stable npm 11 CLI")
  }
  const version = output.endsWith("\n") ? output.slice(0, -1) : output
  if (!isExactSemver(version) || parseSemver(version).major !== 11) {
    throw new Error("The release publisher requires an exact stable npm 11 CLI")
  }
}

function assertPublicRegistry(value) {
  if (value !== PUBLIC_REGISTRY_ORIGIN && value !== `${PUBLIC_REGISTRY_ORIGIN}/`) {
    throw new Error("npm audit signatures did not use the exact public registry")
  }
}

function isExactAttestationUrl(value, name, version) {
  if (typeof value !== "string") return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (
    url.origin !== PUBLIC_REGISTRY_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return false
  }
  try {
    return decodeURIComponent(url.pathname) === `/-/npm/v1/attestations/${name}@${version}`
  } catch {
    return false
  }
}

function npmSubjectName(name, version) {
  if (!name.startsWith("@")) return `pkg:npm/${name}@${version}`
  const [scope, packageName] = name.split("/")
  return `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${version}`
}

function sha512Integrity(sha512) {
  return `sha512-${Buffer.from(sha512, "hex").toString("base64")}`
}

function auditNames(entries) {
  return entries
    .map((entry) => `${entry?.name ?? "<unknown>"}@${entry?.version ?? "<unknown>"}`)
    .join(", ")
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function assertExactFields(value, fields, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} is malformed`)
  }
  const keys = Object.keys(value)
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new Error(`${label} contains missing or unknown fields`)
  }
}

function isAbortSignal(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  )
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
