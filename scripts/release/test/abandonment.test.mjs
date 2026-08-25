import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  canonicalAbandonmentBytes,
  canonicalAbandonmentReleaseBody,
  evaluateAbandonment,
  recordAbandonment,
} from "../abandonment.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import {
  abandonmentReleaseMarker,
  canonicalReleaseBody,
  parseReleaseMarker,
  releaseBodySha256,
} from "../metadata.mjs"

const VERSION = "0.8.22"
const SHA = "a".repeat(40)
const PACKAGE_NAMES = [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(compareText)
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})

test("evaluates complete protected evidence into one canonical terminal record", async () => {
  const result = await evaluateAbandonment(validInput())

  assert.equal(result.version, VERSION)
  assert.equal(result.tag, `v${VERSION}`)
  assert.equal(result.actor, "release-operator")
  assert.equal(result.approval.environment, "release-abandonment")
  assert.equal(result.observations.length, 2)
  assert.ok(Object.isFrozen(result))
  assert.deepEqual(JSON.parse(canonicalAbandonmentBytes(result)), result)
})

test("canonical abandonment Release bodies reject accessors without invoking them", async () => {
  const input = validInput()
  const tombstone = await evaluateAbandonment(input)
  const marker = abandonmentReleaseMarker({
    candidate: input.candidate,
    artifact: input.artifactContext.artifact,
    abandonmentSha256: sha256(canonicalAbandonmentBytes(tombstone)),
  })
  let calls = 0
  const bodyInput = {
    get marker() {
      calls += 1
      return marker
    },
    tombstone,
  }

  assert.throws(() => canonicalAbandonmentReleaseBody(bodyInput), /field|JSON|accessor|input/iu)
  assert.equal(calls, 0)
})

test("rejects malformed identity, authorization, history, registry, tag, and interleaving evidence", async () => {
  const cases = [
    ["version", (input) => (input.candidate.version = "v0.8.22")],
    ["commit SHA", (input) => (input.candidate.commitSha = "b".repeat(39))],
    ["reason", (input) => (input.reason = "")],
    ["environment", (input) => (input.approval.environment = "unprotected")],
    ["actor", (input) => (input.approval.actor = "")],
    ["publish job", (input) => (input.actionsHistory.publishJobStarted = true)],
    ["registry mutation", (input) => (input.actionsHistory.registryMutationStarted = true)],
    ["visible package", (input) => (input.observations[1].packages[3].status = "PRESENT")],
    ["ambiguous package", (input) => (input.observations[1].packages[3].status = "ERROR")],
    ["single observation", (input) => input.observations.pop()],
    ["same run", (input) => (input.observations[1].workflowRunId = 301)],
    ["reused history run", (input) => (input.actionsHistory.workflowRunId = 301)],
    ["wrong tag", (input) => (input.artifactContext.tag.tag = "v0.8.23")],
    ["lightweight tag", (input) => (input.artifactContext.tag.annotated = false)],
    ["newer release", (input) => (input.artifactContext.newerReleaseInterleaved = true)],
    ["extra context field", (input) => (input.artifactContext.extra = true)],
  ]

  for (const [name, mutate] of cases) {
    const input = validInput()
    mutate(input)
    await assert.rejects(evaluateAbandonment(input), undefined, name)
  }
})

test("binds both exact-E404 proofs to the canonical fixed-group inventory", async () => {
  for (const observationIndex of [0, 1]) {
    const input = validInput()
    input.observations[observationIndex].packages = Array.from({ length: 21 }, (_, index) => ({
      name: `fake-package-${String(index).padStart(2, "0")}`,
      version: VERSION,
      status: "ABSENT",
      httpStatus: 404,
      code: "E404",
    }))

    await assert.rejects(evaluateAbandonment(input), /package inventory|observation/iu)
  }
})

test("freshly reauthorizes Actions, registry, and protected approval evidence before mutation", async () => {
  const input = validInput()
  const remote = fakeGitHub()
  const fresh = freshAuthorization(input)
  fresh.evidence.observations[1].packages[0].status = "PRESENT"
  fresh.evidence.observations[1].packages[0].httpStatus = 200
  fresh.evidence.observations[1].packages[0].code = null

  await assert.rejects(
    recordAbandonment({
      candidate: input.candidate,
      reason: input.reason,
      artifactContext: input.artifactContext,
      authorization: fresh.authorization,
      github: remote.github,
    }),
    /authorization|observation|package/iu,
  )
  assert.equal(fresh.calls(), 1)
  assert.deepEqual(remote.mutations, [])
})

test("rejects stale fresh authorization before the first Release mutation", async () => {
  const input = validInput()
  const remote = fakeGitHub()
  const fresh = freshAuthorization(input, { ageMinutes: 30 })

  await assert.rejects(
    recordAbandonment({
      candidate: input.candidate,
      reason: input.reason,
      artifactContext: input.artifactContext,
      authorization: fresh.authorization,
      github: remote.github,
    }),
    /fresh|stale|authorization/iu,
  )
  assert.equal(fresh.calls(), 1)
  assert.deepEqual(remote.mutations, [])
})

test("records the final fresh authorization as the durable abandonment tombstone", async () => {
  const input = validInput()
  const remote = fakeGitHub()
  const fresh = freshAuthorization(input)

  await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: input.artifactContext,
    authorization: fresh.authorization,
    github: remote.github,
  })

  const persisted = JSON.parse(
    remote.assets.find((asset) => asset.name === "abandonment.json").bytes,
  )
  assert.deepEqual(persisted.actionsHistory, fresh.evidence.actionsHistory)
  assert.deepEqual(persisted.observations, fresh.evidence.observations)
  assert.deepEqual(persisted.approval, {
    environment: fresh.evidence.approval.environment,
    environmentId: fresh.evidence.approval.environmentId,
    reviewerId: fresh.evidence.approval.reviewerId,
    reviewer: fresh.evidence.approval.reviewer,
    state: fresh.evidence.approval.state,
    observedAt: fresh.evidence.approval.observedAt,
    workflowRunId: fresh.evidence.approval.workflowRunId,
    runAttempt: fresh.evidence.approval.runAttempt,
  })
  assert.equal(persisted.actor, fresh.evidence.approval.actor)
  assert.equal(persisted.recordedAt, fresh.evidence.approval.recordedAt)
})

test("resumes marker-first abandonment after a real process restart without caller tombstone bytes", async () => {
  const input = validInput()
  const remote = fakeGitHub({ failAfter: "create" })

  await assert.rejects(
    recordAbandonment({
      candidate: input.candidate,
      reason: input.reason,
      artifactContext: input.artifactContext,
      authorization: freshAuthorization(input).authorization,
      github: remote.github,
    }),
    /simulated runner loss/iu,
  )
  assert.equal(parseReleaseMarker(remote.release.body).phase, "ABANDONED_PREPUBLICATION")
  assert.deepEqual(remote.assets, [])

  const restartedContext = contextFromRemote(input.artifactContext, remote)
  const restarted = fakeGitHub({ context: restartedContext, source: remote })
  const secondAuthorization = freshAuthorization(input)
  secondAuthorization.evidence.actionsHistory.workflowRunId = 910
  secondAuthorization.evidence.observations[0].workflowRunId = 910
  secondAuthorization.evidence.observations[1].workflowRunId = 910
  secondAuthorization.evidence.approval.workflowRunId = 910

  const result = await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: restartedContext,
    authorization: secondAuthorization.authorization,
    github: restarted.github,
  })

  assert.equal(result.created, false)
  assert.deepEqual(restarted.mutations, ["upload"])
  assert.equal(restarted.assets[0].name, "abandonment.json")
})

test("resumes asset-first abandonment after a real process restart without caller tombstone bytes", async () => {
  const input = validInput({ predecessor: "ARTIFACTS_ATTESTED", escrowCount: 4 })
  const originalAuthorization = freshAuthorization(input)
  const durableInput = structuredClone(input)
  durableInput.actionsHistory = structuredClone(originalAuthorization.evidence.actionsHistory)
  durableInput.observations = structuredClone(originalAuthorization.evidence.observations)
  durableInput.approval = structuredClone(originalAuthorization.evidence.approval)
  const durableTombstone = await evaluateAbandonment(durableInput)
  const durableBytes = canonicalAbandonmentBytes(durableTombstone)
  const remote = fakeGitHub({ context: input.artifactContext })
  remote.assets.push({
    id: 90,
    name: "abandonment.json",
    bytes: Buffer.from(durableBytes),
  })
  const restartedContext = contextFromRemote(input.artifactContext, remote)
  const restarted = fakeGitHub({ context: restartedContext, source: remote })
  const secondAuthorization = freshAuthorization(input)
  secondAuthorization.evidence.actionsHistory.workflowRunId = 920
  secondAuthorization.evidence.observations[0].workflowRunId = 920
  secondAuthorization.evidence.observations[1].workflowRunId = 920
  secondAuthorization.evidence.approval.workflowRunId = 920

  const result = await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: restartedContext,
    authorization: secondAuthorization.authorization,
    github: restarted.github,
  })

  assert.equal(result.created, false)
  assert.deepEqual(restarted.mutations, ["update"])
  assert.equal(parseReleaseMarker(restarted.release.body).phase, "ABANDONED_PREPUBLICATION")
  assert.deepEqual(
    restarted.assets.find((asset) => asset.name === "abandonment.json").bytes,
    durableBytes,
  )
})

test("reobserves newer Releases after fresh authorization and immediately before mutation", async () => {
  const input = validInput()
  const remote = fakeGitHub()
  const fresh = freshAuthorization(input)
  const authorization = {
    async readFreshAbandonmentEvidence(args) {
      const evidence = await fresh.authorization.readFreshAbandonmentEvidence(args)
      remote.releases.push({ id: 99, tag_name: "v0.8.23" })
      return evidence
    },
  }

  await assert.rejects(
    recordAbandonment({
      candidate: input.candidate,
      reason: input.reason,
      artifactContext: input.artifactContext,
      authorization,
      github: remote.github,
    }),
    /newer.*Release|interleaved/iu,
  )
  assert.deepEqual(remote.mutations, [])
})

test("a create-existing race is not reported as creation and is reauthorized before upload", async () => {
  const input = validInput()
  const remote = fakeGitHub({ createStatus: "existing" })
  const fresh = freshAuthorization(input)

  const result = await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: input.artifactContext,
    authorization: fresh.authorization,
    github: remote.github,
  })

  assert.equal(result.created, false)
  assert.equal(fresh.calls(), 2)
  assert.deepEqual(remote.mutations, ["upload"])
})

test("accepts only the four legal predecessor artifact shapes", async () => {
  for (const predecessor of [
    "CANDIDATE_TAGGED",
    "ARTIFACTS_PREPARED",
    "ARTIFACTS_ATTESTED",
    "CANDIDATE_ESCROWED",
  ]) {
    const input = validInput({ predecessor })
    const result = await evaluateAbandonment(input)
    assert.equal(result.version, VERSION)
  }

  const impossible = validInput({ predecessor: "ARTIFACTS_PREPARED" })
  impossible.artifactContext.artifact.baseAssetSetSha256 = "4".repeat(64)
  await assert.rejects(evaluateAbandonment(impossible), /artifact context|predecessor/iu)

  const weak = validInput({ predecessor: "CANDIDATE_ESCROWED" })
  weak.artifactContext.release.assets.pop()
  await assert.rejects(evaluateAbandonment(weak), /artifact context|asset|escrow/iu)
})

test("records tagged-only abandonment without requiring a release record", async () => {
  const input = validInput()
  const remote = fakeGitHub()

  const result = await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: input.artifactContext,
    authorization: freshAuthorization(input).authorization,
    github: remote.github,
  })

  assert.equal(result.phase, "ABANDONED_PREPUBLICATION")
  assert.equal(result.status, "recorded")
  assert.equal(remote.release.draft, true)
  assert.equal(remote.release.immutable, false)
  assert.match(remote.release.name, /abandoned before publication/u)
  assert.equal(parseReleaseMarker(remote.release.body).phase, "ABANDONED_PREPUBLICATION")
  assert.deepEqual(
    remote.assets.map(({ name }) => name),
    ["abandonment.json"],
  )
  assert.deepEqual(remote.mutations, ["create", "upload"])
})

test("records prepared and attested no-draft predecessors without inventing escrow assets", async () => {
  for (const predecessor of ["ARTIFACTS_PREPARED", "ARTIFACTS_ATTESTED"]) {
    const input = validInput({ predecessor })
    const remote = fakeGitHub({ context: input.artifactContext })

    await recordAbandonment({
      candidate: input.candidate,
      reason: input.reason,
      artifactContext: input.artifactContext,
      authorization: freshAuthorization(input).authorization,
      github: remote.github,
    })

    const marker = parseReleaseMarker(remote.release.body)
    assert.deepEqual(markerArtifact(marker), input.artifactContext.artifact)
    assert.deepEqual(
      remote.assets.map((asset) => asset.name),
      ["abandonment.json"],
    )
  }
})

test("records fully escrowed abandonment without weakening or replacing any base evidence", async () => {
  const input = validInput({ predecessor: "CANDIDATE_ESCROWED" })
  const remote = fakeGitHub({ context: input.artifactContext })
  const retained = remote.assets.map(({ name, bytes }) => ({ name, bytes: Buffer.from(bytes) }))

  await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: input.artifactContext,
    authorization: freshAuthorization(input).authorization,
    github: remote.github,
  })

  assert.equal(retained.length, 45)
  assert.deepEqual(
    remote.assets.slice(0, retained.length).map(({ name, bytes }) => ({ name, bytes })),
    retained,
  )
  assert.equal(remote.assets.at(-1).name, "abandonment.json")
})

test("preserves a matching interrupted escrow subset and advances its marker once", async () => {
  const input = validInput({ predecessor: "ARTIFACTS_ATTESTED", escrowCount: 7 })
  const remote = fakeGitHub({ context: input.artifactContext })
  const retained = remote.assets.map(({ name, bytes }) => ({ name, bytes: Buffer.from(bytes) }))
  const fresh = freshAuthorization(input)

  const result = await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: input.artifactContext,
    authorization: fresh.authorization,
    github: remote.github,
  })

  assert.equal(result.status, "recorded")
  assert.equal(parseReleaseMarker(remote.release.body).revision, 2)
  assert.deepEqual(
    remote.assets.slice(0, retained.length).map(({ name, bytes }) => ({ name, bytes })),
    retained,
  )
  assert.equal(remote.assets.at(-1).name, "abandonment.json")
  assert.equal(fresh.calls(), 1)
  assert.deepEqual(remote.mutations, ["update", "upload"])
  const persisted = JSON.parse(remote.assets.at(-1).bytes)
  assert.deepEqual(persisted.observations, fresh.evidence.observations)
})

test("an exact existing tombstone is idempotent and differing evidence cannot reactivate it", async () => {
  const input = validInput({ predecessor: "ARTIFACTS_ATTESTED", escrowCount: 3 })
  const first = fakeGitHub({ context: input.artifactContext })
  await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: input.artifactContext,
    authorization: freshAuthorization(input).authorization,
    github: first.github,
  })
  const terminalContext = contextFromRemote(input.artifactContext, first)
  const resumed = fakeGitHub({ context: terminalContext, source: first })

  const result = await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: terminalContext,
    authorization: freshAuthorization(input).authorization,
    github: resumed.github,
  })
  assert.equal(result.status, "unchanged")
  assert.deepEqual(resumed.mutations, [])

  await assert.rejects(
    recordAbandonment({
      candidate: input.candidate,
      reason: "A different reason",
      artifactContext: terminalContext,
      authorization: freshAuthorization(input).authorization,
      github: resumed.github,
    }),
    /abandonment|terminal|evidence/iu,
  )
})

test("an exact terminal abandonment is a no-op without requesting new authorization", async () => {
  const input = validInput({ predecessor: "ARTIFACTS_ATTESTED", escrowCount: 3 })
  const first = fakeGitHub({ context: input.artifactContext })
  await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: input.artifactContext,
    authorization: freshAuthorization(input).authorization,
    github: first.github,
  })
  const terminalContext = contextFromRemote(input.artifactContext, first)
  const resumed = fakeGitHub({ context: terminalContext, source: first })

  const result = await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: terminalContext,
    authorization: {
      async readFreshAbandonmentEvidence() {
        assert.fail("an exact terminal no-op must not request fresh authorization")
      },
    },
    github: resumed.github,
  })

  assert.equal(result.status, "unchanged")
  assert.deepEqual(resumed.mutations, [])
})

test("resumes both safe runner-loss boundaries without replacing retained evidence", async () => {
  const input = validInput({ predecessor: "ARTIFACTS_ATTESTED", escrowCount: 4 })
  const tombstone = await evaluateAbandonment(input)
  const tombstoneBytes = canonicalAbandonmentBytes(tombstone)

  const afterUpload = fakeGitHub({ context: input.artifactContext })
  afterUpload.assets.push({
    id: 90,
    name: "abandonment.json",
    bytes: Buffer.from(tombstoneBytes),
  })
  input.artifactContext.release.assets.push({
    id: 90,
    name: "abandonment.json",
    sha256: sha256(tombstoneBytes),
  })
  const uploadedResult = await recordAbandonment({
    candidate: input.candidate,
    reason: input.reason,
    artifactContext: input.artifactContext,
    authorization: freshAuthorization(input).authorization,
    github: afterUpload.github,
  })
  assert.equal(uploadedResult.status, "recorded")
  assert.deepEqual(afterUpload.mutations, ["update"])

  const afterMarker = fakeGitHub()
  const terminalMarker = {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 1,
    phase: "ABANDONED_PREPUBLICATION",
    version: VERSION,
    commitSha: SHA,
    tag: `v${VERSION}`,
    manifestSha256: null,
    releaseRecordSha256: null,
    baseAssetSetSha256: null,
    attestationSet: null,
    npmEvidenceSha256: null,
    smokeAggregateSha256: null,
    audit: null,
    abandonmentSha256: sha256(tombstoneBytes),
  }
  const terminalBody = canonicalAbandonmentReleaseBody({
    marker: terminalMarker,
    tombstone,
  })
  afterMarker.release = {
    id: 10,
    tag_name: `v${VERSION}`,
    name: `Dawn v${VERSION} (abandoned before publication)`,
    body: terminalBody,
    draft: true,
    immutable: false,
  }
  afterMarker.releases.push({ id: 10, tag_name: `v${VERSION}` })
  const terminalContext = structuredClone(validInput().artifactContext)
  terminalContext.release = {
    status: "draft",
    releaseId: 10,
    bodySha256: releaseBodySha256(terminalBody),
    marker: terminalMarker,
    assets: [],
  }
  const markedResult = await recordAbandonment({
    candidate: CANDIDATE,
    reason: input.reason,
    artifactContext: terminalContext,
    authorization: freshAuthorization(input).authorization,
    github: afterMarker.github,
  })
  assert.equal(markedResult.status, "recorded")
  assert.deepEqual(afterMarker.mutations, ["upload"])
})

test("conflicting terminal metadata is rejected before a missing tombstone can be uploaded", async () => {
  const input = validInput()
  const tombstone = await evaluateAbandonment(input)
  const tombstoneBytes = canonicalAbandonmentBytes(tombstone)
  const marker = {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 1,
    phase: "ABANDONED_PREPUBLICATION",
    version: VERSION,
    commitSha: SHA,
    tag: `v${VERSION}`,
    manifestSha256: null,
    releaseRecordSha256: null,
    baseAssetSetSha256: null,
    attestationSet: null,
    npmEvidenceSha256: null,
    smokeAggregateSha256: null,
    audit: null,
    abandonmentSha256: sha256(tombstoneBytes),
  }
  const body = canonicalAbandonmentReleaseBody({ marker, tombstone })
  const remote = fakeGitHub()
  remote.release = {
    id: 10,
    tag_name: `v${VERSION}`,
    name: "conflicting title",
    body,
    draft: true,
    immutable: false,
  }
  remote.releases.push({ id: 10, tag_name: `v${VERSION}` })
  const context = structuredClone(input.artifactContext)
  context.release = {
    status: "draft",
    releaseId: 10,
    bodySha256: releaseBodySha256(body),
    marker,
    assets: [],
  }

  await assert.rejects(
    recordAbandonment({
      candidate: input.candidate,
      reason: input.reason,
      artifactContext: context,
      authorization: freshAuthorization(input).authorization,
      github: remote.github,
    }),
    /metadata|title|terminal/iu,
  )
  assert.deepEqual(remote.mutations, [])
})

test("unknown, duplicate, audit, or different-byte retained assets block terminal recording", async () => {
  const cases = [
    ["unknown", { id: 80, name: "notes.txt", sha256: "8".repeat(64) }],
    ["audit", { id: 81, name: "audit-result.json", sha256: "8".repeat(64) }],
    ["different base bytes", { id: 82, name: "manifest.json", sha256: "8".repeat(64) }],
  ]
  for (const [name, asset] of cases) {
    const input = validInput({ predecessor: "ARTIFACTS_ATTESTED", escrowCount: 1 })
    input.artifactContext.release.assets.push(asset)
    await assert.rejects(evaluateAbandonment(input), undefined, name)
  }

  const duplicate = validInput({ predecessor: "ARTIFACTS_ATTESTED", escrowCount: 1 })
  duplicate.artifactContext.release.assets.push({
    ...duplicate.artifactContext.release.assets[0],
    id: 83,
  })
  await assert.rejects(evaluateAbandonment(duplicate), /duplicate/iu)
})

test("stale tag, release, asset, or newer-release observations stop before mutation", async () => {
  const input = validInput({ predecessor: "ARTIFACTS_ATTESTED", escrowCount: 2 })
  const cases = [
    ["tag", (remote) => (remote.tagCommitSha = "b".repeat(40))],
    ["release body", (remote) => (remote.release.body += "stale")],
    ["asset bytes", (remote) => (remote.assets[0].bytes = Buffer.from("changed"))],
    ["newer release", (remote) => remote.releases.push({ id: 99, tag_name: "v0.8.23" })],
  ]

  for (const [name, mutate] of cases) {
    const remote = fakeGitHub({ context: input.artifactContext })
    mutate(remote)
    await assert.rejects(
      recordAbandonment({
        candidate: input.candidate,
        reason: input.reason,
        artifactContext: input.artifactContext,
        authorization: freshAuthorization(input).authorization,
        github: remote.github,
      }),
      undefined,
      name,
    )
    assert.deepEqual(remote.mutations, [])
  }
})

function validInput({ predecessor = "CANDIDATE_TAGGED", escrowCount } = {}) {
  const observation = (workflowRunId, observedAt) => ({
    workflowRunId,
    runAttempt: 1,
    observedAt,
    packages: PACKAGE_NAMES.map((name) => ({
      name,
      version: VERSION,
      status: "ABSENT",
      httpStatus: 404,
      code: "E404",
    })),
  })
  return {
    candidate: structuredClone(CANDIDATE),
    reason: "Candidate preparation is deterministically defective",
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
    approval: {
      environment: "release-abandonment",
      environmentId: 200,
      reviewerId: 201,
      reviewer: "release-reviewer",
      state: "approved",
      observedAt: "2026-08-24T11:59:00Z",
      workflowRunId: 300,
      runAttempt: 1,
      actor: "release-operator",
      actorId: 200,
      recordedAt: "2026-08-24T12:04:00Z",
    },
    artifactContext: artifactContext(predecessor, escrowCount),
  }
}

function freshAuthorization(input, { ageMinutes = 0 } = {}) {
  const now = Date.now() - ageMinutes * 60_000
  const timestamp = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
  const observation = (workflowRunId, minutesAgo) => ({
    workflowRunId,
    runAttempt: 1,
    observedAt: timestamp(minutesAgo),
    packages: PACKAGE_NAMES.map((name) => ({
      name,
      version: VERSION,
      status: "ABSENT",
      httpStatus: 404,
      code: "E404",
    })),
  })
  const evidence = {
    actionsHistory: {
      workflowRunId: 900,
      runAttempt: 1,
      observedAt: timestamp(0),
      publishJobStarted: false,
      registryMutationStarted: false,
    },
    observations: [observation(900, 2), observation(900, 1)],
    approval: {
      environment: "release-abandonment",
      environmentId: 800,
      reviewerId: 801,
      reviewer: "release-reviewer",
      state: "approved",
      observedAt: timestamp(3),
      workflowRunId: 900,
      runAttempt: 1,
      actor: input.approval.actor,
      actorId: input.approval.actorId,
      recordedAt: timestamp(0),
    },
  }
  let callCount = 0
  return {
    evidence,
    calls: () => callCount,
    authorization: {
      async readFreshAbandonmentEvidence({ candidate }) {
        callCount += 1
        assert.deepEqual(candidate, input.candidate)
        return structuredClone(evidence)
      },
    },
  }
}

function artifactContext(predecessor, requestedEscrowCount) {
  const prepared = predecessor !== "CANDIDATE_TAGGED"
  const attested = ["ARTIFACTS_ATTESTED", "CANDIDATE_ESCROWED"].includes(predecessor)
  const attestationSet = attested ? makeAttestationSet() : null
  const artifact = {
    manifestSha256: prepared ? sha256(bytesForName("manifest.json")) : null,
    releaseRecordSha256: prepared ? sha256(bytesForName("release-record.json")) : null,
    baseAssetSetSha256: attested ? baseAssetSetSha256(attestationSet) : null,
    attestationSet,
  }
  const escrowCount =
    requestedEscrowCount ?? (predecessor === "CANDIDATE_ESCROWED" ? baseAssets(artifact).length : 0)
  const hasRelease = attested && (predecessor === "CANDIDATE_ESCROWED" || escrowCount > 0)
  let release = {
    status: "absent",
    releaseId: null,
    bodySha256: null,
    marker: null,
    assets: [],
  }
  if (hasRelease) {
    const marker = releaseMarker(
      predecessor === "CANDIDATE_ESCROWED" ? "ESCROWED" : "ESCROWING",
      artifact,
    )
    const body = canonicalReleaseBody({ marker, manifest: null })
    release = {
      status: "draft",
      releaseId: 10,
      bodySha256: releaseBodySha256(body),
      marker,
      assets: baseAssets(artifact)
        .slice(0, escrowCount)
        .map((asset, index) => ({ id: index + 1, ...asset })),
    }
  }
  return {
    predecessor,
    tag: { status: "present", annotated: true, tag: `v${VERSION}`, commitSha: SHA },
    newerReleaseInterleaved: false,
    artifact,
    release,
  }
}

function makeAttestationSet() {
  const subjectNames = [
    "manifest.json",
    ...Array.from({ length: 21 }, (_, index) => `package-${String(index).padStart(2, "0")}.tgz`),
  ]
  return {
    repository: "cacheplane/dawnai",
    workflow: ".github/workflows/release.yml",
    sourceRef: `refs/tags/v${VERSION}`,
    commitSha: SHA,
    workflowRunId: 400,
    runAttempt: 1,
    subjects: subjectNames.map((subjectName) => ({
      subjectName,
      subjectSha256: sha256(bytesForName(subjectName)),
      bundleName: `${subjectName}.intoto.jsonl`,
      bundleSha256: sha256(bytesForName(`${subjectName}.intoto.jsonl`)),
    })),
  }
}

function baseAssets(artifact) {
  if (artifact.attestationSet === null) return []
  return [
    { name: "release-record.json", sha256: artifact.releaseRecordSha256 },
    { name: "manifest.json", sha256: artifact.manifestSha256 },
    ...artifact.attestationSet.subjects.slice(1).map((subject) => ({
      name: subject.subjectName,
      sha256: subject.subjectSha256,
    })),
    ...artifact.attestationSet.subjects.map((subject) => ({
      name: subject.bundleName,
      sha256: subject.bundleSha256,
    })),
  ]
}

function baseAssetSetSha256(attestationSet) {
  const artifact = {
    manifestSha256: sha256(bytesForName("manifest.json")),
    releaseRecordSha256: sha256(bytesForName("release-record.json")),
    attestationSet,
  }
  const bytes = Buffer.from(
    `${JSON.stringify(baseAssets(artifact).map(({ name, sha256 }) => ({ name, sha256 })))}\n`,
  )
  return sha256(bytes)
}

function releaseMarker(phase, artifact) {
  return {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 1,
    phase,
    version: VERSION,
    commitSha: SHA,
    tag: `v${VERSION}`,
    ...structuredClone(artifact),
    npmEvidenceSha256: null,
    smokeAggregateSha256: null,
    audit: null,
    abandonmentSha256: null,
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

function fakeGitHub({
  context = artifactContext("CANDIDATE_TAGGED"),
  source,
  failAfter = null,
  createStatus = "created",
} = {}) {
  const state = {
    release: source?.release ? structuredClone(source.release) : null,
    assets: source?.assets
      ? source.assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes) }))
      : [],
    releases: source?.releases ? structuredClone(source.releases) : [],
    mutations: [],
    tagCommitSha: SHA,
  }
  if (source === undefined && context.release.status === "draft") {
    const body = canonicalReleaseBody({ marker: context.release.marker, manifest: null })
    state.release = {
      id: context.release.releaseId,
      tag_name: `v${VERSION}`,
      name: `Dawn v${VERSION}`,
      body,
      draft: true,
      immutable: false,
    }
    state.releases = [{ id: state.release.id, tag_name: state.release.tag_name }]
    state.assets = context.release.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      bytes: bytesForName(asset.name),
    }))
  }
  const envelope = (operation, value) => ({
    status: "PRESENT",
    operation,
    httpStatus: 200,
    code: null,
    value,
  })
  const reader = {
    getRef: async () => envelope("ref", { object: { type: "tag", sha: "c".repeat(40) } }),
    getGitTag: async () =>
      envelope("git-tag", {
        tag: `v${VERSION}`,
        object: { type: "commit", sha: state.tagCommitSha },
      }),
    listReleases: async () => envelope("releases", state.releases),
    getRelease: async ({ releaseId }) => envelope("release", { ...state.release, id: releaseId }),
    listReleaseAssets: async () =>
      envelope(
        "release-assets",
        state.assets.map(({ id, name }) => ({ id, name })),
      ),
    downloadReleaseAsset: async ({ assetId }) => {
      const asset = state.assets.find((item) => item.id === assetId)
      return {
        status: "PRESENT",
        operation: "release-asset-download",
        httpStatus: 200,
        code: null,
        contentBase64: asset.bytes.toString("base64"),
      }
    },
  }
  const writer = {
    createDraftRelease: async ({ tag, title, body }) => {
      if (createStatus === "created") state.mutations.push("create")
      state.release = {
        id: 10,
        tag_name: tag,
        name: title,
        body,
        draft: true,
        immutable: false,
      }
      state.releases.push({ id: 10, tag_name: tag })
      if (failAfter === "create") throw new Error("Simulated runner loss after create")
      return { releaseId: 10, status: createStatus, bodySha256: releaseBodySha256(body) }
    },
    updateDraftReleaseIfCurrent: async ({ title, body }) => {
      state.mutations.push("update")
      state.release.name = title
      state.release.body = body
      if (failAfter === "update") throw new Error("Simulated runner loss after update")
      return { releaseId: 10, status: "updated", bodySha256: releaseBodySha256(body) }
    },
    uploadAssetIfAbsentAndEqual: async ({ name, bytes }) => {
      state.mutations.push("upload")
      if (!state.assets.some((asset) => asset.name === name)) {
        state.assets.push({ id: state.assets.length + 100, name, bytes: Buffer.from(bytes) })
      }
      if (failAfter === "upload") throw new Error("Simulated runner loss after upload")
      return { assetId: state.assets.at(-1).id, status: "uploaded", sha256: sha256(bytes) }
    },
    publishReleaseIfCurrent: async () => {
      throw new Error("Abandonment must never publish a Release")
    },
    dispatchWorkflowAtRef: async () => {
      throw new Error("Abandonment must never dispatch a workflow")
    },
  }
  return Object.assign(state, { github: { reader, writer } })
}

function contextFromRemote(context, remote) {
  const result = structuredClone(context)
  result.release = {
    status: "draft",
    releaseId: remote.release.id,
    bodySha256: releaseBodySha256(remote.release.body),
    marker: parseReleaseMarker(remote.release.body),
    assets: remote.assets.map(({ id, name, bytes }) => ({ id, name, sha256: sha256(bytes) })),
  }
  return result
}

function bytesForName(name) {
  return Buffer.from(`exact fixture bytes for ${name}\n`, "utf8")
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
