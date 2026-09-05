import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
export const digest = (raw) => createHash("sha256").update(raw).digest("hex")
export const canonical = (value) => Buffer.from(`${JSON.stringify(sort(value))}\n`)
function sort(value) {
  return Array.isArray(value)
    ? value.map(sort)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sort(value[key])]),
        )
      : value
}
export const historicalFixturePath = "scripts/release/test/fixtures/recovery-contract-workflow.yml"
export const currentFixturePath =
  "scripts/release/test/fixtures/recovery-contract-workflow-current.yml"
export async function fenceEvidenceFixture() {
  const fixtureBytes = {
    historical: await readFile(historicalFixturePath, "utf8"),
    current: await readFile(currentFixturePath, "utf8"),
  }
  const historicalSha = "a".repeat(40),
    currentSha = "b".repeat(40)
  const repository = "example/disposable-fence",
    repositoryId = "42",
    workflowId = "12",
    workflow = ".github/workflows/recovery-fence-probe.yml",
    defaultBranch = "main"
  const base = `/repos/${repository}`,
    wf = `${base}/actions/workflows/${workflowId}`
  let clock = Date.parse("2026-09-05T00:00:00Z"),
    sequence = 0,
    runNumber = 100,
    state = "active",
    branch = historicalSha
  const calls = [],
    runs = new Map()
  const add = (method, path, body, status, response) => {
    const id = `call-${String(++sequence).padStart(4, "0")}`
    calls.push({
      id,
      startedAt: new Date(clock++).toISOString(),
      finishedAt: new Date(clock++).toISOString(),
      method,
      path,
      body,
      status,
      response: structuredClone(response),
    })
    return id
  }
  const get = (path, response) => add("GET", path, null, 200, response)
  const branchRead = () =>
    get(`${base}/git/ref/heads/main`, {
      ref: "refs/heads/main",
      object: { type: "commit", sha: branch },
    })
  const stateRead = () => get(wf, { id: 12, path: workflow, state })
  const inventory = () => [
    get(`${wf}/runs?per_page=100&page=1`, {
      total_count: runs.size,
      workflow_runs: [...runs.values()],
    }),
  ]
  const job = (run) => ({
    id: Number(run.id) * 100 + run.run_attempt,
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: run.head_sha,
    name: "writer",
    status: "completed",
    conclusion: "failure",
    steps: [
      {
        name:
          run.head_sha === historicalSha
            ? "Prove historical writer reachability without writing"
            : "Prove current writer reachability without writing",
        status: "completed",
        conclusion: "failure",
        number: 1,
        started_at: new Date(clock).toISOString(),
        completed_at: new Date(clock + 1).toISOString(),
      },
    ],
  })
  const runRead = (run) => get(`${base}/actions/runs/${run.id}/attempts/${run.run_attempt}`, run)
  const jobsRead = (run) =>
    get(`${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=1`, {
      total_count: 1,
      jobs: [job(run)],
    })
  const createRun = (source, ref, requestId) => {
    const run = {
      id: ++runNumber,
      run_attempt: 1,
      workflow_id: 12,
      path: workflow,
      repository: { id: 42, full_name: repository },
      head_sha: source,
      head_branch: ref,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      display_title: `recovery-fence-${requestId}`,
    }
    runs.set(run.id, run)
    return run
  }
  const dispatch = (ref, requestId, run) =>
    add("POST", `${wf}/dispatches`, { ref, inputs: { probe_id: requestId } }, 200, {
      workflow_run_id: run.id,
    })
  const repositoryCall = get(base, { id: 42, full_name: repository, default_branch: "main" })
  const contents = (revision, source) =>
    get(`${base}/contents/${workflow}?ref=${source}`, {
      path: workflow,
      encoding: "base64",
      content: Buffer.from(fixtureBytes[revision]).toString("base64"),
    })
  const historicalFixtureCall = contents("historical", historicalSha)
  const initialBranchCall = branchRead()
  const seed = createRun(historicalSha, defaultBranch, "historical-seed")
  const historicalSeedDispatchCall = dispatch(defaultBranch, "historical-seed", seed)
  const historicalSeedRunCall = runRead(seed),
    historicalSeedJobsCall = jobsRead(seed)
  branch = currentSha
  const advancedBranchCall = branchRead(),
    currentFixtureCall = contents("current", currentSha)
  const tag = (name, source) =>
    get(`${base}/git/ref/tags/${name}`, {
      ref: `refs/tags/${name}`,
      object: { type: "commit", sha: source },
    })
  const currentTagCall = tag("fence-current", currentSha),
    historicalTagCall = tag("fence-historical", historicalSha)
  const setup = {
    repositoryCall,
    historicalFixtureCall,
    currentFixtureCall,
    initialBranchCall,
    advancedBranchCall,
    currentTagCall,
    historicalTagCall,
    historicalSeedDispatchCall,
    historicalSeedRunCall,
    historicalSeedJobsCall,
  }
  const cases = [],
    lineages = { historical: seed },
    transitions = {}
  for (const stage of ["active-before", "disabled", "active-after"]) {
    if (stage !== "active-before") {
      const disabled = stage === "disabled"
      transitions[disabled ? "disableCall" : "enableCall"] = add(
        "PUT",
        `${wf}/${disabled ? "disable" : "enable"}`,
        null,
        204,
        null,
      )
      state = disabled ? "disabled_manually" : "active"
    }
    for (const context of ["current-default", "current-tag", "historical"])
      for (const method of ["dispatch", "all", "failed", "job"]) {
        const requestId = `${stage}-${context}-${method}`
        const stateBeforeCall = stateRead(),
          branchBeforeCall = branchRead(),
          beforeInventoryCalls = inventory()
        const source = context === "historical" ? historicalSha : currentSha,
          ref =
            context === "current-default"
              ? defaultBranch
              : context === "current-tag"
                ? "fence-current"
                : "fence-historical"
        let target = method === "dispatch" ? null : lineages[context]
        const targetRunCall = target ? runRead(target) : null,
          targetJobsCall = target ? jobsRead(target) : null
        let requestCall,
          runAfterCall = null,
          jobsAfterCall = null
        if (stage === "disabled") {
          requestCall = add(
            "POST",
            method === "dispatch"
              ? `${wf}/dispatches`
              : method === "job"
                ? `${base}/actions/jobs/${job(target).id}/rerun`
                : `${base}/actions/runs/${target.id}/${method === "all" ? "rerun" : "rerun-failed-jobs"}`,
            method === "dispatch" ? { ref, inputs: { probe_id: requestId } } : null,
            422,
            { message: "Workflow disabled" },
          )
          clock += 5000
        } else {
          if (method === "dispatch") {
            const run = createRun(source, ref, requestId)
            requestCall = dispatch(ref, requestId, run)
            if (context !== "historical") lineages[context] = run
            target = run
          } else {
            requestCall = add(
              "POST",
              method === "job"
                ? `${base}/actions/jobs/${job(target).id}/rerun`
                : `${base}/actions/runs/${target.id}/${method === "all" ? "rerun" : "rerun-failed-jobs"}`,
              null,
              201,
              null,
            )
            target.run_attempt++
          }
          runAfterCall = runRead(target)
          jobsAfterCall = jobsRead(target)
        }
        const afterInventoryCalls = inventory(),
          stateAfterCall = stateRead(),
          branchAfterCall = branchRead()
        cases.push({
          context,
          stage,
          method,
          requestId,
          stateBeforeCall,
          branchBeforeCall,
          beforeInventoryCalls,
          requestCall,
          targetRunCall,
          targetJobsCall,
          runAfterCall,
          jobsAfterCall,
          afterInventoryCalls,
          stateAfterCall,
          branchAfterCall,
        })
      }
  }
  const restoration = { workflowCall: stateRead(), finalInventoryCalls: inventory() }
  const evidence = {
    schemaVersion: 1,
    kind: "recovery-workflow-disable-evidence",
    apiVersion: "2026-03-10",
    startedAt: "2026-09-05T00:00:00.000Z",
    finishedAt: new Date(clock).toISOString(),
    repository,
    repositoryId,
    workflowId,
    workflow,
    defaultBranch,
    historicalSha,
    currentSha,
    currentTag: "fence-current",
    historicalTag: "fence-historical",
    probeClosureSha256: digest(
      canonical([
        { path: "scripts/release/test/recovery-github.integration.mjs", sha256: "c".repeat(64) },
      ]),
    ),
    fixtureDigests: Object.fromEntries(
      Object.entries(fixtureBytes).map(([k, v]) => [k, digest(v)]),
    ),
    calls,
    setup,
    transitions,
    cases,
    restoration,
  }
  return { evidence, fixtureBytes }
}
