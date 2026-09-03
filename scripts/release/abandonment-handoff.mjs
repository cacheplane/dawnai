import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  canonicalAbandonmentArtifactContextBytes,
  parseAbandonmentArtifactContext,
  parseAbandonmentReleaseBody,
} from "./abandonment.mjs"
import { snapshotJson } from "./adapter-normalize.mjs"
import { isManagedReleaseForTag, parseReleaseMarker, releaseBodySha256 } from "./metadata.mjs"
import {
  classifyProductionEvent as defaultClassifyProductionEvent,
  createProductionInventoryReader as defaultCreateProductionInventoryReader,
  observeProductionCandidate as defaultObserveProductionCandidate,
  resolveProductionCandidate as defaultResolveProductionCandidate,
} from "./observe.mjs"
import { planRelease as defaultPlanRelease } from "./planner.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"

const INPUT_FIELDS = Object.freeze(["candidate", "environment"])
const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const ENVIRONMENT_FIELDS = Object.freeze([
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_WORKFLOW_REF",
])
const DEPENDENCY_FIELDS = Object.freeze([
  "root",
  "git",
  "github",
  "npm",
  "npmAuditFactory",
  "attestations",
  "marker",
  "inventory",
  "classifyProductionEvent",
  "resolveProductionCandidate",
  "observeProductionCandidate",
  "createProductionInventoryReader",
  "planRelease",
])
const LEGAL_PREDECESSORS = new Set(["CANDIDATE_TAGGED", "ARTIFACTS_PREPARED", "CANDIDATE_ESCROWED"])
const EXPECTED_PREDECESSOR_TRANSITIONS = Object.freeze({
  CANDIDATE_TAGGED: "prepare-artifacts",
  ARTIFACTS_PREPARED: "attest-artifacts",
  CANDIDATE_ESCROWED: "publish-npm-packages",
})
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const ASSET_NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/u
const MAX_RELEASES = 10_000
const MAX_ASSETS = 46
const MAX_ROOT_BYTES = 4_096

export { canonicalAbandonmentArtifactContextBytes, parseAbandonmentArtifactContext }

export async function createAbandonmentArtifactContext(input, dependencies) {
  validateDataBag(input, INPUT_FIELDS, "Abandonment context input")
  validateDataBag(dependencies, DEPENDENCY_FIELDS, "Abandonment context dependencies", {
    allowMissing: true,
  })
  const source = snapshotJson(input)
  const candidate = validateCandidate(source.candidate)
  validateEnvironment(source.environment, candidate)
  const root = dependency(dependencies, "root")
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    Buffer.byteLength(root, "utf8") > MAX_ROOT_BYTES ||
    containsAsciiControl(root)
  ) {
    throw new TypeError("Abandonment context production root must be absolute and bounded")
  }
  const git = dependency(dependencies, "git")
  const github = dependency(dependencies, "github")
  const npm = dependency(dependencies, "npm")
  const npmAuditFactory = optionalDependency(dependencies, "npmAuditFactory")
  const attestations = dependency(dependencies, "attestations")
  const marker = dependency(dependencies, "marker")
  const classifyProductionEvent =
    optionalFunctionDependency(dependencies, "classifyProductionEvent") ??
    defaultClassifyProductionEvent
  const resolveProductionCandidate =
    optionalFunctionDependency(dependencies, "resolveProductionCandidate") ??
    defaultResolveProductionCandidate
  const observeProductionCandidate =
    optionalFunctionDependency(dependencies, "observeProductionCandidate") ??
    defaultObserveProductionCandidate
  const createProductionInventoryReader =
    optionalFunctionDependency(dependencies, "createProductionInventoryReader") ??
    defaultCreateProductionInventoryReader
  const planRelease = optionalFunctionDependency(dependencies, "planRelease") ?? defaultPlanRelease
  const inventory =
    optionalDependency(dependencies, "inventory") ?? createProductionInventoryReader({ root, git })
  requireMethod(inventory, "read", "production inventory reader")

  const event = deepFreeze({
    inputs: { version: candidate.version, commitSha: candidate.commitSha },
  })
  classifyProductionEvent(event)
  const immutableInventory = await inventory.read({ ref: candidate.commitSha })
  const durableRecovery = await captureDurableAbandonmentContext({ candidate, github })
  if (durableRecovery !== null) {
    await verifyExactAnnotatedTag({ candidate, github })
    return durableRecovery
  }
  const selection = validateSelection(
    await resolveProductionCandidate({
      event,
      inventory,
      git,
      github,
      npm,
      ...(npmAuditFactory === undefined ? {} : { npmAuditFactory }),
      attestations,
      marker,
      // Known limitation: the dormant protected-abandonment handoff reads the terminal record at
      // the candidate commit, which by construction predates any record, so a git-resident record
      // cannot stop it. This path is disabled by the 2026-08-25 design and any reactivation must
      // supply an explicit operator-provided ref (as the recovery CLI does with reviewedCommit).
      terminalRecordRef: candidate.commitSha,
    }),
    candidate,
  )
  const observed = snapshotJson(
    await observeProductionCandidate({
      candidate,
      inventory: immutableInventory,
      marker,
      git,
      github,
      npm,
      ...(npmAuditFactory === undefined ? {} : { npmAuditFactory }),
      attestations,
      // Known limitation: the dormant protected-abandonment handoff reads the terminal record at
      // the candidate commit, which by construction predates any record, so a git-resident record
      // cannot stop it. This path is disabled by the 2026-08-25 design and any reactivation must
      // supply an explicit operator-provided ref (as the recovery CLI does with reviewedCommit).
      terminalRecordRef: candidate.commitSha,
    }),
  )
  assertExactFields(observed, ["observation", "diagnostics"], "production observation result")
  if (!Array.isArray(observed.diagnostics) || observed.diagnostics.length !== 0) {
    throw classifiedError(
      "ABANDONMENT_PRODUCTION_DIAGNOSTICS",
      "Abandonment context requires a production observation with zero diagnostics",
    )
  }
  const observation = observed.observation
  const initialPlan = snapshotJson(planRelease({ candidate, observation, mode: "controller" }))
  if (
    initialPlan.state !== selection.state ||
    !Array.isArray(initialPlan.conflicts) ||
    initialPlan.conflicts.length !== 0 ||
    initialPlan.disposition === "blocked"
  ) {
    throw classifiedError(
      "ABANDONMENT_PRODUCTION_CONFLICT",
      "Abandonment context production selection and plan conflict",
    )
  }
  if (
    observation.release?.marker?.phase === "ATTACHING" ||
    initialPlan.state === "ARTIFACTS_ATTESTED"
  ) {
    throw classifiedError(
      "ABANDONMENT_RESUME_ESCROW_FIRST",
      "Abandonment context must resume escrow first and reach exact CANDIDATE_ESCROWED",
    )
  }
  if (!LEGAL_PREDECESSORS.has(initialPlan.state)) {
    throw classifiedError(
      "ABANDONMENT_STATE_NOT_ELIGIBLE",
      `Abandonment is not permitted from production state ${String(initialPlan.state)}`,
    )
  }
  if (
    initialPlan.disposition !== "would-transition" ||
    initialPlan.nextTransition !== EXPECTED_PREDECESSOR_TRANSITIONS[initialPlan.state]
  ) {
    throw classifiedError(
      "ABANDONMENT_PRODUCTION_CONFLICT",
      "Abandonment context production plan is not the exact predecessor transition",
    )
  }
  assertExactTagObservation(observation.tag, candidate)
  if (
    observation.abandonment?.requested !== false ||
    observation.abandonment?.recorded !== false ||
    observation.abandonment?.predecessor !== null
  ) {
    throw classifiedError(
      "ABANDONMENT_STATE_NOT_ELIGIBLE",
      "Abandonment context requires an unrequested nonterminal candidate",
    )
  }

  const requestedObservation = snapshotJson(observation)
  requestedObservation.abandonment = {
    requested: true,
    recorded: false,
    predecessor: null,
  }
  const requestedPlan = snapshotJson(
    planRelease({ candidate, observation: requestedObservation, mode: "controller" }),
  )
  if (
    requestedPlan.state !== initialPlan.state ||
    requestedPlan.disposition !== "would-transition" ||
    requestedPlan.nextTransition !== "record-prepublication-abandonment" ||
    !Array.isArray(requestedPlan.conflicts) ||
    requestedPlan.conflicts.length !== 0
  ) {
    throw classifiedError(
      "ABANDONMENT_PLAN_NOT_AUTHORIZED",
      "Abandonment request did not recompute to the exact protected transition",
    )
  }

  const artifact = artifactContextFromObservation(initialPlan.state, observation)
  await verifyExactAnnotatedTag({ candidate, github })
  const release = await captureExactReleaseContext({
    candidate,
    predecessor: initialPlan.state,
    artifact,
    observation,
    github,
  })
  return parseAbandonmentArtifactContext(
    {
      predecessor: initialPlan.state,
      tag: {
        status: "present",
        annotated: true,
        tag: `v${candidate.version}`,
        commitSha: candidate.commitSha,
      },
      newerReleaseInterleaved: false,
      artifact,
      release,
    },
    { candidate },
  )
}

async function captureDurableAbandonmentContext({ candidate, github }) {
  const listReleases = requireMethod(github, "listReleases", "GitHub production reader")
  const releases = await readPresent(listReleases({}), "releases")
  if (!Array.isArray(releases) || releases.length > MAX_RELEASES) {
    throw new Error("Abandonment recovery GitHub Release list is malformed or unbounded")
  }
  const ids = new Set()
  const matches = []
  for (const release of releases) {
    if (
      !isRecord(release) ||
      !isPositiveInteger(release.id) ||
      typeof release.tag_name !== "string" ||
      ids.has(String(release.id))
    ) {
      throw new Error("Abandonment recovery GitHub Release identity is malformed or duplicate")
    }
    ids.add(String(release.id))
    if (isManagedReleaseForTag(release, `v${candidate.version}`)) matches.push(release)
    if (
      release.tag_name.startsWith("v") &&
      isReleaseVersion(release.tag_name.slice(1)) &&
      compareSemver(release.tag_name.slice(1), candidate.version) > 0
    ) {
      throw new Error("A newer GitHub Release interleaved before abandonment recovery")
    }
  }
  if (matches.length === 0) return null
  if (matches.length !== 1) {
    throw new Error("Abandonment recovery requires one exact candidate Release")
  }

  const listed = normalizeRecoveryDraftRelease(matches[0], candidate, { bodyRequired: false })
  const getRelease = requireMethod(github, "getRelease", "GitHub production reader")
  const exact = normalizeRecoveryDraftRelease(
    await readPresent(getRelease({ releaseId: listed.id }), "release"),
    candidate,
    { bodyRequired: true },
  )
  if (
    listed.id !== exact.id ||
    listed.name !== exact.name ||
    listed.targetCommitish !== exact.targetCommitish ||
    listed.draft !== exact.draft ||
    listed.immutable !== exact.immutable ||
    (listed.body !== null && listed.body !== exact.body)
  ) {
    throw new Error("Abandonment recovery Release identity or body changed during capture")
  }
  const marker = parseReleaseMarker(exact.body)
  const listReleaseAssets = requireMethod(github, "listReleaseAssets", "GitHub production reader")
  const assets = normalizeAssets(
    await readPresent(listReleaseAssets({ releaseId: exact.id }), "release-assets"),
  )
  const abandonmentAssets = assets.filter((asset) => asset.name === "abandonment.json")
  if (abandonmentAssets.length > 1) {
    throw new Error("Abandonment recovery Release contains duplicate terminal assets")
  }

  let predecessor
  let artifact
  if (marker.phase === "ABANDONED_PREPUBLICATION") {
    const tombstone = parseAbandonmentReleaseBody(exact.body)
    predecessor = tombstone.predecessor.state
    artifact = snapshotJson(tombstone.predecessor.artifact)
    if (
      abandonmentAssets.length === 1 &&
      abandonmentAssets[0].sha256 !== marker.abandonmentSha256
    ) {
      throw new Error("Abandonment recovery terminal asset conflicts with the Release marker")
    }
  } else if (marker.phase === "ESCROWED" && abandonmentAssets.length === 1) {
    predecessor = "CANDIDATE_ESCROWED"
    artifact = markerArtifact(marker)
  } else {
    return null
  }

  const expectedTitle =
    marker.phase === "ABANDONED_PREPUBLICATION"
      ? `Dawn v${candidate.version} (abandoned before publication)`
      : `Dawn v${candidate.version}`
  if (exact.name !== expectedTitle) {
    throw new Error("Abandonment recovery Release title conflicts with its phase")
  }
  return parseAbandonmentArtifactContext(
    {
      predecessor,
      tag: {
        status: "present",
        annotated: true,
        tag: `v${candidate.version}`,
        commitSha: candidate.commitSha,
      },
      newerReleaseInterleaved: false,
      artifact,
      release: {
        status: "draft",
        releaseId: exact.id,
        bodySha256: releaseBodySha256(exact.body),
        marker,
        assets: assets.map(({ id, name, sha256 }) => ({ id, name, sha256 })),
      },
    },
    { candidate },
  )
}

async function verifyExactAnnotatedTag({ candidate, github }) {
  const getRef = requireMethod(github, "getRef", "GitHub production reader")
  const ref = snapshotJson(await readPresent(getRef({ ref: `tags/v${candidate.version}` }), "ref"))
  if (
    ref.ref !== `refs/tags/v${candidate.version}` ||
    !isRecord(ref.object) ||
    ref.object.type !== "tag" ||
    !SHA_PATTERN.test(ref.object.sha)
  ) {
    throw classifiedError(
      "ABANDONMENT_TAG_NOT_EXACT",
      "Abandonment context requires one exact annotated candidate tag",
    )
  }
  const getGitTag = requireMethod(github, "getGitTag", "GitHub production reader")
  const annotated = snapshotJson(
    await readPresent(getGitTag({ tagSha: ref.object.sha }), "git-tag"),
  )
  if (
    annotated.tag !== `v${candidate.version}` ||
    !isRecord(annotated.object) ||
    annotated.object.type !== "commit" ||
    annotated.object.sha !== candidate.commitSha
  ) {
    throw classifiedError(
      "ABANDONMENT_TAG_NOT_EXACT",
      "Abandonment context annotated tag identity does not match the candidate",
    )
  }
}

function validateSelection(value, candidate) {
  const selection = snapshotJson(value)
  assertExactFields(
    selection,
    ["candidate", "state", "disposition", "tag", "conflicts"],
    "production candidate selection",
  )
  if (
    !isDeepStrictEqual(selection.candidate, candidate) ||
    selection.disposition !== "selected" ||
    selection.tag !== `v${candidate.version}` ||
    !Array.isArray(selection.conflicts) ||
    selection.conflicts.length !== 0
  ) {
    throw classifiedError(
      "ABANDONMENT_CANDIDATE_NOT_EXACT",
      "Abandonment context requires one exact selected production candidate",
    )
  }
  return selection
}

function artifactContextFromObservation(predecessor, observation) {
  if (predecessor === "CANDIDATE_TAGGED") {
    if (observation.artifacts?.status !== "absent" || observation.release?.status !== "absent") {
      throw classifiedError(
        "ABANDONMENT_CONTEXT_AMBIGUOUS",
        "Tagged abandonment production evidence is not exactly absent",
      )
    }
    return emptyArtifact()
  }
  if (predecessor === "ARTIFACTS_PREPARED") {
    if (
      observation.artifacts?.status !== "prepared" ||
      observation.release?.status !== "absent" ||
      !SHA256_PATTERN.test(observation.artifacts.manifestSha256) ||
      !SHA256_PATTERN.test(observation.artifacts.releaseRecordAsset?.sha256)
    ) {
      throw classifiedError(
        "ABANDONMENT_CONTEXT_AMBIGUOUS",
        "Prepared abandonment production evidence is not exact",
      )
    }
    return {
      manifestSha256: observation.artifacts.manifestSha256,
      releaseRecordSha256: observation.artifacts.releaseRecordAsset.sha256,
      baseAssetSetSha256: null,
      attestationSet: null,
    }
  }
  const releaseMarker = observation.release?.marker
  if (
    observation.artifacts?.status !== "attested" ||
    observation.escrow?.status !== "present" ||
    observation.release?.status !== "draft" ||
    releaseMarker?.phase !== "ESCROWED"
  ) {
    throw classifiedError(
      "ABANDONMENT_CONTEXT_AMBIGUOUS",
      "Escrowed abandonment production evidence is not exact",
    )
  }
  return snapshotJson({
    manifestSha256: releaseMarker.manifestSha256,
    releaseRecordSha256: releaseMarker.releaseRecordSha256,
    baseAssetSetSha256: releaseMarker.baseAssetSetSha256,
    attestationSet: releaseMarker.attestationSet,
  })
}

async function captureExactReleaseContext({
  candidate,
  predecessor,
  artifact,
  observation,
  github,
}) {
  const listReleases = requireMethod(github, "listReleases", "GitHub production reader")
  const releases = await readPresent(listReleases({}), "releases")
  if (!Array.isArray(releases) || releases.length > MAX_RELEASES) {
    throw new Error("Abandonment context GitHub Release list is malformed or unbounded")
  }
  const ids = new Set()
  const matches = []
  for (const release of releases) {
    if (
      !isRecord(release) ||
      !isPositiveInteger(release.id) ||
      typeof release.tag_name !== "string" ||
      ids.has(String(release.id))
    ) {
      throw new Error("Abandonment context GitHub Release identity is malformed or duplicate")
    }
    ids.add(String(release.id))
    if (isManagedReleaseForTag(release, `v${candidate.version}`)) matches.push(release)
    if (release.tag_name.startsWith("v") && isReleaseVersion(release.tag_name.slice(1))) {
      if (compareSemver(release.tag_name.slice(1), candidate.version) > 0) {
        throw new Error("A newer GitHub Release interleaved before abandonment context capture")
      }
    }
  }
  if (predecessor !== "CANDIDATE_ESCROWED") {
    if (matches.length !== 0 || observation.release.status !== "absent") {
      throw new Error("Abandonment context Release absence changed during capture")
    }
    return absentRelease()
  }
  if (matches.length !== 1) {
    throw new Error("Abandonment context requires one exact escrowed candidate Release")
  }
  const listed = normalizeDraftRelease(matches[0], candidate, { bodyRequired: false })
  const getRelease = requireMethod(github, "getRelease", "GitHub production reader")
  const exact = normalizeDraftRelease(
    await readPresent(getRelease({ releaseId: listed.id }), "release"),
    candidate,
    { bodyRequired: true },
  )
  if (
    listed.id !== exact.id ||
    listed.name !== exact.name ||
    listed.targetCommitish !== exact.targetCommitish ||
    listed.draft !== exact.draft ||
    listed.immutable !== exact.immutable ||
    (listed.body !== null && listed.body !== exact.body) ||
    releaseBodySha256(exact.body) !== observation.release.bodySha256
  ) {
    throw new Error("Abandonment context Release identity or body changed during capture")
  }
  const parsedMarker = parseReleaseMarker(exact.body)
  if (!isDeepStrictEqual(parsedMarker, observation.release.marker)) {
    throw new Error("Abandonment context Release marker changed during capture")
  }
  const markerArtifact = {
    manifestSha256: parsedMarker.manifestSha256,
    releaseRecordSha256: parsedMarker.releaseRecordSha256,
    baseAssetSetSha256: parsedMarker.baseAssetSetSha256,
    attestationSet: parsedMarker.attestationSet,
  }
  if (parsedMarker.phase !== "ESCROWED" || !isDeepStrictEqual(markerArtifact, artifact)) {
    throw new Error("Abandonment context Release is not the exact escrowed predecessor")
  }

  const listReleaseAssets = requireMethod(github, "listReleaseAssets", "GitHub production reader")
  const assets = normalizeAssets(
    await readPresent(listReleaseAssets({ releaseId: exact.id }), "release-assets"),
  )
  if (
    !exactObservedAssets(assets, observation.release.assets) ||
    !exactObservedAssets(assets, observation.escrow.assets)
  ) {
    throw new Error("Abandonment context Release asset namespace changed during capture")
  }
  return {
    status: "draft",
    releaseId: exact.id,
    bodySha256: observation.release.bodySha256,
    marker: parsedMarker,
    assets: assets.map(({ id, name, sha256 }) => ({ id, name, sha256 })),
  }
}

function normalizeDraftRelease(value, candidate, { bodyRequired }) {
  const release = snapshotJson(value)
  if (
    !isRecord(release) ||
    !isPositiveInteger(release.id) ||
    release.name !== `Dawn v${candidate.version}` ||
    release.target_commitish !== "main" ||
    release.draft !== true ||
    release.immutable !== false ||
    release.prerelease !== false ||
    !(
      typeof release.body === "string" ||
      (!bodyRequired && (release.body === undefined || release.body === null))
    )
  ) {
    throw new Error("Abandonment context requires the exact mutable candidate draft")
  }
  return {
    id: release.id,
    name: release.name,
    tag: `v${candidate.version}`,
    targetCommitish: release.target_commitish,
    draft: release.draft,
    immutable: release.immutable,
    body: release.body ?? null,
  }
}

function normalizeRecoveryDraftRelease(value, candidate, { bodyRequired }) {
  const release = snapshotJson(value)
  if (
    !isRecord(release) ||
    !isPositiveInteger(release.id) ||
    ![
      `Dawn v${candidate.version}`,
      `Dawn v${candidate.version} (abandoned before publication)`,
    ].includes(release.name) ||
    release.target_commitish !== "main" ||
    release.draft !== true ||
    release.immutable !== false ||
    release.prerelease !== false ||
    !(
      typeof release.body === "string" ||
      (!bodyRequired && (release.body === undefined || release.body === null))
    )
  ) {
    throw new Error("Abandonment recovery requires the exact mutable candidate draft")
  }
  return {
    id: release.id,
    name: release.name,
    targetCommitish: release.target_commitish,
    draft: release.draft,
    immutable: release.immutable,
    body: release.body ?? null,
  }
}

function markerArtifact(marker) {
  return {
    manifestSha256: marker.manifestSha256,
    releaseRecordSha256: marker.releaseRecordSha256,
    baseAssetSetSha256: marker.baseAssetSetSha256,
    attestationSet: marker.attestationSet,
  }
}

function normalizeAssets(value) {
  const assets = snapshotJson(value)
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) {
    throw new Error("Abandonment context Release asset inventory is malformed or unbounded")
  }
  const ids = new Set()
  const names = new Set()
  return assets.map((asset) => {
    const digest =
      typeof asset?.digest === "string" && asset.digest.startsWith("sha256:")
        ? asset.digest.slice("sha256:".length)
        : null
    if (
      !isRecord(asset) ||
      !isPositiveInteger(asset.id) ||
      typeof asset.name !== "string" ||
      !ASSET_NAME_PATTERN.test(asset.name) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      !SHA256_PATTERN.test(digest) ||
      ids.has(String(asset.id)) ||
      names.has(asset.name)
    ) {
      throw new Error("Abandonment context Release asset identity is invalid or duplicate")
    }
    ids.add(String(asset.id))
    names.add(asset.name)
    return { id: asset.id, name: asset.name, sha256: digest }
  })
}

function exactObservedAssets(actual, observed) {
  return (
    Array.isArray(observed) &&
    actual.length === observed.length &&
    actual.every(
      (asset, index) =>
        observed[index]?.name === asset.name &&
        observed[index]?.status === "matching" &&
        observed[index]?.sha256 === asset.sha256,
    )
  )
}

async function readPresent(promise, operation) {
  const envelope = snapshotJson(await promise)
  assertExactFields(
    envelope,
    ["status", "operation", "httpStatus", "code", "value"],
    `GitHub ${operation} envelope`,
  )
  if (
    envelope.status !== "PRESENT" ||
    envelope.operation !== operation ||
    !Number.isInteger(envelope.httpStatus) ||
    envelope.httpStatus < 200 ||
    envelope.httpStatus >= 300 ||
    envelope.code !== null
  ) {
    throw new Error(`Abandonment context GitHub ${operation} observation is not exact`)
  }
  return envelope.value
}

function validateCandidate(value) {
  const candidate = snapshotJson(value)
  assertExactFields(candidate, CANDIDATE_FIELDS, "abandonment context candidate")
  if (
    !isReleaseVersion(candidate.version) ||
    !SHA_PATTERN.test(candidate.commitSha) ||
    candidate.ciWorkflow !== "CI" ||
    candidate.ciCheck !== "validate" ||
    candidate.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Abandonment context candidate identity is invalid")
  }
  return deepFreeze(candidate)
}

function validateEnvironment(value, candidate) {
  const environment = snapshotJson(value)
  assertExactFields(environment, ENVIRONMENT_FIELDS, "abandonment context environment")
  const expected = {
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_REF: `refs/tags/v${candidate.version}`,
    GITHUB_SHA: candidate.commitSha,
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/release.yml@refs/tags/v${candidate.version}`,
  }
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (environment[name] !== expectedValue) {
      throw new Error(`Abandonment context environment ${name} does not match the candidate`)
    }
  }
  for (const name of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    if (
      typeof environment[name] !== "string" ||
      !/^[1-9][0-9]*$/u.test(environment[name]) ||
      !Number.isSafeInteger(Number(environment[name])) ||
      String(Number(environment[name])) !== environment[name]
    ) {
      throw new TypeError(`Abandonment context environment ${name} is invalid`)
    }
  }
  return deepFreeze(environment)
}

function assertExactTagObservation(tag, candidate) {
  if (
    !isRecord(tag) ||
    Object.keys(tag).length !== 2 ||
    tag.status !== "present" ||
    tag.commitSha !== candidate.commitSha
  ) {
    throw classifiedError(
      "ABANDONMENT_TAG_NOT_EXACT",
      "Abandonment context requires the exact annotated production tag",
    )
  }
}

function emptyArtifact() {
  return {
    manifestSha256: null,
    releaseRecordSha256: null,
    baseAssetSetSha256: null,
    attestationSet: null,
  }
}

function absentRelease() {
  return { status: "absent", releaseId: null, bodySha256: null, marker: null, assets: [] }
}

function validateDataBag(value, fields, label, { allowMissing = false } = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${label} must be one plain data object`)
  }
  const actual = Reflect.ownKeys(value)
  for (const key of actual) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : null
    if (
      typeof key !== "string" ||
      !fields.includes(key) ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(`${label} contains an unknown or unsafe field`)
    }
  }
  if (
    !allowMissing &&
    (actual.length !== fields.length || fields.some((field) => !actual.includes(field)))
  ) {
    throw new TypeError(`${label} fields must be exact`)
  }
}

function dependency(dependencies, name) {
  const value = optionalDependency(dependencies, name)
  if (value === undefined) throw new TypeError(`Abandonment context dependency ${name} is required`)
  return value
}

function optionalFunctionDependency(dependencies, name) {
  const value = optionalDependency(dependencies, name)
  if (value !== undefined && typeof value !== "function") {
    throw new TypeError(`Abandonment context dependency ${name} must be a function`)
  }
  return value
}

function optionalDependency(dependencies, name) {
  const descriptor = Object.getOwnPropertyDescriptor(dependencies, name)
  if (descriptor === undefined) return undefined
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`Abandonment context dependency ${name} is unsafe`)
  }
  return descriptor.value
}

function requireMethod(value, name, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`)
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    throw new TypeError(`${label} method ${name} is invalid`)
  }
  return descriptor.value.bind(value)
}

function assertExactFields(value, fields, label) {
  const actual = isRecord(value) ? Object.keys(value).sort(compareText) : []
  const expected = [...fields].sort(compareText)
  if (!isRecord(value) || !arraysEqual(actual, expected)) {
    throw new TypeError(`${label} fields must be exact`)
  }
}

function isReleaseVersion(value) {
  if (!isExactSemver(value)) return false
  const parsed = parseSemver(value)
  return parsed.prerelease.length === 0 && parsed.build.length === 0
}

function classifiedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function containsAsciiControl(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
