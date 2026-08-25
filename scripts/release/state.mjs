import { findPolicyConflicts } from "./conflicts.mjs"
import { correlateReleaseEvidence } from "./evidence.mjs"
import { snapshotReleaseInput } from "./observation-schema.mjs"

export const ReleaseState = Object.freeze({
  NO_CANDIDATE: "NO_CANDIDATE",
  SUPERSEDED_NOOP: "SUPERSEDED_NOOP",
  CANDIDATE_VALIDATED: "CANDIDATE_VALIDATED",
  CANDIDATE_TAGGED: "CANDIDATE_TAGGED",
  ARTIFACTS_PREPARED: "ARTIFACTS_PREPARED",
  ARTIFACTS_ATTESTED: "ARTIFACTS_ATTESTED",
  CANDIDATE_ESCROWED: "CANDIDATE_ESCROWED",
  NPM_PARTIAL: "NPM_PARTIAL",
  NPM_COMPLETE: "NPM_COMPLETE",
  RELEASE_DRAFT_COMPLETE: "RELEASE_DRAFT_COMPLETE",
  SMOKES_COMPLETE: "SMOKES_COMPLETE",
  RELEASE_PUBLISHED: "RELEASE_PUBLISHED",
  AUDIT_DISPATCHED: "AUDIT_DISPATCHED",
  AUDIT_COMPLETE: "AUDIT_COMPLETE",
  ABANDONED_PREPUBLICATION: "ABANDONED_PREPUBLICATION",
})

export const RELEASE_PROGRESS_RANK = Object.freeze({
  [ReleaseState.NO_CANDIDATE]: 0,
  [ReleaseState.SUPERSEDED_NOOP]: 1,
  [ReleaseState.CANDIDATE_VALIDATED]: 2,
  [ReleaseState.CANDIDATE_TAGGED]: 3,
  [ReleaseState.ARTIFACTS_PREPARED]: 4,
  [ReleaseState.ARTIFACTS_ATTESTED]: 5,
  [ReleaseState.CANDIDATE_ESCROWED]: 6,
  [ReleaseState.NPM_PARTIAL]: 7,
  [ReleaseState.NPM_COMPLETE]: 8,
  [ReleaseState.RELEASE_DRAFT_COMPLETE]: 9,
  [ReleaseState.SMOKES_COMPLETE]: 10,
  [ReleaseState.RELEASE_PUBLISHED]: 11,
  [ReleaseState.AUDIT_DISPATCHED]: 12,
  [ReleaseState.AUDIT_COMPLETE]: 13,
  [ReleaseState.ABANDONED_PREPUBLICATION]: 14,
})

export const TERMINAL_RELEASE_STATES = Object.freeze([
  ReleaseState.NO_CANDIDATE,
  ReleaseState.SUPERSEDED_NOOP,
  ReleaseState.AUDIT_COMPLETE,
  ReleaseState.ABANDONED_PREPUBLICATION,
])

export const INCOMPLETE_TAGGED_RELEASE_STATES = Object.freeze([
  ReleaseState.CANDIDATE_TAGGED,
  ReleaseState.ARTIFACTS_PREPARED,
  ReleaseState.ARTIFACTS_ATTESTED,
  ReleaseState.CANDIDATE_ESCROWED,
  ReleaseState.NPM_PARTIAL,
  ReleaseState.NPM_COMPLETE,
  ReleaseState.RELEASE_DRAFT_COMPLETE,
  ReleaseState.SMOKES_COMPLETE,
  ReleaseState.RELEASE_PUBLISHED,
  ReleaseState.AUDIT_DISPATCHED,
])

const INCOMPLETE_TAGGED_RELEASE_STATE_SET = new Set(INCOMPLETE_TAGGED_RELEASE_STATES)

export function isIncompleteTaggedReleaseState(state) {
  return INCOMPLETE_TAGGED_RELEASE_STATE_SET.has(state)
}

export function analyzeObservedRelease(candidate, observation) {
  const snapshot = snapshotReleaseInput(candidate, observation)
  return analyzeReleaseSnapshot(snapshot.candidate, snapshot.observation)
}

export function analyzeReleaseSnapshot(candidate, observation) {
  if (candidate === null) {
    return Object.freeze({ state: ReleaseState.NO_CANDIDATE, conflicts: Object.freeze([]) })
  }
  const evidence = correlateReleaseEvidence(candidate, observation)
  if (!evidence.structureValid) {
    return Object.freeze({ state: ReleaseState.CANDIDATE_VALIDATED, conflicts: evidence.conflicts })
  }
  const state = classifySnapshot(observation, evidence)
  const conflicts = findPolicyConflicts(
    candidate,
    observation,
    evidence,
    state,
    RELEASE_PROGRESS_RANK,
  )
  return Object.freeze({ state, conflicts: Object.freeze(conflicts) })
}

export function classifyObservedRelease(candidate, observation) {
  return analyzeObservedRelease(candidate, observation).state
}

export function findReleaseConflicts(candidate, observation) {
  return analyzeObservedRelease(candidate, observation).conflicts
}

function classifySnapshot(observation, evidence) {
  if (!evidence.schemaValid) return ReleaseState.CANDIDATE_VALIDATED
  if (observation.abandonment?.recorded) return ReleaseState.ABANDONED_PREPUBLICATION
  if (evidence.audit.complete) return ReleaseState.AUDIT_COMPLETE
  if (evidence.audit.dispatched) return ReleaseState.AUDIT_DISPATCHED
  if (evidence.assets.publishedExact) return ReleaseState.RELEASE_PUBLISHED
  if (evidence.assets.metadataComplete && evidence.smokes.complete) {
    return ReleaseState.SMOKES_COMPLETE
  }
  if (evidence.assets.metadataComplete) return ReleaseState.RELEASE_DRAFT_COMPLETE
  if (evidence.npm.complete) return ReleaseState.NPM_COMPLETE
  if (evidence.npm.started) return ReleaseState.NPM_PARTIAL
  if (evidence.assets.draftExact) return ReleaseState.CANDIDATE_ESCROWED
  if (evidence.artifact.attested) return ReleaseState.ARTIFACTS_ATTESTED
  if (evidence.artifact.prepared) return ReleaseState.ARTIFACTS_PREPARED
  if (observation.tag?.status === "present") return ReleaseState.CANDIDATE_TAGGED
  if (evidence.npm.latestNewer && isUnstarted(observation)) return ReleaseState.SUPERSEDED_NOOP
  return ReleaseState.CANDIDATE_VALIDATED
}

function isUnstarted(observation) {
  return (
    observation.tag?.status === "absent" &&
    observation.artifacts?.status === "absent" &&
    observation.escrow?.status === "absent" &&
    !observation.registry?.publishJobStarted &&
    !observation.registry?.mutationStarted &&
    (observation.registry?.packages ?? []).every((pkg) => pkg.status !== "present") &&
    observation.release?.status === "absent" &&
    observation.audit?.status === "none" &&
    !observation.abandonment?.recorded
  )
}
