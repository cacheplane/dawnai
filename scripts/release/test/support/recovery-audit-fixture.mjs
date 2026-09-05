import assert from "node:assert/strict"
import { dispatchRecoveryAudit } from "../../recovery/audit.mjs"
import { collectRecoveryEvidence } from "../../recovery/evidence.mjs"
import { canonicalRecoveryBytes } from "../../recovery/schema.mjs"
import { evidenceRemote, zip } from "./recovery-evidence-fixture.mjs"
import { canonical, digest } from "./recovery-fixture.mjs"
export async function auditRemote() {
  const r = await evidenceRemote()
  await collectRecoveryEvidence(r.request, r.config, r.dependencies)
  r.effects.length = 0
  r.request = { ...r.request, requestId: "audit-new-1" }
  const transport = r.dependencies.fetchImpl
  r.dependencies.fetchImpl = async (url, options) => {
    if (!url.endsWith("/dispatches")) return transport(url, options)
    r.effects.push({ url, ...options })
    assert.equal(options.headers["X-GitHub-Api-Version"], "2026-03-10")
    const body = JSON.parse(options.body)
    assert.equal(body.ref, "main")
    assert.equal(Object.hasOwn(body, "return_run_details"), false)
    assert.ok(r.assets().some((a) => a.assetName.startsWith("recovery-v2-audit-intent-")))
    return new Response(
      JSON.stringify({
        workflow_run_id: 905,
        run_url: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/905",
        html_url: "https://github.com/cacheplane/dawnai/actions/runs/905",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  const read = r.args.github.getActionsRunAttempt
  r.auditRun = {
    id: 905,
    run_attempt: 1,
    head_sha: r.e.controllerSha,
    head_branch: "main",
    path: ".github/workflows/release-postpublication-audit.yml",
    workflow_id: 802,
    event: "workflow_dispatch",
    status: "in_progress",
    repository: { id: 901, full_name: r.c.repository },
  }
  r.args.github.getActionsRunAttempt = async (a) =>
    a.runId === "905" ? { status: "PRESENT", value: r.auditRun } : read(a)
  const workflow = r.args.github.getWorkflow
  r.args.github.getWorkflow = async (a) =>
    a.workflow === "release-postpublication-audit.yml"
      ? {
          status: "PRESENT",
          value: { id: 802, path: r.auditRun.path, state: "active" },
        }
      : workflow(a)
  return r
}
export async function auditResultRemote() {
  const r = await auditRemote()
  const pending = await dispatchRecoveryAudit(r.request, r.config, r.dependencies)
  r.effects.length = 0
  r.auditRun.status = "completed"
  r.auditRun.conclusion = "success"
  r.auditExecutor = {
    ...r.e,
    workflow: r.auditRun.path,
    runId: "905",
    runAttempt: "1",
    jobId: "906",
  }
  r.result = {
    schemaVersion: 2,
    kind: "recovery-audit-result",
    candidate: r.c,
    policySha256: pending.facts.policySha256,
    requestId: r.request.requestId,
    verificationSetSha256: pending.facts.verification.ref.sha256,
    inventorySha256: digest(canonical(pending.facts.audit.intent.inventory)),
    executor: r.auditExecutor,
    checks: [
      "admission",
      "annotated-tag",
      "asset-inventory",
      "attestations",
      "candidate",
      "cleanup",
      "dispatch-correlation",
      "original-payload",
      "registry-packages",
      "selected-evidence",
    ].map((name) => ({ name, conclusion: "success" })),
    conclusion: "success",
  }
  const jobs = r.args.github.listActionsRunJobs
  const ownerJobs = (await jobs({ runId: r.e.runId })).value.filter((job) => job.id !== 907)
  r.execution.jobId = "907"
  r.auditJob = {
    id: 906,
    runAttempt: 1,
    name: "recovery-audit",
    status: "completed",
    conclusion: "success",
    startedAt: "2026-09-04T10:03:00.000Z",
    completedAt: "2026-09-04T10:03:40.000Z",
  }
  r.args.github.listActionsRunJobs = async (a) =>
    a.runId === "905"
      ? { status: "PRESENT", value: [r.auditJob] }
      : a.runId === r.e.runId
        ? {
            status: "PRESENT",
            value: [
              ...ownerJobs,
              {
                id: 907,
                runAttempt: 1,
                name: "recovery-audit-evidence",
                status: "in_progress",
                startedAt: "2026-09-04T10:03:50.000Z",
                completedAt: null,
              },
            ],
          }
        : jobs(a)
  const name = "recovery-v2-audit-result-905-1-906"
  r.auditArtifact = {
    id: 999,
    name,
    size_in_bytes: 0,
    digest: "",
    expired: false,
    created_at: "2026-09-04T10:03:20.000Z",
    updated_at: "2026-09-04T10:03:20.000Z",
    workflow_run: {
      id: 905,
      repository_id: 901,
      head_repository_id: 901,
      head_sha: r.e.controllerSha,
      head_branch: "main",
    },
  }
  r.replaceResult = (value) => {
    r.auditBytes = zip([{ name: `${name}.json`, bytes: canonicalRecoveryBytes(value) }])
    r.auditArtifact.size_in_bytes = r.auditBytes.length
    r.auditArtifact.digest = `sha256:${digest(r.auditBytes)}`
  }
  r.replaceResult(r.result)
  const artifacts = r.args.github.listActionsRunArtifacts
  r.auditArtifacts = [r.auditArtifact]
  r.args.github.listActionsRunArtifacts = async (a) =>
    a.runId === "905" ? { status: "PRESENT", value: r.auditArtifacts } : artifacts(a)
  r.args.github.getActionsArtifact = async () => ({
    status: "PRESENT",
    value: r.auditArtifact,
  })
  r.args.github.downloadActionsArtifact = async () => ({
    status: "PRESENT",
    contentBase64: r.auditBytes.toString("base64"),
  })
  return r
}
