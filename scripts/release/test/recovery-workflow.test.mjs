import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { parse } from "yaml"
import { planRecovery, verifyRecoveryObservedPhase } from "../recovery/model.mjs"
import { recoveryFacts } from "./support/recovery-fixture.mjs"

const graph = await import("../recovery/workflow.mjs").catch(() => ({}))
const cli = await import("../recovery/cli.mjs")
const phases = [
  "NPM_COMPLETE",
  "RECOVERY_ADOPTED",
  "VERIFICATION_COMPLETE",
  "AUDIT_PENDING",
  "AUDIT_VERIFIED",
  "PUBLICATION_READY",
  "COMPLETE",
]
for (const [index, phase] of phases.entries())
  test(`workflow resume selects durable ${phase} phase`, () => {
    assert.equal(typeof graph.planRecoveryWorkflow, "function")
    const facts = recoveryFacts({ phase })
    facts.assets = facts.fresh.assets
    if (["NPM_COMPLETE", "RECOVERY_ADOPTED"].includes(phase)) facts.verification = null
    const observed = {
      phase,
      outcome: phase === "COMPLETE" ? "complete" : "recovery-required",
      terminal: phase === "COMPLETE",
      facts,
      errors: [],
    }
    if (!["NPM_COMPLETE", "COMPLETE"].includes(phase))
      assert.equal(verifyRecoveryObservedPhase(facts), phase)
    if (phase === "COMPLETE") assert.equal(planRecovery(facts).outcome, "complete")
    const p = graph.planRecoveryWorkflow(observed)
    assert.equal(p.smoke, index <= 1)
    assert.equal(p.evidence, index <= 1)
    assert.equal(p.dispatch, index <= 3)
    assert.equal(p.audit, index <= 3)
    assert.equal(p.finalize, index <= 5)
    assert.equal(p.publish, index <= 5)
  })
test("verified fixed finalization with corrupt display selects repair without smoke", () => {
  const facts = recoveryFacts({ phase: "PUBLICATION_READY" })
  facts.assets = facts.fresh.assets
  facts.marker = null
  assert.equal(verifyRecoveryObservedPhase(facts), "UNKNOWN")
  const p = graph.planRecoveryWorkflow({
    phase: "UNKNOWN",
    outcome: "recovery-required",
    facts,
    errors: [],
  })
  assert.equal(p.finalize, true)
  assert.equal(p.publish, true)
  assert.equal(p.smoke, false)
  facts.finalization.ref.sha256 = "0".repeat(64)
  assert.throws(() =>
    graph.planRecoveryWorkflow({
      phase: "UNKNOWN",
      outcome: "recovery-required",
      facts,
      errors: [],
    }),
  )
})
test("report exits zero only for fresh complete proof; empty, pending and skipped required work fail", () => {
  assert.equal(typeof cli.recoveryCommandExitCode, "function")
  const needs = Object.fromEntries(
    Object.keys(graph.RECOVERY_WORKFLOW_NEEDS).map((job) => [job, { result: "success" }]),
  )
  for (const phase of phases.slice(0, -1))
    assert.equal(cli.recoveryCommandExitCode("report", { phase, errors: [], facts: {} }, needs), 1)
  assert.equal(
    cli.recoveryCommandExitCode(
      "report",
      { phase: "COMPLETE", outcome: "complete", terminal: true, errors: [], facts: {} },
      needs,
    ),
    1,
  )
  const facts = recoveryFacts({ phase: "COMPLETE" })
  facts.assets = facts.fresh.assets
  const complete = { phase: "COMPLETE", outcome: "complete", terminal: true, errors: [], facts }
  assert.equal(cli.recoveryCommandExitCode("report", complete, needs), 0)
  needs["recovery-adopt"].result = "skipped"
  assert.equal(cli.recoveryCommandExitCode("report", complete, needs), 1)
})
test("owner workflow graph pins checkouts, authority jobs, all required dependencies and always report", async () => {
  const source = await readFile(
    new URL("../../../.github/workflows/release-postpublication.yml", import.meta.url),
    "utf8",
  )
  const workflow = parse(source)
  assert.equal(typeof validateRecoveryWorkflow, "function")
  validateRecoveryWorkflow(workflow)
  const missing = structuredClone(workflow)
  missing.jobs["recovery-evidence"].needs.pop()
  assert.throws(() => validateRecoveryWorkflow(missing))
  const noReport = structuredClone(workflow)
  noReport.jobs["recovery-report"].if = "success()"
  assert.throws(() => validateRecoveryWorkflow(noReport))
})

function validateRecoveryWorkflow(workflow) {
  assert.deepEqual(workflow.concurrency, {
    group: "dawn-release-controller",
    "cancel-in-progress": false,
    queue: "max",
  })
  assert.deepEqual(
    Object.keys(workflow.jobs).sort(),
    [...Object.keys(graph.RECOVERY_WORKFLOW_NEEDS), "recovery-report"].sort(),
  )
  for (const [job, needs] of Object.entries(graph.RECOVERY_WORKFLOW_NEEDS)) {
    assert.deepEqual(workflow.jobs[job].needs ?? [], needs)
    assert.equal(workflow.jobs[job].if, graph.recoveryWorkflowCondition(job))
  }
  assert.equal(workflow.jobs["recovery-report"].if, "always()")
  assert.deepEqual(
    workflow.jobs["recovery-report"].needs,
    Object.keys(graph.RECOVERY_WORKFLOW_NEEDS),
  )
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.name, name)
    assert.equal(job.permissions.actions, name === "recovery-dispatch-audit" ? "write" : "read")
    assert.equal(job.permissions["id-token"], undefined)
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
    assert.equal(checkout.with.ref, `\${{ github.sha }}`)
    assert.equal(checkout.with["persist-credentials"], false)
    for (const step of job.steps) if (step.run) assert.ok(!step.run.includes("${{ inputs."))
  }
}

test("auditor has exact inputs, independent concurrency, GET-only command and one result artifact", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../../.github/workflows/release-postpublication-audit.yml", import.meta.url),
      "utf8",
    ),
  )
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "expected_controller_sha",
    "intent_sha256",
    "release_id",
    "request_id",
  ])
  assert.notEqual(workflow.concurrency.group, "dawn-release-controller")
  const job = workflow.jobs["recovery-audit"]
  assert.equal(job.permissions.actions, "read")
  assert.equal(job.permissions.attestations, "read")
  assert.equal(job.permissions["id-token"], undefined)
  assert.equal(
    job.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref,
    `\${{ github.sha }}`,
  )
  assert.match(job.if, /github.ref == 'refs\/heads\/main'/)
  assert.match(job.if, /inputs.expected_controller_sha == github.sha/)
  for (const step of job.steps) {
    assert.equal(step.env?.DAWN_RECOVERY_POLICY_TOKEN, undefined)
    if (step.run) {
      assert.doesNotMatch(step.run, /\b(?:build|pack|publish|adopt|finalize)\b/)
      assert.ok(!step.run.includes("${{ inputs."))
    }
  }
  const upload = job.steps.find((step) => step.name === "Retain exact audit result")
  assert.equal(upload.if, "always()")
  assert.match(upload.with.path, /evidence_directory.*\/\*\.json$/)
  assert.equal(upload.with.overwrite, false)
})
