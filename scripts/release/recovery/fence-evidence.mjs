// A finite validator of git-reviewed observations; never a service probe or interpreter.
import { createHash } from "node:crypto"
import { types } from "node:util"
import { recoveryId } from "./invocation.mjs"
import { snapshotRecoveryData } from "./schema.mjs"

export const FENCE_API_VERSION = "2026-03-10"
export const FENCE_FIXTURES = Object.freeze({
  historical: Object.freeze({
    path: "scripts/release/test/fixtures/recovery-contract-workflow.yml",
    sha256: "8bcc57a7c844915822919758ecf485f8bdabccba88bce6fb86dfcc0727392d4c",
    step: "Prove historical writer reachability without writing",
  }),
  current: Object.freeze({
    path: "scripts/release/test/fixtures/recovery-contract-workflow-current.yml",
    sha256: "d8ae34b9f18cbf4a8f401188a99a6b9985946e98a790157f43b0aaea28e9a49d",
    step: "Prove current writer reachability without writing",
  }),
})
export function fenceRequire(value, message) {
  if (!value) throw new TypeError(`Recovery fence blocked: ${message}`)
}
export function fenceExact(value, fields) {
  fenceRequire(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(" ") === fields.split(" ").filter(Boolean).sort().join(" "),
    `exact ${fields} fields required`,
  )
}
export function fenceDigest(raw) {
  return createHash("sha256").update(raw).digest("hex")
}
export function fenceCanonical(value) {
  const sort = (item) =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item
  return Buffer.from(`${JSON.stringify(sort(snapshotRecoveryData(value, 8 * 1024 * 1024)))}\n`)
}
export function fenceSame(a, b, message) {
  fenceRequire(fenceCanonical(a).equals(fenceCanonical(b)), message)
}
export function fenceParse(raw, maximumBytes) {
  fenceRequire(typeof raw === "string" || Buffer.isBuffer(raw), "raw bytes required")
  fenceRequire(
    Buffer.byteLength(raw) > 0 && Buffer.byteLength(raw) <= maximumBytes,
    "raw byte bound",
  )
  const bytes = Buffer.from(raw)
  const value = snapshotRecoveryData(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    maximumBytes,
  )
  fenceRequire(fenceCanonical(value).equals(bytes), "canonical JSON required")
  return value
}
function timestamp(value) {
  fenceRequire(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      (new Date(Date.parse(value)).toISOString() === value ||
        new Date(Date.parse(value)).toISOString().replace(".000Z", "Z") === value),
    "canonical timestamp required",
  )
  return Date.parse(value)
}
function timestampIntervalEnd(value) {
  const start = timestamp(value)
  // GitHub step times may omit fractional seconds. Their represented interval is
  // [start, start + 1000ms); explicit milliseconds narrow it to one millisecond.
  // This accounts only for recorded precision, never clock skew or rewritten data.
  return start + (value.includes(".") ? 1 : 1000)
}
function writerExecutionFitsObservation(step, request, observation) {
  const start = timestamp(step.started_at)
  const earliestStart = request === null ? start : Math.max(start, timestamp(request.startedAt))
  const latestStart = timestampIntervalEnd(step.started_at) - 1
  const earliestEnd = timestamp(step.completed_at)
  const latestEnd = Math.min(
    timestampIntervalEnd(step.completed_at) - 1,
    timestamp(observation.finishedAt),
  )
  // Require at least one ordered pair of integer-millisecond execution times
  // within the recorded intervals, after the request and before observation.
  return earliestStart <= latestStart && Math.max(earliestStart, earliestEnd) <= latestEnd
}
function sha(value) {
  fenceRequire(typeof value === "string" && /^[a-f0-9]{40}$/u.test(value), "commit SHA required")
}
function id(value) {
  fenceRequire(
    typeof value === "string" && recoveryId(value) === value,
    "canonical ID string required",
  )
}
export function fenceTerminalRuns(runs, { workflowId, workflow, repository, repositoryId } = {}) {
  fenceRequire(Array.isArray(runs) && runs.length <= 10000, "bounded run inventory required")
  const ids = new Set()
  return runs
    .map((run) => {
      const runId = recoveryId(run.id),
        attempt = recoveryId(run.run_attempt)
      fenceRequire(!ids.has(runId), "duplicate run ID")
      ids.add(runId)
      fenceRequire(
        run.status === "completed" &&
          [
            "success",
            "failure",
            "cancelled",
            "skipped",
            "timed_out",
            "action_required",
            "neutral",
            "stale",
            "startup_failure",
          ].includes(run.conclusion),
        "terminal drained runs required",
      )
      if (workflowId !== undefined)
        fenceRequire(
          recoveryId(run.workflow_id) === workflowId &&
            run.path === workflow &&
            run.repository?.full_name === repository &&
            recoveryId(run.repository.id) === repositoryId,
          "run repository/workflow mismatch",
        )
      sha(run.head_sha)
      return { id: runId, attempt, status: run.status, conclusion: run.conclusion }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}
export function validateRecoveryFenceEvidence(raw, { fixtureBytes, probeClosureSha256 }) {
  const e = fenceParse(raw, 8 * 1024 * 1024)
  fenceExact(
    e,
    "schemaVersion kind apiVersion startedAt finishedAt repository repositoryId workflowId workflow defaultBranch historicalSha currentSha currentTag historicalTag probeClosureSha256 fixtureDigests calls setup transitions cases restoration",
  )
  fenceRequire(
    e.schemaVersion === 1 &&
      e.kind === "recovery-workflow-disable-evidence" &&
      e.apiVersion === FENCE_API_VERSION,
    "supported service evidence required",
  )
  fenceRequire(
    typeof e.repository === "string" &&
      /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(e.repository) &&
      e.repository.toLowerCase() !== "cacheplane/dawnai",
    "disposable evidence repository required",
  )
  id(e.repositoryId)
  id(e.workflowId)
  fenceRequire(e.repositoryId !== "1210070282", "production repository ID forbidden")
  fenceRequire(
    e.workflow === ".github/workflows/recovery-fence-probe.yml" &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(e.defaultBranch),
    "fixed probe workflow/default branch required",
  )
  sha(e.historicalSha)
  sha(e.currentSha)
  fenceRequire(
    e.historicalSha !== e.currentSha &&
      e.currentTag !== e.historicalTag &&
      [e.currentTag, e.historicalTag].every(
        (x) => typeof x === "string" && /^fence-[a-z0-9-]{1,100}$/u.test(x),
      ),
    "distinct fixture revisions and tags required",
  )
  fenceRequire(
    e.probeClosureSha256 === probeClosureSha256 && /^[a-f0-9]{64}$/u.test(probeClosureSha256),
    "probe closure mismatch",
  )
  fenceExact(e.fixtureDigests, "historical current")
  for (const revision of ["historical", "current"])
    fenceRequire(
      typeof fixtureBytes[revision] === "string" &&
        fenceDigest(fixtureBytes[revision]) === FENCE_FIXTURES[revision].sha256 &&
        e.fixtureDigests[revision] === FENCE_FIXTURES[revision].sha256,
      "reviewed harmless fixture bytes required",
    )
  const started = timestamp(e.startedAt),
    finished = timestamp(e.finishedAt)
  fenceRequire(finished > started && finished - started <= 3_600_000, "evidence elapsed bound")
  fenceRequire(
    Array.isArray(e.calls) && e.calls.length > 0 && e.calls.length <= 4096,
    "bounded explicit service calls required",
  )
  const base = `/repos/${e.repository}`,
    wf = `${base}/actions/workflows/${e.workflowId}`
  const calls = new Map(),
    used = new Set()
  let previous = started
  for (const c of e.calls) {
    fenceExact(c, "id startedAt finishedAt method path body status response")
    fenceRequire(
      typeof c.id === "string" && /^call-[0-9]{4}$/u.test(c.id) && !calls.has(c.id),
      "unique service call ID required",
    )
    fenceRequire(
      timestamp(c.startedAt) >= previous &&
        timestamp(c.finishedAt) >= timestamp(c.startedAt) &&
        timestamp(c.finishedAt) <= finished,
      "service call chronology required",
    )
    previous = timestamp(c.finishedAt)
    fenceRequire(
      ["GET", "POST", "PUT"].includes(c.method) &&
        Number.isInteger(c.status) &&
        c.status >= 200 &&
        c.status <= 599,
      "service call method/status required",
    )
    fenceRequire(
      typeof c.path === "string" &&
        c.path.length <= 2048 &&
        (c.path === base || c.path.startsWith(`${base}/`)) &&
        !c.path.includes("..") &&
        !c.path.includes("%") &&
        !c.path.includes("#"),
      "disposable endpoint confinement required",
    )
    calls.set(c.id, c)
  }
  const call = (reference, method, path, statuses = [200]) => {
    const c = calls.get(reference)
    fenceRequire(
      c &&
        !used.has(reference) &&
        c.method === method &&
        c.path === path &&
        statuses.includes(c.status),
      "correlated service call required",
    )
    used.add(reference)
    if (method === "GET" || method === "PUT")
      fenceRequire(c.body === null, "read/transition body must be null")
    return c
  }
  const before = (a, b) =>
    fenceRequire(timestamp(a.finishedAt) <= timestamp(b.startedAt), "operation chronology mismatch")
  const repository = (c) =>
    fenceRequire(
      c.response?.full_name === e.repository &&
        recoveryId(c.response.id) === e.repositoryId &&
        c.response.default_branch === e.defaultBranch,
      "service repository mismatch",
    )
  const branch = (reference, source) => {
    const c = call(reference, "GET", `${base}/git/ref/heads/${e.defaultBranch}`)
    fenceRequire(
      c.response?.ref === `refs/heads/${e.defaultBranch}` &&
        c.response.object?.type === "commit" &&
        c.response.object.sha === source,
      "branch source mismatch",
    )
    return c
  }
  const state = (reference, expected) => {
    const c = call(reference, "GET", wf)
    fenceRequire(
      recoveryId(c.response?.id) === e.workflowId &&
        c.response.path === e.workflow &&
        c.response.state === expected,
      "workflow state mismatch",
    )
    return c
  }
  const run = (reference) => {
    const c = calls.get(reference),
      r = c?.response
    fenceRequire(r, "run observation required")
    call(
      reference,
      "GET",
      `${base}/actions/runs/${recoveryId(r.id)}/attempts/${recoveryId(r.run_attempt)}`,
    )
    fenceTerminalRuns([r], e)
    fenceRequire(
      r.event === "workflow_dispatch" && r.conclusion === "failure",
      "completed failing fixture run required",
    )
    return c
  }
  const jobOwners = new Map()
  const jobs = (reference, r, request = null) => {
    const c = call(
      reference,
      "GET",
      `${base}/actions/runs/${recoveryId(r.id)}/attempts/${recoveryId(r.run_attempt)}/jobs?per_page=100&page=1`,
    )
    fenceRequire(
      Number.isInteger(c.response?.total_count) &&
        c.response.total_count >= 1 &&
        c.response.total_count <= 4 &&
        c.response.jobs?.length === c.response.total_count,
      "complete bounded fixture jobs required",
    )
    const ids = new Set()
    for (const j of c.response.jobs) {
      fenceRequire(!ids.has(recoveryId(j.id)), "duplicate fixture job")
      ids.add(recoveryId(j.id))
      const jobId = recoveryId(j.id),
        owner = `${recoveryId(r.id)}:${recoveryId(r.run_attempt)}`
      fenceRequire(
        !jobOwners.has(jobId) || jobOwners.get(jobId) === owner,
        "numeric job ID reassigned to another run/attempt",
      )
      jobOwners.set(jobId, owner)
      fenceRequire(
        recoveryId(j.run_id) === recoveryId(r.id) &&
          recoveryId(j.run_attempt) === recoveryId(r.run_attempt) &&
          j.head_sha === r.head_sha &&
          j.status === "completed",
        "fixture job identity mismatch",
      )
    }
    const writers = c.response.jobs.filter((j) => j.name === "writer")
    fenceRequire(
      writers.length === 1 && writers[0].conclusion === "failure",
      "intended failing writer job required",
    )
    const writer = writers[0],
      stepName = FENCE_FIXTURES[r.head_sha === e.historicalSha ? "historical" : "current"].step
    fenceRequire(Array.isArray(writer.steps) && writer.steps.length <= 20, "writer steps required")
    const steps = writer.steps.filter((step) => step.name === stepName)
    fenceRequire(
      steps.length === 1 &&
        steps[0].status === "completed" &&
        steps[0].conclusion === "failure" &&
        Number.isSafeInteger(steps[0].number) &&
        steps[0].number > 0 &&
        writerExecutionFitsObservation(steps[0], request, c),
      "actual intended writer step execution required",
    )
    return { call: c, writer }
  }
  const inventorySourceIdentity = (records) => {
    const byId = new Map(records.map((record) => [recoveryId(record.id), record]))
    return fenceTerminalRuns(records, e).map((identity) => {
      const record = byId.get(identity.id)
      return {
        ...identity,
        headSha: record.head_sha,
        headBranch: record.head_branch,
        event: record.event,
        workflowId: recoveryId(record.workflow_id),
        workflow: record.path,
        repository: record.repository.full_name,
        repositoryId: recoveryId(record.repository.id),
      }
    })
  }
  const inventory = (refs) => {
    fenceRequire(
      Array.isArray(refs) && refs.length > 0 && refs.length <= 100,
      "complete inventory calls required",
    )
    const records = []
    let total = null
    const observations = []
    for (const [index, reference] of refs.entries()) {
      const c = call(reference, "GET", `${wf}/runs?per_page=100&page=${index + 1}`),
        body = c.response
      observations.push(c)
      fenceRequire(
        Number.isInteger(body?.total_count) &&
          body.total_count >= 0 &&
          body.total_count <= 10000 &&
          (total === null || total === body.total_count) &&
          Array.isArray(body.workflow_runs) &&
          body.workflow_runs.length <= 100 &&
          (index === refs.length - 1 || body.workflow_runs.length === 100),
        "complete stable inventory pages required",
      )
      total = body.total_count
      records.push(...body.workflow_runs)
      if (index > 0) before(observations[index - 1], c)
    }
    fenceRequire(records.length === total, "inventory total mismatch")
    return {
      records,
      identity: fenceTerminalRuns(records, e),
      first: observations[0],
      last: observations.at(-1),
    }
  }
  fenceExact(
    e.setup,
    "repositoryCall historicalFixtureCall currentFixtureCall initialBranchCall advancedBranchCall currentTagCall historicalTagCall historicalSeedDispatchCall historicalSeedRunCall historicalSeedJobsCall",
  )
  const s = e.setup
  const repositoryCall = call(s.repositoryCall, "GET", base)
  repository(repositoryCall)
  const content = (reference, revision, source) => {
    const c = call(reference, "GET", `${base}/contents/${e.workflow}?ref=${source}`)
    fenceRequire(
      c.response?.path === e.workflow &&
        c.response.encoding === "base64" &&
        typeof c.response.content === "string" &&
        c.response.content.replace(/\n/gu, "") ===
          Buffer.from(fixtureBytes[revision]).toString("base64"),
      "service fixture content mismatch",
    )
    return c
  }
  const historicalContent = content(s.historicalFixtureCall, "historical", e.historicalSha),
    initialBranch = branch(s.initialBranchCall, e.historicalSha)
  before(repositoryCall, historicalContent)
  before(repositoryCall, initialBranch)
  const seedRequest = call(s.historicalSeedDispatchCall, "POST", `${wf}/dispatches`, [200])
  fenceExact(seedRequest.body, "ref inputs")
  fenceExact(seedRequest.body.inputs, "probe_id")
  fenceRequire(
    seedRequest.body.ref === e.defaultBranch &&
      seedRequest.body.inputs.probe_id === "historical-seed",
    "historical default seed dispatch required",
  )
  const seed = run(s.historicalSeedRunCall),
    seedJobs = jobs(s.historicalSeedJobsCall, seed.response, seedRequest)
  fenceRequire(
    recoveryId(seedRequest.response?.workflow_run_id) === recoveryId(seed.response.id) &&
      seed.response.run_attempt === 1 &&
      seed.response.head_sha === e.historicalSha &&
      seed.response.head_branch === e.defaultBranch &&
      seed.response.display_title === "recovery-fence-historical-seed",
    "historical seed lineage mismatch",
  )
  before(initialBranch, seedRequest)
  before(historicalContent, seedRequest)
  before(seedRequest, seed)
  before(seed, seedJobs.call)
  const advanced = branch(s.advancedBranchCall, e.currentSha),
    currentContent = content(s.currentFixtureCall, "current", e.currentSha)
  before(seedJobs.call, advanced)
  before(advanced, currentContent)
  const tag = (reference, name, source) => {
    const c = call(reference, "GET", `${base}/git/ref/tags/${name}`)
    fenceRequire(
      c.response?.ref === `refs/tags/${name}` &&
        c.response.object?.type === "commit" &&
        c.response.object.sha === source,
      "lightweight tag target mismatch",
    )
    return c
  }
  const currentTag = tag(s.currentTagCall, e.currentTag, e.currentSha),
    historicalTag = tag(s.historicalTagCall, e.historicalTag, e.historicalSha)
  before(currentContent, currentTag)
  before(currentTag, historicalTag)
  fenceExact(e.transitions, "disableCall enableCall")
  fenceExact(e.restoration, "workflowCall finalInventoryCalls")
  fenceRequire(Array.isArray(e.cases) && e.cases.length === 36, "exact 36 service cases required")
  let last = historicalTag,
    index = 0
  const requestIds = new Set(),
    dispatchIds = new Set([recoveryId(seed.response.id)])
  for (const stage of ["active-before", "disabled", "active-after"]) {
    if (stage !== "active-before") {
      const c = call(
        e.transitions[stage === "disabled" ? "disableCall" : "enableCall"],
        "PUT",
        `${wf}/${stage === "disabled" ? "disable" : "enable"}`,
        [204],
      )
      fenceRequire(c.response === null, "empty transition response required")
      before(last, c)
      last = c
    }
    for (const context of ["current-default", "current-tag", "historical"])
      for (const method of ["dispatch", "all", "failed", "job"]) {
        const c = e.cases[index++]
        fenceExact(
          c,
          "context stage method requestId stateBeforeCall branchBeforeCall beforeInventoryCalls requestCall targetRunCall targetJobsCall runAfterCall jobsAfterCall afterInventoryCalls stateAfterCall branchAfterCall",
        )
        fenceRequire(
          c.stage === stage && c.context === context && c.method === method,
          "finite case matrix order required",
        )
        fenceRequire(
          typeof c.requestId === "string" &&
            /^[a-z0-9-]{1,128}$/u.test(c.requestId) &&
            !requestIds.has(c.requestId),
          "unique request correlation required",
        )
        requestIds.add(c.requestId)
        const expectedState = stage === "disabled" ? "disabled_manually" : "active"
        const stateBefore = state(c.stateBeforeCall, expectedState),
          branchBefore = branch(c.branchBeforeCall, e.currentSha),
          beforeInv = inventory(c.beforeInventoryCalls)
        before(last, stateBefore)
        before(stateBefore, branchBefore)
        before(branchBefore, beforeInv.first)
        const source = context === "historical" ? e.historicalSha : e.currentSha,
          ref =
            context === "current-default"
              ? e.defaultBranch
              : context === "current-tag"
                ? e.currentTag
                : e.historicalTag
        let target = null,
          targetJobs = null,
          preRequest = beforeInv.last
        if (method === "dispatch")
          fenceRequire(
            c.targetRunCall === null && c.targetJobsCall === null,
            "dispatch has no rerun target",
          )
        else {
          target = run(c.targetRunCall)
          targetJobs = jobs(c.targetJobsCall, target.response)
          before(beforeInv.last, target)
          before(target, targetJobs.call)
          preRequest = targetJobs.call
          fenceRequire(
            target.response.head_sha === source &&
              target.response.head_branch === (context === "historical" ? e.defaultBranch : ref),
            "rerun source/ref mismatch",
          )
          if (context === "historical")
            fenceRequire(
              recoveryId(target.response.id) === recoveryId(seed.response.id),
              "historical rerun must preserve pre-advance seed lineage",
            )
          const priorRun = beforeInv.records.find(
            (r) => recoveryId(r.id) === recoveryId(target.response.id),
          )
          fenceRequire(priorRun, "rerun target not in prior inventory")
          fenceSame(
            fenceTerminalRuns([priorRun], e),
            fenceTerminalRuns([target.response], e),
            "rerun target not in prior inventory",
          )
          for (const key of ["head_sha", "head_branch", "workflow_id", "event", "path"])
            fenceSame(priorRun[key], target.response[key], "rerun target source mismatch")
        }
        const requestPath =
          method === "dispatch"
            ? `${wf}/dispatches`
            : method === "job"
              ? `${base}/actions/jobs/${recoveryId(targetJobs.writer.id)}/rerun`
              : `${base}/actions/runs/${recoveryId(target.response.id)}/${method === "all" ? "rerun" : "rerun-failed-jobs"}`
        const request = call(
          c.requestCall,
          "POST",
          requestPath,
          stage === "disabled" ? [403, 404, 409, 422] : method === "dispatch" ? [200] : [201],
        )
        before(preRequest, request)
        if (method === "dispatch")
          fenceSame(
            request.body,
            { ref, inputs: { probe_id: c.requestId } },
            "dispatch request correlation mismatch",
          )
        else fenceRequire(request.body === null, "rerun request body must be null")
        let after = null,
          executed = request
        if (stage === "disabled")
          fenceRequire(
            c.runAfterCall === null && c.jobsAfterCall === null,
            "denied request cannot claim new execution",
          )
        else {
          after = run(c.runAfterCall)
          const afterJobs = jobs(c.jobsAfterCall, after.response, request)
          before(request, after)
          before(after, afterJobs.call)
          executed = afterJobs.call
          fenceRequire(after.response.head_sha === source, "executed source mismatch")
          if (method === "dispatch") {
            const runId = recoveryId(after.response.id)
            fenceRequire(
              recoveryId(request.response?.workflow_run_id) === runId &&
                !dispatchIds.has(runId) &&
                after.response.run_attempt === 1 &&
                after.response.head_branch === ref &&
                after.response.display_title === `recovery-fence-${c.requestId}`,
              "direct dispatch correlation required",
            )
            dispatchIds.add(runId)
          } else {
            fenceRequire(
              (request.response === null ||
                (typeof request.response === "object" &&
                  !Array.isArray(request.response) &&
                  Object.keys(request.response).length === 0)) &&
                recoveryId(after.response.id) === recoveryId(target.response.id) &&
                after.response.run_attempt === target.response.run_attempt + 1,
              "rerun must advance exactly one attempt",
            )
            for (const key of ["head_branch", "head_sha", "display_title"])
              fenceSame(after.response[key], target.response[key], "rerun lineage changed")
          }
        }
        const afterInv = inventory(c.afterInventoryCalls),
          stateAfter = state(c.stateAfterCall, expectedState),
          branchAfter = branch(c.branchAfterCall, e.currentSha)
        before(executed, afterInv.first)
        before(afterInv.last, stateAfter)
        before(stateAfter, branchAfter)
        if (stage === "disabled") {
          fenceRequire(
            timestamp(afterInv.first.startedAt) - timestamp(request.finishedAt) >= 5000,
            "five-second settled denial required",
          )
          fenceSame(beforeInv.identity, afterInv.identity, "denied request changed inventory")
        } else {
          const expected = beforeInv.records.filter(
            (r) => recoveryId(r.id) !== recoveryId(after.response.id),
          )
          expected.push(after.response)
          fenceSame(
            inventorySourceIdentity(expected),
            inventorySourceIdentity(afterInv.records),
            "positive control inventory correlation mismatch",
          )
        }
        last = branchAfter
      }
  }
  const restored = state(e.restoration.workflowCall, "active"),
    final = inventory(e.restoration.finalInventoryCalls)
  before(last, restored)
  before(restored, final.first)
  fenceRequire(used.size === calls.size, "unreferenced/unsupported service calls forbidden")
  return e
}

// Retain the full raw polling/setup ledger separately. The proof contains only
// referenced calls, in original order, and the response fields validated above.
// Projection preserves their values and every collection item; it invents no data.
export function projectRecoveryFenceEvidence(rawCalls, witness, options) {
  witness = snapshotRecoveryData(witness, 128 * 1024)
  fenceRequire(
    !types.isProxy(rawCalls) &&
      Array.isArray(rawCalls) &&
      Object.getPrototypeOf(rawCalls) === Array.prototype &&
      rawCalls.length <= 10000 &&
      !Object.hasOwn(witness, "calls"),
    "bounded raw ledger and witness metadata required",
  )
  const entries = Object.getOwnPropertyDescriptors(rawCalls)
  fenceRequire(
    Reflect.ownKeys(entries).length === rawCalls.length + 1,
    "dense raw call array required",
  )
  const references = new Set()
  const add = (value) => {
    if (Array.isArray(value)) value.forEach(add)
    else if (value !== null) {
      fenceRequire(typeof value === "string", "call reference required")
      references.add(value)
    }
  }
  for (const value of Object.values(witness.setup)) add(value)
  for (const value of Object.values(witness.transitions)) add(value)
  for (const value of Object.values(witness.restoration)) add(value)
  for (const c of witness.cases)
    for (const key of [
      "stateBeforeCall",
      "branchBeforeCall",
      "beforeInventoryCalls",
      "requestCall",
      "targetRunCall",
      "targetJobsCall",
      "runAfterCall",
      "jobsAfterCall",
      "afterInventoryCalls",
      "stateAfterCall",
      "branchAfterCall",
    ])
      add(c[key])
  const seen = new Set(),
    calls = []
  let rawBytes = 2
  for (let index = 0; index < rawCalls.length; index++) {
    const entry = entries[index]
    fenceRequire(
      entry && Object.hasOwn(entry, "value") && entry.enumerable,
      "raw call data required",
    )
    // Retain the ledger separately. Snapshot each bounded API response before
    // projecting: aggregate GitHub metadata must not consume the evidence's
    // node budget, and omitted calls still receive the same input validation.
    const c = snapshotRecoveryData(entry.value, 2 * 1024 * 1024)
    rawBytes += Buffer.byteLength(JSON.stringify(c)) + 1
    fenceRequire(rawBytes <= 32 * 1024 * 1024, "raw ledger byte bound")
    fenceRequire(typeof c.id === "string" && !seen.has(c.id), "unique raw call IDs required")
    seen.add(c.id)
    if (references.has(c.id)) calls.push({ ...c, response: projectFenceResponse(c, witness) })
  }
  fenceRequire(calls.length === references.size, "missing raw witness call")
  return validateRecoveryFenceEvidence(fenceCanonical({ ...witness, calls }), options)
}

// Preserve every field consumed by validation, every array item and its order.
// This is a projection of observations, never normalization of their values.
function projectFenceResponse(call, witness) {
  if (call.method !== "GET" || call.status !== 200) return call.response
  const pick = (value, keys) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          keys
            .split(" ")
            .filter((key) => Object.hasOwn(value, key))
            .map((key) => [key, value[key]]),
        )
      : value
  const map = (value, project) => (Array.isArray(value) ? value.map(project) : value)
  const run = (value) => {
    const result = pick(
      value,
      "id run_attempt status conclusion head_sha head_branch event workflow_id path repository display_title",
    )
    if (result && Object.hasOwn(result, "repository"))
      result.repository = pick(result.repository, "id full_name")
    return result
  }
  const job = (value) => {
    const result = pick(value, "id run_id run_attempt head_sha name status conclusion steps")
    if (result && Object.hasOwn(result, "steps"))
      result.steps = map(result.steps, (step) =>
        pick(step, "name status conclusion number started_at completed_at"),
      )
    return result
  }
  const base = `/repos/${witness.repository}`
  const workflow = `${base}/actions/workflows/${witness.workflowId}`
  const value = call.response
  if (call.path === base) return pick(value, "id full_name default_branch")
  if (call.path.startsWith(`${base}/contents/`)) return pick(value, "path encoding content")
  if (call.path.startsWith(`${base}/git/ref/`)) {
    const result = pick(value, "ref object")
    if (result && Object.hasOwn(result, "object")) result.object = pick(result.object, "type sha")
    return result
  }
  if (call.path === workflow) return pick(value, "id path state")
  if (call.path.startsWith(`${workflow}/runs?`)) {
    const result = pick(value, "total_count workflow_runs")
    if (result && Object.hasOwn(result, "workflow_runs"))
      result.workflow_runs = map(result.workflow_runs, run)
    return result
  }
  if (call.path.startsWith(`${base}/actions/runs/`)) {
    if (call.path.includes("/jobs?")) {
      const result = pick(value, "total_count jobs")
      if (result && Object.hasOwn(result, "jobs")) result.jobs = map(result.jobs, job)
      return result
    }
    return run(value)
  }
  return value
}
