import assert from "node:assert/strict"
import test from "node:test"
import { resolveProductionCandidate } from "../observe.mjs"
import { planCandidateArbitration } from "../planner.mjs"
import { renderRecoveryReleaseBody } from "../recovery/metadata.mjs"
import { recoveryRemote } from "./support/recovery-observe-fixture.mjs"

const routing = await import("../recovery/observe.mjs")
const legacy = (r) => ({
  version: r.c.version,
  commitSha: r.c.candidateSha,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})
const route = async (r) => {
  assert.equal(typeof routing.routeRecoveryCandidate, "function")
  return routing.routeRecoveryCandidate({
    ...r.args,
    candidate: legacy(r),
    terminalRecordRef: r.e.controllerSha,
  })
}

test("exact reviewed reservation routes legacy draft to recovery-required even without active owner", async () => {
  const r = await recoveryRemote()
  const result = await route(r)
  assert.equal(result.state, "RECOVERY_REQUIRED")
  assert.equal(result.disposition, "recovery-owned")
})
test("durable v2 ownership survives removal of the current git intent", async () => {
  const r = await recoveryRemote()
  r.release.body = renderRecoveryReleaseBody({ marker: r.marker, body: "notes" })
  r.args.git.listTree = async () => ""
  r.setAssets([...r.baseAssets, r.adoption.archive, r.adoptionRef])
  const result = await route(r)
  assert.equal(result.state, "RECOVERY_REQUIRED")
  assert.equal(result.disposition, "recovery-owned")
})
for (const body of ["", "corrupt <!-- DAWN_RELEASE_CONTROLLER_MARKER\n{"])
  test(`published recovery uses immutable tag and fixed final asset with body ${JSON.stringify(body)}`, async () => {
    const r = await recoveryRemote({ published: true })
    r.release.body = body
    r.release.name = "edited"
    r.args.git.listTree = async () => ""
    const result = await route(r)
    assert.equal(result.state, "RECOVERY_COMPLETE")
    assert.equal(result.disposition, "recovery-terminal")
  })
for (const [name, mutate] of [
  [
    "unknown marker schema",
    (r) => {
      r.release.body = renderRecoveryReleaseBody({ marker: r.marker, body: "notes" }).replace(
        '"schemaVersion":2',
        '"schemaVersion":3',
      )
    },
  ],
  [
    "malformed intent",
    (r) => {
      const original = r.args.git.showFile
      r.args.git.showFile = async (args) => (args.path === r.intentPath ? "{" : original(args))
    },
  ],
  [
    "duplicate drafts",
    (r) => {
      r.args.github.listReleases = async () => ({
        status: "PRESENT",
        value: [r.release, { ...r.release, id: 903 }],
      })
    },
  ],
  [
    "absent npm",
    (r) => {
      r.args.npm.observePackageVersion = async () => ({ status: "ABSENT", httpStatus: 404 })
    },
  ],
])
  test(`${name} can never fall back to legacy continuation`, async () => {
    const r = await recoveryRemote()
    mutate(r)
    let result
    try {
      result = await route(r)
    } catch {
      return
    }
    assert.notEqual(result, null)
    assert.equal(result.disposition, "blocked")
    assert.equal(result.state, "RECOVERY_REQUIRED")
  })
test("incomplete recovery blocks a newer candidate, independently verified terminal recovery permits it", async () => {
  const r = await recoveryRemote()
  const reserved = await route(r)
  const newer = {
    candidate: { ...legacy(r), version: "0.8.25", commitSha: "e".repeat(40) },
    state: "CANDIDATE_VALIDATED",
    disposition: "selected",
    tag: null,
    conflicts: [],
  }
  assert.equal(
    planCandidateArbitration({ candidate: newer, managedReleases: [reserved] }).disposition,
    "blocked",
  )
  const done = await recoveryRemote({ published: true })
  const terminal = await route(done)
  assert.equal(
    planCandidateArbitration({ candidate: newer, managedReleases: [terminal] }).disposition,
    "selected",
  )
})
for (const eventName of ["schedule", "push", "dispatch"])
  test(`${eventName} shares the recovery ownership router before legacy observation`, async () => {
    const r = await recoveryRemote()
    const c = legacy(r)
    const selected = {
      candidate: c,
      state: "CANDIDATE_VALIDATED",
      disposition: "selected",
      tag: r.c.tag,
      conflicts: [],
    }
    const event =
      eventName === "schedule"
        ? { schedule: "cron" }
        : eventName === "push"
          ? { ref: "refs/heads/main", after: c.commitSha }
          : { inputs: { version: c.version, commitSha: c.commitSha } }
    const result = await resolveProductionCandidate({
      ...r.args,
      terminalRecordRef: r.e.controllerSha,
      event,
      inventory: { read: async () => ({}) },
      marker: {},
      discovery: {
        discoverManagedCandidate: async () => selected,
        discoverScheduledCandidate: async () => selected,
      },
    })
    assert.equal(result.state, "RECOVERY_REQUIRED")
    assert.equal(result.disposition, "recovery-owned")
  })
test("exact invocation cannot reselect a recovery-complete candidate after scheduled discovery returns no candidate", async () => {
  const r = await recoveryRemote({ published: true })
  const c = legacy(r)
  const result = await resolveProductionCandidate({
    ...r.args,
    terminalRecordRef: r.e.controllerSha,
    event: { inputs: { version: c.version, commitSha: c.commitSha } },
    inventory: { read: async () => ({}) },
    marker: {},
    discovery: {
      discoverManagedCandidate: async () => ({
        candidate: c,
        state: "CANDIDATE_VALIDATED",
        disposition: "selected",
        tag: r.c.tag,
        conflicts: [],
      }),
      discoverScheduledCandidate: async () => ({
        candidate: null,
        state: "NO_CANDIDATE",
        disposition: "noop",
        tag: null,
        conflicts: [],
      }),
    },
  })
  assert.equal(result.disposition, "recovery-terminal")
})

import { coordinateIndependentAudit } from "../independent-audit-coordinator.mjs"

for (const mode of ["schedule", "manual-main", "manual-tag"])
  test(`legacy audit coordinator reports unsupported recovery before ${mode} can dispatch frozen code`, async () => {
    const r = await recoveryRemote({ published: true })
    r.release.body = ""
    r.release.name = "edited"
    const calls = []
    for (const [method, operation] of [
      ["listReleases", "releases"],
      ["getReleaseByTag", "release"],
    ]) {
      const original = r.args.github[method]
      r.args.github[method] = async (args) => ({
        ...(await original(args)),
        operation,
        httpStatus: 200,
        code: null,
      })
    }
    await assert.rejects(
      coordinateIndependentAudit({
        eventName: mode === "schedule" ? "schedule" : "workflow_dispatch",
        ref: mode === "manual-tag" ? `refs/tags/${r.c.tag}` : "refs/heads/main",
        sha: mode === "manual-tag" ? r.c.candidateSha : r.e.controllerSha,
        defaultBranch: "main",
        inputs:
          mode === "schedule"
            ? { version: "", commitSha: "", manifestSha256: "" }
            : {
                version: r.c.version,
                commitSha: r.c.candidateSha,
                manifestSha256: r.c.manifestSha256,
              },
        github: {
          reader: r.args.github,
          writer: { dispatchWorkflowAtRef: async (request) => calls.push(request) },
        },
      }),
      /RECOVERY_UNSUPPORTED_MODE/,
    )
    assert.deepEqual(calls, [])
  })
test("adopted opaque draft with edited title and removed intent never returns legacy ownership", async () => {
  const r = await recoveryRemote()
  r.release.body = renderRecoveryReleaseBody({ marker: r.marker, body: "notes" })
  r.release.name = "Edited title"
  r.args.git.listTree = async () => ""
  r.setAssets([...r.baseAssets, r.adoption.archive, r.adoptionRef])
  const result = await route(r)
  assert.notEqual(result, null)
  assert.equal(result.state, "RECOVERY_REQUIRED")
})
test("unsupported published marker without finalization cannot return legacy ownership", async () => {
  const r = await recoveryRemote({ published: true })
  r.args.git.listTree = async () => ""
  r.release.body = renderRecoveryReleaseBody({ marker: r.marker, body: "notes" }).replace(
    '"schemaVersion":2',
    '"schemaVersion":3',
  )
  r.setAssets(r.baseAssets)
  await assert.rejects(route(r), /unsupported|Unsupported|legacy|Legacy/)
})

import { discoverScheduledCandidate } from "../candidate.mjs"

test("reservation without a tag or visible Release still blocks global candidate discovery", async () => {
  const r = await recoveryRemote()
  r.args.github.listTagRefs = async () => ({ status: "PRESENT", value: [] })
  r.args.github.listReleases = async () => ({ status: "PRESENT", value: [] })
  const result = await discoverScheduledCandidate({
    ...r.args,
    terminalRecordRef: r.e.controllerSha,
    marker: {
      schemaVersion: 1,
      publishingOwner: "release-controller",
      epoch: "fixed-group-v1",
      npmTrustedPublisherEnvironment: null,
      abandonmentEnvironment: "release-abandonment",
    },
    inventory: { read: async () => ({}) },
    git: {
      ...r.args.git,
      resolveTag: async () => null,
      listFirstParentHistory: async () => [],
      firstParent: async () => null,
    },
  })
  assert.equal(result.state, "RECOVERY_REQUIRED")
  assert.equal(result.disposition, "recovery-owned")
})

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runReleaseCli } from "../cli.mjs"

test("legacy CLI emits blocked recovery-required outputs with no continuation or v1 hydration evidence", async () => {
  const r = await recoveryRemote()
  const directory = await mkdtemp(join(tmpdir(), "dawn-recovery-cli-"))
  const active = {
    schemaVersion: 1,
    publishingOwner: "release-controller",
    epoch: "fixed-group-v1",
    npmTrustedPublisherEnvironment: null,
    abandonmentEnvironment: "release-abandonment",
  }
  const original = r.args.git.showFile
  const git = {
    ...r.args.git,
    async listTree() {
      return `${r.intentPath}\nscripts/release/controller-schema.json\n`
    },
    async showFile(args) {
      return args.path === "scripts/release/controller-schema.json"
        ? JSON.stringify(active)
        : original(args)
    },
    async firstParent() {
      return "d".repeat(40)
    },
    async listFirstParentHistory() {
      return [r.c.candidateSha]
    },
    async resolveTag() {
      return r.c.candidateSha
    },
  }
  const github = {
    ...r.args.github,
    async listTagRefs() {
      return {
        status: "PRESENT",
        value: [{ ref: `refs/tags/${r.c.tag}`, object: { type: "tag", sha: r.c.tagObjectSha } }],
      }
    },
  }
  try {
    const event = join(directory, "event.json"),
      report = join(directory, "report.json"),
      output = join(directory, "output")
    await writeFile(event, JSON.stringify({ schedule: "cron" }))
    await writeFile(output, "")
    const result = await runReleaseCli(
      ["observe", "--event", event, "--report", report, "--github-output", output],
      {
        cwd: directory,
        git,
        githubReader: github,
        npm: r.args.npm,
        npmAuditFactory: r.args.npmAuditFactory,
        attestations: r.args.attestations,
        controllerMarker: active,
        inventory: {
          read: async ({ ref }) => ({
            status: "valid",
            packages: r.base.manifest.packages.map((p) => ({
              name: p.name,
              version: ref === "d".repeat(40) ? "0.8.23" : r.c.version,
            })),
          }),
        },
      },
    )
    assert.equal(result.before.plan.state, "RECOVERY_REQUIRED")
    assert.equal(result.before.plan.disposition, "blocked")
    assert.equal(result.before.plan.nextTransition, null)
    assert.equal(result.recovery, null)
    assert.match(
      await readFile(output, "utf8"),
      /state=RECOVERY_REQUIRED\ndisposition=blocked\nnext_transition=\n/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
for (const body of ["", "corrupt <!-- DAWN_RELEASE_CONTROLLER_MARKER\n{"])
  test(`adopted opaque draft with edited title, removed intent and body ${JSON.stringify(body)} stays recovery-owned`, async () => {
    const r = await recoveryRemote()
    r.release.body = body
    r.release.name = "Edited title"
    r.args.git.listTree = async () => ""
    r.setAssets([...r.baseAssets, r.adoption.archive, r.adoptionRef])
    let result
    try {
      result = await route(r)
    } catch {
      return
    }
    assert.notEqual(result, null)
    assert.equal(result.state, "RECOVERY_REQUIRED")
  })

for (const bodyMode of ["valid", "absent", "corrupt", "unknown"]) {
  test(`production resolver blocks newer publication when tagless recovery has ${bodyMode} display metadata and no intent`, async () => {
    const r = await recoveryRemote()
    const newerSha = "e".repeat(40)
    const parentSha = "d".repeat(40)
    const active = {
      schemaVersion: 1,
      publishingOwner: "release-controller",
      epoch: "fixed-group-v1",
      npmTrustedPublisherEnvironment: null,
      abandonmentEnvironment: "release-abandonment",
    }
    r.release.name = "Edited recovery title"
    r.release.body =
      bodyMode === "valid"
        ? renderRecoveryReleaseBody({ marker: r.marker, body: "notes" })
        : bodyMode === "absent"
          ? ""
          : "corrupt <!-- DAWN_RELEASE_CONTROLLER_MARKER\n{"
    if (bodyMode === "unknown") {
      r.release.body = renderRecoveryReleaseBody({ marker: r.marker, body: "notes" }).replace(
        '"schemaVersion":2',
        '"schemaVersion":3',
      )
      r.setAssets(r.baseAssets)
    } else r.setAssets([...r.baseAssets, r.adoption.archive, r.adoptionRef])
    const showFile = r.args.git.showFile
    const git = {
      ...r.args.git,
      async listTree() {
        return "scripts/release/controller-schema.json\n"
      },
      async showFile(args) {
        return args.path === "scripts/release/controller-schema.json"
          ? JSON.stringify(active)
          : showFile(args)
      },
      async listFirstParentHistory() {
        return [newerSha]
      },
      async firstParent() {
        return parentSha
      },
      async resolveTag() {
        return null
      },
    }
    const getRef = r.args.github.getRef
    const github = {
      ...r.args.github,
      async listTagRefs() {
        return { status: "PRESENT", value: [] }
      },
      async getRef(args) {
        return args.ref.startsWith("tags/")
          ? { status: "ABSENT", httpStatus: 404, code: "NOT_FOUND" }
          : getRef(args)
      },
    }
    const pending = resolveProductionCandidate({
      ...r.args,
      event: { ref: "refs/heads/main", after: newerSha },
      marker: active,
      terminalRecordRef: r.e.controllerSha,
      git,
      github,
      inventory: {
        async read({ ref }) {
          return {
            status: "valid",
            packages: r.base.manifest.packages.map((pkg) => ({
              name: pkg.name,
              version: ref === newerSha ? "0.8.25" : "0.8.24",
            })),
          }
        },
      },
    })
    if (bodyMode === "corrupt" || bodyMode === "unknown") {
      await assert.rejects(pending, /Unsupported recovery\/legacy marker blocks routing/)
      return
    }
    const result = await pending
    assert.equal(result.candidate.version, "0.8.24")
    assert.equal(result.state, "RECOVERY_REQUIRED")
    assert.equal(result.disposition, "blocked")
  })
}

for (const [name, mutation] of [
  ["candidate SHA", (r) => ({ ...r.marker, candidate: { ...r.c, candidateSha: "e".repeat(40) } })],
  ["Release ID", (r) => ({ ...r.marker, candidate: { ...r.c, releaseId: "999" } })],
  [
    "version and tag",
    (r) => ({ ...r.marker, candidate: { ...r.c, version: "0.9.0", tag: "v0.9.0" } }),
  ],
  [
    "phase and references",
    (r) => ({ ...r.marker, adoption: { ...r.marker.adoption, id: "999", sha256: "f".repeat(64) } }),
  ],
  ["title collision", (r) => r.marker],
]) {
  test(`published finalization owns observation and routing despite edited valid marker ${name}`, async () => {
    const r = await recoveryRemote({ published: true })
    r.release.body = renderRecoveryReleaseBody({ marker: mutation(r), body: "Edited display" })
    if (name === "title collision") r.release.name = "Dawn v0.8.25"
    r.args.git.listTree = async () => ""
    const observed = await routing.observeRecoveryCandidate(r.args)
    assert.equal(observed.outcome, "complete", JSON.stringify(observed.errors))
    assert.equal(observed.displayDrift, true)
    const identities = await routing.discoverRecoveryReleaseCandidates({
      github: r.args.github,
      releaseRecords: [r.release],
    })
    assert.deepEqual(identities.get(r.c.releaseId), r.c)
    assert.equal((await route(r)).state, "RECOVERY_COMPLETE")
    const active = {
      schemaVersion: 1,
      publishingOwner: "release-controller",
      epoch: "fixed-group-v1",
      npmTrustedPublisherEnvironment: null,
      abandonmentEnvironment: "release-abandonment",
    }
    const newerSha = "f".repeat(40),
      parentSha = "d".repeat(40)
    const showFile = r.args.git.showFile
    const result = await resolveProductionCandidate({
      ...r.args,
      event: { ref: "refs/heads/main", after: newerSha },
      marker: active,
      terminalRecordRef: r.e.controllerSha,
      git: {
        ...r.args.git,
        listTree: async () => "scripts/release/controller-schema.json",
        showFile: async (args) =>
          args.path === "scripts/release/controller-schema.json"
            ? JSON.stringify(active)
            : showFile(args),
        listFirstParentHistory: async () => [newerSha],
        firstParent: async () => parentSha,
        resolveTag: async () => null,
      },
      github: { ...r.args.github, listTagRefs: async () => ({ status: "PRESENT", value: [] }) },
      inventory: {
        read: async ({ ref }) => ({
          status: "valid",
          packages: r.base.manifest.packages.map((pkg) => ({
            name: pkg.name,
            version: ref === newerSha ? "0.8.25" : "0.8.24",
          })),
        }),
      },
    })
    assert.equal(result.candidate.version, "0.8.25")
    assert.equal(result.state, "CANDIDATE_VALIDATED")
    assert.equal(result.disposition, "selected")
  })
}

test("production discovery retries a transient asset read and memoizes only the successful inventory", async () => {
  const r = await recoveryRemote()
  const active = {
    schemaVersion: 1,
    publishingOwner: "release-controller",
    epoch: "fixed-group-v1",
    npmTrustedPublisherEnvironment: null,
    abandonmentEnvironment: "release-abandonment",
  }
  let reads = 0
  const readAssets = r.args.github.listReleaseAssets
  const github = {
    ...r.args.github,
    listTagRefs: async () => ({ status: "PRESENT", value: [] }),
    listReleaseAssets: async (args) =>
      ++reads === 1
        ? {
            status: "AMBIGUOUS",
            operation: "release-assets",
            httpStatus: 503,
            code: "SERVER_ERROR",
          }
        : readAssets(args),
  }
  const { discoverScheduledCandidate } = await import("../candidate.mjs")
  const result = await discoverScheduledCandidate({
    ...r.args,
    github,
    git: {
      ...r.args.git,
      resolveTag: async () => null,
      firstParent: async () => null,
      listFirstParentHistory: async () => [],
    },
    terminalRecordRef: r.e.controllerSha,
    marker: active,
    inventory: {
      read: async () => ({
        status: "valid",
        packages: r.base.manifest.packages.map((pkg) => ({ name: pkg.name, version: pkg.version })),
      }),
    },
  })
  assert.equal(result.state, "RECOVERY_REQUIRED")
  assert.equal(result.disposition, "recovery-owned")
  assert.equal(reads, 2)
})

test("draft marker candidate edits remain blocked and cannot borrow published finalization behavior", async () => {
  const r = await recoveryRemote()
  r.release.body = renderRecoveryReleaseBody({
    marker: { ...r.marker, candidate: { ...r.c, candidateSha: "e".repeat(40) } },
    body: "Edited draft",
  })
  r.setAssets([...r.baseAssets, r.adoption.archive, r.adoptionRef])
  assert.equal((await routing.observeRecoveryCandidate(r.args)).outcome, "blocked")
  await assert.rejects(route(r), /candidate differ/)
})

test("published finalization still rejects a conflicting immutable reservation", async () => {
  const r = await recoveryRemote({ published: true })
  const showFile = r.args.git.showFile
  r.args.git.showFile = async (args) => {
    const raw = await showFile(args)
    if (args.path !== r.intentPath) return raw
    const intent = JSON.parse(raw)
    intent.candidate.releaseId = "999"
    const { canonicalRecoveryBytes } = await import("../recovery/schema.mjs")
    return canonicalRecoveryBytes(intent).toString()
  }
  await assert.rejects(route(r), /reservation and finalization candidate differ/)
})

test("built-in production discovery proves a recovery candidate once per invocation", async () => {
  const r = await recoveryRemote()
  const active = {
    schemaVersion: 1,
    publishingOwner: "release-controller",
    epoch: "fixed-group-v1",
    npmTrustedPublisherEnvironment: null,
    abandonmentEnvironment: "release-abandonment",
  }
  let creates = 0,
    verifications = 0
  const create = r.args.npmAuditFactory.create
  const result = await resolveProductionCandidate({
    ...r.args,
    event: { schedule: "cron" },
    github: { ...r.args.github, listTagRefs: async () => ({ status: "PRESENT", value: [] }) },
    git: {
      ...r.args.git,
      resolveTag: async () => null,
      firstParent: async () => null,
      listFirstParentHistory: async () => [],
    },
    terminalRecordRef: r.e.controllerSha,
    marker: active,
    npmAuditFactory: {
      async create(args) {
        creates++
        const verifier = await create(args)
        return {
          ...verifier,
          async verifyPackage(args) {
            verifications++
            return verifier.verifyPackage(args)
          },
        }
      },
    },
    inventory: {
      read: async () => ({
        status: "valid",
        packages: r.base.manifest.packages.map((pkg) => ({ name: pkg.name, version: pkg.version })),
      }),
    },
  })
  assert.equal(result.state, "RECOVERY_REQUIRED")
  assert.equal(result.disposition, "recovery-owned")
  assert.equal(creates, 1)
  assert.equal(verifications, r.base.manifest.packages.length)
})

test("an injected recovery-looking discovery result still receives independent observation", async () => {
  const r = await recoveryRemote()
  const result = await resolveProductionCandidate({
    ...r.args,
    event: { schedule: "cron" },
    terminalRecordRef: r.e.controllerSha,
    marker: {},
    inventory: { read: async () => ({}) },
    discovery: {
      discoverManagedCandidate: async () => {
        throw new Error("unexpected exact discovery")
      },
      discoverScheduledCandidate: async () => ({
        candidate: legacy(r),
        state: "RECOVERY_COMPLETE",
        disposition: "recovery-terminal",
        tag: r.c.tag,
        conflicts: [],
      }),
    },
  })
  assert.equal(result.state, "RECOVERY_REQUIRED")
  assert.equal(result.disposition, "recovery-owned")
  assert.equal(r.calls.filter((call) => call === "dispose").length, 1)
})

for (const body of ["", "corrupt <!-- DAWN_RELEASE_CONTROLLER_MARKER\n{"])
  test(`frozen draft remains recovery-owned after display loss ${JSON.stringify(body)}`, async () => {
    const r = await recoveryRemote()
    r.setAssets(r.allAssets)
    r.release.body = body
    r.release.name = "edited title"
    r.args.git.listTree = async () => ""
    const result = await route(r)
    assert.equal(result.state, "RECOVERY_REQUIRED")
    assert.equal(result.disposition, "recovery-owned")
    const observed = await routing.observeRecoveryCandidate(r.args)
    assert.equal(observed.facts.marker, null)
    assert.equal(observed.facts.release.body, body)
    assert.deepEqual(observed.facts.finalization.ref, r.finalRef)
  })
