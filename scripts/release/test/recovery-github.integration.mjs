import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { authorizeFenceProbe, classifyFenceProbe } from "./support/recovery-github-fence.mjs"

const execute = promisify(execFile)
const workflowFile = "recovery-fence-probe.yml"
const workflowPath = `.github/workflows/${workflowFile}`

// No network or credentials are accessed unless this dedicated lane is opted in.
// Provision the exact fixture on the authorized disposable default branch first.
test("disposable GitHub workflow disable versus historical reruns", {
  skip: Reflect.get(process.env, "DAWN_TEST_RECOVERY_GITHUB") !== "1",
  timeout: 3_000_000,
}, async (t) => {
  const repository = authorizeFenceProbe(process.env)
  const prefix = `repos/${repository}`
  const ledgerPath = join(await mkdtemp(join(tmpdir(), "dawn-recovery-fence-")), "evidence.json")
  const ledger = {
    repository,
    startedAt: new Date().toISOString(),
    requests: [],
    observations: [],
    ownedRunIds: [],
    runs: [],
    outcome: "inconclusive",
    restoration: "not-needed",
  }
  const persist = async () => {
    await writeFile(`${ledgerPath}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
    await rename(`${ledgerPath}.tmp`, ledgerPath)
  }
  await persist()
  t.diagnostic(`Evidence (including incomplete attempts): ${ledgerPath}`)

  async function api(method, path, body) {
    // No arbitrary host, absolute URL, shell interpolation, or unrecorded effect.
    assert.ok(path.startsWith(`${prefix}/`) || path === prefix)
    const entry = { method, path, ...(body ? { body } : {}), startedAt: new Date().toISOString() }
    ledger.requests.push(entry)
    await persist()
    const args = [
      "api",
      "--hostname",
      "github.com",
      "--include",
      "--method",
      method,
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      path,
    ]
    // Every body value is a fixed key or a validated branch/UUID. gh raw fields
    // avoid shell interpretation, with nested inputs supported by gh itself.
    for (const [key, value] of Object.entries(body ?? {})) {
      args.push("--raw-field", `${key}=${value}`)
    }
    let stdout
    try {
      ;({ stdout } = await execute("gh", args, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }))
    } catch (error) {
      if (!error.stdout?.startsWith("HTTP/"))
        throw new Error(`Unknown response to ${method} ${path}; inspect ledger`, { cause: error })
      stdout = error.stdout
    }
    const separator = stdout.search(/\r?\n\r?\n/)
    assert.ok(separator >= 0, "GitHub response has headers")
    const status = Number(/^HTTP\/\S+ (\d+)/.exec(stdout)?.[1])
    assert.ok(Number.isInteger(status) && status >= 100)
    const text = stdout.slice(separator).trim()
    const data = text ? JSON.parse(text) : null
    entry.status = status
    // Retain correlation and error details, never response headers or auth data.
    entry.result = data
    await persist()
    return { status, data }
  }
  async function get(path) {
    const response = await api("GET", path)
    assert.equal(response.status, 200)
    return response.data
  }
  async function waitFor(runId, attempt, method, requestId) {
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      const run = await get(`${prefix}/actions/runs/${runId}`)
      assert.equal(run.id, runId)
      assert.equal(run.workflow_id, ledger.workflowId)
      assert.equal(run.head_sha, ledger.headSha)
      assert.equal(run.event, "workflow_dispatch")
      if (method === "dispatch") assert.equal(run.display_title, `recovery-fence-${requestId}`)
      if (run.run_attempt >= attempt && run.status === "completed") {
        assert.equal(run.run_attempt, attempt, "unexpected concurrent rerun")
        assert.equal(run.conclusion, "failure")
        const result = await get(
          `${prefix}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
        )
        assert.ok(result.total_count <= 2, "unexpected fixture jobs")
        const writer = result.jobs.find((job) => job.name === "writer")
        assert.equal(writer?.status, "completed")
        assert.equal(
          writer?.conclusion,
          "failure",
          "historical detect output must reach the writer",
        )
        assert.ok(Number.isSafeInteger(writer.id))
        const step = writer.steps.find(
          ({ name }) => name === "Prove historical writer reachability without writing",
        )
        assert.equal(step?.status, "completed", "runner setup failure is not writer execution")
        assert.equal(step?.conclusion, "failure")
        if (method === "dispatch" || method === "all") {
          assert.equal(result.jobs.find(({ name }) => name === "detect")?.conclusion, "success")
        }
        ledger.runs.push({
          id: runId,
          attempt,
          writerJobId: writer.id,
          writerStep: { name: step.name, status: step.status, conclusion: step.conclusion },
          jobs: result.jobs.map(({ id, name, conclusion }) => ({ id, name, conclusion })),
        })
        await persist()
        return { id: runId, attempt, writerJobId: writer.id }
      }
      await delay(5000)
    }
    throw new Error(
      `Run ${runId} did not drain; inspect and stop fixture runs before using results`,
    )
  }
  async function state(expected) {
    const workflow = await get(`${prefix}/actions/workflows/${ledger.workflowId}`)
    assert.equal(workflow.state, expected)
  }
  async function inventory() {
    const result = await get(`${prefix}/actions/workflows/${ledger.workflowId}/runs?per_page=100`)
    // This minimal experiment refuses larger inventories; Task 12 adds pagination.
    assert.ok(result.total_count <= 100 && result.total_count === result.workflow_runs.length)
    for (const run of result.workflow_runs) {
      assert.equal(run.status, "completed", `fixture run ${run.id} has not drained`)
      if (ledger.initialRunIds)
        assert.ok(
          [...ledger.initialRunIds, ...ledger.ownedRunIds].includes(run.id),
          `unowned or ambiguous fixture run ${run.id}; inspect ledger`,
        )
    }
    return result.workflow_runs
      .map(({ id, run_attempt }) => ({ id, run_attempt }))
      .sort((a, b) => a.id - b.id)
  }
  let current
  async function probe(stage, method) {
    await state(stage === "disabled" ? "disabled_manually" : "active")
    const before = current
    const beforeInventory = await inventory()
    const requestId = randomUUID()
    const path =
      method === "dispatch"
        ? `${prefix}/actions/workflows/${ledger.workflowId}/dispatches`
        : method === "job"
          ? `${prefix}/actions/jobs/${current.writerJobId}/rerun`
          : `${prefix}/actions/runs/${current.id}/${method === "all" ? "rerun" : "rerun-failed-jobs"}`
    if (method === "dispatch") {
      const tip = await get(`${prefix}/commits/${encodeURIComponent(ledger.defaultBranch)}`)
      assert.equal(tip.sha, ledger.headSha, "fixture default branch moved before dispatch")
    }
    const response = await api(
      "POST",
      path,
      method === "dispatch"
        ? { ref: ledger.defaultBranch, "inputs[probe_id]": requestId }
        : undefined,
    )
    const accepted = response.status >= 200 && response.status < 300
    const observation = { stage, method, status: response.status, accepted, requestId }
    ledger.observations.push(observation)
    await persist()
    if (accepted) {
      const id = method === "dispatch" ? response.data?.workflow_run_id : current.id
      assert.ok(Number.isSafeInteger(id) && id > 0, "direct run correlation required")
      if (method === "dispatch") ledger.ownedRunIds.push(id)
      await persist()
      current = await waitFor(
        id,
        method === "dispatch" ? 1 : current.attempt + 1,
        method,
        requestId,
      )
      observation.run = current
    } else if (stage === "disabled") {
      // Observe after a short settlement period; an HTTP error alone is no fence.
      await delay(5000)
      const run = await get(`${prefix}/actions/runs/${before.id}`)
      observation.unchanged = run.run_attempt === before.attempt && run.status === "completed"
      assert.deepEqual(await inventory(), beforeInventory, "denial created a new run or attempt")
    } else {
      throw new Error(
        `Positive ${stage}/${method} control rejected (${response.status}); inconclusive`,
      )
    }
    await state(stage === "disabled" ? "disabled_manually" : "active")
    await inventory()
    await persist()
  }

  const repo = await get(prefix)
  assert.notEqual(repo.id, 1210070282, "production repository ID forbidden, including aliases")
  assert.equal(
    repo.full_name.toLowerCase(),
    repository.toLowerCase(),
    "redirected repository forbidden",
  )
  ledger.repositoryId = repo.id
  ledger.defaultBranch = repo.default_branch
  const branch = await get(`${prefix}/commits/${encodeURIComponent(repo.default_branch)}`)
  ledger.headSha = branch.sha
  assert.match(ledger.headSha, /^[a-f0-9]{40}$/)
  const fixture = await readFile(
    new URL("./fixtures/recovery-contract-workflow.yml", import.meta.url),
    "utf8",
  )
  const content = await get(`${prefix}/contents/${workflowPath}?ref=${ledger.headSha}`)
  assert.equal(content.encoding, "base64")
  assert.equal(
    Buffer.from(content.content, "base64").toString("utf8"),
    fixture,
    "install the exact harmless fixture first",
  )
  const workflow = await get(`${prefix}/actions/workflows/${workflowFile}`)
  assert.equal(workflow.path, workflowPath)
  assert.equal(workflow.state, "active", "pre-existing workflow state must be active")
  ledger.workflowId = workflow.id
  ledger.initialRunIds = (await inventory()).map(({ id }) => id)
  await persist()
  try {
    for (const method of ["dispatch", "all", "failed", "job"]) await probe("active-before", method)
    // Mark restoration required BEFORE a possibly ambiguous disable response.
    ledger.restoration = "required"
    await persist()
    assert.equal(
      (await api("PUT", `${prefix}/actions/workflows/${workflow.id}/disable`)).status,
      204,
    )
    for (const method of ["dispatch", "all", "failed", "job"]) await probe("disabled", method)
  } finally {
    ledger.outcome = classifyFenceProbe(ledger.observations)
    if (ledger.restoration === "required") {
      try {
        assert.equal(
          (await api("PUT", `${prefix}/actions/workflows/${workflow.id}/enable`)).status,
          204,
        )
        await state("active")
        ledger.restoration = "restored-active"
      } catch {
        ledger.restoration = "failed-requires-operator"
      }
    }
    await persist()
  }
  assert.equal(ledger.restoration, "restored-active")
  for (const method of ["dispatch", "all", "failed", "job"]) await probe("active-after", method)
  await inventory()
  ledger.outcome = classifyFenceProbe(ledger.observations)
  ledger.finishedAt = new Date().toISOString()
  await persist()
  t.diagnostic(
    `Fence result: ${ledger.outcome}. Fixture runs are retained as evidence; no release resources were created.`,
  )
  assert.equal(
    ledger.outcome,
    "disposable-fence-observed",
    "workflow disable is not a demonstrated fence; production recovery remains blocked",
  )
})
