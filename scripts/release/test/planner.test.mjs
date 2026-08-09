import assert from "node:assert/strict"
import test from "node:test"

import { planRelease } from "../planner.mjs"
import { classifyObservedRelease, findReleaseConflicts, ReleaseState } from "../state.mjs"

const VERSION = "0.8.20"
const NEWER_VERSION = "0.8.21"
const OLDER_VERSION = "0.8.19"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const OTHER_SHA = "abcdef0123456789abcdef0123456789abcdef01"
const MANIFEST_SHA256 = "a".repeat(64)
const OTHER_MANIFEST_SHA256 = "b".repeat(64)
const CI_WORKFLOW = "CI"
const PUBLISHER_WORKFLOW = ".github/workflows/release.yml"
const OUTPUT_KEYS = [
  "conflicts",
  "disposition",
  "nextTransition",
  "proposedMutations",
  "reasons",
  "state",
]
const PACKAGE_IDENTITIES = [
  {
    name: "@dawn-ai/core",
    version: VERSION,
    filename: `dawn-ai-core-${VERSION}.tgz`,
    tarballSha256: "1".repeat(64),
    integrity: "sha512-core",
  },
  {
    name: "@dawn-ai/sdk",
    version: VERSION,
    filename: `dawn-ai-sdk-${VERSION}.tgz`,
    tarballSha256: "2".repeat(64),
    integrity: "sha512-sdk",
  },
]

test("ReleaseState is the frozen canonical state model", () => {
  assert.deepEqual(ReleaseState, {
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
  assert.equal(Object.isFrozen(ReleaseState), true)
})

const stateCases = [
  {
    name: "no candidate",
    candidate: null,
    observation: baseObservation(),
    state: "NO_CANDIDATE",
    disposition: "noop",
    transition: null,
  },
  {
    name: "superseded candidate",
    observation: observationFor("SUPERSEDED_NOOP"),
    state: "SUPERSEDED_NOOP",
    disposition: "audit-only",
    transition: null,
  },
  {
    name: "validated candidate",
    observation: observationFor("CANDIDATE_VALIDATED"),
    state: "CANDIDATE_VALIDATED",
    disposition: "would-transition",
    transition: "create-candidate-tag",
  },
  {
    name: "tagged candidate",
    observation: observationFor("CANDIDATE_TAGGED"),
    state: "CANDIDATE_TAGGED",
    disposition: "would-transition",
    transition: "prepare-artifacts",
  },
  {
    name: "prepared artifacts",
    observation: observationFor("ARTIFACTS_PREPARED"),
    state: "ARTIFACTS_PREPARED",
    disposition: "would-transition",
    transition: "attest-artifacts",
  },
  {
    name: "attested artifacts",
    observation: observationFor("ARTIFACTS_ATTESTED"),
    state: "ARTIFACTS_ATTESTED",
    disposition: "would-transition",
    transition: "escrow-candidate",
  },
  {
    name: "escrowed candidate",
    observation: observationFor("CANDIDATE_ESCROWED"),
    state: "CANDIDATE_ESCROWED",
    disposition: "would-transition",
    transition: "publish-npm-packages",
  },
  {
    name: "partially published npm fixed group",
    observation: observationFor("NPM_PARTIAL"),
    state: "NPM_PARTIAL",
    disposition: "would-transition",
    transition: "resume-npm-publish",
  },
  {
    name: "complete npm fixed group",
    observation: observationFor("NPM_COMPLETE"),
    state: "NPM_COMPLETE",
    disposition: "would-transition",
    transition: "reconcile-release-draft",
  },
  {
    name: "complete GitHub Release draft metadata",
    observation: observationFor("RELEASE_DRAFT_COMPLETE"),
    state: "RELEASE_DRAFT_COMPLETE",
    disposition: "would-transition",
    transition: "run-release-smokes",
  },
  {
    name: "complete exact-version smokes",
    observation: observationFor("SMOKES_COMPLETE"),
    state: "SMOKES_COMPLETE",
    disposition: "would-transition",
    transition: "publish-github-release",
  },
  {
    name: "published GitHub Release",
    observation: observationFor("RELEASE_PUBLISHED"),
    state: "RELEASE_PUBLISHED",
    disposition: "would-transition",
    transition: "dispatch-release-audit",
  },
  {
    name: "independent audit dispatched",
    observation: observationFor("AUDIT_DISPATCHED"),
    state: "AUDIT_DISPATCHED",
    disposition: "would-transition",
    transition: "complete-release-audit",
  },
  {
    name: "independent audit complete",
    observation: observationFor("AUDIT_COMPLETE"),
    state: "AUDIT_COMPLETE",
    disposition: "noop",
    transition: null,
  },
  {
    name: "manually abandoned prepublication candidate",
    observation: observationFor("ABANDONED_PREPUBLICATION"),
    state: "ABANDONED_PREPUBLICATION",
    disposition: "noop",
    transition: null,
  },
]

for (const row of stateCases) {
  test(`plans deterministic ${row.name} state`, () => {
    const input = deepFreeze({
      candidate: row.candidate === undefined ? candidate() : row.candidate,
      observation: row.observation,
      mode: "shadow",
    })
    const before = JSON.stringify(input)

    const first = planRelease(input)
    const second = planRelease(input)

    assert.deepEqual(first, second)
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first)
    assert.deepEqual(Object.keys(first).sort(), OUTPUT_KEYS)
    assert.equal(first.state, row.state)
    assert.equal(first.disposition, row.disposition)
    assert.equal(first.nextTransition, row.transition)
    assert.deepEqual(first.conflicts, [])
    assert.ok(Array.isArray(first.reasons))
    assert.deepEqual(
      first.proposedMutations,
      row.transition === null
        ? []
        : [
            {
              type: row.transition,
              version: VERSION,
              commitSha: COMMIT_SHA,
            },
          ],
    )
    assert.equal(JSON.stringify(input), before)
    assertRecursivelyFrozen(input)
    assert.equal(classifyObservedRelease(input.candidate, input.observation), row.state)
  })
}

test("controller mode describes the same transition without executing it", () => {
  const observation = deepFreeze(observationFor("CANDIDATE_TAGGED"))

  const shadow = planRelease({ candidate: candidate(), observation, mode: "shadow" })
  const controller = planRelease({ candidate: candidate(), observation, mode: "controller" })

  assert.deepEqual(controller, shadow)
  assert.deepEqual(controller.proposedMutations, [
    {
      type: "prepare-artifacts",
      version: VERSION,
      commitSha: COMMIT_SHA,
    },
  ])
})

test("a skipped candidate is superseded audit-only without a mutation proposal", () => {
  const observation = baseObservation()
  setPackageLatest(observation, NEWER_VERSION)

  const plan = planRelease({ candidate: candidate(), observation })

  assert.equal(plan.state, "SUPERSEDED_NOOP")
  assert.equal(plan.disposition, "audit-only")
  assert.equal(plan.nextTransition, null)
  assert.deepEqual(plan.proposedMutations, [])
})

test("an older tagged incomplete release blocks a newer candidate", () => {
  const observation = baseObservation()
  observation.otherCandidates.push({
    version: OLDER_VERSION,
    commitSha: OTHER_SHA,
    state: "CANDIDATE_TAGGED",
  })

  assertBlocked(observation, "older-tagged-candidate-incomplete")
})

test("older audited or abandoned releases unblock a newer candidate", () => {
  for (const state of ["AUDIT_COMPLETE", "ABANDONED_PREPUBLICATION"]) {
    const observation = baseObservation()
    observation.otherCandidates.push({ version: OLDER_VERSION, commitSha: OTHER_SHA, state })

    const plan = planRelease({ candidate: candidate(), observation })

    assert.equal(plan.state, "CANDIDATE_VALIDATED")
    assert.equal(plan.disposition, "would-transition")
  }
})

test("a newer registry latest cannot move a completed candidate backward", () => {
  const observation = observationFor("AUDIT_COMPLETE")
  setPackageLatest(observation, NEWER_VERSION)

  const plan = planRelease({ candidate: candidate(), observation })

  assert.equal(plan.state, "AUDIT_COMPLETE")
  assert.equal(plan.disposition, "noop")
})

test("a newer registry latest conflicts with partial candidate progress", () => {
  const observation = observationFor("NPM_PARTIAL")
  setPackageLatest(observation, NEWER_VERSION)

  assertBlocked(observation, "newer-registry-version-interleaved")
})

test("registry bytes must exactly match the prepared package", () => {
  const observation = observationFor("NPM_PARTIAL")
  observation.registry.packages[0].integrity = "sha512-other-bytes"

  assertBlocked(observation, "npm-bytes-mismatch")
})

for (const field of ["workflow", "commitSha"]) {
  test(`registry provenance ${field} must match the candidate`, () => {
    const observation = observationFor("NPM_PARTIAL")
    observation.registry.packages[0].provenance[field] =
      field === "workflow" ? "other-workflow" : OTHER_SHA

    assertBlocked(observation, `npm-provenance-${field}-mismatch`)
  })
}

test("the candidate tag cannot resolve to another commit", () => {
  const observation = observationFor("CANDIDATE_TAGGED")
  observation.tag.commitSha = OTHER_SHA

  assertBlocked(observation, "candidate-tag-commit-mismatch")
})

test("a same-name GitHub asset with different bytes is a conflict", () => {
  const observation = observationFor("RELEASE_DRAFT_COMPLETE")
  observation.release.assets[0].status = "different"

  assertBlocked(observation, "github-asset-bytes-mismatch")
})

test("every fixed-group package must use the exact candidate version", () => {
  const observation = baseObservation()
  observation.inventory.packages[1].version = OLDER_VERSION

  assertBlocked(observation, "fixed-group-version-mismatch")
})

const invalidCiCases = [
  ["missing", {}, "candidate-ci-missing"],
  ["failed", {}, "candidate-ci-failed"],
  ["success", { commitSha: OTHER_SHA }, "candidate-ci-commit-mismatch"],
]

for (const [status, overrides, conflict] of invalidCiCases) {
  test(`${status} exact-SHA candidate CI blocks release work`, () => {
    const observation = baseObservation()
    observation.ci = {
      status,
      workflow: CI_WORKFLOW,
      commitSha: COMMIT_SHA,
      ...overrides,
    }

    assertBlocked(observation, conflict)
  })
}

for (const status of ["missing", "corrupt", "unmanifested"]) {
  test(`${status} prepared artifact blocks release work`, () => {
    const observation = observationFor("ARTIFACTS_PREPARED")
    observation.artifacts.files[0].status = status

    assertBlocked(observation, `artifact-${status}`)
  })
}

for (const status of ["missing", "failed"]) {
  test(`${status} required smoke blocks release work`, () => {
    const observation = observationFor("RELEASE_DRAFT_COMPLETE")
    observation.smokes[0].status = status

    assertBlocked(observation, `required-smoke-${status}`)
  })
}

test("every named required smoke lane needs one exact-version success", () => {
  const observation = useCorrelatedSmokeSchema(observationFor("RELEASE_DRAFT_COMPLETE"))
  for (const smoke of observation.smokes) {
    smoke.status = "passed"
  }

  let plan
  assert.doesNotThrow(() => {
    plan = planRelease({ candidate: candidate(), observation })
  })
  assert.equal(plan.state, "SMOKES_COMPLETE")
  assert.equal(plan.disposition, "would-transition")
  assert.equal(plan.nextTransition, "publish-github-release")
})

test("fully correlated required smoke results authorize SMOKES_COMPLETE", () => {
  const observation = useCorrelatedSmokeSchema(observationFor("RELEASE_DRAFT_COMPLETE"))
  for (const smoke of observation.smokes) {
    smoke.status = "passed"
  }

  let plan
  assert.doesNotThrow(() => {
    plan = planRelease({ candidate: candidate(), observation })
  })
  assert.equal(plan.state, "SMOKES_COMPLETE")
  assert.equal(plan.disposition, "would-transition")
  assert.equal(plan.nextTransition, "publish-github-release")
})

const staleSmokeIdentityCases = [
  {
    name: "candidate commit",
    mutate(smoke) {
      smoke.commitSha = OTHER_SHA
    },
    conflict: "required-smoke-commit-mismatch",
  },
  {
    name: "manifest digest",
    mutate(smoke) {
      smoke.manifestSha256 = OTHER_MANIFEST_SHA256
    },
    conflict: "required-smoke-manifest-mismatch",
  },
]

for (const { name, mutate, conflict } of staleSmokeIdentityCases) {
  test(`a required smoke result from another ${name} blocks publication`, () => {
    const observation = useCorrelatedSmokeSchema(observationFor("RELEASE_DRAFT_COMPLETE"))
    for (const smoke of observation.smokes) {
      smoke.status = "passed"
    }
    mutate(observation.smokes[0])

    assertDesiredSchemaBlocked(observation, conflict)
  })
}

const invalidSmokeRunMetadataCases = [
  {
    name: "missing workflow run ID",
    mutate(smoke) {
      delete smoke.workflowRunId
    },
    conflict: "required-smoke-workflow-run-id-invalid",
  },
  {
    name: "missing run attempt",
    mutate(smoke) {
      delete smoke.runAttempt
    },
    conflict: "required-smoke-run-attempt-invalid",
  },
  {
    name: "non-positive workflow run ID",
    mutate(smoke) {
      smoke.workflowRunId = 0
    },
    conflict: "required-smoke-workflow-run-id-invalid",
  },
  {
    name: "non-integer run attempt",
    mutate(smoke) {
      smoke.runAttempt = 1.5
    },
    conflict: "required-smoke-run-attempt-invalid",
  },
]

for (const { name, mutate, conflict } of invalidSmokeRunMetadataCases) {
  test(`${name} blocks a required smoke result`, () => {
    const observation = useCorrelatedSmokeSchema(observationFor("RELEASE_DRAFT_COMPLETE"))
    for (const smoke of observation.smokes) {
      smoke.status = "passed"
    }
    mutate(observation.smokes[0])

    assertDesiredSchemaBlocked(observation, conflict)
  })
}

for (const source of ["artifacts", "escrow"]) {
  test(`missing current manifest digest in ${source} blocks correlated smokes`, () => {
    const observation = useCorrelatedSmokeSchema(observationFor("RELEASE_DRAFT_COMPLETE"))
    for (const smoke of observation.smokes) {
      smoke.status = "passed"
    }
    observation[source].manifestSha256 = null

    assertDesiredSchemaBlocked(observation, `${source}-manifest-digest-missing`)
  })
}

const invalidRequiredLaneCases = [
  {
    name: "omitted",
    mutate(observation) {
      delete observation.requiredSmokeLanes
    },
    conflict: "required-smoke-lanes-missing",
  },
  {
    name: "empty",
    mutate(observation) {
      observation.requiredSmokeLanes = []
    },
    conflict: "required-smoke-lanes-empty",
  },
  {
    name: "duplicate",
    mutate(observation) {
      observation.requiredSmokeLanes = ["install", "install"]
    },
    conflict: "required-smoke-lane-duplicate",
  },
  {
    name: "non-deterministic",
    mutate(observation) {
      observation.requiredSmokeLanes = ["runtime", "install"]
    },
    conflict: "required-smoke-lanes-nondeterministic",
  },
]

for (const { name, mutate, conflict } of invalidRequiredLaneCases) {
  test(`${name} required smoke lanes block publication`, () => {
    const observation = useExplicitSmokeSchema(observationFor("RELEASE_DRAFT_COMPLETE"))
    mutate(observation)

    assertDesiredSchemaBlocked(observation, conflict)
  })
}

const invalidRequiredResultCases = [
  {
    name: "missing",
    mutate(observation) {
      observation.smokes.pop()
    },
    conflict: "required-smoke-result-missing",
  },
  {
    name: "duplicate",
    mutate(observation) {
      observation.smokes.push(structuredClone(observation.smokes[0]))
    },
    conflict: "required-smoke-result-duplicate",
  },
  {
    name: "unexpected",
    mutate(observation) {
      observation.smokes.push({
        name: "unlisted",
        status: "passed",
        version: VERSION,
      })
    },
    conflict: "required-smoke-result-unexpected",
  },
]

for (const { name, mutate, conflict } of invalidRequiredResultCases) {
  test(`${name} required smoke results block publication`, () => {
    const observation = useExplicitSmokeSchema(observationFor("RELEASE_DRAFT_COMPLETE"))
    mutate(observation)

    assertDesiredSchemaBlocked(observation, conflict)
  })
}

const ambiguityCases = [
  {
    name: "registry latest",
    mutate(observation) {
      observation.registry.packages[0].latest = { status: "ambiguous", version: null }
    },
    conflict: "registry-latest-ambiguous",
  },
  {
    name: "registry package",
    mutate(observation) {
      observation.registry.packages[0] = ambiguousRegistryPackage(
        observation.registry.packages[0].name,
      )
    },
    conflict: "registry-package-ambiguous",
  },
  {
    name: "GitHub tag",
    mutate(observation) {
      observation.tag = { status: "ambiguous", commitSha: null }
    },
    conflict: "candidate-tag-ambiguous",
  },
  {
    name: "GitHub Release",
    mutate(observation) {
      observation.release.status = "ambiguous"
    },
    conflict: "github-release-ambiguous",
  },
  {
    name: "GitHub asset",
    mutate(observation) {
      observation.release = releaseRecord("draft")
      observation.release.assets[0].status = "ambiguous"
    },
    conflict: "github-asset-ambiguous",
  },
]

for (const { name, mutate, conflict } of ambiguityCases) {
  test(`an ambiguous ${name} response blocks and is never absence`, () => {
    const observation = baseObservation()
    mutate(observation)

    assertBlocked(observation, conflict)
  })
}

const invalidAbandonmentCases = [
  {
    name: "publish job starts",
    mutate(observation) {
      observation.registry.publishJobStarted = true
    },
    conflict: "abandonment-after-publish-started",
  },
  {
    name: "first registry mutation starts",
    mutate(observation) {
      observation.registry.mutationStarted = true
    },
    conflict: "abandonment-after-publish-started",
  },
  {
    name: "any package is visible",
    mutate(observation) {
      observation.registry.packages[0] = presentRegistryPackage(PACKAGE_IDENTITIES[0])
    },
    conflict: "abandonment-after-package-visible",
  },
  {
    name: "registry response is ambiguous",
    mutate(observation) {
      observation.registry.packages[0] = ambiguousRegistryPackage(
        observation.registry.packages[0].name,
      )
    },
    conflict: "abandonment-with-ambiguity",
  },
  {
    name: "candidate tag mismatches",
    mutate(observation) {
      observation.tag.commitSha = OTHER_SHA
    },
    conflict: "candidate-tag-commit-mismatch",
  },
  {
    name: "newer public state interleaves",
    mutate(observation) {
      observation.otherCandidates.push({
        version: NEWER_VERSION,
        commitSha: OTHER_SHA,
        state: "NPM_COMPLETE",
      })
    },
    conflict: "abandonment-newer-public-state",
  },
]

for (const { name, mutate, conflict } of invalidAbandonmentCases) {
  test(`abandonment is rejected when ${name}`, () => {
    const observation = observationFor("CANDIDATE_TAGGED")
    observation.abandonment.requested = true
    mutate(observation)

    assertBlocked(observation, conflict)
  })
}

test("abandonment is manual and permitted only from tagged through escrowed", () => {
  const permitted = [
    "CANDIDATE_TAGGED",
    "ARTIFACTS_PREPARED",
    "ARTIFACTS_ATTESTED",
    "CANDIDATE_ESCROWED",
  ]
  for (const state of permitted) {
    const observation = observationFor(state)
    observation.abandonment.requested = true

    const plan = planRelease({ candidate: candidate(), observation })

    assert.equal(plan.state, state)
    assert.equal(plan.nextTransition, "record-prepublication-abandonment")
  }

  const untagged = baseObservation()
  untagged.abandonment.requested = true
  assertBlocked(untagged, "abandonment-not-permitted-from-state")
})

test("an abandoned candidate later visible on npm is a hard conflict", () => {
  const observation = observationFor("ABANDONED_PREPUBLICATION")
  observation.registry.packages[0] = presentRegistryPackage(PACKAGE_IDENTITIES[0])

  assertBlocked(observation, "abandoned-candidate-visible-on-npm")
})

test("recorded abandonment stays terminal after a newer release becomes public", () => {
  const observation = observationFor("ABANDONED_PREPUBLICATION")
  setPackageLatest(observation, NEWER_VERSION)
  observation.otherCandidates.push({
    version: NEWER_VERSION,
    commitSha: OTHER_SHA,
    state: "RELEASE_PUBLISHED",
  })

  const plan = planRelease({ candidate: candidate(), observation })

  assert.equal(plan.state, "ABANDONED_PREPUBLICATION")
  assert.equal(plan.disposition, "noop")
  assert.equal(plan.nextTransition, null)
  assert.deepEqual(plan.conflicts, [])
  assert.deepEqual(plan.proposedMutations, [])
})

test("malformed candidate identity and mode are rejected", () => {
  const observation = baseObservation()

  assert.throws(
    () => planRelease({ candidate: candidate({ version: "v0.8.20" }), observation }),
    /candidate\.version must be an exact SemVer/u,
  )
  assert.throws(
    () => planRelease({ candidate: candidate({ commitSha: "main" }), observation }),
    /candidate\.commitSha must be a 40-character lowercase hexadecimal SHA/u,
  )
  assert.throws(
    () => planRelease({ candidate: candidate(), observation, mode: "write" }),
    /mode must be shadow or controller/u,
  )
  assert.throws(
    () => planRelease({ candidate: candidate(), observation, mode: null }),
    /mode must be shadow or controller/u,
  )
})

test("contradictory progress observations fail closed", () => {
  const observation = observationFor("NPM_COMPLETE")
  observation.escrow.status = "absent"

  assertBlocked(observation, "npm-before-escrow")
  assert.ok(findReleaseConflicts(candidate(), observation).includes("npm-before-escrow"))
})

const tagPrerequisiteStates = [
  "ARTIFACTS_PREPARED",
  "ARTIFACTS_ATTESTED",
  "CANDIDATE_ESCROWED",
  "NPM_PARTIAL",
  "NPM_COMPLETE",
  "RELEASE_DRAFT_COMPLETE",
  "SMOKES_COMPLETE",
  "RELEASE_PUBLISHED",
  "AUDIT_DISPATCHED",
  "AUDIT_COMPLETE",
]

for (const state of tagPrerequisiteStates) {
  test(`${state} requires exact candidate tag evidence`, () => {
    const observation = observationFor(state)
    observation.tag = { status: "absent", commitSha: null }

    assertBlocked(observation, "candidate-tag-prerequisite-missing")
  })
}

test("a Release draft cannot advance with an expected asset explicitly absent", () => {
  const observation = observationFor("RELEASE_DRAFT_COMPLETE")
  observation.release.assets[0].status = "absent"

  assertBlocked(observation, "github-required-asset-absent")
})

const preNpmDraftStates = ["CANDIDATE_ESCROWED", "NPM_PARTIAL", "NPM_COMPLETE"]

for (const state of preNpmDraftStates) {
  test(`${state} accepts the immutable draft Release before npm completion`, () => {
    const observation = observationFor(state)
    observation.release = releaseRecord("draft")

    const plan = planRelease({ candidate: candidate(), observation })

    assert.equal(plan.state, state)
    assert.notEqual(plan.disposition, "blocked")
    assert.ok(!plan.conflicts.includes("github-release-before-npm-complete"))
  })
}

test("NPM_COMPLETE reconciles the existing draft instead of creating a Release", () => {
  const plan = planRelease({
    candidate: candidate(),
    observation: observationFor("NPM_COMPLETE"),
  })

  assert.equal(plan.state, "NPM_COMPLETE")
  assert.equal(plan.nextTransition, "reconcile-release-draft")
})

test("npm provenance uses the trusted publisher workflow rather than CI", () => {
  const observation = observationFor("NPM_PARTIAL")
  observation.ci.workflow = CI_WORKFLOW
  observation.registry.packages[0].provenance.workflow = PUBLISHER_WORKFLOW

  const plan = planRelease({
    candidate: candidate({ publisherWorkflow: PUBLISHER_WORKFLOW }),
    observation,
  })

  assert.equal(plan.disposition, "would-transition")
  assert.deepEqual(plan.conflicts, [])
})

test("an untrusted publisher workflow path blocks registry provenance", () => {
  const observation = observationFor("NPM_PARTIAL")
  observation.ci.workflow = CI_WORKFLOW
  observation.registry.packages[0].provenance.workflow = "release.yml"

  assertDesiredSchemaBlocked(
    observation,
    "publisher-workflow-untrusted",
    candidate({ publisherWorkflow: "release.yml" }),
  )
})

test("all-present npm packages do not complete with an exact per-package latest e404", () => {
  const observation = observationFor("NPM_COMPLETE")
  usePerPackageRegistryEvidence(observation)
  observation.registry.packages[0].latest = { status: "e404", version: null }

  assertDesiredSchemaBlocked(observation, "npm-package-latest-missing")
})

test("all-present npm packages do not complete without a valid signature", () => {
  const observation = observationFor("NPM_COMPLETE")
  usePerPackageRegistryEvidence(observation)
  observation.registry.packages[0].signature = { status: "missing" }

  assertDesiredSchemaBlocked(observation, "npm-signature-missing")
})

const invalidCompletePackageCases = [
  {
    name: "tarball digest mismatch",
    mutate(pkg) {
      pkg.tarballSha256 = OTHER_MANIFEST_SHA256
    },
    conflict: "npm-tarball-digest-mismatch",
  },
  {
    name: "latest dist-tag mismatch",
    mutate(pkg) {
      pkg.latest = { status: "present", version: OLDER_VERSION }
    },
    conflict: "npm-package-latest-version-mismatch",
  },
  {
    name: "invalid signature",
    mutate(pkg) {
      pkg.signature = { status: "invalid" }
    },
    conflict: "npm-signature-invalid",
  },
  {
    name: "missing provenance",
    mutate(pkg) {
      pkg.provenance = null
    },
    conflict: "npm-provenance-missing",
  },
]

for (const { name, mutate, conflict } of invalidCompletePackageCases) {
  test(`all-present npm packages do not complete with ${name}`, () => {
    const observation = observationFor("NPM_COMPLETE")
    mutate(observation.registry.packages[0])

    assertDesiredSchemaBlocked(observation, conflict)
  })
}

test("a fully correlated audit success is terminal", () => {
  const observation = observationFor("RELEASE_PUBLISHED")
  observation.audit = auditRecord("success")

  let plan
  assert.doesNotThrow(() => {
    plan = planRelease({ candidate: candidate(), observation })
  })
  assert.equal(plan.state, "AUDIT_COMPLETE")
  assert.equal(plan.disposition, "noop")
})

test("a stale audit success cannot complete another candidate", () => {
  const observation = observationFor("RELEASE_PUBLISHED")
  observation.audit = auditRecord("success")
  observation.audit.commitSha = OTHER_SHA

  assertDesiredSchemaBlocked(observation, "release-audit-commit-mismatch")
})

for (const { name, mutate, conflict } of [
  {
    name: "manifest digest",
    mutate(audit) {
      audit.manifestSha256 = OTHER_MANIFEST_SHA256
    },
    conflict: "release-audit-manifest-mismatch",
  },
  {
    name: "workflow run ID",
    mutate(audit) {
      audit.workflowRunId = 0
    },
    conflict: "release-audit-workflow-run-id-invalid",
  },
  {
    name: "run attempt",
    mutate(audit) {
      delete audit.runAttempt
    },
    conflict: "release-audit-run-attempt-invalid",
  },
]) {
  test(`a stale or malformed audit ${name} cannot complete another candidate`, () => {
    const observation = observationFor("RELEASE_PUBLISHED")
    observation.audit = auditRecord("success")
    mutate(observation.audit)

    assertDesiredSchemaBlocked(observation, conflict)
  })
}

test("immutable escrow and Release assets must be a non-empty exact set", () => {
  const emptyEscrow = observationFor("CANDIDATE_ESCROWED")
  emptyEscrow.escrow.assets = []
  assertDesiredSchemaBlocked(emptyEscrow, "escrow-required-assets-empty")

  const duplicate = observationFor("CANDIDATE_ESCROWED")
  duplicate.release.assets.push(structuredClone(duplicate.release.assets[0]))
  assertDesiredSchemaBlocked(duplicate, "github-asset-duplicate")

  const extra = observationFor("CANDIDATE_ESCROWED")
  extra.release.assets.push({
    name: "unexpected-managed.tgz",
    status: "matching",
    sha256: "3".repeat(64),
  })
  assertDesiredSchemaBlocked(extra, "github-managed-asset-unexpected")
})

test("assets attached while a Release is absent are contradictory", () => {
  const observation = baseObservation()
  observation.release.assets = [releaseAsset(PACKAGE_IDENTITIES[0], "matching")]

  assertBlocked(observation, "github-assets-without-release")
})

test("equal release versions with different candidate SHAs conflict", () => {
  const observation = baseObservation()
  observation.otherCandidates.push({
    version: VERSION,
    commitSha: OTHER_SHA,
    state: "CANDIDATE_TAGGED",
  })

  assertDesiredSchemaBlocked(observation, "candidate-version-sha-conflict")
})

test("release candidate and competing versions reject build metadata", () => {
  assert.throws(
    () =>
      planRelease({
        candidate: candidate({ version: `${VERSION}+build` }),
        observation: baseObservation(),
      }),
    /candidate\.version must not contain build metadata/u,
  )

  const observation = baseObservation()
  observation.otherCandidates.push({
    version: `${VERSION}+build`,
    commitSha: OTHER_SHA,
    state: "CANDIDATE_TAGGED",
  })
  assertDesiredSchemaBlocked(observation, "competing-version-build-metadata")
})

test("planner root rejects unexpected, inherited, accessor, symbol, and class input", () => {
  const valid = {
    candidate: candidate(),
    observation: baseObservation(),
    mode: "shadow",
  }
  const unexpected = { ...valid, extra: true }
  assert.throws(() => planRelease(unexpected), /planner input contains unknown field extra/u)

  const inherited = Object.create(valid)
  assert.throws(() => planRelease(inherited), /planner input must use own data properties/u)

  let reads = 0
  const accessor = { candidate: valid.candidate, observation: valid.observation }
  Object.defineProperty(accessor, "mode", {
    enumerable: true,
    get() {
      reads += 1
      return "shadow"
    },
  })
  assert.throws(() => planRelease(accessor), /planner input must not contain accessors/u)
  assert.equal(reads, 0)

  const symbol = { ...valid, [Symbol("hidden")]: true }
  assert.throws(() => planRelease(symbol), /planner input must contain only string keys/u)

  class PlannerInput {
    constructor() {
      Object.assign(this, valid)
    }
  }
  assert.throws(() => planRelease(new PlannerInput()), /planner input must be a plain object/u)
})

test("planner accepts a null-prototype exact-key root", () => {
  const input = Object.assign(Object.create(null), {
    candidate: candidate(),
    observation: baseObservation(),
    mode: "shadow",
  })

  assert.doesNotThrow(() => planRelease(input))
})

test("planner root snapshots reject sparse nested JSON structures", () => {
  const observation = baseObservation()
  observation.smokes.length += 1

  assert.throws(
    () => planRelease({ candidate: candidate(), observation }),
    /planner input arrays must not be sparse/u,
  )
})

test("planner root rejects non-enumerable fields before snapshotting", () => {
  const input = {
    candidate: candidate(),
    observation: baseObservation(),
    mode: "shadow",
  }
  Object.defineProperty(input, "hidden", { value: true })

  assert.throws(() => planRelease(input), /planner input contains unknown field hidden/u)
})

test("planner root requires its expected fields to be enumerable data properties", () => {
  const input = {
    candidate: candidate(),
    observation: baseObservation(),
  }
  Object.defineProperty(input, "mode", { value: "shadow", enumerable: false })

  assert.throws(() => planRelease(input), /planner input must use enumerable data properties/u)
})

test("planner snapshots reject named properties attached to arrays", () => {
  const observation = baseObservation()
  observation.smokes.extra = true

  assert.throws(
    () => planRelease({ candidate: candidate(), observation }),
    /planner input arrays must contain only indexed values/u,
  )
})

function assertBlocked(observation, expectedConflict) {
  const frozen = deepFreeze(observation)
  const before = JSON.stringify(frozen)
  const plan = planRelease({ candidate: candidate(), observation: frozen })

  assert.equal(plan.disposition, "blocked")
  assert.equal(plan.nextTransition, null)
  assert.deepEqual(plan.proposedMutations, [])
  assert.ok(plan.conflicts.includes(expectedConflict), JSON.stringify(plan.conflicts))
  assert.equal(JSON.stringify(frozen), before)
}

function assertDesiredSchemaBlocked(observation, expectedConflict, releaseCandidate = candidate()) {
  let plan
  assert.doesNotThrow(() => {
    plan = planRelease({ candidate: releaseCandidate, observation })
  })
  assert.equal(plan.disposition, "blocked")
  assert.ok(plan.conflicts.includes(expectedConflict), JSON.stringify(plan.conflicts))
}

function usePerPackageRegistryEvidence(observation) {
  for (const pkg of observation.registry.packages) {
    const expected = PACKAGE_IDENTITIES.find((identity) => identity.name === pkg.name)
    pkg.tarballSha256 = expected.tarballSha256
    pkg.latest = { status: "present", version: VERSION }
    pkg.signature = { status: "valid" }
    pkg.integrity = expected.integrity
  }
  return observation
}

function auditRecord(status) {
  return {
    status,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: MANIFEST_SHA256,
    workflowRunId: 300,
    runAttempt: 1,
  }
}

function useExplicitSmokeSchema(observation) {
  observation.requiredSmokeLanes = ["install", "runtime"]
  return observation
}

function useCorrelatedSmokeSchema(observation) {
  useExplicitSmokeSchema(observation)
  observation.artifacts.manifestSha256 = MANIFEST_SHA256
  observation.escrow.manifestSha256 = MANIFEST_SHA256
  observation.smokes = observation.smokes.map((smoke, index) => ({
    ...smoke,
    commitSha: COMMIT_SHA,
    manifestSha256: MANIFEST_SHA256,
    workflowRunId: 100 + index,
    runAttempt: 1,
  }))
  return observation
}

function candidate(overrides = {}) {
  return {
    version: VERSION,
    commitSha: COMMIT_SHA,
    publisherWorkflow: PUBLISHER_WORKFLOW,
    ...overrides,
  }
}

function baseObservation() {
  return {
    inventory: {
      status: "valid",
      packages: structuredClone(PACKAGE_IDENTITIES),
    },
    ci: {
      status: "success",
      workflow: CI_WORKFLOW,
      commitSha: COMMIT_SHA,
    },
    otherCandidates: [],
    tag: {
      status: "absent",
      commitSha: null,
    },
    artifacts: {
      status: "absent",
      manifestVersion: null,
      manifestCommitSha: null,
      manifestSha256: null,
      files: PACKAGE_IDENTITIES.map((pkg) => artifactFile(pkg, "pending")),
    },
    escrow: {
      status: "absent",
      manifestSha256: null,
      assets: [],
    },
    registry: {
      publishJobStarted: false,
      mutationStarted: false,
      packages: PACKAGE_IDENTITIES.map(({ name }) => absentRegistryPackage(name)),
    },
    release: releaseRecord("absent"),
    requiredSmokeLanes: ["install", "runtime"],
    smokes: [
      {
        name: "install",
        status: "pending",
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: null,
        workflowRunId: 100,
        runAttempt: 1,
      },
      {
        name: "runtime",
        status: "pending",
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: null,
        workflowRunId: 101,
        runAttempt: 1,
      },
    ],
    audit: {
      status: "none",
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256: null,
      workflowRunId: 300,
      runAttempt: 1,
    },
    abandonment: {
      requested: false,
      recorded: false,
    },
  }
}

function observationFor(state) {
  const observation = baseObservation()
  if (state === "SUPERSEDED_NOOP") {
    setPackageLatest(observation, NEWER_VERSION)
    return observation
  }
  if (state === "CANDIDATE_VALIDATED") {
    return observation
  }

  observation.tag = { status: "present", commitSha: COMMIT_SHA }
  if (state === "CANDIDATE_TAGGED") {
    return observation
  }

  observation.artifacts = {
    status: state === "ARTIFACTS_PREPARED" ? "prepared" : "attested",
    manifestVersion: VERSION,
    manifestCommitSha: COMMIT_SHA,
    manifestSha256: MANIFEST_SHA256,
    files: PACKAGE_IDENTITIES.map((pkg) => artifactFile(pkg, "valid")),
  }
  for (const smoke of observation.smokes) {
    smoke.manifestSha256 = MANIFEST_SHA256
  }
  if (state === "ARTIFACTS_PREPARED" || state === "ARTIFACTS_ATTESTED") {
    return observation
  }

  observation.escrow.status = "present"
  observation.escrow.manifestSha256 = MANIFEST_SHA256
  observation.escrow.assets = PACKAGE_IDENTITIES.map((pkg) => releaseAsset(pkg, "matching"))
  observation.release = releaseRecord("draft")
  if (state === "CANDIDATE_ESCROWED") {
    return observation
  }

  observation.registry.publishJobStarted = true
  observation.registry.mutationStarted = true
  observation.registry.packages[0] = presentRegistryPackage(PACKAGE_IDENTITIES[0])
  if (state === "NPM_PARTIAL") {
    return observation
  }

  observation.registry.packages[1] = presentRegistryPackage(PACKAGE_IDENTITIES[1])
  if (state === "NPM_COMPLETE") {
    return observation
  }

  observation.release = releaseRecord(
    ["RELEASE_PUBLISHED", "AUDIT_DISPATCHED", "AUDIT_COMPLETE"].includes(state)
      ? "published"
      : "draft",
    { metadataReconciled: true },
  )
  if (state === "RELEASE_DRAFT_COMPLETE") {
    return observation
  }

  for (const smoke of observation.smokes) {
    smoke.status = "passed"
    smoke.workflowRunId = 100 + observation.smokes.indexOf(smoke)
    smoke.runAttempt = 1
  }
  if (state === "SMOKES_COMPLETE") {
    return observation
  }
  if (state === "RELEASE_PUBLISHED") {
    return observation
  }

  observation.audit = auditRecord(state === "AUDIT_DISPATCHED" ? "dispatched" : "success")
  if (state === "AUDIT_DISPATCHED" || state === "AUDIT_COMPLETE") {
    return observation
  }

  if (state === "ABANDONED_PREPUBLICATION") {
    const abandoned = observationFor("CANDIDATE_TAGGED")
    abandoned.abandonment = { requested: true, recorded: true }
    return abandoned
  }
  throw new Error(`Unknown test state ${state}`)
}

function absentRegistryPackage(name) {
  return {
    name,
    status: "e404",
    version: null,
    tarballSha256: null,
    integrity: null,
    latest: { status: "e404", version: null },
    signature: { status: "missing" },
    provenance: null,
  }
}

function ambiguousRegistryPackage(name) {
  return {
    name,
    status: "ambiguous",
    version: null,
    tarballSha256: null,
    integrity: null,
    latest: { status: "ambiguous", version: null },
    signature: { status: "ambiguous" },
    provenance: null,
  }
}

function presentRegistryPackage(pkg) {
  return {
    name: pkg.name,
    status: "present",
    version: pkg.version,
    tarballSha256: pkg.tarballSha256,
    integrity: pkg.integrity,
    latest: { status: "present", version: pkg.version },
    signature: { status: "valid" },
    provenance: {
      workflow: PUBLISHER_WORKFLOW,
      commitSha: COMMIT_SHA,
    },
  }
}

function releaseRecord(status, { metadataReconciled = false } = {}) {
  return {
    status,
    tag: status === "absent" ? null : `v${VERSION}`,
    commitSha: status === "absent" ? null : COMMIT_SHA,
    metadataReconciled: status === "absent" ? false : metadataReconciled,
    assets: status === "absent" ? [] : PACKAGE_IDENTITIES.map((pkg) => releaseAsset(pkg)),
  }
}

function artifactFile(pkg, status) {
  return {
    name: pkg.name,
    status,
    assetName: pkg.filename,
    sha256: status === "pending" ? null : pkg.tarballSha256,
    integrity: status === "pending" ? null : pkg.integrity,
  }
}

function releaseAsset(pkg, status = "matching") {
  return {
    name: pkg.filename,
    status,
    sha256: pkg.tarballSha256,
  }
}

function setPackageLatest(observation, version, status = "present") {
  for (const pkg of observation.registry.packages) {
    pkg.latest = { status, version: status === "present" ? version : null }
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") {
    return
  }
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) {
    assertRecursivelyFrozen(child)
  }
}
