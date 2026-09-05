import assert from "node:assert/strict"

export const PROBE_SOURCE_PATHS = Object.freeze([
  "scripts/release/adapter-normalize.mjs",
  "scripts/release/adapters/github.mjs",
  "scripts/release/adapters/http.mjs",
  "scripts/release/adapters/npm.mjs",
  "scripts/release/limits.mjs",
  "scripts/release/recovery/fence-evidence.mjs",
  "scripts/release/recovery/invocation.mjs",
  "scripts/release/recovery/policy.mjs",
  "scripts/release/recovery/schema.mjs",
  "scripts/release/semver.mjs",
  "scripts/release/test/recovery-github.integration.mjs",
  "scripts/release/test/support/recovery-github-fence.mjs",
  "scripts/release/test/support/recovery-github-probe.mjs",
])

// Test-only, complete all-SHA inventory. No latest-run or source filter.
export async function readProbeInventory(get, workflowBase) {
  const records = [],
    calls = [],
    ids = new Set()
  let total = null
  for (let page = 1; page <= 100; page++) {
    const call = await get(`${workflowBase}/runs?per_page=100&page=${page}`)
    const body = call.response
    assert.ok(
      Number.isSafeInteger(body?.total_count) && body.total_count >= 0 && body.total_count <= 10000,
      "bounded inventory total",
    )
    assert.ok(total === null || total === body.total_count, "stable inventory total")
    total = body.total_count
    assert.ok(
      Array.isArray(body.workflow_runs) && body.workflow_runs.length <= 100,
      "inventory page",
    )
    for (const run of body.workflow_runs) {
      assert.ok(
        Number.isSafeInteger(run.id) && run.id > 0 && !ids.has(run.id),
        "unique inventory identity",
      )
      assert.equal(run.status, "completed", "inventory must be drained")
      ids.add(run.id)
      records.push(run)
    }
    calls.push(call.id)
    if (records.length === total) return { records, calls }
    assert.ok(
      records.length < total && body.workflow_runs.length === 100,
      "complete inventory pages",
    )
  }
  throw new Error("inventory page bound exceeded")
}

export async function exerciseRecoveryFenceMatrix({
  evidence,
  api,
  sleep,
  now = Date.now,
  persist = async () => {},
}) {
  const base = `/repos/${evidence.repository}`,
    wf = `${base}/actions/workflows/${evidence.workflowId}`
  const get = async (path) => {
    const call = await api("GET", path, null)
    assert.equal(call.status, 200, `read ${path}`)
    return call
  }
  const state = async (expected) => {
    const call = await get(wf)
    assert.equal(String(call.response.id), evidence.workflowId)
    assert.equal(call.response.path, evidence.workflow)
    assert.equal(call.response.state, expected)
    return call.id
  }
  const branch = async () => {
    const call = await get(`${base}/git/ref/heads/${evidence.defaultBranch}`)
    assert.equal(call.response.object?.sha, evidence.currentSha, "default branch moved")
    return call.id
  }
  const inventory = () => readProbeInventory(get, wf)
  const drain = async () => {
    const deadline = now() + 240000
    while (true) {
      try {
        return await inventory()
      } catch (error) {
        if (!error.message.includes("inventory must be drained") || now() >= deadline) throw error
        await sleep(5000)
      }
    }
  }
  const lineages = { historical: evidence.seed }
  const cases = [],
    transitions = {}
  let restorationRequired = false
  const snapshot = async () => persist({ cases, transitions, restorationRequired })
  async function execution(id, attempt, source) {
    const deadline = now() + 240000
    while (now() < deadline) {
      const run = await api("GET", `${base}/actions/runs/${id}/attempts/${attempt}`, null)
      if (run.status === 404) {
        await sleep(5000)
        continue
      }
      assert.equal(run.status, 200)
      assert.equal(run.response.id, id)
      assert.equal(run.response.run_attempt, attempt)
      assert.equal(String(run.response.workflow_id), evidence.workflowId)
      assert.equal(run.response.head_sha, source)
      if (run.response.status === "completed") {
        assert.equal(run.response.conclusion, "failure")
        const jobs = await get(
          `${base}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100&page=1`,
        )
        assert.ok(
          jobs.response.total_count === jobs.response.jobs.length && jobs.response.total_count <= 2,
        )
        const writer = jobs.response.jobs.find((j) => j.name === "writer")
        assert.equal(writer?.conclusion, "failure", "writer must actually execute")
        const name =
          source === evidence.historicalSha
            ? "Prove historical writer reachability without writing"
            : "Prove current writer reachability without writing"
        assert.equal(writer.steps.find((s) => s.name === name)?.conclusion, "failure")
        return { run, jobs, writer }
      }
      await sleep(5000)
    }
    throw new Error(`fixture run ${id} did not drain`)
  }
  try {
    for (const stage of ["active-before", "disabled", "active-after"]) {
      if (stage !== "active-before") {
        const disabling = stage === "disabled"
        if (disabling) {
          restorationRequired = true
          await snapshot()
        }
        const call = await api("PUT", `${wf}/${disabling ? "disable" : "enable"}`, null)
        assert.equal(call.status, 204)
        transitions[disabling ? "disableCall" : "enableCall"] = call.id
        // Remain obligated to check restoration and drainage in finally.
      }
      for (const context of ["current-default", "current-tag", "historical"]) {
        for (const method of ["dispatch", "all", "failed", "job"]) {
          const expectedState = stage === "disabled" ? "disabled_manually" : "active"
          const source = context === "historical" ? evidence.historicalSha : evidence.currentSha
          const ref =
            context === "current-default"
              ? evidence.defaultBranch
              : context === "current-tag"
                ? evidence.currentTag
                : evidence.historicalTag
          const requestId = `${stage}-${context}-${method}`
          const c = {
            context,
            stage,
            method,
            requestId,
            stateBeforeCall: await state(expectedState),
            branchBeforeCall: await branch(),
            beforeInventoryCalls: (await inventory()).calls,
            requestCall: null,
            targetRunCall: null,
            targetJobsCall: null,
            runAfterCall: null,
            jobsAfterCall: null,
          }
          let target
          if (method !== "dispatch") {
            const lineage = lineages[context]
            assert.ok(lineage, "explicit rerun lineage required")
            target = await execution(lineage.id, lineage.attempt, source)
            c.targetRunCall = target.run.id
            c.targetJobsCall = target.jobs.id
          }
          const path =
            method === "dispatch"
              ? `${wf}/dispatches`
              : method === "job"
                ? `${base}/actions/jobs/${target.writer.id}/rerun`
                : `${base}/actions/runs/${target.run.response.id}/${method === "all" ? "rerun" : "rerun-failed-jobs"}`
          const request = await api(
            "POST",
            path,
            method === "dispatch" ? { ref, inputs: { probe_id: requestId } } : null,
          )
          c.requestCall = request.id
          cases.push(c)
          await snapshot()
          if (stage === "disabled") {
            assert.ok(
              [403, 404, 409, 422].includes(request.status),
              "workflow disable is insufficient or inconclusive",
            )
            await sleep(5000)
          } else {
            assert.equal(request.status, method === "dispatch" ? 200 : 201)
            if (method !== "dispatch") assert.equal(request.response, null)
            const id =
              method === "dispatch" ? request.response?.workflow_run_id : target.run.response.id
            assert.ok(Number.isSafeInteger(id) && id > 0, "direct dispatch ID required")
            const attempt = method === "dispatch" ? 1 : target.run.response.run_attempt + 1
            const after = await execution(id, attempt, source)
            c.runAfterCall = after.run.id
            c.jobsAfterCall = after.jobs.id
            if (method !== "dispatch" || context !== "historical")
              lineages[context] = { id, attempt }
          }
          c.afterInventoryCalls = (await inventory()).calls
          c.stateAfterCall = await state(expectedState)
          c.branchAfterCall = await branch()
          await snapshot()
        }
      }
    }
    const restoration = {
      workflowCall: await state("active"),
      finalInventoryCalls: (await inventory()).calls,
    }
    restorationRequired = false
    await snapshot()
    return { cases, transitions, restoration }
  } finally {
    if (restorationRequired) {
      // Unknown disable/enable outcomes still require explicit restoration. Never
      // retry dispatch or infer acceptance from a title search.
      const enabled = await api("PUT", `${wf}/enable`, null)
      assert.equal(enabled.status, 204, "operator must restore workflow")
      await state("active")
      await drain()
      restorationRequired = false
      await snapshot()
    }
  }
}
