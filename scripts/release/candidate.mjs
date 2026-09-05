import { createHash } from "node:crypto"
import {
  abandonmentRecordTag,
  canonicalAbandonmentBytes,
  parseAbandonmentReleaseBody,
  parseAnyAbandonmentRecord,
} from "./abandonment.mjs"
import { assertPayloadByteLength, RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import { canonicalReleaseBody, isManagedReleaseForTag, parseReleaseMarker } from "./metadata.mjs"
import { planCandidateArbitration } from "./planner.mjs"
import {
  discoverRecoveryReleaseCandidates,
  readRecoveryReservations,
  routeRecoveryCandidate,
} from "./recovery/observe.mjs"
import { releaseRecordSha256 } from "./release-record.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"
import { ReleaseState } from "./state.mjs"
import { readTerminalRecord } from "./terminal-record-store.mjs"
import { canonicalAuditResultBytes, parseAuditResult } from "./terminal-records.mjs"

const MARKER_PATH = "scripts/release/controller-schema.json"
const PRODUCTION_MAIN_REF = "refs/remotes/origin/main"
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
const TERMINAL_ABANDONMENT_ASSET = "abandonment.json"
const RELEASE_MARKER_TOKEN = "<!-- DAWN_RELEASE_CONTROLLER_MARKER\n"
const MAX_ABANDONMENT_ASSETS = 46
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

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
  const onMain = await git.isAncestor({
    ancestor: commitSha,
    descendant: PRODUCTION_MAIN_REF,
  })
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

export async function discoverScheduledCandidate({
  inventory,
  git,
  github,
  marker,
  terminalRecordRef,
  verifyTerminalAbandonment,
  npm,
  npmAuditFactory,
  attestations,
}) {
  normalizeActiveMarker(marker)
  if (typeof terminalRecordRef !== "string" || terminalRecordRef.length === 0) {
    throw new TypeError("Terminal record ref is invalid")
  }
  assertMethods(
    git,
    ["resolveTag", "listFirstParentHistory", "firstParent", "isAncestor", "listTree", "showFile"],
    "Git reader",
  )
  assertMethods(inventory, ["read"], "inventory reader")
  if (verifyTerminalAbandonment !== undefined && typeof verifyTerminalAbandonment !== "function") {
    throw new TypeError("Terminal abandonment verifier is invalid")
  }
  assertMethods(
    github,
    [
      "listTagRefs",
      "getRef",
      "getGitTag",
      "listReleases",
      "getReleaseByTag",
      "listReleaseAssets",
      "downloadReleaseAsset",
    ],
    "GitHub reader",
  )

  const [tagResult, releaseResult] = await Promise.all([
    github.listTagRefs(),
    github.listReleases(),
  ])
  const tagRecords = presentList(tagResult, "managed tag refs")
  const releaseRecords = presentList(releaseResult, "GitHub Releases")
  const tags = await normalizeManagedTags(tagRecords, git, github)
  const tagsByName = new Map(tags.map((tag) => [tag.tag, tag]))
  // Committed terminal records are authoritative for their version regardless of
  // what the GitHub token can see; a record is read at the controller's own
  // checkout, the same ref the observer uses.
  const recorded = new Map()
  const terminalRecordReader = memoizeListTree(git, terminalRecordRef)
  for (const tag of tags) {
    const terminalRecord = await readTerminalRecord({
      git: terminalRecordReader,
      ref: terminalRecordRef,
      version: tag.version,
    })
    if (terminalRecord === null) continue
    if (
      terminalRecord.commitSha !== tag.commitSha ||
      terminalRecord.tag.name !== tag.tag ||
      terminalRecord.tag.objectSha !== tag.tagObjectSha
    ) {
      throw new Error(`Terminal record for ${tag.tag} does not match the tag peel`)
    }
    recorded.set(tag.tag, terminalRecord)
  }
  const releases = await inspectManagedReleases({
    records: releaseRecords,
    tagsByName,
    recorded,
    inventory,
    git,
    github,
    marker,
    verifyTerminalAbandonment,
    terminalRecordRef,
    npm,
    npmAuditFactory,
    attestations,
    recoveryGit: terminalRecordReader,
  })
  const releasesByTag = new Map(releases.map((release) => [release.tag, release]))
  const standalone = []

  for (const tag of tags) {
    if (releasesByTag.has(tag.tag) || recorded.has(tag.tag)) continue
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

  // These selections exist only as arbitration input: terminal states are
  // filtered out of `incomplete`, so a recorded version is never re-selected.
  for (const [tagName, terminalRecord] of recorded) {
    const discovery = await discoverManagedCandidate({
      ref: terminalRecord.commitSha,
      inventory,
      git,
      marker,
    })
    if (discovery.state === ReleaseState.SUPERSEDED_NOOP) continue
    if (
      discovery.state !== ReleaseState.CANDIDATE_VALIDATED ||
      discovery.candidate.version !== terminalRecord.version ||
      discovery.candidate.commitSha !== terminalRecord.commitSha
    ) {
      throw new Error(`Recorded terminal tag ${tagName} is not an exact release candidate`)
    }
    standalone.push(
      candidateSelection({
        candidate: discovery.candidate,
        state: ReleaseState.ABANDONED_PREPUBLICATION,
        disposition: "selected",
        tag: tagName,
        conflicts: [],
      }),
    )
  }

  const tagged = [...releases, ...standalone].sort(compareSelections)
  const incomplete = tagged.filter(
    (release) =>
      release.state !== ReleaseState.RECOVERY_COMPLETE &&
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

  const history = await git.listFirstParentHistory({
    ref: "main",
    maxCount: 1000,
  })
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
    const discovery = await discoverManagedCandidate({
      ref: sha,
      inventory,
      git,
      marker,
    })
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
  return arbitrateCandidate({
    candidate: newest,
    managedReleases: tagged,
    registryLatest: [],
  })
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
  return planCandidateArbitration({
    candidate,
    managedReleases,
    registryLatest,
  })
}

export function decideInvocation({
  candidateVersion,
  candidateSha,
  githubSha,
  githubRef,
  tagState,
}) {
  if (!isReleaseVersion(candidateVersion)) {
    throw new TypeError("Invocation candidate version must be exact SemVer without build metadata")
  }
  validateSha(candidateSha, "Candidate SHA")
  validateSha(githubSha, "GITHUB_SHA")
  const invocationRef = normalizeGithubRef(githubRef)
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
  const candidateRef = `refs/tags/${tag.tag}`
  if (invocationRef === candidateRef) {
    if (tag.status === "absent") {
      return invocationDecision({
        disposition: "blocked",
        tagAction: null,
        dispatchRef: null,
        exitBeforePreparation: true,
        conflicts: ["candidate-tag-missing-at-invocation-ref"],
      })
    }
    if (githubSha !== candidateSha) {
      return invocationDecision({
        disposition: "blocked",
        tagAction: null,
        dispatchRef: null,
        exitBeforePreparation: true,
        conflicts: ["candidate-invocation-ref-sha-mismatch"],
      })
    }
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

function normalizeGithubRef(value) {
  if (
    typeof value !== "string" ||
    !/^refs\/(?:heads|tags)\/[\x21-\x7e]+$/u.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("\\")
  ) {
    throw new TypeError("GITHUB_REF must be one safe full branch or tag ref")
  }
  return value
}

async function inspectManagedReleases({
  records,
  tagsByName,
  recorded,
  inventory,
  git,
  github,
  marker,
  verifyTerminalAbandonment,
  terminalRecordRef,
  npm,
  npmAuditFactory,
  attestations,
  recoveryGit,
}) {
  const assetReads = new Map()
  const originalGithub = github
  github = {
    ...github,
    listReleaseAssets(args) {
      const key = String(args.releaseId)
      if (!assetReads.has(key)) {
        const pending = Promise.resolve()
          .then(() => originalGithub.listReleaseAssets(args))
          .then(
            (result) => {
              if (result?.status !== "PRESENT") assetReads.delete(key)
              return result
            },
            (error) => {
              assetReads.delete(key)
              throw error
            },
          )
        assetReads.set(key, pending)
      }
      return assetReads.get(key)
    },
  }
  const routingRecords = records.filter((release) => {
    let tag = release.tag_name
    try {
      tag = parseReleaseMarker(release.body).tag
    } catch {
      /* Existing tombstone validation below fails closed. */
    }
    return !recorded.has(tag)
  })
  const recovered = []
  const recoveryTags = new Set()
  const recoverySubjects = new Map(
    [...tagsByName.values()].map((tag) => [
      tag.tag,
      { version: tag.version, commitSha: tag.commitSha, tag: tag.tag },
    ]),
  )
  for (const { intent } of await readRecoveryReservations({
    git: recoveryGit,
    terminalRecordRef,
  })) {
    const c = intent.candidate
    const existing = recoverySubjects.get(c.tag)
    if (existing && existing.commitSha !== c.candidateSha)
      throw new Error("Recovery reservation conflicts with annotated tag")
    recoverySubjects.set(c.tag, { version: c.version, commitSha: c.candidateSha, tag: c.tag })
  }
  for (const c of (
    await discoverRecoveryReleaseCandidates({ github, releaseRecords: routingRecords })
  ).values()) {
    const existing = recoverySubjects.get(c.tag)
    if (existing && existing.commitSha !== c.candidateSha)
      throw new Error("Durable recovery identity conflicts with candidate tag")
    recoverySubjects.set(c.tag, { version: c.version, commitSha: c.candidateSha, tag: c.tag })
  }
  for (const tag of recoverySubjects.values()) {
    if (recorded.has(tag.tag)) continue
    const routed = await routeRecoveryCandidate({
      candidate: candidateIdentity(tag.version, tag.commitSha),
      git: recoveryGit,
      github,
      terminalRecordRef,
      npm,
      npmAuditFactory,
      attestations,
      releaseRecords: routingRecords,
    })
    if (routed !== null) {
      recovered.push(routed)
      recoveryTags.add(tag.tag)
    }
  }
  const managed = []
  for (const release of records) {
    const exactTag = managedVersionFromTag(release?.tag_name) === null ? null : release.tag_name
    const markerTag =
      exactTag === null
        ? [...tagsByName.keys()].find((tag) => isManagedReleaseForTag(release, tag))
        : null
    const tag = exactTag ?? markerTag
    if (
      !recoveryTags.has(tag) &&
      managedVersionFromTag(tag) !== null &&
      isManagedReleaseForTag(release, tag)
    ) {
      managed.push({ release, tag })
    }
  }
  const seenTags = new Set()
  const releases = [...recovered]
  for (const managedRelease of managed) {
    const { release, tag } = managedRelease
    if (seenTags.has(tag)) throw new Error(`Managed GitHub Release ${tag} is duplicated`)
    seenTags.add(tag)
    if (!isPositiveId(release.id) || typeof release.draft !== "boolean") {
      throw new TypeError(`Managed GitHub Release ${tag} is malformed`)
    }
    const tagIdentity = tagsByName.get(tag)
    if (tagIdentity === undefined) {
      throw new Error(`Managed GitHub Release ${tag} has no matching tag ref`)
    }
    // A committed terminal record settles this version, so no Release evidence
    // is read for it: the controller must reach the same classification whether
    // or not its token can see this draft at all. A visible Release must still
    // be the stamped tombstone the record describes, because a recorded version
    // is never re-selected and so is never observed again: a stray, tampered, or
    // published Release on that tag would otherwise go unexamined forever. The
    // marker alone settles it, from data already in hand — no extra reads.
    const terminalRecord = recorded.get(tagIdentity.tag)
    if (terminalRecord !== undefined) {
      const stamped = releaseMarkerIfPresent(release.body)
      if (
        release.draft !== true ||
        release.immutable !== false ||
        stamped?.phase !== "ABANDONED_PREPUBLICATION" ||
        stamped.abandonmentSha256 !== terminalRecord.sha256
      ) {
        throw new Error(
          `Visible Release for recorded ${tagIdentity.tag} is not its stamped tombstone`,
        )
      }
      continue
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

    const assetResult = await github.listReleaseAssets({
      releaseId: release.id,
    })
    const assets = presentList(assetResult, `assets for ${tag}`)
    const abandonmentState = await inspectAbandonmentRelease({
      release,
      assets,
      tagIdentity,
      // The final terminal boundary must revalidate assets with the service.
      github: originalGithub,
      verifyTerminalAbandonment,
    })
    if (abandonmentState !== null) {
      releases.push(
        candidateSelection({
          candidate: discovery.candidate,
          state: abandonmentState.state,
          disposition: abandonmentState.disposition,
          tag,
          conflicts: abandonmentState.conflicts,
        }),
      )
      continue
    }
    const records = assets.filter((asset) => asset?.name === "release-record.json")
    if (records.length !== 1) {
      throw new Error(`Managed GitHub Release ${tag} must contain exactly one release-record.json`)
    }
    const record = await downloadJsonAsset(github, records[0], `release record for ${tag}`, {
      maximumBytes: RELEASE_PAYLOAD_LIMITS.releaseRecordBytes,
    })
    validateReleaseRecordIdentity(record, tagIdentity)
    const state = await releaseStateFromAssets({
      release,
      releaseRecord: record,
      assets,
      tagIdentity,
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

async function releaseStateFromAssets({ release, releaseRecord, assets, tagIdentity, github }) {
  const auditAssets = assets.filter((asset) => asset?.name === "audit-result.json")
  if (auditAssets.length > 1) {
    throw new Error(`Managed GitHub Release ${tagIdentity.tag} has duplicate terminal evidence`)
  }
  if (auditAssets.length === 1) {
    const downloaded = await downloadJsonAsset(
      github,
      auditAssets[0],
      `audit result for ${tagIdentity.tag}`,
      {
        maximumBytes: RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
        includeBytes: true,
      },
    )
    const record = parseAuditResult(downloaded.value)
    validateTerminalIdentity(record, tagIdentity, {
      label: "audit result",
      requireTag: false,
      manifestSha256: releaseRecord.manifestSha256,
    })
    if (record.conclusion === "success") {
      if (release.draft === true) {
        assertExactAuditVerifiedDraft({
          release,
          releaseRecord,
          auditResult: record,
          auditBytes: downloaded.bytes,
          tagIdentity,
        })
      } else if (release.draft !== false) {
        throw new Error(`Managed audit result for ${tagIdentity.tag} has an invalid Release state`)
      }
      // Candidate discovery cannot prove the durable smoke descriptor, exact
      // terminal namespace, or cryptographic Release authority. Keep the
      // candidate nonterminal until the production observer can apply that
      // complete contract; otherwise a plausible audit receipt could let a
      // newer candidate leapfrog an older unproven release.
      return ReleaseState.CANDIDATE_TAGGED
    }
  }
  return ReleaseState.CANDIDATE_TAGGED
}

function assertExactAuditVerifiedDraft({
  release,
  releaseRecord,
  auditResult,
  auditBytes,
  tagIdentity,
}) {
  if (
    release.name !== `Dawn v${tagIdentity.version}` ||
    release.target_commitish !== "main" ||
    release.draft !== true ||
    release.immutable !== false ||
    release.prerelease !== false ||
    typeof release.body !== "string"
  ) {
    throw new Error(`Managed audit result for ${tagIdentity.tag} requires an exact candidate draft`)
  }
  const marker = parseReleaseMarker(release.body)
  if (release.body !== canonicalReleaseBody({ marker, manifest: null })) {
    throw new Error(`Managed audit result for ${tagIdentity.tag} requires a canonical Release body`)
  }
  const canonicalAuditBytes = canonicalAuditResultBytes(auditResult)
  const auditSha256 = sha256(canonicalAuditBytes)
  if (!auditBytes.equals(canonicalAuditBytes)) {
    throw new Error(`Managed audit result for ${tagIdentity.tag} is not canonical`)
  }
  if (
    marker.phase !== "AUDIT_VERIFIED" ||
    marker.version !== tagIdentity.version ||
    marker.commitSha !== tagIdentity.commitSha ||
    marker.tag !== tagIdentity.tag ||
    marker.manifestSha256 !== releaseRecord.manifestSha256 ||
    marker.releaseRecordSha256 !== releaseRecordSha256(releaseRecord) ||
    marker.audit?.workflowRunId !== auditResult.workflowRunId ||
    marker.audit?.runAttempt !== auditResult.runAttempt ||
    marker.audit?.attemptAssetName !==
      `audit-attempt-${auditResult.workflowRunId}-${auditResult.runAttempt}.json` ||
    marker.audit?.attemptSha256 !== auditSha256 ||
    marker.audit?.canonicalSha256 !== auditSha256 ||
    marker.audit?.conclusion !== "success"
  ) {
    throw new Error(
      `Managed audit result for ${tagIdentity.tag} does not match its AUDIT_VERIFIED draft`,
    )
  }
}

async function inspectAbandonmentRelease({
  release,
  assets,
  tagIdentity,
  github,
  verifyTerminalAbandonment,
}) {
  const marker = releaseMarkerIfPresent(release.body)
  const abandonmentRelated =
    marker?.phase === "ABANDONED_PREPUBLICATION" ||
    assets.some((asset) => asset?.name === TERMINAL_ABANDONMENT_ASSET)
  if (!abandonmentRelated) return null

  const inventory = normalizeAbandonmentAssetInventory(assets, tagIdentity.tag)
  const tombstones = inventory.filter((asset) => asset.name === TERMINAL_ABANDONMENT_ASSET)
  const auditAssets = inventory.filter(
    (asset) =>
      asset.name === "audit-result.json" ||
      /^audit-attempt-[1-9][0-9]*-[1-9][0-9]*\.json$/u.test(asset.name),
  )
  if (tombstones.length > 1) {
    throw new Error(`Managed GitHub Release ${tagIdentity.tag} has duplicate abandonment evidence`)
  }
  if (auditAssets.length > 0) {
    throw new Error(`Managed GitHub Release ${tagIdentity.tag} has conflicting terminal evidence`)
  }
  if (release.draft !== true || release.immutable !== false) {
    throw new Error(`Managed abandonment for ${tagIdentity.tag} requires an exact mutable draft`)
  }

  if (marker === null) {
    throw new Error(
      `Managed abandonment evidence for ${tagIdentity.tag} has no exact Release marker`,
    )
  }
  if (
    marker.version !== tagIdentity.version ||
    marker.commitSha !== tagIdentity.commitSha ||
    marker.tag !== tagIdentity.tag
  ) {
    throw new Error(`Managed abandonment marker identity does not match ${tagIdentity.tag}`)
  }

  const terminal = marker.phase === "ABANDONED_PREPUBLICATION"
  if (!terminal && !["ATTACHING", "ESCROWED"].includes(marker.phase)) {
    throw new Error(
      `Managed abandonment evidence for ${tagIdentity.tag} has an illegal predecessor`,
    )
  }
  const bodyTombstone = terminal ? parseAbandonmentReleaseBody(release.body) : null
  const bodyTombstoneBytes =
    bodyTombstone === null ? null : canonicalAbandonmentBytes(bodyTombstone)
  if (terminal) {
    const expectedTitle = `Dawn v${tagIdentity.version} (abandoned before publication)`
    if (
      release.name !== expectedTitle ||
      release.target_commitish !== "main" ||
      release.prerelease !== false
    ) {
      throw new Error(`Managed abandonment Release metadata for ${tagIdentity.tag} is not exact`)
    }
    const terminalArtifact = {
      manifestSha256: marker.manifestSha256,
      releaseRecordSha256: marker.releaseRecordSha256,
      baseAssetSetSha256: marker.baseAssetSetSha256,
      attestationSet: marker.attestationSet,
    }
    if (!jsonValuesEqual(bodyTombstone.predecessor.artifact, terminalArtifact)) {
      throw new Error(`Managed abandonment predecessor for ${tagIdentity.tag} is not exact`)
    }
    if (marker.attestationSet === null) {
      if (
        !["CANDIDATE_TAGGED", "ARTIFACTS_PREPARED"].includes(bodyTombstone.predecessor.state) ||
        bodyTombstone.predecessor.releaseStatus !== "absent" ||
        bodyTombstone.predecessor.releaseId !== null ||
        bodyTombstone.predecessor.bodySha256 !== null ||
        bodyTombstone.predecessor.marker !== null
      ) {
        throw new Error(`Managed early abandonment predecessor for ${tagIdentity.tag} is invalid`)
      }
    } else if (
      bodyTombstone.predecessor.state !== "CANDIDATE_ESCROWED" ||
      bodyTombstone.predecessor.releaseStatus !== "draft" ||
      String(bodyTombstone.predecessor.releaseId) !== String(release.id) ||
      bodyTombstone.predecessor.marker?.phase !== "ESCROWED"
    ) {
      throw new Error(`Managed escrowed abandonment predecessor for ${tagIdentity.tag} is invalid`)
    }
  }

  const baseAssets = validateAbandonmentAssetNamespace({
    inventory,
    marker,
    requireCompleteBase: terminal && marker.attestationSet !== null,
  })

  let tombstoneBytes = null
  let tombstone = null
  if (tombstones.length === 1) {
    const downloaded = await downloadJsonAsset(
      github,
      tombstones[0],
      `abandonment record for ${tagIdentity.tag}`,
      {
        maximumBytes: RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
        includeBytes: true,
      },
    )
    tombstone = parseAnyAbandonmentRecord(downloaded.value)
    if (
      tombstone.version !== tagIdentity.version ||
      tombstone.commitSha !== tagIdentity.commitSha
    ) {
      throw new Error(`Managed abandonment record for ${tagIdentity.tag} names another candidate`)
    }
    tombstoneBytes = canonicalAbandonmentBytes(tombstone)
    if (
      !tombstoneBytes.equals(downloaded.bytes) ||
      abandonmentRecordTag(tombstone) !== tagIdentity.tag
    ) {
      throw new Error(`Managed abandonment record for ${tagIdentity.tag} is not canonical`)
    }
  }

  if (
    bodyTombstoneBytes !== null &&
    tombstoneBytes !== null &&
    !bodyTombstoneBytes.equals(tombstoneBytes)
  ) {
    throw new Error(`Managed abandonment body and asset evidence conflict for ${tagIdentity.tag}`)
  }

  await verifyAbandonmentAssetBytes({
    baseAssets,
    tombstoneBytes: tombstoneBytes ?? bodyTombstoneBytes,
    github,
  })

  if (terminal && bodyTombstoneBytes !== null && tombstoneBytes !== null) {
    if (marker.abandonmentSha256 !== sha256(tombstoneBytes)) {
      throw new Error(`Managed abandonment marker digest conflicts with ${tagIdentity.tag}`)
    }
    if (marker.attestationSet !== null) {
      const verified =
        verifyTerminalAbandonment === undefined
          ? false
          : await verifyTerminalAbandonment({
              candidate: {
                version: tagIdentity.version,
                commitSha: tagIdentity.commitSha,
              },
              release: {
                id: release.id,
                tag: tagIdentity.tag,
                bodySha256: sha256(Buffer.from(release.body, "utf8")),
                abandonmentSha256: marker.abandonmentSha256,
                baseAssetSetSha256: marker.baseAssetSetSha256,
              },
            })
      if (verified !== true) {
        return {
          state: ReleaseState.CANDIDATE_TAGGED,
          disposition: "blocked",
          conflicts: ["abandonment-cryptographic-reverification-required"],
        }
      }
    }
    await revalidateTerminalAbandonmentBoundary({
      release,
      inventory,
      tagIdentity,
      github,
    })
    return {
      state: ReleaseState.ABANDONED_PREPUBLICATION,
      disposition: "selected",
      conflicts: [],
    }
  }
  if (!terminal && tombstoneBytes === null) return null
  return {
    state: ReleaseState.CANDIDATE_TAGGED,
    disposition: "blocked",
    conflicts: [
      terminal
        ? "abandonment-asset-reconciliation-required"
        : "abandonment-marker-reconciliation-required",
    ],
  }
}

async function revalidateTerminalAbandonmentBoundary({ release, inventory, tagIdentity, github }) {
  const [ref, tagObject, exactRelease, exactAssets] = await Promise.all([
    github
      .getRef({ ref: `tags/${tagIdentity.tag}` })
      .then((result) => presentObject(result, `final ref for ${tagIdentity.tag}`)),
    github
      .getGitTag({ tagSha: tagIdentity.tagObjectSha })
      .then((result) => presentObject(result, `final annotated tag for ${tagIdentity.tag}`)),
    github
      .getReleaseByTag({ tag: tagIdentity.tag })
      .then((result) => presentObject(result, `final Release for ${tagIdentity.tag}`)),
    github
      .listReleaseAssets({ releaseId: release.id })
      .then((result) => presentList(result, `final assets for ${tagIdentity.tag}`)),
  ])
  if (
    ref.ref !== `refs/tags/${tagIdentity.tag}` ||
    ref.object?.type !== "tag" ||
    ref.object.sha !== tagIdentity.tagObjectSha ||
    tagObject.tag !== tagIdentity.tag ||
    tagObject.object?.type !== "commit" ||
    tagObject.object.sha !== tagIdentity.commitSha
  ) {
    throw new Error(`Managed terminal tag ${tagIdentity.tag} changed during arbitration`)
  }
  for (const field of [
    "id",
    "tag_name",
    "name",
    "body",
    "target_commitish",
    "draft",
    "immutable",
    "prerelease",
  ]) {
    if (exactRelease[field] !== release[field]) {
      throw new Error(`Managed terminal Release ${tagIdentity.tag} changed during arbitration`)
    }
  }
  const finalInventory = normalizeAbandonmentAssetInventory(exactAssets, tagIdentity.tag)
  const identity = (assets) =>
    assets.map((asset) => `${String(asset.id)}\0${asset.name}`).sort(compareText)
  if (!arraysEqual(identity(inventory), identity(finalInventory))) {
    throw new Error(`Managed terminal assets for ${tagIdentity.tag} changed during arbitration`)
  }
}

function jsonValuesEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    )
  }
  if (
    left === null ||
    Array.isArray(left) ||
    typeof left !== "object" ||
    right === null ||
    Array.isArray(right) ||
    typeof right !== "object"
  ) {
    return false
  }
  const leftKeys = Object.keys(left).sort(compareText)
  const rightKeys = Object.keys(right).sort(compareText)
  return (
    arraysEqual(leftKeys, rightKeys) &&
    leftKeys.every((key) => jsonValuesEqual(left[key], right[key]))
  )
}

/**
 * One full-repository tree listing serves every terminal-record read at `ref`;
 * the wrapper forwards every other read to the reader it was given unchanged.
 */
function memoizeListTree(git, ref) {
  let listing = null
  return {
    ...git,
    listTree(input) {
      if (input?.ref !== ref) return git.listTree(input)
      listing ??= git.listTree(input)
      return listing
    },
  }
}

function releaseMarkerIfPresent(body) {
  if (typeof body !== "string" || !body.includes(RELEASE_MARKER_TOKEN)) return null
  return parseReleaseMarker(body)
}

function normalizeAbandonmentAssetInventory(assets, tag) {
  if (!Array.isArray(assets) || assets.length > MAX_ABANDONMENT_ASSETS) {
    throw new Error(`Managed abandonment asset inventory for ${tag} is malformed or unbounded`)
  }
  const ids = new Set()
  const names = new Set()
  return assets.map((asset) => {
    if (
      asset === null ||
      Array.isArray(asset) ||
      typeof asset !== "object" ||
      !isPositiveId(asset.id) ||
      typeof asset.name !== "string" ||
      Buffer.byteLength(asset.name, "utf8") > 512 ||
      ids.has(String(asset.id)) ||
      names.has(asset.name)
    ) {
      throw new Error(`Managed abandonment asset identity for ${tag} is invalid or duplicate`)
    }
    ids.add(String(asset.id))
    names.add(asset.name)
    return { id: asset.id, name: asset.name }
  })
}

function validateAbandonmentAssetNamespace({ inventory, marker, requireCompleteBase }) {
  const expectedBase = abandonmentMarkerBaseAssets(marker)
  const expectedByName = new Map(expectedBase.map((asset) => [asset.name, asset]))
  const baseAssets = []
  for (const asset of inventory) {
    if (asset.name === TERMINAL_ABANDONMENT_ASSET) continue
    const expected = expectedByName.get(asset.name)
    if (expected === undefined) {
      throw new Error("Managed abandonment Release contains an unexpected asset namespace member")
    }
    assetLimit(asset.name)
    baseAssets.push({ ...asset, expected })
  }
  if (requireCompleteBase && baseAssets.length !== expectedBase.length) {
    throw new Error("Escrowed abandonment runner-loss state has an incomplete base asset set")
  }
  return baseAssets
}

async function verifyAbandonmentAssetBytes({ baseAssets, tombstoneBytes, github }) {
  let cumulativeBytes = tombstoneBytes?.byteLength ?? 0
  for (const asset of baseAssets) {
    const bytes = await downloadAssetBytes(github, asset, assetLimit(asset.name))
    cumulativeBytes += bytes.byteLength
    assertPayloadByteLength(
      cumulativeBytes,
      RELEASE_PAYLOAD_LIMITS.escrowBytes + RELEASE_PAYLOAD_LIMITS.auditReceiptBytes,
      "Managed abandonment evidence",
    )
    if (sha256(bytes) !== asset.expected.sha256) {
      throw new Error(`Managed abandonment base asset ${asset.name} conflicts with its marker`)
    }
  }
}

function abandonmentMarkerBaseAssets(marker) {
  if (marker.attestationSet === null) return []
  const assets = [
    { name: "release-record.json", sha256: marker.releaseRecordSha256 },
    { name: "manifest.json", sha256: marker.manifestSha256 },
    ...marker.attestationSet.subjects.slice(1).map((subject) => ({
      name: subject.subjectName,
      sha256: subject.subjectSha256,
    })),
    ...marker.attestationSet.subjects.map((subject) => ({
      name: subject.bundleName,
      sha256: subject.bundleSha256,
    })),
  ]
  if (
    assets.length !== 45 ||
    new Set(assets.map((asset) => asset.name)).size !== 45 ||
    assets.some((asset) => !SHA256_PATTERN.test(asset.sha256))
  ) {
    throw new Error("Managed abandonment marker base asset set is invalid")
  }
  const digest = sha256(
    Buffer.from(
      `${JSON.stringify(assets.map(({ name, sha256: assetSha256 }) => ({ name, sha256: assetSha256 })))}\n`,
      "utf8",
    ),
  )
  if (digest !== marker.baseAssetSetSha256) {
    throw new Error("Managed abandonment marker base asset-set digest is invalid")
  }
  return assets
}

function assetLimit(name) {
  if (name === "release-record.json") return RELEASE_PAYLOAD_LIMITS.releaseRecordBytes
  if (name === "manifest.json") return RELEASE_PAYLOAD_LIMITS.manifestBytes
  if (name.endsWith(".tgz")) return RELEASE_PAYLOAD_LIMITS.tarballBytes
  if (name.endsWith(".intoto.jsonl")) return RELEASE_PAYLOAD_LIMITS.attestationBundleBytes
  throw new Error("Managed abandonment Release contains an unexpected asset namespace member")
}

async function normalizeManagedTags(records, git, github) {
  if (records.length > 10_000) throw new Error("Managed tag ref inventory exceeds its bound")
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
      record.object.type !== "tag" ||
      !isSha(record.object.sha)
    ) {
      throw new TypeError(`Managed tag ref ${tag} is not one exact annotated tag`)
    }
    const exactRefResult = await github.getRef({ ref: `tags/${tag}` })
    const exactRef = presentObject(exactRefResult, `exact ref for ${tag}`)
    if (
      exactRef.ref !== record.ref ||
      exactRef.object === null ||
      Array.isArray(exactRef.object) ||
      typeof exactRef.object !== "object" ||
      exactRef.object.type !== "tag" ||
      exactRef.object.sha !== record.object.sha
    ) {
      throw new Error(`Managed tag ref ${tag} changed during arbitration`)
    }
    const tagObject = presentObject(
      await github.getGitTag({ tagSha: record.object.sha }),
      `annotated tag for ${tag}`,
    )
    if (
      tagObject.tag !== tag ||
      tagObject.object === null ||
      Array.isArray(tagObject.object) ||
      typeof tagObject.object !== "object" ||
      tagObject.object.type !== "commit" ||
      !isSha(tagObject.object.sha)
    ) {
      throw new Error(`Managed annotated tag ${tag} does not peel to one exact commit`)
    }
    const commitSha = await git.resolveTag({ tag })
    if (!isSha(commitSha)) throw new TypeError(`Managed tag ref ${tag} did not resolve exactly`)
    if (tagObject.object.sha !== commitSha) {
      throw new Error(`Managed tag ref ${tag} conflicts with local tag identity`)
    }
    tags.push({ tag, version, commitSha, tagObjectSha: record.object.sha })
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
  const namedChecks = checkResult.value.filter(
    (check) => check?.name === "validate" && check?.head_sha === sha,
  )
  const workflows = workflowResult.value.filter(
    (run) =>
      run?.name === "CI" &&
      run?.path === ".github/workflows/ci.yml" &&
      run?.head_sha === sha &&
      run?.head_branch === "main" &&
      run?.event === "push",
  )
  if (workflows.length !== 1) {
    return failedCi(sha, "required-ci-identity-conflict")
  }
  const [workflow] = workflows
  if (
    !isPositiveId(workflow.id) ||
    !Number.isSafeInteger(workflow.run_attempt) ||
    workflow.run_attempt < 1 ||
    !isPositiveId(workflow.check_suite_id) ||
    namedChecks.some((check) => !isPositiveId(check?.check_suite?.id))
  ) {
    return failedCi(sha, "required-ci-identity-conflict")
  }
  const checks = namedChecks.filter(
    (check) => String(check.check_suite.id) === String(workflow.check_suite_id),
  )
  if (checks.length !== 1) return failedCi(sha, "required-ci-identity-conflict")
  const [check] = checks
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

async function downloadJsonAsset(github, asset, label, { maximumBytes, includeBytes = false }) {
  if (!isPositiveId(asset?.id)) throw new TypeError(`${label} asset identity is invalid`)
  const result = await github.downloadReleaseAsset({
    assetId: asset.id,
    maximumBytes,
  })
  if (!isExactAssetDownload(result)) {
    throw new Error(`${label} could not be read exactly`)
  }
  assertPayloadByteLength(
    Buffer.byteLength(result.contentBase64, "utf8"),
    Math.ceil(maximumBytes / 3) * 4,
    `${label} base64`,
  )
  const bytes = Buffer.from(result.contentBase64, "base64")
  if (bytes.toString("base64") !== result.contentBase64) {
    throw new TypeError(`${label} is not canonical base64`)
  }
  assertPayloadByteLength(bytes.byteLength, maximumBytes, label)
  let value
  try {
    value = JSON.parse(UTF8_DECODER.decode(bytes))
  } catch (error) {
    throw new TypeError(`${label} is not valid UTF-8 JSON`, { cause: error })
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must contain a JSON object`)
  }
  return includeBytes ? { value, bytes } : value
}

async function downloadAssetBytes(github, asset, maximumBytes) {
  const result = await github.downloadReleaseAsset({
    assetId: asset.id,
    maximumBytes,
  })
  if (!isExactAssetDownload(result)) {
    throw new Error(`Managed abandonment asset ${asset.name} could not be read exactly`)
  }
  assertPayloadByteLength(
    Buffer.byteLength(result.contentBase64, "utf8"),
    Math.ceil(maximumBytes / 3) * 4,
    `Managed abandonment asset ${asset.name} base64`,
  )
  const bytes = Buffer.from(result.contentBase64, "base64")
  if (bytes.toString("base64") !== result.contentBase64) {
    throw new Error(`Managed abandonment asset ${asset.name} is not canonical base64`)
  }
  assertPayloadByteLength(bytes.byteLength, maximumBytes, `Managed abandonment asset ${asset.name}`)
  return bytes
}

function isExactAssetDownload(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).length === 5 &&
    ["status", "operation", "httpStatus", "code", "contentBase64"].every((field) =>
      Object.hasOwn(value, field),
    ) &&
    value.status === "PRESENT" &&
    value.operation === "release-asset-download" &&
    value.httpStatus === 200 &&
    value.code === null &&
    typeof value.contentBase64 === "string"
  )
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
    throw new TypeError("Candidate controller marker is invalid JSON", {
      cause: error,
    })
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
    const error = new Error(`${label} could not be enumerated exactly`)
    if (typeof result?.code === "string" && /^[A-Z][A-Z0-9_-]{0,127}$/u.test(result.code)) {
      Object.defineProperty(error, "code", {
        value: result.code,
        enumerable: true,
      })
    }
    throw error
  }
  return result.value
}

function presentObject(result, label) {
  if (
    result?.status !== "PRESENT" ||
    result.value === null ||
    Array.isArray(result.value) ||
    typeof result.value !== "object"
  ) {
    const error = new Error(`${label} could not be observed exactly`)
    if (typeof result?.code === "string" && /^[A-Z][A-Z0-9_-]{0,127}$/u.test(result.code)) {
      Object.defineProperty(error, "code", {
        value: result.code,
        enumerable: true,
      })
    }
    throw error
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
