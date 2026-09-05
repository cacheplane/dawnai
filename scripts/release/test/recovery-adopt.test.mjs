import assert from "node:assert/strict"
import test from "node:test"
import { parseRecoveryReleaseMarker } from "../recovery/metadata.mjs"
import { parseRecovery } from "../recovery/schema.mjs"
import { recoveryWriteRemote } from "./support/recovery-write-fixture.mjs"

const module = await import("../recovery/adopt.mjs").catch(() => ({}))
const adopt = (r) => {
  assert.equal(typeof module.adoptRecoveryCandidate, "function")
  return module.adoptRecoveryCandidate(r.request, r.config, r.dependencies)
}
test("adoption archives exact legacy bytes and verified original inventory before revision one", async () => {
  const r = await recoveryWriteRemote()
  const result = await adopt(r)
  assert.equal(result.phase, "RECOVERY_ADOPTED")
  assert.deepEqual(
    r.effects.map((e) => e.method),
    ["POST", "POST", "PATCH"],
  )
  const marker = parseRecoveryReleaseMarker(r.release.body)
  assert.equal(marker.revision, 1)
  const receipt = parseRecovery(r.raws.get(marker.adoption.assetName))
  assert.deepEqual(receipt.baseAssets, r.baseAssets)
  assert.deepEqual(receipt.executor, r.execution)
  assert.equal(receipt.npmEvidence.conclusion, "success")
  assert.equal(r.raws.get(receipt.archive.assetName).toString(), r.legacyBody)
  assert.match(marker.adoption.assetName, new RegExp(r.execution.controllerSha))
  await adopt(r)
  assert.equal(r.effects.length, 3)
})
for (const stop of [1, 2, 3])
  for (const takeover of [false, true])
    test(`adoption resumes interruption ${stop} with ${takeover ? "new" : "same"} attempt`, async () => {
      const r = await recoveryWriteRemote()
      r.interruptAfter(stop)
      await assert.rejects(adopt(r))
      if (takeover) {
        r.execution.runId = "1903"
        r.execution.runAttempt = "2"
      }
      const result = await adopt(r)
      assert.equal(result.phase, "RECOVERY_ADOPTED")
      const marker = parseRecoveryReleaseMarker(r.release.body)
      const receipt = parseRecovery(r.raws.get(marker.adoption.assetName))
      assert.deepEqual(receipt.baseAssets, r.baseAssets)
      if (takeover && stop === 2) assert.equal(receipt.retainedAttempts.length, 1)
      assert.equal(r.effects.filter((e) => e.method === "PATCH").length, 1)
    })

test("foreign partial recovery assets block adoption before effects", async () => {
  const r = await recoveryWriteRemote()
  const foreign = r.add("recovery-v2-foreign.json", "{}\n")
  r.activate([...r.baseAssets, foreign])
  await assert.rejects(adopt(r))
  assert.equal(r.effects.length, 0)
})

test("canonical but foreign-named adoption asset cannot enter partial migration inventory", async () => {
  const r = await recoveryWriteRemote()
  const foreign = r.add("recovery-v2-foreign.json", r.adoption)
  r.activate([...r.baseAssets, r.adoption.archive, foreign])
  await assert.rejects(adopt(r), /name|namespace/)
  assert.equal(r.effects.length, 0)
})

test("adoption request and dependency proxies/accessors are rejected without executing traps", async () => {
  const r = await recoveryWriteRemote()
  let traps = 0
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        traps++
        return undefined
      },
    },
  )
  await assert.rejects(module.adoptRecoveryCandidate(r.request, r.config, proxy))
  const accessor = { ...r.dependencies }
  Object.defineProperty(accessor, "observation", {
    enumerable: true,
    get() {
      traps++
      return r.args
    },
  })
  await assert.rejects(module.adoptRecoveryCandidate(r.request, r.config, accessor))
  assert.equal(traps, 0)
})

test("authority is recaptured immediately before each migration mutation", async () => {
  const r = await recoveryWriteRemote()
  const fence = r.dependencies.authority.observeLegacyFence
  r.dependencies.authority.observeLegacyFence = async () => {
    if (r.effects.length === 1) r.setFence(false)
    return fence()
  }
  await assert.rejects(adopt(r), /fence/)
  assert.equal(r.effects.length, 1)
  assert.equal(r.release.body, r.legacyBody)
})

test("freshly observed but expired fence causes no mutation", async () => {
  const r = await recoveryWriteRemote()
  r.dependencies.authority.now = () => 31000
  await assert.rejects(adopt(r), /expired|fresh/)
  assert.equal(r.effects.length, 0)
})

test("new compatible controller retains earlier attempt authority before and after durable adoption", async () => {
  const r = await recoveryWriteRemote()
  r.interruptAfter(2)
  await assert.rejects(adopt(r))
  const github = r.args.github
  const methods = { ...github }
  const nextSha = "f".repeat(40)
  r.execution.controllerSha = nextSha
  r.execution.runId = "1903"
  r.execution.runAttempt = "2"
  r.request.expectedControllerSha = nextSha
  const adapt = (run) => ({ ...run, id: 1700, head_sha: nextSha, check_suite_id: 1900 })
  github.getRef = async (args) =>
    args.ref === "heads/main"
      ? {
          status: "PRESENT",
          value: { ref: "refs/heads/main", object: { type: "commit", sha: nextSha } },
        }
      : methods.getRef(args)
  github.listWorkflowRuns = async (args) => {
    const result = await methods.listWorkflowRuns(args)
    return args.commitSha === nextSha ? { ...result, value: result.value.map(adapt) } : result
  }
  github.getActionsRunAttempt = async (args) =>
    String(args.runId) === "1700"
      ? {
          status: "PRESENT",
          value: adapt((await methods.getActionsRunAttempt({ runId: "700" })).value),
        }
      : methods.getActionsRunAttempt(args)
  github.listActionsRunJobs = async (args) =>
    String(args.runId) === "1700"
      ? {
          status: "PRESENT",
          value: (await methods.listActionsRunJobs({ runId: "700" })).value.map((j) => ({
            ...j,
            id: j.id + 1000,
          })),
        }
      : methods.listActionsRunJobs(args)
  github.getCommitCheckRuns = async (args) => {
    const result = await methods.getCommitCheckRuns(args)
    return args.commitSha === nextSha
      ? {
          ...result,
          value: result.value.map((c) => ({
            ...c,
            id: c.id + 1000,
            head_sha: nextSha,
            check_suite: { id: 1900 },
          })),
        }
      : result
  }
  const result = await adopt(r)
  assert.equal(result.phase, "RECOVERY_ADOPTED")
  const marker = parseRecoveryReleaseMarker(r.release.body)
  const receipt = parseRecovery(r.raws.get(marker.adoption.assetName))
  assert.equal(receipt.executor.controllerSha, nextSha)
  assert.equal(receipt.retainedAttempts.length, 1)
  const count = r.effects.length
  assert.equal((await adopt(r)).phase, "RECOVERY_ADOPTED")
  assert.equal(r.effects.length, count)
})
