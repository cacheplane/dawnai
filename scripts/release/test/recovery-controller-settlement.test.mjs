import assert from "node:assert/strict"
import test from "node:test"
import { adoptRecoveryCandidate } from "../recovery/adopt.mjs"
import { dispatchRecoveryAudit } from "../recovery/audit.mjs"
import { collectRecoveryEvidence } from "../recovery/evidence.mjs"
import { createRecoveryWriter } from "../recovery/writer.mjs"
import { auditRemote } from "./support/recovery-audit-fixture.mjs"
import { evidenceRemote } from "./support/recovery-evidence-fixture.mjs"
import { recoveryWriteRemote } from "./support/recovery-write-fixture.mjs"

const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const flush = async () => {
  for (let i = 0; i < 1000; i++) await Promise.resolve()
}
for (const [name, fixture, controller] of [
  ["adopt", recoveryWriteRemote, adoptRecoveryCandidate],
  ["evidence", evidenceRemote, collectRecoveryEvidence],
  ["audit", auditRemote, dispatchRecoveryAudit],
]) {
  for (const stalled of ["create", "verifyPackages", "dispose"])
    test(`${name} initial ${stalled} timeout retains managed ownership across controller recreation`, async () => {
      const r = await fixture()
      const started = deferred(),
        raw = deferred(),
        cleanupStarted = deferred(),
        cleanup = deferred()
      const originalCreate = r.args.npmAuditFactory.create
      let created = 0,
        disposed = 0
      r.args.npmAuditFactory.create = async () => {
        const index = ++created
        const actual = await originalCreate()
        if (index === 1 && stalled === "create") {
          started.resolve()
          await raw.promise
        }
        return {
          async verifyPackages(args) {
            if (index === 1 && stalled === "verifyPackages") {
              started.resolve()
              await raw.promise
            }
            return actual.verifyPackages(args)
          },
          async dispose() {
            disposed++
            if (index === 1) {
              if (stalled === "dispose") started.resolve()
              cleanupStarted.resolve()
              await cleanup.promise
            }
            return actual.dispose()
          },
        }
      }
      const originalSet = globalThis.setTimeout,
        originalClear = globalThis.clearTimeout
      const timers = []
      globalThis.setTimeout = (fn, delay) => {
        const timer = { fn, delay, cleared: false }
        timers.push(timer)
        return timer
      }
      globalThis.clearTimeout = (timer) => {
        if (timer) timer.cleared = true
      }
      try {
        const result = controller(r.request, r.config, r.dependencies)
        await started.promise
        for (const t of timers.filter((t) => !t.cleared && t.delay > 1000000)) t.fn()
        await assert.rejects(result, /deadline/)
        await flush()
        await assert.rejects(controller(r.request, r.config, r.dependencies), /unsettled/)
        assert.equal(created, 1)
        assert.equal(r.effects.length, 0)
        raw.resolve()
        await cleanupStarted.promise
        assert.throws(() => createRecoveryWriter(r.config, r.dependencies), /unsettled/)
        assert.equal(disposed, 1)
        cleanup.resolve()
        await flush()
        const observed = await createRecoveryWriter(
          r.config,
          r.dependencies,
        ).observeRecoveryCandidate({
          candidate: r.request.candidate,
          expectedControllerSha: r.request.expectedControllerSha,
          intentPath: r.request.intentPath,
        })
        assert.notEqual(observed.outcome, "blocked")
        assert.equal(created, 2)
        assert.equal(disposed, 2)
        assert.equal(r.effects.length, 0)
      } finally {
        raw.resolve()
        cleanup.resolve()
        globalThis.setTimeout = originalSet
        globalThis.clearTimeout = originalClear
      }
    })
}
for (const [name, fixture, controller] of [
  ["adopt", recoveryWriteRemote, adoptRecoveryCandidate],
  ["evidence", evidenceRemote, collectRecoveryEvidence],
  ["audit", auditRemote, dispatchRecoveryAudit],
])
  test(`${name} initial pending GET releases harmless ownership but cannot start late managed work`, async () => {
    const r = await fixture()
    const started = deferred(),
      raw = deferred()
    const originalGet = r.args.github.getRelease
    const originalCreate = r.args.npmAuditFactory.create
    let created = 0
    r.args.npmAuditFactory.create = async () => {
      created++
      return originalCreate()
    }
    r.args.github.getRelease = async () => {
      started.resolve()
      return raw.promise
    }
    const originalSet = globalThis.setTimeout,
      originalClear = globalThis.clearTimeout
    const timers = []
    globalThis.setTimeout = (fn, delay) => {
      const timer = { fn, delay, cleared: false }
      timers.push(timer)
      return timer
    }
    globalThis.clearTimeout = (timer) => {
      if (timer) timer.cleared = true
    }
    try {
      const result = controller(r.request, r.config, r.dependencies)
      await started.promise
      for (const t of timers.filter((t) => !t.cleared && t.delay > 1000000)) t.fn()
      await assert.rejects(result, /deadline/)
      assert.doesNotThrow(() => createRecoveryWriter(r.config, r.dependencies))
      r.args.github.getRelease = originalGet
      raw.resolve(await originalGet({ releaseId: r.c.releaseId }))
      await flush()
      assert.equal(created, 0)
      assert.equal(r.effects.length, 0)
    } finally {
      raw.resolve({ status: "ERROR" })
      globalThis.setTimeout = originalSet
      globalThis.clearTimeout = originalClear
    }
  })
