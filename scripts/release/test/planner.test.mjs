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
const RELEASE_RECORD_SHA256 = "c".repeat(64)
const MANIFEST_ATTESTATION_NAME = "manifest.json.intoto.jsonl"
const MANIFEST_ATTESTATION_SHA256 = "f".repeat(64)
const CI_WORKFLOW = "CI"
const CI_CHECK = "validate"
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
    attestationFilename: `dawn-ai-core-${VERSION}.tgz.intoto.jsonl`,
    attestationSha256: "d".repeat(64),
    integrity: "sha512-core",
  },
  {
    name: "@dawn-ai/sdk",
    version: VERSION,
    filename: `dawn-ai-sdk-${VERSION}.tgz`,
    tarballSha256: "2".repeat(64),
    attestationFilename: `dawn-ai-sdk-${VERSION}.tgz.intoto.jsonl`,
    attestationSha256: "e".repeat(64),
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
              ...(row.transition === "dispatch-release-audit" ? { tag: `v${VERSION}` } : {}),
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
  observation.registry.packages[0].integrity = "sha512-otherbytes"

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
      check: CI_CHECK,
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
        commitSha: COMMIT_SHA,
        manifestSha256: MANIFEST_SHA256,
        workflowRunId: 999,
        runAttempt: 1,
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

const semanticSchemaCases = [
  ["inventory status enum", (o) => (o.inventory.status = "unknown")],
  ["CI status enum", (o) => (o.ci.status = "unknown")],
  ["tag status enum", (o) => (o.tag.status = "unknown")],
  ["artifact status enum", (o) => (o.artifacts.status = "unknown")],
  ["artifact file status enum", (o) => (o.artifacts.files[0].status = "unknown")],
  [
    "attestation status enum",
    (o) => (o.artifacts.attestations[0].status = "unknown"),
    "ARTIFACTS_ATTESTED",
  ],
  ["escrow status enum", (o) => (o.escrow.status = "unknown")],
  ["registry package status enum", (o) => (o.registry.packages[0].status = "unknown")],
  ["registry latest status enum", (o) => (o.registry.packages[0].latest.status = "unknown")],
  ["registry signature status enum", (o) => (o.registry.packages[0].signature.status = "unknown")],
  ["Release status enum", (o) => (o.release.status = "unknown")],
  ["smoke status enum", (o) => (o.smokes[0].status = "unknown")],
  ["audit status enum", (o) => (o.audit.status = "unknown")],
  ["strict registry booleans", (o) => (o.registry.publishJobStarted = "false")],
  ["strict abandonment booleans", (o) => (o.abandonment.requested = 1)],
  ["safe package name", (o) => (o.inventory.packages[0].name = "../core")],
  ["exact package SemVer", (o) => (o.inventory.packages[0].version = `${VERSION}+build`)],
  ["safe tarball asset name", (o) => (o.inventory.packages[0].filename = "../core.tgz")],
  ["lowercase tarball SHA-256", (o) => (o.inventory.packages[0].tarballSha256 = "A".repeat(64))],
  ["valid package integrity", (o) => (o.inventory.packages[0].integrity = "")],
  ["full lowercase CI SHA", (o) => (o.ci.commitSha = "A".repeat(40))],
  ["tag identity presence", (o) => (o.tag = { status: "present", commitSha: null })],
  ["absent artifact null digest", (o) => (o.artifacts.manifestSha256 = MANIFEST_SHA256)],
  ["absent escrow has no assets", (o) => o.escrow.assets.push(releaseAsset(PACKAGE_IDENTITIES[0]))],
  ["exact e404 package absence", (o) => (o.registry.packages[0].version = VERSION)],
  ["absent Release has no metadata", (o) => (o.release.metadataReconciled = true)],
  ["required smoke lane type", (o) => (o.requiredSmokeLanes[0] = 1)],
  ["audit none null identity", (o) => (o.audit.workflowRunId = 300)],
  ["audit conclusion correlation", (o) => (o.audit.conclusion = "failure"), "AUDIT_COMPLETE"],
]

for (const [name, mutate, state = "CANDIDATE_VALIDATED"] of semanticSchemaCases) {
  test(`semantic observation schema rejects invalid ${name}`, () => {
    const observation = observationFor(state)
    mutate(observation)

    assertDesiredSchemaBlocked(observation, "observation-schema-invalid")
  })
}

for (const [field, value] of [
  ["version", VERSION],
  ["commitSha", COMMIT_SHA],
  ["manifestSha256", MANIFEST_SHA256],
  ["workflowRunId", 300],
  ["runAttempt", 1],
  ["conclusion", "success"],
]) {
  test(`audit status none requires null ${field}`, () => {
    const observation = baseObservation()
    observation.audit[field] = value

    assertDesiredSchemaBlocked(observation, "observation-schema-invalid")
  })
}

for (const [name, mutate] of [
  ["pending artifact file digest", (o) => (o.artifacts.files[0].sha256 = "1".repeat(64))],
  ["pending artifact file integrity", (o) => (o.artifacts.files[0].integrity = "sha512-core")],
  ["pending attestation digest", (o) => (o.artifacts.attestations[0].sha256 = "d".repeat(64))],
]) {
  test(`absent artifacts reject a ${name}`, () => {
    const observation = baseObservation()
    mutate(observation)

    assertDesiredSchemaBlocked(observation, "observation-schema-invalid")
  })
}

test("prepared artifacts reject already-valid attestation evidence", () => {
  const observation = observationFor("ARTIFACTS_PREPARED")
  observation.artifacts.attestations[0] = attestationRecord(PACKAGE_IDENTITIES[0], "valid")

  assertDesiredSchemaBlocked(observation, "observation-schema-invalid")
})

test("attested artifacts reject pending attestation evidence", () => {
  const observation = observationFor("ARTIFACTS_ATTESTED")
  observation.artifacts.attestations[0] = attestationRecord(PACKAGE_IDENTITIES[0], "pending")

  assertDesiredSchemaBlocked(observation, "observation-schema-invalid")
})

for (const [name, mutate] of [
  ["missing artifact identity record", (o) => delete o.artifacts.manifestAsset],
  ["non-array inventory packages", (o) => (o.inventory.packages = {})],
  ["non-array registry packages", (o) => (o.registry.packages = {})],
  ["non-array Release assets", (o) => (o.release.assets = {})],
]) {
  test(`malformed nested observation blocks without throwing: ${name}`, () => {
    const observation = baseObservation()
    mutate(observation)

    assertDesiredSchemaBlocked(observation, "observation-schema-invalid")
  })
}

for (const [name, mutate] of [
  ["null inventory package", (o) => (o.inventory.packages[0] = null)],
  ["non-object inventory package", (o) => (o.inventory.packages[0] = "core")],
  ["null registry package", (o) => (o.registry.packages[0] = null)],
  ["non-object registry package", (o) => (o.registry.packages[0] = 1)],
  ["null artifact file", (o) => (o.artifacts.files[0] = null)],
  ["non-object artifact file", (o) => (o.artifacts.files[0] = "core.tgz")],
  ["null attestation", (o) => (o.artifacts.attestations[0] = null)],
  ["non-object attestation", (o) => (o.artifacts.attestations[0] = false)],
]) {
  test(`arbitrary JSON blocks without throwing: ${name}`, () => {
    const observation = baseObservation()
    mutate(observation)

    assertDesiredSchemaBlocked(observation, "observation-schema-invalid")
  })
}

const malformedImmutableIdentityCases = [
  ...["manifestAsset", "releaseRecordAsset", "manifestAttestationAsset"].flatMap((recordName) =>
    ["name", "sha256"].flatMap((field) => [
      [`missing artifacts.${recordName}.${field}`, (o) => delete o.artifacts[recordName][field]],
      [`null artifacts.${recordName}.${field}`, (o) => (o.artifacts[recordName][field] = null)],
      [`wrong-type artifacts.${recordName}.${field}`, (o) => (o.artifacts[recordName][field] = 1)],
    ]),
  ),
  ...[
    "name",
    "version",
    "filename",
    "tarballSha256",
    "attestationFilename",
    "attestationSha256",
    "integrity",
  ].flatMap((field) => [
    [`missing inventory package ${field}`, (o) => delete o.inventory.packages[0][field]],
    [`null inventory package ${field}`, (o) => (o.inventory.packages[0][field] = null)],
    [`wrong-type inventory package ${field}`, (o) => (o.inventory.packages[0][field] = 1)],
  ]),
]

const activeManagedAssetVariants = [
  [
    "escrow",
    () => {
      const observation = observationFor("CANDIDATE_ESCROWED")
      observation.release = releaseRecord("absent")
      return observation
    },
  ],
  [
    "Release",
    () => {
      const observation = observationFor("CANDIDATE_ESCROWED")
      observation.escrow = { status: "absent", manifestSha256: null, assets: [] }
      return observation
    },
  ],
]

for (const [variant, createObservation] of activeManagedAssetVariants) {
  for (const [name, mutate] of malformedImmutableIdentityCases) {
    test(`container-shaped malformed ${name} blocks with active ${variant}`, () => {
      const observation = createObservation()
      mutate(observation)

      assertMalformedObservationBlocked(observation)
    })
  }
}

for (const [name, mutate] of [
  [
    "extra registry package",
    (o) => o.registry.packages.push(absentRegistryPackage("@dawn-ai/extra")),
  ],
  ["missing registry package", (o) => o.registry.packages.pop()],
  [
    "duplicate registry package",
    (o) => o.registry.packages.push(structuredClone(o.registry.packages[0])),
  ],
  [
    "extra artifact file",
    (o) =>
      o.artifacts.files.push({
        name: "@dawn-ai/extra",
        status: "pending",
        assetName: `dawn-ai-extra-${VERSION}.tgz`,
        sha256: null,
        integrity: null,
      }),
  ],
  ["missing artifact file", (o) => o.artifacts.files.pop()],
  ["duplicate artifact file", (o) => o.artifacts.files.push(structuredClone(o.artifacts.files[0]))],
  [
    "extra attestation subject",
    (o) =>
      o.artifacts.attestations.push({
        name: `dawn-ai-extra-${VERSION}.tgz.intoto.jsonl`,
        status: "pending",
        sha256: null,
        subjectName: `dawn-ai-extra-${VERSION}.tgz`,
        subjectSha256: "f".repeat(64),
      }),
  ],
  ["missing attestation subject", (o) => o.artifacts.attestations.pop()],
  [
    "duplicate attestation subject",
    (o) => o.artifacts.attestations.push(structuredClone(o.artifacts.attestations[0])),
  ],
  [
    "categorized immutable asset name collision",
    (o) => {
      o.inventory.packages[0].filename = "release-record.json"
      o.artifacts.files[0].assetName = "release-record.json"
      o.artifacts.attestations[0].subjectName = "release-record.json"
    },
  ],
]) {
  test(`canonical observation sets reject ${name}`, () => {
    const observation = baseObservation()
    mutate(observation)

    assertDesiredSchemaBlocked(observation, "observation-schema-invalid")
  })
}

for (const [field, value, conflict] of [
  ["workflow", "Build", "candidate-ci-workflow-mismatch"],
  ["check", "unit", "candidate-ci-check-mismatch"],
  ["commitSha", OTHER_SHA, "candidate-ci-commit-mismatch"],
]) {
  test(`successful CI with the wrong ${field} cannot validate the candidate`, () => {
    const observation = baseObservation()
    observation.ci[field] = value

    assertDesiredSchemaBlocked(observation, conflict)
  })
}

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

for (const { name, conflict } of [
  { name: "manifest.json", conflict: "escrow-manifest-asset-missing" },
  { name: "release-record.json", conflict: "escrow-release-record-asset-missing" },
  {
    name: PACKAGE_IDENTITIES[0].attestationFilename,
    conflict: "escrow-attestation-asset-missing",
  },
  {
    name: PACKAGE_IDENTITIES[1].attestationFilename,
    conflict: "escrow-attestation-asset-missing",
  },
  { name: MANIFEST_ATTESTATION_NAME, conflict: "escrow-attestation-asset-missing" },
]) {
  test(`immutable escrow rejects a missing ${name}`, () => {
    const observation = observationFor("CANDIDATE_ESCROWED")
    observation.escrow.assets = observation.escrow.assets.filter((asset) => asset.name !== name)

    assertDesiredSchemaBlocked(observation, conflict)
  })
}

for (const { name, conflict } of [
  { name: "manifest.json", conflict: "github-manifest-asset-missing" },
  { name: "release-record.json", conflict: "github-release-record-asset-missing" },
  {
    name: PACKAGE_IDENTITIES[0].attestationFilename,
    conflict: "github-attestation-asset-missing",
  },
  {
    name: PACKAGE_IDENTITIES[1].attestationFilename,
    conflict: "github-attestation-asset-missing",
  },
  { name: MANIFEST_ATTESTATION_NAME, conflict: "github-attestation-asset-missing" },
]) {
  test(`immutable draft Release rejects a missing ${name}`, () => {
    const observation = observationFor("CANDIDATE_ESCROWED")
    observation.release.assets = observation.release.assets.filter((asset) => asset.name !== name)

    assertDesiredSchemaBlocked(observation, conflict)
  })
}

test("tarball-only escrow cannot reach CANDIDATE_ESCROWED", () => {
  const observation = observationFor("CANDIDATE_ESCROWED")
  const tarballNames = new Set(PACKAGE_IDENTITIES.map((pkg) => pkg.filename))
  observation.escrow.assets = observation.escrow.assets.filter((asset) =>
    tarballNames.has(asset.name),
  )
  observation.release.assets = observation.release.assets.filter((asset) =>
    tarballNames.has(asset.name),
  )

  const plan = planRelease({ candidate: candidate(), observation })

  assert.notEqual(plan.state, "CANDIDATE_ESCROWED")
  assert.equal(plan.disposition, "blocked")
})

test("immutable escrow rejects an exact-name digest mismatch", () => {
  const observation = observationFor("CANDIDATE_ESCROWED")
  observation.escrow.assets.find((asset) => asset.name === "manifest.json").sha256 =
    OTHER_MANIFEST_SHA256

  assertDesiredSchemaBlocked(observation, "escrow-asset-bytes-mismatch")
})

test("manifest provenance completes the exact attestation subject set", () => {
  const observation = observationFor("ARTIFACTS_ATTESTED")

  const plan = planRelease({ candidate: candidate(), observation })

  assert.equal(plan.state, "ARTIFACTS_ATTESTED")
  assert.equal(plan.disposition, "would-transition")
  assert.equal(plan.nextTransition, "escrow-candidate")
  assert.deepEqual(plan.conflicts, [])
})

test("attested artifacts reject a missing manifest provenance attestation", () => {
  const observation = observationFor("ARTIFACTS_ATTESTED")
  observation.artifacts.attestations = observation.artifacts.attestations.filter(
    (attestation) => attestation.subjectName !== "manifest.json",
  )

  assertDesiredSchemaBlocked(observation, "artifact-manifest-attestation-missing")
})

test("attested artifacts reject a corrupt manifest provenance bundle", () => {
  const observation = observationFor("ARTIFACTS_ATTESTED")
  const attestation = observation.artifacts.attestations.find(
    (record) => record.subjectName === "manifest.json",
  )
  attestation.status = "corrupt"
  attestation.sha256 = null

  assertDesiredSchemaBlocked(observation, "artifact-attestation-corrupt")
})

test("attested artifacts reject an invalid manifest provenance bundle digest", () => {
  const observation = observationFor("ARTIFACTS_ATTESTED")
  observation.artifacts.attestations.find(
    (attestation) => attestation.subjectName === "manifest.json",
  ).sha256 = OTHER_MANIFEST_SHA256

  assertDesiredSchemaBlocked(observation, "artifact-attestation-digest-mismatch")
})

test("attested artifacts reject the wrong manifest provenance subject name", () => {
  const observation = observationFor("ARTIFACTS_ATTESTED")
  observation.artifacts.attestations.find(
    (attestation) => attestation.subjectName === "manifest.json",
  ).subjectName = "manifest-copy.json"

  assertDesiredSchemaBlocked(observation, "artifact-attestation-subject-set-mismatch")
})

test("attested artifacts reject the wrong manifest provenance subject digest", () => {
  const observation = observationFor("ARTIFACTS_ATTESTED")
  observation.artifacts.attestations.find(
    (attestation) => attestation.subjectName === "manifest.json",
  ).subjectSha256 = OTHER_MANIFEST_SHA256

  assertDesiredSchemaBlocked(observation, "artifact-attestation-subject-mismatch")
})

for (const target of ["escrow", "release"]) {
  test(`${target} rejects a mismatched manifest provenance asset digest`, () => {
    const observation = observationFor("CANDIDATE_ESCROWED")
    observation[target].assets.find((asset) => asset.name === MANIFEST_ATTESTATION_NAME).sha256 =
      OTHER_MANIFEST_SHA256

    assertDesiredSchemaBlocked(
      observation,
      target === "escrow" ? "escrow-asset-bytes-mismatch" : "github-asset-bytes-mismatch",
    )
  })
}

for (const status of ["failed", "expired"]) {
  test(`a correlated ${status} audit attempt is retryable from the published Release`, () => {
    const observation = observationFor("RELEASE_PUBLISHED")
    observation.audit = auditRecord(status)

    const plan = planRelease({ candidate: candidate(), observation })

    assert.equal(plan.state, "RELEASE_PUBLISHED")
    assert.equal(plan.disposition, "would-transition")
    assert.equal(plan.nextTransition, "dispatch-release-audit")
    assert.deepEqual(plan.conflicts, [])
    assert.deepEqual(plan.proposedMutations, [
      {
        type: "dispatch-release-audit",
        version: VERSION,
        commitSha: COMMIT_SHA,
        tag: `v${VERSION}`,
      },
    ])
  })
}

test("a failed audit attempt with mismatched identity remains blocked", () => {
  const observation = observationFor("RELEASE_PUBLISHED")
  observation.audit = auditRecord("failed")
  observation.audit.commitSha = OTHER_SHA

  assertDesiredSchemaBlocked(observation, "release-audit-commit-mismatch")
})

test("an exactly identified ambiguous audit attempt blocks instead of becoming absence", () => {
  const observation = observationFor("RELEASE_PUBLISHED")
  observation.audit = auditRecord("ambiguous")

  assertDesiredSchemaBlocked(observation, "release-audit-ambiguous")
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

function assertMalformedObservationBlocked(observation) {
  const input = deepFreeze({ candidate: candidate(), observation, mode: "shadow" })
  const before = JSON.stringify(input)
  let first
  let second

  assert.doesNotThrow(() => {
    first = planRelease(input)
    second = planRelease(input)
  })
  assert.deepEqual(second, first)
  assert.equal(first.state, "CANDIDATE_VALIDATED")
  assert.equal(first.disposition, "blocked")
  assert.equal(first.nextTransition, null)
  assert.ok(first.conflicts.includes("observation-schema-invalid"), JSON.stringify(first.conflicts))
  assert.deepEqual(first.proposedMutations, [])
  assert.equal(JSON.stringify(input), before)
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
    conclusion:
      status === "success"
        ? "success"
        : status === "failed"
          ? "failure"
          : status === "expired"
            ? "expired"
            : null,
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
    ciWorkflow: CI_WORKFLOW,
    ciCheck: CI_CHECK,
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
      check: CI_CHECK,
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
      manifestAsset: { name: "manifest.json", sha256: null },
      releaseRecordAsset: { name: "release-record.json", sha256: null },
      manifestAttestationAsset: { name: MANIFEST_ATTESTATION_NAME, sha256: null },
      attestations: [
        ...PACKAGE_IDENTITIES.map((pkg) => attestationRecord(pkg, "pending")),
        manifestAttestationRecord("pending"),
      ],
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
      version: null,
      commitSha: null,
      manifestSha256: null,
      workflowRunId: null,
      runAttempt: null,
      conclusion: null,
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
    manifestAsset: { name: "manifest.json", sha256: MANIFEST_SHA256 },
    releaseRecordAsset: { name: "release-record.json", sha256: RELEASE_RECORD_SHA256 },
    manifestAttestationAsset: {
      name: MANIFEST_ATTESTATION_NAME,
      sha256: state === "ARTIFACTS_PREPARED" ? null : MANIFEST_ATTESTATION_SHA256,
    },
    attestations: [
      ...PACKAGE_IDENTITIES.map((pkg) =>
        attestationRecord(pkg, state === "ARTIFACTS_PREPARED" ? "pending" : "valid"),
      ),
      manifestAttestationRecord(state === "ARTIFACTS_PREPARED" ? "pending" : "valid"),
    ],
  }
  for (const smoke of observation.smokes) {
    smoke.manifestSha256 = MANIFEST_SHA256
  }
  if (state === "ARTIFACTS_PREPARED" || state === "ARTIFACTS_ATTESTED") {
    return observation
  }

  observation.escrow.status = "present"
  observation.escrow.manifestSha256 = MANIFEST_SHA256
  observation.escrow.assets = immutableAssets().map((asset) => ({ ...asset, status: "matching" }))
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
    assets:
      status === "absent"
        ? []
        : immutableAssets().map((asset) => ({ ...asset, status: "matching" })),
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

function attestationRecord(pkg, status) {
  return {
    name: pkg.attestationFilename,
    status,
    sha256: status === "valid" ? pkg.attestationSha256 : null,
    subjectName: pkg.filename,
    subjectSha256: pkg.tarballSha256,
  }
}

function manifestAttestationRecord(status) {
  return {
    name: MANIFEST_ATTESTATION_NAME,
    status,
    sha256: status === "valid" ? MANIFEST_ATTESTATION_SHA256 : null,
    subjectName: "manifest.json",
    subjectSha256: MANIFEST_SHA256,
  }
}

function immutableAssets() {
  return [
    { name: "release-record.json", sha256: RELEASE_RECORD_SHA256 },
    { name: "manifest.json", sha256: MANIFEST_SHA256 },
    { name: MANIFEST_ATTESTATION_NAME, sha256: MANIFEST_ATTESTATION_SHA256 },
    ...PACKAGE_IDENTITIES.map((pkg) => ({ name: pkg.filename, sha256: pkg.tarballSha256 })),
    ...PACKAGE_IDENTITIES.map((pkg) => ({
      name: pkg.attestationFilename,
      sha256: pkg.attestationSha256,
    })),
  ]
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
