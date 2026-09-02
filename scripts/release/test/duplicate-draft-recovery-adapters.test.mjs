import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  canonicalRecoveryNotice,
  canonicalRecoveryReceipt,
  originalBodyAssetName,
  recoveryReceiptAssetName,
} from "../duplicate-draft-recovery.mjs"
import {
  createDuplicateDraftRecoveryReader,
  createDuplicateDraftRecoveryWriter,
} from "../duplicate-draft-recovery-adapters.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../manifest.mjs"
import { canonicalReleaseBody, parseReleaseMarker } from "../metadata.mjs"

const EXPECTED_METHODS = [
  "listCandidateReleases",
  "readCandidatePublishJobs",
  "readCandidateTag",
  "readImmutableReleases",
  "readNpmAbsence",
  "readReleaseRuns",
  "readReleaseSnapshot",
  "readRepositoryState",
  "readReviewedMergeAuthority",
  "readWorkflowState",
]
const REVIEWED_COMMIT = "a".repeat(40)
const REVIEWED_HEAD = "b".repeat(40)
const TREE = "c".repeat(40)
const TAG_OBJECT = "d".repeat(40)
const CANDIDATE_SHA = "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8"
const BASE = "https://api.github.com/repos/cacheplane/dawnai"
const UPLOAD_BASE = "https://uploads.github.com/repos/cacheplane/dawnai"
const DUPLICATE_ID = 379982100
const DUPLICATE_TAG = "untagged-a13939767dd2419ade01"
const WRITER_TITLE = "Dawn v0.8.22"

test("recovery writer exposes only the exact frozen mutation surface", () => {
  const writer = createDuplicateDraftRecoveryWriter({
    token: "secret-token",
    fetchImpl: async () => assert.fail("construction must not access the network"),
  })

  assert.deepEqual(Object.keys(writer).sort(), [
    "quarantineDuplicateBodyIfCurrent",
    "uploadEvidenceAssetIfAbsentAndEqual",
  ])
  assert.equal(Object.isFrozen(writer), true)
  assert.equal(
    Object.values(writer).every((method) => typeof method === "function"),
    true,
  )
  assert.throws(
    () =>
      createDuplicateDraftRecoveryWriter({
        token: "secret-token",
        fetchImpl: async () => {},
        uploadOrigin: "https://evil.example",
      }),
    /schema|option|field/iu,
  )
  assert.throws(
    () =>
      createDuplicateDraftRecoveryWriter(
        Object.assign(Object.create({ hiddenCapability() {} }), {
          token: "secret-token",
          fetchImpl: async () => {},
        }),
      ),
    /schema|option|field/iu,
  )
})

test("recovery writer uploads only exact candidate-derived evidence with pre/post snapshots", async () => {
  const fixture = writerFixture()
  const calls = []
  let uploaded = false
  const writer = createDuplicateDraftRecoveryWriter({
    token: "secret-token",
    fetchImpl: routingFetch(calls, async (url, init) => {
      if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) return jsonResponse(candidateTagRef())
      if (url === `${BASE}/git/tags/${TAG_OBJECT}`) return jsonResponse(candidateTagObject())
      if (url === `${BASE}/releases/${DUPLICATE_ID}`) {
        return jsonResponse(writerRelease(fixture.body))
      }
      if (url === `${BASE}/releases/${DUPLICATE_ID}/assets?per_page=100`) {
        return jsonResponse(
          uploaded ? [...fixture.rawAssets, fixture.archiveRawAsset] : fixture.rawAssets,
        )
      }
      if (url === `${BASE}/releases/assets/${fixture.archiveRawAsset.id}`) {
        return binaryResponse(fixture.archiveBytes)
      }
      if (
        url ===
        `${UPLOAD_BASE}/releases/${DUPLICATE_ID}/assets?name=${encodeURIComponent(fixture.archiveName)}`
      ) {
        assert.equal(init.method, "POST")
        assert.equal(init.redirect, "manual")
        assert.equal(init.headers.Authorization, "Bearer secret-token")
        assert.equal(init.headers["Content-Type"], "application/octet-stream")
        assert.deepEqual(Buffer.from(init.body), fixture.archiveBytes)
        uploaded = true
        return jsonResponse(
          {
            id: fixture.archiveRawAsset.id,
            name: fixture.archiveName,
            digest: `sha256:${fixture.archiveSha256}`,
            size: fixture.archiveBytes.byteLength,
            state: "uploaded",
          },
          201,
        )
      }
      assert.fail(`unexpected URL ${url}`)
    }),
  })

  const receipt = await writer.uploadEvidenceAssetIfAbsentAndEqual({
    expectedSnapshot: fixture.untouchedSnapshot,
    name: fixture.archiveName,
    bytes: fixture.archiveBytes,
    sha256: fixture.archiveSha256,
  })

  assert.deepEqual(receipt, {
    releaseId: DUPLICATE_ID,
    assetId: fixture.archiveRawAsset.id,
    name: fixture.archiveName,
    status: "uploaded",
    sha256: fixture.archiveSha256,
  })
  assert.equal(Object.isFrozen(receipt), true)
  assert.deepEqual(
    calls.filter(({ init }) => init.method !== "GET").map(({ url, init }) => [url, init.method]),
    [
      [
        `${UPLOAD_BASE}/releases/${DUPLICATE_ID}/assets?name=${encodeURIComponent(fixture.archiveName)}`,
        "POST",
      ],
    ],
  )
  assert.equal(calls.filter(({ url }) => url.includes("/git/ref/tags%2Fv0.8.22")).length, 2)
  assert.equal(
    calls.some(({ url }) => /npm|actions|dispatch|DELETE/iu.test(url)),
    false,
  )
})

test("recovery writer accepts an existing evidence asset only after exact download equality", async () => {
  const fixture = writerFixture()
  const calls = []
  const writer = createDuplicateDraftRecoveryWriter({
    token: "secret-token",
    fetchImpl: routingFetch(calls, (url) => {
      if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) return jsonResponse(candidateTagRef())
      if (url === `${BASE}/git/tags/${TAG_OBJECT}`) return jsonResponse(candidateTagObject())
      if (url === `${BASE}/releases/${DUPLICATE_ID}`)
        return jsonResponse(writerRelease(fixture.body))
      if (url === `${BASE}/releases/${DUPLICATE_ID}/assets?per_page=100`) {
        return jsonResponse([...fixture.rawAssets, fixture.archiveRawAsset])
      }
      if (url === `${BASE}/releases/assets/${fixture.archiveRawAsset.id}`) {
        return binaryResponse(fixture.archiveBytes)
      }
      assert.fail(`unexpected URL ${url}`)
    }),
  })

  const receipt = await writer.uploadEvidenceAssetIfAbsentAndEqual({
    expectedSnapshot: fixture.bodyArchivedSnapshot,
    name: fixture.archiveName,
    bytes: fixture.archiveBytes,
    sha256: fixture.archiveSha256,
  })

  assert.equal(receipt.status, "existing")
  assert.equal(
    calls.every(({ init }) => init.method === "GET"),
    true,
  )

  const unequal = createDuplicateDraftRecoveryWriter({
    token: "secret-token",
    fetchImpl: async (url) => {
      if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) return jsonResponse(candidateTagRef())
      if (url === `${BASE}/git/tags/${TAG_OBJECT}`) return jsonResponse(candidateTagObject())
      if (url === `${BASE}/releases/${DUPLICATE_ID}`)
        return jsonResponse(writerRelease(fixture.body))
      if (url === `${BASE}/releases/${DUPLICATE_ID}/assets?per_page=100`) {
        return jsonResponse([...fixture.rawAssets, fixture.archiveRawAsset])
      }
      if (url === `${BASE}/releases/assets/${fixture.archiveRawAsset.id}`) {
        return binaryResponse(
          Buffer.from("same-size-wrong-bytes".padEnd(fixture.archiveBytes.length)),
        )
      }
      assert.fail(`unexpected URL ${url}`)
    },
  })
  await assert.rejects(
    unequal.uploadEvidenceAssetIfAbsentAndEqual({
      expectedSnapshot: fixture.bodyArchivedSnapshot,
      name: fixture.archiveName,
      bytes: fixture.archiveBytes,
      sha256: fixture.archiveSha256,
    }),
    /bytes|digest|snapshot/iu,
  )
})

test("recovery writer quarantines with an exact body-only compare-and-swap", async () => {
  const fixture = writerFixture()
  const calls = []
  let quarantined = false
  const writer = createDuplicateDraftRecoveryWriter({
    token: "secret-token",
    fetchImpl: routingFetch(calls, async (url, init) => {
      if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) return jsonResponse(candidateTagRef())
      if (url === `${BASE}/git/tags/${TAG_OBJECT}`) return jsonResponse(candidateTagObject())
      if (url === `${BASE}/releases/${DUPLICATE_ID}` && init.method === "PATCH") {
        assert.deepEqual(JSON.parse(Buffer.from(init.body).toString("utf8")), {
          body: fixture.notice,
        })
        assert.equal(Buffer.from(init.body).toString("utf8").includes("name"), false)
        quarantined = true
        return jsonResponse(
          {
            ...writerRelease(fixture.notice),
            body: fixture.notice,
          },
          200,
        )
      }
      if (url === `${BASE}/releases/${DUPLICATE_ID}`) {
        return jsonResponse(writerRelease(quarantined ? fixture.notice : fixture.body))
      }
      if (url === `${BASE}/releases/${DUPLICATE_ID}/assets?per_page=100`) {
        return jsonResponse([
          ...fixture.rawAssets,
          fixture.archiveRawAsset,
          fixture.receiptRawAsset,
        ])
      }
      if (url === `${BASE}/releases/assets/${fixture.archiveRawAsset.id}`) {
        return binaryResponse(fixture.archiveBytes)
      }
      if (url === `${BASE}/releases/assets/${fixture.receiptRawAsset.id}`) {
        return binaryResponse(fixture.receiptBytes)
      }
      assert.fail(`unexpected URL ${url}`)
    }),
  })

  const result = await writer.quarantineDuplicateBodyIfCurrent({
    expectedSnapshot: fixture.receiptArchivedSnapshot,
    expectedBodySha256: fixture.archiveSha256,
    expectedNotice: fixture.notice,
  })

  assert.deepEqual(result, {
    releaseId: DUPLICATE_ID,
    status: "quarantined",
    bodySha256: sha256(Buffer.from(fixture.notice)),
  })
  assert.equal(Object.isFrozen(result), true)
  const patch = calls.find(({ init }) => init.method === "PATCH")
  assert.ok(patch)
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(patch.init.body))).sort(), ["body"])
  assert.equal(calls.filter(({ url }) => url.includes("/git/ref/tags%2Fv0.8.22")).length, 2)
})

test("recovery writer rejects non-candidate inputs and concurrent drift before mutation", async () => {
  const fixture = writerFixture()
  let calls = 0
  const writer = createDuplicateDraftRecoveryWriter({
    token: "secret-token",
    fetchImpl: async () => {
      calls += 1
      assert.fail("invalid input must not access the network")
    },
  })
  const baseInput = {
    expectedSnapshot: fixture.untouchedSnapshot,
    name: fixture.archiveName,
    bytes: fixture.archiveBytes,
    sha256: fixture.archiveSha256,
  }
  for (const input of [
    { ...baseInput, expectedSnapshot: { ...fixture.untouchedSnapshot, releaseId: 379991871 } },
    {
      ...baseInput,
      expectedSnapshot: { ...fixture.untouchedSnapshot, tagName: "v0.8.22" },
    },
    { ...baseInput, name: "arbitrary.txt" },
    { ...baseInput, bytes: Buffer.from("arbitrary") },
    { ...baseInput, sha256: "0".repeat(64) },
    {
      ...baseInput,
      expectedSnapshot: {
        ...fixture.untouchedSnapshot,
        assets: [
          ...fixture.untouchedSnapshot.assets,
          { id: 1001, name: "unexpected-evidence.txt", sha256: fixture.archiveSha256 },
        ],
        evidenceAssets: ["body"],
      },
    },
    { ...baseInput, extra: true },
  ]) {
    await assert.rejects(writer.uploadEvidenceAssetIfAbsentAndEqual(input))
  }
  const accessor = { ...baseInput }
  Object.defineProperty(accessor, "name", { enumerable: true, get: () => fixture.archiveName })
  await assert.rejects(writer.uploadEvidenceAssetIfAbsentAndEqual(accessor), /schema|accessor/iu)
  const symbol = { ...baseInput, [Symbol("hidden")]: true }
  await assert.rejects(writer.uploadEvidenceAssetIfAbsentAndEqual(symbol), /schema|field/iu)
  const inherited = Object.assign(Object.create({ hiddenCapability() {} }), baseInput)
  await assert.rejects(writer.uploadEvidenceAssetIfAbsentAndEqual(inherited), /schema|field/iu)
  assert.equal(calls, 0)

  const networkCalls = []
  const drifted = createDuplicateDraftRecoveryWriter({
    token: "secret-token",
    fetchImpl: routingFetch(networkCalls, (url) => {
      if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) return jsonResponse(candidateTagRef())
      if (url === `${BASE}/git/tags/${TAG_OBJECT}`) return jsonResponse(candidateTagObject())
      if (url === `${BASE}/releases/${DUPLICATE_ID}`) {
        return jsonResponse({ ...writerRelease(fixture.body), name: "changed title" })
      }
      if (url === `${BASE}/releases/${DUPLICATE_ID}/assets?per_page=100`) {
        return jsonResponse(fixture.rawAssets)
      }
      assert.fail(`unexpected URL ${url}`)
    }),
  })
  await assert.rejects(
    drifted.uploadEvidenceAssetIfAbsentAndEqual(baseInput),
    /title|snapshot|metadata/iu,
  )
  assert.equal(
    networkCalls.some(({ init }) => init.method !== "GET"),
    false,
  )
})

test("recovery writer bounds a stalled mutation response body", async () => {
  const fixture = writerFixture()
  const writer = createDuplicateDraftRecoveryWriter({
    token: "secret-token",
    timeoutMs: 20,
    fetchImpl: async (url, init) => {
      if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) return jsonResponse(candidateTagRef())
      if (url === `${BASE}/git/tags/${TAG_OBJECT}`) return jsonResponse(candidateTagObject())
      if (url === `${BASE}/releases/${DUPLICATE_ID}`)
        return jsonResponse(writerRelease(fixture.body))
      if (url === `${BASE}/releases/${DUPLICATE_ID}/assets?per_page=100`) {
        return jsonResponse(fixture.rawAssets)
      }
      if (url.startsWith(`${UPLOAD_BASE}/releases/${DUPLICATE_ID}/assets?name=`)) {
        assert.equal(init.method, "POST")
        return {
          status: 201,
          headers: new Headers({ "content-type": "application/json" }),
          body: {
            getReader() {
              return {
                read: () => new Promise(() => {}),
                cancel: async () => {},
              }
            },
          },
        }
      }
      assert.fail(`unexpected URL ${url}`)
    },
  })

  const operation = writer.uploadEvidenceAssetIfAbsentAndEqual({
    expectedSnapshot: fixture.untouchedSnapshot,
    name: fixture.archiveName,
    bytes: fixture.archiveBytes,
    sha256: fixture.archiveSha256,
  })
  let guard
  try {
    await assert.rejects(
      Promise.race([
        operation,
        new Promise((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error("mutation response was not time-bounded")), 200)
        }),
      ]),
      (error) => error.code === "WRITE_TIMEOUT",
    )
  } finally {
    clearTimeout(guard)
  }

  const stalledFetch = createDuplicateDraftRecoveryWriter({
    token: "secret-token",
    timeoutMs: 20,
    fetchImpl: async (url) => {
      if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) return jsonResponse(candidateTagRef())
      if (url === `${BASE}/git/tags/${TAG_OBJECT}`) return jsonResponse(candidateTagObject())
      if (url === `${BASE}/releases/${DUPLICATE_ID}`)
        return jsonResponse(writerRelease(fixture.body))
      if (url === `${BASE}/releases/${DUPLICATE_ID}/assets?per_page=100`) {
        return jsonResponse(fixture.rawAssets)
      }
      if (url.startsWith(`${UPLOAD_BASE}/releases/${DUPLICATE_ID}/assets?name=`)) {
        return new Promise(() => {})
      }
      assert.fail(`unexpected URL ${url}`)
    },
  })
  const stalledOperation = stalledFetch.uploadEvidenceAssetIfAbsentAndEqual({
    expectedSnapshot: fixture.untouchedSnapshot,
    name: fixture.archiveName,
    bytes: fixture.archiveBytes,
    sha256: fixture.archiveSha256,
  })
  let fetchGuard
  try {
    await assert.rejects(
      Promise.race([
        stalledOperation,
        new Promise((_resolve, reject) => {
          fetchGuard = setTimeout(
            () => reject(new Error("mutation fetch was not time-bounded")),
            200,
          )
        }),
      ]),
      (error) => error.code === "WRITE_TIMEOUT",
    )
  } finally {
    clearTimeout(fetchGuard)
  }
})

test("recovery writer never sends configured credential bytes as evidence or notice content", async () => {
  const fixture = writerFixture()
  const token = "DAWN_DUPLICATE_DRAFT_RECOVERY"
  let calls = 0
  const writer = createDuplicateDraftRecoveryWriter({
    token,
    fetchImpl: async () => {
      calls += 1
      assert.fail("credential-bearing content must fail before network access")
    },
  })

  await assert.rejects(
    writer.quarantineDuplicateBodyIfCurrent({
      expectedSnapshot: fixture.receiptArchivedSnapshot,
      expectedBodySha256: fixture.archiveSha256,
      expectedNotice: fixture.notice,
    }),
    (error) => !error.message.includes(token) && !JSON.stringify(error).includes(token),
  )
  assert.equal(calls, 0)
})

test("recovery writer rejects post-upload snapshot or candidate-tag drift", async (t) => {
  const fixture = writerFixture()
  for (const drift of ["asset inventory", "candidate tag"]) {
    await t.test(drift, async () => {
      let uploaded = false
      let tagReads = 0
      let posts = 0
      const writer = createDuplicateDraftRecoveryWriter({
        token: "secret-token",
        fetchImpl: async (url, init) => {
          if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) {
            tagReads += 1
            if (drift === "candidate tag" && tagReads === 2) {
              return jsonResponse({
                ref: "refs/tags/v0.8.22",
                object: { type: "tag", sha: "e".repeat(40) },
              })
            }
            return jsonResponse(candidateTagRef())
          }
          if (url === `${BASE}/git/tags/${TAG_OBJECT}`) return jsonResponse(candidateTagObject())
          if (url === `${BASE}/git/tags/${"e".repeat(40)}`) {
            return jsonResponse({
              sha: "e".repeat(40),
              tag: "v0.8.22",
              object: { type: "commit", sha: "f".repeat(40) },
            })
          }
          if (url === `${BASE}/releases/${DUPLICATE_ID}`)
            return jsonResponse(writerRelease(fixture.body))
          if (url === `${BASE}/releases/${DUPLICATE_ID}/assets?per_page=100`) {
            if (uploaded && drift === "candidate tag") {
              return jsonResponse([...fixture.rawAssets, fixture.archiveRawAsset])
            }
            return jsonResponse(fixture.rawAssets)
          }
          if (url === `${BASE}/releases/assets/${fixture.archiveRawAsset.id}`) {
            return binaryResponse(fixture.archiveBytes)
          }
          if (url.startsWith(`${UPLOAD_BASE}/releases/${DUPLICATE_ID}/assets?name=`)) {
            assert.equal(init.method, "POST")
            posts += 1
            uploaded = true
            return jsonResponse(
              {
                id: fixture.archiveRawAsset.id,
                name: fixture.archiveName,
                digest: `sha256:${fixture.archiveSha256}`,
                size: fixture.archiveBytes.byteLength,
                state: "uploaded",
              },
              201,
            )
          }
          assert.fail(`unexpected URL ${url}`)
        },
      })

      await assert.rejects(
        writer.uploadEvidenceAssetIfAbsentAndEqual({
          expectedSnapshot: fixture.untouchedSnapshot,
          name: fixture.archiveName,
          bytes: fixture.archiveBytes,
          sha256: fixture.archiveSha256,
        }),
        (error) => ["RELEASE_SNAPSHOT_CONFLICT", "CANDIDATE_TAG_CONFLICT"].includes(error.code),
      )
      assert.equal(posts, 1)
    })
  }
})

test("recovery reader exposes only the exact frozen read surface", () => {
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => assert.fail("construction must not execute commands"),
    fetchImpl: async () => assert.fail("construction must not access the network"),
  })

  assert.deepEqual(Object.keys(reader).sort(), EXPECTED_METHODS)
  assert.equal(Object.isFrozen(reader), true)
  assert.equal(
    Object.values(reader).every((method) => typeof method === "function"),
    true,
  )
})

test("reviewed authority reads exact routes and proves local, remote, PR, trees, and CI", async () => {
  const calls = []
  const runCalls = []
  const fetchImpl = routingFetch(calls, (url) => {
    if (url === `${BASE}`) return repositoryResponse()
    if (url === `${BASE}/git/ref/heads%2Fmain`) return jsonResponse(mainRef(REVIEWED_COMMIT))
    if (url === `${BASE}/commits/${REVIEWED_COMMIT}/pulls?per_page=2`) {
      return jsonResponse([reviewedPull()])
    }
    if (url === `${BASE}/git/commits/${REVIEWED_COMMIT}`) {
      return jsonResponse({ sha: REVIEWED_COMMIT, tree: { sha: TREE } })
    }
    if (url === `${BASE}/git/commits/${REVIEWED_HEAD}`) {
      return jsonResponse({ sha: REVIEWED_HEAD, tree: { sha: TREE } })
    }
    if (url === `${BASE}/commits/${REVIEWED_HEAD}/check-runs?per_page=100`) {
      return jsonResponse({
        total_count: 1,
        check_runs: [
          {
            id: 98,
            name: "validate",
            head_sha: REVIEWED_HEAD,
            status: "completed",
            conclusion: "success",
            check_suite: { id: 77 },
          },
        ],
      })
    }
    if (url === `${BASE}/actions/workflows/ci.yml/runs?head_sha=${REVIEWED_HEAD}&per_page=100`) {
      return jsonResponse({
        total_count: 1,
        workflow_runs: [
          {
            id: 987654321,
            run_attempt: 1,
            name: "CI",
            path: ".github/workflows/ci.yml",
            head_sha: REVIEWED_HEAD,
            head_branch: "reviewed-recovery",
            event: "pull_request",
            check_suite_id: 77,
            status: "completed",
            conclusion: "success",
          },
        ],
      })
    }
    assert.fail(`unexpected URL ${url}`)
  })
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    fetchImpl,
    token: "secret-token",
    run: async (command, args, options) => {
      runCalls.push([command, args, options])
      return `${REVIEWED_COMMIT}\n`
    },
  })

  assert.deepEqual(await reader.readReviewedMergeAuthority(REVIEWED_COMMIT), {
    mergeCommitSha: REVIEWED_COMMIT,
    mergeTreeSha: TREE,
    pullRequestNumber: 789,
    reviewedHeadSha: REVIEWED_HEAD,
    reviewedTreeSha: TREE,
    validateRunId: 987654321,
  })
  assert.deepEqual(
    runCalls.map(([command, args]) => [command, args]),
    [["git", ["rev-list", "--first-parent", "--max-count=1", "HEAD"]]],
  )
  assert.equal(calls.length, 7)
  assert.equal(
    calls.every(({ init }) => init.method === "GET" && init.redirect === "manual"),
    true,
  )
  assert.equal(
    calls.every(({ init }) => init.headers.Authorization === "Bearer secret-token"),
    true,
  )
})

test("reviewed authority rejects ambiguity, later main, unmerged PRs, tree drift, and failed CI", async (t) => {
  const cases = [
    ["multiple PRs", { pulls: [reviewedPull(), { ...reviewedPull(), number: 790 }] }],
    ["non-merged PR", { pulls: [{ ...reviewedPull(), merged_at: null }] }],
    [
      "wrong base",
      { pulls: [{ ...reviewedPull(), base: { ...reviewedPull().base, ref: "dev" } }] },
    ],
    ["later main", { mainSha: "e".repeat(40) }],
    ["unequal trees", { headTree: "e".repeat(40) }],
    ["failed validate", { checkConclusion: "failure" }],
    [
      "calendar-invalid merge timestamp",
      { pulls: [{ ...reviewedPull(), merged_at: "2026-02-31T00:00:00Z" }] },
    ],
    ["duplicate check ID", { duplicateCheckId: true }],
    ["duplicate CI run ID", { duplicateCiRunId: true }],
  ]
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const reader = reviewedReader(overrides)
      await assert.rejects(
        reader.readReviewedMergeAuthority(REVIEWED_COMMIT),
        (error) =>
          typeof error.code === "string" &&
          !JSON.stringify(error).includes("secret-token") &&
          !error.message.includes("remote body"),
      )
    })
  }
})

test("production reads bind repository, workflow, immutable setting, annotated tag, runs, and jobs", async () => {
  const calls = []
  const fetchImpl = routingFetch(calls, (url) => {
    if (url === BASE) return repositoryResponse()
    if (url === `${BASE}/git/ref/heads%2Fmain`) return jsonResponse(mainRef(REVIEWED_COMMIT))
    if (url === `${BASE}/actions/workflows/260503756`) {
      return jsonResponse({
        id: 260503756,
        path: ".github/workflows/release.yml",
        state: "disabled_manually",
      })
    }
    if (url === `${BASE}/immutable-releases`) return jsonResponse({ enabled: true })
    if (url === `${BASE}/git/ref/tags%2Fv0.8.22`) {
      return jsonResponse({
        ref: "refs/tags/v0.8.22",
        object: { type: "tag", sha: TAG_OBJECT },
      })
    }
    if (url === `${BASE}/git/tags/${TAG_OBJECT}`) {
      return jsonResponse({
        sha: TAG_OBJECT,
        tag: "v0.8.22",
        object: { type: "commit", sha: CANDIDATE_SHA },
      })
    }
    if (url === `${BASE}/actions/workflows/260503756/runs?per_page=100`) {
      return jsonResponse({ total_count: 1, workflow_runs: [releaseRun(10)] })
    }
    if (url === `${BASE}/actions/runs/10/jobs?filter=all&per_page=100`) {
      return jsonResponse({
        total_count: 1,
        jobs: [
          job(11, "publish-npm", {
            conclusion: "skipped",
            started_at: "2026-08-27T20:27:31Z",
            completed_at: "2026-08-27T20:27:30Z",
          }),
        ],
      })
    }
    assert.fail(`unexpected URL ${url}`)
  })
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    fetchImpl,
    run: async () => `${REVIEWED_COMMIT}\n`,
  })

  assert.deepEqual(await reader.readRepositoryState(), {
    id: 1210070282,
    nameWithOwner: "cacheplane/dawnai",
    mainSha: REVIEWED_COMMIT,
  })
  assert.deepEqual(await reader.readWorkflowState(), {
    id: 260503756,
    state: "disabled_manually",
  })
  assert.deepEqual(await reader.readImmutableReleases(), { enabled: true })
  assert.deepEqual(await reader.readCandidateTag(), {
    version: "0.8.22",
    commitSha: CANDIDATE_SHA,
    tagObjectSha: TAG_OBJECT,
  })
  assert.deepEqual(await reader.readReleaseRuns(), {
    runs: [
      {
        id: 10,
        runAttempt: 1,
        status: "completed",
        conclusion: "success",
        headSha: CANDIDATE_SHA,
        createdAt: "2026-09-01T00:00:00Z",
        startedAt: "2026-09-01T00:00:01Z",
        updatedAt: "2026-09-01T00:01:00Z",
      },
    ],
    candidateRuns: [
      {
        id: 10,
        runAttempt: 1,
        status: "completed",
        conclusion: "success",
        headSha: CANDIDATE_SHA,
        createdAt: "2026-09-01T00:00:00Z",
        startedAt: "2026-09-01T00:00:01Z",
        updatedAt: "2026-09-01T00:01:00Z",
      },
    ],
  })
  assert.equal((await reader.readCandidatePublishJobs(10, 1))[0].name, "publish-npm")
  assert.equal(
    calls.filter(({ url }) => url.includes("/actions/workflows/260503756/runs?")).length,
    1,
  )
})

test("repository reads reject string or drifted numeric IDs", async () => {
  for (const id of ["1210070282", 1210070281]) {
    const reader = createDuplicateDraftRecoveryReader({
      root: "/workspace",
      run: async () => `${REVIEWED_COMMIT}\n`,
      fetchImpl: async (url) => {
        if (url === BASE) {
          return jsonResponse({
            id,
            name: "dawnai",
            full_name: "cacheplane/dawnai",
            default_branch: "main",
            owner: { login: "cacheplane" },
          })
        }
        if (url === `${BASE}/git/ref/heads%2Fmain`) {
          return jsonResponse(mainRef(REVIEWED_COMMIT))
        }
        assert.fail(`unexpected URL ${url}`)
      },
    })
    await assert.rejects(
      reader.readRepositoryState(),
      (error) => error.code === "REPOSITORY_IDENTITY_CONFLICT",
    )
  }
})

test("Release and job observations reject malformed rows and incoherent terminal state", async () => {
  const malformedReleaseReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () => jsonResponse([{ id: 99 }]),
  })
  await assert.rejects(
    malformedReleaseReader.listCandidateReleases(),
    (error) => error.code === "RELEASE_LIST_MALFORMED",
  )

  const malformedJobReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse({
        total_count: 1,
        jobs: [{ ...job(11, "publish-npm"), started_at: null }],
      }),
  })
  await assert.rejects(
    malformedJobReader.readCandidatePublishJobs(10, 1),
    (error) => error.code === "CANDIDATE_JOBS_MALFORMED",
  )

  const malformedRunReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse({
        total_count: 1,
        workflow_runs: [{ ...releaseRun(10), run_started_at: null }],
      }),
  })
  await assert.rejects(
    malformedRunReader.readReleaseRuns(),
    (error) => error.code === "RELEASE_RUNS_MALFORMED",
  )
})

test("remote timestamps require calendar-valid canonical ISO forms", async () => {
  for (const timestamp of [
    "2026-02-31T00:00:00Z",
    "2025-02-29T12:00:00.000Z",
    "2026-01-01T24:00:00Z",
  ]) {
    const reader = createDuplicateDraftRecoveryReader({
      root: "/workspace",
      run: async () => `${REVIEWED_COMMIT}\n`,
      fetchImpl: async () =>
        jsonResponse({
          total_count: 1,
          jobs: [job(11, "publish-npm", { started_at: timestamp, completed_at: timestamp })],
        }),
    })
    await assert.rejects(
      reader.readCandidatePublishJobs(10, 1),
      (error) => error.code === "CANDIDATE_JOBS_MALFORMED",
    )
  }

  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse({
        total_count: 1,
        jobs: [
          job(11, "publish-npm", {
            started_at: "2024-02-29T23:59:59Z",
            completed_at: "2024-02-29T23:59:59.123Z",
          }),
        ],
      }),
  })
  assert.equal(
    (await reader.readCandidatePublishJobs(10, 1))[0].completedAt,
    "2024-02-29T23:59:59.123Z",
  )
})

test("GitHub responses cannot echo configured credentials through values or keys", async () => {
  const token = "secret-token"
  const jobsReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    token,
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse({
        total_count: 2,
        jobs: [
          job(11, "publish-npm", {
            status: "queued",
            conclusion: null,
            started_at: null,
            completed_at: null,
          }),
          job(12, `prepare-${token}`),
        ],
      }),
  })
  const jobs = await jobsReader.readCandidatePublishJobs(10, 1)
  assert.equal(JSON.stringify(jobs).includes(token), false)
  assert.equal(jobs[1].name, "prepare-[REDACTED]")

  const anonymousReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse({
        total_count: 2,
        jobs: [
          job(11, "publish-npm", {
            status: "queued",
            conclusion: null,
            started_at: null,
            completed_at: null,
          }),
          job(12, `prepare-${token}`),
        ],
      }),
  })
  assert.equal((await anonymousReader.readCandidatePublishJobs(10, 1))[1].name, `prepare-${token}`)

  const bodyReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    token,
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse({
        id: 260503756,
        path: ".github/workflows/release.yml",
        state: "disabled_manually",
        [token]: "echo",
      }),
  })
  await assert.rejects(bodyReader.readWorkflowState(), (error) => {
    assert.equal(error.code, "RELEASE_WORKFLOW_MALFORMED")
    assert.equal(JSON.stringify(error).includes(token), false)
    assert.equal(error.message.includes(token), false)
    return true
  })
})

test("candidate jobs bind the run and exhaust every attempt through the current attempt", async () => {
  const exactJobs = [
    job(21, "prepare"),
    job(22, "publish-npm", {
      conclusion: "skipped",
      started_at: "2026-08-27T20:27:31Z",
      completed_at: "2026-08-27T20:27:30Z",
    }),
    job(23, "prepare", { run_attempt: 2 }),
    job(24, "publish-npm", {
      run_attempt: 2,
      conclusion: "skipped",
      started_at: "2026-08-27T20:27:31Z",
      completed_at: "2026-08-27T20:27:31Z",
    }),
  ]
  const exactReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) => {
      assert.equal(url, `${BASE}/actions/runs/10/jobs?filter=all&per_page=100`)
      return jsonResponse({ total_count: exactJobs.length, jobs: exactJobs })
    },
  })
  assert.deepEqual(
    (await exactReader.readCandidatePublishJobs(10, 2)).map(({ runId, runAttempt, name }) => ({
      runId,
      runAttempt,
      name,
    })),
    [
      { runId: 10, runAttempt: 1, name: "prepare" },
      { runId: 10, runAttempt: 1, name: "publish-npm" },
      { runId: 10, runAttempt: 2, name: "prepare" },
      { runId: 10, runAttempt: 2, name: "publish-npm" },
    ],
  )

  for (const jobs of [
    [job(31, "publish-npm", { run_id: 11 }), job(32, "publish-npm", { run_attempt: 2 })],
    [job(41, "publish-npm", { run_attempt: 2 })],
    [job(42, "prepare"), job(43, "publish-npm", { run_attempt: 2 })],
    [job(51, "publish-npm"), job(52, "publish-npm"), job(53, "publish-npm", { run_attempt: 2 })],
    [
      job(61, "publish-npm"),
      job(62, "publish-npm", { run_attempt: 2 }),
      job(63, "publish-npm", { run_attempt: 3 }),
    ],
    [
      job(71, "publish-npm"),
      job(72, "publish-npm", { run_attempt: 2 }),
      job(72, "prepare", { run_attempt: 2 }),
    ],
  ]) {
    const reader = createDuplicateDraftRecoveryReader({
      root: "/workspace",
      run: async () => `${REVIEWED_COMMIT}\n`,
      fetchImpl: async () => jsonResponse({ total_count: jobs.length, jobs }),
    })
    await assert.rejects(
      reader.readCandidatePublishJobs(10, 2),
      (error) => error.code === "CANDIDATE_JOBS_MALFORMED",
    )
  }
})

test("skipped publish jobs preserve production scheduler timestamps without execution authority", async () => {
  for (const [startedAt, completedAt] of [
    ["2026-08-27T20:27:31Z", "2026-08-27T20:27:30Z"],
    ["2026-08-27T20:27:31Z", "2026-08-27T20:27:31Z"],
  ]) {
    const reader = createDuplicateDraftRecoveryReader({
      root: "/workspace",
      run: async () => `${REVIEWED_COMMIT}\n`,
      fetchImpl: async () =>
        jsonResponse({
          total_count: 1,
          jobs: [
            job(11, "publish-npm", {
              conclusion: "skipped",
              started_at: startedAt,
              completed_at: completedAt,
            }),
          ],
        }),
    })
    assert.deepEqual(await reader.readCandidatePublishJobs(10, 1), [
      {
        id: 11,
        runId: 10,
        runAttempt: 1,
        name: "publish-npm",
        status: "completed",
        conclusion: "skipped",
        startedAt,
        completedAt,
      },
    ])
  }
})

test("candidate Release discovery includes every marker-backed candidate history row", async () => {
  const wrongShaBody = attachingBody("e".repeat(40))
  const rows = [
    releaseRow(400000001, { tag_name: "v0.8.22", draft: false, immutable: true }),
    releaseRow(400000002, { body: wrongShaBody }),
    releaseRow(400000003, { body: wrongShaBody, draft: false, immutable: true }),
    releaseRow(400000004, { body: wrongShaBody, immutable: true }),
    releaseRow(400000005),
  ]
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () => jsonResponse(rows),
  })
  assert.deepEqual(
    (await reader.listCandidateReleases()).map(({ releaseId }) => releaseId),
    [400000001, 400000002, 400000003, 400000004],
  )
})

test("npm absence performs exact-version E404 plus package metadata confirmation", async () => {
  const calls = []
  const packageName = "@dawn-ai/sdk"
  const encoded = encodeURIComponent(packageName)
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: routingFetch(calls, (url) => {
      if (url === `https://registry.npmjs.org/${encoded}/0.8.22`) {
        return jsonResponse({ code: "E404", message: "secret remote body" }, 404)
      }
      if (url === `https://registry.npmjs.org/${encoded}`) {
        return jsonResponse({
          name: packageName,
          versions: { "0.8.21": packageVersion(packageName) },
        })
      }
      assert.fail(`unexpected URL ${url}`)
    }),
  })

  assert.deepEqual(await reader.readNpmAbsence(packageName), {
    name: packageName,
    version: "0.8.22",
    status: "absent",
  })
  assert.deepEqual(
    calls.map(({ url }) => url),
    [`https://registry.npmjs.org/${encoded}/0.8.22`, `https://registry.npmjs.org/${encoded}`],
  )
})

test("release snapshots read complete assets and required recovery bytes through safe redirects", async () => {
  const calls = []
  const releaseId = 379982100
  const originalBody = "canonical body\n"
  const archiveBytes = Buffer.from(originalBody)
  const archiveSha = sha256(archiveBytes)
  const archiveName = `dawn-v0.8.22-duplicate-${releaseId}-original-body-${archiveSha}.txt`
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: routingFetch(calls, (url) => {
      if (url === `${BASE}/releases/${releaseId}`) {
        return jsonResponse(releaseFixture({ releaseId, body: originalBody }))
      }
      if (url === `${BASE}/releases/${releaseId}/assets?per_page=100`) {
        return jsonResponse([
          asset(1, "base.tgz", Buffer.from("base")),
          asset(2, archiveName, archiveBytes),
        ])
      }
      if (url === `${BASE}/releases/assets/2`) {
        return binaryResponse(new Uint8Array(), 302, {
          location: "https://objects.githubusercontent.com/recovery-archive",
        })
      }
      if (url === "https://objects.githubusercontent.com/recovery-archive") {
        return binaryResponse(archiveBytes)
      }
      assert.fail(`unexpected URL ${url}`)
    }),
  })

  const snapshot = await reader.readReleaseSnapshot(releaseId, {
    expectedOriginalBody: originalBody,
  })
  assert.deepEqual(snapshot.evidenceAssets, ["body"])
  assert.equal(snapshot.assets[1].sha256, archiveSha)
  assert.equal(Object.hasOwn(snapshot.assets[1], "bytes"), false)
})

test("downloaded recovery evidence rejects configured credential bytes and preserves anonymous bytes", async () => {
  const releaseId = 379982100
  const token = "secret-token"
  const originalBody = "canonical body\n"
  const receiptBytes = Buffer.from(`{"credential":"${token}"}\n`)
  const receiptName = `dawn-v0.8.22-duplicate-${releaseId}-recovery-receipt.json`
  const createReader = (configuredToken) =>
    createDuplicateDraftRecoveryReader({
      root: "/workspace",
      ...(configuredToken === null ? {} : { token: configuredToken }),
      run: async () => `${REVIEWED_COMMIT}\n`,
      fetchImpl: async (url) => {
        if (url === `${BASE}/releases/${releaseId}`) {
          return jsonResponse(releaseFixture({ releaseId, body: originalBody }))
        }
        if (url === `${BASE}/releases/${releaseId}/assets?per_page=100`) {
          return jsonResponse([asset(1, receiptName, receiptBytes)])
        }
        if (url === `${BASE}/releases/assets/1`) return binaryResponse(receiptBytes)
        assert.fail(`unexpected URL ${url}`)
      },
    })

  await assert.rejects(
    createReader(token).readReleaseSnapshot(releaseId, { expectedOriginalBody: originalBody }),
    (error) => {
      assert.equal(error.code, "RECOVERY_ASSET_CREDENTIAL_CONFLICT")
      assert.equal(JSON.stringify(error).includes(token), false)
      assert.equal(error.message.includes(token), false)
      return true
    },
  )

  const anonymous = await createReader(null).readReleaseSnapshot(releaseId, {
    expectedOriginalBody: originalBody,
  })
  assert.equal(anonymous.assets[0].bytes, receiptBytes.toString("utf8"))
})

test("release snapshots reject duplicate asset IDs and name collisions", async () => {
  for (const field of ["id", "name"]) {
    const first = asset(1, "first.tgz", Buffer.from("first"))
    const second = asset(2, "second.tgz", Buffer.from("second"))
    second[field] = first[field]
    const reader = createDuplicateDraftRecoveryReader({
      root: "/workspace",
      run: async () => `${REVIEWED_COMMIT}\n`,
      fetchImpl: async (url) => {
        if (url === `${BASE}/releases/379982100`) {
          return jsonResponse(releaseFixture({ releaseId: 379982100, body: "canonical body\n" }))
        }
        if (url === `${BASE}/releases/379982100/assets?per_page=100`) {
          return jsonResponse([first, second])
        }
        assert.fail(`unexpected URL ${url}`)
      },
    })
    await assert.rejects(
      reader.readReleaseSnapshot(379982100, { expectedOriginalBody: "canonical body\n" }),
      (error) => error.code === "RELEASE_ASSETS_MALFORMED",
    )
  }
})

test("candidate Release listing rejects unsafe pagination and does not expose remote bodies in errors", async () => {
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    token: "secret-token",
    fetchImpl: async () =>
      jsonResponse([{ id: 1, body: "secret remote body" }], 200, {
        link: '<https://evil.example/releases?page=2>; rel="next"',
      }),
  })

  await assert.rejects(reader.listCandidateReleases(), (error) => {
    assert.equal(error.message.includes("secret-token"), false)
    assert.equal(error.message.includes("secret remote body"), false)
    return true
  })
})

test("Release workflow runs reject unsafe or incomplete pagination", async () => {
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) => {
      if (url.includes(`head_sha=${CANDIDATE_SHA}`)) {
        return jsonResponse({ total_count: 0, workflow_runs: [] })
      }
      return jsonResponse(
        {
          total_count: 101,
          workflow_runs: Array.from({ length: 100 }, (_, index) => releaseRun(index + 1)),
        },
        200,
        {
          link: `<https://evil.example/repos/cacheplane/dawnai/actions/workflows/260503756/runs?per_page=100&page=2>; rel="next"`,
        },
      )
    },
  })

  await assert.rejects(
    reader.readReleaseRuns(),
    (error) => error.code === "PAGINATION_DRIFT" && !error.message.includes("evil.example"),
  )
})

test("recovery pagination rejects same-origin page jumps and total-count drift", async () => {
  const jumpReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=3")
        ? jsonResponse([])
        : jsonResponse(
            Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
            200,
            { link: `<${BASE}/releases?per_page=100&page=3>; rel="next"` },
          ),
  })
  await assert.rejects(
    jumpReader.listCandidateReleases(),
    (error) => error.code === "PAGINATION_DRIFT",
  )

  const totalsReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=2")
        ? jsonResponse({ total_count: 102, jobs: [job(101, "publish-npm")] })
        : jsonResponse(
            {
              total_count: 101,
              jobs: Array.from({ length: 100 }, (_, index) => job(index + 1, "prepare")),
            },
            200,
            { link: `<${BASE}/actions/runs/10/jobs?filter=all&per_page=100&page=2>; rel="next"` },
          ),
  })
  await assert.rejects(
    totalsReader.readCandidatePublishJobs(10, 1),
    (error) => error.code === "PAGINATION_DRIFT",
  )
})

test("recovery pagination exhausts hidden Release, asset, and job pages", async () => {
  const releaseReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=2")
        ? jsonResponse([
            releaseRow(400000000, {
              tag_name: "v0.8.22",
              draft: false,
              immutable: true,
            }),
          ])
        : jsonResponse(
            Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
            200,
            { link: `<${BASE}/releases?per_page=100&page=2>; rel="next"` },
          ),
  })
  assert.deepEqual(
    (await releaseReader.listCandidateReleases()).map(({ releaseId }) => releaseId),
    [400000000],
  )

  const releaseId = 379982100
  const assetReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) => {
      if (url === `${BASE}/releases/${releaseId}`) {
        return jsonResponse(releaseFixture({ releaseId, body: "canonical body\n" }))
      }
      if (url.endsWith("page=2")) {
        return jsonResponse([asset(101, "hidden.tgz", Buffer.from("hidden"))])
      }
      return jsonResponse(
        Array.from({ length: 100 }, (_, index) =>
          asset(index + 1, `base-${index + 1}.tgz`, Buffer.from(`base-${index + 1}`)),
        ),
        200,
        { link: `<${BASE}/releases/${releaseId}/assets?per_page=100&page=2>; rel="next"` },
      )
    },
  })
  assert.equal(
    (await assetReader.readReleaseSnapshot(releaseId, { expectedOriginalBody: "canonical body\n" }))
      .assets.length,
    101,
  )

  const jobReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=2")
        ? jsonResponse({ total_count: 101, jobs: [job(101, "publish-npm")] })
        : jsonResponse(
            {
              total_count: 101,
              jobs: Array.from({ length: 100 }, (_, index) => job(index + 1, "prepare")),
            },
            200,
            { link: `<${BASE}/actions/runs/10/jobs?filter=all&per_page=100&page=2>; rel="next"` },
          ),
  })
  assert.equal((await jobReader.readCandidatePublishJobs(10, 1)).at(-1).name, "publish-npm")
})

test("terminal pagination rejects a later last page and accepts the current last page", async () => {
  const incompleteReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse(
        Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
        200,
        { link: `<${BASE}/releases?per_page=100&page=2>; rel="last"` },
      ),
  })
  await assert.rejects(
    incompleteReader.listCandidateReleases(),
    (error) => error.code === "PAGINATION_DRIFT",
  )

  const completeReader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=2")
        ? jsonResponse([releaseRow(101)], 200, {
            link: [
              `<${BASE}/releases?per_page=100&page=1>; rel="prev"`,
              `<${BASE}/releases?per_page=100&page=1>; rel="first"`,
            ].join(", "),
          })
        : jsonResponse(
            Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
            200,
            {
              link: [
                `<${BASE}/releases?per_page=100&page=2>; rel="next"`,
                `<${BASE}/releases?per_page=100&page=2>; rel="last"`,
              ].join(", "),
            },
          ),
  })
  assert.deepEqual(await completeReader.listCandidateReleases(), [])
})

test("pagination requires a stable advertised last page across the operation", async () => {
  for (const { firstLast, terminalLink } of [
    {
      firstLast: 3,
      terminalLink: `<${BASE}/releases?per_page=100&page=2>; rel="last"`,
    },
    { firstLast: 3, terminalLink: null },
  ]) {
    const reader = createDuplicateDraftRecoveryReader({
      root: "/workspace",
      run: async () => `${REVIEWED_COMMIT}\n`,
      fetchImpl: async (url) =>
        url.endsWith("page=2")
          ? jsonResponse(
              [releaseRow(101)],
              200,
              terminalLink === null ? {} : { link: terminalLink },
            )
          : jsonResponse(
              Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
              200,
              {
                link: [
                  `<${BASE}/releases?per_page=100&page=2>; rel="next"`,
                  `<${BASE}/releases?per_page=100&page=${firstLast}>; rel="last"`,
                ].join(", "),
              },
            ),
    })
    await assert.rejects(
      reader.listCandidateReleases(),
      (error) => error.code === "PAGINATION_DRIFT",
    )
  }
})

test("Release pagination rejects a repeated unrelated ID on a later page", async () => {
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=2")
        ? jsonResponse([releaseRow(50)], 200, {
            link: `<${BASE}/releases?per_page=100&page=2>; rel="last"`,
          })
        : jsonResponse(
            Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
            200,
            {
              link: [
                `<${BASE}/releases?per_page=100&page=2>; rel="next"`,
                `<${BASE}/releases?per_page=100&page=2>; rel="last"`,
              ].join(", "),
            },
          ),
  })
  await assert.rejects(reader.listCandidateReleases(), (error) => error.code === "PAGINATION_DRIFT")
})

test("recovery pagination enforces one cumulative response-byte budget", async () => {
  const pages = [
    Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
    Array.from({ length: 100 }, (_, index) => releaseRow(index + 101)),
  ]
  const pageBytes = Buffer.byteLength(JSON.stringify(pages[0]))
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    maxResponseBytes: pageBytes + 100,
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) =>
      url.endsWith("page=2")
        ? jsonResponse(pages[1])
        : jsonResponse(pages[0], 200, {
            link: `<${BASE}/releases?per_page=100&page=2>; rel="next"`,
          }),
  })
  await assert.rejects(reader.listCandidateReleases(), (error) => /LIMIT|LARGE/u.test(error.code))
})

test("recovery pagination enforces one cumulative operation deadline", async () => {
  const clock = [0, 0, 10]
  const reader = createDuplicateDraftRecoveryReader({
    root: "/workspace",
    timeoutMs: 10,
    now: () => clock.shift() ?? 10,
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async () =>
      jsonResponse(
        Array.from({ length: 100 }, (_, index) => releaseRow(index + 1)),
        200,
        { link: `<${BASE}/releases?per_page=100&page=2>; rel="next"` },
      ),
  })
  await assert.rejects(
    reader.listCandidateReleases(),
    (error) => error.code === "RELEASE_LIST_UNAVAILABLE",
  )
})

function reviewedReader({
  pulls = [reviewedPull()],
  mainSha = REVIEWED_COMMIT,
  headTree = TREE,
  checkConclusion = "success",
  duplicateCheckId = false,
  duplicateCiRunId = false,
} = {}) {
  return createDuplicateDraftRecoveryReader({
    root: "/workspace",
    token: "secret-token",
    run: async () => `${REVIEWED_COMMIT}\n`,
    fetchImpl: async (url) => {
      if (url === BASE) return repositoryResponse()
      if (url === `${BASE}/git/ref/heads%2Fmain`) return jsonResponse(mainRef(mainSha))
      if (url === `${BASE}/commits/${REVIEWED_COMMIT}/pulls?per_page=2`) {
        return jsonResponse(pulls)
      }
      if (url === `${BASE}/git/commits/${REVIEWED_COMMIT}`) {
        return jsonResponse({ sha: REVIEWED_COMMIT, tree: { sha: TREE } })
      }
      if (url === `${BASE}/git/commits/${REVIEWED_HEAD}`) {
        return jsonResponse({ sha: REVIEWED_HEAD, tree: { sha: headTree } })
      }
      if (url === `${BASE}/commits/${REVIEWED_HEAD}/check-runs?per_page=100`) {
        return jsonResponse({
          total_count: duplicateCheckId ? 2 : 1,
          check_runs: [
            {
              id: 1,
              name: "validate",
              head_sha: REVIEWED_HEAD,
              status: "completed",
              conclusion: checkConclusion,
              check_suite: { id: 77 },
            },
            ...(duplicateCheckId
              ? [
                  {
                    id: 1,
                    name: "unrelated",
                    head_sha: REVIEWED_HEAD,
                    status: "completed",
                    conclusion: "success",
                    check_suite: { id: 78 },
                  },
                ]
              : []),
          ],
        })
      }
      if (url === `${BASE}/actions/workflows/ci.yml/runs?head_sha=${REVIEWED_HEAD}&per_page=100`) {
        return jsonResponse({
          total_count: duplicateCiRunId ? 2 : 1,
          workflow_runs: [
            {
              id: 2,
              run_attempt: 1,
              name: "CI",
              path: ".github/workflows/ci.yml",
              head_sha: REVIEWED_HEAD,
              head_branch: "reviewed-recovery",
              event: "pull_request",
              check_suite_id: 77,
              status: "completed",
              conclusion: checkConclusion,
            },
            ...(duplicateCiRunId
              ? [
                  {
                    id: 2,
                    run_attempt: 1,
                    name: "Unrelated",
                    path: ".github/workflows/ci.yml",
                    head_sha: REVIEWED_HEAD,
                    head_branch: "reviewed-recovery",
                    event: "workflow_dispatch",
                    check_suite_id: 78,
                    status: "completed",
                    conclusion: "success",
                  },
                ]
              : []),
          ],
        })
      }
      assert.fail(`unexpected URL ${url}`)
    },
  })
}

function reviewedPull() {
  return {
    number: 789,
    state: "closed",
    merged_at: "2026-09-01T00:00:00Z",
    merge_commit_sha: REVIEWED_COMMIT,
    base: {
      ref: "main",
      repo: { id: 1210070282, full_name: "cacheplane/dawnai" },
    },
    head: { sha: REVIEWED_HEAD },
  }
}

function repositoryResponse() {
  return jsonResponse({
    id: 1210070282,
    name: "dawnai",
    full_name: "cacheplane/dawnai",
    default_branch: "main",
    owner: { login: "cacheplane" },
  })
}

function mainRef(sha) {
  return { ref: "refs/heads/main", object: { type: "commit", sha } }
}

function releaseRun(id) {
  return {
    id,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    head_sha: CANDIDATE_SHA,
    path: ".github/workflows/release.yml",
    created_at: "2026-09-01T00:00:00Z",
    run_started_at: "2026-09-01T00:00:01Z",
    updated_at: "2026-09-01T00:01:00Z",
  }
}

function job(id, name, overrides = {}) {
  return {
    id,
    run_id: 10,
    run_attempt: 1,
    name,
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-01T00:00:00Z",
    completed_at: "2026-09-01T00:01:00Z",
    ...overrides,
  }
}

function candidateTagRef() {
  return {
    ref: "refs/tags/v0.8.22",
    object: { type: "tag", sha: TAG_OBJECT },
  }
}

function candidateTagObject() {
  return {
    sha: TAG_OBJECT,
    tag: "v0.8.22",
    object: { type: "commit", sha: CANDIDATE_SHA },
  }
}

function writerRelease(body) {
  return {
    id: DUPLICATE_ID,
    tag_name: DUPLICATE_TAG,
    name: WRITER_TITLE,
    body,
    draft: true,
    prerelease: false,
    immutable: false,
    target_commitish: "main",
  }
}

function writerFixture() {
  const manifest = writerManifest()
  const manifestSha256 = sha256(canonicalManifestBytes(manifest))
  const subjects = [
    { name: "manifest.json", sha256: manifestSha256 },
    ...manifest.packages.map((pkg) => ({ name: pkg.filename, sha256: pkg.sha256 })),
  ]
  const normalizedAssets = [
    { id: 1, name: "release-record.json", sha256: "e".repeat(64) },
    ...subjects.map(({ name, sha256: digest }, index) => ({
      id: index + 2,
      name,
      sha256: digest,
    })),
    ...subjects.map(({ name }, index) => ({
      id: subjects.length + index + 2,
      name: `${name}.intoto.jsonl`,
      sha256: "f".repeat(64),
    })),
  ]
  assert.equal(normalizedAssets.length, 45)
  const baseAssetSetSha256 = sha256(
    Buffer.from(
      `${JSON.stringify(normalizedAssets.map(({ name, sha256: digest }) => ({ name, sha256: digest })))}\n`,
    ),
  )
  const marker = {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 2,
    phase: "ESCROWED",
    version: "0.8.22",
    commitSha: CANDIDATE_SHA,
    tag: "v0.8.22",
    manifestSha256,
    releaseRecordSha256: "e".repeat(64),
    baseAssetSetSha256,
    attestationSet: {
      repository: "cacheplane/dawnai",
      workflow: ".github/workflows/release.yml",
      sourceRef: "refs/tags/v0.8.22",
      commitSha: CANDIDATE_SHA,
      workflowRunId: 3,
      runAttempt: 1,
      subjects: subjects.map(({ name, sha256: digest }) => ({
        subjectName: name,
        subjectSha256: digest,
        bundleName: `${name}.intoto.jsonl`,
        bundleSha256: "f".repeat(64),
      })),
    },
    npmEvidenceSha256: null,
    smoke: null,
    audit: null,
    abandonmentSha256: null,
  }
  const body = canonicalReleaseBody({ marker, manifest })
  const archiveBytes = Buffer.from(body)
  const archiveSha256 = sha256(archiveBytes)
  const archiveName = originalBodyAssetName(DUPLICATE_ID, archiveSha256)
  const receiptName = recoveryReceiptAssetName(DUPLICATE_ID)
  const receiptBytes = canonicalRecoveryReceipt({
    repository: "cacheplane/dawnai",
    version: "0.8.22",
    candidateSha: CANDIDATE_SHA,
    recoveryCommit: REVIEWED_COMMIT,
    canonicalReleaseId: 379991871,
    duplicateReleaseId: DUPLICATE_ID,
    originalBodySha256: archiveSha256,
    baseAssetSetSha256,
    archiveAsset: { name: archiveName, sha256: archiveSha256 },
  })
  const receiptSha256 = sha256(receiptBytes)
  const notice = canonicalRecoveryNotice({
    repository: "cacheplane/dawnai",
    version: "0.8.22",
    canonicalReleaseId: 379991871,
    duplicateReleaseId: DUPLICATE_ID,
    originalBodySha256: archiveSha256,
    archiveAssetName: archiveName,
    receiptAssetName: receiptName,
    receiptSha256,
  })
  const rawAssets = normalizedAssets.map(({ id, name, sha256: digest }) => ({
    id,
    name,
    digest: `sha256:${digest}`,
    size: 1,
  }))
  const archiveRawAsset = asset(1001, archiveName, archiveBytes)
  const receiptRawAsset = asset(1002, receiptName, receiptBytes)
  const snapshotBase = {
    releaseId: DUPLICATE_ID,
    tagName: DUPLICATE_TAG,
    body,
    marker: parseReleaseMarker(body),
    assets: normalizedAssets,
  }
  const archiveAsset = { id: archiveRawAsset.id, name: archiveName, sha256: archiveSha256 }
  const receiptAsset = {
    id: receiptRawAsset.id,
    name: receiptName,
    sha256: receiptSha256,
    bytes: receiptBytes.toString("utf8"),
  }
  return {
    body,
    rawAssets,
    archiveBytes,
    archiveSha256,
    archiveName,
    archiveRawAsset,
    receiptBytes,
    receiptRawAsset,
    notice,
    untouchedSnapshot: { ...snapshotBase, evidenceAssets: [] },
    bodyArchivedSnapshot: {
      ...snapshotBase,
      assets: [...normalizedAssets, archiveAsset],
      evidenceAssets: ["body"],
    },
    receiptArchivedSnapshot: {
      ...snapshotBase,
      assets: [...normalizedAssets, archiveAsset, receiptAsset],
      evidenceAssets: ["body", "receipt"],
    },
  }
}

function writerManifest() {
  const packages = CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => {
    const filename = `${name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name}-0.8.22.tgz`
    const bytes = Buffer.from(`package:${name}`)
    const sha512 = createHash("sha512").update(bytes).digest("hex")
    return {
      name,
      version: "0.8.22",
      filename,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      sha512,
      npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
      access: "public",
    }
  })
  return {
    schemaVersion: 1,
    version: "0.8.22",
    commitSha: CANDIDATE_SHA,
    ci: { workflow: "CI", runId: 1, runAttempt: 1 },
    artifact: {
      name: `release-v0.8.22-${CANDIDATE_SHA.slice(0, 12)}`,
      prepareRunId: 2,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages,
  }
}

function attachingBody(commitSha) {
  return canonicalReleaseBody({
    marker: {
      schemaVersion: 1,
      epoch: "fixed-group-v1",
      revision: 1,
      phase: "ATTACHING",
      version: "0.8.22",
      commitSha,
      tag: "v0.8.22",
      manifestSha256: "a".repeat(64),
      releaseRecordSha256: "b".repeat(64),
      baseAssetSetSha256: null,
      attestationSet: null,
      npmEvidenceSha256: null,
      smoke: null,
      audit: null,
      abandonmentSha256: null,
    },
    manifest: null,
  })
}

function packageVersion(name) {
  return { name, version: "0.8.21" }
}

function releaseFixture({ releaseId, body }) {
  return {
    id: releaseId,
    tag_name: "untagged-a13939767dd2419ade01",
    body,
    draft: true,
    prerelease: false,
    immutable: false,
    target_commitish: "main",
  }
}

function releaseRow(id, overrides = {}) {
  return {
    id,
    tag_name: `untagged-unrelated-${id}`,
    body: null,
    draft: true,
    prerelease: false,
    immutable: false,
    target_commitish: "main",
    ...overrides,
  }
}

function asset(id, name, bytes) {
  return {
    id,
    name,
    digest: `sha256:${sha256(bytes)}`,
    size: bytes.byteLength,
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function routingFetch(calls, route) {
  return async (url, init) => {
    calls.push({ url, init })
    return route(url, init)
  }
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function binaryResponse(value, status = 200, headers = {}) {
  return new Response(value, {
    status,
    headers: { "content-type": "application/octet-stream", ...headers },
  })
}
