import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createGitHubReader } from "../adapters/github.mjs"
import { authorizeFenceProbe } from "./support/recovery-github-fence.mjs"
import { runPublicationServiceProbe } from "./support/recovery-publication-service.mjs"

// Separate opt-in: unlike the harmless fence workflow, this leaves an immutable
// prerelease and annotated tag in a PUBLIC disposable repository. No npm effects.
test("real annotated-tag publication, draft visibility and immutable asset readback", {
  skip: Reflect.get(process.env, "DAWN_TEST_RECOVERY_PUBLICATION_GITHUB") !== "1",
  timeout: 180000,
}, async (t) => {
  const env = process.env
  const repository = authorizeFenceProbe(env)
  const token = env.DAWN_RECOVERY_PUBLICATION_TOKEN
  const policyToken = env.DAWN_RECOVERY_TEST_POLICY_TOKEN
  assert.ok(
    typeof token === "string" && token.length > 0 && token.length < 4096 && !/[\r\n]/u.test(token),
    "explicit intended publication credential required",
  )
  assert.ok(
    typeof policyToken === "string" &&
      policyToken.length > 0 &&
      policyToken.length < 4096 &&
      !/[\r\n]/u.test(policyToken),
    "separate policy-read credential required",
  )
  assert.match(env.DAWN_RECOVERY_TEST_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/u)
  assert.ok(
    ["operator", "workflow"].includes(env.DAWN_RECOVERY_TEST_CREDENTIAL_KIND),
    "explicit credential kind required",
  )
  if (env.DAWN_RECOVERY_TEST_CREDENTIAL_KIND === "workflow") {
    assert.equal(env.GITHUB_ACTIONS, "true")
    assert.equal(env.GITHUB_REPOSITORY, repository)
    assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/u)
  }
  const discard = env.DAWN_RECOVERY_TEST_DISCARD_RESPONSE ?? ""
  assert.ok(["", "upload", "publication"].includes(discard), "bounded response-loss experiment")
  let discarded = false
  const root = await mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), "dawn-recovery-publication-"))
  const ledger = {
    repository,
    startedAt: new Date().toISOString(),
    credentialKind: env.DAWN_RECOVERY_TEST_CREDENTIAL_KIND,
    runId: env.GITHUB_RUN_ID ?? null,
    calls: [],
    owned: null,
    outcome: "incomplete",
    limitation:
      "operator credentials do not prove workflow-token authority; workflow claims require the actual reviewed run and fixture source",
  }
  const save = async () => {
    const bytes = JSON.stringify(ledger, null, 2)
    assert.ok(Buffer.byteLength(bytes) <= 8 * 1024 * 1024)
    await writeFile(join(root, "ledger.json"), `${bytes}\n`, { mode: 0o600 })
  }
  await save()
  t.diagnostic(`Retained service evidence: ${root}`)
  const base = `/repos/${repository}`
  const hash = (x) => createHash("sha256").update(x).digest("hex")
  let repositoryId
  async function request(method, path, body = null, anonymous = false) {
    assert.ok(path === base || path.startsWith(`${base}/`))
    assert.ok(!path.includes("..") && !path.includes("%") && !path.includes("#"))
    assert.ok(ledger.calls.length < 100 && Date.now() - Date.parse(ledger.startedAt) < 150000)
    const upload = Buffer.isBuffer(body)
    const origin = upload ? "https://uploads.github.com" : "https://api.github.com"
    const entry = {
      method,
      path,
      origin,
      anonymous,
      body: upload ? { size: body.length, sha256: hash(body) } : body,
      startedAt: new Date().toISOString(),
      status: null,
      response: null,
    }
    ledger.calls.push(entry)
    await save()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const credential = path.endsWith("/immutable-releases") ? policyToken : token
      const response = await fetch(`${origin}${path}`, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(anonymous ? {} : { Authorization: `Bearer ${credential}` }),
          ...(body === null
            ? {}
            : { "Content-Type": upload ? "application/octet-stream" : "application/json" }),
        },
        ...(body === null ? {} : { body: upload ? body : JSON.stringify(body) }),
      })
      entry.status = response.status
      const chunks = []
      let size = 0
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.length
          assert.ok(size <= 2 * 1024 * 1024, "bounded response")
          chunks.push(chunk)
        }
      const bytes = Buffer.concat(chunks).toString("utf8")
      entry.response = bytes ? JSON.parse(bytes) : null
      entry.finishedAt = new Date().toISOString()
      if (method === "GET" && path === base && response.status === 200)
        repositoryId = String(entry.response.id)
      await save()
      return { status: entry.status, body: entry.response }
    } catch (error) {
      entry.finishedAt = new Date().toISOString()
      entry.unknownResponse = true
      await save()
      throw Object.assign(new Error("unknown service response; inspect ledger", { cause: error }), {
        uncertain: entry.status === null || (entry.status >= 200 && entry.status < 300),
      })
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const [owner, repo] = repository.split("/")
    const result = await runPublicationServiceProbe({
      repository,
      sourceSha: env.DAWN_RECOVERY_TEST_SOURCE_SHA,
      nonce: randomUUID(),
      topologySha256: hash(
        await readFile(new URL("./fixtures/recovery-topology-workflow.yml", import.meta.url)),
      ),
      api: async (method, path, body) => {
        const response = await request(method, path, body)
        const selected =
          discard === "upload"
            ? Buffer.isBuffer(body)
            : discard === "publication" && method === "PATCH"
        if (!discarded && selected && response.status >= 200 && response.status < 300) {
          discarded = true
          ledger.injectedClientResponseLoss = discard
          await save()
          throw Object.assign(
            new Error("probe discards accepted response before driver receives it"),
            { uncertain: true },
          )
        }
        return response
      },
      anonymousGet: (path) => request("GET", path, null, true),
      download: async (assetId) => {
        const reader = createGitHubReader({
          owner,
          repo,
          repositoryId,
          token,
          maxResponseBytes: 65536,
        })
        const result = await reader.downloadReleaseAsset({ assetId, maximumBytes: 65536 })
        assert.equal(result.status, "PRESENT", "production asset adapter must retrieve exact bytes")
        ledger.calls.push({
          operation: "production-asset-download",
          assetId,
          size: result.value.length,
          sha256: hash(result.value),
          finishedAt: new Date().toISOString(),
        })
        await save()
        return result.value
      },
      persist: async (owned) => {
        ledger.owned = structuredClone(owned)
        await save()
      },
    })
    ledger.outcome = "published-immutable"
    ledger.result = result
  } finally {
    ledger.finishedAt = new Date().toISOString()
    await save()
    t.diagnostic(
      "Owned annotated tag and immutable prerelease are retained for review; no resource deletion or policy change is performed.",
    )
  }
})
