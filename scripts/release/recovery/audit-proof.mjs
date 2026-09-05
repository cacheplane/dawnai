// Shared read-only audit proof; no controller or writer dependency.
import { createHash } from "node:crypto"
import { extractActionsArtifactZip } from "../artifact-store.mjs"
import {
  canonicalRecoveryBytes,
  parseRecovery,
  RECOVERY_LIMITS,
  recoveryApiTimestampRange,
} from "./schema.mjs"
export const RECOVERY_AUDIT_WORKFLOW = ".github/workflows/release-postpublication-audit.yml"
export const RECOVERY_AUDIT_CHECKS = Object.freeze([
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
])
export const auditInventoryHash = (inventory) =>
  auditHash(
    `${JSON.stringify(inventory.map(({ assetName, id, sha256, size }) => ({ assetName, id, sha256, size })))}\n`,
  )
export const auditHash = (b) => createHash("sha256").update(b).digest("hex")
export const auditSame = (a, b, message) => {
  const stable = (v) =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v
  auditRequire(JSON.stringify(stable(a)) === JSON.stringify(stable(b)), message)
}
export function auditRequire(ok, message) {
  if (!ok) throw new Error(`Recovery audit blocked: ${message}`)
}
export const auditSort = (refs) =>
  [...refs].sort((a, b) => (a.assetName < b.assetName ? -1 : a.assetName > b.assetName ? 1 : 0))
export const auditName = (value) =>
  `recovery-v2-audit-${value.kind.slice("recovery-audit-".length)}-${value.requestId ?? value.result.sha256}.json`
export const auditArtifactName = (executor) =>
  `recovery-v2-audit-result-${executor.runId}-${executor.runAttempt}-${executor.jobId}`
export function auditInventory(facts) {
  return auditSort([
    ...facts.adoption.receipt.baseAssets,
    facts.adoption.receipt.archive,
    ...facts.adoption.receipt.retainedAttempts,
    facts.adoption.ref,
    ...facts.verification.set.lanes.map((l) => l.receipt),
    ...facts.verification.set.retainedReceipts,
    facts.verification.ref,
  ])
}
export function verifyAuditIntent(intent, facts) {
  parseRecovery(intent, {
    kind: "recovery-audit-intent",
    candidate: facts.candidate,
  })
  auditSame(intent.policySha256, facts.policySha256, "intent policy differs")
  auditSame(
    intent.expectedAuditorSha,
    intent.executor.controllerSha,
    "auditor must pin reviewed dispatch revision",
  )
  auditSame(
    intent.verificationSetSha256,
    facts.verification.ref.sha256,
    "selected verification set differs",
  )
  auditSame(intent.inventory, auditInventory(facts), "exact audited inventory differs")
}
// Only structurally complete API identities can establish a foreign run. A failed
// read or malformed identity is unavailable proof, never a classified mismatch.
export async function inspectAuditRun(candidate, intent, runId, read) {
  const apiId = (value) =>
    typeof value === "number"
      ? Number.isSafeInteger(value) && value > 0
      : typeof value === "string" && /^[1-9][0-9]{0,31}$/u.test(value)
  const workflowPath = (value) =>
    typeof value === "string" &&
    /^\.github\/workflows\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.ya?ml$/u.test(value)
  const run = await read("getActionsRunAttempt", { runId, attempt: "1" })
  auditRequire(
    run &&
      apiId(run.id) &&
      apiId(run.run_attempt) &&
      apiId(run.workflow_id) &&
      typeof run.head_sha === "string" &&
      /^[a-f0-9]{40}$/u.test(run.head_sha) &&
      workflowPath(run.path) &&
      typeof run.event === "string" &&
      run.event.length > 0 &&
      typeof run.head_branch === "string" &&
      run.head_branch.length > 0 &&
      apiId(run.repository?.id) &&
      typeof run.repository?.full_name === "string" &&
      /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(run.repository.full_name),
    "complete audit run identity unavailable",
  )
  if (run.head_sha !== intent.expectedAuditorSha)
    return { run, classification: "unexpected-auditor-sha" }
  if (
    String(run.id) !== runId ||
    String(run.run_attempt) !== "1" ||
    run.path !== RECOVERY_AUDIT_WORKFLOW ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    String(run.repository.id) !== candidate.repositoryId ||
    run.repository.full_name !== candidate.repository
  )
    return { run, classification: "foreign-run" }
  const workflow = await read("getWorkflow", {
    workflow: RECOVERY_AUDIT_WORKFLOW.split("/").at(-1),
  })
  auditRequire(
    workflow && apiId(workflow.id) && workflowPath(workflow.path),
    "complete audit workflow identity unavailable",
  )
  return {
    run,
    classification:
      String(workflow.id) !== String(run.workflow_id) || workflow.path !== run.path
        ? "foreign-run"
        : null,
  }
}
export async function observeAuditRun(candidate, intent, runId, read, completed = false) {
  const { run, classification } = await inspectAuditRun(candidate, intent, runId, read)
  auditRequire(
    classification === null,
    classification === "unexpected-auditor-sha"
      ? "unexpected auditor SHA"
      : "foreign audit run identity",
  )
  if (completed)
    auditRequire(
      run.status === "completed" && run.conclusion === "success",
      "audit run not successful",
    )
  return run
}
export function verifyAuditResult(result, intent, dispatch) {
  parseRecovery(result, {
    kind: "recovery-audit-result",
    candidate: intent.candidate,
  })
  auditSame(result.policySha256, intent.policySha256, "audit policy differs")
  auditSame(result.requestId, intent.requestId, "audit request differs")
  auditSame(result.verificationSetSha256, intent.verificationSetSha256, "audited selection differs")
  auditSame(
    result.inventorySha256,
    auditInventoryHash(intent.inventory),
    "audited inventory differs",
  )
  auditRequire(
    result.executor.controllerSha === intent.expectedAuditorSha &&
      result.executor.workflow === RECOVERY_AUDIT_WORKFLOW &&
      result.executor.runId === dispatch.runId &&
      result.executor.runAttempt === "1",
    "audit executor differs",
  )
  auditRequire(
    result.conclusion === "success" &&
      RECOVERY_AUDIT_CHECKS.every((name) =>
        result.checks.some((c) => c.name === name && c.conclusion === "success"),
      ),
    "mandatory audit checks missing or failed",
  )
}
// Same terminal conclusion vocabulary as the production Actions observer, excluding
// success. Missing or unknown conclusions establish no immutable failure evidence.
const AUDIT_FAILURE_CONCLUSIONS = Object.freeze([
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
])
export function isAuditTerminalFailure(run) {
  return run.status === "completed" && AUDIT_FAILURE_CONCLUSIONS.includes(run.conclusion)
}
export async function readAuditArtifact(candidate, intent, dispatch, read) {
  const run = await observeAuditRun(candidate, intent, dispatch.runId, read)
  if (run.status !== "completed") return { missing: "Audit pending" }
  if (run.conclusion !== "success") {
    auditRequire(isAuditTerminalFailure(run), "terminal audit conclusion unavailable")
    return { failure: "failed-audit" }
  }
  const jobs = await read("listActionsRunJobs", { runId: dispatch.runId })
  const matches = jobs.filter((j) => j.name === "recovery-audit" && String(j.runAttempt) === "1")
  auditRequire(matches.length === 1, "unique audit job required")
  const job = matches[0]
  auditRequire(job.status === "completed" && job.conclusion === "success", "audit job failed")
  const executor = {
    ...intent.executor,
    workflow: RECOVERY_AUDIT_WORKFLOW,
    runId: dispatch.runId,
    runAttempt: "1",
    jobId: String(job.id),
  }
  const name = auditArtifactName(executor)
  const artifacts = await read("listActionsRunArtifacts", {
    runId: dispatch.runId,
  })
  auditRequire(
    Array.isArray(artifacts) && artifacts.length <= RECOVERY_LIMITS.retainedAssets,
    "bounded audit artifacts required",
  )
  auditRequire(
    artifacts
      .filter((a) =>
        a.name.startsWith(`recovery-v2-audit-result-${executor.runId}-${executor.runAttempt}-`),
      )
      .every((a) => a.name === name),
    "foreign audit artifact job",
  )
  const selected = artifacts.filter((a) => a.name === name)
  auditRequire(selected.length <= 1, "ambiguous audit artifact")
  if (!selected.length) return { missing: "Missing audit result" }
  const artifact = await read("getActionsArtifact", {
    artifactId: String(selected[0].id),
  })
  auditSame(artifact, selected[0], "audit artifact list/detail differs")
  const source = artifact.workflow_run
  auditRequire(
    source &&
      String(source.id) === executor.runId &&
      String(source.repository_id) === candidate.repositoryId &&
      String(source.head_repository_id) === candidate.repositoryId &&
      source.head_sha === executor.controllerSha &&
      source.head_branch === "main",
    "foreign audit artifact",
  )
  auditRequire(
    artifact.expired === false &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= RECOVERY_LIMITS.selectionBytes &&
      /^sha256:[a-f0-9]{64}$/u.test(artifact.digest),
    "audit artifact unavailable",
  )
  const encoded = await read("downloadActionsArtifact", {
    artifactId: String(artifact.id),
    maximumBytes: artifact.size_in_bytes,
  })
  const bytes = Buffer.from(encoded, "base64")
  auditRequire(
    bytes.toString("base64") === encoded &&
      bytes.length === artifact.size_in_bytes &&
      `sha256:${auditHash(bytes)}` === artifact.digest,
    "audit ZIP digest differs",
  )
  const files = extractActionsArtifactZip(bytes, {
    maxOutputBytes: RECOVERY_LIMITS.receiptBytes,
  })
  auditRequire(
    files.length === 1 && files[0].name === `${name}.json`,
    "exact audit ZIP membership required",
  )
  const result = parseRecovery(files[0].bytes, {
    kind: "recovery-audit-result",
    candidate,
    executor,
  })
  auditRequire(
    canonicalRecoveryBytes(result).equals(files[0].bytes),
    "canonical audit bytes required",
  )
  verifyAuditResult(result, intent, dispatch)
  for (const stamp of [artifact.created_at, artifact.updated_at])
    auditRequire(
      recoveryApiTimestampRange(job.startedAt)[0] <= recoveryApiTimestampRange(stamp)[1] &&
        recoveryApiTimestampRange(stamp)[0] <= recoveryApiTimestampRange(job.completedAt)[1],
      "audit artifact timing differs",
    )
  return {
    result,
    contentBase64: files[0].bytes.toString("base64"),
    artifact: {
      id: String(artifact.id),
      serviceDigest: artifact.digest,
      name,
      size: artifact.size_in_bytes,
      workflowId: String(run.workflow_id),
      createdAt: artifact.created_at,
      updatedAt: artifact.updated_at,
      jobStartedAt: job.startedAt,
      jobCompletedAt: job.completedAt,
    },
  }
}
export function auditHasFailed(facts) {
  return (
    facts.audit &&
    facts.auditBookkeeping.some(
      (e) =>
        e.receipt.kind === "recovery-audit-attempt" &&
        e.receipt.intentSha256 === facts.audit.intentRef.sha256 &&
        e.receipt.runId === facts.audit.dispatch.runId &&
        e.receipt.classification === "failed-audit",
    )
  )
}
export function selectAuditDispatch(facts, ref) {
  const dispatch = facts.auditBookkeeping.find(
    (e) => e.receipt.kind === "recovery-audit-dispatch" && e.ref.assetName === ref.assetName,
  )
  auditRequire(dispatch, "persisted retry dispatch required")
  auditSame(dispatch.ref, ref, "retry dispatch reference differs")
  const intent = facts.auditBookkeeping.find(
    (e) =>
      e.receipt.kind === "recovery-audit-intent" && e.ref.sha256 === dispatch.receipt.intentSha256,
  )
  auditRequire(intent, "persisted retry intent required")
  verifyAuditIntent(intent.receipt, facts)
  return {
    intent: intent.receipt,
    intentRef: intent.ref,
    dispatch: dispatch.receipt,
    dispatchRef: dispatch.ref,
    result: null,
    resultRef: null,
  }
}

export async function verifyAuditEscrowProducer(escrow, c, read, now) {
  const producer = escrow.executor
  const producerRun = await read("getActionsRunAttempt", {
    runId: producer.runId,
    attempt: producer.runAttempt,
  })
  auditRequire(
    String(producerRun.id) === producer.runId &&
      String(producerRun.run_attempt) === producer.runAttempt &&
      producerRun.head_sha === producer.controllerSha &&
      producerRun.head_branch === "main" &&
      producerRun.path === producer.workflow &&
      producerRun.event === "workflow_dispatch" &&
      ["in_progress", "completed"].includes(producerRun.status) &&
      String(producerRun.repository?.id) === c.repositoryId &&
      producerRun.repository?.full_name === c.repository,
    "audit escrow producer run differs",
  )
  const producerJobs = await read("listActionsRunJobs", {
    runId: producer.runId,
  })
  auditRequire(
    producerJobs.filter(
      (job) =>
        String(job.id) === producer.jobId &&
        String(job.runAttempt) === producer.runAttempt &&
        job.name === "recovery-audit-evidence" &&
        ["in_progress", "completed"].includes(job.status) &&
        recoveryApiTimestampRange(job.startedAt)[0] <= Date.parse(escrow.validatedAt) &&
        (job.completedAt === null ||
          recoveryApiTimestampRange(job.completedAt)[1] >= Date.parse(escrow.validatedAt)),
    ).length === 1,
    "audit escrow producer job differs",
  )
  auditRequire(Date.parse(escrow.validatedAt) <= now, "audit escrow in future")
}

export async function requireActiveAuditWorkflow(read) {
  const workflow = await read("getWorkflow", {
    workflow: RECOVERY_AUDIT_WORKFLOW.split("/").at(-1),
  })
  auditRequire(
    workflow.path === RECOVERY_AUDIT_WORKFLOW &&
      workflow.state === "active" &&
      /^[1-9][0-9]*$/u.test(String(workflow.id)),
    "active audit workflow required",
  )
}
