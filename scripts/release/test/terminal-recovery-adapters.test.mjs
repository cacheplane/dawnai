import assert from "node:assert/strict"
import test from "node:test"

import { createTerminalRecoveryReader } from "../abandon-v0.8.22-candidate.mjs"
import {
  createDuplicateRecoveryWriterContext,
  RECOVERY_MAX_ASSET_BYTES,
  readCurrentWriterObservation,
  requestRecoveryJson,
} from "../duplicate-draft-recovery-adapters.mjs"
import {
  assertTerminalRecoveryWriter,
  CANONICAL_ABANDONED_TITLE,
  CANONICAL_ESCROW_TITLE,
  CANONICAL_RELEASE_ID,
  CANONICAL_TAG_NAME,
  createTerminalRecoveryWriter,
  createTerminalRecoveryWriterContext,
  normalizeTerminalReleaseProjection,
  normalizeTerminalReleaseSnapshot,
  TOMBSTONE_ASSET_NAME,
} from "../terminal-recovery-adapters.mjs"
import { sealedManifestBytes } from "./support/terminal-record-fixture.mjs"
import {
  binaryResponse,
  canonicalizeForTest,
  jsonResponse,
  requestBody,
  routingFetch,
  sha256,
} from "./support/terminal-recovery-fetch.mjs"

const TOKEN = "secret-token"
const TAG_OBJECT = "d".repeat(40)
const CANDIDATE_SHA = "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8"
const BASE = "https://api.github.com/repos/cacheplane/dawnai"
const UPLOAD_BASE = "https://uploads.github.com/repos/cacheplane/dawnai"
const DUPLICATE_ID = 379982100

test("terminal recovery writer exposes only the exact frozen canonical surface", () => {
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: async () => assert.fail("construction must not access the network"),
  })

  assert.deepEqual(Object.keys(writer).sort(), [
    "abandonCandidateIfCurrent",
    "downloadCanonicalAsset",
    "readCanonicalSnapshot",
    "uploadTombstoneIfAbsentAndEqual",
  ])
  assert.equal(Object.isFrozen(writer), true)
  assert.equal(assertTerminalRecoveryWriter(writer), writer)
  assert.throws(
    () => assertTerminalRecoveryWriter({ ...writer }),
    /surface is not exact/iu,
    "an unfrozen look-alike is not the writer surface",
  )
  assert.throws(
    () =>
      createTerminalRecoveryWriter({
        token: TOKEN,
        fetchImpl: async () => {},
        uploadOrigin: "https://evil.example",
      }),
    /schema|option|field/iu,
  )
})

test("terminal recovery writer reads the canonical draft under either pinned title", async () => {
  for (const title of [CANONICAL_ESCROW_TITLE, CANONICAL_ABANDONED_TITLE]) {
    const fixture = terminalFixture()
    const writer = createTerminalRecoveryWriter({
      token: TOKEN,
      fetchImpl: routingFetch([], canonicalRoute(fixture, { title })),
    })

    const snapshot = await writer.readCanonicalSnapshot()

    assert.deepEqual(snapshot, { ...fixture.escrowSnapshot, name: title })
    assert.equal(Object.isFrozen(snapshot), true)
  }
})

test("terminal recovery writer fails closed on canonical projection drift", async (t) => {
  const drifts = [
    ["tag drift", { tagName: "untagged-0000000000000000cafe" }],
    ["title drift", { title: "Dawn v0.8.22 (retired)" }],
    ["publication drift", { draft: false }],
    ["immutability drift", { immutable: true }],
    ["branch drift", { targetCommitish: "release" }],
  ]
  for (const [name, overrides] of drifts) {
    await t.test(name, async () => {
      const fixture = terminalFixture()
      const writer = createTerminalRecoveryWriter({
        token: TOKEN,
        fetchImpl: routingFetch([], canonicalRoute(fixture, overrides)),
      })

      await assert.rejects(() => writer.readCanonicalSnapshot(), {
        code: "RELEASE_MALFORMED",
      })
    })
  }
})

test("terminal recovery writer rejects an unexpected canonical asset inventory", async (t) => {
  await t.test("a missing base asset", async () => {
    const fixture = terminalFixture()
    const writer = createTerminalRecoveryWriter({
      token: TOKEN,
      fetchImpl: routingFetch(
        [],
        canonicalRoute(fixture, { rawAssets: fixture.rawAssets.slice(1) }),
      ),
    })
    await assert.rejects(() => writer.readCanonicalSnapshot(), {
      code: "RELEASE_ASSETS_MALFORMED",
    })
  })
  await t.test("an unapproved extra asset", async () => {
    const fixture = terminalFixture()
    const writer = createTerminalRecoveryWriter({
      token: TOKEN,
      fetchImpl: routingFetch(
        [],
        canonicalRoute(fixture, {
          rawAssets: [
            ...fixture.rawAssets,
            { id: 9001, name: "surprise.json", digest: `sha256:${"a".repeat(64)}`, size: 4 },
          ],
        }),
      ),
    })
    await assert.rejects(() => writer.readCanonicalSnapshot(), {
      code: "RELEASE_ASSETS_MALFORMED",
    })
  })
})

test("terminal recovery writer uploads the tombstone then stamps the abandonment in one PATCH", async () => {
  const fixture = terminalFixture()
  const calls = []
  let uploaded = false
  let abandoned = false
  const observedTimes = [
    Date.parse("2026-09-03T09:00:00.000Z"),
    Date.parse("2026-09-03T09:00:01.000Z"),
  ]
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    now: () => observedTimes.shift(),
    fetchImpl: routingFetch(calls, async (url, init) => {
      if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) return jsonResponse(candidateTagRef())
      if (url === `${BASE}/git/tags/${TAG_OBJECT}`) return jsonResponse(candidateTagObject())
      if (url === `${BASE}/releases/${CANONICAL_RELEASE_ID}` && init.method === "PATCH") {
        assert.deepEqual(requestBody(init), {
          name: CANONICAL_ABANDONED_TITLE,
          body: fixture.abandonmentBody,
        })
        abandoned = true
        return jsonResponse(
          canonicalRelease({
            title: CANONICAL_ABANDONED_TITLE,
            body: fixture.abandonmentBody,
          }),
          200,
        )
      }
      if (url === `${BASE}/releases/${CANONICAL_RELEASE_ID}`) {
        return jsonResponse(
          canonicalRelease({
            title: abandoned ? CANONICAL_ABANDONED_TITLE : CANONICAL_ESCROW_TITLE,
            body: abandoned ? fixture.abandonmentBody : fixture.escrowBody,
          }),
        )
      }
      if (url === `${BASE}/releases/${CANONICAL_RELEASE_ID}/assets?per_page=100`) {
        return jsonResponse(uploaded ? fixture.rawAssetsWithTombstone : fixture.rawAssets)
      }
      if (
        url ===
        `${UPLOAD_BASE}/releases/${CANONICAL_RELEASE_ID}/assets?name=${TOMBSTONE_ASSET_NAME}`
      ) {
        assert.equal(init.method, "POST")
        assert.equal(init.redirect, "manual")
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`)
        assert.deepEqual(Buffer.from(init.body), fixture.tombstoneBytes)
        uploaded = true
        return jsonResponse(
          {
            id: fixture.tombstoneRawAsset.id,
            name: TOMBSTONE_ASSET_NAME,
            digest: `sha256:${fixture.tombstoneSha256}`,
            size: fixture.tombstoneBytes.byteLength,
            state: "uploaded",
          },
          201,
        )
      }
      assert.fail(`unexpected URL ${url}`)
    }),
  })

  const upload = await writer.uploadTombstoneIfAbsentAndEqual({
    expectedSnapshot: fixture.escrowSnapshot,
    expectedTagObjectSha: TAG_OBJECT,
    bytes: fixture.tombstoneBytes,
    sha256: fixture.tombstoneSha256,
  })
  assert.deepEqual(upload, {
    releaseId: CANONICAL_RELEASE_ID,
    assetId: fixture.tombstoneRawAsset.id,
    name: TOMBSTONE_ASSET_NAME,
    status: "uploaded",
    sha256: fixture.tombstoneSha256,
  })

  const result = await writer.abandonCandidateIfCurrent({
    expectedSnapshot: fixture.tombstonedSnapshot,
    expectedTagObjectSha: TAG_OBJECT,
    expectedBodySha256: sha256(Buffer.from(fixture.escrowBody, "utf8")),
    expectedTombstoneSha256: fixture.tombstoneSha256,
    expectedName: CANONICAL_ABANDONED_TITLE,
    expectedBody: fixture.abandonmentBody,
  })

  assert.deepEqual(result, {
    atomic: false,
    releaseId: CANONICAL_RELEASE_ID,
    outcome: "performed",
    preWriteFence: {
      observedAt: "2026-09-03T09:00:00.000Z",
      projectionSha256: terminalProjectionSha256(fixture, {
        name: CANONICAL_ESCROW_TITLE,
        body: fixture.escrowBody,
      }),
      tagObjectSha: TAG_OBJECT,
    },
    postWriteFence: {
      observedAt: "2026-09-03T09:00:01.000Z",
      projectionSha256: terminalProjectionSha256(fixture, {
        name: CANONICAL_ABANDONED_TITLE,
        body: fixture.abandonmentBody,
      }),
      tagObjectSha: TAG_OBJECT,
    },
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.preWriteFence), true)
  assert.notEqual(result.preWriteFence.projectionSha256, result.postWriteFence.projectionSha256)
  assert.match(result.preWriteFence.projectionSha256, /^[0-9a-f]{64}$/u)
  assert.match(result.postWriteFence.projectionSha256, /^[0-9a-f]{64}$/u)

  const patches = calls.filter(({ init }) => init.method === "PATCH")
  assert.equal(patches.length, 1)
  assert.deepEqual(Object.keys(requestBody(patches[0].init)).sort(), ["body", "name"])
  assert.equal(calls.filter(({ init }) => init.method === "POST").length, 1)
})

test("terminal recovery writer refuses to stamp when the pre-write body digest differs", async () => {
  const fixture = terminalFixture()
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(calls, canonicalRoute(fixture, { withTombstone: true })),
  })

  await assert.rejects(
    () =>
      writer.abandonCandidateIfCurrent({
        expectedSnapshot: fixture.tombstonedSnapshot,
        expectedTagObjectSha: TAG_OBJECT,
        expectedBodySha256: "b".repeat(64),
        expectedTombstoneSha256: fixture.tombstoneSha256,
        expectedName: CANONICAL_ABANDONED_TITLE,
        expectedBody: fixture.abandonmentBody,
      }),
    { code: "CANONICAL_BODY_DIGEST_STALE" },
  )
  assert.equal(
    calls.filter(({ init }) => init.method === "PATCH").length,
    0,
    "no PATCH may be issued once the body fence fails",
  )
})

test("terminal recovery writer refuses to stamp a canonical draft without its tombstone", async () => {
  const fixture = terminalFixture()
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(calls, canonicalRoute(fixture, {})),
  })

  await assert.rejects(
    () =>
      writer.abandonCandidateIfCurrent({
        expectedSnapshot: fixture.escrowSnapshot,
        expectedTagObjectSha: TAG_OBJECT,
        expectedBodySha256: sha256(Buffer.from(fixture.escrowBody, "utf8")),
        expectedTombstoneSha256: fixture.tombstoneSha256,
        expectedName: CANONICAL_ABANDONED_TITLE,
        expectedBody: fixture.abandonmentBody,
      }),
    { code: "TOMBSTONE_ASSET_MISSING" },
  )
  assert.equal(calls.filter(({ init }) => init.method === "PATCH").length, 0)
})

test("terminal recovery writer conflicts on an existing tombstone whose digest differs", async () => {
  const fixture = terminalFixture()
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(calls, canonicalRoute(fixture, { withTombstone: true })),
  })

  await assert.rejects(
    () =>
      writer.uploadTombstoneIfAbsentAndEqual({
        expectedSnapshot: fixture.tombstonedSnapshot,
        expectedTagObjectSha: TAG_OBJECT,
        bytes: fixture.otherTombstoneBytes,
        sha256: fixture.otherTombstoneSha256,
      }),
    { code: "TOMBSTONE_ASSET_CONFLICT" },
  )
  assert.equal(calls.filter(({ init }) => init.method === "POST").length, 0)
})

test("terminal recovery writer accepts an already-present identical tombstone", async () => {
  const fixture = terminalFixture()
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(calls, canonicalRoute(fixture, { withTombstone: true })),
  })

  const result = await writer.uploadTombstoneIfAbsentAndEqual({
    expectedSnapshot: fixture.tombstonedSnapshot,
    expectedTagObjectSha: TAG_OBJECT,
    bytes: fixture.tombstoneBytes,
    sha256: fixture.tombstoneSha256,
  })

  assert.deepEqual(result, {
    releaseId: CANONICAL_RELEASE_ID,
    assetId: fixture.tombstoneRawAsset.id,
    name: TOMBSTONE_ASSET_NAME,
    status: "existing",
    sha256: fixture.tombstoneSha256,
  })
  assert.equal(calls.filter(({ init }) => init.method === "POST").length, 0)
})

test("terminal recovery writer reports ambiguity on post-write name or body drift", async (t) => {
  const cases = [
    ["name drift", { name: CANONICAL_ESCROW_TITLE }],
    ["body drift", { body: "# not what we wrote\n" }],
  ]
  for (const [name, drift] of cases) {
    await t.test(name, async () => {
      const fixture = terminalFixture()
      const writer = createTerminalRecoveryWriter({
        token: TOKEN,
        fetchImpl: routingFetch(
          [],
          canonicalRoute(fixture, { withTombstone: true, postWriteDrift: drift }),
        ),
      })

      await assert.rejects(
        () =>
          writer.abandonCandidateIfCurrent({
            expectedSnapshot: fixture.tombstonedSnapshot,
            expectedTagObjectSha: TAG_OBJECT,
            expectedBodySha256: sha256(Buffer.from(fixture.escrowBody, "utf8")),
            expectedTombstoneSha256: fixture.tombstoneSha256,
            expectedName: CANONICAL_ABANDONED_TITLE,
            expectedBody: fixture.abandonmentBody,
          }),
        { code: "MUTATION_OUTCOME_AMBIGUOUS" },
      )
    })
  }
})

test("terminal recovery writer rejects non-canonical abandonment inputs before any read", async (t) => {
  const fixture = terminalFixture()
  const rejecting = () =>
    createTerminalRecoveryWriter({
      token: TOKEN,
      fetchImpl: async () => assert.fail("input validation must not access the network"),
    })
  const base = {
    expectedSnapshot: fixture.tombstonedSnapshot,
    expectedTagObjectSha: TAG_OBJECT,
    expectedBodySha256: sha256(Buffer.from(fixture.escrowBody, "utf8")),
    expectedTombstoneSha256: fixture.tombstoneSha256,
    expectedName: CANONICAL_ABANDONED_TITLE,
    expectedBody: fixture.abandonmentBody,
  }
  const cases = [
    ["a non-canonical title", { expectedName: "Dawn v0.8.22 (retired)" }, /abandonment title/iu],
    ["a non-string title", { expectedName: 7 }, /abandonment title/iu],
    ["an empty title", { expectedName: "" }, /abandonment title/iu],
    ["a non-string body", { expectedBody: null }, /abandonment body/iu],
    ["an empty body", { expectedBody: "" }, /abandonment body/iu],
    ["an oversize body", { expectedBody: "x".repeat(1024 * 1024 + 1) }, /abandonment body/iu],
    ["a credential-bearing title", { expectedName: `Dawn ${TOKEN}` }, /credential/iu],
    ["a credential-bearing body", { expectedBody: `leaked ${TOKEN}\n` }, /credential/iu],
    ["an unknown field", { extra: 1 }, /schema/iu],
  ]
  for (const [name, override, pattern] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        () => rejecting().abandonCandidateIfCurrent({ ...base, ...override }),
        pattern,
      )
    })
  }
})

test("terminal recovery writer rejects credential-bearing tombstone bytes", async () => {
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: async () => assert.fail("input validation must not access the network"),
  })
  const bytes = Buffer.from(`{"token":"${TOKEN}"}`)

  await assert.rejects(
    () =>
      writer.uploadTombstoneIfAbsentAndEqual({
        expectedSnapshot: terminalFixture().escrowSnapshot,
        expectedTagObjectSha: TAG_OBJECT,
        bytes,
        sha256: sha256(bytes),
      }),
    /credential/iu,
  )
})

test("each recovery writer's innermost URL guard refuses the other writer's Releases", async () => {
  const options = { token: TOKEN, fetchImpl: async () => assert.fail("guard runs before fetch") }
  const terminal = createTerminalRecoveryWriterContext(options)
  const duplicate = createDuplicateRecoveryWriterContext(options)
  const patch = (releaseId) => ({
    url: `https://api.github.com/repos/cacheplane/dawnai/releases/${releaseId}`,
    method: "PATCH",
    body: { body: "x" },
    contentType: "application/json",
    maximumRequestBytes: 16 * 1024,
  })

  await assert.rejects(
    () => requestRecoveryJson(terminal, patch(DUPLICATE_ID)),
    /URL or method is not allowed/iu,
  )
  await assert.rejects(
    () => requestRecoveryJson(duplicate, patch(CANONICAL_RELEASE_ID)),
    /URL or method is not allowed/iu,
  )
  await assert.rejects(
    () =>
      requestRecoveryJson(terminal, {
        ...patch(CANONICAL_RELEASE_ID),
        method: "DELETE",
      }),
    /URL or method is not allowed/iu,
  )
})

test("terminal recovery writer refuses to stamp an already-abandoned draft", async () => {
  const fixture = terminalFixture()
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(
      calls,
      canonicalRoute(fixture, {
        title: CANONICAL_ABANDONED_TITLE,
        body: fixture.abandonmentBody,
        withTombstone: true,
      }),
    ),
  })

  // Every other pre-write fence is satisfied on purpose — the body digest is
  // the abandoned body's own digest and the tombstone is present and exact —
  // so the escrow-title check is the only thing standing between this call and
  // a second, redundant PATCH.
  await assert.rejects(
    () =>
      writer.abandonCandidateIfCurrent({
        expectedSnapshot: fixture.abandonedSnapshot,
        expectedTagObjectSha: TAG_OBJECT,
        expectedBodySha256: sha256(Buffer.from(fixture.abandonmentBody, "utf8")),
        expectedTombstoneSha256: fixture.tombstoneSha256,
        expectedName: CANONICAL_ABANDONED_TITLE,
        expectedBody: fixture.abandonmentBody,
      }),
    { code: "CANONICAL_DRAFT_NOT_ESCROWED" },
  )
  assert.equal(
    calls.filter(({ init }) => init.method === "PATCH").length,
    0,
    "an abandoned draft must never be stamped a second time",
  )
})

test("terminal recovery writer refuses to stamp against a foreign tombstone digest", async () => {
  const fixture = terminalFixture()
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(calls, canonicalRoute(fixture, { withTombstone: true })),
  })

  await assert.rejects(
    () =>
      writer.abandonCandidateIfCurrent({
        expectedSnapshot: fixture.tombstonedSnapshot,
        expectedTagObjectSha: TAG_OBJECT,
        expectedBodySha256: sha256(Buffer.from(fixture.escrowBody, "utf8")),
        expectedTombstoneSha256: fixture.otherTombstoneSha256,
        expectedName: CANONICAL_ABANDONED_TITLE,
        expectedBody: fixture.abandonmentBody,
      }),
    { code: "TOMBSTONE_ASSET_CONFLICT" },
  )
  assert.equal(calls.filter(({ init }) => init.method === "PATCH").length, 0)
})

test("terminal recovery writer refuses to upload a tombstone onto an abandoned draft", async () => {
  const fixture = terminalFixture()
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(
      calls,
      canonicalRoute(fixture, {
        title: CANONICAL_ABANDONED_TITLE,
        body: fixture.abandonmentBody,
      }),
    ),
  })

  await assert.rejects(
    () =>
      writer.uploadTombstoneIfAbsentAndEqual({
        expectedSnapshot: fixture.abandonedEscrowAssetSnapshot,
        expectedTagObjectSha: TAG_OBJECT,
        bytes: fixture.tombstoneBytes,
        sha256: fixture.tombstoneSha256,
      }),
    { code: "CANONICAL_DRAFT_NOT_ESCROWED" },
  )
  assert.equal(calls.filter(({ init }) => init.method === "POST").length, 0)
})

test("terminal recovery writer rejects an oversize PATCH envelope before any request", async () => {
  const fixture = terminalFixture()
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(calls, async () => assert.fail("no request may be issued")),
  })
  // 600 KiB of quotes is under the 1 MiB body bound, but JSON escaping doubles
  // it well past the transport bound the PATCH would use.
  const body = '"'.repeat(600 * 1024)
  assert.ok(Buffer.byteLength(body, "utf8") < 1024 * 1024)

  await assert.rejects(
    () =>
      writer.abandonCandidateIfCurrent({
        expectedSnapshot: fixture.tombstonedSnapshot,
        expectedTagObjectSha: TAG_OBJECT,
        expectedBodySha256: sha256(Buffer.from(fixture.escrowBody, "utf8")),
        expectedTombstoneSha256: fixture.tombstoneSha256,
        expectedName: CANONICAL_ABANDONED_TITLE,
        expectedBody: body,
      }),
    { code: "ABANDONMENT_REQUEST_TOO_LARGE" },
  )
  assert.deepEqual(calls, [], "an oversize envelope is an input rejection, not a write")
})

test("each writer context's observation reader refuses the other writer's Releases", async () => {
  // The rejection code alone cannot distinguish the allowlist guard from a
  // failed read, so the proof is that the guard runs before the transport: a
  // refused Release ID produces no request at all.
  const calls = []
  const context = (build) =>
    build({ token: TOKEN, fetchImpl: routingFetch(calls, async () => jsonResponse({}, 500)) })
  const terminal = context(createTerminalRecoveryWriterContext)
  const duplicate = context(createDuplicateRecoveryWriterContext)

  await assert.rejects(() => readCurrentWriterObservation(terminal, DUPLICATE_ID, undefined), {
    code: "RELEASE_SNAPSHOT_UNAVAILABLE",
  })
  await assert.rejects(
    () => readCurrentWriterObservation(duplicate, CANONICAL_RELEASE_ID, undefined),
    { code: "RELEASE_SNAPSHOT_UNAVAILABLE" },
  )
  assert.deepEqual(calls, [], "a Release outside the allowlist is never requested")
})

test("the canonical normalizers reject a foreign Release identity", () => {
  const fixture = terminalFixture()
  const release = {
    id: DUPLICATE_ID,
    tag_name: CANONICAL_TAG_NAME,
    name: CANONICAL_ESCROW_TITLE,
    body: fixture.escrowBody,
    draft: true,
    prerelease: false,
    immutable: false,
    target_commitish: "main",
  }

  assert.throws(
    () =>
      normalizeTerminalReleaseSnapshot({
        release,
        rawAssets: fixture.rawAssets,
        releaseId: DUPLICATE_ID,
      }),
    { code: "RELEASE_MALFORMED" },
    "a foreign release ID is never normalized",
  )
  assert.throws(
    () =>
      normalizeTerminalReleaseSnapshot({
        release,
        rawAssets: fixture.rawAssets,
        releaseId: CANONICAL_RELEASE_ID,
      }),
    { code: "RELEASE_MALFORMED" },
    "a payload whose own ID is foreign is never normalized",
  )
  assert.throws(
    () =>
      normalizeTerminalReleaseSnapshot({
        release: { ...release, id: CANONICAL_RELEASE_ID },
        rawAssets: fixture.rawAssets,
        releaseId: DUPLICATE_ID,
      }),
    { code: "RELEASE_MALFORMED" },
    "the releaseId parameter is pinned independently of the payload's own ID",
  )
  assert.throws(
    () =>
      normalizeTerminalReleaseProjection({ ...fixture.escrowSnapshot, releaseId: DUPLICATE_ID }),
    /projection metadata is not exact/iu,
  )
  assert.throws(
    () =>
      normalizeTerminalReleaseProjection({ ...fixture.escrowSnapshot, name: "Dawn v0.8.22 RC" }),
    /projection metadata is not exact/iu,
  )
  assert.throws(
    () => normalizeTerminalReleaseProjection({ ...fixture.escrowSnapshot, prerelease: true }),
    /projection metadata is not exact/iu,
  )
})

function terminalFixture() {
  // GitHub sends far more than the four fields this boundary projects, so the
  // fixture carries a realistic payload: the normalizer must ignore the rest
  // rather than depend on a trimmed shape.
  const rawAssets = Array.from({ length: 45 }, (_value, index) => ({
    id: index + 1,
    name: `dawn-asset-${String(index + 1).padStart(2, "0")}.tgz`,
    digest: `sha256:${index.toString(16).padStart(2, "0").repeat(32)}`,
    size: index + 1,
    label: null,
    state: "uploaded",
    content_type: "application/gzip",
    download_count: 0,
    url: `https://api.github.com/repos/cacheplane/dawnai/releases/assets/${index + 1}`,
    browser_download_url: `https://github.com/cacheplane/dawnai/releases/download/v0.8.22/dawn-asset-${String(index + 1).padStart(2, "0")}.tgz`,
    uploader: { login: "github-actions[bot]", id: 41898282, type: "Bot" },
    created_at: "2026-09-01T12:00:00Z",
    updated_at: "2026-09-01T12:00:01Z",
  }))
  const escrowBody = `<!-- dawn-release-marker\n{"phase":"ESCROWED"}\n-->\n`
  const abandonmentBody = `# Dawn v0.8.22 was abandoned before publication\n${"detail line\n".repeat(2_000)}`
  const tombstoneBytes = Buffer.from(`{"schemaVersion":1,"phase":"ABANDONED"}\n`)
  const otherTombstoneBytes = Buffer.from(`{"schemaVersion":1,"phase":"OTHER"}\n`)
  const tombstoneSha256 = sha256(tombstoneBytes)
  const tombstoneRawAsset = {
    id: 5001,
    name: TOMBSTONE_ASSET_NAME,
    digest: `sha256:${tombstoneSha256}`,
    size: tombstoneBytes.byteLength,
    label: null,
    state: "uploaded",
    content_type: "application/json",
    download_count: 0,
    url: "https://api.github.com/repos/cacheplane/dawnai/releases/assets/5001",
    uploader: { login: "operator", id: 7, type: "User" },
    created_at: "2026-09-03T09:00:00Z",
    updated_at: "2026-09-03T09:00:00Z",
  }
  const normalized = rawAssets.map(({ id, name, digest, size }) => ({
    id,
    name,
    sha256: digest.slice(7),
    size,
  }))
  const tombstoneAsset = {
    id: tombstoneRawAsset.id,
    name: TOMBSTONE_ASSET_NAME,
    sha256: tombstoneSha256,
    size: tombstoneBytes.byteLength,
  }
  const snapshotBase = {
    releaseId: CANONICAL_RELEASE_ID,
    tagName: CANONICAL_TAG_NAME,
    name: CANONICAL_ESCROW_TITLE,
    targetCommitish: "main",
    draft: true,
    prerelease: false,
    immutable: false,
    body: escrowBody,
  }
  return {
    rawAssets,
    rawAssetsWithTombstone: [...rawAssets, tombstoneRawAsset],
    tombstoneRawAsset,
    tombstoneBytes,
    tombstoneSha256,
    otherTombstoneBytes,
    otherTombstoneSha256: sha256(otherTombstoneBytes),
    normalized,
    tombstoneAsset,
    escrowBody,
    abandonmentBody,
    escrowSnapshot: { ...snapshotBase, assets: normalized },
    tombstonedSnapshot: { ...snapshotBase, assets: [...normalized, tombstoneAsset] },
    abandonedSnapshot: {
      ...snapshotBase,
      name: CANONICAL_ABANDONED_TITLE,
      body: abandonmentBody,
      assets: [...normalized, tombstoneAsset],
    },
    abandonedEscrowAssetSnapshot: {
      ...snapshotBase,
      name: CANONICAL_ABANDONED_TITLE,
      body: abandonmentBody,
      assets: normalized,
    },
  }
}

function canonicalRoute(
  fixture,
  {
    title = CANONICAL_ESCROW_TITLE,
    body,
    tagName = CANONICAL_TAG_NAME,
    draft = true,
    immutable = false,
    targetCommitish = "main",
    rawAssets,
    withTombstone = false,
    postWriteDrift = null,
  },
) {
  let patched = false
  const assets = rawAssets ?? (withTombstone ? fixture.rawAssetsWithTombstone : fixture.rawAssets)
  return async (url, init) => {
    if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) return jsonResponse(candidateTagRef())
    if (url === `${BASE}/git/tags/${TAG_OBJECT}`) return jsonResponse(candidateTagObject())
    if (url === `${BASE}/releases/${CANONICAL_RELEASE_ID}` && init.method === "PATCH") {
      patched = true
      return jsonResponse(
        canonicalRelease({
          title: CANONICAL_ABANDONED_TITLE,
          body: fixture.abandonmentBody,
          tagName,
          draft,
          immutable,
          targetCommitish,
        }),
        200,
      )
    }
    if (url === `${BASE}/releases/${CANONICAL_RELEASE_ID}`) {
      const stamped = patched
      return jsonResponse(
        canonicalRelease({
          title: stamped ? CANONICAL_ABANDONED_TITLE : title,
          body: stamped ? fixture.abandonmentBody : (body ?? fixture.escrowBody),
          tagName,
          draft,
          immutable,
          targetCommitish,
          ...(stamped && postWriteDrift !== null ? postWriteDrift : {}),
        }),
      )
    }
    if (url === `${BASE}/releases/${CANONICAL_RELEASE_ID}/assets?per_page=100`) {
      return jsonResponse(assets)
    }
    assert.fail(`unexpected URL ${url}`)
  }
}

function canonicalRelease({
  title = CANONICAL_ESCROW_TITLE,
  body = "",
  tagName = CANONICAL_TAG_NAME,
  draft = true,
  immutable = false,
  targetCommitish = "main",
  name,
}) {
  return {
    id: CANONICAL_RELEASE_ID,
    tag_name: tagName,
    name: name ?? title,
    body,
    draft,
    prerelease: false,
    immutable,
    target_commitish: targetCommitish,
  }
}

function candidateTagRef() {
  return { ref: "refs/tags/v0.8.22", object: { type: "tag", sha: TAG_OBJECT } }
}

function candidateTagObject() {
  return { sha: TAG_OBJECT, tag: "v0.8.22", object: { type: "commit", sha: CANDIDATE_SHA } }
}

function terminalProjectionSha256(fixture, { name, body }) {
  return sha256(
    Buffer.from(
      JSON.stringify(
        canonicalizeForTest({
          releaseId: CANONICAL_RELEASE_ID,
          tagName: CANONICAL_TAG_NAME,
          name,
          targetCommitish: "main",
          draft: true,
          prerelease: false,
          immutable: false,
          body,
          assets: [...fixture.normalized, fixture.tombstoneAsset],
        }),
      ),
    ),
  )
}

const SIGNED_DOWNLOAD_HOST = "https://objects.githubusercontent.com/terminal"

/**
 * Match a signed asset download URL as `<host>/<digits>` without building a
 * regular expression from the host (an unescaped "." in a host pattern matches
 * more hosts than intended). Returns [url, id] like RegExp#exec, or null.
 */
function signedAssetMatch(url, host) {
  const prefix = `${host}/`
  if (typeof url !== "string" || !url.startsWith(prefix)) return null
  const id = url.slice(prefix.length)
  return /^[0-9]+$/u.test(id) ? [url, id] : null
}

/**
 * Serve the canonical draft plus one signed asset download, exactly as GitHub
 * does: the API asset URL answers 302 to a signed host that carries the bytes.
 */
function downloadRoute(fixture, bytesByAssetId) {
  const canonical = canonicalRoute(fixture, { rawAssets: fixture.rawAssets })
  return async (url, init) => {
    const asset =
      /^https:\/\/api\.github\.com\/repos\/cacheplane\/dawnai\/releases\/assets\/(\d+)$/u.exec(url)
    if (asset !== null) {
      return binaryResponse(new Uint8Array(), 302, {
        location: `${SIGNED_DOWNLOAD_HOST}/${asset[1]}`,
      })
    }
    const signed = signedAssetMatch(url, SIGNED_DOWNLOAD_HOST)
    if (signed !== null) {
      const bytes = bytesByAssetId.get(Number(signed[1]))
      if (bytes === undefined) assert.fail(`no bytes for asset ${signed[1]}`)
      return binaryResponse(bytes)
    }
    return canonical(url, init)
  }
}

/**
 * A canonical fixture whose first base asset actually serves bytes, so the
 * download path can be exercised end to end against a listing that agrees.
 */
function downloadableFixture() {
  const fixture = terminalFixture()
  const bytes = Buffer.from('{"schemaVersion":1,"manifest":true}\n', "utf8")
  const rawAssets = fixture.rawAssets.map((asset, index) =>
    index === 0
      ? {
          ...asset,
          name: "manifest.json",
          digest: `sha256:${sha256(bytes)}`,
          size: bytes.byteLength,
        }
      : asset,
  )
  return { fixture: { ...fixture, rawAssets }, assetId: rawAssets[0].id, bytes }
}

test("the writer downloads a listed canonical asset through one signed redirect", async () => {
  const { fixture, assetId, bytes } = downloadableFixture()
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(calls, downloadRoute(fixture, new Map([[assetId, bytes]]))),
  })

  const downloaded = await writer.downloadCanonicalAsset({
    assetId,
    expectedSha256: sha256(bytes),
    maximumBytes: 1024,
  })

  assert.deepEqual(downloaded, bytes)
  assert.equal(
    calls.some(({ url }) => url === `${SIGNED_DOWNLOAD_HOST}/${assetId}`),
    true,
    "the signed redirect is followed",
  )
})

test("the writer refuses an asset id the canonical draft does not list", async () => {
  const { fixture, assetId, bytes } = downloadableFixture()
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(calls, downloadRoute(fixture, new Map([[assetId, bytes]]))),
  })

  await assert.rejects(
    () =>
      writer.downloadCanonicalAsset({
        assetId: 999_001,
        expectedSha256: sha256(bytes),
        maximumBytes: 1024,
      }),
    { code: "CANONICAL_ASSET_NOT_LISTED" },
  )
  assert.deepEqual(
    calls.filter(({ url }) => url.includes("/releases/assets/")),
    [],
    "a foreign asset id is never requested",
  )
})

test("the writer refuses a listed asset whose digest is not the expected one", async () => {
  const { fixture, assetId, bytes } = downloadableFixture()
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch([], downloadRoute(fixture, new Map([[assetId, bytes]]))),
  })

  await assert.rejects(
    () =>
      writer.downloadCanonicalAsset({
        assetId,
        expectedSha256: "b".repeat(64),
        maximumBytes: 1024,
      }),
    { code: "CANONICAL_ASSET_CONFLICT" },
  )
})

test("the writer refuses downloaded bytes that do not hash to the listing", async () => {
  const { fixture, assetId, bytes } = downloadableFixture()
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(
      [],
      downloadRoute(
        fixture,
        new Map([[assetId, Buffer.from('{"schemaVersion":1,"manifest":0}\n', "utf8")]]),
      ),
    ),
  })

  await assert.rejects(
    () =>
      writer.downloadCanonicalAsset({ assetId, expectedSha256: sha256(bytes), maximumBytes: 1024 }),
    { code: "CANONICAL_ASSET_CONFLICT" },
  )
})

test("the writer refuses a download bounded below the listed asset size", async () => {
  const { fixture, assetId, bytes } = downloadableFixture()
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch([], downloadRoute(fixture, new Map([[assetId, bytes]]))),
  })

  await assert.rejects(
    () =>
      writer.downloadCanonicalAsset({ assetId, expectedSha256: sha256(bytes), maximumBytes: 1 }),
    { code: "CANONICAL_ASSET_CONFLICT" },
  )
})

/**
 * The production canonical draft's `manifest.json` asset is 11,928 bytes. The
 * fixture's sealed manifest is 11,845 — the same order, built the same way — so
 * these tests exercise the real payload size rather than a toy one.
 */
function manifestSizedFixture(bytes) {
  const fixture = terminalFixture()
  const rawAssets = fixture.rawAssets.map((asset, index) =>
    index === 0
      ? {
          ...asset,
          name: "manifest.json",
          digest: `sha256:${sha256(bytes)}`,
          size: bytes.byteLength,
        }
      : asset,
  )
  return { fixture: { ...fixture, rawAssets }, assetId: rawAssets[0].id, bytes }
}

test("the writer downloads a realistically sized sealed manifest and one exactly at its cap", async (t) => {
  const cases = [
    ["a production-sized sealed manifest", sealedManifestBytes()],
    ["an asset of exactly the canonical asset cap", Buffer.alloc(RECOVERY_MAX_ASSET_BYTES, 0x61)],
  ]
  for (const [name, bytes] of cases) {
    await t.test(name, async () => {
      const { fixture, assetId } = manifestSizedFixture(bytes)
      const writer = createTerminalRecoveryWriter({
        token: TOKEN,
        fetchImpl: routingFetch([], downloadRoute(fixture, new Map([[assetId, bytes]]))),
      })

      const downloaded = await writer.downloadCanonicalAsset({
        assetId,
        expectedSha256: sha256(bytes),
        // Exactly what the reader may ask for: the boundary's own asset cap.
        maximumBytes: RECOVERY_MAX_ASSET_BYTES,
      })

      assert.equal(downloaded.byteLength, bytes.byteLength)
      assert.equal(sha256(downloaded), sha256(bytes))
    })
  }
})

test("the writer refuses a requested maximum above its own canonical asset cap", async () => {
  // The defect the first production rerun hit: the caller asked for a maximum
  // the transport can never serve, so the request was invalid before any read.
  const bytes = sealedManifestBytes()
  const { fixture, assetId } = manifestSizedFixture(bytes)
  const calls = []
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch(calls, downloadRoute(fixture, new Map([[assetId, bytes]]))),
  })

  await assert.rejects(
    () =>
      writer.downloadCanonicalAsset({
        assetId,
        expectedSha256: sha256(bytes),
        maximumBytes: RECOVERY_MAX_ASSET_BYTES + 1,
      }),
    /download request is invalid/iu,
  )
  assert.deepEqual(calls, [], "an unservable request never reaches the network")
})

test("the writer refuses a listed asset larger than the canonical asset cap", async () => {
  const bytes = Buffer.alloc(RECOVERY_MAX_ASSET_BYTES + 1, 0x62)
  const { fixture, assetId } = manifestSizedFixture(bytes)
  const writer = createTerminalRecoveryWriter({
    token: TOKEN,
    fetchImpl: routingFetch([], downloadRoute(fixture, new Map([[assetId, bytes]]))),
  })

  await assert.rejects(
    () =>
      writer.downloadCanonicalAsset({
        assetId,
        expectedSha256: sha256(bytes),
        maximumBytes: RECOVERY_MAX_ASSET_BYTES,
      }),
    { code: "CANONICAL_ASSET_CONFLICT" },
  )
})

test("the terminal reader reads the sealed manifest through the real writer boundary", async () => {
  // The regression that fakes could not catch: the reader's requested maximum
  // must be one the real download boundary accepts.
  const bytes = sealedManifestBytes()
  const { fixture, assetId } = manifestSizedFixture(bytes)
  const reader = createTerminalRecoveryReader({
    root: "/workspace",
    token: TOKEN,
    run: async () => "",
    dependencies: {
      createDuplicateReader: () => ({}),
      createTerminalWriter: (options) =>
        createTerminalRecoveryWriter({
          ...options,
          fetchImpl: routingFetch([], downloadRoute(fixture, new Map([[assetId, bytes]]))),
        }),
    },
  })

  const downloaded = await reader.readCanonicalManifest({
    escrowAssets: [{ id: assetId, name: "manifest.json", sha256: sha256(bytes) }],
  })

  assert.equal(downloaded.byteLength, bytes.byteLength)
  assert.equal(sha256(downloaded), sha256(bytes))
})

test("the shared recovery asset cap stays exactly 64 KiB for the duplicate boundary", () => {
  // The terminal manifest bound is DERIVED from this constant, so widening it
  // to make a bigger manifest fit would silently widen the duplicate-draft
  // archive and evidence caps too. Pin it so that trade is never made by
  // accident.
  assert.equal(RECOVERY_MAX_ASSET_BYTES, 64 * 1024)
})
