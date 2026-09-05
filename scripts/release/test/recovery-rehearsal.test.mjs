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
