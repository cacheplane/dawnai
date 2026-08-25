import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { composeGitHubEffects, createGitHubWriter } from "../adapters/github-write.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { releaseBodySha256 } from "../metadata.mjs"
import { canonicalAuditResultBytes } from "../terminal-records.mjs"

const OWNER = "cacheplane"
const REPO = "dawnai"
const VERSION = "0.8.22"
const TAG = `v${VERSION}`
const SHA = "0123456789abcdef0123456789abcdef01234567"
const TAG_SHA = "abcdef0123456789abcdef0123456789abcdef01"
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`
const WRITER_METHODS = [
  "createDraftRelease",
  "dispatchWorkflowAtRef",
  "publishReleaseIfCurrent",
  "updateDraftReleaseIfCurrent",
  "uploadAssetIfAbsentAndEqual",
]

test("GitHub writer exposes exactly five capabilities and composes a frozen boundary", () => {
  const reader = exactReader()
  const writer = createGitHubWriter({ owner: OWNER, repo: REPO, reader, fetchImpl: assert.fail })
  assert.deepEqual(Object.keys(writer).sort(), WRITER_METHODS)
  for (const forbidden of ["request", "delete", "overwrite", "force", "createTag"]) {
    assert.equal(Object.hasOwn(writer, forbidden), false)
  }
  const effects = composeGitHubEffects({ reader, writer })
  assert.deepEqual(Object.keys(effects), ["reader", "writer"])
  assert.equal(Object.isFrozen(effects), true)
})

test("draft creation proves an annotated tag and re-reads the exact created draft", async () => {
  const calls = []
  const reader = exactReader({
    releases: [],
    release: {
      id: 7,
      tag_name: TAG,
      name: `Dawn v${VERSION}`,
      body: "candidate body",
      draft: true,
      immutable: false,
    },
  })
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ id: 7 }, 201)
    },
  })

  const result = await writer.createDraftRelease({
    tag: TAG,
    targetSha: SHA,
    title: `Dawn v${VERSION}`,
    body: "candidate body",
  })
  assert.deepEqual(result, {
    releaseId: 7,
    status: "created",
    bodySha256: releaseBodySha256("candidate body"),
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API_BASE}/releases`)
  assert.equal(calls[0].init.method, "POST")
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    tag_name: TAG,
    name: `Dawn v${VERSION}`,
    body: "candidate body",
    draft: true,
    generate_release_notes: false,
  })
  assert.equal(Object.hasOwn(JSON.parse(calls[0].init.body), "target_commitish"), false)
})

test("writer rejects lightweight tags and stale body CAS without mutation", async () => {
  let mutations = 0
  const lightweight = exactReader({ tagType: "commit" })
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: lightweight,
    fetchImpl: async () => {
      mutations += 1
      return jsonResponse({}, 200)
    },
  })
  await assert.rejects(
    writer.createDraftRelease({ tag: TAG, targetSha: SHA, title: "title", body: "body" }),
    /annotated|tag/iu,
  )
  assert.equal(mutations, 0)

  const staleWriter = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      release: {
        id: 7,
        tag_name: TAG,
        name: "old",
        body: "old body",
        draft: true,
        immutable: false,
      },
    }),
    fetchImpl: async () => {
      mutations += 1
      return jsonResponse({}, 200)
    },
  })
  await assert.rejects(
    staleWriter.updateDraftReleaseIfCurrent({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      expectedBodySha256: "f".repeat(64),
      title: "new",
      body: "new body",
    }),
    /stale|body|compare/iu,
  )
  assert.equal(mutations, 0)
})

test("writer revalidates an annotated tag before returning an existing-resource no-op", async () => {
  let tagReads = 0
  const reader = exactReader({
    tagTargetSha() {
      tagReads += 1
      return tagReads === 1 ? SHA : "f".repeat(40)
    },
  })
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader,
    fetchImpl: assert.fail,
  })

  await assert.rejects(
    writer.createDraftRelease({
      tag: TAG,
      targetSha: SHA,
      title: `Dawn v${VERSION}`,
      body: "candidate body",
    }),
    /annotated|tag|target|commit/iu,
  )
  assert.equal(tagReads, 2)
})

test("asset uploads accept only absent bytes or downloaded byte equality", async () => {
  const bytes = Buffer.from("exact asset")
  const digest = sha256(bytes)
  let mutations = 0
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      release: draftRelease("body"),
      assets: [{ id: 90, name: "manifest.json" }],
      downloads: new Map([[90, bytes]]),
    }),
    fetchImpl: async () => {
      mutations += 1
      return jsonResponse({}, 201)
    },
  })
  assert.deepEqual(
    await writer.uploadAssetIfAbsentAndEqual({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      name: "manifest.json",
      bytes,
      sha256: digest,
    }),
    { assetId: 90, status: "existing", sha256: digest },
  )
  assert.equal(mutations, 0)

  const different = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      release: draftRelease("body"),
      assets: [{ id: 90, name: "manifest.json" }],
      downloads: new Map([[90, Buffer.from("different")]]),
    }),
    fetchImpl: assert.fail,
  })
  await assert.rejects(
    different.uploadAssetIfAbsentAndEqual({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      name: "manifest.json",
      bytes,
      sha256: digest,
    }),
    /different|digest|bytes/iu,
  )
})

test("asset uploads admit valid tarballs above the JSON request limit", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 0x61)
  const digest = sha256(bytes)
  const assets = []
  const downloads = new Map()
  let uploads = 0
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({ release: draftRelease("body"), assets, downloads }),
    fetchImpl: async (_url, init) => {
      uploads += 1
      assert.equal(init.body.byteLength, bytes.byteLength)
      assets.push({ id: 90, name: "package-01.tgz" })
      downloads.set(90, bytes)
      return jsonResponse({ id: 90 }, 201)
    },
  })

  assert.deepEqual(
    await writer.uploadAssetIfAbsentAndEqual({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      name: "package-01.tgz",
      bytes,
      sha256: digest,
    }),
    { assetId: 90, status: "uploaded", sha256: digest },
  )
  assert.equal(uploads, 1)
})

test("asset uploads reject unknown namespaces and bytes above the exact asset-class limit", async () => {
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({ release: draftRelease("body") }),
    fetchImpl: assert.fail,
  })
  const input = {
    releaseId: 7,
    tag: TAG,
    targetSha: SHA,
    name: "oversized.tgz",
    bytes: Buffer.alloc(RELEASE_PAYLOAD_LIMITS.tarballBytes + 1),
    sha256: "0".repeat(64),
  }

  await assert.rejects(writer.uploadAssetIfAbsentAndEqual(input), /byte|limit|tarball/iu)
  await assert.rejects(
    writer.uploadAssetIfAbsentAndEqual({
      ...input,
      name: "controller-debug.intoto.jsonl",
      bytes: Buffer.alloc(0),
      sha256: sha256(Buffer.alloc(0)),
    }),
    /namespace|allowed|asset/iu,
  )
})

test("workflow dispatch uses the exact 2026 API contract and direct HTTP 200 receipt", async () => {
  const calls = []
  const runId = 123456789
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader(),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse(
        {
          workflow_run_id: runId,
          run_url: `${API_BASE}/actions/runs/${runId}`,
          html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${runId}`,
        },
        200,
      )
    },
  })
  const receipt = await writer.dispatchWorkflowAtRef({
    workflow: ".github/workflows/published-artifact-verify.yml",
    ref: TAG,
    inputs: { version: VERSION, commitSha: SHA, manifestSha256: "a".repeat(64) },
  })
  assert.deepEqual(receipt, {
    workflowRunId: runId,
    runUrl: `${API_BASE}/actions/runs/${runId}`,
    htmlUrl: `https://github.com/${OWNER}/${REPO}/actions/runs/${runId}`,
  })
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    `${API_BASE}/actions/workflows/.github%2Fworkflows%2Fpublished-artifact-verify.yml/dispatches`,
  )
  assert.equal(calls[0].init.headers["X-GitHub-Api-Version"], "2026-03-10")
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ref: TAG,
    inputs: { version: VERSION, commitSha: SHA, manifestSha256: "a".repeat(64) },
  })
  assert.equal(Object.hasOwn(JSON.parse(calls[0].init.body), "return_run_details"), false)

  for (const status of [202, 204]) {
    const invalid = createGitHubWriter({
      owner: OWNER,
      repo: REPO,
      reader: exactReader(),
      fetchImpl: async () => jsonResponse({}, status),
    })
    await assert.rejects(
      invalid.dispatchWorkflowAtRef({
        workflow: ".github/workflows/release.yml",
        ref: TAG,
        inputs: {},
      }),
      /HTTP 200|dispatch/iu,
    )
  }
})

test("writer bounds response time, content type, redirects, and output bytes", async () => {
  const dispatch = (writer) =>
    writer.dispatchWorkflowAtRef({
      workflow: ".github/workflows/release.yml",
      ref: TAG,
      inputs: {},
    })
  const delayedBody = JSON.stringify({
    workflow_run_id: 1,
    run_url: `${API_BASE}/actions/runs/1`,
    html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`,
  })
  const delayed = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader(),
    timeoutMs: 5,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            this.timer = setTimeout(() => {
              controller.enqueue(Buffer.from(delayedBody))
              controller.close()
            }, 30)
          },
          cancel() {
            clearTimeout(this.timer)
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  })
  await assert.rejects(dispatch(delayed), /timed out/iu)

  const wrongType = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader(),
    fetchImpl: async () =>
      new Response(delayedBody, { status: 200, headers: { "content-type": "text/plain" } }),
  })
  await assert.rejects(dispatch(wrongType), /content.type|JSON/iu)

  const redirect = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader(),
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: API_BASE } }),
  })
  await assert.rejects(dispatch(redirect), /redirect/iu)

  const oversized = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader(),
    maxResponseBytes: 8,
    fetchImpl: async () => jsonResponse({ too: "large" }, 200),
  })
  await assert.rejects(dispatch(oversized), /byte limit/iu)
})

test("publication changes only draft state and requires immutable unchanged re-read", async () => {
  const fixture = verifiedPublicationFixture()
  const calls = []
  let releaseReads = 0
  const reader = exactReader({
    release() {
      releaseReads += 1
      return {
        id: 7,
        tag_name: TAG,
        name: `Dawn v${VERSION}`,
        body: fixture.body,
        draft: releaseReads === 1,
        immutable: releaseReads > 1,
      }
    },
    assets: fixture.assets.map((asset, index) => ({ id: index + 1, name: asset.name })),
    downloads: new Map(fixture.assets.map((asset, index) => [index + 1, asset.bytes])),
  })
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ id: 7, draft: false }, 200)
    },
  })

  const result = await writer.publishReleaseIfCurrent({
    releaseId: 7,
    tag: TAG,
    targetSha: SHA,
    expectedBodySha256: releaseBodySha256(fixture.body),
    assets: fixture.assets.map(({ name, digest }) => ({ name, sha256: digest })),
  })
  assert.deepEqual(result, { releaseId: 7, status: "published", immutable: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API_BASE}/releases/7`)
  assert.deepEqual(JSON.parse(calls[0].init.body), { draft: false })
})

test("publication rejects a marker whose immutable base digest does not match its assets", async () => {
  const fixture = verifiedPublicationFixture()
  const wrongMarker = { ...fixture.marker, baseAssetSetSha256: "f".repeat(64) }
  const wrongBody = markerBody(wrongMarker)
  let mutations = 0
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      release: draftRelease(wrongBody),
      assets: fixture.assets.map((asset, index) => ({ id: index + 1, name: asset.name })),
      downloads: new Map(fixture.assets.map((asset, index) => [index + 1, asset.bytes])),
    }),
    fetchImpl: async () => {
      mutations += 1
      return jsonResponse({}, 200)
    },
  })

  await assert.rejects(
    writer.publishReleaseIfCurrent({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      expectedBodySha256: releaseBodySha256(wrongBody),
      assets: fixture.assets.map(({ name, digest }) => ({ name, sha256: digest })),
    }),
    /base|asset.set|digest/iu,
  )
  assert.equal(mutations, 0)
})

test("publication rejects a malformed historical audit attempt before mutation", async () => {
  const fixture = verifiedPublicationFixture()
  const invalid = {
    name: "audit-attempt-100-1.json",
    bytes: Buffer.from("not an audit receipt"),
  }
  const assets = [...fixture.assets, { ...invalid, digest: sha256(invalid.bytes) }]
  let releaseReads = 0
  let mutations = 0
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      release() {
        releaseReads += 1
        return {
          ...draftRelease(fixture.body),
          draft: releaseReads === 1,
          immutable: releaseReads > 1,
        }
      },
      assets: assets.map((asset, index) => ({ id: index + 1, name: asset.name })),
      downloads: new Map(assets.map((asset, index) => [index + 1, asset.bytes])),
    }),
    fetchImpl: async () => {
      mutations += 1
      return jsonResponse({ id: 7, draft: false }, 200)
    },
  })

  await assert.rejects(
    writer.publishReleaseIfCurrent({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      expectedBodySha256: releaseBodySha256(fixture.body),
      assets: assets.map(({ name, digest }) => ({ name, sha256: digest })),
    }),
    /audit|canonical|receipt/iu,
  )
  assert.equal(mutations, 0)
})

function exactReader({
  releases,
  release = draftRelease("candidate body"),
  assets = [],
  downloads = new Map(),
  tagType = "tag",
  tagTargetSha = SHA,
} = {}) {
  const getReleaseValue = () => (typeof release === "function" ? release() : release)
  return Object.freeze({
    getRef: async () => present("ref", { object: { type: tagType, sha: TAG_SHA } }),
    getGitTag: async () =>
      present("git-tag", {
        tag: TAG,
        object: {
          type: "commit",
          sha: typeof tagTargetSha === "function" ? tagTargetSha() : tagTargetSha,
        },
      }),
    listReleases: async () =>
      present("releases", releases ?? [{ id: 7, tag_name: TAG, draft: true }]),
    getRelease: async () => present("release", getReleaseValue()),
    listReleaseAssets: async () => present("release-assets", assets),
    downloadReleaseAsset: async ({ assetId }) => {
      const bytes = downloads.get(assetId)
      assert.ok(bytes, `missing test bytes for asset ${assetId}`)
      return {
        status: "PRESENT",
        operation: "release-asset-download",
        httpStatus: 200,
        code: null,
        contentBase64: Buffer.from(bytes).toString("base64"),
      }
    },
  })
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function draftRelease(body) {
  return {
    id: 7,
    tag_name: TAG,
    name: `Dawn v${VERSION}`,
    body,
    draft: true,
    immutable: false,
  }
}

function verifiedPublicationFixture() {
  const subjects = [
    { name: "manifest.json", bytes: Buffer.from("manifest") },
    ...Array.from({ length: 21 }, (_unused, index) => ({
      name: `package-${String(index + 1).padStart(2, "0")}.tgz`,
      bytes: Buffer.from(`package-${index}`),
    })),
  ].map((subject) => ({ ...subject, digest: sha256(subject.bytes) }))
  const bundles = subjects.map((subject, index) => ({
    name: `${subject.name}.intoto.jsonl`,
    bytes: Buffer.from(`bundle-${index}`),
  }))
  const attestationSubjects = subjects.map((subject, index) => ({
    subjectName: subject.name,
    subjectSha256: subject.digest,
    bundleName: bundles[index].name,
    bundleSha256: sha256(bundles[index].bytes),
  }))
  const releaseRecord = { name: "release-record.json", bytes: Buffer.from("record") }
  const baseAssets = [releaseRecord, ...subjects, ...bundles].map((asset) => ({
    ...asset,
    digest: sha256(asset.bytes),
  }))
  const auditBytes = canonicalAuditResultBytes({
    schemaVersion: 1,
    version: VERSION,
    commitSha: SHA,
    manifestSha256: subjects[0].digest,
    workflowRunId: 101,
    runAttempt: 1,
    startedAt: "2026-08-24T01:00:00Z",
    finishedAt: "2026-08-24T01:01:00Z",
    checks: [{ name: "published-artifacts", conclusion: "success", detail: "verified" }],
    conclusion: "success",
  })
  const auditDigest = sha256(auditBytes)
  const marker = {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 7,
    phase: "AUDIT_VERIFIED",
    version: VERSION,
    commitSha: SHA,
    tag: TAG,
    manifestSha256: subjects[0].digest,
    releaseRecordSha256: sha256(releaseRecord.bytes),
    baseAssetSetSha256: sha256(
      Buffer.from(
        `${JSON.stringify(baseAssets.map(({ name, digest }) => ({ name, sha256: digest })))}\n`,
      ),
    ),
    attestationSet: {
      repository: `${OWNER}/${REPO}`,
      workflow: ".github/workflows/release.yml",
      sourceRef: `refs/tags/${TAG}`,
      commitSha: SHA,
      workflowRunId: 100,
      runAttempt: 1,
      subjects: attestationSubjects,
    },
    npmEvidenceSha256: "4".repeat(64),
    smokeAggregateSha256: "5".repeat(64),
    audit: {
      workflow: ".github/workflows/published-artifact-verify.yml",
      workflowRunId: 101,
      runUrl: `${API_BASE}/actions/runs/101`,
      htmlUrl: `https://github.com/${OWNER}/${REPO}/actions/runs/101`,
      runAttempt: 1,
      attemptAssetName: "audit-attempt-101-1.json",
      attemptSha256: auditDigest,
      canonicalSha256: auditDigest,
      conclusion: "success",
    },
    abandonmentSha256: null,
  }
  const body = markerBody(marker)
  const bytesByName = new Map([
    ...baseAssets.map((asset) => [asset.name, asset.bytes]),
    ["audit-attempt-101-1.json", auditBytes],
    ["audit-result.json", auditBytes],
  ])
  return {
    body,
    marker,
    assets: [...bytesByName].map(([name, bytes]) => ({ name, bytes, digest: sha256(bytes) })),
  }
}

function markerBody(marker) {
  return `# release\n\n<!-- DAWN_RELEASE_CONTROLLER_MARKER\n${JSON.stringify(canonicalize(marker))}\nEND_DAWN_RELEASE_CONTROLLER_MARKER -->\n`
}

function jsonResponse(body, status) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}
