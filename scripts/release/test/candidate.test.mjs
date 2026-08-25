import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { canonicalAbandonmentBytes, canonicalAbandonmentReleaseBody } from "../abandonment.mjs"
import {
  arbitrateCandidate,
  decideInvocation,
  discoverManagedCandidate,
  discoverScheduledCandidate,
  waitForRequiredCi,
} from "../candidate.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import { abandonmentReleaseMarker, canonicalReleaseBody, parseReleaseMarker } from "../metadata.mjs"

const MARKER_PATH = "scripts/release/controller-schema.json"
const ACTIVE_MARKER = Object.freeze({
  schemaVersion: 1,
  publishingOwner: "release-controller",
  epoch: "fixed-group-v1",
  npmTrustedPublisherEnvironment: null,
  abandonmentEnvironment: "release-abandonment",
})
const BASE_SHA = "1".repeat(40)
const CUTOVER_SHA = "2".repeat(40)
const SHA_21 = "3".repeat(40)
const SHA_22 = "4".repeat(40)
const SHA_23 = "5".repeat(40)
const SHA_24 = "6".repeat(40)
const OTHER_SHA = "a".repeat(40)
const PACKAGE_NAMES = [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(compareText)

test("the ownership-switch marker without a fixed-group version delta is NO_CANDIDATE", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20"),
    commit(CUTOVER_SHA, "0.8.20", { parent: BASE_SHA, marker: true }),
  ])

  const result = await discoverManagedCandidate({
    ref: CUTOVER_SHA,
    inventory: repository.inventory,
    git: repository.git,
    marker: ACTIVE_MARKER,
  })

  assert.equal(result.state, "NO_CANDIDATE")
  assert.equal(result.candidate, null)
  assert.equal(result.disposition, "noop")
})

test("an active first-parent commit changing all 21 versions is a candidate despite new changesets", async () => {
  const repository = repositoryFixture([
    commit(CUTOVER_SHA, "0.8.20", { marker: true }),
    commit(SHA_21, "0.8.21", {
      parent: CUTOVER_SHA,
      marker: true,
      tree: [".changeset/a-new-change.md", ".changeset/another-change.md"],
    }),
  ])

  const result = await discoverManagedCandidate({
    ref: "origin/main",
    inventory: repository.inventory,
    git: repository.git,
    marker: ACTIVE_MARKER,
  })

  assert.deepEqual(result, selectedCandidate("0.8.21", SHA_21, "CANDIDATE_VALIDATED"))
  assert.deepEqual(
    repository.calls.filter(([operation]) => operation === "showFile"),
    [["showFile", SHA_21, MARKER_PATH]],
  )
  assert.ok(
    repository.calls.every(
      ([operation, , path]) => operation !== "showFile" || !path.startsWith(".changeset/"),
    ),
  )
})

test("a legacy version commit without the active marker is audit-only", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20"),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA }),
  ])

  const result = await discoverManagedCandidate({
    ref: SHA_21,
    inventory: repository.inventory,
    git: repository.git,
    marker: ACTIVE_MARKER,
  })

  assert.equal(result.state, "SUPERSEDED_NOOP")
  assert.equal(result.disposition, "audit-only")
  assert.deepEqual(result.candidate, candidateIdentity("0.8.21", SHA_21))
  assert.deepEqual(result.conflicts, [])
})

test("candidate discovery rejects an active version commit that is not provably on main", async () => {
  for (const ancestry of [false, null]) {
    const repository = repositoryFixture(
      [
        commit(BASE_SHA, "0.8.20", { marker: true }),
        commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
      ],
      { ancestry },
    )

    await assert.rejects(
      discoverManagedCandidate({
        ref: SHA_21,
        inventory: repository.inventory,
        git: repository.git,
        marker: ACTIVE_MARKER,
      }),
      /reachable from main/u,
    )
  }

  const repository = repositoryFixture(
    [
      commit(BASE_SHA, "0.8.20", { marker: true }),
      commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
    ],
    { ancestryError: new Error("ancestry unavailable") },
  )
  await assert.rejects(
    discoverManagedCandidate({
      ref: SHA_21,
      inventory: repository.inventory,
      git: repository.git,
      marker: ACTIVE_MARKER,
    }),
    /ancestry unavailable/u,
  )
})

test("scheduled standalone recovery rejects an off-main candidate tag", async () => {
  const repository = repositoryFixture(
    [
      commit(BASE_SHA, "0.8.20", { marker: true }),
      commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
    ],
    { ancestry: false },
  )

  await assert.rejects(
    discoverScheduledCandidate({
      inventory: repository.inventory,
      git: repository.git,
      github: githubFixture({ tags: [tagRef("0.8.21", SHA_21)] }),
      marker: ACTIVE_MARKER,
    }),
    /reachable from main/u,
  )
})

test("scheduled arbitration rejects a lightweight managed tag before terminal selection", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20", { marker: true }),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
  ])
  const lightweight = {
    ref: "refs/tags/v0.8.21",
    object: { type: "commit", sha: SHA_21 },
    peeledCommitSha: SHA_21,
  }

  await assert.rejects(
    discoverScheduledCandidate({
      inventory: repository.inventory,
      git: repository.git,
      github: githubFixture({ tags: [lightweight] }),
      marker: ACTIVE_MARKER,
    }),
    /annotated/u,
  )
})

test("scheduled discovery enumerates managed Releases and standalone tags before choosing the oldest incomplete tag", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20"),
    commit(CUTOVER_SHA, "0.8.20", { parent: BASE_SHA, marker: true }),
    commit(SHA_21, "0.8.21", { parent: CUTOVER_SHA, marker: true }),
    commit(SHA_22, "0.8.22", { parent: SHA_21, marker: true }),
    commit(SHA_23, "0.8.23", { parent: SHA_22, marker: true }),
    commit(SHA_24, "0.8.24", { parent: SHA_23, marker: true }),
  ])
  const github = githubFixture({
    tags: [
      tagRef("0.8.24", SHA_24),
      tagRef("0.8.23", SHA_23),
      tagRef("0.8.22", SHA_22),
      tagRef("0.8.21", SHA_21),
    ],
    releases: [
      managedRelease(24, "0.8.24", SHA_24, { auditComplete: true, published: true }),
      unmanagedRelease(99),
      managedRelease(23, "0.8.23", SHA_23, { abandoned: true }),
      managedRelease(22, "0.8.22", SHA_22),
    ],
  })

  const result = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github,
    marker: ACTIVE_MARKER,
  })

  assert.deepEqual(result, selectedCandidate("0.8.21", SHA_21, "CANDIDATE_TAGGED"))
  assert.deepEqual(
    github.calls.filter(([operation]) => operation === "listReleases"),
    [["listReleases"]],
  )
  assert.deepEqual(
    github.calls
      .filter(([operation]) => operation === "downloadReleaseAsset")
      .map(([, assetId]) => assetId)
      .sort((left, right) => left - right),
    [221, 233, 241, 242],
  )
  assert.ok(github.calls.every(([operation, id]) => operation !== "listReleaseAssets" || id !== 99))
})

test("a standalone active candidate tag is recovered as CANDIDATE_TAGGED", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20", { marker: true }),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
  ])
  const github = githubFixture({ tags: [tagRef("0.8.21", SHA_21)] })

  const result = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github,
    marker: ACTIVE_MARKER,
  })

  assert.deepEqual(result, selectedCandidate("0.8.21", SHA_21, "CANDIDATE_TAGGED"))
})

test("a markerless legacy v* Release is audit-only and does not block active discovery", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20"),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA }),
    commit(CUTOVER_SHA, "0.8.21", { parent: SHA_21, marker: true }),
    commit(SHA_22, "0.8.22", { parent: CUTOVER_SHA, marker: true }),
  ])
  const legacy = managedRelease(21, "0.8.21", SHA_21, { published: true })
  legacy.assets = []

  const result = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github: githubFixture({ tags: [tagRef("0.8.21", SHA_21)], releases: [legacy] }),
    marker: ACTIVE_MARKER,
  })

  assert.deepEqual(result, selectedCandidate("0.8.22", SHA_22, "CANDIDATE_VALIDATED"))
})

test("a draft Release record identifies a tagged candidate without overstating escrow progress", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20"),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
  ])
  const github = githubFixture({
    tags: [tagRef("0.8.21", SHA_21)],
    releases: [managedRelease(21, "0.8.21", SHA_21)],
  })

  const result = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github,
    marker: ACTIVE_MARKER,
  })

  assert.deepEqual(result, selectedCandidate("0.8.21", SHA_21, "CANDIDATE_TAGGED"))
})

test("a managed v* Release without exactly one release record fails closed", async () => {
  for (const assets of [[], [releaseRecordAsset(211), releaseRecordAsset(212)]]) {
    const repository = repositoryFixture([
      commit(BASE_SHA, "0.8.20", { marker: true }),
      commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
    ])
    const release = managedRelease(21, "0.8.21", SHA_21)
    release.assets = assets
    const github = githubFixture({ tags: [tagRef("0.8.21", SHA_21)], releases: [release] })

    await assert.rejects(
      discoverScheduledCandidate({
        inventory: repository.inventory,
        git: repository.git,
        github,
        marker: ACTIVE_MARKER,
      }),
      /exactly one release-record\.json/u,
    )
  }
})

test("scheduled discovery rejects a release-record identity that conflicts with its tag", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20", { marker: true }),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
  ])
  const release = managedRelease(21, "0.8.21", SHA_21)
  release.record.commitSha = OTHER_SHA
  const github = githubFixture({ tags: [tagRef("0.8.21", SHA_21)], releases: [release] })

  await assert.rejects(
    discoverScheduledCandidate({
      inventory: repository.inventory,
      git: repository.git,
      github,
      marker: ACTIVE_MARKER,
    }),
    /release record identity/u,
  )
})

test("scheduled discovery rejects terminal audit evidence for another manifest", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20"),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
  ])
  const release = managedRelease(21, "0.8.21", SHA_21, {
    auditComplete: true,
    published: true,
  })
  release.auditResult.manifestSha256 = "d".repeat(64)
  const github = githubFixture({ tags: [tagRef("0.8.21", SHA_21)], releases: [release] })

  await assert.rejects(
    discoverScheduledCandidate({
      inventory: repository.inventory,
      git: repository.git,
      github,
      marker: ACTIVE_MARKER,
    }),
    /audit result identity/u,
  )
})

test("scheduled discovery never excludes an audit-looking Release without durable smoke authority", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20"),
    commit(CUTOVER_SHA, "0.8.20", { parent: BASE_SHA, marker: true }),
    commit(SHA_21, "0.8.21", { parent: CUTOVER_SHA, marker: true }),
    commit(SHA_22, "0.8.22", { parent: SHA_21, marker: true }),
  ])
  const older = managedRelease(21, "0.8.21", SHA_21, {
    auditComplete: true,
    published: true,
  })

  const result = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github: githubFixture({ tags: [tagRef("0.8.21", SHA_21)], releases: [older] }),
    marker: ACTIVE_MARKER,
  })

  assert.deepEqual(result, selectedCandidate("0.8.21", SHA_21, "CANDIDATE_TAGGED"))
})

test("only a published Release with a strict consistent successful audit is terminal", async () => {
  const cases = [
    {
      name: "draft Release",
      mutate(release) {
        release.draft = true
      },
    },
    {
      name: "skeletal result",
      mutate(release) {
        delete release.auditResult.workflowRunId
      },
    },
    {
      name: "reversed timestamps",
      mutate(release) {
        release.auditResult.finishedAt = "2026-08-24T11:59:59Z"
      },
    },
    {
      name: "hidden failed check",
      mutate(release) {
        release.auditResult.checks[0].conclusion = "failure"
      },
    },
  ]

  for (const fixture of cases) {
    const repository = repositoryFixture([
      commit(BASE_SHA, "0.8.20"),
      commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
    ])
    const release = managedRelease(21, "0.8.21", SHA_21, {
      auditComplete: true,
      published: true,
    })
    fixture.mutate(release)

    await assert.rejects(
      discoverScheduledCandidate({
        inventory: repository.inventory,
        git: repository.git,
        github: githubFixture({ tags: [tagRef("0.8.21", SHA_21)], releases: [release] }),
        marker: ACTIVE_MARKER,
      }),
      /audit result|published Release/iu,
      fixture.name,
    )
  }
})

test("only a draft Release with a complete protected abandonment tombstone is terminal", async () => {
  const cases = [
    {
      name: "published Release",
      mutate(release) {
        release.draft = false
      },
    },
    {
      name: "skeletal tombstone",
      mutate(release) {
        delete release.abandonment.actor
        release.abandonmentBytes = Buffer.from(JSON.stringify(release.abandonment))
      },
    },
    {
      name: "publish history started",
      mutate(release) {
        release.abandonment.actionsHistory.publishJobStarted = true
        release.abandonmentBytes = Buffer.from(JSON.stringify(release.abandonment))
      },
    },
    {
      name: "incomplete package observation",
      mutate(release) {
        release.abandonment.observations[1].packages.pop()
        release.abandonmentBytes = Buffer.from(JSON.stringify(release.abandonment))
      },
    },
  ]

  for (const fixture of cases) {
    const repository = repositoryFixture([
      commit(BASE_SHA, "0.8.20"),
      commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
    ])
    const release = managedRelease(21, "0.8.21", SHA_21, { abandoned: true })
    fixture.mutate(release)

    await assert.rejects(
      discoverScheduledCandidate({
        inventory: repository.inventory,
        git: repository.git,
        github: githubFixture({ tags: [tagRef("0.8.21", SHA_21)], releases: [release] }),
        marker: ACTIVE_MARKER,
      }),
      /abandonment|draft Release/iu,
      fixture.name,
    )
  }
})

test("scheduled recovery recognizes tagged-only canonical abandonment before release-record gating", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20"),
    commit(CUTOVER_SHA, "0.8.20", { parent: BASE_SHA, marker: true }),
    commit(SHA_21, "0.8.21", { parent: CUTOVER_SHA, marker: true }),
    commit(SHA_22, "0.8.22", { parent: SHA_21, marker: true }),
  ])
  const abandoned = managedRelease(21, "0.8.21", SHA_21, {
    abandoned: true,
    releaseRecord: false,
  })

  const result = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github: githubFixture({
      tags: [tagRef("0.8.21", SHA_21)],
      releases: [abandoned],
    }),
    marker: ACTIVE_MARKER,
  })

  assert.deepEqual(result, selectedCandidate("0.8.22", SHA_22, "CANDIDATE_VALIDATED"))
})

test("scheduled recovery requires strong verification before excluding exact attested abandonment", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20"),
    commit(CUTOVER_SHA, "0.8.20", { parent: BASE_SHA, marker: true }),
    commit(SHA_21, "0.8.21", { parent: CUTOVER_SHA, marker: true }),
    commit(SHA_22, "0.8.22", { parent: SHA_21, marker: true }),
  ])
  const abandoned = terminalAttestedAbandonmentRelease(21, "0.8.21", SHA_21)

  const blocked = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github: githubFixture({
      tags: [tagRef("0.8.21", SHA_21)],
      releases: [abandoned],
    }),
    marker: ACTIVE_MARKER,
  })
  assert.deepEqual(blocked, {
    ...selectedCandidate("0.8.21", SHA_21, "CANDIDATE_TAGGED"),
    disposition: "blocked",
    conflicts: ["abandonment-cryptographic-reverification-required"],
  })

  const result = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github: githubFixture({
      tags: [tagRef("0.8.21", SHA_21)],
      releases: [abandoned],
    }),
    marker: ACTIVE_MARKER,
    async verifyTerminalAbandonment(input) {
      assert.equal(input.candidate.commitSha, SHA_21)
      assert.equal(input.release.bodySha256, sha256(Buffer.from(abandoned.body, "utf8")))
      return true
    },
  })

  assert.deepEqual(result, selectedCandidate("0.8.22", SHA_22, "CANDIDATE_VALIDATED"))
})

test("scheduled recovery keeps both abandonment runner-loss boundaries nonterminal", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20", { marker: true }),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
  ])
  const markerBeforeAsset = managedRelease(21, "0.8.21", SHA_21, {
    abandoned: true,
    releaseRecord: false,
  })
  markerBeforeAsset.assets = []
  const assetBeforeMarker = interruptedAbandonmentRelease(21, "0.8.21", SHA_21)

  for (const [release, conflict] of [
    [markerBeforeAsset, "abandonment-asset-reconciliation-required"],
    [assetBeforeMarker, "abandonment-marker-reconciliation-required"],
  ]) {
    const result = await discoverScheduledCandidate({
      inventory: repository.inventory,
      git: repository.git,
      github: githubFixture({
        tags: [tagRef("0.8.21", SHA_21)],
        releases: [release],
      }),
      marker: ACTIVE_MARKER,
    })
    assert.deepEqual(result, {
      ...selectedCandidate("0.8.21", SHA_21, "CANDIDATE_TAGGED"),
      disposition: "blocked",
      conflicts: [conflict],
    })
  }
})

test("terminal abandonment requires exact canonical bytes, marker digest, metadata, and namespace", async () => {
  const cases = [
    [
      "noncanonical tombstone",
      (release) => (release.abandonmentBytes = Buffer.from(JSON.stringify(release.abandonment))),
    ],
    [
      "missing durable body record",
      (release) =>
        (release.body = canonicalReleaseBody({
          marker: parseReleaseMarker(release.body),
          manifest: null,
        })),
    ],
    ["wrong title", (release) => (release.name = "conflicting title")],
    ["unknown asset", (release) => release.assets.push({ id: 999, name: "notes.txt" })],
  ]

  for (const [name, mutate] of cases) {
    const repository = repositoryFixture([
      commit(BASE_SHA, "0.8.20", { marker: true }),
      commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
    ])
    const release = managedRelease(21, "0.8.21", SHA_21, {
      abandoned: true,
      releaseRecord: false,
    })
    mutate(release)
    await assert.rejects(
      discoverScheduledCandidate({
        inventory: repository.inventory,
        git: repository.git,
        github: githubFixture({
          tags: [tagRef("0.8.21", SHA_21)],
          releases: [release],
        }),
        marker: ACTIVE_MARKER,
      }),
      /abandonment|canonical|metadata|namespace|asset/iu,
      name,
    )
  }
})

test("abandonment asset metadata is bounded before the first download", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20", { marker: true }),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
  ])
  const release = managedRelease(21, "0.8.21", SHA_21, {
    abandoned: true,
    releaseRecord: false,
  })
  release.assets.push(
    ...Array.from({ length: 46 }, (_, index) => ({
      id: 1_000 + index,
      name: `unexpected-${index}.json`,
    })),
  )
  const github = githubFixture({
    tags: [tagRef("0.8.21", SHA_21)],
    releases: [release],
  })

  await assert.rejects(
    discoverScheduledCandidate({
      inventory: repository.inventory,
      git: repository.git,
      github,
      marker: ACTIVE_MARKER,
    }),
    /asset|bounded|namespace/iu,
  )
  assert.equal(
    github.calls.some(([operation]) => operation === "downloadReleaseAsset"),
    false,
  )
})

test("scheduled discovery keeps an audit-looking release selected until smoke authority exists", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20"),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
    commit(SHA_22, "0.8.22", { parent: SHA_21, marker: true }),
    commit(SHA_23, "0.8.23", { parent: SHA_22, marker: true }),
  ])
  const audited = managedRelease(21, "0.8.21", SHA_21, {
    auditComplete: true,
    published: true,
  })
  const github = githubFixture({ tags: [tagRef("0.8.21", SHA_21)], releases: [audited] })

  const result = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github,
    marker: ACTIVE_MARKER,
  })

  assert.deepEqual(result, selectedCandidate("0.8.21", SHA_21, "CANDIDATE_TAGGED"))
  assert.equal(
    repository.calls.some(
      ([operation, ref, maxCount]) =>
        operation === "history" && ref === "main" && maxCount === 1000,
    ),
    false,
  )
})

test("scheduled history stops at pre-marker root history instead of requiring a first parent", async () => {
  const repository = repositoryFixture([
    commit(OTHER_SHA, "0.8.19"),
    commit(BASE_SHA, "0.8.20", { parent: OTHER_SHA }),
    commit(CUTOVER_SHA, "0.8.20", { parent: BASE_SHA, marker: true }),
  ])

  const result = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github: githubFixture(),
    marker: ACTIVE_MARKER,
  })

  assert.equal(result.state, "NO_CANDIDATE")
  assert.equal(
    repository.calls.some(([operation, ref]) => operation === "firstParent" && ref === BASE_SHA),
    false,
  )
  assert.equal(
    repository.calls.some(([operation, ref]) => operation === "listTree" && ref === OTHER_SHA),
    false,
  )
})

test("an older incomplete tag wins over a newer commit and is redispatched at its immutable tag", async () => {
  const repository = repositoryFixture([
    commit(BASE_SHA, "0.8.20", { marker: true }),
    commit(SHA_21, "0.8.21", { parent: BASE_SHA, marker: true }),
    commit(SHA_22, "0.8.22", { parent: SHA_21, marker: true }),
  ])
  const github = githubFixture({ tags: [tagRef("0.8.21", SHA_21)] })

  const selected = await discoverScheduledCandidate({
    inventory: repository.inventory,
    git: repository.git,
    github,
    marker: ACTIVE_MARKER,
  })
  const invocation = decideInvocation({
    candidateVersion: "0.8.21",
    candidateSha: selected.candidate.commitSha,
    githubSha: SHA_22,
    githubRef: "refs/heads/main",
    tagState: { status: "present", tag: selected.tag, commitSha: SHA_21 },
  })

  assert.equal(selected.candidate.version, "0.8.21")
  assert.equal(invocation.disposition, "dispatch-and-exit")
  assert.equal(invocation.dispatchRef, "v0.8.21")
  assert.equal(invocation.exitBeforePreparation, true)
})

test("arbitration blocks a newer candidate behind older tagged or partial state", () => {
  for (const state of ["CANDIDATE_TAGGED", "NPM_PARTIAL"]) {
    const result = arbitrateCandidate({
      candidate: selectedCandidate("0.8.22", SHA_22, "CANDIDATE_VALIDATED"),
      managedReleases: [selectedCandidate("0.8.21", SHA_21, state)],
      registryLatest: [],
    })

    assert.equal(result.disposition, "blocked")
    assert.deepEqual(result.conflicts, ["older-tagged-candidate-incomplete"])
  }
})

test("arbitration ignores older audited or abandoned managed releases", () => {
  for (const state of ["AUDIT_COMPLETE", "ABANDONED_PREPUBLICATION"]) {
    const candidate = selectedCandidate("0.8.22", SHA_22, "CANDIDATE_VALIDATED")
    const result = arbitrateCandidate({
      candidate,
      managedReleases: [selectedCandidate("0.8.21", SHA_21, state)],
      registryLatest: [],
    })

    assert.deepEqual(result, candidate)
  }
})

test("arbitration never moves latest backward", () => {
  const latest = PACKAGE_NAMES.map((name) => ({ name, version: "0.8.23" }))
  const unstarted = arbitrateCandidate({
    candidate: selectedCandidate("0.8.22", SHA_22, "CANDIDATE_VALIDATED"),
    managedReleases: [],
    registryLatest: latest,
  })
  const partial = arbitrateCandidate({
    candidate: selectedCandidate("0.8.22", SHA_22, "NPM_PARTIAL"),
    managedReleases: [],
    registryLatest: latest,
  })

  assert.equal(unstarted.state, "SUPERSEDED_NOOP")
  assert.equal(unstarted.disposition, "audit-only")
  assert.deepEqual(unstarted.conflicts, [])
  assert.equal(partial.disposition, "blocked")
  assert.deepEqual(partial.conflicts, ["newer-registry-latest"])
})

test("arbitration requires the exact candidate CI and publisher policy identity", () => {
  const selected = selectedCandidate("0.8.22", SHA_22, "CANDIDATE_VALIDATED")
  selected.candidate.ciWorkflow = "Other"

  assert.throws(
    () =>
      arbitrateCandidate({
        candidate: selected,
        managedReleases: [],
        registryLatest: [],
      }),
    /candidate identity/u,
  )
})

test("exact CI / validate success at the candidate SHA gates tagging", async () => {
  const github = ciFixture([
    ciAttempt({ status: "in_progress" }),
    ciAttempt({ status: "completed", conclusion: "success" }),
  ])
  const delays = []

  const result = await waitForRequiredCi({
    sha: SHA_22,
    github,
    attempts: 3,
    delayMs: 25,
    delay: async (milliseconds) => delays.push(milliseconds),
  })

  assert.equal(result.status, "success")
  assert.equal(result.retryable, false)
  assert.equal(result.commitSha, SHA_22)
  assert.equal(result.workflow, "CI")
  assert.equal(result.check, "validate")
  assert.equal(result.runId, 101)
  assert.deepEqual(delays, [25])
})

test("required CI correlates validate to the unique workflow check suite", async () => {
  const attempt = ciAttempt({ status: "completed", conclusion: "success" })
  const github = {
    async getCommitCheckRuns() {
      return present("commit-check-runs", [
        attempt.check,
        { ...attempt.check, check_suite: { id: 99 } },
      ])
    },
    async listWorkflowRuns() {
      return present("workflow-runs", [attempt.workflow])
    },
  }

  const result = await waitForRequiredCi({
    sha: SHA_22,
    github,
    attempts: 1,
    delayMs: 0,
    delay: async () => assert.fail("terminal CI must not poll"),
  })

  assert.equal(result.status, "success")
  assert.equal(result.runId, attempt.workflow.id)
})

test("required CI cannot authorize a pull-request run at the candidate SHA", async () => {
  const result = await waitForRequiredCi({
    sha: SHA_22,
    github: ciFixture([
      ciAttempt({
        status: "completed",
        conclusion: "success",
        workflowBranch: "feature",
        workflowEvent: "pull_request",
      }),
    ]),
    attempts: 1,
    delayMs: 0,
    delay: async () => assert.fail("terminal CI identity conflict must not poll"),
  })

  assert.equal(result.status, "failed")
  assert.equal(result.reason, "required-ci-identity-conflict")
})

test("required CI selects the exact main push when a PR suite shares its SHA", async () => {
  const main = ciAttempt({ status: "completed", conclusion: "success" })
  const pullRequest = ciAttempt({
    status: "completed",
    conclusion: "success",
    workflowBranch: "feature",
    workflowEvent: "pull_request",
    workflowSuiteId: 78,
  })
  pullRequest.workflow.id = 102
  pullRequest.check.check_suite.id = 78
  const github = {
    async getCommitCheckRuns() {
      return present("commit-check-runs", [pullRequest.check, main.check])
    },
    async listWorkflowRuns() {
      return present("workflow-runs", [pullRequest.workflow, main.workflow])
    },
  }

  const result = await waitForRequiredCi({
    sha: SHA_22,
    github,
    attempts: 1,
    delayMs: 0,
    delay: async () => assert.fail("successful CI must not poll"),
  })

  assert.equal(result.status, "success")
  assert.equal(result.runId, main.workflow.id)
})

test("pending CI polls within budget, terminal failure stops, and timeout is retryable", async () => {
  const failedGithub = ciFixture([
    ciAttempt({ status: "completed", conclusion: "failure" }),
    ciAttempt({ status: "completed", conclusion: "success" }),
  ])
  let failureDelays = 0
  const failed = await waitForRequiredCi({
    sha: SHA_22,
    github: failedGithub,
    attempts: 4,
    delayMs: 1,
    delay: async () => (failureDelays += 1),
  })
  assert.equal(failed.status, "failed")
  assert.equal(failed.retryable, false)
  assert.equal(failedGithub.attemptsRead(), 1)
  assert.equal(failureDelays, 0)

  const pendingGithub = ciFixture([
    ciAttempt({ status: "queued" }),
    ciAttempt({ status: "in_progress" }),
    ciAttempt({ status: "in_progress" }),
  ])
  let timeoutDelays = 0
  const timeout = await waitForRequiredCi({
    sha: SHA_22,
    github: pendingGithub,
    attempts: 3,
    delayMs: 1,
    delay: async () => (timeoutDelays += 1),
  })
  assert.deepEqual(timeout, {
    status: "timeout",
    retryable: true,
    commitSha: SHA_22,
    workflow: "CI",
    check: "validate",
  })
  assert.equal(pendingGithub.attemptsRead(), 3)
  assert.equal(timeoutDelays, 2)
})

test("a successful check with any other CI identity cannot gate tagging", async () => {
  for (const overrides of [
    { workflowName: "Other" },
    { workflowPath: ".github/workflows/other.yml" },
    { checkName: "other" },
    { headSha: OTHER_SHA },
    { workflowSuiteId: 88 },
    { workflowBranch: "feature" },
    { workflowEvent: "pull_request" },
  ]) {
    const result = await waitForRequiredCi({
      sha: SHA_22,
      github: ciFixture([ciAttempt({ status: "completed", conclusion: "success", ...overrides })]),
      attempts: 1,
      delayMs: 0,
      delay: async () => assert.fail("terminal identity conflict must not poll"),
    })

    assert.equal(result.status, "failed")
    assert.equal(result.reason, "required-ci-identity-conflict")
  }
})

test("only the exact candidate tag ref and SHA continue after tag validation", () => {
  const result = decideInvocation({
    candidateVersion: "0.8.22",
    candidateSha: SHA_22,
    githubSha: SHA_22,
    githubRef: "refs/tags/v0.8.22",
    tagState: { status: "present", tag: "v0.8.22", commitSha: SHA_22 },
  })

  assert.deepEqual(result, {
    disposition: "continue",
    tagAction: "validate",
    dispatchRef: null,
    exitBeforePreparation: false,
    conflicts: [],
  })
})

test("a branch coordinator at the candidate SHA still tags, dispatches, and exits", () => {
  for (const tagState of [
    { status: "absent", tag: "v0.8.22", commitSha: null },
    { status: "present", tag: "v0.8.22", commitSha: SHA_22 },
  ]) {
    const result = decideInvocation({
      candidateVersion: "0.8.22",
      candidateSha: SHA_22,
      githubSha: SHA_22,
      githubRef: "refs/heads/main",
      tagState,
    })

    assert.deepEqual(result, {
      disposition: "dispatch-and-exit",
      tagAction: tagState.status === "absent" ? "create" : "validate",
      dispatchRef: "v0.8.22",
      exitBeforePreparation: true,
      conflicts: [],
    })
  }
})

test("a coordinator at another SHA tags then dispatches the immutable ref and exits", () => {
  const result = decideInvocation({
    candidateVersion: "0.8.22",
    candidateSha: SHA_22,
    githubSha: SHA_23,
    githubRef: "refs/heads/main",
    tagState: { status: "absent", tag: "v0.8.22", commitSha: null },
  })

  assert.deepEqual(result, {
    disposition: "dispatch-and-exit",
    tagAction: "create",
    dispatchRef: "v0.8.22",
    exitBeforePreparation: true,
    conflicts: [],
  })
})

test("an existing candidate tag at another commit is a conflict", () => {
  const result = decideInvocation({
    candidateVersion: "0.8.22",
    candidateSha: SHA_22,
    githubSha: SHA_23,
    githubRef: "refs/heads/main",
    tagState: { status: "present", tag: "v0.8.22", commitSha: OTHER_SHA },
  })

  assert.equal(result.disposition, "blocked")
  assert.equal(result.tagAction, null)
  assert.equal(result.exitBeforePreparation, true)
  assert.deepEqual(result.conflicts, ["candidate-tag-commit-mismatch"])
})

test("invocation decisions bind the candidate tag to the exact candidate version", () => {
  assert.throws(
    () =>
      decideInvocation({
        candidateVersion: "0.8.22",
        candidateSha: SHA_22,
        githubSha: SHA_22,
        githubRef: "refs/tags/v0.8.22",
        tagState: { status: "present", tag: "v0.8.23", commitSha: SHA_22 },
      }),
    /candidate version/u,
  )
})

test("an exact candidate tag invocation with a mismatched SHA or missing tag blocks", () => {
  const wrongSha = decideInvocation({
    candidateVersion: "0.8.22",
    candidateSha: SHA_22,
    githubSha: SHA_23,
    githubRef: "refs/tags/v0.8.22",
    tagState: { status: "present", tag: "v0.8.22", commitSha: SHA_22 },
  })
  assert.equal(wrongSha.disposition, "blocked")
  assert.deepEqual(wrongSha.conflicts, ["candidate-invocation-ref-sha-mismatch"])

  const missingTag = decideInvocation({
    candidateVersion: "0.8.22",
    candidateSha: SHA_22,
    githubSha: SHA_22,
    githubRef: "refs/tags/v0.8.22",
    tagState: { status: "absent", tag: "v0.8.22", commitSha: null },
  })
  assert.equal(missingTag.disposition, "blocked")
  assert.deepEqual(missingTag.conflicts, ["candidate-tag-missing-at-invocation-ref"])
})

function repositoryFixture(commits, { ancestry = true, ancestryError = null } = {}) {
  const bySha = new Map(commits.map((entry) => [entry.sha, entry]))
  const history = commits.map((entry) => entry.sha).reverse()
  const head = commits.at(-1)?.sha
  const calls = []
  const resolveRef = (ref) => (ref === "main" || ref === "origin/main" ? head : ref)
  return {
    calls,
    inventory: {
      async read({ ref }) {
        calls.push(["inventory", ref])
        const entry = bySha.get(ref)
        if (entry === undefined) throw new Error(`unknown fixture inventory ${ref}`)
        return releaseInventory(entry.version)
      },
    },
    git: {
      async listFirstParentHistory({ ref, maxCount }) {
        calls.push(["history", ref, maxCount])
        if (maxCount === 1) return [resolveRef(ref)]
        return history.slice(0, maxCount)
      },
      async firstParent(ref) {
        calls.push(["firstParent", ref])
        const parent = bySha.get(ref)?.parent
        if (parent === null || parent === undefined) throw new Error("fixture commit has no parent")
        return parent
      },
      async isAncestor({ ancestor, descendant }) {
        calls.push(["isAncestor", ancestor, descendant])
        if (ancestryError !== null) throw ancestryError
        return ancestry
      },
      async listTree({ ref }) {
        calls.push(["listTree", ref])
        const entry = bySha.get(ref)
        return [...(entry.marker ? [MARKER_PATH] : []), ...entry.tree].join("\n")
      },
      async showFile({ ref, path }) {
        calls.push(["showFile", ref, path])
        const entry = bySha.get(ref)
        if (path !== MARKER_PATH || !entry?.marker) throw new Error("fixture file missing")
        return JSON.stringify(ACTIVE_MARKER)
      },
      async resolveTag({ tag }) {
        calls.push(["resolveTag", tag])
        const version = tag.slice(1)
        const entry = commits.find((item) => item.version === version && item.parent !== null)
        if (entry === undefined) throw new Error(`unknown fixture tag ${tag}`)
        return entry.sha
      },
    },
  }
}

function commit(sha, version, { parent = null, marker = false, tree = [] } = {}) {
  return { sha, version, parent, marker, tree }
}

function releaseInventory(version) {
  return {
    status: "valid",
    packages: PACKAGE_NAMES.map((name) => ({ name, version })),
  }
}

function candidateIdentity(version, commitSha) {
  return {
    version,
    commitSha,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
}

function selectedCandidate(version, commitSha, state) {
  return {
    candidate: candidateIdentity(version, commitSha),
    state,
    disposition:
      state === "NO_CANDIDATE" ? "noop" : state === "SUPERSEDED_NOOP" ? "audit-only" : "selected",
    tag: state === "CANDIDATE_VALIDATED" ? null : `v${version}`,
    conflicts: [],
  }
}

function tagRef(version, commitSha) {
  return {
    ref: `refs/tags/v${version}`,
    object: { type: "tag", sha: tagObjectSha(version) },
    peeledCommitSha: commitSha,
  }
}

function tagObjectSha(version) {
  return createHash("sha1").update(`annotated tag v${version}\n`).digest("hex")
}

function managedRelease(
  id,
  version,
  commitSha,
  {
    auditComplete = false,
    abandoned = false,
    published = false,
    releaseRecord: includeReleaseRecordOption,
  } = {},
) {
  const includeReleaseRecord = includeReleaseRecordOption ?? !abandoned
  const recordId = id * 10 + 1
  const assets = includeReleaseRecord ? [releaseRecordAsset(recordId)] : []
  if (auditComplete) assets.push({ id: id * 10 + 2, name: "audit-result.json" })
  if (abandoned) assets.push({ id: id * 10 + 3, name: "abandonment.json" })
  const abandonment = abandoned ? abandonmentRecord(version, commitSha) : null
  const abandonmentBytes = abandonment === null ? null : canonicalAbandonmentBytes(abandonment)
  const abandonmentMarker =
    abandonmentBytes === null
      ? null
      : abandonmentReleaseMarker({
          candidate: { version, commitSha },
          artifact: {
            manifestSha256: null,
            releaseRecordSha256: null,
            baseAssetSetSha256: null,
            attestationSet: null,
          },
          abandonmentSha256: sha256(abandonmentBytes),
        })
  return {
    id,
    version,
    tag_name: `v${version}`,
    name: `Dawn v${version}`,
    target_commitish: "main",
    draft: !published,
    immutable: published,
    prerelease: false,
    ...(abandonmentMarker === null
      ? {}
      : {
          name: `Dawn v${version} (abandoned before publication)`,
          body: canonicalAbandonmentReleaseBody({
            marker: abandonmentMarker,
            tombstone: abandonment,
          }),
        }),
    assets,
    record: releaseRecord(version, commitSha),
    ...(auditComplete
      ? {
          auditResult: {
            schemaVersion: 1,
            version,
            commitSha,
            manifestSha256: "b".repeat(64),
            workflowRunId: 300,
            runAttempt: 1,
            startedAt: "2026-08-24T12:00:00Z",
            finishedAt: "2026-08-24T12:05:00Z",
            checks: [
              {
                name: "public-release",
                conclusion: "success",
                detail: "Public release identity and package evidence verified",
              },
            ],
            conclusion: "success",
          },
        }
      : {}),
    ...(abandonment === null ? {} : { abandonment, abandonmentBytes }),
  }
}

function interruptedAbandonmentRelease(id, version, commitSha) {
  const release = managedRelease(id, version, commitSha, {
    abandoned: true,
    releaseRecord: false,
  })
  const recordBytes = Buffer.from(JSON.stringify(release.record))
  const marker = {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 1,
    phase: "ATTACHING",
    version,
    commitSha,
    tag: `v${version}`,
    manifestSha256: "b".repeat(64),
    releaseRecordSha256: sha256(recordBytes),
    baseAssetSetSha256: null,
    attestationSet: null,
    npmEvidenceSha256: null,
    smokeAggregateSha256: null,
    audit: null,
    abandonmentSha256: null,
  }
  release.name = `Dawn v${version}`
  release.body = canonicalReleaseBody({ marker, manifest: null })
  return release
}

function terminalAttestedAbandonmentRelease(id, version, commitSha) {
  const release = managedRelease(id, version, commitSha, {
    abandoned: true,
    releaseRecord: false,
  })
  const bytesByName = new Map()
  const recordBytes = Buffer.from(JSON.stringify(release.record))
  bytesByName.set("release-record.json", recordBytes)
  const anchoredBundleBytes = Buffer.from("fixture bytes for the anchored attestation bundle\n")
  const subjects = [
    "manifest.json",
    ...Array.from({ length: 21 }, (_, index) => `package-${String(index).padStart(2, "0")}.tgz`),
  ].map((subjectName) => {
    const subjectBytes = Buffer.from(`fixture bytes for ${subjectName}\n`)
    const bundleName = `${subjectName}.intoto.jsonl`
    const bundleBytes = anchoredBundleBytes
    bytesByName.set(subjectName, subjectBytes)
    bytesByName.set(bundleName, bundleBytes)
    return {
      subjectName,
      subjectSha256: sha256(subjectBytes),
      bundleName,
      bundleSha256: sha256(bundleBytes),
    }
  })
  const attestationSet = {
    repository: "cacheplane/dawnai",
    workflow: ".github/workflows/release.yml",
    sourceRef: `refs/tags/v${version}`,
    commitSha,
    workflowRunId: 400,
    runAttempt: 1,
    subjects,
  }
  const baseAssets = [
    { name: "release-record.json", sha256: sha256(recordBytes) },
    { name: "manifest.json", sha256: subjects[0].subjectSha256 },
    ...subjects.slice(1).map((subject) => ({
      name: subject.subjectName,
      sha256: subject.subjectSha256,
    })),
    ...subjects.map((subject) => ({
      name: subject.bundleName,
      sha256: subject.bundleSha256,
    })),
  ]
  const previousMarker = {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 2,
    phase: "ESCROWED",
    version,
    commitSha,
    tag: `v${version}`,
    manifestSha256: subjects[0].subjectSha256,
    releaseRecordSha256: sha256(recordBytes),
    baseAssetSetSha256: sha256(Buffer.from(`${JSON.stringify(baseAssets)}\n`)),
    attestationSet,
    npmEvidenceSha256: null,
    smoke: null,
    audit: null,
    abandonmentSha256: null,
  }
  const previousBody = canonicalReleaseBody({ marker: previousMarker, manifest: null })
  release.abandonment = {
    ...release.abandonment,
    predecessor: {
      state: "CANDIDATE_ESCROWED",
      releaseStatus: "draft",
      releaseId: id,
      bodySha256: sha256(Buffer.from(previousBody, "utf8")),
      marker: previousMarker,
      artifact: {
        manifestSha256: previousMarker.manifestSha256,
        releaseRecordSha256: previousMarker.releaseRecordSha256,
        baseAssetSetSha256: previousMarker.baseAssetSetSha256,
        attestationSet: previousMarker.attestationSet,
      },
    },
  }
  release.abandonmentBytes = canonicalAbandonmentBytes(release.abandonment)
  const marker = abandonmentReleaseMarker({
    candidate: { version, commitSha },
    artifact: {
      manifestSha256: previousMarker.manifestSha256,
      releaseRecordSha256: previousMarker.releaseRecordSha256,
      baseAssetSetSha256: previousMarker.baseAssetSetSha256,
      attestationSet: previousMarker.attestationSet,
    },
    abandonmentSha256: sha256(release.abandonmentBytes),
    previousMarker,
  })
  release.assets = [
    ...baseAssets.map((asset, index) => ({ id: id * 1_000 + index + 1, name: asset.name })),
    { id: id * 1_000 + 100, name: "abandonment.json" },
  ]
  release.assetBytes = new Map([
    ...release.assets
      .filter((asset) => asset.name !== "abandonment.json")
      .map((asset) => [asset.id, bytesByName.get(asset.name)]),
    [id * 1_000 + 100, release.abandonmentBytes],
  ])
  release.name = `Dawn v${version} (abandoned before publication)`
  release.body = canonicalAbandonmentReleaseBody({
    marker,
    tombstone: release.abandonment,
    previousMarker,
  })
  return release
}

function abandonmentRecord(version, commitSha) {
  const observation = (workflowRunId, observedAt) => ({
    workflowRunId,
    runAttempt: 1,
    observedAt,
    packages: PACKAGE_NAMES.map((name) => ({
      name,
      version,
      status: "ABSENT",
      httpStatus: 404,
      code: "E404",
    })),
  })
  return {
    schemaVersion: 1,
    version,
    commitSha,
    tag: `v${version}`,
    predecessor: {
      state: "CANDIDATE_TAGGED",
      releaseStatus: "absent",
      releaseId: null,
      bodySha256: null,
      marker: null,
      artifact: {
        manifestSha256: null,
        releaseRecordSha256: null,
        baseAssetSetSha256: null,
        attestationSet: null,
      },
    },
    reason: "Candidate preparation is deterministically defective",
    actor: "release-operator",
    actorId: 200,
    recordedAt: "2026-08-24T12:04:00Z",
    approval: {
      environment: "release-abandonment",
      environmentId: 200,
      reviewerId: 201,
      reviewer: "release-reviewer",
      state: "approved",
      observedAt: "2026-08-24T11:59:00Z",
      workflowRunId: 300,
      runAttempt: 1,
    },
    actionsHistory: {
      workflowRunId: 300,
      runAttempt: 1,
      observedAt: "2026-08-24T12:03:30Z",
      publishJobStarted: false,
      registryMutationStarted: false,
    },
    observations: [
      observation(300, "2026-08-24T12:01:00Z"),
      observation(300, "2026-08-24T12:03:00Z"),
    ],
  }
}

function unmanagedRelease(id) {
  return { id, tag_name: "@dawn-ai/core@0.8.21", draft: false, assets: [] }
}

function releaseRecordAsset(id) {
  return { id, name: "release-record.json" }
}

function releaseRecord(version, commitSha) {
  return {
    schemaVersion: 1,
    version,
    commitSha,
    tag: `v${version}`,
    manifestSha256: "b".repeat(64),
    actionsArtifact: {
      id: 100,
      name: `release-v${version}-${commitSha.slice(0, 12)}`,
      serviceDigest: `sha256:${"c".repeat(64)}`,
      prepareRunId: 200,
      prepareRunAttempt: 1,
    },
  }
}

function githubFixture({ tags = [], releases = [] } = {}) {
  const calls = []
  const releasesById = new Map(releases.map((release) => [release.id, release]))
  const assetBytes = new Map()
  for (const release of releases) {
    if (release.assetBytes instanceof Map) {
      for (const [assetId, bytes] of release.assetBytes) assetBytes.set(assetId, bytes)
    }
    const recordAsset = release.assets.find((asset) => asset.name === "release-record.json")
    if (recordAsset !== undefined) assetBytes.set(recordAsset.id, release.record)
    const auditAsset = release.assets.find((asset) => asset.name === "audit-result.json")
    if (auditAsset !== undefined) assetBytes.set(auditAsset.id, release.auditResult)
    const abandonmentAsset = release.assets.find((asset) => asset.name === "abandonment.json")
    if (abandonmentAsset !== undefined) {
      assetBytes.set(abandonmentAsset.id, release.abandonmentBytes ?? release.abandonment)
    }
  }
  return {
    calls,
    async listTagRefs() {
      calls.push(["listTagRefs"])
      return present(
        "tag-refs",
        tags.map(({ peeledCommitSha, ...tag }) => tag),
      )
    },
    async getRef({ ref }) {
      calls.push(["getRef", ref])
      const tag = tags.find((item) => item.ref === `refs/${ref}`)
      if (tag === undefined) throw new Error(`unknown fixture ref ${ref}`)
      return present("ref", { ref: tag.ref, object: tag.object })
    },
    async getGitTag({ tagSha }) {
      calls.push(["getGitTag", tagSha])
      const tag = tags.find((item) => item.object.sha === tagSha)
      if (tag === undefined) throw new Error(`unknown fixture annotated tag ${tagSha}`)
      return present("git-tag", {
        tag: tag.ref.slice("refs/tags/".length),
        object: { type: "commit", sha: tag.peeledCommitSha },
      })
    },
    async listReleases() {
      calls.push(["listReleases"])
      return present(
        "releases",
        releases.map(
          ({
            record,
            auditResult,
            abandonment,
            abandonmentBytes,
            assets,
            assetBytes,
            ...release
          }) => release,
        ),
      )
    },
    async getReleaseByTag({ tag }) {
      calls.push(["getReleaseByTag", tag])
      const release = releases.find((item) => item.tag_name === tag)
      if (release === undefined) throw new Error(`unknown fixture Release ${tag}`)
      const { record, auditResult, abandonment, abandonmentBytes, assets, assetBytes, ...value } =
        release
      return present("release", value)
    },
    async listReleaseAssets({ releaseId }) {
      calls.push(["listReleaseAssets", releaseId])
      return present("release-assets", releasesById.get(releaseId)?.assets ?? [])
    },
    async downloadReleaseAsset({ assetId }) {
      calls.push(["downloadReleaseAsset", assetId])
      const value = assetBytes.get(assetId)
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
      return {
        status: "PRESENT",
        operation: "release-asset-download",
        httpStatus: 200,
        code: null,
        contentBase64: bytes.toString("base64"),
      }
    },
  }
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function ciAttempt({
  status,
  conclusion = null,
  workflowName = "CI",
  workflowPath = ".github/workflows/ci.yml",
  workflowBranch = "main",
  workflowEvent = "push",
  checkName = "validate",
  headSha = SHA_22,
  workflowSuiteId = 77,
} = {}) {
  return {
    workflow: {
      id: 101,
      run_attempt: 2,
      name: workflowName,
      path: workflowPath,
      head_sha: headSha,
      head_branch: workflowBranch,
      event: workflowEvent,
      check_suite_id: workflowSuiteId,
      status,
      conclusion,
    },
    check: {
      name: checkName,
      head_sha: headSha,
      check_suite: { id: 77 },
      status,
      conclusion,
    },
  }
}

function ciFixture(attempts) {
  let index = 0
  return {
    attemptsRead: () => index,
    async getCommitCheckRuns({ commitSha }) {
      assert.equal(commitSha, SHA_22)
      return present("commit-check-runs", [attempts[Math.min(index, attempts.length - 1)].check])
    },
    async listWorkflowRuns({ workflow, commitSha }) {
      assert.equal(workflow, "ci.yml")
      assert.equal(commitSha, SHA_22)
      const attempt = attempts[Math.min(index, attempts.length - 1)]
      index += 1
      return present("workflow-runs", [attempt.workflow])
    },
  }
}
