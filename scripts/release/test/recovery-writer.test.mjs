import assert from "node:assert/strict"
import test from "node:test"
import { createGitHubReader } from "../adapters/github.mjs"
import { renderRecoveryFinalMetadata, renderRecoveryReleaseBody } from "../recovery/metadata.mjs"
import { canonicalRecoveryBytes } from "../recovery/schema.mjs"
import { digest } from "./support/recovery-fixture.mjs"
import { recoveryWriteRemote } from "./support/recovery-write-fixture.mjs"

const module = await import("../recovery/writer.mjs").catch(() => ({}))
const writer = (r) => {
  assert.equal(typeof module.createRecoveryWriter, "function")
  return module.createRecoveryWriter(r.config, r.dependencies)
}
const archiveInput = (r) => ({
  ...r.request,
  expectedBodySha256: digest(r.legacyBody),
  name: r.adoption.archive.assetName,
  contentBase64: Buffer.from(r.legacyBody).toString("base64"),
})

test("recovery writer exposes only bounded release effects and independent audit dispatch", async () => {
  const r = await recoveryWriteRemote()
  assert.deepEqual(Object.keys(writer(r)).sort(), [
    "dispatchRecoveryAudit",
    "publishRecoveryDraft",
    "updateRecoveryDraft",
    "uploadRecoveryAsset",
  ])
  const ref = await writer(r).uploadRecoveryAsset(archiveInput(r))
  assert.equal(ref.assetName, r.adoption.archive.assetName)
  assert.equal(r.effects.length, 1)
  assert.equal(r.events.at(-2), "fence")
  assert.equal(r.events.at(-1), "POST")
  assert.deepEqual(await writer(r).uploadRecoveryAsset(archiveInput(r)), ref)
  assert.equal(r.effects.length, 1)
})

for (const [name, mutate] of [
  ["lost fence", (r) => r.setFence(false)],
  [
    "changed legacy body",
    (r) => {
      r.release.body += "external edit"
    },
  ],
  [
    "incomplete npm",
    (r) => {
      r.args.npm.observePackageVersion = async () => ({ status: "ABSENT", httpStatus: 404 })
    },
  ],
])
  test(`${name} causes zero recovery effects`, async () => {
    const r = await recoveryWriteRemote()
    mutate(r)
    await assert.rejects(writer(r).uploadRecoveryAsset(archiveInput(r)))
    assert.equal(r.effects.length, 0)
  })

test("JSON cannot grant authority or select arbitrary write URLs and asset namespaces", async () => {
  const r = await recoveryWriteRemote()
  const w = writer(r)
  for (const extra of [
    { authorize: true },
    { authority: r.adoption.authority },
    { url: "https://evil.test" },
    { name: "manifest.json" },
    { name: "recovery-v2-untyped.json" },
  ])
    await assert.rejects(w.uploadRecoveryAsset({ ...archiveInput(r), ...extra }))
  assert.throws(() =>
    module.createRecoveryWriter({ ...r.config, apiOrigin: "https://evil.test" }, r.dependencies),
  )
  assert.equal(r.effects.length, 0)
})

test("uncertain upload stops the invocation and resume reobserves the existing exact bytes", async () => {
  const r = await recoveryWriteRemote()
  r.interruptAfter(1)
  const w = writer(r)
  await assert.rejects(w.uploadRecoveryAsset(archiveInput(r)), /uncertain|resume|write failed/)
  await assert.rejects(w.uploadRecoveryAsset(archiveInput(r)), /resume|stopped|uncertain/)
  const ref = await writer(r).uploadRecoveryAsset(archiveInput(r))
  assert.equal(ref.sha256, digest(r.legacyBody))
  assert.equal(r.effects.length, 1)
})

test("same-name equal bytes cannot reuse a forbidden original asset namespace", async () => {
  const r = await recoveryWriteRemote()
  await assert.rejects(
    writer(r).uploadRecoveryAsset({
      ...archiveInput(r),
      name: "manifest.json",
      contentBase64: r.raws.get("manifest.json").toString("base64"),
    }),
  )
  assert.equal(r.effects.length, 0)
})

test("same-name differing bytes never overwrite a recovery asset", async () => {
  const r = await recoveryWriteRemote()
  r.activate([...r.baseAssets, r.adoption.archive])
  await assert.rejects(
    writer(r).uploadRecoveryAsset({
      ...archiveInput(r),
      contentBase64: Buffer.from("differing").toString("base64"),
    }),
  )
  assert.equal(r.effects.length, 0)
})

test("legacy marker with invalid fixed finalization cannot reuse equal archive bytes", async () => {
  const r = await recoveryWriteRemote()
  const invalid = {
    ...r.finalization,
    assets: r.finalization.assets.filter((a) => a.assetName !== r.adoption.archive.assetName),
  }
  const finalRef = r.add("recovery-v2-finalization.json", invalid)
  r.activate([...r.allAssets.filter((a) => a.assetName !== finalRef.assetName), finalRef])
  await assert.rejects(
    writer(r).uploadRecoveryAsset(archiveInput(r)),
    /legacy.*finalization|finalization.*legacy/,
  )
  assert.equal(r.effects.length, 0)
})

test("write failure preserves HTTP status without exposing service credentials", async () => {
  const r = await recoveryWriteRemote()
  r.dependencies.fetchImpl = async () =>
    new Response(
      JSON.stringify({ message: `temporary failure ${r.config.token} npm_${"a".repeat(25)}` }),
      { status: 503, headers: { "content-type": "application/json" } },
    )
  await assert.rejects(writer(r).uploadRecoveryAsset(archiveInput(r)), (error) => {
    assert.equal(error.httpStatus, 503)
    assert.match(error.message, /503/)
    assert.ok(!error.message.includes(r.config.token))
    assert.ok(!error.message.includes(`npm_${"a".repeat(25)}`))
    return true
  })
})

test("verification marker cannot select a set omitting retained receipts", async () => {
  const r = await recoveryWriteRemote()
  r.activate(r.allAssets.filter((a) => a.assetName !== "recovery-v2-finalization.json"))
  r.release.body = renderRecoveryReleaseBody({ marker: r.marker, body: "Notes" })
  await assert.rejects(
    writer(r).updateRecoveryDraft({
      ...r.request,
      expectedBodySha256: digest(r.release.body),
      title: r.release.name,
      body: renderRecoveryReleaseBody({
        marker: {
          ...r.marker,
          phase: "VERIFICATION_COMPLETE",
          revision: 2,
          verificationSet: r.setRef,
        },
        body: "Notes",
      }),
    }),
    /partial selection must retain every receipt/,
  )
  assert.equal(r.effects.length, 0)
})

test("lane uploads cannot bypass independent artifact admission", async () => {
  const r = await recoveryWriteRemote()
  r.activate([...r.baseAssets, r.adoption.archive, r.adoptionRef])
  r.release.body = renderRecoveryReleaseBody({ marker: r.marker, body: "Notes" })
  await assert.rejects(
    writer(r).uploadRecoveryAsset({
      ...r.request,
      expectedBodySha256: digest(r.release.body),
      name: "recovery-v2-lane-metadata-unproven.json",
      contentBase64: canonicalRecoveryBytes(r.lanes.metadata).toString("base64"),
    }),
    /method|dependency|function/,
  )
  assert.equal(r.effects.length, 0)
})

test("finalization existence freezes uploads even when durable marker lags readiness", async () => {
  const r = await recoveryWriteRemote()
  r.activate(r.allAssets)
  r.release.body = renderRecoveryReleaseBody({
    marker: {
      ...r.marker,
      phase: "AUDIT_VERIFIED",
      revision: 4,
      verificationSet: r.setRef,
      audit: r.auditRef,
    },
    body: "Notes",
  })
  await assert.rejects(
    writer(r).uploadRecoveryAsset({
      ...r.request,
      expectedBodySha256: digest(r.release.body),
      name: "recovery-v2-new-lane.json",
      contentBase64: canonicalRecoveryBytes(r.lanes.metadata).toString("base64"),
    }),
    /freezes/,
  )
  assert.equal(r.effects.length, 0)
})

test("verified publication associates the exact existing candidate tag with the same release", async () => {
  const r = await recoveryWriteRemote()
  r.activate(r.allAssets)
  const metadata = renderRecoveryFinalMetadata(r.finalization, r.finalRef)
  Object.assign(r.release, { name: metadata.title, body: metadata.body })
  const result = await writer(r).publishRecoveryDraft({
    ...r.request,
    expectedBodySha256: digest(r.release.body),
  })
  assert.equal(result.terminal, true)
  assert.deepEqual(JSON.parse(r.effects[0].bytes), { draft: false, tag_name: r.c.tag })
  assert.equal(r.effects.length, 1)
  assert.equal(
    (
      await writer(r).publishRecoveryDraft({
        ...r.request,
        expectedBodySha256: digest(r.release.body),
      })
    ).terminal,
    true,
  )
  assert.equal(r.effects.length, 1)
})

test("two pre-created writers cannot overlap a shared transport transaction", async () => {
  const r = await recoveryWriteRemote()
  const first = writer(r),
    second = writer(r)
  const results = await Promise.allSettled([
    first.uploadRecoveryAsset(archiveInput(r)),
    second.uploadRecoveryAsset(archiveInput(r)),
  ])
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
  assert.equal(r.effects.length, 1)
  assert.equal(r.events.filter((event) => event === "POST").length, 1)
})

test("invalid frozen finalization blocks even equal-byte reuse before readiness marker", async () => {
  const r = await recoveryWriteRemote()
  const bad = {
    ...r.finalization,
    assets: r.finalization.assets.filter((a) => a.assetName !== r.adoption.archive.assetName),
  }
  const finalRef = r.add("recovery-v2-finalization.json", bad)
  r.activate([...r.allAssets.filter((a) => a.assetName !== finalRef.assetName), finalRef])
  r.release.body = renderRecoveryReleaseBody({
    marker: {
      ...r.marker,
      phase: "AUDIT_VERIFIED",
      revision: 4,
      verificationSet: r.setRef,
      audit: r.auditRef,
    },
    body: "Notes",
  })
  await assert.rejects(
    writer(r).uploadRecoveryAsset({
      ...r.request,
      expectedBodySha256: digest(r.release.body),
      name: finalRef.assetName,
      contentBase64: canonicalRecoveryBytes(bad).toString("base64"),
    }),
  )
  assert.equal(r.effects.length, 0)
})

test("production GitHub reader redownloads uploaded bytes using numeric IDs and exact release endpoints", async () => {
  const r = await recoveryWriteRemote()
  const original = r.args.github
  const reads = []
  const production = createGitHubReader({
    owner: "cacheplane",
    repo: "dawnai",
    repositoryId: r.c.repositoryId,
    token: "test-reader-token",
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "GET")
      assert.equal(new URL(url).origin, "https://api.github.com")
      reads.push(url)
      const path = decodeURIComponent(new URL(url).pathname)
      let result
      if (path === "/repos/cacheplane/dawnai/releases/902")
        result = await original.getRelease({ releaseId: "902" })
      else if (path === "/repos/cacheplane/dawnai/releases/902/assets")
        result = await original.listReleaseAssets({ releaseId: "902" })
      else if (path.includes("/releases/assets/")) {
        result = await original.downloadReleaseAsset({ assetId: path.split("/").at(-1) })
        return new Response(Buffer.from(result.contentBase64, "base64"), {
          headers: { "content-type": "application/octet-stream" },
        })
      } else if (path.includes("/git/ref/"))
        result = await original.getRef({ ref: path.split("/git/ref/")[1] })
      else if (path.includes("/git/tags/"))
        result = await original.getGitTag({ tagSha: path.split("/").at(-1) })
      else throw new Error(`unexpected read ${path}`)
      return new Response(JSON.stringify(result.value), {
        headers: { "content-type": "application/json" },
      })
    },
  })
  r.dependencies.observation = {
    ...r.args,
    github: {
      ...original,
      ...Object.fromEntries(
        ["getRelease", "listReleaseAssets", "downloadReleaseAsset", "getRef", "getGitTag"].map(
          (method) => [method, production[method]],
        ),
      ),
    },
  }
  const ref = await writer(r).uploadRecoveryAsset(archiveInput(r))
  assert.ok(reads.some((url) => url.endsWith(`/releases/assets/${ref.id}`)))
  assert.equal(r.effects.length, 1)
})

test("lost publication response resumes terminal proof without another PATCH", async () => {
  const r = await recoveryWriteRemote()
  r.activate(r.allAssets)
  const rendered = renderRecoveryFinalMetadata(r.finalization, r.finalRef)
  Object.assign(r.release, { name: rendered.title, body: rendered.body })
  r.interruptAfter(1)
  const args = { ...r.request, expectedBodySha256: digest(r.release.body) }
  await assert.rejects(writer(r).publishRecoveryDraft(args), /uncertain/)
  assert.equal((await writer(r).publishRecoveryDraft(args)).terminal, true)
  assert.equal(r.effects.length, 1)
})

test("verified fixed finalization reconstructs only its canonical readiness metadata", async () => {
  const r = await recoveryWriteRemote()
  r.activate(r.allAssets)
  r.release.body = renderRecoveryReleaseBody({
    marker: {
      ...r.marker,
      phase: "AUDIT_VERIFIED",
      revision: 4,
      verificationSet: r.setRef,
      audit: r.auditRef,
    },
    body: "Notes",
  })
  const expectedBodySha256 = digest(r.release.body)
  const rendered = renderRecoveryFinalMetadata(r.finalization, r.finalRef)
  const result = await writer(r).updateRecoveryDraft({
    ...r.request,
    expectedBodySha256,
    title: rendered.title,
    body: rendered.body,
  })
  assert.equal(result.phase, "PUBLICATION_READY")
  assert.equal(r.effects.length, 1)
})

test("finalization upload is validated against actual audit and inventory before being frozen", async () => {
  const r = await recoveryWriteRemote()
  r.activate(r.allAssets.filter((a) => a.assetName !== "recovery-v2-finalization.json"))
  r.release.body = renderRecoveryReleaseBody({
    marker: {
      ...r.marker,
      phase: "AUDIT_VERIFIED",
      revision: 4,
      verificationSet: r.setRef,
      audit: r.auditRef,
    },
    body: "Notes",
  })
  const result = await writer(r).uploadRecoveryAsset({
    ...r.request,
    expectedBodySha256: digest(r.release.body),
    name: "recovery-v2-finalization.json",
    contentBase64: canonicalRecoveryBytes(r.finalization).toString("base64"),
  })
  assert.equal(result.sha256, r.finalRef.sha256)
  assert.equal(r.effects.length, 1)
})

for (const result of [
  { status: "ABSENT", httpStatus: 404 },
  { status: "PRESENT", value: { object: { type: "tag", sha: "f".repeat(40) } } },
])
  test(`absent or wrong candidate tag causes zero publication effects ${result.status}`, async () => {
    const r = await recoveryWriteRemote()
    r.activate(r.allAssets)
    const rendered = renderRecoveryFinalMetadata(r.finalization, r.finalRef)
    Object.assign(r.release, { name: rendered.title, body: rendered.body })
    const getRef = r.args.github.getRef
    r.args.github.getRef = async (args) => (args.ref.startsWith("tags/") ? result : getRef(args))
    await assert.rejects(
      writer(r).publishRecoveryDraft({ ...r.request, expectedBodySha256: digest(r.release.body) }),
    )
    assert.equal(r.effects.length, 0)
  })

for (const status of [
  { repository: "foreign/repo", enabled: true },
  { repository: "cacheplane/dawnai", enabled: false },
  {},
  "enabled",
])
  test(`publication rejects unbound immutable policy ${JSON.stringify(status)}`, async () => {
    const r = await recoveryWriteRemote()
    r.activate(r.allAssets)
    const metadata = renderRecoveryFinalMetadata(r.finalization, r.finalRef)
    Object.assign(r.release, { name: metadata.title, body: metadata.body })
    r.dependencies.observeImmutableReleasePolicy = async () => status
    await assert.rejects(
      writer(r).publishRecoveryDraft({ ...r.request, expectedBodySha256: digest(r.release.body) }),
    )
    assert.equal(r.effects.length, 0)
  })

for (const stalled of ["headers", "body"])
  test(`unsettled ${stalled} timeout blocks all following reads and writes across writer recreation`, async () => {
    const r = await recoveryWriteRemote()
    const originalSet = globalThis.setTimeout,
      originalClear = globalThis.clearTimeout
    const timers = []
    let start, settle
    const started = new Promise((resolve) => {
      start = resolve
    })
    const pending = new Promise((resolve) => {
      settle = resolve
    })
    const body = {
      getReader: () => ({
        read: () => {
          start()
          return pending
        },
        cancel: async () => {},
      }),
      cancel: async () => {},
    }
    r.dependencies.fetchImpl = async () => {
      if (stalled === "headers") {
        start()
        return pending
      }
      return { status: 201, headers: new Headers({ "content-type": "application/json" }), body }
    }
    globalThis.setTimeout = (fn, delay) => {
      const timer = { fn, delay }
      timers.push(timer)
      return timer
    }
    globalThis.clearTimeout = () => {}
    try {
      const w = writer(r)
      const result = w.uploadRecoveryAsset(archiveInput(r))
      await started
      timers
        .filter((t) => t.delay === 15000)
        .at(-1)
        .fn()
      await assert.rejects(result, /uncertain/)
      const reads = r.calls.length
      assert.throws(() => writer(r), /unsettled/)
      assert.equal(r.calls.length, reads)
      settle(
        stalled === "headers"
          ? { status: 201, headers: new Headers(), body: null }
          : { done: true },
      )
      await pending
      await Promise.resolve()
    } finally {
      globalThis.setTimeout = originalSet
      globalThis.clearTimeout = originalClear
    }
  })

test("direct provenance upload rejects invented artifact identity with a real admitted producer", async () => {
  const { evidenceRemote } = await import("./support/recovery-evidence-fixture.mjs")
  const { collectRecoveryEvidence } = await import("../recovery/evidence.mjs")
  const { recoveryProvenanceName } = await import("../recovery/evidence-proof.mjs")
  const r = await evidenceRemote()
  const accepted = await collectRecoveryEvidence(r.request, r.config, r.dependencies)
  const original = accepted.facts.escrow[0]
  r.activate(
    r
      .assets()
      .filter(
        (ref) =>
          ref.assetName !== accepted.facts.verification.ref.assetName &&
          ref.assetName !== original.ref.assetName,
      ),
  )
  r.release.body = renderRecoveryReleaseBody({ marker: r.marker, body: "Notes" })
  const forged = structuredClone(original.receipt)
  forged.provenance.artifactId = "999"
  const effects = r.effects.length
  await assert.rejects(
    writer(r).uploadRecoveryAsset({
      ...r.request,
      expectedBodySha256: digest(r.release.body),
      name: recoveryProvenanceName(forged),
      contentBase64: canonicalRecoveryBytes(forged).toString("base64"),
    }),
    /independent API proof/,
  )
  assert.equal(r.effects.length, effects)
})

test("direct selection upload cannot invent independent provenance or omit retained installations", async () => {
  const { evidenceRemote } = await import("./support/recovery-evidence-fixture.mjs")
  const { collectRecoveryEvidence } = await import("../recovery/evidence.mjs")
  const { recoveryVerificationName } = await import("../recovery/evidence-proof.mjs")
  const r = await evidenceRemote()
  const accepted = await collectRecoveryEvidence(r.request, r.config, r.dependencies)
  r.activate(
    r.assets().filter((ref) => ref.assetName !== accepted.facts.verification.ref.assetName),
  )
  r.release.body = renderRecoveryReleaseBody({ marker: r.marker, body: "Notes" })
  const selection = structuredClone(accepted.facts.verification.set)
  selection.retainedReceipts = selection.retainedReceipts.filter(
    (ref) => !ref.assetName.startsWith("recovery-v2-installation-"),
  )
  const effects = r.effects.length
  await assert.rejects(
    writer(r).uploadRecoveryAsset({
      ...r.request,
      expectedBodySha256: digest(r.release.body),
      name: recoveryVerificationName(selection.executor),
      contentBase64: canonicalRecoveryBytes(selection).toString("base64"),
    }),
    /independently persisted escrow/,
  )
  assert.equal(r.effects.length, effects)
})
