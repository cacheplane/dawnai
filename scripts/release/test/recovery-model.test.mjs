import assert from "node:assert/strict"
import test from "node:test"
import {
  digest,
  executor,
  LANES,
  markerAt,
  receiptRef,
  recoveryFacts,
  wireFixtures,
} from "./support/recovery-fixture.mjs"

const model = await import("../recovery/model.mjs").catch(() => ({}))
const plan = (facts) => {
  assert.equal(typeof model.planRecovery, "function", "pure recovery planner exists")
  return model.planRecovery(facts)
}
const blocked = (facts, before) => {
  const result = plan(facts)
  assert.equal(result.outcome, "blocked")
  assert.equal(result.after, before)
  assert.deepEqual(result.effects, [])
  return result
}
for (const [phase, after, operation] of [
  ["NPM_COMPLETE", "RECOVERY_ADOPTED", "write-marker"],
  ["RECOVERY_ADOPTED", "VERIFICATION_COMPLETE", "write-marker"],
  ["VERIFICATION_COMPLETE", "AUDIT_PENDING", "write-marker"],
  ["AUDIT_PENDING", "AUDIT_VERIFIED", "write-marker"],
  ["AUDIT_VERIFIED", "AUDIT_VERIFIED", "finalize"],
  ["PUBLICATION_READY", "PUBLICATION_READY", "publish"],
]) {
  test(`${phase} plans only the next supported operation with durable proof`, () => {
    const facts = recoveryFacts({ phase })
    const original = structuredClone(facts)
    const result = plan(facts)
    assert.equal(result.outcome, "planned")
    assert.equal(result.before, phase)
    assert.equal(result.after, after)
    assert.equal(result.effects[0].operation, operation)
    assert.deepEqual(facts, original)
    assert.ok(Object.isFrozen(result.effects))
  })
}
const prerequisites = {
  NPM_COMPLETE: [
    (f) => {
      f.authority = null
    },
    (f) => {
      f.legacy.bodySha256 = "e".repeat(64)
    },
    (f) => {
      f.ownership.legacyWriters = "active"
    },
    (f) => {
      f.ownership.concurrencyGroup = "other"
    },
    (f) => {
      f.adoption.archive.sha256 = "e".repeat(64)
    },
    (f) => {
      f.adoption.baseAssets.pop()
    },
    (f) => {
      f.adoption.manifestPackages.push("@dawn-ai/core")
    },
    (f) => {
      f.adoption.npmEvidence.packages[0].sourceSha = "e".repeat(40)
    },
    (f) => {
      f.authority.intent.candidate.releaseId = "999"
    },
    (f) => {
      f.authority.intent.operations = ["verify"]
    },
  ],
  RECOVERY_ADOPTED: [
    (f) => {
      f.verification.set.policySha256 = "e".repeat(64)
    },
    (f) => {
      f.verification.lanes.storage.executor.runId = "999"
    },
    (f) => {
      f.verification.provenance[0].executor.controllerSha = "e".repeat(40)
    },
    (f) => {
      f.verification.provenance[0].artifactId = "999"
    },
    (f) => {
      f.verification.set.lanes.pop()
    },
    (f) => {
      f.verification.ref.sha256 = "e".repeat(64)
    },
    (f) => {
      f.marker.adoption.id = "999"
    },
  ],
  VERIFICATION_COMPLETE: [
    (f) => {
      f.audit.dispatch.runId = f.executor.runId
    },
    (f) => {
      f.audit.dispatch.intentSha256 = "e".repeat(64)
    },
    (f) => {
      f.audit.intent.verificationSetSha256 = "e".repeat(64)
    },
    (f) => {
      f.audit.dispatch.expectedAuditorSha = "e".repeat(40)
    },
    (f) => {
      f.audit.dispatchRef.sha256 = "e".repeat(64)
    },
    (f) => {
      f.marker.verificationSet.id = "999"
    },
  ],
  AUDIT_PENDING: [
    (f) => {
      f.audit.result.checks[0].conclusion = "failure"
      f.audit.result.conclusion = "failure"
    },
    (f) => {
      f.audit.result.executor.controllerSha = "e".repeat(40)
    },
    (f) => {
      f.audit.result.requestId = "other-request"
    },
    (f) => {
      f.audit.result.inventorySha256 = "e".repeat(64)
    },
    (f) => {
      f.audit.observedExecutor.jobId = "999"
    },
    (f) => {
      f.audit.admission = null
    },
    (f) => {
      f.marker.audit.id = "999"
    },
  ],
  AUDIT_VERIFIED: [
    (f) => {
      f.fresh.tag.objectSha = "e".repeat(40)
    },
    (f) => {
      f.fresh.registry.packages = []
    },
    (f) => {
      f.fresh.assets.pop()
    },
    (f) => {
      f.fresh.immutableReleasePolicy = "disabled"
    },
    (f) => {
      f.proposedFinalization.receipt.assets.pop()
    },
    (f) => {
      f.proposedFinalization.receipt.audit.id = "999"
    },
    (f) => {
      f.marker.audit.id = "999"
    },
  ],
  PUBLICATION_READY: [
    (f) => {
      f.finalization.receipt = null
    },
    (f) => {
      f.finalization.ref.sha256 = "e".repeat(64)
    },
    (f) => {
      f.finalization.inventory.pop()
    },
    (f) => {
      f.fresh.candidate.releaseId = "999"
    },
    (f) => {
      f.fresh.ownership = "unknown"
    },
  ],
}
for (const [phase, mutations] of Object.entries(prerequisites))
  mutations.forEach((mutate, index) => {
    test(`${phase} prerequisite ${index + 1} fails closed`, () => {
      const facts = recoveryFacts({ phase })
      mutate(facts)
      blocked(facts, phase)
    })
  })
for (const lane of LANES) {
  test(`failed ${lane} cannot be adjudicated into verification success`, () => {
    const facts = recoveryFacts({ phase: "RECOVERY_ADOPTED" })
    facts.verification.lanes[lane].conclusion = "failure"
    facts.legacyAdjudication = { kind: "smoke-gate-adjudicated" }
    blocked(facts, "RECOVERY_ADOPTED")
  })
  test(`missing ${lane} cannot advance or invent a passing receipt`, () => {
    const facts = recoveryFacts({ phase: "RECOVERY_ADOPTED" })
    delete facts.verification.lanes[lane]
    const result = plan(facts)
    assert.equal(result.after, "RECOVERY_ADOPTED")
    assert.equal(result.outcome, "blocked")
    assert.deepEqual(result.effects, [])
  })
}
test("missing first-run work is explicitly planned without claiming durable progress", () => {
  for (const [phase, field, operation] of [
    ["NPM_COMPLETE", "adoption", "adopt"],
    ["RECOVERY_ADOPTED", "verification", "smoke"],
  ]) {
    const facts = recoveryFacts({ phase })
    facts[field] = null
    const result = plan(facts)
    assert.equal(result.after, phase)
    assert.equal(result.outcome, "planned")
    assert.equal(result.effects[0].operation, operation)
  }
  const facts = recoveryFacts({ phase: "VERIFICATION_COMPLETE" })
  facts.audit = null
  const result = plan(facts)
  assert.equal(result.after, "VERIFICATION_COMPLETE")
  assert.equal(result.effects[0].operation, "dispatch-audit")
})
test("missing audit result waits with no false success", () => {
  const facts = recoveryFacts({ phase: "AUDIT_PENDING" })
  facts.audit.result = null
  facts.audit.resultRef = null
  const result = plan(facts)
  assert.equal(result.after, "AUDIT_PENDING")
  assert.equal(result.outcome, "waiting")
  assert.deepEqual(result.effects, [])
})
test("unknown executor capability and unsupported observations have no effects", () => {
  for (const mutate of [
    (f) => {
      f.capability = null
    },
    (f) => {
      f.marker = null
      f.legacy.phase = "PARTIALLY_PUBLISHED"
    },
    (f) => {
      f.capability.schemaVersion = 3
    },
    (f) => {
      f.capability.policySha256 = "e".repeat(64)
    },
    (f) => {
      f.capability.controllerSha = "e".repeat(40)
    },
    (f) => {
      f.capability.verifierClosureSha256 = "e".repeat(64)
    },
    (f) => {
      f.marker = { schemaVersion: 99, phase: "RECOVERY_ADOPTED" }
    },
    (f) => {
      f.legacy = null
      f.marker = null
    },
  ]) {
    const facts = recoveryFacts({ phase: "RECOVERY_ADOPTED" })
    mutate(facts)
    const result = plan(facts)
    assert.equal(result.outcome, "blocked")
    assert.deepEqual(result.effects, [])
  }
})
test("a newer compatible controller may resume a complete older selected run and independent audit", () => {
  const facts = recoveryFacts({ phase: "AUDIT_PENDING" })
  facts.executor = executor({ controllerSha: "e".repeat(40), runId: "999", jobId: "998" })
  facts.capability.controllerSha = facts.executor.controllerSha
  assert.equal(plan(facts).after, "AUDIT_VERIFIED")
})
test("audit intent pins dispatch revision even when its self-claimed auditor revision is different", () => {
  const facts = recoveryFacts({ phase: "VERIFICATION_COMPLETE" })
  facts.audit.intent.expectedAuditorSha = "e".repeat(40)
  facts.audit.intentRef = receiptRef(
    facts.audit.intent,
    facts.audit.intentRef.assetName,
    facts.audit.intentRef.id,
  )
  facts.audit.dispatch.expectedAuditorSha = "e".repeat(40)
  facts.audit.dispatch.intentSha256 = facts.audit.intentRef.sha256
  facts.audit.dispatchRef = receiptRef(
    facts.audit.dispatch,
    facts.audit.dispatchRef.assetName,
    facts.audit.dispatchRef.id,
  )
  blocked(facts, "VERIFICATION_COMPLETE")
})
test("finalization existence freezes uploads and audit dispatch even with a lagging or missing marker", () => {
  for (const phase of [
    "NPM_COMPLETE",
    "RECOVERY_ADOPTED",
    "VERIFICATION_COMPLETE",
    "AUDIT_PENDING",
    "AUDIT_VERIFIED",
    "PUBLICATION_READY",
  ]) {
    const facts = recoveryFacts({ phase })
    facts.finalization = {
      receipt: facts.proposedFinalization.receipt,
      ref: receiptRef(facts.proposedFinalization.receipt, "recovery-v2-finalization.json", 34),
      inventory: facts.proposedFinalization.receipt.assets,
    }
    facts.fresh.assets = [...facts.finalization.inventory, facts.finalization.ref].sort((a, b) =>
      a.assetName < b.assetName ? -1 : 1,
    )
    const result = plan(facts)
    assert.equal(result.outcome, "planned")
    assert.equal(result.after, "PUBLICATION_READY")
    assert.ok(
      result.effects.every((effect) => ["write-marker", "publish"].includes(effect.operation)),
    )
  }
  const facts = recoveryFacts({ phase: "RECOVERY_ADOPTED" })
  facts.finalization = { receipt: null, ref: wireFixtures().finalRef, inventory: [] }
  blocked(facts, "RECOVERY_ADOPTED")
})
test("readiness is reconstructed from the exact persisted finalization asset", () => {
  const facts = recoveryFacts({ phase: "AUDIT_VERIFIED" })
  facts.finalization = {
    receipt: facts.proposedFinalization.receipt,
    ref: receiptRef(facts.proposedFinalization.receipt, "recovery-v2-finalization.json", 34),
    inventory: facts.proposedFinalization.receipt.assets,
  }
  facts.fresh.assets = [...facts.finalization.inventory, facts.finalization.ref].sort((a, b) =>
    a.assetName < b.assetName ? -1 : 1,
  )
  const result = plan(facts)
  assert.equal(result.after, "PUBLICATION_READY")
  assert.deepEqual(result.effects, [
    { operation: "write-marker", target: "PUBLICATION_READY" },
    { operation: "publish", target: "902" },
  ])
})
test("published immutable proof derives COMPLETE read-only without write authority or editable marker", () => {
  for (const marker of [
    null,
    "corrupt body marker",
    { schemaVersion: 99 },
    { ...markerAt("PUBLICATION_READY"), revision: 999 },
  ]) {
    const facts = recoveryFacts({ phase: "COMPLETE" })
    facts.marker = marker
    facts.capability = null
    facts.authority = null
    facts.legacy = null
    facts.executor = null
    const result = plan(facts)
    assert.equal(result.after, "COMPLETE")
    assert.equal(result.outcome, "complete")
    assert.equal(result.displayDrift, true)
    assert.deepEqual(result.effects, [])
  }
  const facts = recoveryFacts({ phase: "COMPLETE" })
  const result = plan(facts)
  assert.equal(result.after, "COMPLETE")
  assert.equal(result.displayDrift, false)
  assert.deepEqual(result.effects, [])
  facts.publication.metadata = "drift"
  assert.equal(plan(facts).displayDrift, true)
})
test("missing or conflicting immutable publication proof is an integrity block with no legacy fallback", () => {
  for (const mutate of [
    (f) => {
      f.finalization = null
    },
    (f) => {
      f.publication.immutable = false
    },
    (f) => {
      f.publication.tag.objectSha = "e".repeat(40)
    },
    (f) => {
      f.publication.assets.pop()
    },
    (f) => {
      f.publication.candidate.releaseId = "999"
    },
    (f) => {
      f.publication.finalizationSha256 = "e".repeat(64)
    },
    (f) => {
      f.finalization.receipt.metadata.title = "conflicting bytes"
    },
    (f) => {
      f.verification.lanes.storage = null
    },
    (f) => {
      f.audit.result = null
    },
  ]) {
    const facts = recoveryFacts({ phase: "COMPLETE" })
    mutate(facts)
    const result = plan(facts)
    assert.equal(result.outcome, "blocked")
    assert.notEqual(result.after, "COMPLETE")
    assert.deepEqual(result.effects, [])
    assert.match(result.errors.join(" "), /integrity/i)
  }
})
test("final inventory admits only the audited selection plus correlated audit bookkeeping", () => {
  const facts = recoveryFacts({ phase: "AUDIT_VERIFIED" })
  const extra = {
    assetName: "recovery-v2-unreviewed.json",
    id: "999",
    sha256: digest("extra"),
    size: 5,
  }
  facts.proposedFinalization.receipt.assets.push(extra)
  facts.proposedFinalization.receipt.assets.sort((a, b) => (a.assetName < b.assetName ? -1 : 1))
  facts.fresh.assets = facts.proposedFinalization.receipt.assets
  blocked(facts, "AUDIT_VERIFIED")
})
test("planner rejects hostile descriptors without invoking them", () => {
  const facts = recoveryFacts()
  let reads = 0
  Object.defineProperty(facts, "candidate", {
    enumerable: true,
    get() {
      reads++
      throw new Error("getter executed")
    },
  })
  const result = plan(facts)
  assert.equal(result.outcome, "blocked")
  assert.equal(reads, 0)
  assert.deepEqual(result.effects, [])
})

test("persisted finalization retries verify the whole observed release inventory", () => {
  const facts = recoveryFacts({ phase: "PUBLICATION_READY" })
  assert.ok(facts.fresh.assets.some((asset) => asset.assetName === "recovery-v2-finalization.json"))
  assert.equal(plan(facts).outcome, "planned")
  assert.equal(plan(facts).effects[0].operation, "publish")
  facts.fresh.assets = facts.fresh.assets.filter(
    (asset) => asset.assetName !== "recovery-v2-finalization.json",
  )
  blocked(facts, "PUBLICATION_READY")
})

test("bounded facts can carry a large valid retained selection across repeated proof inventories", () => {
  const facts = recoveryFacts({ phase: "COMPLETE", retainedCount: 1400 })
  assert.ok(Buffer.byteLength(JSON.stringify(facts)) > 1024 * 1024)
  const result = plan(facts)
  assert.equal(result.outcome, "complete", result.errors.join("; "))
  assert.equal(result.after, "COMPLETE")
  assert.deepEqual(result.effects, [])
})

test("new reviewed controller resumes persisted adoption before the first marker", () => {
  const facts = recoveryFacts()
  const historic = structuredClone(facts.adoption)
  facts.executor = executor({ controllerSha: "e".repeat(40), runId: "999", jobId: "998" })
  facts.capability.controllerSha = facts.executor.controllerSha
  facts.authority.reviewedControllerSha = facts.executor.controllerSha
  facts.ownership.controllerSha = facts.executor.controllerSha
  const result = plan(facts)
  assert.equal(result.after, "RECOVERY_ADOPTED", result.errors.join("; "))
  assert.deepEqual(facts.adoption, historic)
  facts.adoption.admission = null
  blocked(facts, "NPM_COMPLETE")
})
test("first finalization needs no fictitious uploaded asset ID or persisted proposal", () => {
  const facts = recoveryFacts({ phase: "AUDIT_VERIFIED" })
  assert.equal(facts.proposedFinalization.ref, undefined)
  assert.equal(plan(facts).outcome, "planned")
  facts.proposedFinalization = null
  const result = plan(facts)
  assert.equal(result.outcome, "planned", result.errors.join("; "))
  assert.equal(result.after, "AUDIT_VERIFIED")
  assert.deepEqual(result.effects, [
    { operation: "finalize", target: "recovery-v2-finalization.json" },
  ])
})

test("finalization preserves monotonic marker revisions", () => {
  const proposed = recoveryFacts({ phase: "AUDIT_VERIFIED" })
  proposed.proposedFinalization.receipt.metadata.markerRevision = 1
  blocked(proposed, "AUDIT_VERIFIED")
  proposed.proposedFinalization.receipt.metadata.markerRevision = proposed.marker.revision
  blocked(proposed, "AUDIT_VERIFIED")
  const persisted = recoveryFacts({ phase: "PUBLICATION_READY" })
  persisted.marker.revision = 999
  blocked(persisted, "PUBLICATION_READY")
  const lagging = recoveryFacts({ phase: "RECOVERY_ADOPTED" })
  const receipt = lagging.proposedFinalization.receipt
  lagging.finalization = {
    receipt,
    ref: receiptRef(receipt, "recovery-v2-finalization.json", 34),
    inventory: receipt.assets,
  }
  lagging.fresh.assets = [...receipt.assets, lagging.finalization.ref].sort((a, b) =>
    a.assetName < b.assetName ? -1 : 1,
  )
  lagging.marker.revision = receipt.metadata.markerRevision
  blocked(lagging, "RECOVERY_ADOPTED")
})

test("persisted finalization needs current verifier eligibility before any mutable publication", () => {
  for (const phase of ["AUDIT_VERIFIED", "PUBLICATION_READY"]) {
    const facts = recoveryFacts({ phase })
    facts.executor.verifierClosureSha256 = digest("different verifier implementation")
    facts.capability.verifierClosureSha256 = facts.executor.verifierClosureSha256
    blocked(facts, phase)
  }
  const completed = recoveryFacts({ phase: "COMPLETE" })
  completed.executor.verifierClosureSha256 = digest("different verifier implementation")
  completed.capability.verifierClosureSha256 = completed.executor.verifierClosureSha256
  assert.equal(plan(completed).outcome, "complete")
})

test("proxy facts are blocked without invoking observation traps", () => {
  let calls = 0
  const wrap = (value) =>
    new Proxy(value, {
      get() {
        calls++
        throw new Error("proxy get executed")
      },
      getPrototypeOf() {
        calls++
        throw new Error("proxy prototype executed")
      },
      ownKeys() {
        calls++
        throw new Error("proxy keys executed")
      },
      getOwnPropertyDescriptor() {
        calls++
        throw new Error("proxy descriptor executed")
      },
    })
  assert.equal(plan(wrap(recoveryFacts())).outcome, "blocked")
  const nested = recoveryFacts()
  nested.adoption = wrap(nested.adoption)
  assert.equal(plan(nested).outcome, "blocked")
  assert.equal(calls, 0)
})

test("exhausted revisions block work that would need a newer durable marker", () => {
  for (const phase of [
    "RECOVERY_ADOPTED",
    "VERIFICATION_COMPLETE",
    "AUDIT_PENDING",
    "AUDIT_VERIFIED",
  ]) {
    const facts = recoveryFacts({ phase })
    facts.marker.revision = Number.MAX_SAFE_INTEGER
    if (phase === "AUDIT_VERIFIED") facts.proposedFinalization = null
    blocked(facts, phase)
  }
  const ready = recoveryFacts({ phase: "PUBLICATION_READY" })
  ready.marker.revision = Number.MAX_SAFE_INTEGER
  ready.finalization.receipt.metadata.markerRevision = Number.MAX_SAFE_INTEGER
  ready.finalization.ref = receiptRef(
    ready.finalization.receipt,
    "recovery-v2-finalization.json",
    34,
  )
  ready.marker.finalization = ready.finalization.ref
  ready.fresh.assets = [...ready.finalization.inventory, ready.finalization.ref].sort((a, b) =>
    a.assetName < b.assetName ? -1 : 1,
  )
  assert.equal(plan(ready).outcome, "planned")
  assert.deepEqual(plan(ready).effects, [{ operation: "publish", target: "902" }])
  const completed = recoveryFacts({ phase: "COMPLETE" })
  completed.marker.revision = Number.MAX_SAFE_INTEGER
  assert.equal(plan(completed).outcome, "complete")
})
