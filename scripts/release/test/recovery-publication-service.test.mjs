import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createGitHubReader } from "../adapters/github.mjs"

const historicalWorkflow = await readFile(
  "scripts/release/test/fixtures/recovery-contract-workflow.yml",
  "utf8",
)
const currentWorkflow = await readFile(
  "scripts/release/test/fixtures/recovery-contract-workflow-current.yml",
  "utf8",
)

const subject = await import("./support/recovery-publication-service.mjs").catch(() => ({}))
const sha = (x) => createHash("sha256").update(x).digest("hex")
function service({ uncertain = null, production = false, immutable = true } = {}) {
  const calls = [],
    effects = [],
    base = "/repos/example/release-lab"
  let release, asset, payload
  return {
    calls,
    effects,
    repository: "example/release-lab",
    sourceSha: "a".repeat(40),
    nonce: "01234567-1234-1234-1234-123456789abc",
    async api(method, path, body) {
      calls.push({ method, path })
      if (method === "GET") {
        if (path.includes("/actions/workflows?"))
          return {
            status: 200,
            body: {
              total_count: 1,
              workflows: [{ id: 12, path: ".github/workflows/recovery-fence-probe.yml" }],
            },
          }
        if (path === base)
          return {
            status: 200,
            body: {
              id: production ? 1210070282 : 42,
              full_name: "example/release-lab",
              default_branch: "main",
              private: false,
            },
          }
        if (path.endsWith("/immutable-releases"))
          return { status: 200, body: { enabled: immutable, enforced_by_owner: false } }
        if (path.includes("/git/ref/heads/"))
          return { status: 200, body: { object: { sha: "b".repeat(40), type: "commit" } } }
        if (path.includes("/contents/"))
          return {
            status: 200,
            body: {
              encoding: "base64",
              content: Buffer.from(
                path.endsWith("a".repeat(40)) ? historicalWorkflow : currentWorkflow,
              ).toString("base64"),
            },
          }
        if (path.includes("/git/ref/tags/"))
          return { status: 200, body: { object: { sha: "c".repeat(40), type: "tag" } } }
        if (path.includes("/git/tags/"))
          return { status: 200, body: { object: { sha: "a".repeat(40), type: "commit" } } }
        if (path.endsWith("/assets?per_page=100&page=1")) return { status: 200, body: [asset] }
        if (path.endsWith("/releases/100")) return { status: 200, body: release }
      }
      effects.push({ method, path })
      if (path.endsWith("/git/tags")) return { status: 201, body: { sha: "c".repeat(40) } }
      if (path.endsWith("/git/refs")) return { status: 201, body: {} }
      if (method === "POST" && path.endsWith("/releases")) {
        release = { ...body, id: 100, tag_name: "untagged-fixture", immutable: false }
        if (uncertain === "create")
          throw Object.assign(new Error("response lost"), { uncertain: true })
        return { status: 201, body: release }
      }
      if (method === "POST" && path.includes("/assets?name=")) {
        payload = body
        asset = { id: 200, name: "contract.txt", size: body.length, digest: `sha256:${sha(body)}` }
        if (uncertain === "upload")
          throw Object.assign(new Error("response lost"), { uncertain: true })
        return { status: 201, body: asset }
      }
      if (method === "PATCH") {
        release = { ...release, ...body, immutable: true }
        if (uncertain === "publish")
          throw Object.assign(new Error("response lost"), { uncertain: true })
        return { status: 200, body: release }
      }
      throw new Error(`unexpected ${method} ${path}`)
    },
    async anonymousGet() {
      return { status: release.draft ? 404 : 200, body: release.draft ? null : release }
    },
    async download() {
      return payload
    },
  }
}
for (const uncertain of [null, "upload", "publish"]) {
  test(`publication service contract reads back exact immutable payload with ${uncertain ?? "known"} response`, async () => {
    assert.equal(typeof subject.runPublicationServiceProbe, "function")
    const fake = service({ uncertain })
    const result = await subject.runPublicationServiceProbe(fake)
    assert.equal(result.status, "published-immutable")
    assert.equal(fake.effects.filter((e) => e.path.endsWith("/releases")).length, 1)
    assert.equal(fake.effects.filter((e) => e.path.includes("/assets?")).length, 1)
    assert.equal(fake.effects.filter((e) => e.method === "PATCH").length, 1)
  })
}
test("publication probe refuses production aliases and disabled immutability before mutations", async () => {
  for (const options of [{ production: true }, { immutable: false }]) {
    const fake = service(options)
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.equal(fake.effects.length, 0)
  }
})
test("unknown draft creation stops without a duplicate creation or inferred resource ID", async () => {
  const fake = service({ uncertain: "create" })
  await assert.rejects(subject.runPublicationServiceProbe(fake), /response lost/)
  assert.equal(fake.effects.filter((e) => e.path.endsWith("/releases")).length, 1)
  assert.equal(
    fake.effects.some((e) => e.method === "PATCH"),
    false,
  )
})

test("asset readback compares immutable identity rather than mutable download counters", async () => {
  const fake = service()
  const api = fake.api
  let count = 0
  fake.api = async (...args) => {
    const r = await api(...args)
    if (args[1].endsWith("/assets?per_page=100&page=1"))
      r.body = r.body.map((asset) => ({ ...asset, download_count: count++ }))
    return r
  }
  assert.equal((await subject.runPublicationServiceProbe(fake)).status, "published-immutable")
})

for (const damage of ["draft-visible", "payload", "asset-digest", "asset-size", "asset-extra"]) {
  test(`publication probe blocks ${damage} before publication`, async () => {
    const fake = service()
    if (damage === "draft-visible") fake.anonymousGet = async () => ({ status: 200, body: {} })
    if (damage === "payload") fake.download = async () => Buffer.from("changed payload")
    const api = fake.api
    fake.api = async (...args) => {
      const r = await api(...args)
      if (args[1].endsWith("/assets?per_page=100&page=1")) {
        r.body = structuredClone(r.body)
        if (damage === "asset-digest") r.body[0].digest = `sha256:${"0".repeat(64)}`
        if (damage === "asset-size") r.body[0].size++
        if (damage === "asset-extra") r.body.push({ ...r.body[0], id: 201 })
      }
      return r
    }
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.equal(
      fake.effects.some((e) => e.method === "PATCH"),
      false,
    )
  })
}

test("publication refuses unrelated workflow identities before tag or release creation", async () => {
  const fake = service()
  const api = fake.api
  fake.api = async (...args) => {
    if (args[1].includes("/actions/workflows?"))
      return {
        status: 200,
        body: {
          total_count: 1,
          workflows: [{ id: 999, path: ".github/workflows/unrelated-release-writer.yml" }],
        },
      }
    return api(...args)
  }
  await assert.rejects(subject.runPublicationServiceProbe(fake), /workflow/)
  assert.equal(fake.effects.length, 0)
})

test("default branch movement after upload blocks publication", async () => {
  const fake = service()
  const api = fake.api
  fake.api = async (...args) => {
    const r = await api(...args)
    if (
      args[1].includes("/git/ref/heads/") &&
      fake.effects.some((e) => e.path.includes("/assets?"))
    )
      r.body = { object: { type: "commit", sha: "d".repeat(40) } }
    return r
  }
  await assert.rejects(subject.runPublicationServiceProbe(fake), /default branch/)
  assert.equal(
    fake.effects.some((e) => e.method === "PATCH"),
    false,
  )
})

test("publication service download decodes the production binary envelope without changing bytes", async () => {
  assert.equal(typeof subject.downloadPublicationAsset, "function")
  const bytes = Buffer.from([0, 255, 195, 40, 10])
  const calls = []
  const reader = createGitHubReader({
    owner: "example",
    repo: "release-lab",
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(bytes, { headers: { "content-type": "application/octet-stream" } })
    },
  })
  assert.deepEqual(await subject.downloadPublicationAsset(reader, 200), bytes)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://api.github.com/repos/example/release-lab/releases/assets/200")
  assert.equal(calls[0].init.headers.Accept, "application/octet-stream")
})

test("publication service download refuses a failed production read", async () => {
  assert.equal(typeof subject.downloadPublicationAsset, "function")
  const reader = createGitHubReader({
    owner: "example",
    repo: "release-lab",
    fetchImpl: async () => new Response("missing", { status: 404 }),
  })
  await assert.rejects(subject.downloadPublicationAsset(reader, 200), /production asset adapter/)
})

test("publication visibility may settle after authenticated immutable publication without another write", async () => {
  const fake = service()
  const original = fake.anonymousGet
  let postPublishReads = 0
  const sleeps = []
  fake.sleep = async (ms) => sleeps.push(ms)
  fake.anonymousGet = async () => {
    const response = await original()
    if (response.status === 200 && postPublishReads++ < 2) return { status: 404, body: null }
    return response
  }
  assert.equal((await subject.runPublicationServiceProbe(fake)).status, "published-immutable")
  assert.deepEqual(sleeps, [5000, 5000])
  assert.equal(fake.effects.filter((e) => e.method === "PATCH").length, 1)
})

test("publication visibility settlement is bounded and does not retry non-404 failures", async () => {
  for (const status of [404, 403]) {
    const fake = service()
    const original = fake.anonymousGet
    const sleeps = []
    fake.sleep = async (ms) => sleeps.push(ms)
    fake.anonymousGet = async () => {
      const response = await original()
      return response.status === 200 ? { status, body: null } : response
    }
    await assert.rejects(subject.runPublicationServiceProbe(fake))
    assert.equal(sleeps.length, status === 404 ? 11 : 0)
    assert.equal(fake.effects.filter((e) => e.method === "PATCH").length, 1)
  }
})
