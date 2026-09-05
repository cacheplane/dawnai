import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"
import { after, test } from "node:test"
import {
  API_BASE,
  auditFixture,
  CANDIDATE,
  COMMIT_SHA,
  candidateFixture,
  escrowInput,
  incompatibleV2Body,
  LEGACY_REVISION,
  loadLegacyFixture,
  observeLegacyAttempt,
  recordingGitHub,
  sha256,
  smokeFixture,
  TAG,
} from "./support/recovery-legacy-fixture.mjs"

const legacy = await loadLegacyFixture()
after(() => legacy.cleanup())

test("frozen candidate preserves original workflows, entry points, and executable import closure", async () => {
  assert.equal(LEGACY_REVISION, "88c01c4afd59866fc0ea4c8f3b8444439a01c8ea")
  assert.equal(legacy.files.size, 59)
  for (const path of [
    ".github/workflows/release.yml",
    ".github/workflows/published-artifact-verify.yml",
    "scripts/release/cli.mjs",
    "scripts/release/metadata.mjs",
    "scripts/release/audit.mjs",
    "scripts/release/adapters/github.mjs",
    "scripts/release/adapters/github-write.mjs",
  ])
    assert.ok(legacy.files.has(path), path)
  const source = await readFile(join(legacy.directory, "scripts/release/metadata.mjs"), "utf8")
  assert.match(source, /from "\.\/adapter-normalize\.mjs"/u)
  assert.match(source, /export async function escrowCandidate/u)
  // Check the exercised entry modules, whose imports are source declarations.
  // Archived workflow smoke scripts also contain imports inside generated apps.
  for (const path of [
    "scripts/release/metadata.mjs",
    "scripts/release/audit.mjs",
    "scripts/release/adapters/github.mjs",
    "scripts/release/adapters/github-write.mjs",
  ]) {
    const bytes = await readFile(join(legacy.directory, path), "utf8")
    for (const match of bytes.matchAll(
      /(?:from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+\.mjs)["']/gu,
    )) {
      assert.ok(
        legacy.files.has(posix.normalize(posix.join(posix.dirname(path), match[1]))),
        `${path} imports ${match[1]}`,
      )
    }
  }
})

test("frozen escrow reports legacy-fence-required for duplicate opaque-draft creation", async () => {
  const fixture = candidateFixture(legacy)
  const remote = recordingGitHub(legacy, fixture, { body: incompatibleV2Body(fixture.body) })
  assert.equal(legacy.modules.metadata.isManagedReleaseForTag(remote.release, TAG), false)
  assert.throws(
    () => legacy.modules.metadata.parseReleaseMarker(remote.release.body),
    /schema|identity|version/iu,
  )
  const report = await observeLegacyAttempt(remote, "escrowCandidate", () =>
    legacy.modules.metadata.escrowCandidate(escrowInput(fixture, remote.github)),
  )
  assert.equal(report.disposition, "legacy-fence-required")
  assert.equal(report.reachedReleaseObservation, true)
  assert.match(report.error, /^GitHub draft creation race could not be reconciled$/u)
  assert.equal(report.mutations.length, 1)
  const [attempt] = report.mutations
  assert.equal(attempt.method, "POST")
  assert.equal(attempt.url, `${API_BASE}/releases`)
  assert.deepEqual(JSON.parse(attempt.body), {
    body: fixture.initialBody,
    draft: true,
    generate_release_notes: false,
    name: `Dawn ${TAG}`,
    tag_name: TAG,
  })
  assert.equal(
    remote.calls.filter(({ url }) => url === `${API_BASE}/releases?per_page=100`).length,
    3,
  )
  assert.equal(
    remote.calls.some(({ url }) => url === `${API_BASE}/releases/7`),
    false,
  )
})

test("v1 opaque escrow remains recognized and completes an unchanged 45-asset replay", async () => {
  const fixture = candidateFixture(legacy)
  const remote = recordingGitHub(legacy, fixture)
  assert.equal(legacy.modules.metadata.isManagedReleaseForTag(remote.release, TAG), true)
  const result = await legacy.modules.metadata.escrowCandidate(escrowInput(fixture, remote.github))
  assert.equal(result.status, "unchanged")
  assert.equal(result.assetCount, 45)
  assert.deepEqual(remote.mutations(), [])
  assert.equal(remote.calls.filter(({ url }) => url.includes("/releases/assets/")).length, 45)
})

test("frozen low-level create recognizes a matching v1 body and title", async () => {
  const fixture = candidateFixture(legacy)
  const remote = recordingGitHub(legacy, fixture, { body: fixture.initialBody })
  const result = await remote.github.writer.createDraftRelease({
    tag: TAG,
    targetSha: COMMIT_SHA,
    title: `Dawn ${TAG}`,
    body: fixture.initialBody,
  })
  assert.equal(result.status, "existing")
  assert.deepEqual(remote.mutations(), [])
})

test("v1 npm reconciliation reaches and persists the real writer PATCH", async () => {
  const fixture = candidateFixture(legacy)
  const remote = recordingGitHub(legacy, fixture)
  const result = await legacy.modules.metadata.reconcileNpmEvidence({
    candidate: CANDIDATE,
    record: fixture.record,
    manifest: fixture.manifest,
    npmEvidence: fixture.npmEvidence,
    github: remote.github,
  })
  assert.equal(result.phase, "NPM_COMPLETE")
  assert.equal(result.status, "updated")
  assert.deepEqual(
    remote.mutations().map(({ method, url }) => ({ method, url })),
    [{ method: "PATCH", url: `${API_BASE}/releases/7` }],
  )
  assert.equal(
    legacy.modules.metadata.parseReleaseMarker(remote.release.body).phase,
    "NPM_COMPLETE",
  )
})

for (const tag of ["untagged-opaque", TAG]) {
  for (const operation of [
    "reconcileNpmEvidence",
    "reconcileSmokeEvidence",
    "recordAuditDispatch",
    "recordAuditAttempt",
    "verifyAuditSuccess",
    "publishConsolidatedRelease",
  ]) {
    test(`frozen ${operation} reaches the ${tag === TAG ? "marker parser" : "opaque-draft lookup"} boundary before rejecting v2`, async () => {
      const fixture = candidateFixture(legacy)
      const remote = recordingGitHub(legacy, fixture, {
        body: incompatibleV2Body(fixture.body),
        tag,
      })
      const { dispatch, result } = auditFixture(fixture)
      const inputs = {
        reconcileNpmEvidence: {
          candidate: CANDIDATE,
          record: fixture.record,
          manifest: fixture.manifest,
          npmEvidence: fixture.npmEvidence,
          github: remote.github,
        },
        reconcileSmokeEvidence: {
          candidate: CANDIDATE,
          record: fixture.record,
          manifest: fixture.manifest,
          npmEvidence: fixture.npmEvidence,
          smokeResults: smokeFixture(legacy, fixture),
          workflowRunId: 200,
          runAttempt: 1,
          github: remote.github,
        },
        recordAuditDispatch: { candidate: CANDIDATE, dispatch, github: remote.github },
        recordAuditAttempt: { candidate: CANDIDATE, dispatch, result, github: remote.github },
        verifyAuditSuccess: { candidate: CANDIDATE, dispatch, result, github: remote.github },
        publishConsolidatedRelease: {
          candidate: CANDIDATE,
          record: fixture.record,
          auditResult: result,
          github: remote.github,
        },
      }
      const module = Object.hasOwn(legacy.modules.metadata, operation)
        ? legacy.modules.metadata
        : legacy.modules.audit
      const report = await observeLegacyAttempt(remote, operation, () =>
        module[operation](inputs[operation]),
      )
      assert.equal(report.disposition, "no-mutation-observed")
      assert.equal(report.reachedReleaseObservation, true)
      assert.match(
        report.error,
        tag === TAG
          ? /Release marker.*(?:schema|identity|version)/iu
          : /Managed (?:draft Release is missing|audit draft is missing or ambiguous)/u,
      )
      assert.deepEqual(report.mutations, [])
      assert.equal(
        remote.calls.some(({ url }) => url === `${API_BASE}/releases/7`),
        tag === TAG,
      )
    })
  }
}

test("audit correlation accepts its exact legacy receipt and rejects another dispatch", () => {
  const fixture = candidateFixture(legacy)
  const { dispatch, result } = auditFixture(fixture)
  const input = {
    candidate: CANDIDATE,
    manifestSha256: fixture.record.manifestSha256,
    dispatch,
    result,
  }
  assert.deepEqual(legacy.modules.audit.correlateAuditResult(input), result)
  assert.throws(
    () =>
      legacy.modules.audit.correlateAuditResult({
        ...input,
        result: { ...result, workflowRunId: 502 },
      }),
    /not correlated/u,
  )
})

test("stale v1 compare-and-swap prevents a low-level body overwrite after v2 adoption", async () => {
  const fixture = candidateFixture(legacy)
  const remote = recordingGitHub(legacy, fixture, { body: incompatibleV2Body(fixture.body) })
  await assert.rejects(
    remote.github.writer.updateDraftReleaseIfCurrent({
      releaseId: 7,
      tag: TAG,
      targetSha: COMMIT_SHA,
      expectedBodySha256: sha256(fixture.body),
      title: `Dawn ${TAG}`,
      body: fixture.initialBody,
    }),
    /compare-and-swap is stale/u,
  )
  assert.deepEqual(remote.mutations(), [])
  assert.ok(remote.calls.some(({ url }) => url === `${API_BASE}/releases/7`))
})

test("a frozen in-flight uploader can still attach an audit asset to an opaque v2 draft", async () => {
  const fixture = candidateFixture(legacy)
  const remote = recordingGitHub(legacy, fixture, { body: incompatibleV2Body(fixture.body) })
  const bytes = legacy.modules.terminal.canonicalAuditResultBytes(auditFixture(fixture).result)
  const report = await observeLegacyAttempt(remote, "uploadAssetIfAbsentAndEqual", () =>
    remote.github.writer.uploadAssetIfAbsentAndEqual({
      releaseId: 7,
      tag: TAG,
      targetSha: COMMIT_SHA,
      name: "audit-attempt-501-1.json",
      bytes,
      sha256: sha256(bytes),
    }),
  )
  assert.equal(report.disposition, "legacy-fence-required")
  assert.equal(report.error, null)
  assert.equal(report.result.status, "uploaded")
  assert.deepEqual(report.mutations, [
    {
      method: "POST",
      url: "https://uploads.github.com/repos/cacheplane/dawnai/releases/7/assets?name=audit-attempt-501-1.json",
      body: bytes.toString("utf8"),
    },
  ])
})

test("low-level publication reaches and rejects the incompatible marker before PATCH", async () => {
  const fixture = candidateFixture(legacy)
  const remote = recordingGitHub(legacy, fixture, { body: incompatibleV2Body(fixture.body) })
  const report = await observeLegacyAttempt(remote, "publishReleaseIfCurrent", () =>
    remote.github.writer.publishReleaseIfCurrent({
      releaseId: 7,
      tag: TAG,
      targetSha: COMMIT_SHA,
      expectedBodySha256: sha256(remote.release.body),
      assets: fixture.base.assets.map(({ name, sha256 }) => ({ name, sha256 })),
    }),
  )
  assert.equal(report.reachedReleaseObservation, true)
  assert.match(report.error, /Release marker.*(?:schema|identity|version)/iu)
  assert.deepEqual(report.mutations, [])
})

test("invalid prerequisite inputs are inconclusive instead of fencing evidence", async () => {
  const fixture = candidateFixture(legacy)
  const remote = recordingGitHub(legacy, fixture, { body: incompatibleV2Body(fixture.body) })
  const report = await observeLegacyAttempt(remote, "escrowCandidate", () =>
    legacy.modules.metadata.escrowCandidate({}),
  )
  assert.equal(report.disposition, "inconclusive")
  assert.equal(report.reachedReleaseObservation, false)
  assert.equal(typeof report.error, "string")
  assert.deepEqual(report.mutations, [])
})

test("frozen audit dispatch reports legacy-fence-required without reading the adopted marker", async () => {
  const fixture = candidateFixture(legacy)
  const remote = recordingGitHub(legacy, fixture, { body: incompatibleV2Body(fixture.body) })
  const report = await observeLegacyAttempt(remote, "dispatchIndependentAudit", () =>
    legacy.modules.audit.dispatchIndependentAudit({
      candidate: CANDIDATE,
      manifestSha256: fixture.record.manifestSha256,
      github: remote.github.writer,
    }),
  )
  assert.equal(report.error, null)
  assert.deepEqual(report.result, auditFixture(fixture).dispatch)
  assert.equal(report.disposition, "legacy-fence-required")
  assert.equal(report.reachedReleaseObservation, false)
  assert.equal(remote.calls.length, 1)
  assert.equal(remote.release.body, incompatibleV2Body(fixture.body))
  assert.equal(report.mutations.length, 1)
  const [attempt] = report.mutations
  assert.equal(attempt.method, "POST")
  assert.equal(
    attempt.url,
    `${API_BASE}/actions/workflows/${encodeURIComponent(".github/workflows/published-artifact-verify.yml")}/dispatches`,
  )
  assert.deepEqual(JSON.parse(attempt.body), {
    ref: TAG,
    inputs: {
      version: CANDIDATE.version,
      commitSha: COMMIT_SHA,
      manifestSha256: fixture.record.manifestSha256,
    },
  })
})

test("frozen body update reports legacy-fence-required when adoption occurs after its GET", async () => {
  const fixture = candidateFixture(legacy)
  const adoptedBody = incompatibleV2Body(fixture.body)
  const remote = recordingGitHub(legacy, fixture, {
    body: fixture.initialBody,
    adoptBodyAfterFirstReleaseRead: adoptedBody,
  })
  const report = await observeLegacyAttempt(remote, "updateDraftReleaseIfCurrent", () =>
    remote.github.writer.updateDraftReleaseIfCurrent({
      releaseId: 7,
      tag: TAG,
      targetSha: COMMIT_SHA,
      expectedBodySha256: sha256(fixture.initialBody),
      title: `Dawn ${TAG}`,
      body: fixture.body,
    }),
  )
  assert.equal(report.error, null)
  assert.equal(report.result.status, "updated")
  assert.deepEqual(remote.adoptions, [{ before: fixture.initialBody, after: adoptedBody }])
  assert.deepEqual(remote.patchObservations, [{ bodyBefore: adoptedBody, ifMatch: null }])
  assert.equal(report.disposition, "legacy-fence-required")
  assert.equal(report.mutations.length, 1)
  const [attempt] = report.mutations
  assert.equal(attempt.method, "PATCH")
  assert.equal(attempt.url, `${API_BASE}/releases/7`)
  assert.deepEqual(JSON.parse(attempt.body), { name: `Dawn ${TAG}`, body: fixture.body })
  assert.equal(remote.release.body, fixture.body)
  assert.equal(legacy.modules.metadata.parseReleaseMarker(remote.release.body).phase, "ESCROWED")
})
