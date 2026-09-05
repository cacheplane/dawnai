import { types } from "node:util"
import {
  auditHasFailed,
  auditHash,
  auditInventory,
  auditInventoryHash,
  auditName,
  auditRequire,
  auditSame,
  inspectAuditRun,
  RECOVERY_AUDIT_CHECKS,
  readAuditArtifact,
  requireActiveAuditWorkflow,
  selectAuditDispatch,
  verifyAuditIntent,
} from "./audit-proof.mjs"
// Dormant orchestration. Only the guarded writer performs mutations.
import { captureRecoveryAuditor, captureRecoveryEligibility } from "./authority.mjs"
import { renderRecoveryReleaseBody } from "./metadata.mjs"
import {
  createRecoveryWorkBudget,
  normalizeRecoveryAssetInventory,
  observeRecoveryCandidate,
} from "./observe.mjs"
import { RECOVERY_RETRY, recoveryMethods, runRecoveryRead } from "./policy.mjs"
import {
  canonicalRecoveryBytes,
  parseRecovery,
  RECOVERY_LIMITS,
  snapshotRecoveryData,
} from "./schema.mjs"
import { createRecoveryWriter } from "./writer.mjs"

async function controller(request, config, dependencies) {
  dependencies = auditDependencies(dependencies, true)
  request = snapshotRecoveryData(request, 16384)
  auditRequire(
    Object.keys(request).sort().join(" ") ===
      "candidate expectedControllerSha intentPath requestId",
    "exact audit request required",
  )
  auditRequire(/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(request.requestId), "fresh request ID required")
  const writer = createRecoveryWriter(config, dependencies)
  const clock = recoveryMethods(dependencies.authority, ["now", "sleep"])
  const deadline = clock.now() + RECOVERY_RETRY.phaseDeadlineMs
  const budget = createRecoveryWorkBudget(
    { phaseDeadline: deadline },
    {
      now: clock.now,
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (t) => clearTimeout(t),
    },
  )
  const common = {
    candidate: request.candidate,
    expectedControllerSha: request.expectedControllerSha,
    intentPath: request.intentPath,
  }
  const observe = async () => {
    const r = await budget.work(() =>
      observeRecoveryCandidate({
        ...dependencies.observation,
        candidate: request.candidate,
        controllerRef: request.expectedControllerSha,
        intentPath: request.intentPath,
      }),
    )
    auditRequire(r.outcome !== "blocked", r.errors.join("; "))
    return r
  }
  const proof = await budget.work(() =>
    captureRecoveryEligibility(
      {
        candidate: request.candidate,
        expectedControllerSha: request.expectedControllerSha,
      },
      dependencies.authority,
    ),
  )
  const current = await observe()
  common.expectedBodySha256 = auditHash(Buffer.from(current.facts.release.body))
  const upload = (value) =>
    writer.uploadRecoveryAsset({
      ...common,
      name: auditName(value),
      contentBase64: canonicalRecoveryBytes(value).toString("base64"),
    })
  const read = async (method, args) => {
    const r = await runRecoveryRead(
      { phaseDeadline: deadline, responseBytes: 2 * 1024 * 1024 },
      () => recoveryMethods(dependencies.observation.github, [method])[method](args),
      clock,
    )
    auditRequire(r.status === "PRESENT", "audit API unavailable")
    return method === "downloadActionsArtifact" ? r.contentBase64 : r.value
  }
  const advance = async (observed, phase, selected = observed.facts.audit) => {
    const marker = parseRecovery({
      ...observed.facts.marker,
      revision: observed.facts.marker.revision + 1,
      phase,
      audit: phase === "AUDIT_PENDING" ? selected.dispatchRef : selected.resultRef,
    })
    const prefix = observed.facts.release.body.split("\n\n<!-- DAWN_RELEASE_CONTROLLER_MARKER\n")[0]
    return writer.updateRecoveryDraft({
      ...common,
      title: observed.facts.release.name,
      body: renderRecoveryReleaseBody({ marker, body: prefix }),
    })
  }
  return {
    request,
    writer,
    current,
    proof,
    observe,
    upload,
    read,
    advance,
    clock,
    deadline,
    budget,
  }
}
export async function dispatchRecoveryAudit(request, config, dependencies) {
  const c = await controller(request, config, dependencies)
  let { current } = c
  const retry = current.phase === "AUDIT_PENDING" && auditHasFailed(current.facts)
  if (current.phase !== "VERIFICATION_COMPLETE" && !retry) return current
  if (current.facts.audit && !retry) return c.advance(current, "AUDIT_PENDING")
  const existing = current.facts.auditBookkeeping.find(
    (e) =>
      e.receipt.kind === "recovery-audit-intent" && e.receipt.requestId === c.request.requestId,
  )
  if (existing) {
    const correlated = current.facts.auditBookkeeping.find(
      (e) =>
        e.receipt.kind === "recovery-audit-dispatch" &&
        e.receipt.intentSha256 === existing.ref.sha256,
    )
    if (retry && correlated && correlated.ref.sha256 !== current.facts.audit.dispatchRef.sha256)
      return c.advance(current, "AUDIT_PENDING", selectAuditDispatch(current.facts, correlated.ref))
    if (
      !current.facts.auditBookkeeping.some((e) => e.receipt.intentSha256 === existing.ref.sha256)
    ) {
      await c.upload({
        schemaVersion: 2,
        kind: "recovery-audit-attempt",
        candidate: c.request.candidate,
        policySha256: c.proof.policySha256,
        requestId: c.request.requestId,
        intentSha256: existing.ref.sha256,
        runId: null,
        expectedAuditorSha: existing.receipt.expectedAuditorSha,
        observedAuditorSha: null,
        classification: "uncorrelated",
        executor: c.proof.executor,
      })
    }
    return c.observe()
  }
  await requireActiveAuditWorkflow(c.read)
  const intent = parseRecovery({
    schemaVersion: 2,
    kind: "recovery-audit-intent",
    candidate: c.request.candidate,
    policySha256: c.proof.policySha256,
    requestId: c.request.requestId,
    expectedAuditorSha: c.request.expectedControllerSha,
    verificationSetSha256: current.facts.verification.ref.sha256,
    inventory: auditInventory(current.facts),
    executor: c.proof.executor,
  })
  const intentRef = await c.upload(intent)
  const { runId } = await c.writer.dispatchRecoveryAudit({
    candidate: c.request.candidate,
    expectedControllerSha: c.request.expectedControllerSha,
    intentPath: c.request.intentPath,
    expectedBodySha256: auditHash(Buffer.from(current.facts.release.body)),
    intentRef,
  })
  const { run, classification } = await inspectAuditRun(c.request.candidate, intent, runId, c.read)
  if (classification) {
    await c.upload({
      schemaVersion: 2,
      kind: "recovery-audit-attempt",
      candidate: c.request.candidate,
      policySha256: c.proof.policySha256,
      requestId: intent.requestId,
      intentSha256: intentRef.sha256,
      runId,
      expectedAuditorSha: intent.expectedAuditorSha,
      observedAuditorSha: run.head_sha,
      classification,
      executor: c.proof.executor,
    })
    return c.observe()
  }
  const dispatchRef = await c.upload({
    schemaVersion: 2,
    kind: "recovery-audit-dispatch",
    candidate: c.request.candidate,
    requestId: intent.requestId,
    intentSha256: intentRef.sha256,
    runId,
    expectedAuditorSha: intent.expectedAuditorSha,
    executor: c.proof.executor,
  })
  current = await c.observe()
  return c.advance(current, "AUDIT_PENDING", selectAuditDispatch(current.facts, dispatchRef))
}

export async function reconcileRecoveryAudit(request, config, dependencies) {
  return reconcileAuditController(await controller(request, config, dependencies), false)
}
export async function waitForRecoveryAudit(request, config, dependencies) {
  return reconcileAuditController(await controller(request, config, dependencies), true)
}
async function reconcileAuditController(c, wait) {
  if (c.current.phase !== "AUDIT_PENDING") return c.current
  if (c.current.facts.audit.result) return c.advance(c.current, "AUDIT_VERIFIED")
  const audit = c.current.facts.audit
  let verified,
    backoff = RECOVERY_RETRY.initialBackoffMs
  for (;;) {
    verified = await readAuditArtifact(c.request.candidate, audit.intent, audit.dispatch, c.read)
    if (!wait || !verified.missing) break
    const remaining = c.deadline - c.clock.now()
    auditRequire(remaining > 0, "audit wait phase deadline expired")
    await c.budget.work(() => c.clock.sleep(Math.min(backoff, remaining)))
    backoff = Math.min(backoff * 2, RECOVERY_RETRY.maxRetryAfterMs)
  }
  if (verified.missing)
    return snapshotRecoveryData({ ...c.current, errors: [verified.missing] }, 16 * 1024 * 1024)
  if (verified.failure) {
    await c.upload({
      schemaVersion: 2,
      kind: "recovery-audit-attempt",
      candidate: c.request.candidate,
      policySha256: c.proof.policySha256,
      requestId: audit.intent.requestId,
      intentSha256: audit.intentRef.sha256,
      runId: audit.dispatch.runId,
      expectedAuditorSha: audit.intent.expectedAuditorSha,
      observedAuditorSha: audit.intent.expectedAuditorSha,
      classification: verified.failure,
      executor: c.proof.executor,
    })
    return c.observe()
  }
  const result = await c.upload(verified.result)
  await c.upload({
    schemaVersion: 2,
    kind: "recovery-audit-escrow",
    candidate: c.request.candidate,
    policySha256: c.proof.policySha256,
    executor: c.proof.executor,
    result,
    artifact: verified.artifact,
    validatedAt: new Date(c.clock.now()).toISOString(),
  })
  return c.advance(await c.observe(), "AUDIT_VERIFIED")
}
export async function runRecoveryAudit(request, dependencies) {
  dependencies = auditDependencies(dependencies, false)
  request = snapshotRecoveryData(request, 16384)
  auditRequire(
    Object.keys(request).sort().join(" ") ===
      "candidate expectedControllerSha intentPath requestId",
    "exact audit request required",
  )
  const clock = recoveryMethods(dependencies.authority, ["now", "sleep"])
  const deadline = clock.now() + RECOVERY_RETRY.phaseDeadlineMs
  const budget = createRecoveryWorkBudget(
    { phaseDeadline: deadline },
    {
      now: clock.now,
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (t) => clearTimeout(t),
    },
  )
  const authority = await budget.work(() =>
    captureRecoveryAuditor(
      {
        candidate: request.candidate,
        expectedControllerSha: request.expectedControllerSha,
      },
      dependencies.authority,
    ),
  )
  const read = async (method, args) => {
    const r = await budget.work(() =>
      runRecoveryRead(
        {
          phaseDeadline: deadline,
          responseBytes: 2 * RECOVERY_LIMITS.selectionBytes,
        },
        () => recoveryMethods(dependencies.observation.github, [method])[method](args),
        clock,
      ),
    )
    auditRequire(r.status === "PRESENT", "auditor intent read unavailable")
    return method === "downloadReleaseAsset" ? r.contentBase64 : r.value
  }
  // Download the bounded immutable request first, so even a later failed production
  // observation can emit a correctly bound non-success result. It proves no audit gate.
  const refs = normalizeRecoveryAssetInventory(
    await read("listReleaseAssets", { releaseId: request.candidate.releaseId }),
  )
  const ref = refs.find(
    (r) =>
      r.assetName ===
      auditName({
        kind: "recovery-audit-intent",
        requestId: request.requestId,
      }),
  )
  auditRequire(
    ref && ref.size <= RECOVERY_LIMITS.selectionBytes,
    "matching persisted audit intent required",
  )
  const encoded = await read("downloadReleaseAsset", {
    assetId: ref.id,
    maximumBytes: ref.size,
  })
  const bytes = Buffer.from(encoded, "base64")
  auditRequire(
    bytes.toString("base64") === encoded &&
      bytes.length === ref.size &&
      auditHash(bytes) === ref.sha256,
    "audit intent bytes differ",
  )
  const intent = parseRecovery(bytes, {
    kind: "recovery-audit-intent",
    candidate: request.candidate,
  })
  auditRequire(canonicalRecoveryBytes(intent).equals(bytes), "canonical audit intent required")
  auditSame(
    intent.expectedAuditorSha,
    authority.executor.controllerSha,
    "audit admission SHA differs",
  )
  auditSame(intent.policySha256, authority.policySha256, "audit admission policy differs")
  const makeResult = (success) =>
    parseRecovery({
      schemaVersion: 2,
      kind: "recovery-audit-result",
      candidate: request.candidate,
      policySha256: authority.policySha256,
      requestId: request.requestId,
      verificationSetSha256: intent.verificationSetSha256,
      inventorySha256: auditInventoryHash(intent.inventory),
      executor: authority.executor,
      checks: RECOVERY_AUDIT_CHECKS.map((name) => ({
        name,
        conclusion:
          success || name === "admission"
            ? "success"
            : name === "selected-evidence"
              ? "failure"
              : "skipped",
      })),
      conclusion: success ? "success" : "failure",
    })
  try {
    for (;;) {
      // Every attempt opens its own production observation and clean verifier;
      // only successful completed disposal can establish the cleanup gate.
      const current = await budget.work(() =>
        observeRecoveryCandidate({
          ...dependencies.observation,
          candidate: request.candidate,
          controllerRef: request.expectedControllerSha,
          intentPath: request.intentPath,
        }),
      )
      auditRequire(current.outcome !== "blocked", current.errors.join("; "))
      auditRequire(
        ["VERIFICATION_COMPLETE", "AUDIT_PENDING"].includes(current.phase) &&
          current.facts.release.draft === true &&
          current.facts.release.immutable === false,
        "auditor requires mutable verification draft",
      )
      verifyAuditIntent(intent, current.facts)
      const audit = current.facts.audit
      if (audit && audit.intent.requestId === request.requestId) {
        auditSame(authority.executor.runId, audit.dispatch.runId, "audit invocation run differs")
        auditSame(audit.intentRef, ref, "audit intent selection differs")
        if (current.phase === "AUDIT_PENDING") {
          const expectedInventory = [
            ...intent.inventory,
            ...current.facts.auditBookkeeping.map((e) => e.ref),
          ].sort((a, b) => (a.assetName < b.assetName ? -1 : 1))
          auditSame(
            current.facts.assets,
            expectedInventory,
            "audit inventory contains unexpected assets",
          )
          return makeResult(true)
        }
      } else auditRequire(!audit || auditHasFailed(current.facts), "conflicting audit correlation")
      await budget.work(() =>
        clock.sleep(Math.min(RECOVERY_RETRY.initialBackoffMs, deadline - clock.now())),
      )
    }
  } catch {
    return makeResult(false)
  }
}
function auditDependencies(source, writer) {
  const data = (object, key) => {
    auditRequire(
      object &&
        typeof object === "object" &&
        !types.isProxy(object) &&
        [Object.prototype, null].includes(Object.getPrototypeOf(object)),
      "safe audit adapters required",
    )
    const d = Object.getOwnPropertyDescriptor(object, key)
    auditRequire(d && Object.hasOwn(d, "value"), "safe audit adapter data required")
    return d.value
  }
  const observation = data(source, "observation")
  return {
    observation: Object.fromEntries(
      ["github", "git", "npm", "npmAuditFactory", "attestations"].map((key) => [
        key,
        data(observation, key),
      ]),
    ),
    authority: data(source, "authority"),
    ...(writer
      ? {
          fetchImpl: data(source, "fetchImpl"),
          observeImmutableReleasePolicy: data(source, "observeImmutableReleasePolicy"),
        }
      : {}),
  }
}
