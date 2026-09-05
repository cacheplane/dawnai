import assert from "node:assert/strict"
import test from "node:test"
import { adoptRecoveryCandidate } from "../recovery/adopt.mjs"
import { dispatchRecoveryAudit, reconcileRecoveryAudit } from "../recovery/audit.mjs"
import { collectRecoveryEvidence } from "../recovery/evidence.mjs"
import { renderRecoveryFinalMetadata } from "../recovery/metadata.mjs"
import { observeRecoveryCandidate } from "../recovery/observe.mjs"
import { canonicalRecoveryBytes } from "../recovery/schema.mjs"
import { createRecoveryWriter } from "../recovery/writer.mjs"
import { auditResultRemote } from "./support/recovery-audit-fixture.mjs"
import { digest } from "./support/recovery-fixture.mjs"

const module = await import("../recovery/finalize.mjs").catch(() => ({}))
async function remote() {
  const r = await auditResultRemote()
  await reconcileRecoveryAudit(r.request, r.config, r.dependencies)
  r.auditRequest = r.request
  const { requestId: _id, ...request } = r.request
  r.request = request
  r.effects.length = 0
  return r
}
async function finalize(r) {
  assert.equal(typeof module.finalizeRecoveryCandidate, "function")
  return module.finalizeRecoveryCandidate(r.request, r.config, r.dependencies)
}
async function publish(r) {
  assert.equal(typeof module.publishRecoveryCandidate, "function")
  return module.publishRecoveryCandidate(r.request, r.config, r.dependencies)
}
const observed = (r) => observeRecoveryCandidate(r.args)
const fixed = (r) => r.assets().find((a) => a.assetName === "recovery-v2-finalization.json")

test("finalization binds the complete nonrecursive inventory including audit escrow", async () => {
  const r = await remote()
  const before = await observed(r)
  const result = await finalize(r)
  assert.equal(result.phase, "PUBLICATION_READY")
  const proof = result.facts.finalization
  assert.deepEqual(proof.receipt.assets, before.facts.assets)
  assert.ok(proof.receipt.assets.some((a) => a.assetName.startsWith("recovery-v2-audit-escrow-")))
  assert.ok(!proof.receipt.assets.some((a) => a.assetName === proof.ref.assetName))
  assert.deepEqual(proof.receipt.adoption, before.facts.adoption.ref)
  assert.deepEqual(proof.receipt.verificationSet, before.facts.verification.ref)
  assert.deepEqual(proof.receipt.audit, before.facts.audit.resultRef)
  assert.deepEqual(proof.receipt.metadata, {
    title: before.facts.release.name,
    body: "Original notes",
    markerRevision: before.facts.marker.revision + 1,
  })
  assert.equal(proof.ref.sha256, digest(canonicalRecoveryBytes(proof.receipt)))
  assert.deepEqual(
    r.effects.map((e) => e.method),
    ["POST", "PATCH"],
  )
  r.effects.length = 0
  assert.deepEqual(await finalize(r), result)
  assert.equal(r.effects.length, 0)
})
for (const interrupt of [1, 2])
  test(`lost finalization response after effect ${interrupt} resumes exact persisted bytes`, async () => {
    const r = await remote()
    r.interruptAfter(interrupt)
    await assert.rejects(finalize(r), /uncertain|stopped/)
    const ref = fixed(r)
    assert.ok(ref)
    r.effects.length = 0
    r.interruptAfter(0)
    const result = await finalize(r)
    assert.equal(result.phase, "PUBLICATION_READY")
    assert.deepEqual(result.facts.finalization.ref, ref)
    assert.deepEqual(
      r.effects.map((e) => e.method),
      interrupt === 1 ? ["PATCH"] : [],
    )
  })
for (const [name, mutate] of [
  [
    "title",
    (r) => {
      r.release.name = "Edited title"
    },
  ],
  [
    "body",
    (r) => {
      r.release.body = `Edited notes${r.release.body}`
    },
  ],
  [
    "marker removal",
    (r) => {
      r.release.body = "All metadata removed"
    },
  ],
  [
    "marker corruption",
    (r) => {
      r.release.body = r.release.body.replace('"schemaVersion":2', '"schemaVersion":999')
    },
  ],
]) {
  test(`draft ${name} after freeze repairs only canonical metadata`, async () => {
    const r = await remote()
    await finalize(r)
    const baseline = await observed(r)
    const metadata = renderRecoveryFinalMetadata(baseline.facts.finalization.receipt, fixed(r))
    mutate(r)
    const edited = r.release.body
    r.effects.length = 0
    const drifted = await observed(r)
    assert.notEqual(drifted.outcome, "blocked", drifted.errors.join("; "))
    assert.deepEqual(drifted.facts.finalization, baseline.facts.finalization)
    assert.equal(drifted.facts.release.body, edited)
    if (name.startsWith("marker")) assert.equal(drifted.facts.marker, null)
    await finalize(r)
    assert.equal(r.release.name, metadata.title)
    assert.equal(r.release.body, metadata.body)
    assert.deepEqual(
      r.effects.map((e) => e.method),
      ["PATCH"],
    )
  })
  test(`published ${name} remains terminal with display drift and no repair`, async () => {
    const r = await remote()
    await finalize(r)
    const completed = await publish(r)
    assert.equal(completed.phase, "COMPLETE")
    mutate(r)
    r.effects.length = 0
    for (const run of [finalize, publish]) {
      const result = await run(r)
      assert.equal(result.terminal, true)
      assert.equal(result.displayDrift, true)
    }
    assert.equal(r.effects.length, 0)
  })
}
test("fixed asset freezes every receipt entrypoint after upload interruption and missing marker", async () => {
  const r = await remote()
  r.interruptAfter(1)
  await assert.rejects(finalize(r), /uncertain|stopped/)
  r.interruptAfter(0)
  r.release.body = "marker removed after interrupted upload"
  r.effects.length = 0
  for (const run of [
    () => adoptRecoveryCandidate(r.request, r.config, r.dependencies),
    () => collectRecoveryEvidence(r.request, r.config, r.dependencies),
    () => dispatchRecoveryAudit(r.auditRequest, r.config, r.dependencies),
    () => reconcileRecoveryAudit(r.auditRequest, r.config, r.dependencies),
  ]) {
    await run()
    assert.equal(r.effects.length, 0)
  }
  const current = await observed(r)
  const writer = createRecoveryWriter(r.config, r.dependencies)
  await assert.rejects(
    writer.uploadRecoveryAsset({
      ...r.request,
      expectedBodySha256: digest(Buffer.from(r.release.body)),
      name: "recovery-v2-new.json",
      contentBase64: canonicalRecoveryBytes(current.facts.adoption.receipt).toString("base64"),
    }),
    /freezes/,
  )
  assert.equal(r.effects.length, 0)
  assert.equal((await finalize(r)).phase, "PUBLICATION_READY")
})
test("lost publication response resumes terminal without another mutation or complete stamp", async () => {
  const r = await remote()
  await finalize(r)
  const body = r.release.body
  r.effects.length = 0
  r.interruptAfter(1)
  await assert.rejects(publish(r), /uncertain|stopped/)
  assert.equal(r.release.draft, false)
  r.effects.length = 0
  r.interruptAfter(0)
  assert.equal((await publish(r)).phase, "COMPLETE")
  assert.equal((await finalize(r)).phase, "COMPLETE")
  assert.equal(r.release.body, body)
  assert.equal(r.effects.length, 0)
})
for (const [name, mutate] of [
  [
    "oversized title",
    (r) => {
      r.release.name = "x".repeat(513)
    },
  ],
  [
    "unrenderable notes",
    (r) => {
      r.release.body = `DAWN_RELEASE_CONTROLLER_MARKER notes\n${r.release.body}`
    },
  ],
  [
    "extra asset",
    (r) => {
      r.activate([...r.assets(), r.add("extra.txt", "extra")])
    },
  ],
  [
    "ineligible invocation",
    (r) => {
      r.request.expectedControllerSha = "f".repeat(40)
    },
  ],
  [
    "missing fence",
    (r) => {
      r.setFence(false)
    },
  ],
  [
    "disabled immutable releases",
    (r) => {
      r.dependencies.observeImmutableReleasePolicy = async () => ({
        repository: r.c.repository,
        enabled: false,
      })
    },
  ],
])
  test(`${name} blocks finalization before freeze with zero effects`, async () => {
    const r = await remote()
    mutate(r)
    await assert.rejects(finalize(r))
    assert.equal(fixed(r), undefined)
    assert.equal(r.effects.length, 0)
  })
test("readiness marker without the fixed asset blocks finalization and publication", async () => {
  const r = await remote()
  await finalize(r)
  r.activate(r.assets().filter((a) => a.assetName !== "recovery-v2-finalization.json"))
  r.effects.length = 0
  await assert.rejects(finalize(r))
  await assert.rejects(publish(r))
  assert.equal(r.effects.length, 0)
})
test("extra postfreeze asset blocks repair and publication", async () => {
  const r = await remote()
  await finalize(r)
  r.activate([...r.assets(), r.add("extra.txt", "extra")])
  r.effects.length = 0
  await assert.rejects(finalize(r))
  await assert.rejects(publish(r))
  assert.equal(r.effects.length, 0)
})
test("initial authority work consumes the publication invocation deadline", async () => {
  const r = await remote()
  await finalize(r)
  let time = r.dependencies.authority.now()
  r.dependencies.authority.now = () => time
  const invocation = r.dependencies.authority.readInvocation
  r.dependencies.authority.readInvocation = async () => {
    time += 21 * 60 * 1000
    return invocation()
  }
  r.effects.length = 0
  await assert.rejects(publish(r), /deadline|stopped|expired|fence|readInvocation unavailable/)
  assert.equal(r.effects.length, 0)
})

test("publication requires readiness and never finalizes implicitly", async () => {
  const r = await remote()
  await assert.rejects(publish(r), /readiness|finalization/)
  assert.equal(r.effects.length, 0)
})
test("invalid audit selection cannot freeze or dispatch a replacement audit", async () => {
  const r = await remote()
  r.auditRun.conclusion = "failure"
  await assert.rejects(finalize(r))
  assert.equal(fixed(r), undefined)
  assert.equal(r.effects.length, 0)
})
test("uploaded finalization must be independently downloaded before readiness", async () => {
  const r = await remote()
  const transport = r.dependencies.fetchImpl
  r.dependencies.fetchImpl = async (...args) => {
    const response = await transport(...args)
    if (fixed(r)) r.raws.set("recovery-v2-finalization.json", Buffer.from("corrupt upload"))
    return response
  }
  await assert.rejects(finalize(r), /bytes|digest/)
  assert.deepEqual(
    r.effects.map((e) => e.method),
    ["POST"],
  )
})

test("final inventory retains permitted earlier uncorrelated audit bookkeeping", async () => {
  const { auditName } = await import("../recovery/audit-proof.mjs")
  const r = await remote()
  const current = await observed(r)
  const intent = { ...current.facts.audit.intent, requestId: "earlier-uncorrelated" }
  const intentRef = r.add(auditName(intent), intent)
  const attempt = {
    schemaVersion: 2,
    kind: "recovery-audit-attempt",
    candidate: r.c,
    policySha256: current.facts.policySha256,
    requestId: intent.requestId,
    intentSha256: intentRef.sha256,
    runId: null,
    expectedAuditorSha: intent.expectedAuditorSha,
    observedAuditorSha: null,
    classification: "uncorrelated",
    executor: intent.executor,
  }
  const attemptRef = r.add(auditName(attempt), attempt)
  r.activate([...r.assets(), intentRef, attemptRef])
  const result = await finalize(r)
  assert.ok(
    result.facts.finalization.receipt.assets.some((a) => a.assetName === intentRef.assetName),
  )
  assert.ok(
    result.facts.finalization.receipt.assets.some((a) => a.assetName === attemptRef.assetName),
  )
  assert.deepEqual(
    result.facts.finalization.receipt.assets,
    r
      .assets()
      .filter((a) => a.assetName !== "recovery-v2-finalization.json")
      .sort((a, b) => (a.assetName < b.assetName ? -1 : a.assetName > b.assetName ? 1 : 0)),
  )
})
