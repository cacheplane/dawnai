#!/usr/bin/env node

import { appendFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { normalizeAdapterEnvelope, snapshotJson } from "./adapter-normalize.mjs"
import { createGitHubReader } from "./adapters/github.mjs"
import { createGitHubWriter } from "./adapters/github-write.mjs"
import { canonicalReleaseBody, parseReleaseMarker } from "./metadata.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"

const REPOSITORY = "cacheplane/dawnai"
const WORKFLOW = ".github/workflows/published-artifact-verify.yml"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254}[A-Za-z0-9])?$/u
const MAX_PATH_BYTES = 4_096

export function parseIndependentAuditCoordinatorArgs(argv) {
  const values = snapshotJson(argv)
  if (
    !Array.isArray(values) ||
    values.length !== 2 ||
    values[0] !== "--github-output" ||
    typeof values[1] !== "string" ||
    values[1].length === 0 ||
    /[\0\r\n]/u.test(values[1]) ||
    Buffer.byteLength(values[1], "utf8") > MAX_PATH_BYTES
  ) {
    throw new TypeError("Independent audit coordinator requires exactly --github-output <path>")
  }
  return Object.freeze({ githubOutput: values[1] })
}

export async function coordinateIndependentAudit(input) {
  const invocation = normalizeInvocation(input)
  const exactTag = `refs/tags/v${invocation.inputs.version}`
  if (invocation.eventName === "workflow_dispatch" && invocation.ref === exactTag) {
    if (invocation.sha !== invocation.inputs.commitSha) {
      throw new Error("Exact-tag audit SHA does not match its candidate input")
    }
    const release = await readReleaseByTag(
      invocation.github.reader,
      `v${invocation.inputs.version}`,
    )
    const managed = parseManagedRelease(release, {
      defaultBranch: invocation.defaultBranch,
      expected: invocation.inputs,
      allowDraft: true,
    })
    await verifyAnnotatedTag(invocation.github.reader, managed)
    return Object.freeze({ mode: managed.mode, ...managedIdentity(managed) })
  }

  if (invocation.ref !== `refs/heads/${invocation.defaultBranch}`) {
    throw new Error("Independent audit coordination is restricted to the default branch")
  }

  const managed =
    invocation.eventName === "schedule"
      ? await discoverLatestPublishedRelease(invocation.github.reader, invocation.defaultBranch)
      : parseManagedRelease(
          await readReleaseByTag(invocation.github.reader, `v${invocation.inputs.version}`),
          {
            defaultBranch: invocation.defaultBranch,
            expected: invocation.inputs,
            allowDraft: false,
          },
        )
  await verifyAnnotatedTag(invocation.github.reader, managed)
  const identity = managedIdentity(managed)
  const receipt = snapshotJson(
    await invocation.github.writer.dispatchWorkflowAtRef({
      workflow: WORKFLOW,
      ref: managed.tag,
      inputs: identity,
    }),
  )
  assertDispatchReceipt(receipt)
  return Object.freeze({ mode: "relayed", ...identity })
}

async function discoverLatestPublishedRelease(reader, defaultBranch) {
  const releases = await readEnvelopeValue(reader.listReleases(), "releases")
  if (!Array.isArray(releases)) throw new Error("GitHub Release list is malformed")
  const managed = []
  const versions = new Set()
  for (const release of releases) {
    if (!isPublishedReleaseCandidate(release)) continue
    const parsed = parseManagedRelease(release, { defaultBranch, allowDraft: false })
    if (versions.has(parsed.version)) {
      throw new Error(`Managed published Release v${parsed.version} is duplicated`)
    }
    versions.add(parsed.version)
    managed.push(parsed)
  }
  if (managed.length === 0) throw new Error("No managed published immutable Release was found")
  managed.sort((left, right) => compareSemver(left.version, right.version))
  return managed.at(-1)
}

function isPublishedReleaseCandidate(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    value.draft === false &&
    value.immutable === true &&
    typeof value.tag_name === "string" &&
    value.tag_name.startsWith("v") &&
    isReleaseVersion(value.tag_name.slice(1))
  )
}

async function readReleaseByTag(reader, tag) {
  return readEnvelopeValue(reader.getReleaseByTag({ tag }), "release")
}

async function readEnvelopeValue(value, operation) {
  const envelope = normalizeAdapterEnvelope(await value, {
    source: "github",
    operation,
    payloadKey: "value",
  })
  if (envelope.status !== "PRESENT") {
    throw new Error(`GitHub ${operation} observation is not exact`)
  }
  return envelope.value
}

function parseManagedRelease(value, { defaultBranch, expected, allowDraft }) {
  const release = snapshotJson(value)
  if (
    release === null ||
    Array.isArray(release) ||
    typeof release !== "object" ||
    !Number.isSafeInteger(release.id) ||
    release.id < 1 ||
    release.prerelease !== false ||
    release.target_commitish !== defaultBranch ||
    typeof release.body !== "string" ||
    typeof release.tag_name !== "string"
  ) {
    throw new Error("Managed Release identity is malformed")
  }
  const version = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : ""
  if (!isReleaseVersion(version) || release.name !== `Dawn v${version}`) {
    throw new Error("Managed Release version or title is malformed")
  }
  const marker = parseReleaseMarker(release.body)
  if (
    marker.version !== version ||
    marker.tag !== release.tag_name ||
    release.body !== canonicalReleaseBody({ marker, manifest: null })
  ) {
    throw new Error("Managed Release marker identity is malformed")
  }
  let mode
  if (release.draft === false && release.immutable === true && marker.phase === "AUDIT_VERIFIED") {
    mode = "published"
  } else if (
    allowDraft &&
    release.draft === true &&
    release.immutable === false &&
    ["SMOKES_COMPLETE", "AUDIT_DISPATCHED", "AUDIT_RETRYABLE"].includes(marker.phase)
  ) {
    mode = "draft"
  } else {
    throw new Error("Managed Release is not an auditable draft or published immutable release")
  }
  const identity = {
    version,
    commitSha: marker.commitSha,
    manifestSha256: marker.manifestSha256,
  }
  if (
    expected !== undefined &&
    (identity.version !== expected.version ||
      identity.commitSha !== expected.commitSha ||
      identity.manifestSha256 !== expected.manifestSha256)
  ) {
    throw new Error("Managed Release does not match the exact audit inputs")
  }
  return Object.freeze({ ...identity, tag: release.tag_name, mode })
}

async function verifyAnnotatedTag(reader, release) {
  const ref = await readEnvelopeValue(reader.getRef({ ref: `tags/${release.tag}` }), "ref")
  if (
    ref === null ||
    Array.isArray(ref) ||
    typeof ref !== "object" ||
    ref.object?.type !== "tag" ||
    !SHA_PATTERN.test(ref.object?.sha)
  ) {
    throw new Error("Managed Release tag must be one annotated Git tag")
  }
  const tag = await readEnvelopeValue(reader.getGitTag({ tagSha: ref.object.sha }), "git-tag")
  if (
    tag === null ||
    Array.isArray(tag) ||
    typeof tag !== "object" ||
    tag.tag !== release.tag ||
    tag.object?.type !== "commit" ||
    tag.object?.sha !== release.commitSha
  ) {
    throw new Error("Managed annotated tag does not peel to the release commit")
  }
}

function normalizeInvocation(input) {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    throw new TypeError("Independent audit coordinator input is invalid")
  }
  const keys = Reflect.ownKeys(input)
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.slice().sort().join("\0") !==
      ["defaultBranch", "eventName", "github", "inputs", "ref", "sha"].sort().join("\0")
  ) {
    throw new TypeError("Independent audit coordinator input fields are invalid")
  }
  const value = Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor?.enumerable !== true || !("value" in descriptor)) {
        throw new TypeError("Independent audit coordinator input fields are invalid")
      }
      return [key, key === "github" ? descriptor.value : snapshotJson(descriptor.value)]
    }),
  )
  if (!new Set(["schedule", "workflow_dispatch"]).has(value.eventName)) {
    throw new TypeError("Independent audit coordinator event is invalid")
  }
  if (
    typeof value.defaultBranch !== "string" ||
    !BRANCH_PATTERN.test(value.defaultBranch) ||
    value.defaultBranch.includes("..") ||
    value.defaultBranch.includes("//") ||
    typeof value.ref !== "string" ||
    !SHA_PATTERN.test(value.sha)
  ) {
    throw new TypeError("Independent audit coordinator ref identity is invalid")
  }
  const inputs = normalizeInputs(value.inputs, value.eventName)
  if (
    value.github === null ||
    Array.isArray(value.github) ||
    typeof value.github !== "object" ||
    typeof value.github.reader?.listReleases !== "function" ||
    typeof value.github.reader?.getReleaseByTag !== "function" ||
    typeof value.github.reader?.getRef !== "function" ||
    typeof value.github.reader?.getGitTag !== "function" ||
    typeof value.github.writer?.dispatchWorkflowAtRef !== "function"
  ) {
    throw new TypeError("Independent audit coordinator GitHub boundary is invalid")
  }
  return Object.freeze({ ...value, inputs })
}

function normalizeInputs(value, eventName) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Independent audit inputs are invalid")
  }
  const fields = ["version", "commitSha", "manifestSha256"]
  if (Object.keys(value).sort().join("\0") !== fields.slice().sort().join("\0")) {
    throw new TypeError("Independent audit input fields are invalid")
  }
  const inputs = Object.fromEntries(fields.map((field) => [field, value[field]]))
  if (eventName === "schedule") {
    if (fields.some((field) => inputs[field] !== "")) {
      throw new TypeError("Scheduled independent audits cannot accept inputs")
    }
    return Object.freeze(inputs)
  }
  if (
    !isReleaseVersion(inputs.version) ||
    !SHA_PATTERN.test(inputs.commitSha) ||
    !SHA256_PATTERN.test(inputs.manifestSha256)
  ) {
    throw new TypeError("Manual independent audit inputs are invalid")
  }
  return Object.freeze(inputs)
}

function managedIdentity(value) {
  return Object.freeze({
    version: value.version,
    commitSha: value.commitSha,
    manifestSha256: value.manifestSha256,
  })
}

function assertDispatchReceipt(value) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).sort().join("\0") !==
      ["workflowRunId", "runUrl", "htmlUrl"].sort().join("\0") ||
    !Number.isSafeInteger(value.workflowRunId) ||
    value.workflowRunId < 1 ||
    value.runUrl !==
      `https://api.github.com/repos/${REPOSITORY}/actions/runs/${value.workflowRunId}` ||
    value.htmlUrl !== `https://github.com/${REPOSITORY}/actions/runs/${value.workflowRunId}`
  ) {
    throw new Error("Independent audit relay receipt is malformed")
  }
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function environmentValue(environment, name) {
  const value = environment[name]
  if (typeof value !== "string" || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`Independent audit coordinator environment ${name} is invalid`)
  }
  return value
}

async function main() {
  const options = parseIndependentAuditCoordinatorArgs(process.argv.slice(2))
  const repository = environmentValue(process.env, "GITHUB_REPOSITORY")
  if (repository !== REPOSITORY) throw new TypeError("Independent audit repository is invalid")
  const token = environmentValue(process.env, "GITHUB_TOKEN")
  const repositoryId = environmentValue(process.env, "GITHUB_REPOSITORY_ID")
  const defaultBranch = environmentValue(process.env, "GITHUB_DEFAULT_BRANCH")
  const [owner, repo] = repository.split("/")
  const reader = createGitHubReader({ owner, repo, repositoryId, token })
  const writer = createGitHubWriter({ owner, repo, token, reader })
  const result = await coordinateIndependentAudit({
    eventName: environmentValue(process.env, "GITHUB_EVENT_NAME"),
    ref: environmentValue(process.env, "GITHUB_REF"),
    sha: environmentValue(process.env, "GITHUB_SHA"),
    defaultBranch,
    inputs: {
      version: environmentValue(process.env, "INPUT_VERSION"),
      commitSha: environmentValue(process.env, "INPUT_COMMIT_SHA"),
      manifestSha256: environmentValue(process.env, "INPUT_MANIFEST_SHA256"),
    },
    github: { reader, writer },
  })
  await appendFile(path.resolve(options.githubOutput), `mode=${result.mode}\n`, "utf8")
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
