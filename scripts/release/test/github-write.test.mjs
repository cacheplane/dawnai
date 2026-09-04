import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { composeGitHubEffects, createGitHubWriter } from "../adapters/github-write.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { releaseBodySha256 } from "../metadata.mjs"
import { canonicalSmokeResultBytes } from "../smoke-result.mjs"
import { canonicalAuditResultBytes } from "../terminal-records.mjs"
import { SMOKE_LANES, smokeDescriptor } from "./support/marker-observation.mjs"

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
      tag_name: "untagged-opaque",
      target_commitish: "main",
      prerelease: false,
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

test("draft creation discovers one exact mutable draft despite an opaque temporary tag", async () => {
  const fixture = verifiedPublicationFixture()
  const release = { ...draftRelease(fixture.body), tag_name: "untagged-opaque" }
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({ releases: [release], release }),
    fetchImpl: assert.fail,
  })

  assert.deepEqual(
    await writer.createDraftRelease({
      tag: TAG,
      targetSha: SHA,
      title: `Dawn v${VERSION}`,
      body: fixture.body,
    }),
    {
      releaseId: 7,
      status: "existing",
      bodySha256: releaseBodySha256(fixture.body),
    },
  )
})

test("draft creation reconciles one exact opaque-tag race and rejects ambiguous duplicates", async () => {
  const fixture = verifiedPublicationFixture()
  const release = { ...draftRelease(fixture.body), tag_name: "untagged-opaque" }
  let lists = 0
  const raced = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      releases() {
        lists += 1
        return lists === 1 ? [] : [release]
      },
      release,
    }),
    fetchImpl: async () => jsonResponse({}, 422),
  })

  assert.deepEqual(
    await raced.createDraftRelease({
      tag: TAG,
      targetSha: SHA,
      title: `Dawn v${VERSION}`,
      body: fixture.body,
    }),
    {
      releaseId: 7,
      status: "existing",
      bodySha256: releaseBodySha256(fixture.body),
    },
  )
  assert.equal(lists, 2)

  let mutations = 0
  const duplicate = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      releases: [release, { ...release, id: 8, tag_name: "untagged-other" }],
      release,
    }),
    fetchImpl: async () => {
      mutations += 1
      return jsonResponse({}, 201)
    },
  })
  await assert.rejects(
    duplicate.createDraftRelease({
      tag: TAG,
      targetSha: SHA,
      title: `Dawn v${VERSION}`,
      body: fixture.body,
    }),
    /duplicate|ambiguous/iu,
  )
  assert.equal(mutations, 0)
})

test("draft updates and asset uploads preserve tag verification around opaque-tag mutations", async () => {
  let updateTagReads = 0
  let body = "old body"
  const updateWriter = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      release: () => ({ ...draftRelease(body), tag_name: "untagged-opaque" }),
      tagTargetSha() {
        updateTagReads += 1
        return SHA
      },
    }),
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body).body
      return jsonResponse({ id: 7 }, 200)
    },
  })
  assert.deepEqual(
    await updateWriter.updateDraftReleaseIfCurrent({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      expectedBodySha256: releaseBodySha256("old body"),
      title: `Dawn v${VERSION}`,
      body: "new body",
    }),
    {
      releaseId: 7,
      status: "updated",
      bodySha256: releaseBodySha256("new body"),
    },
  )
  assert.equal(updateTagReads, 2)

  const bytes = Buffer.from("exact asset")
  const digest = sha256(bytes)
  const assets = []
  const downloads = new Map()
  let uploadTagReads = 0
  const uploadWriter = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      release: { ...draftRelease("body"), tag_name: "untagged-opaque" },
      assets,
      downloads,
      tagTargetSha() {
        uploadTagReads += 1
        return SHA
      },
    }),
    fetchImpl: async () => {
      assets.push({ id: 90, name: "manifest.json" })
      downloads.set(90, bytes)
      return jsonResponse({ id: 90 }, 201)
    },
  })
  assert.deepEqual(
    await uploadWriter.uploadAssetIfAbsentAndEqual({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      name: "manifest.json",
      bytes,
      sha256: digest,
    }),
    { assetId: 90, status: "uploaded", sha256: digest },
  )
  assert.equal(uploadTagReads, 2)
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
        target_commitish: "main",
        prerelease: false,
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

test("writer rejects off-target or prerelease drafts at every mutation boundary", async () => {
  const bytes = Buffer.from("exact manifest")
  const digest = sha256(bytes)
  for (const release of [
    { ...draftRelease("body"), target_commitish: "release-controller-temp" },
    { ...draftRelease("body"), prerelease: true },
  ]) {
    let mutations = 0
    const writer = createGitHubWriter({
      owner: OWNER,
      repo: REPO,
      reader: exactReader({ release }),
      fetchImpl: async () => {
        mutations += 1
        return jsonResponse({}, 200)
      },
    })
    await assert.rejects(
      writer.updateDraftReleaseIfCurrent({
        releaseId: 7,
        tag: TAG,
        targetSha: SHA,
        expectedBodySha256: releaseBodySha256("body"),
        title: "new",
        body: "new body",
      }),
      /identity|metadata|target|prerelease/iu,
    )
    await assert.rejects(
      writer.uploadAssetIfAbsentAndEqual({
        releaseId: 7,
        tag: TAG,
        targetSha: SHA,
        name: "manifest.json",
        bytes,
        sha256: digest,
      }),
      /identity|metadata|target|prerelease/iu,
    )
    assert.equal(mutations, 0)
  }
})

test("draft creation rejects a raced prerelease before returning an existing receipt", async () => {
  let releaseLists = 0
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      releases() {
        releaseLists += 1
        return releaseLists === 1 ? [] : [{ id: 7, tag_name: TAG, draft: true }]
      },
      release: { ...draftRelease("candidate body"), prerelease: true },
    }),
    fetchImpl: async () => jsonResponse({}, 422),
  })

  await assert.rejects(
    writer.createDraftRelease({
      tag: TAG,
      targetSha: SHA,
      title: `Dawn v${VERSION}`,
      body: "candidate body",
    }),
    /identity|metadata|prerelease/iu,
  )
  assert.equal(releaseLists, 2)
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

test("asset uploads admit only exact bounded smoke receipt names", async () => {
  const bytes = canonicalSmokeResultBytes({
    schemaVersion: 1,
    lane: "metadata",
    version: VERSION,
    commitSha: SHA,
    manifestSha256: "a".repeat(64),
    workflowRunId: 400,
    runAttempt: 1,
    startedAt: "2026-08-24T00:10:00.000Z",
    finishedAt: "2026-08-24T00:11:00.000Z",
    checks: [{ name: "published-artifacts", conclusion: "success", detail: "verified" }],
    conclusion: "success",
  })
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      release: draftRelease("body"),
      assets: [{ id: 90, name: "smoke-result-metadata-400-1.json" }],
      downloads: new Map([[90, bytes]]),
    }),
    fetchImpl: assert.fail,
  })

  assert.deepEqual(
    await writer.uploadAssetIfAbsentAndEqual({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      name: "smoke-result-metadata-400-1.json",
      bytes,
      sha256: sha256(bytes),
    }),
    { assetId: 90, status: "existing", sha256: sha256(bytes) },
  )
  for (const name of [
    "smoke-result-other-400-1.json",
    "smoke-result-metadata-0-1.json",
    "smoke-result-metadata-400-0.json",
    "smoke-result-metadata-400-1.json.extra",
  ]) {
    await assert.rejects(
      writer.uploadAssetIfAbsentAndEqual({
        releaseId: 7,
        tag: TAG,
        targetSha: SHA,
        name,
        bytes,
        sha256: sha256(bytes),
      }),
      /namespace|allowed|asset/iu,
      name,
    )
  }
  await assert.rejects(
    writer.uploadAssetIfAbsentAndEqual({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      name: "smoke-result-metadata-400-1.json",
      bytes: Buffer.alloc(RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes + 1),
      sha256: sha256(Buffer.alloc(RELEASE_PAYLOAD_LIMITS.smokeReceiptBytes + 1)),
    }),
    /byte|limit|smoke/iu,
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

const DRAFT_INPUT = { tag: TAG, targetSha: SHA, title: `Dawn v${VERSION}`, body: "candidate body" }
const FAKE_TOKEN = `ghp_${"A".repeat(30)}`

function draftWriter(fetchImpl, options = {}) {
  return createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({ releases: [], release: draftRelease("candidate body") }),
    fetchImpl,
    ...options,
  })
}

async function rejection(promise) {
  return promise.then(
    () => assert.fail("the writer call must reject"),
    (reason) => reason,
  )
}

test("draft creation failures carry the HTTP status and the sanitized GitHub message", async () => {
  const writer = draftWriter(
    async () => jsonResponse({ message: "Resource not accessible by integration" }, 403),
    { token: FAKE_TOKEN },
  )
  const error = await rejection(writer.createDraftRelease(DRAFT_INPUT))
  assert.equal(
    error.message,
    "GitHub draft creation returned HTTP 403: Resource not accessible by integration",
  )
  assert.ok(!error.message.includes(FAKE_TOKEN))
  assert.ok(!error.message.includes("Authorization"))
})

test("draft creation failures include structured GitHub errors and survive non-JSON bodies", async () => {
  const validation = draftWriter(async () =>
    jsonResponse(
      {
        message: "Validation Failed",
        errors: [{ resource: "Release", code: "custom", field: "tag_name" }],
        documentation_url: "https://docs.github.com/rest/releases/releases#create-a-release",
      },
      400,
    ),
  )
  assert.equal(
    (await rejection(validation.createDraftRelease(DRAFT_INPUT))).message,
    'GitHub draft creation returned HTTP 400: Validation Failed errors=[{"resource":"Release","code":"custom","field":"tag_name"}]',
  )

  const html = draftWriter(
    async () =>
      new Response("<html>\n<body>  Bad Gateway\u0000 </body>\n</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
  )
  assert.equal(
    (await rejection(html.createDraftRelease(DRAFT_INPUT))).message,
    "GitHub draft creation returned HTTP 502: <html> <body> Bad Gateway </body> </html>",
  )

  const empty = draftWriter(async () => new Response(null, { status: 500 }))
  assert.equal(
    (await rejection(empty.createDraftRelease(DRAFT_INPUT))).message,
    "GitHub draft creation returned HTTP 500",
  )

  const malformedJson = draftWriter(
    async () =>
      new Response("{not json", { status: 503, headers: { "content-type": "application/json" } }),
  )
  assert.equal(
    (await rejection(malformedJson.createDraftRelease(DRAFT_INPUT))).message,
    "GitHub draft creation returned HTTP 503: {not json",
  )
})

test("writer failure detail redacts credentials and query strings from the response body", async () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  const secrets = [
    FAKE_TOKEN,
    `github_pat_${"B".repeat(40)}`,
    `npm_${"C".repeat(36)}`,
    "bearer sk-live-topsecretvalue",
    "authorization: Basic dXNlcjpwYXNz",
    jwt,
    `v1.${jwt}`,
    `{"id.${jwt}":1}`,
    `https://h.test/v1.${jwt}`,
  ]
  const writer = draftWriter(async () =>
    jsonResponse(
      {
        message: `Bad credentials ${secrets.join(" | ")} see https://api.github.com/x?access_token=leaky`,
      },
      401,
    ),
  )
  const error = await rejection(writer.createDraftRelease(DRAFT_INPUT))
  assert.ok(error.message.startsWith("GitHub draft creation returned HTTP 401: Bad credentials "))
  for (const leak of [
    "A".repeat(30),
    "B".repeat(40),
    "C".repeat(36),
    "sk-live-topsecretvalue",
    "dXNlcjpwYXNz",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ",
    "access_token",
    "leaky",
  ]) {
    assert.ok(!error.message.includes(leak), `leaked ${leak}: ${error.message}`)
  }
  assert.equal((error.message.match(/\[redacted\]/gu) ?? []).length, 9, error.message)
  assert.match(
    error.message,
    /\| https:\/\/h\.test\/v1\.\[redacted\] see https:\/\/api\.github\.com\/x$/u,
  )
})

test("writer failure detail bounds a 10 KB body to a 200-character snippet", async () => {
  const filler = "x".repeat(10 * 1024)
  const jsonWriter = draftWriter(async () => jsonResponse({ message: filler }, 500))
  const jsonError = await rejection(jsonWriter.createDraftRelease(DRAFT_INPUT))
  const jsonPrefix = "GitHub draft creation returned HTTP 500: "
  assert.ok(jsonError.message.startsWith(jsonPrefix))
  const jsonSnippet = jsonError.message.slice(jsonPrefix.length)
  assert.equal(jsonSnippet.length, 200)
  assert.equal(jsonSnippet.at(-1), "…")

  const textWriter = draftWriter(
    async () =>
      new Response(`gateway ${filler}`, { status: 504, headers: { "content-type": "text/plain" } }),
  )
  const textError = await rejection(textWriter.createDraftRelease(DRAFT_INPUT))
  const textSnippet = textError.message.slice("GitHub draft creation returned HTTP 504: ".length)
  assert.equal(textSnippet.length, 200)
  assert.ok(textSnippet.startsWith("gateway xxxx"))
  assert.equal(textSnippet.at(-1), "…")
})

test("an unreconciled 422 draft race reports the status and GitHub's explanation", async () => {
  const writer = draftWriter(async () =>
    jsonResponse({ message: "Validation Failed", errors: [{ code: "already_exists" }] }, 422),
  )
  assert.equal(
    (await rejection(writer.createDraftRelease(DRAFT_INPUT))).message,
    'GitHub draft creation race could not be reconciled: no Release matches the tag and the POST returned HTTP 422: Validation Failed errors=[{"code":"already_exists"}]',
  )
})

test("draft update, asset upload, publication, and dispatch failures carry the HTTP status", async () => {
  const forbidden = async () =>
    jsonResponse({ message: "Resource not accessible by integration" }, 403)
  const detail = "returned HTTP 403: Resource not accessible by integration"

  const updateWriter = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({ release: draftRelease("old body") }),
    fetchImpl: forbidden,
  })
  assert.equal(
    (
      await rejection(
        updateWriter.updateDraftReleaseIfCurrent({
          releaseId: 7,
          tag: TAG,
          targetSha: SHA,
          expectedBodySha256: releaseBodySha256("old body"),
          title: `Dawn v${VERSION}`,
          body: "new body",
        }),
      )
    ).message,
    `GitHub draft update ${detail}`,
  )

  const bytes = Buffer.from("exact asset")
  const uploadWriter = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({ release: draftRelease("body"), assets: [], downloads: new Map() }),
    fetchImpl: forbidden,
  })
  assert.equal(
    (
      await rejection(
        uploadWriter.uploadAssetIfAbsentAndEqual({
          releaseId: 7,
          tag: TAG,
          targetSha: SHA,
          name: "manifest.json",
          bytes,
          sha256: sha256(bytes),
        }),
      )
    ).message,
    `GitHub Release asset upload ${detail}`,
  )

  const fixture = verifiedPublicationFixture()
  const publishWriter = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      release: draftRelease(fixture.body),
      assets: fixture.assets.map((asset, index) => ({ id: index + 1, name: asset.name })),
      downloads: new Map(fixture.assets.map((asset, index) => [index + 1, asset.bytes])),
    }),
    fetchImpl: forbidden,
  })
  assert.equal(
    (
      await rejection(
        publishWriter.publishReleaseIfCurrent({
          releaseId: 7,
          tag: TAG,
          targetSha: SHA,
          expectedBodySha256: releaseBodySha256(fixture.body),
          assets: fixture.assets.map(({ name, digest }) => ({ name, sha256: digest })),
        }),
      )
    ).message,
    `Release publication ${detail}`,
  )

  const dispatchWriter = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader(),
    fetchImpl: async () => jsonResponse({ message: "Not Found" }, 404),
  })
  assert.equal(
    (
      await rejection(
        dispatchWriter.dispatchWorkflowAtRef({
          workflow: ".github/workflows/release.yml",
          ref: TAG,
          inputs: {},
        }),
      )
    ).message,
    "GitHub workflow dispatch requires the direct HTTP 200 run receipt but returned HTTP 404: Not Found",
  )
})

test("writer timeouts report the configured budget without headers or the token", async () => {
  const writer = draftWriter(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      }),
    { timeoutMs: 5, token: FAKE_TOKEN },
  )
  const error = await rejection(writer.createDraftRelease(DRAFT_INPUT))
  assert.equal(error.message, "GitHub write timed out after 5 ms (POST)")
  assert.ok(!error.message.includes(FAKE_TOKEN))
})

test("publication binds the exact tag and requires an exact immutable unchanged re-read", async () => {
  const fixture = verifiedPublicationFixture()
  const calls = []
  let releaseReads = 0
  const reader = exactReader({
    release() {
      releaseReads += 1
      return {
        id: 7,
        tag_name: releaseReads === 1 ? "untagged-opaque" : TAG,
        target_commitish: "main",
        prerelease: false,
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
  assert.deepEqual(JSON.parse(calls[0].init.body), { tag_name: TAG, draft: false })
})

test("publication PATCH includes the exact requested tag for an already tagged draft", async () => {
  const fixture = verifiedPublicationFixture()
  const calls = []
  let releaseReads = 0
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
      assets: fixture.assets.map((asset, index) => ({ id: index + 1, name: asset.name })),
      downloads: new Map(fixture.assets.map((asset, index) => [index + 1, asset.bytes])),
    }),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ id: 7, draft: false }, 200)
    },
  })

  await writer.publishReleaseIfCurrent({
    releaseId: 7,
    tag: TAG,
    targetSha: SHA,
    expectedBodySha256: releaseBodySha256(fixture.body),
    assets: fixture.assets.map(({ name, digest }) => ({ name, sha256: digest })),
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].init.body), { tag_name: TAG, draft: false })
})

test("publication rejects an immutable re-read that retains the opaque temporary tag", async () => {
  const fixture = verifiedPublicationFixture()
  let releaseReads = 0
  const writer = createGitHubWriter({
    owner: OWNER,
    repo: REPO,
    reader: exactReader({
      release() {
        releaseReads += 1
        return {
          ...draftRelease(fixture.body),
          tag_name: "untagged-opaque",
          draft: releaseReads === 1,
          immutable: releaseReads > 1,
        }
      },
      assets: fixture.assets.map((asset, index) => ({ id: index + 1, name: asset.name })),
      downloads: new Map(fixture.assets.map((asset, index) => [index + 1, asset.bytes])),
    }),
    fetchImpl: async () => jsonResponse({ id: 7, draft: false }, 200),
  })

  await assert.rejects(
    writer.publishReleaseIfCurrent({
      releaseId: 7,
      tag: TAG,
      targetSha: SHA,
      expectedBodySha256: releaseBodySha256(fixture.body),
      assets: fixture.assets.map(({ name, digest }) => ({ name, sha256: digest })),
    }),
    /identity|metadata|tag/iu,
  )
  assert.equal(releaseReads, 2)
})

test("an existing published Release must expose the exact tag and be immutable", async () => {
  const fixture = verifiedPublicationFixture()
  let mutations = 0
  for (const release of [
    { ...draftRelease(fixture.body), tag_name: "untagged-opaque", draft: false, immutable: true },
    { ...draftRelease(fixture.body), draft: false, immutable: false },
  ]) {
    const writer = createGitHubWriter({
      owner: OWNER,
      repo: REPO,
      reader: exactReader({
        release,
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
        expectedBodySha256: releaseBodySha256(fixture.body),
        assets: fixture.assets.map(({ name, digest }) => ({ name, sha256: digest })),
      }),
      /identity|metadata|immutable/iu,
    )
  }
  assert.equal(mutations, 0)
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

test("publication rejects audit count and declared-size overflow before the first download", async () => {
  const fixture = verifiedPublicationFixture()
  const extraAttempts = Array.from({ length: 128 }, (_unused, index) => ({
    name: `audit-attempt-${index + 1_000}-1.json`,
    bytes: Buffer.from("{}"),
  }))
  const assertPreflightRejects = async (extra, pattern) => {
    const all = [...fixture.assets, ...extra].map((asset) => ({
      ...asset,
      digest: asset.digest ?? sha256(asset.bytes),
    }))
    const downloadCalls = []
    const writer = createGitHubWriter({
      owner: OWNER,
      repo: REPO,
      reader: exactReader({
        release: draftRelease(fixture.body),
        assets: all.map((asset, index) => ({
          id: index + 1,
          name: asset.name,
          size: asset.bytes.byteLength,
        })),
        downloads: new Map(all.map((asset, index) => [index + 1, asset.bytes])),
        downloadCalls,
      }),
      fetchImpl: assert.fail,
    })

    await assert.rejects(
      writer.publishReleaseIfCurrent({
        releaseId: 7,
        tag: TAG,
        targetSha: SHA,
        expectedBodySha256: releaseBodySha256(fixture.body),
        assets: all.map(({ name, digest }) => ({ name, sha256: digest })),
      }),
      pattern,
    )
    assert.deepEqual(downloadCalls, [])
  }

  await assertPreflightRejects(extraAttempts, /audit|count|bound/iu)
  await assertPreflightRejects(
    [
      {
        name: "audit-attempt-100-1.json",
        bytes: Buffer.alloc(RELEASE_PAYLOAD_LIMITS.auditReceiptBytes + 1),
      },
    ],
    /audit|size|byte|limit/iu,
  )
})

function exactReader({
  releases,
  release = draftRelease("candidate body"),
  assets = [],
  downloads = new Map(),
  tagType = "tag",
  tagTargetSha = SHA,
  downloadCalls = [],
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
      present(
        "releases",
        typeof releases === "function"
          ? releases()
          : (releases ?? [{ id: 7, tag_name: TAG, draft: true }]),
      ),
    getRelease: async () => present("release", getReleaseValue()),
    listReleaseAssets: async () =>
      present(
        "release-assets",
        assets.map((asset) => ({
          ...asset,
          size: asset.size ?? downloads.get(asset.id)?.byteLength ?? 0,
        })),
      ),
    downloadReleaseAsset: async ({ assetId }) => {
      downloadCalls.push(assetId)
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
    target_commitish: "main",
    prerelease: false,
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
  const bundles = subjects.map((subject) => ({
    name: `${subject.name}.intoto.jsonl`,
    bytes: Buffer.from("one-exact-multi-subject-bundle"),
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
  const smokeAssets = SMOKE_LANES.map((lane) => ({
    name: `smoke-result-${lane}-400-1.json`,
    bytes: canonicalSmokeResultBytes({
      schemaVersion: 1,
      lane,
      version: VERSION,
      commitSha: SHA,
      manifestSha256: subjects[0].digest,
      workflowRunId: 400,
      runAttempt: 1,
      startedAt: "2026-08-24T00:10:00.000Z",
      finishedAt: "2026-08-24T00:11:00.000Z",
      checks: [{ name: "published-artifacts", conclusion: "success", detail: "verified" }],
      conclusion: "success",
    }),
  }))
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
    smoke: smokeDescriptor({
      aggregateSha256: "5".repeat(64),
      releaseAssetIdStart: 46,
      receiptSha256s: smokeAssets.map((asset) => sha256(asset.bytes)),
    }),
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
    ...smokeAssets.map((asset) => [asset.name, asset.bytes]),
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
