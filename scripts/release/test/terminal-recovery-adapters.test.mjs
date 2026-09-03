import assert from "node:assert/strict"
import test from "node:test"

import {
  createDuplicateRecoveryWriterContext,
  requestRecoveryJson,
} from "../duplicate-draft-recovery-adapters.mjs"
import {
  CANONICAL_ABANDONED_TITLE,
  CANONICAL_ESCROW_TITLE,
  CANONICAL_RELEASE_ID,
  CANONICAL_TAG_NAME,
  createTerminalRecoveryWriter,
  createTerminalRecoveryWriterContext,
  TOMBSTONE_ASSET_NAME,
} from "../terminal-recovery-adapters.mjs"
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
    "readCanonicalSnapshot",
    "uploadTombstoneIfAbsentAndEqual",
  ])
  assert.equal(Object.isFrozen(writer), true)
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
      if (url === `${BASE}/releases/assets/${fixture.tombstoneRawAsset.id}`) {
        return binaryResponse(fixture.tombstoneBytes)
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
        expectedName: CANONICAL_ABANDONED_TITLE,
        expectedBody: fixture.abandonmentBody,
      }),
    /digest is stale/iu,
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
        expectedName: CANONICAL_ABANDONED_TITLE,
        expectedBody: fixture.abandonmentBody,
      }),
    /tombstone/iu,
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

function terminalFixture() {
  const rawAssets = Array.from({ length: 45 }, (_value, index) => ({
    id: index + 1,
    name: `dawn-asset-${String(index + 1).padStart(2, "0")}.tgz`,
    digest: `sha256:${index.toString(16).padStart(2, "0").repeat(32)}`,
    size: index + 1,
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
    if (url === `${BASE}/releases/assets/${fixture.tombstoneRawAsset.id}`) {
      return binaryResponse(fixture.tombstoneBytes)
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
          immutable: false,
          body,
          assets: [...fixture.normalized, fixture.tombstoneAsset],
        }),
      ),
    ),
  )
}
