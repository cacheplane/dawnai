import { planCandidateArbitration } from "./planner.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"
import { ReleaseState } from "./state.mjs"
import { parseAbandonmentRecord, parseAuditResult } from "./terminal-records.mjs"

const MARKER_PATH = "scripts/release/controller-schema.json"
const EXPECTED_PACKAGE_COUNT = 21
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })
const CANDIDATE_POLICY = Object.freeze({
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})
const ACTIVE_MARKER = Object.freeze({
  schemaVersion: 1,
  publishingOwner: "release-controller",
  epoch: "fixed-group-v1",
  npmTrustedPublisherEnvironment: null,
  abandonmentEnvironment: "release-abandonment",
})
const ACTIVE_MARKER_FIELDS = Object.freeze(Object.keys(ACTIVE_MARKER).sort())

export async function discoverManagedCandidate({ ref, inventory, git, marker }) {
  return (
    await discoverManagedCandidateDetails({
      ref,
      inventory,
      git,
      marker,
    })
  ).selection
}

async function discoverManagedCandidateDetails({ ref, inventory, git, marker }) {
  normalizeActiveMarker(marker)
  assertRef(ref)
  assertMethods(
    git,
    ["listFirstParentHistory", "firstParent", "isAncestor", "listTree", "showFile"],
    "Git reader",
  )
  assertMethods(inventory, ["read"], "inventory reader")

  const history = await git.listFirstParentHistory({ ref, maxCount: 1 })
  if (!Array.isArray(history) || history.length !== 1 || !isSha(history[0])) {
    throw new TypeError("Candidate ref did not resolve to one exact commit")
  }
  const commitSha = history[0]
  const onMain = await git.isAncestor({ ancestor: commitSha, descendant: "refs/heads/main" })
  if (onMain !== true) throw new Error(`Candidate SHA ${commitSha} is not reachable from main`)
  const parentSha = await git.firstParent(commitSha)
  if (!isSha(parentSha)) throw new TypeError("Candidate first parent is not an exact commit")

  const [currentRaw, parentRaw] = await Promise.all([
    inventory.read({ ref: commitSha }),
    inventory.read({ ref: parentSha }),
  ])
  const current = normalizeDiscoveryInventory(currentRaw, "current")
  const parent = normalizeDiscoveryInventory(parentRaw, "first-parent")
  if (!arraysEqual(current.names, parent.names)) {
    throw new TypeError("Release inventory package set changed across the candidate commit")
  }
  if (current.version === parent.version) {
    return candidateDetails(noCandidate(), current.names)
  }
  if (compareSemver(current.version, parent.version) <= 0) {
    throw new TypeError("Release inventory version delta must increase uniformly")
  }

  const candidate = candidateIdentity(current.version, commitSha)
  if (!(await commitHasActiveMarker({ commitSha, git, marker }))) {
    return candidateDetails(
      candidateSelection({
        candidate,
        state: ReleaseState.SUPERSEDED_NOOP,
        disposition: "audit-only",
        tag: null,
        conflicts: [],
      }),
      current.names,
    )
  }

  return candidateDetails(
    candidateSelection({
      candidate,
      state: ReleaseState.CANDIDATE_VALIDATED,
      disposition: "selected",
      tag: null,
      conflicts: [],
    }),
    current.names,
  )
}

export async function discoverScheduledCandidate({ inventory, git, github, marker }) {
  normalizeActiveMarker(marker)
  assertMethods(
    git,
    ["resolveTag", "listFirstParentHistory", "firstParent", "isAncestor", "listTree", "showFile"],
    "Git reader",
  )
  assertMethods(inventory, ["read"], "inventory reader")
  assertMethods(
    github,
    ["listTagRefs", "listReleases", "listReleaseAssets", "downloadReleaseAsset"],
    "GitHub reader",
  )

  const [tagResult, releaseResult] = await Promise.all([
    github.listTagRefs(),
    github.listReleases(),
  ])
  const tagRecords = presentList(tagResult, "managed tag refs")
  const releaseRecords = presentList(releaseResult, "GitHub Releases")
  const tags = await normalizeManagedTags(tagRecords, git)
  const tagsByName = new Map(tags.map((tag) => [tag.tag, tag]))
  const releases = await inspectManagedReleases({
    records: releaseRecords,
    tagsByName,
    inventory,
    git,
    github,
    marker,
  })
  const releasesByTag = new Map(releases.map((release) => [release.tag, release]))
  const standalone = []

  for (const tag of tags) {
    if (releasesByTag.has(tag.tag)) continue
    const discovery = await discoverManagedCandidate({
      ref: tag.commitSha,
      inventory,
      git,
      marker,
    })
    if (discovery.state === ReleaseState.SUPERSEDED_NOOP) continue
    if (
      discovery.state !== ReleaseState.CANDIDATE_VALIDATED ||
      discovery.candidate.version !== tag.version ||
      discovery.candidate.commitSha !== tag.commitSha
    ) {
      throw new Error(`Standalone managed tag ${tag.tag} is not an exact release candidate`)
    }
    standalone.push(
      candidateSelection({
        candidate: discovery.candidate,
        state: ReleaseState.CANDIDATE_TAGGED,
        disposition: "selected",
        tag: tag.tag,
        conflicts: [],
      }),
    )
  }

  const tagged = [...releases, ...standalone].sort(compareSelections)
  const incomplete = tagged.filter(
    (release) =>
      release.state !== ReleaseState.AUDIT_COMPLETE &&
      release.state !== ReleaseState.ABANDONED_PREPUBLICATION,
  )
  if (incomplete.length > 0) {
    return arbitrateCandidate({
      candidate: incomplete[0],
      managedReleases: tagged,
      registryLatest: [],
    })
  }

  const history = await git.listFirstParentHistory({ ref: "main", maxCount: 1000 })
  if (!Array.isArray(history) || !history.every(isSha)) {
    throw new TypeError("First-parent main history is malformed")
  }
  const versionCandidates = []
  let activeEpochStarted = false
  for (const sha of history) {
    if (!(await commitHasActiveMarker({ commitSha: sha, git, marker }))) {
      if (activeEpochStarted) break
      continue
    }
    activeEpochStarted = true
    const discovery = await discoverManagedCandidate({ ref: sha, inventory, git, marker })
    if (discovery.state === ReleaseState.CANDIDATE_VALIDATED) versionCandidates.push(discovery)
  }
  versionCandidates.sort((left, right) => {
    const comparison = compareSemver(right.candidate.version, left.candidate.version)
    return comparison === 0
      ? compareText(left.candidate.commitSha, right.candidate.commitSha)
      : comparison
  })
  for (let index = 1; index < versionCandidates.length; index += 1) {
    const previous = versionCandidates[index - 1]
    const current = versionCandidates[index]
    if (
      current.candidate.version === previous.candidate.version &&
      current.candidate.commitSha !== previous.candidate.commitSha
    ) {
      throw new Error("Managed release version resolves to multiple candidate commits")
    }
  }

  const newest = versionCandidates[0]
  if (newest === undefined || tagsByName.has(`v${newest.candidate.version}`)) return noCandidate()
  return arbitrateCandidate({ candidate: newest, managedReleases: tagged, registryLatest: [] })
}

export async function waitForRequiredCi({ sha, github, attempts, delayMs, delay = wait }) {
  validateSha(sha, "Candidate SHA")
  assertMethods(github, ["getCommitCheckRuns", "listWorkflowRuns"], "GitHub reader")
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new TypeError("CI polling attempts must be an integer from 1 through 100")
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 300_000) {
    throw new TypeError("CI polling delay must be an integer from 0 through 300000")
  }
  if (typeof delay !== "function") throw new TypeError("CI polling delay must be a function")

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [checkResult, workflowResult] = await Promise.all([
      github.getCommitCheckRuns({ commitSha: sha }),
      github.listWorkflowRuns({ workflow: "ci.yml", commitSha: sha }),
    ])
    const status = classifyRequiredCi({ sha, checkResult, workflowResult })
    if (status.status !== "pending") return deepFreeze(status)
    if (attempt + 1 < attempts) await delay(delayMs)
  }
  return deepFreeze({
    status: "timeout",
    retryable: true,
    commitSha: sha,
    workflow: "CI",
    check: "validate",
  })
}

export function arbitrateCandidate({ candidate, managedReleases, registryLatest }) {
  return planCandidateArbitration({ candidate, managedReleases, registryLatest })
}

export function decideInvocation({ candidateVersion, candidateSha, githubSha, tagState }) {
  if (!isReleaseVersion(candidateVersion)) {
    throw new TypeError("Invocation candidate version must be exact SemVer without build metadata")
  }
  validateSha(candidateSha, "Candidate SHA")
  validateSha(githubSha, "GITHUB_SHA")
  const tag = normalizeTagState(tagState)
  if (tag.tag !== `v${candidateVersion}`) {
    throw new TypeError("Invocation candidate tag does not match the candidate version")
  }
  if (tag.status === "ambiguous") {
    return invocationDecision({
      disposition: "blocked",
      tagAction: null,
      dispatchRef: null,
      exitBeforePreparation: true,
      conflicts: ["candidate-tag-ambiguous"],
    })
  }
  if (tag.status === "present" && tag.commitSha !== candidateSha) {
    return invocationDecision({
      disposition: "blocked",
      tagAction: null,
      dispatchRef: null,
      exitBeforePreparation: true,
      conflicts: ["candidate-tag-commit-mismatch"],
    })
  }
  const tagAction = tag.status === "absent" ? "create" : "validate"
  if (githubSha === candidateSha) {
    return invocationDecision({
      disposition: "continue",
      tagAction,
      dispatchRef: null,
      exitBeforePreparation: false,
      conflicts: [],
    })
  }
  return invocationDecision({
    disposition: "dispatch-and-exit",
    tagAction,
    dispatchRef: tag.tag,
    exitBeforePreparation: true,
    conflicts: [],
  })
}

async function inspectManagedReleases({ records, tagsByName, inventory, git, github, marker }) {
  const managed = records.filter((record) => managedVersionFromTag(record?.tag_name) !== null)
  const seenTags = new Set()
  const releases = []
  for (const release of managed) {
    const tag = release.tag_name
    if (seenTags.has(tag)) throw new Error(`Managed GitHub Release ${tag} is duplicated`)
    seenTags.add(tag)
    if (!isPositiveId(release.id) || typeof release.draft !== "boolean") {
      throw new TypeError(`Managed GitHub Release ${tag} is malformed`)
    }
    const tagIdentity = tagsByName.get(tag)
    if (tagIdentity === undefined) {
      throw new Error(`Managed GitHub Release ${tag} has no matching tag ref`)
    }
    const candidate = await discoverManagedCandidateDetails({
      ref: tagIdentity.commitSha,
      inventory,
      git,
      marker,
    })
    const discovery = candidate.selection
    if (discovery.state === ReleaseState.SUPERSEDED_NOOP) continue
    if (
      discovery.state !== ReleaseState.CANDIDATE_VALIDATED ||
      discovery.candidate.version !== tagIdentity.version ||
      discovery.candidate.commitSha !== tagIdentity.commitSha
    ) {
      throw new Error(`Managed GitHub Release ${tag} is not an active release candidate`)
    }

    const assetResult = await github.listReleaseAssets({ releaseId: release.id })
    const assets = presentList(assetResult, `assets for ${tag}`)
    const records = assets.filter((asset) => asset?.name === "release-record.json")
    if (records.length !== 1) {
      throw new Error(`Managed GitHub Release ${tag} must contain exactly one release-record.json`)
    }
    const record = await downloadJsonAsset(github, records[0], `release record for ${tag}`)
    validateReleaseRecordIdentity(record, tagIdentity)
    const state = await releaseStateFromAssets({
      release,
      releaseRecord: record,
      assets,
      tagIdentity,
      expectedPackageNames: candidate.packageNames,
      abandonmentEnvironment: marker.abandonmentEnvironment,
      github,
    })
    releases.push(
      candidateSelection({
        candidate: discovery.candidate,
        state,
        disposition: "selected",
        tag,
        conflicts: [],
      }),
    )
  }
  return releases
}

async function releaseStateFromAssets({
  release,
  releaseRecord,
  assets,
  tagIdentity,
  expectedPackageNames,
  abandonmentEnvironment,
  github,
}) {
  const auditAssets = assets.filter((asset) => asset?.name === "audit-result.json")
  const abandonmentAssets = assets.filter((asset) => asset?.name === "abandonment.json")
  if (auditAssets.length > 1 || abandonmentAssets.length > 1) {
    throw new Error(`Managed GitHub Release ${tagIdentity.tag} has duplicate terminal evidence`)
  }
  if (auditAssets.length === 1 && abandonmentAssets.length === 1) {
    throw new Error(`Managed GitHub Release ${tagIdentity.tag} has conflicting terminal evidence`)
  }
  if (abandonmentAssets.length === 1) {
    const record = parseAbandonmentRecord(
      await downloadJsonAsset(
        github,
        abandonmentAssets[0],
        `abandonment record for ${tagIdentity.tag}`,
      ),
      {
        candidate: { version: tagIdentity.version, commitSha: tagIdentity.commitSha },
        environment: abandonmentEnvironment,
        packageNames: expectedPackageNames,
      },
    )
    if (record.tag !== tagIdentity.tag) {
      throw new Error(`Managed abandonment record identity does not match ${tagIdentity.tag}`)
    }
    if (release.draft !== true) {
      throw new Error(`Managed abandonment record for ${tagIdentity.tag} requires a draft Release`)
    }
    return ReleaseState.ABANDONED_PREPUBLICATION
  }
  if (auditAssets.length === 1) {
    const record = parseAuditResult(
      await downloadJsonAsset(github, auditAssets[0], `audit result for ${tagIdentity.tag}`),
    )
    validateTerminalIdentity(record, tagIdentity, {
      label: "audit result",
      requireTag: false,
      manifestSha256: releaseRecord.manifestSha256,
    })
    if (record.conclusion === "success") {
      if (release.draft !== false) {
        throw new Error(`Managed audit result for ${tagIdentity.tag} requires a published Release`)
      }
      return ReleaseState.AUDIT_COMPLETE
    }
  }
  return ReleaseState.CANDIDATE_TAGGED
}

async function normalizeManagedTags(records, git) {
  const seen = new Set()
  const tags = []
  for (const record of records) {
    const version = managedVersionFromRef(record?.ref)
    if (version === null) continue
    const tag = `v${version}`
    if (seen.has(tag)) throw new Error(`Managed tag ref ${tag} is duplicated`)
    seen.add(tag)
    if (
      record.object === null ||
      Array.isArray(record.object) ||
      typeof record.object !== "object" ||
      !["commit", "tag"].includes(record.object.type) ||
      !isSha(record.object.sha)
    ) {
      throw new TypeError(`Managed tag ref ${tag} is malformed`)
    }
    const commitSha = await git.resolveTag({ tag })
    if (!isSha(commitSha)) throw new TypeError(`Managed tag ref ${tag} did not resolve exactly`)
    if (record.object.type === "commit" && record.object.sha !== commitSha) {
      throw new Error(`Managed tag ref ${tag} conflicts with local tag identity`)
    }
    tags.push({ tag, version, commitSha })
  }
  tags.sort((left, right) => compareSemver(left.version, right.version))
  return tags
}

function classifyRequiredCi({ sha, checkResult, workflowResult }) {
  if (checkResult?.status !== "PRESENT" || workflowResult?.status !== "PRESENT") {
    return { status: "pending" }
  }
  if (!Array.isArray(checkResult.value) || !Array.isArray(workflowResult.value)) {
    return failedCi(sha, "required-ci-observation-malformed")
  }
  if (checkResult.value.length === 0 && workflowResult.value.length === 0) {
    return { status: "pending" }
  }
  const checks = checkResult.value.filter(
    (check) => check?.name === "validate" && check?.head_sha === sha,
  )
  const workflows = workflowResult.value.filter(
    (run) =>
      run?.name === "CI" && run?.path === ".github/workflows/ci.yml" && run?.head_sha === sha,
  )
  if (checks.length !== 1 || workflows.length !== 1) {
    return failedCi(sha, "required-ci-identity-conflict")
  }
  const [check] = checks
  const [workflow] = workflows
  if (
    !isPositiveId(workflow.id) ||
    !Number.isSafeInteger(workflow.run_attempt) ||
    workflow.run_attempt < 1 ||
    !isPositiveId(workflow.check_suite_id) ||
    !isPositiveId(check?.check_suite?.id) ||
    String(workflow.check_suite_id) !== String(check.check_suite.id)
  ) {
    return failedCi(sha, "required-ci-identity-conflict")
  }
  if (
    (workflow.status === "completed" && workflow.conclusion !== "success") ||
    (check.status === "completed" && check.conclusion !== "success")
  ) {
    return failedCi(sha, "required-ci-terminal-failure")
  }
  if (workflow.status !== "completed" || check.status !== "completed") {
    return { status: "pending" }
  }
  if (workflow.conclusion !== "success" || check.conclusion !== "success") {
    return failedCi(sha, "required-ci-terminal-failure")
  }
  return {
    status: "success",
    retryable: false,
    commitSha: sha,
    workflow: "CI",
    check: "validate",
    runId: workflow.id,
    runAttempt: workflow.run_attempt,
  }
}

function failedCi(sha, reason) {
  return {
    status: "failed",
    retryable: false,
    reason,
    commitSha: sha,
    workflow: "CI",
    check: "validate",
  }
}

async function downloadJsonAsset(github, asset, label) {
  if (!isPositiveId(asset?.id)) throw new TypeError(`${label} asset identity is invalid`)
  const result = await github.downloadReleaseAsset({ assetId: asset.id })
  if (result?.status !== "PRESENT" || typeof result.contentBase64 !== "string") {
    throw new Error(`${label} could not be read exactly`)
  }
  let bytes
  try {
    bytes = Buffer.from(result.contentBase64, "base64")
  } catch (error) {
    throw new TypeError(`${label} is not valid base64`, { cause: error })
  }
  if (bytes.toString("base64") !== result.contentBase64) {
    throw new TypeError(`${label} is not canonical base64`)
  }
  let value
  try {
    value = JSON.parse(UTF8_DECODER.decode(bytes))
  } catch (error) {
    throw new TypeError(`${label} is not valid UTF-8 JSON`, { cause: error })
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must contain a JSON object`)
  }
  return value
}

function validateReleaseRecordIdentity(record, expected) {
  if (
    record.schemaVersion !== 1 ||
    !isReleaseVersion(record.version) ||
    !isSha(record.commitSha) ||
    record.tag !== `v${record.version}` ||
    typeof record.manifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.manifestSha256) ||
    record.version !== expected.version ||
    record.commitSha !== expected.commitSha ||
    record.tag !== expected.tag
  ) {
    throw new Error(`Managed release record identity does not match ${expected.tag}`)
  }
}

function validateTerminalIdentity(record, expected, { label, requireTag, manifestSha256 }) {
  if (
    record.schemaVersion !== 1 ||
    record.version !== expected.version ||
    record.commitSha !== expected.commitSha ||
    (requireTag && record.tag !== expected.tag) ||
    (manifestSha256 !== null && record.manifestSha256 !== manifestSha256)
  ) {
    throw new Error(`Managed ${label} identity does not match ${expected.tag}`)
  }
}

async function commitHasActiveMarker({ commitSha, git, marker }) {
  const tree = await git.listTree({ ref: commitSha })
  if (typeof tree !== "string") throw new TypeError("Candidate tree listing is malformed")
  const paths = new Set(tree.split("\n").filter((path) => path.length > 0))
  if (!paths.has(MARKER_PATH)) return false

  const source = await git.showFile({ ref: commitSha, path: MARKER_PATH })
  let commitMarker
  try {
    commitMarker = JSON.parse(source)
  } catch (error) {
    throw new TypeError("Candidate controller marker is invalid JSON", { cause: error })
  }
  if (!markersEqual(commitMarker, marker)) {
    throw new Error("Candidate controller marker does not match the active release owner")
  }
  return true
}

function normalizeDiscoveryInventory(value, label) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    value.status !== "valid" ||
    !Array.isArray(value.packages) ||
    value.packages.length !== EXPECTED_PACKAGE_COUNT
  ) {
    throw new TypeError(`${label} release inventory must contain exactly 21 fixed-group packages`)
  }
  const packages = value.packages.map((pkg) => {
    if (
      pkg === null ||
      Array.isArray(pkg) ||
      typeof pkg !== "object" ||
      typeof pkg.name !== "string" ||
      pkg.name.length === 0 ||
      !isReleaseVersion(pkg.version)
    ) {
      throw new TypeError(`${label} release inventory package is invalid`)
    }
    return { name: pkg.name, version: pkg.version }
  })
  packages.sort((left, right) => compareText(left.name, right.name))
  const names = packages.map((pkg) => pkg.name)
  if (new Set(names).size !== EXPECTED_PACKAGE_COUNT) {
    throw new TypeError(`${label} release inventory package set contains duplicates`)
  }
  const versions = new Set(packages.map((pkg) => pkg.version))
  if (versions.size !== 1) {
    throw new TypeError(`${label} release inventory version delta is not uniform`)
  }
  return { names, version: packages[0].version }
}

function normalizeActiveMarker(marker) {
  if (!markersEqual(marker, ACTIVE_MARKER)) {
    throw new TypeError("Active release controller marker is invalid")
  }
  return marker
}

function markersEqual(left, right) {
  if (
    left === null ||
    Array.isArray(left) ||
    typeof left !== "object" ||
    right === null ||
    Array.isArray(right) ||
    typeof right !== "object" ||
    !arraysEqual(Object.keys(left).sort(), ACTIVE_MARKER_FIELDS) ||
    !arraysEqual(Object.keys(right).sort(), ACTIVE_MARKER_FIELDS)
  ) {
    return false
  }
  return ACTIVE_MARKER_FIELDS.every((field) => left[field] === right[field])
}

function normalizeTagState(value) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    !["absent", "present", "ambiguous"].includes(value.status) ||
    managedVersionFromTag(value.tag) === null
  ) {
    throw new TypeError("Candidate tag state is invalid")
  }
  if (value.status === "present" ? !isSha(value.commitSha) : value.commitSha !== null) {
    throw new TypeError("Candidate tag state commit identity is invalid")
  }
  return { status: value.status, tag: value.tag, commitSha: value.commitSha }
}

function candidateIdentity(version, commitSha) {
  return deepFreeze({ version, commitSha, ...CANDIDATE_POLICY })
}

function noCandidate() {
  return candidateSelection({
    candidate: null,
    state: ReleaseState.NO_CANDIDATE,
    disposition: "noop",
    tag: null,
    conflicts: [],
  })
}

function candidateSelection(value) {
  return deepFreeze({
    candidate: value.candidate,
    state: value.state,
    disposition: value.disposition,
    tag: value.tag,
    conflicts: value.conflicts,
  })
}

function candidateDetails(selection, packageNames) {
  return deepFreeze({ selection, packageNames: [...packageNames] })
}

function invocationDecision(value) {
  return deepFreeze({
    disposition: value.disposition,
    tagAction: value.tagAction,
    dispatchRef: value.dispatchRef,
    exitBeforePreparation: value.exitBeforePreparation,
    conflicts: value.conflicts,
  })
}

function presentList(result, label) {
  if (result?.status !== "PRESENT" || !Array.isArray(result.value)) {
    throw new Error(`${label} could not be enumerated exactly`)
  }
  return result.value
}

function managedVersionFromRef(ref) {
  return typeof ref === "string" && ref.startsWith("refs/tags/")
    ? managedVersionFromTag(ref.slice("refs/tags/".length))
    : null
}

function managedVersionFromTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) return null
  const version = tag.slice(1)
  return isReleaseVersion(version) && tag === `v${version}` ? version : null
}

function compareSelections(left, right) {
  const comparison = compareSemver(left.candidate.version, right.candidate.version)
  return comparison === 0
    ? compareText(left.candidate.commitSha, right.candidate.commitSha)
    : comparison
}

function assertMethods(value, methods, label) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    methods.some((method) => typeof value[method] !== "function")
  ) {
    throw new TypeError(`${label} does not expose the required named methods`)
  }
}

function assertRef(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/u.test(value) ||
    value.includes("..") ||
    value.includes("//")
  ) {
    throw new TypeError("Invalid candidate discovery ref")
  }
}

function validateSha(value, label) {
  if (!isSha(value)) throw new TypeError(`${label} must be a full lowercase hexadecimal SHA`)
}

function isSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value)
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function isPositiveId(value) {
  return (
    (Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && /^[1-9][0-9]*$/u.test(value))
  )
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
