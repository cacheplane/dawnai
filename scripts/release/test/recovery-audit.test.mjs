import assert from "node:assert/strict"
import test from "node:test"
import { canonicalRecoveryBytes } from "../recovery/schema.mjs"
import {
  auditRemote as remote,
  auditResultRemote as resultRemote,
} from "./support/recovery-audit-fixture.mjs"
import { digest } from "./support/recovery-fixture.mjs"

const module = await import("../recovery/audit.mjs").catch(() => ({}))
async function dispatch(r) {
  assert.equal(typeof module.dispatchRecoveryAudit, "function")
  return module.dispatchRecoveryAudit(r.request, r.config, r.dependencies)
}
test("audit dispatch persists intent and directly correlated receipt before pending marker", async () => {
  const r = await remote()
  const result = await dispatch(r)
  assert.equal(result.phase, "AUDIT_PENDING")
  assert.equal(result.facts.audit.dispatch.runId, "905")
  assert.deepEqual(
    r.effects.map((e) => e.method),
    ["POST", "POST", "POST", "PATCH"],
  )
})
test("admission SHA mismatch has zero effects", async () => {
  const r = await remote()
  r.request.expectedControllerSha = "d".repeat(40)
  await assert.rejects(dispatch(r), /SHA|controller/)
  assert.equal(r.effects.length, 0)
})
for (const [name, mutate] of [
  [
    "unexpected auditor SHA",
    (r) => {
      r.auditRun.head_sha = "d".repeat(40)
    },
  ],
  [
    "foreign run",
    (r) => {
      r.auditRun.repository.id = 999
    },
  ],
])
  test(`${name} after dispatch retains a failed attempt without selecting`, async () => {
    const r = await remote()
    mutate(r)
    const result = await dispatch(r)
    assert.equal(result.phase, "VERIFICATION_COMPLETE")
    assert.equal(result.facts.audit, null)
    assert.ok(
      result.facts.auditBookkeeping.some((x) => x.receipt.kind === "recovery-audit-attempt"),
    )
    assert.equal(
      r.effects.some((e) => e.method === "PATCH"),
      false,
    )
  })
test("lost direct response is never redispatched with the same intent", async () => {
  const r = await remote()
  const transport = r.dependencies.fetchImpl
  r.dependencies.fetchImpl = async (...args) => {
    const result = await transport(...args)
    if (args[0].endsWith("/dispatches")) throw new Error("lost response")
    return result
  }
  await assert.rejects(dispatch(r), /uncertain|stopped/)
  const count = r.effects.filter((e) => e.url.endsWith("/dispatches")).length
  const result = await dispatch(r)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.filter((e) => e.url.endsWith("/dispatches")).length, count)
  assert.ok(result.facts.auditBookkeeping.some((x) => x.receipt.classification === "uncorrelated"))
})

async function reconcile(r) {
  assert.equal(typeof module.reconcileRecoveryAudit, "function")
  return module.reconcileRecoveryAudit(r.request, r.config, r.dependencies)
}
test("matching API artifact is escrowed before audit verification and survives expiry", async () => {
  const r = await resultRemote()
  const result = await reconcile(r)
  assert.equal(result.phase, "AUDIT_VERIFIED")
  assert.deepEqual(
    r.effects.map((e) => e.method),
    ["POST", "POST", "PATCH"],
  )
  r.auditArtifact.expired = true
  r.args.github.downloadActionsArtifact = async () => {
    throw new Error("expired")
  }
  const replay = await reconcile(r)
  assert.equal(replay.phase, "AUDIT_VERIFIED")
  assert.equal(r.effects.length, 3)
})
for (const [name, mutate] of [
  [
    "wrong selection",
    (r) => {
      r.replaceResult({ ...r.result, verificationSetSha256: "d".repeat(64) })
    },
  ],
  [
    "missing mandatory gate",
    (r) => {
      r.replaceResult({
        ...r.result,
        checks: r.result.checks.filter((c) => c.name !== "attestations"),
      })
    },
  ],
  [
    "foreign artifact",
    (r) => {
      r.auditArtifact.workflow_run.id = 999
    },
  ],
  [
    "foreign job",
    (r) => {
      r.auditJob.id = 999
    },
  ],
])
  test(`${name} cannot enter audit escrow`, async () => {
    const r = await resultRemote()
    mutate(r)
    await assert.rejects(reconcile(r))
    assert.equal(r.effects.length, 0)
  })
for (const state of ["failed", "missing", "pending"])
  test(`${state} audit never verifies`, async () => {
    const r = await resultRemote()
    if (state === "failed") r.auditRun.conclusion = "failure"
    if (state === "missing") r.auditArtifacts = []
    if (state === "pending") r.auditRun.status = "in_progress"
    const result = await reconcile(r)
    assert.equal(result.phase, "AUDIT_PENDING")
    assert.equal(
      r.effects.some((e) => e.method === "PATCH"),
      false,
    )
  })
test("read-only auditor checks fresh production evidence with separate invocation role", async () => {
  const r = await resultRemote()
  r.auditRun.status = "in_progress"
  r.auditJob.status = "in_progress"
  r.auditJob.completedAt = null
  const invocation = await r.dependencies.authority.readInvocation()
  r.dependencies.authority.readInvocation = async () => ({
    ...invocation,
    workflow: r.auditRun.path,
    runId: "905",
    runAttempt: "1",
    jobId: "906",
  })
  r.dependencies.authority.observeLegacyFence = async () => {
    throw new Error("auditor must not request writer authority")
  }
  assert.equal(typeof module.runRecoveryAudit, "function")
  const result = await module.runRecoveryAudit(r.request, {
    observation: r.args,
    authority: r.dependencies.authority,
  })
  assert.equal(result.conclusion, "success")
  assert.deepEqual(result.checks, r.result.checks)
  assert.equal(r.effects.length, 0)
})
test("process loss after direct run receipt but before dispatch persistence never guesses correlation", async () => {
  const r = await remote()
  const read = r.args.github.getActionsRunAttempt
  let lost = false
  r.args.github.getActionsRunAttempt = async (a) => {
    if (a.runId === "905" && !lost) {
      lost = true
      throw new Error("process lost after direct receipt")
    }
    return read(a)
  }
  await assert.rejects(dispatch(r))
  const count = r.effects.filter((e) => e.url.endsWith("/dispatches")).length
  const result = await dispatch(r)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(r.effects.filter((e) => e.url.endsWith("/dispatches")).length, count)
  assert.ok(result.facts.auditBookkeeping.some((e) => e.receipt.classification === "uncorrelated"))
})
test("ambiguous HTTP acceptance is retained without scanning recent audit runs", async () => {
  const r = await remote()
  const transport = r.dependencies.fetchImpl
  r.dependencies.fetchImpl = async (...args) => {
    const response = await transport(...args)
    return args[0].endsWith("/dispatches") ? new Response(null, { status: 204 }) : response
  }
  const runs = r.args.github.listWorkflowRuns
  r.args.github.listWorkflowRuns = async (a) => {
    assert.equal(a.workflow, "ci.yml")
    return runs(a)
  }
  await assert.rejects(dispatch(r), /uncertain/)
  await dispatch(r)
  assert.equal(r.effects.filter((e) => e.url.endsWith("/dispatches")).length, 1)
})
test("auditor cannot acquire owner mutation authority", async () => {
  const r = await remote()
  r.execution.workflow = ".github/workflows/release-postpublication-audit.yml"
  await assert.rejects(dispatch(r), /workflow/)
  assert.equal(r.effects.length, 0)
})
test("fresh request can replace a failed selected audit without regressing the phase", async () => {
  const r = await resultRemote()
  r.auditRun.conclusion = "failure"
  await reconcile(r)
  r.request.requestId = "audit-new-2"
  const first = r.auditRun
  const second = { ...first, id: 908, status: "in_progress", conclusion: null }
  const read = r.args.github.getActionsRunAttempt
  r.args.github.getActionsRunAttempt = async (a) =>
    a.runId === "908" ? { status: "PRESENT", value: second } : read(a)
  const transport = r.dependencies.fetchImpl
  r.dependencies.fetchImpl = async (...args) => {
    const response = await transport(...args)
    return args[0].endsWith("/dispatches")
      ? new Response(
          JSON.stringify({
            workflow_run_id: 908,
            run_url: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/908",
            html_url: "https://github.com/cacheplane/dawnai/actions/runs/908",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : response
  }
  const result = await dispatch(r)
  assert.equal(result.phase, "AUDIT_PENDING")
  assert.equal(result.facts.audit.dispatch.runId, "908")
  assert.ok(result.facts.auditBookkeeping.some((e) => e.receipt.classification === "failed-audit"))
})
async function writerUpload(r, value) {
  const { createRecoveryWriter } = await import("../recovery/writer.mjs")
  const { auditName } = await import("../recovery/audit-proof.mjs")
  const { requestId: _requestId, ...request } = r.request
  return createRecoveryWriter(r.config, r.dependencies).uploadRecoveryAsset({
    ...request,
    expectedBodySha256: digest(r.release.body),
    name: auditName(value),
    contentBase64: canonicalRecoveryBytes(value).toString("base64"),
  })
}
for (const state of ["success", "in_progress"])
  test(`${state} selected audit cannot be displaced by fabricated failure bookkeeping`, async () => {
    const r = await resultRemote()
    if (state === "in_progress") r.auditRun.status = "in_progress"
    const { observeRecoveryCandidate } = await import("../recovery/observe.mjs")
    const current = await observeRecoveryCandidate(r.args)
    const a = current.facts.audit
    await assert.rejects(
      writerUpload(r, {
        schemaVersion: 2,
        kind: "recovery-audit-attempt",
        candidate: r.c,
        policySha256: current.facts.policySha256,
        requestId: a.intent.requestId,
        intentSha256: a.intentRef.sha256,
        runId: a.dispatch.runId,
        expectedAuditorSha: a.intent.expectedAuditorSha,
        observedAuditorSha: a.intent.expectedAuditorSha,
        classification: "failed-audit",
        executor: { ...r.e, jobId: "907" },
      }),
      /did not fail/,
    )
    assert.equal(r.effects.length, 0)
  })
test("wrong escrow producer cannot persist a receipt before post-observation rejection", async () => {
  const r = await resultRemote()
  const jobs = r.args.github.listActionsRunJobs
  r.args.github.listActionsRunJobs = async (a) => {
    const result = await jobs(a)
    return {
      status: "PRESENT",
      value: result.value.map((j) => (j.id === 907 ? { ...j, name: "wrong-producer" } : j)),
    }
  }
  await assert.rejects(reconcile(r), /producer/)
  assert.equal(r.effects.length, 1) // The independently valid raw result may already be escrowed.
})
test("a fresh writer cannot redispatch an old immutable intent directly", async () => {
  const r = await remote()
  const transport = r.dependencies.fetchImpl
  r.dependencies.fetchImpl = async (...args) => {
    const res = await transport(...args)
    if (args[0].endsWith("/dispatches")) throw new Error("lost")
    return res
  }
  await assert.rejects(dispatch(r))
  const { createRecoveryWriter } = await import("../recovery/writer.mjs")
  const intentRef = r.assets().find((a) => a.assetName.startsWith("recovery-v2-audit-intent-"))
  const { requestId: _requestId, ...request } = r.request
  const count = r.effects.length
  await assert.rejects(
    createRecoveryWriter(r.config, r.dependencies).dispatchRecoveryAudit({
      ...request,
      expectedBodySha256: digest(r.release.body),
      intentRef,
    }),
    /fresh|invocation|intent/,
  )
  assert.equal(r.effects.length, count)
})
for (const failure of ["registry", "cleanup"])
  test(`read-only auditor emits an honest failed result when fresh ${failure} verification fails`, async () => {
    const r = await resultRemote()
    r.auditRun.status = "in_progress"
    r.auditJob.status = "in_progress"
    r.auditJob.completedAt = null
    const invocation = await r.dependencies.authority.readInvocation()
    r.dependencies.authority.readInvocation = async () => ({
      ...invocation,
      workflow: r.auditRun.path,
      runId: "905",
      runAttempt: "1",
      jobId: "906",
    })
    if (failure === "registry")
      r.args.npm.observePackageVersion = async () => ({ status: "ABSENT" })
    else {
      const factory = r.args.npmAuditFactory.create
      r.args.npmAuditFactory.create = async (...a) => {
        const verifier = await factory(...a)
        return {
          ...verifier,
          dispose: async () => {
            throw new Error("cleanup failed")
          },
        }
      }
    }
    const result = await module.runRecoveryAudit(r.request, {
      observation: r.args,
      authority: r.dependencies.authority,
    })
    assert.equal(result.conclusion, "failure")
    assert.notEqual(result.checks.find((c) => c.name === "cleanup").conclusion, "success")
    assert.equal(r.effects.length, 0)
  })
async function auditorInvocation(r) {
  r.auditRun.status = "in_progress"
  r.auditJob.status = "in_progress"
  r.auditJob.completedAt = null
  const invocation = await r.dependencies.authority.readInvocation()
  r.dependencies.authority.readInvocation = async () => ({
    ...invocation,
    workflow: r.auditRun.path,
    runId: "905",
    runAttempt: "1",
    jobId: "906",
  })
}
test("auditor waits for dispatch persistence when GitHub starts it before owner correlation", async () => {
  const r = await resultRemote()
  await auditorInvocation(r)
  const { parseRecoveryReleaseMarker, renderRecoveryReleaseBody } = await import(
    "../recovery/metadata.mjs"
  )
  const body = r.release.body,
    assets = [...r.assets()]
  const marker = parseRecoveryReleaseMarker(body)
  r.release.body = renderRecoveryReleaseBody({
    marker: { ...marker, phase: "VERIFICATION_COMPLETE", audit: null },
    body: "Original notes",
  })
  r.activate(assets.filter((a) => !a.assetName.startsWith("recovery-v2-audit-dispatch-")))
  let waits = 0
  r.dependencies.authority.sleep = async () => {
    waits++
    r.release.body = body
    r.activate(assets)
  }
  const result = await module.runRecoveryAudit(r.request, {
    observation: r.args,
    authority: r.dependencies.authority,
  })
  assert.equal(result.conclusion, "success")
  assert.equal(waits, 1)
  assert.equal(r.effects.length, 0)
})
test("auditor cannot accept production observation finishing after its shared phase deadline", async () => {
  const r = await resultRemote()
  await auditorInvocation(r)
  const start = r.dependencies.authority.now()
  let time = start
  r.dependencies.authority.now = () => time
  const release = r.args.github.getRelease
  r.args.github.getRelease = async (a) => {
    const result = await release(a)
    time = start + 1200001
    return result
  }
  const result = await module.runRecoveryAudit(r.request, {
    observation: r.args,
    authority: r.dependencies.authority,
  })
  assert.equal(result.conclusion, "failure")
  assert.equal(r.effects.length, 0)
})
test("disabled historical audit workflow preserves verified escrow", async () => {
  const r = await resultRemote()
  await reconcile(r)
  const workflow = r.args.github.getWorkflow
  r.args.github.getWorkflow = async (a) => {
    const result = await workflow(a)
    return a.workflow === "release-postpublication-audit.yml"
      ? { status: "PRESENT", value: { ...result.value, state: "disabled_manually" } }
      : result
  }
  const count = r.effects.length
  const result = await reconcile(r)
  assert.equal(result.phase, "AUDIT_VERIFIED")
  assert.equal(r.effects.length, count)
})
test("disabled audit workflow blocks new intent and dispatch", async () => {
  const r = await remote()
  const workflow = r.args.github.getWorkflow
  r.args.github.getWorkflow = async (a) => {
    const result = await workflow(a)
    return a.workflow === "release-postpublication-audit.yml"
      ? { status: "PRESENT", value: { ...result.value, state: "disabled_manually" } }
      : result
  }
  await assert.rejects(dispatch(r), /workflow/)
  assert.equal(r.effects.length, 0)
})
test("observer independently rejects a retained failure claim for a successful run", async () => {
  const r = await resultRemote()
  const { observeRecoveryCandidate } = await import("../recovery/observe.mjs")
  const { auditName } = await import("../recovery/audit-proof.mjs")
  const current = await observeRecoveryCandidate(r.args),
    a = current.facts.audit
  const receipt = {
    schemaVersion: 2,
    kind: "recovery-audit-attempt",
    candidate: r.c,
    policySha256: current.facts.policySha256,
    requestId: a.intent.requestId,
    intentSha256: a.intentRef.sha256,
    runId: a.dispatch.runId,
    expectedAuditorSha: a.intent.expectedAuditorSha,
    observedAuditorSha: a.intent.expectedAuditorSha,
    classification: "failed-audit",
    executor: { ...r.e, jobId: "907" },
  }
  const ref = r.add(auditName(receipt), canonicalRecoveryBytes(receipt).toString())
  r.activate([...r.assets(), ref])
  const observed = await observeRecoveryCandidate(r.args)
  assert.equal(observed.outcome, "blocked")
})
test("main advancing inside dispatch retains the unexpected-SHA attempt without selecting it", async () => {
  const r = await remote()
  const transport = r.dependencies.fetchImpl
  const readRef = r.args.github.getRef
  let advanced = false
  r.dependencies.fetchImpl = async (...args) => {
    const response = await transport(...args)
    if (args[0].endsWith("/dispatches")) {
      advanced = true
      r.auditRun.head_sha = "d".repeat(40)
    }
    return response
  }
  r.args.github.getRef = async (args) => {
    const response = await readRef(args)
    return advanced && args.ref === "heads/main"
      ? {
          status: "PRESENT",
          value: { ...response.value, object: { type: "commit", sha: "d".repeat(40) } },
        }
      : response
  }
  const result = await dispatch(r)
  assert.equal(result.phase, "VERIFICATION_COMPLETE")
  assert.equal(result.facts.audit, null)
  assert.ok(
    result.facts.auditBookkeeping.some(
      (e) => e.receipt.classification === "unexpected-auditor-sha",
    ),
  )
  assert.equal(
    r.effects.some((e) => e.method === "PATCH"),
    false,
  )
})
async function foreignAttempt(r) {
  const { observeRecoveryCandidate } = await import("../recovery/observe.mjs")
  const current = await observeRecoveryCandidate(r.args)
  const a = current.facts.audit
  return {
    schemaVersion: 2,
    kind: "recovery-audit-attempt",
    candidate: r.c,
    policySha256: current.facts.policySha256,
    requestId: a.intent.requestId,
    intentSha256: a.intentRef.sha256,
    runId: a.dispatch.runId,
    expectedAuditorSha: a.intent.expectedAuditorSha,
    observedAuditorSha: a.intent.expectedAuditorSha,
    classification: "foreign-run",
    executor: { ...r.e, jobId: "907" },
  }
}
test("transient workflow lookup cannot occupy a foreign-attempt filename or block later real failure", async () => {
  const r = await resultRemote()
  const receipt = await foreignAttempt(r)
  r.auditRun.status = "in_progress"
  const workflow = r.args.github.getWorkflow
  let calls = 0
  r.args.github.getWorkflow = async (args) => {
    if (args.workflow === "release-postpublication-audit.yml" && ++calls === 2)
      throw new Error("transient workflow lookup error")
    return workflow(args)
  }
  await assert.rejects(writerUpload(r, receipt), /unavailable|transient/)
  assert.equal(r.effects.length, 0)
  r.args.github.getWorkflow = workflow
  r.auditRun.status = "completed"
  r.auditRun.conclusion = "failure"
  const result = await reconcile(r)
  assert.equal(result.phase, "AUDIT_PENDING")
  assert.ok(result.facts.auditBookkeeping.some((e) => e.receipt.classification === "failed-audit"))
})
test("observer rejects a retained foreign-run claim without an actual identity mismatch", async () => {
  const r = await resultRemote()
  const receipt = await foreignAttempt(r)
  const { auditName } = await import("../recovery/audit-proof.mjs")
  const ref = r.add(auditName(receipt), canonicalRecoveryBytes(receipt).toString())
  r.activate([...r.assets(), ref])
  const { observeRecoveryCandidate } = await import("../recovery/observe.mjs")
  const observed = await observeRecoveryCandidate(r.args)
  assert.equal(observed.outcome, "blocked")
})
for (const conclusion of [null, undefined, "", "not-a-github-conclusion"])
  test(`completed audit conclusion ${String(conclusion)} is unavailable proof without effects`, async () => {
    const r = await resultRemote()
    if (conclusion === undefined) delete r.auditRun.conclusion
    else r.auditRun.conclusion = conclusion
    await assert.rejects(reconcile(r), /conclusion|unavailable/)
    assert.equal(r.effects.length, 0)
    r.auditRun.conclusion = "success"
    assert.equal((await reconcile(r)).phase, "AUDIT_VERIFIED")
  })
test("low-level writer cannot persist a failed-audit receipt from a null terminal conclusion", async () => {
  const r = await resultRemote()
  const receipt = { ...(await foreignAttempt(r)), classification: "failed-audit" }
  r.auditRun.conclusion = null
  await assert.rejects(writerUpload(r, receipt), /conclusion|did not fail|unavailable/)
  assert.equal(r.effects.length, 0)
  r.auditRun.conclusion = "failure"
  const result = await reconcile(r)
  assert.ok(result.facts.auditBookkeeping.some((e) => e.receipt.classification === "failed-audit"))
})
test("observer rejects a retained failed-audit claim when terminal conclusion is unknown", async () => {
  const r = await resultRemote()
  const receipt = { ...(await foreignAttempt(r)), classification: "failed-audit" }
  const { auditName } = await import("../recovery/audit-proof.mjs")
  const ref = r.add(auditName(receipt), canonicalRecoveryBytes(receipt).toString())
  r.activate([...r.assets(), ref])
  r.auditRun.conclusion = null
  const { observeRecoveryCandidate } = await import("../recovery/observe.mjs")
  assert.equal((await observeRecoveryCandidate(r.args)).outcome, "blocked")
})
test("retry cannot replace a selected audit whose terminal failure proof became unavailable", async () => {
  const r = await resultRemote()
  r.auditRun.conclusion = "failure"
  await reconcile(r)
  r.effects.length = 0
  r.auditRun.conclusion = null
  r.request.requestId = "retry-unknown-conclusion"
  await assert.rejects(dispatch(r), /conclusion|failure|unavailable/)
  assert.equal(r.effects.length, 0)
})
test("all known non-success Actions terminal conclusions remain admissible failure proof", async () => {
  const r = await resultRemote()
  for (const conclusion of [
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
  ]) {
    r.auditRun.conclusion = conclusion
    const result = await reconcile(r)
    assert.equal(result.phase, "AUDIT_PENDING")
    assert.ok(
      result.facts.auditBookkeeping.some((e) => e.receipt.classification === "failed-audit"),
    )
  }
  assert.equal(r.effects.length, 1)
})
