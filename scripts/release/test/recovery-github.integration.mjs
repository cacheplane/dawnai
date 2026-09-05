import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import {
  FENCE_API_VERSION,
  FENCE_FIXTURES,
  fenceCanonical,
  fenceDigest,
  projectRecoveryFenceEvidence,
} from "../recovery/fence-evidence.mjs"
import { authorizeFenceProbe } from "./support/recovery-github-fence.mjs"
import {
  exerciseRecoveryFenceMatrix,
  PROBE_SOURCE_PATHS,
  readProbeInventory,
} from "./support/recovery-github-probe.mjs"

// Explicit service lane only. Install the historical fixture verbatim on the
// separately authorized disposable default branch. This probe advances that
// fixture, creates two named tags, and retains commits/runs as evidence. No
// production identity, release resource, or npm publication is allowed here.
test("disposable GitHub workflow disable across current and historical sources", {
  skip: Reflect.get(process.env, "DAWN_TEST_RECOVERY_GITHUB") !== "1",
  timeout: 3_000_000,
}, async (t) => {
  const repository = authorizeFenceProbe(process.env)
  const base = `/repos/${repository}`
  const directory = await mkdtemp(join(tmpdir(), "dawn-recovery-fence-"))
  const ledgerPath = join(directory, "raw-ledger.json")
  const ledger = {
    repository,
    startedAt: new Date().toISOString(),
    calls: [],
    ownedRunIds: [],
    ownedTags: [],
    restoration: "not-needed",
    outcome: "inconclusive",
  }
  const persist = async () => {
    const bytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`)
    assert.ok(bytes.length <= 32 * 1024 * 1024, "raw ledger byte bound")
    await writeFile(`${ledgerPath}.tmp`, bytes, { mode: 0o600 })
    await rename(`${ledgerPath}.tmp`, ledgerPath)
  }
  await persist()
  t.diagnostic(`Raw service observations and incomplete attempts: ${ledgerPath}`)
  async function api(method, path, body = null) {
    assert.ok(path === base || path.startsWith(`${base}/`), "endpoint confinement")
    assert.ok(!path.includes("..") && !path.includes("#") && !path.includes("%"))
    assert.ok(
      ledger.calls.length < 9999 && Date.now() - Date.parse(ledger.startedAt) < 2_900_000,
      "probe bound",
    )
    const call = {
      id: `call-${String(ledger.calls.length + 1).padStart(4, "0")}`,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      method,
      path,
      body,
      status: null,
      response: null,
    }
    ledger.calls.push(call)
    await persist()
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--include",
      "--method",
      method,
      "-H",
      `X-GitHub-Api-Version: ${FENCE_API_VERSION}`,
      path.slice(1),
    ]
    if (body !== null) args.push("--input", "-")
    let stdout
    try {
      stdout = await new Promise((resolve, reject) => {
        const child = execFile(
          "gh",
          args,
          { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
          (error, output) => {
            if (error && !output.startsWith("HTTP/")) reject(error)
            else resolve(output)
          },
        )
        child.stdin.on("error", () => {})
        child.stdin.end(body === null ? undefined : JSON.stringify(body))
      })
      const separator = stdout.search(/\r?\n\r?\n/u)
      assert.ok(separator >= 0, "response headers required")
      call.status = Number(/^HTTP\/\S+ (\d+)/u.exec(stdout)?.[1])
      assert.ok(Number.isSafeInteger(call.status) && call.status >= 200 && call.status <= 599)
      const raw = stdout.slice(separator).trim()
      call.response = raw ? JSON.parse(raw) : null
      call.finishedAt = new Date().toISOString()
      if (
        method === "POST" &&
        path.endsWith("/dispatches") &&
        Number.isSafeInteger(call.response?.workflow_run_id)
      )
        ledger.ownedRunIds.push(call.response.workflow_run_id)
      await persist()
      return call
    } catch (error) {
      call.finishedAt = new Date().toISOString()
      ledger.outcome = "unknown-response-requires-inspection"
      await persist()
      throw new Error(
        `Unknown or invalid response to ${method} ${path}; no automatic mutation retry`,
        { cause: error },
      )
    }
  }
  const get = async (path) => {
    const call = await api("GET", path)
    assert.equal(call.status, 200, path)
    return call
  }
  const fixtureBytes = Object.fromEntries(
    await Promise.all(
      Object.entries(FENCE_FIXTURES).map(async ([revision, fixture]) => {
        const bytes = await readFile(fixture.path, "utf8")
        assert.equal(fenceDigest(bytes), fixture.sha256)
        return [revision, bytes]
      }),
    ),
  )
  // All local source dependencies are explicit; hash actual bytes, not a claimed
  // source revision. This is a review manifest, never admission by itself.
  const closure = await Promise.all(
    PROBE_SOURCE_PATHS.map(async (path) => ({ path, sha256: fenceDigest(await readFile(path)) })),
  )
  const repositoryCall = await get(base)
  const repo = repositoryCall.response
  assert.notEqual(repo.id, 1210070282, "production repository ID forbidden")
  assert.equal(repo.full_name.toLowerCase(), repository.toLowerCase(), "redirect forbidden")
  assert.match(repo.default_branch, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u)
  const defaultBranch = repo.default_branch,
    workflow = ".github/workflows/recovery-fence-probe.yml"
  const initial = await get(`${base}/git/ref/heads/${defaultBranch}`)
  const historicalSha = initial.response.object.sha
  const historicalFixtureCall = await get(`${base}/contents/${workflow}?ref=${historicalSha}`)
  assert.equal(historicalFixtureCall.response.encoding, "base64")
  assert.equal(
    Buffer.from(historicalFixtureCall.response.content, "base64").toString("utf8"),
    fixtureBytes.historical,
    "install exact historical fixture first",
  )
  const initialBranchCall = await get(`${base}/git/ref/heads/${defaultBranch}`)
  assert.equal(initialBranchCall.response.object.sha, historicalSha)
  const workflowCall = await get(`${base}/actions/workflows/recovery-fence-probe.yml`)
  const workflowId = String(workflowCall.response.id),
    wf = `${base}/actions/workflows/${workflowId}`
  assert.equal(workflowCall.response.path, workflow)
  assert.equal(workflowCall.response.state, "active")
  ledger.initialRunIds = (await readProbeInventory(get, wf)).records.map((r) => r.id)
  const historicalSeedDispatchCall = await api("POST", `${wf}/dispatches`, {
    ref: defaultBranch,
    inputs: { probe_id: "historical-seed" },
  })
  assert.equal(historicalSeedDispatchCall.status, 200)
  const seedId = historicalSeedDispatchCall.response?.workflow_run_id
  assert.ok(Number.isSafeInteger(seedId) && seedId > 0, "direct seed ID required")
  let historicalSeedRunCall, historicalSeedJobsCall
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    const call = await api("GET", `${base}/actions/runs/${seedId}/attempts/1`)
    if (call.status === 404) {
      await delay(5000)
      continue
    }
    assert.equal(call.status, 200)
    if (call.response.status !== "completed") {
      await delay(5000)
      continue
    }
    historicalSeedRunCall = call
    historicalSeedJobsCall = await get(
      `${base}/actions/runs/${seedId}/attempts/1/jobs?per_page=100&page=1`,
    )
    break
  }
  assert.ok(
    historicalSeedRunCall && historicalSeedJobsCall,
    "seed must drain before advancing branch",
  )
  assert.equal(historicalSeedRunCall.response.head_sha, historicalSha)
  assert.equal(historicalSeedRunCall.response.conclusion, "failure")
  assert.equal(
    historicalSeedJobsCall.response.jobs
      .find((j) => j.name === "writer")
      ?.steps.find((s) => s.name === FENCE_FIXTURES.historical.step)?.conclusion,
    "failure",
  )
  const beforeAdvance = await get(`${base}/git/ref/heads/${defaultBranch}`)
  assert.equal(
    beforeAdvance.response.object.sha,
    historicalSha,
    "default branch moved before fixture advance",
  )
  const advancedWrite = await api("PUT", `${base}/contents/${workflow}`, {
    message: "test(release): advance disposable fence fixture",
    content: Buffer.from(fixtureBytes.current).toString("base64"),
    sha: historicalFixtureCall.response.sha,
    branch: defaultBranch,
  })
  assert.equal(advancedWrite.status, 200)
  const currentSha = advancedWrite.response.commit.sha
  const advancedBranchCall = await get(`${base}/git/ref/heads/${defaultBranch}`)
  assert.equal(advancedBranchCall.response.object.sha, currentSha)
  const currentFixtureCall = await get(`${base}/contents/${workflow}?ref=${currentSha}`)
  const suffix = randomUUID(),
    currentTag = `fence-current-${suffix}`,
    historicalTag = `fence-historical-${suffix}`
  const tagCalls = []
  for (const [tag, sha] of [
    [currentTag, currentSha],
    [historicalTag, historicalSha],
  ]) {
    ledger.ownedTags.push({ tag, sha, creation: "pending" })
    await persist()
    const created = await api("POST", `${base}/git/refs`, { ref: `refs/tags/${tag}`, sha })
    assert.equal(created.status, 201)
    ledger.ownedTags.at(-1).creation = "confirmed"
    tagCalls.push(await get(`${base}/git/ref/tags/${tag}`))
  }
  const evidence = {
    schemaVersion: 1,
    kind: "recovery-workflow-disable-evidence",
    apiVersion: FENCE_API_VERSION,
    startedAt: ledger.startedAt,
    repository,
    repositoryId: String(repo.id),
    workflowId,
    workflow,
    defaultBranch,
    historicalSha,
    currentSha,
    currentTag,
    historicalTag,
    probeClosureSha256: fenceDigest(fenceCanonical(closure)),
    fixtureDigests: Object.fromEntries(
      Object.entries(fixtureBytes).map(([k, v]) => [k, fenceDigest(v)]),
    ),
    setup: Object.fromEntries(
      Object.entries({
        repositoryCall,
        historicalFixtureCall,
        currentFixtureCall,
        initialBranchCall,
        advancedBranchCall,
        currentTagCall: tagCalls[0],
        historicalTagCall: tagCalls[1],
        historicalSeedDispatchCall,
        historicalSeedRunCall,
        historicalSeedJobsCall,
      }).map(([k, v]) => [k, v.id]),
    ),
  }
  ledger.probeClosure = closure
  try {
    const matrix = await exerciseRecoveryFenceMatrix({
      evidence: { ...evidence, seed: { id: seedId, attempt: 1 } },
      api,
      sleep: delay,
      persist: async (progress) => {
        ledger.progress = progress
        ledger.restoration = progress.restorationRequired
          ? "required"
          : ledger.restoration === "required" || progress.transitions.disableCall
            ? "active-and-drained"
            : "not-needed"
        await persist()
      },
    })
    ledger.witness = { ...evidence, ...matrix, finishedAt: new Date().toISOString() }
    await persist()
    const witness = projectRecoveryFenceEvidence(ledger.calls, ledger.witness, {
      fixtureBytes,
      probeClosureSha256: evidence.probeClosureSha256,
    })
    const bytes = fenceCanonical(witness)
    const evidenceSha256 = fenceDigest(bytes)
    await writeFile(join(directory, `${evidenceSha256}.json`), bytes, { mode: 0o600 })
    ledger.outcome = "disposable-fence-observed"
    ledger.evidenceSha256 = evidenceSha256
    ledger.restoration = "active-and-drained"
  } finally {
    // Retain only the explicitly ledger-owned tags, commits and runs for review.
    // No broad delete, branch reset, or unowned run cancellation is performed.
    ledger.finishedAt = new Date().toISOString()
    await persist()
    const rawLedgerSha256 = fenceDigest(await readFile(ledgerPath))
    await writeFile(
      join(directory, "report.json"),
      `${JSON.stringify({ outcome: ledger.outcome, rawLedgerSha256, evidenceSha256: ledger.evidenceSha256 ?? null, retainedResources: { tags: ledger.ownedTags, runs: ledger.ownedRunIds }, restoration: ledger.restoration, serviceScope: "workflow-disable only; release publication and production topology remain separate" }, null, 2)}\n`,
      { mode: 0o600 },
    )
  }
  assert.equal(ledger.outcome, "disposable-fence-observed")
})
