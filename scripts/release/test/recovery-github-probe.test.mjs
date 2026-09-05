import assert from "node:assert/strict"
import test from "node:test"

const probe = await import("./support/recovery-github-probe.mjs").catch(() => ({}))

test("service probe reads all unfiltered pages and rejects changed totals and duplicate identities", async () => {
  assert.equal(typeof probe.readProbeInventory, "function")
  const records = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, status: "completed" }))
  const paths = []
  const read = async (path) => {
    paths.push(path)
    const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"))
    return {
      id: `page-${page}`,
      response: { total_count: 101, workflow_runs: records.slice((page - 1) * 100, page * 100) },
    }
  }
  assert.equal(
    (await probe.readProbeInventory(read, "/repos/example/lab/actions/workflows/12")).records
      .length,
    101,
  )
  assert.deepEqual(paths, [
    "/repos/example/lab/actions/workflows/12/runs?per_page=100&page=1",
    "/repos/example/lab/actions/workflows/12/runs?per_page=100&page=2",
  ])
  for (const change of ["total", "duplicate", "short", "active"]) {
    await assert.rejects(
      probe.readProbeInventory(async (path) => {
        const call = await read(path)
        if (path.endsWith("page=2")) {
          if (change === "total") call.response.total_count++
          if (change === "duplicate") call.response.workflow_runs[0] = records[0]
          if (change === "short") call.response.workflow_runs = []
          if (change === "active")
            call.response.workflow_runs[0] = { id: 101, status: "in_progress" }
        }
        return call
      }, "/repos/example/lab/actions/workflows/12"),
      /inventory|drained/,
    )
  }
})

test("36 service cases preserve raw correlations and produce an admissible witness", async () => {
  const { fenceEvidenceFixture } = await import("./support/recovery-fence-fixture.mjs")
  const { projectRecoveryFenceEvidence } = await import("../recovery/fence-evidence.mjs")
  const { evidence, fixtureBytes } = await fenceEvidenceFixture()
  const start = evidence.calls.findIndex((c) => c.id === evidence.setup.historicalTagCall) + 1
  let index = start
  const sleeps = []
  const seedRun = evidence.calls.find((c) => c.id === evidence.setup.historicalSeedRunCall).response
  const matrix = await probe.exerciseRecoveryFenceMatrix({
    evidence: { ...evidence, seed: { id: seedRun.id, attempt: seedRun.run_attempt } },
    api: async (method, path, body) => {
      const next = evidence.calls[index++]
      assert.deepEqual(
        { method, path, body },
        { method: next.method, path: next.path, body: next.body },
      )
      return structuredClone(next)
    },
    sleep: async (ms) => sleeps.push(ms),
  })
  assert.equal(index, evidence.calls.length)
  assert.equal(matrix.cases.length, 36)
  assert.deepEqual(sleeps, Array(12).fill(5000))
  const { calls, ...witness } = evidence
  const result = projectRecoveryFenceEvidence(
    calls,
    { ...witness, ...matrix },
    { fixtureBytes, probeClosureSha256: evidence.probeClosureSha256 },
  )
  assert.equal(result.cases.length, 36)
})

test("service recorder manifest covers the exact reviewed executable closure", async () => {
  const { RECOVERY_FENCE_PROBE_INPUTS } = await import("../recovery/fence.mjs")
  assert.deepEqual(probe.PROBE_SOURCE_PATHS, RECOVERY_FENCE_PROBE_INPUTS)
})

for (const failure of ["accepted-disabled", "unknown-disable", "unknown-dispatch"]) {
  test(`service probe restores and drains after ${failure}`, async () => {
    const { fenceEvidenceFixture } = await import("./support/recovery-fence-fixture.mjs")
    const { evidence } = await fenceEvidenceFixture()
    let index = evidence.calls.findIndex((c) => c.id === evidence.setup.historicalTagCall) + 1
    let failed = false
    const restored = []
    const seed = evidence.calls.find((c) => c.id === evidence.setup.historicalSeedRunCall).response
    await assert.rejects(
      probe.exerciseRecoveryFenceMatrix({
        evidence: { ...evidence, seed: { id: seed.id, attempt: 1 } },
        sleep: async () => {},
        api: async (method, path, body) => {
          if (failed) {
            restored.push({ method, path })
            if (method === "PUT") return { status: 204 }
            if (path.includes("/runs?"))
              return { id: "cleanup", status: 200, response: { total_count: 0, workflow_runs: [] } }
            return {
              status: 200,
              response: {
                id: Number(evidence.workflowId),
                path: evidence.workflow,
                state: "active",
              },
            }
          }
          const next = structuredClone(evidence.calls[index++])
          assert.deepEqual(
            { method, path, body },
            { method: next.method, path: next.path, body: next.body },
          )
          if (failure === "unknown-disable" && path.endsWith("/disable")) {
            failed = true
            throw new Error("unknown response")
          }
          if (failure === "unknown-dispatch" && method === "POST" && next.status === 422) {
            failed = true
            throw new Error("unknown response")
          }
          if (failure === "accepted-disabled" && next.status === 422) {
            failed = true
            next.status = 200
          }
          return next
        },
      }),
      /unknown response|insufficient/,
    )
    assert.deepEqual(
      restored.map((r) => r.method),
      ["PUT", "GET", "GET"],
    )
    assert.ok(restored[0].path.endsWith("/enable"))
    assert.ok(restored[2].path.endsWith("/runs?per_page=100&page=1"))
  })
}

test("service driver accepts GitHub's empty object rerun acknowledgement and still observes execution", async () => {
  const { fenceEvidenceFixture } = await import("./support/recovery-fence-fixture.mjs")
  const { evidence } = await fenceEvidenceFixture()
  let index = evidence.calls.findIndex((c) => c.id === evidence.setup.historicalTagCall) + 1
  const seed = evidence.calls.find((c) => c.id === evidence.setup.historicalSeedRunCall).response
  const matrix = await probe.exerciseRecoveryFenceMatrix({
    evidence: { ...evidence, seed: { id: seed.id, attempt: 1 } },
    sleep: async () => {},
    api: async (method, path, body) => {
      const call = structuredClone(evidence.calls[index++])
      assert.deepEqual(
        { method, path, body },
        { method: call.method, path: call.path, body: call.body },
      )
      if (method === "POST" && call.status === 201) call.response = {}
      return call
    },
  })
  assert.equal(matrix.cases.length, 36)
  assert.equal(index, evidence.calls.length)
})
