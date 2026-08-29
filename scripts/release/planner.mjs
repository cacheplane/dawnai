import { snapshotPlannerInput } from "./observation-schema.mjs"
import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"
import { analyzeReleaseSnapshot, isIncompleteTaggedReleaseState, ReleaseState } from "./state.mjs"

const NEXT_TRANSITIONS = Object.freeze({
  [ReleaseState.CANDIDATE_VALIDATED]: "create-candidate-tag",
  [ReleaseState.CANDIDATE_TAGGED]: "prepare-artifacts",
  [ReleaseState.ARTIFACTS_PREPARED]: "attest-artifacts",
  [ReleaseState.ARTIFACTS_ATTESTED]: "escrow-candidate",
  [ReleaseState.CANDIDATE_ESCROWED]: "publish-npm-packages",
  [ReleaseState.NPM_PARTIAL]: "resume-npm-publish",
  [ReleaseState.NPM_COMPLETE]: "reconcile-npm-evidence",
  [ReleaseState.RELEASE_DRAFT_COMPLETE]: "run-release-smokes",
  [ReleaseState.SMOKES_COMPLETE]: "dispatch-release-audit",
  [ReleaseState.AUDIT_DISPATCHED]: "complete-release-audit",
  [ReleaseState.AUDIT_RETRYABLE]: "dispatch-release-audit",
  [ReleaseState.AUDIT_VERIFIED]: "publish-github-release",
})

const ABANDONABLE_STATES = new Set([
  ReleaseState.CANDIDATE_TAGGED,
  ReleaseState.ARTIFACTS_PREPARED,
  ReleaseState.ARTIFACTS_ATTESTED,
  ReleaseState.CANDIDATE_ESCROWED,
])

export function planRelease(input) {
  const { candidate, observation } = snapshotPlannerInput(input)
  const { state, conflicts } = analyzeReleaseSnapshot(candidate, observation)
  if (conflicts.length > 0) {
    return result({
      state,
      disposition: "blocked",
      nextTransition: null,
      reasons: ["release observations conflict with candidate identity or policy"],
      conflicts,
      proposedMutations: [],
    })
  }

  if (state === ReleaseState.NO_CANDIDATE) {
    return result({
      state,
      disposition: "noop",
      nextTransition: null,
      reasons: ["no release candidate was supplied"],
      conflicts: [],
      proposedMutations: [],
    })
  }
  if (state === ReleaseState.SUPERSEDED_NOOP) {
    return result({
      state,
      disposition: "audit-only",
      nextTransition: null,
      reasons: ["the registry latest version supersedes this unstarted candidate"],
      conflicts: [],
      proposedMutations: [],
    })
  }
  if (state === ReleaseState.AUDIT_COMPLETE || state === ReleaseState.ABANDONED_PREPUBLICATION) {
    return result({
      state,
      disposition: "noop",
      nextTransition: null,
      reasons: [
        state === ReleaseState.AUDIT_COMPLETE
          ? "the independent release audit is complete"
          : "the candidate was manually abandoned before publication",
      ],
      conflicts: [],
      proposedMutations: [],
    })
  }

  const nextTransition =
    observation.abandonment.requested && ABANDONABLE_STATES.has(state)
      ? "record-prepublication-abandonment"
      : state === ReleaseState.RELEASE_DRAFT_COMPLETE && smokeEvidenceReady(observation)
        ? "reconcile-smoke-evidence"
        : NEXT_TRANSITIONS[state]
  if (nextTransition === undefined) {
    throw new Error(`No transition is defined for release state ${state}`)
  }
  return result({
    state,
    disposition: "would-transition",
    nextTransition,
    reasons: [`release state is ready for ${nextTransition}`],
    conflicts: [],
    proposedMutations: [
      {
        type: nextTransition,
        version: candidate.version,
        commitSha: candidate.commitSha,
        ...(nextTransition === "dispatch-release-audit"
          ? { tag: observation.release.tag }
          : nextTransition === "record-prepublication-abandonment"
            ? { tag: `v${candidate.version}` }
            : {}),
      },
    ],
  })
}

function smokeEvidenceReady(observation) {
  const lanes = observation.requiredSmokeLanes
  const smokes = observation.smokes
  if (!Array.isArray(lanes) || lanes.length === 0 || !Array.isArray(smokes)) return false
  return lanes.every((lane) => {
    const matches = smokes.filter((smoke) => smoke.name === lane)
    return matches.length === 1 && matches[0].status === "passed"
  })
}

export function planCandidateArbitration({ candidate, managedReleases = [], registryLatest = [] }) {
  const selected = normalizeCandidateSelection(candidate, "candidate")
  if (!Array.isArray(managedReleases)) {
    throw new TypeError("managedReleases must be an array")
  }
  if (!Array.isArray(registryLatest)) {
    throw new TypeError("registryLatest must be an array")
  }
  const managed = managedReleases.map((release, index) =>
    normalizeCandidateSelection(release, `managedReleases[${index}]`),
  )
  const conflicts = new Set()
  let superseded = false

  for (const release of managed) {
    const comparison = compareSemver(release.candidate.version, selected.candidate.version)
    if (comparison === 0) {
      if (release.candidate.commitSha !== selected.candidate.commitSha) {
        conflicts.add("candidate-version-sha-conflict")
      }
      continue
    }
    if (comparison < 0 && isIncompleteTaggedReleaseState(release.state)) {
      conflicts.add("older-tagged-candidate-incomplete")
    }
    if (comparison > 0) {
      if (selected.state === ReleaseState.CANDIDATE_VALIDATED) superseded = true
    }
  }

  let newerLatest = false
  for (const [index, latest] of registryLatest.entries()) {
    if (
      latest === null ||
      Array.isArray(latest) ||
      typeof latest !== "object" ||
      !isReleaseVersion(latest.version)
    ) {
      conflicts.add(`registry-latest-invalid-${index}`)
      continue
    }
    if (compareSemver(latest.version, selected.candidate.version) > 0) newerLatest = true
  }
  if (newerLatest) {
    if (selected.state === ReleaseState.CANDIDATE_VALIDATED) superseded = true
    else if (!terminalHistoricalState(selected.state)) conflicts.add("newer-registry-latest")
  }

  if (conflicts.size > 0) {
    return candidateSelection({
      ...selected,
      disposition: "blocked",
      conflicts: [...conflicts].sort(),
    })
  }
  if (superseded) {
    return candidateSelection({
      ...selected,
      state: ReleaseState.SUPERSEDED_NOOP,
      disposition: "audit-only",
      tag: null,
      conflicts: [],
    })
  }
  return candidateSelection(selected)
}

function result(value) {
  return {
    state: value.state,
    disposition: value.disposition,
    nextTransition: value.nextTransition,
    reasons: value.reasons,
    conflicts: value.conflicts,
    proposedMutations: value.proposedMutations,
  }
}

function normalizeCandidateSelection(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be a candidate selection`)
  }
  const identity = value.candidate
  if (
    identity === null ||
    Array.isArray(identity) ||
    typeof identity !== "object" ||
    !isReleaseVersion(identity.version) ||
    typeof identity.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(identity.commitSha) ||
    identity.ciWorkflow !== "CI" ||
    identity.ciCheck !== "validate" ||
    identity.publisherWorkflow !== ".github/workflows/release.yml" ||
    !arraysEqual(Object.keys(identity).sort(), [
      "ciCheck",
      "ciWorkflow",
      "commitSha",
      "publisherWorkflow",
      "version",
    ])
  ) {
    throw new TypeError(`${label} candidate identity is invalid`)
  }
  if (!Object.values(ReleaseState).includes(value.state)) {
    throw new TypeError(`${label} release state is invalid`)
  }
  if (value.tag !== null && value.tag !== `v${identity.version}`) {
    throw new TypeError(`${label} candidate tag is invalid`)
  }
  if (
    !Array.isArray(value.conflicts) ||
    !value.conflicts.every((item) => typeof item === "string")
  ) {
    throw new TypeError(`${label} conflicts are invalid`)
  }
  return {
    candidate: structuredClone(identity),
    state: value.state,
    disposition: value.disposition,
    tag: value.tag,
    conflicts: [...value.conflicts],
  }
}

function candidateSelection(value) {
  const result = {
    candidate: value.candidate,
    state: value.state,
    disposition: value.disposition,
    tag: value.tag,
    conflicts: value.conflicts,
  }
  return deepFreeze(result)
}

function terminalHistoricalState(state) {
  return state === ReleaseState.AUDIT_COMPLETE || state === ReleaseState.ABANDONED_PREPUBLICATION
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
