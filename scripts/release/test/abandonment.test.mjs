import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  canonicalAbandonmentBytes,
  evaluateAbandonment,
  recordAbandonment,
} from "../abandonment.mjs"
import { canonicalReleaseBody, parseReleaseMarker, releaseBodySha256 } from "../metadata.mjs"

const VERSION = "0.8.22"
const SHA = "a".repeat(40)
const PACKAGE_NAMES = Array.from({ length: 21 }, (_, index) =>
  index === 20 ? "create-dawn-ai-app" : `@dawn-ai/package-${String(index).padStart(2, "0")}`,
)
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
  const tombstone = await evaluateAbandonment(input)
  const remote = fakeGitHub()

  const result = await recordAbandonment({
    candidate: input.candidate,
    tombstone,
    artifactContext: input.artifactContext,
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

test("preserves a matching interrupted escrow subset and advances its marker once", async () => {
  const input = validInput({ predecessor: "ARTIFACTS_ATTESTED", escrowCount: 7 })
  const tombstone = await evaluateAbandonment(input)
  const remote = fakeGitHub({ context: input.artifactContext })
  const retained = remote.assets.map(({ name, bytes }) => ({ name, bytes: Buffer.from(bytes) }))

  const result = await recordAbandonment({
    candidate: input.candidate,
    tombstone,
    artifactContext: input.artifactContext,
    github: remote.github,
  })

  assert.equal(result.status, "recorded")
  assert.equal(parseReleaseMarker(remote.release.body).revision, 2)
  assert.deepEqual(
    remote.assets.slice(0, retained.length).map(({ name, bytes }) => ({ name, bytes })),
    retained,
  )
  assert.equal(remote.assets.at(-1).name, "abandonment.json")
  assert.deepEqual(remote.mutations, ["upload", "update"])
})

test("an exact existing tombstone is idempotent and differing evidence cannot reactivate it", async () => {
  const input = validInput({ predecessor: "ARTIFACTS_ATTESTED", escrowCount: 3 })
  const tombstone = await evaluateAbandonment(input)
  const first = fakeGitHub({ context: input.artifactContext })
  await recordAbandonment({
    candidate: input.candidate,
    tombstone,
    artifactContext: input.artifactContext,
    github: first.github,
  })
  const terminalContext = contextFromRemote(input.artifactContext, first)
  const resumed = fakeGitHub({ context: terminalContext, source: first })

  const result = await recordAbandonment({
    candidate: input.candidate,
    tombstone,
    artifactContext: terminalContext,
    github: resumed.github,
  })
  assert.equal(result.status, "unchanged")
  assert.deepEqual(resumed.mutations, [])

  const changed = structuredClone(tombstone)
  changed.reason = "A different reason"
  await assert.rejects(
    recordAbandonment({
      candidate: input.candidate,
      tombstone: changed,
      artifactContext: terminalContext,
      github: resumed.github,
    }),
    /abandonment|terminal|evidence/iu,
  )
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
    tombstone,
    artifactContext: input.artifactContext,
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
  const terminalBody = canonicalReleaseBody({ marker: terminalMarker, manifest: null })
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
    tombstone,
    artifactContext: terminalContext,
    github: afterMarker.github,
  })
  assert.equal(markedResult.status, "recorded")
  assert.deepEqual(afterMarker.mutations, ["upload"])
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
  const tombstone = await evaluateAbandonment(input)
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
        tombstone,
        artifactContext: input.artifactContext,
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
      observedAt: "2026-08-24T12:00:00Z",
      publishJobStarted: false,
      registryMutationStarted: false,
    },
    observations: [
      observation(301, "2026-08-24T12:01:00Z"),
      observation(302, "2026-08-24T12:03:00Z"),
    ],
    approval: {
      environment: "release-abandonment",
      deploymentId: 200,
      reviewer: "release-reviewer",
      approvedAt: "2026-08-24T11:59:00Z",
      actor: "release-operator",
      recordedAt: "2026-08-24T12:04:00Z",
    },
    artifactContext: artifactContext(predecessor, escrowCount),
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

function fakeGitHub({ context = artifactContext("CANDIDATE_TAGGED"), source } = {}) {
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
      state.mutations.push("create")
      state.release = {
        id: 10,
        tag_name: tag,
        name: title,
        body,
        draft: true,
        immutable: false,
      }
      state.releases.push({ id: 10, tag_name: tag })
      return { releaseId: 10, status: "created", bodySha256: releaseBodySha256(body) }
    },
    updateDraftReleaseIfCurrent: async ({ title, body }) => {
      state.mutations.push("update")
      state.release.name = title
      state.release.body = body
      return { releaseId: 10, status: "updated", bodySha256: releaseBodySha256(body) }
    },
    uploadAssetIfAbsentAndEqual: async ({ name, bytes }) => {
      state.mutations.push("upload")
      if (!state.assets.some((asset) => asset.name === name)) {
        state.assets.push({ id: state.assets.length + 100, name, bytes: Buffer.from(bytes) })
      }
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
