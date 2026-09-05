import assert from "node:assert/strict"
import test from "node:test"

import * as module from "./support/recovery-rehearsal.mjs"

test("production HTTP recovery arc preserves payload through adoption, audit, publication and next-version arbitration", {
  timeout: 120000,
}, async () => {
  assert.equal(typeof module.createRecoveryHttpRehearsal, "function")
  const rehearsal = await module.createRecoveryHttpRehearsal()
  try {
    const result = await rehearsal.drive()
    assert.equal(result.phase, "COMPLETE")
    assert.equal(result.noopWrites, 0)
    assert.equal(result.nextVersionDisposition, "selected")
    assert.equal(result.originalAssetsVerified, 45)
    assert.equal(result.lanesVerified, 5)
    assert.equal(result.npmPublishAttempts, 0)
    assert.equal(result.duplicateDrafts, 0)
    assert.equal(result.duplicateAuditRequests, 0)
    assert.ok(result.httpRequests > 100)
    assert.equal(result.effects.length, 32)
    assert.ok(result.githubNotModified > 1000, "real HTTP 304 confirmations required")
    assert.ok(
      result.githubPrimaryByStage["five-lanes"] < 250,
      "evidence fixture must fit primary quota with headroom",
    )
    assert.ok(
      result.githubPrimaryRequests < 1000,
      "entire fixture arc must fit repository hourly quota",
    )
    assert.ok(result.testSeams.includes("synthetic npm and attestation trust"))
  } finally {
    await rehearsal.close()
  }
})

test("recovery resumes a lost first upload response through independent HTTP readback", {
  timeout: 120000,
}, async () => {
  const rehearsal = await module.createRecoveryHttpRehearsal({ fault: { at: 1, when: "after" } })
  try {
    const result = await rehearsal.drive()
    assert.equal(result.faultTriggered, true)
    assert.equal(result.phase, "COMPLETE")
    assert.equal(result.noopWrites, 0)
    assert.equal(result.duplicateUploads, 0)
    assert.equal(result.npmPublishAttempts, 0)
  } finally {
    await rehearsal.close()
  }
})

test("interruptions before and after every recovery mutation resume without duplicate publication", {
  timeout: 1200000,
  concurrency: 2,
}, async (t) => {
  // The baseline test binds this inventory to the current complete production arc.
  const cases = []
  for (let at = 1; at <= 32; at++) {
    for (const when of ["before", "after"]) {
      cases.push(
        t.test(`effect ${at} ${when}`, { timeout: 120000 }, async () => {
          const rehearsal = await module.createRecoveryHttpRehearsal({ fault: { at, when } })
          try {
            const result = await rehearsal.drive()
            assert.equal(result.faultTriggered, true)
            assert.equal(result.phase, "COMPLETE")
            assert.equal(result.noopWrites, 0)
            assert.equal(result.nextVersionDisposition, "selected")
            assert.equal(result.originalAssetsVerified, 45)
            assert.equal(result.duplicateUploads, 0)
            assert.equal(result.npmPublishAttempts, 0)
            assert.equal(result.duplicateDrafts, 0)
            assert.equal(result.duplicateAuditRequests, 0)
            assert.equal(result.resumes.length, 1)
          } finally {
            await rehearsal.close()
          }
        }),
      )
    }
  }
  await Promise.all(cases)
})

test("real fence HTTP recovery includes complete paginated histories and fresh phase readers", {
  timeout: 240000,
}, async (t) => {
  const rehearsal = await module.createRecoveryHttpRehearsal({ realFence: true })
  try {
    const result = await rehearsal.drive()
    assert.equal(result.phase, "COMPLETE")
    assert.equal(result.effects.length, 32)
    assert.equal(result.originalAssetsVerified, 45)
    assert.equal(result.lanesVerified, 5)
    assert.equal(result.noopWrites, 0)
    assert.equal(result.nextVersionDisposition, "selected")
    assert.ok(result.fenceObservations.length >= 60)
    assert.ok(
      result.fenceObservations.every((f) => f.complete && f.pages === 14 && f.writers === 4),
    )
    assert.ok(result.fenceHistoryNotModified > 600)
    assert.ok(result.githubPrimaryRequests < 1000)
    const unconditional = await module.createRecoveryHttpRehearsal({
      realFence: true,
      conditionalReads: false,
    })
    try {
      const baseline = await unconditional.drive()
      assert.deepEqual(baseline.effects, result.effects)
      assert.deepEqual(baseline.fenceObservations, result.fenceObservations)
      assert.equal(baseline.httpRequests, result.httpRequests)
      assert.equal(baseline.githubNotModified, 0)
      assert.ok(result.githubPrimaryRequests < baseline.githubPrimaryRequests / 4)
      t.diagnostic(
        JSON.stringify({
          realFence: true,
          metadataFieldsPerRun: 220,
          paddingBytesPerRun: 8000,
          httpRequests: result.httpRequests,
          fenceObservations: result.fenceObservations.length,
          conditionalPrimary: result.githubPrimaryRequests,
          unconditionalPrimary: baseline.githubPrimaryRequests,
          confirmations304: result.githubNotModified,
          fenceHistory304: result.fenceHistoryNotModified,
        }),
      )
    } finally {
      await unconditional.close()
    }
    for (const stage of [
      "adopt",
      "five-lanes",
      "audit-dispatch",
      "audit-escrow",
      "finalize",
      "publish",
    ]) {
      const first = rehearsal.requests.find(
        (q) => q.stage === stage && q.fence && q.path.endsWith("/runs"),
      )
      assert.equal(first.httpStatus, 200, `cold reader at ${stage}`)
      assert.equal(first.conditional, false)
    }
  } finally {
    await rehearsal.close()
  }
})

test("malformed real fence history prevents the next recovery write", {
  timeout: 120000,
}, async () => {
  const rehearsal = await module.createRecoveryHttpRehearsal({
    realFence: true,
    malformedFence: true,
  })
  try {
    await assert.rejects(rehearsal.drive(), /terminal drained runs required|stopped/)
    assert.equal(rehearsal.requests.filter((q) => q.method !== "GET").length, 0)
    assert.ok(rehearsal.requests.some((q) => q.fence && q.path.endsWith("/runs")))
  } finally {
    await rehearsal.close()
  }
})

test("real fence readers reset after an uncertain upload and preserve the complete recovery arc", {
  timeout: 120000,
}, async () => {
  const rehearsal = await module.createRecoveryHttpRehearsal({
    realFence: true,
    fault: { at: 1, when: "after" },
  })
  try {
    const result = await rehearsal.drive()
    assert.equal(result.phase, "COMPLETE")
    assert.equal(result.faultTriggered, true)
    assert.equal(result.resumes.length, 1)
    assert.equal(result.duplicateUploads, 0)
    assert.equal(result.noopWrites, 0)
    assert.ok(result.fenceObservations.length > 60)
    const firstPages = rehearsal.requests.filter(
      (q) =>
        q.fence &&
        q.stage === "adopt" &&
        q.path.endsWith("/804/runs") &&
        !q.search.includes("&page="),
    )
    assert.equal(firstPages.filter((q) => !q.conditional && q.httpStatus === 200).length, 2)
  } finally {
    await rehearsal.close()
  }
})
