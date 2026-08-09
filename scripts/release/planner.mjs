import { snapshotPlannerInput } from "./observation-schema.mjs"
import { analyzeReleaseSnapshot, ReleaseState } from "./state.mjs"

const NEXT_TRANSITIONS = Object.freeze({
  [ReleaseState.CANDIDATE_VALIDATED]: "create-candidate-tag",
  [ReleaseState.CANDIDATE_TAGGED]: "prepare-artifacts",
  [ReleaseState.ARTIFACTS_PREPARED]: "attest-artifacts",
  [ReleaseState.ARTIFACTS_ATTESTED]: "escrow-candidate",
  [ReleaseState.CANDIDATE_ESCROWED]: "publish-npm-packages",
  [ReleaseState.NPM_PARTIAL]: "resume-npm-publish",
  [ReleaseState.NPM_COMPLETE]: "reconcile-release-draft",
  [ReleaseState.RELEASE_DRAFT_COMPLETE]: "run-release-smokes",
  [ReleaseState.SMOKES_COMPLETE]: "publish-github-release",
  [ReleaseState.RELEASE_PUBLISHED]: "dispatch-release-audit",
  [ReleaseState.AUDIT_DISPATCHED]: "complete-release-audit",
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
        ...(nextTransition === "dispatch-release-audit" ? { tag: observation.release.tag } : {}),
      },
    ],
  })
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
