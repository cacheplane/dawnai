import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  canonicalAbandonmentArtifactContextBytes,
  createAbandonmentArtifactContext,
  parseAbandonmentArtifactContext,
} from "../abandonment-handoff.mjs"
import { canonicalReleaseBody } from "../metadata.mjs"
import { classifyProductionEvent } from "../observe.mjs"
import { planRelease } from "../planner.mjs"
import {
  COMMIT_SHA,
  candidate,
  observationForMarker,
  VERSION,
} from "./support/marker-observation.mjs"

const ROOT = "/absolute/release-candidate"
const ENVIRONMENT = Object.freeze({
  GITHUB_REPOSITORY: "cacheplane/dawnai",
  GITHUB_REF: `refs/tags/v${VERSION}`,
  GITHUB_SHA: COMMIT_SHA,
  GITHUB_RUN_ID: "7001",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/release.yml@refs/tags/v${VERSION}`,
})

for (const predecessor of ["CANDIDATE_TAGGED", "ARTIFACTS_PREPARED", "CANDIDATE_ESCROWED"]) {
  test(`derives canonical ${predecessor} abandonment context only through production boundaries`, async () => {
    const observation = legalObservation(predecessor)
    const harness = productionHarness(observation, predecessor)
    const inputCandidate = candidate()
    const environment = { ...ENVIRONMENT }
    const pending = createAbandonmentArtifactContext(
      { candidate: inputCandidate, environment },
      harness.dependencies,
    )

    inputCandidate.version = "9.9.9"
    environment.GITHUB_SHA = "f".repeat(40)
    const context = await pending

    assert.deepEqual(harness.calls.events, [
      { inputs: { version: VERSION, commitSha: COMMIT_SHA } },
    ])
    assert.deepEqual(harness.calls.inventoryRefs, [COMMIT_SHA])
    assert.deepEqual(
      harness.calls.plannerInputs.map((entry) => entry.observation.abandonment.requested),
      [false, true],
    )
    assert.deepEqual(harness.calls.plannerInputs[0].candidate, candidate())
    assert.equal(harness.calls.plannerInputs[0].mode, "controller")
    assert.deepEqual(observation.abandonment, {
      requested: false,
      recorded: false,
      predecessor: null,
    })
    assert.equal(context.predecessor, predecessor)
    assert.deepEqual(context.tag, {
      status: "present",
      annotated: true,
      tag: `v${VERSION}`,
      commitSha: COMMIT_SHA,
    })
    assert.equal(context.newerReleaseInterleaved, false)

    if (predecessor === "CANDIDATE_TAGGED") {
      assert.deepEqual(context.artifact, emptyArtifact())
      assert.deepEqual(context.release, absentRelease())
    } else if (predecessor === "ARTIFACTS_PREPARED") {
      assert.deepEqual(context.artifact, {
        manifestSha256: observation.artifacts.manifestSha256,
        releaseRecordSha256: observation.artifacts.releaseRecordAsset.sha256,
        baseAssetSetSha256: null,
        attestationSet: null,
      })
      assert.deepEqual(context.release, absentRelease())
    } else {
      const raw = rawReleaseFixture(observation)
      assert.deepEqual(context.artifact, {
        manifestSha256: observation.release.marker.manifestSha256,
        releaseRecordSha256: observation.release.marker.releaseRecordSha256,
        baseAssetSetSha256: observation.release.marker.baseAssetSetSha256,
        attestationSet: observation.release.marker.attestationSet,
      })
      assert.deepEqual(context.release, {
        status: "draft",
        releaseId: raw.release.id,
        bodySha256: observation.release.bodySha256,
        marker: observation.release.marker,
        assets: raw.assets.map((asset) => ({
          id: asset.id,
          name: asset.name,
          sha256: asset.digest.slice("sha256:".length),
        })),
      })
    }

    assertRecursivelyFrozen(context)
    const bytes = canonicalAbandonmentArtifactContextBytes(context, { candidate: candidate() })
    assert.equal(bytes.at(-1), 10)
    assert.deepEqual(parseAbandonmentArtifactContext(bytes, { candidate: candidate() }), context)
  })
}

test("fails closed with resume-escrow-first for ATTACHING and artifact-attested observations", async () => {
  const attaching = observationForMarker({ phase: "ATTACHING", partialBase: true })
  const attested = legalObservation("CANDIDATE_ESCROWED")
  attested.release = absentObservedRelease()
  attested.escrow = { status: "absent", manifestSha256: null, assets: [] }

  for (const [name, observation] of [
    ["ATTACHING", attaching],
    ["ARTIFACTS_ATTESTED", attested],
  ]) {
    const plan = planRelease({ candidate: candidate(), observation, mode: "controller" })
    assert.equal(plan.state, "ARTIFACTS_ATTESTED", name)
    const harness = productionHarness(observation, plan.state)
    await assert.rejects(
      createAbandonmentArtifactContext(
        { candidate: candidate(), environment: ENVIRONMENT },
        harness.dependencies,
      ),
      (error) =>
        error?.code === "ABANDONMENT_RESUME_ESCROW_FIRST" &&
        /resume.*escrow.*first/iu.test(error.message),
      name,
    )
    assert.deepEqual(harness.calls.github, [], `${name} must fail before fresh Release reads`)
  }
})

test("denies npm-started, published, terminal, and conflicting production states", async () => {
  const cases = [
    ["npm started", observationForMarker({ phase: "NPM_COMPLETE" })],
    ["published", observationForMarker({ phase: "AUDIT_VERIFIED", releaseStatus: "published" })],
    ["terminal abandonment", terminalAbandonmentObservation()],
    ["conflicting escrow", observationForMarker({ phase: "ESCROWED", partialBase: true })],
  ]

  for (const [name, observation] of cases) {
    const plan = planRelease({ candidate: candidate(), observation, mode: "controller" })
    const harness = productionHarness(observation, plan.state, {
      selectionDisposition: plan.disposition === "blocked" ? "blocked" : "selected",
      selectionConflicts: plan.conflicts,
    })
    await assert.rejects(
      createAbandonmentArtifactContext(
        { candidate: candidate(), environment: ENVIRONMENT },
        harness.dependencies,
      ),
      /abandonment|state|conflict|terminal|publish|npm/iu,
      name,
    )
    assert.deepEqual(harness.calls.github, [], `${name} must not create a context`)
  }
})

test("rejects diagnostics, lightweight tags, and mismatched selected identities", async () => {
  const tagged = legalObservation("CANDIDATE_TAGGED")
  const cases = [
    {
      name: "diagnostics",
      options: {
        diagnostics: [
          {
            source: "github",
            operation: "git-tag",
            status: "AMBIGUOUS",
            httpStatus: null,
            code: "ANNOTATED_TAG_REQUIRED",
            classification: "conflict",
          },
        ],
      },
    },
    {
      name: "lightweight tag",
      mutate(observation) {
        observation.tag = { status: "ambiguous", commitSha: null }
      },
    },
    {
      name: "selected SHA mismatch",
      options: { selectedCandidate: { ...candidate(), commitSha: "f".repeat(40) } },
    },
    {
      name: "selected version mismatch",
      options: { selectedCandidate: { ...candidate(), version: "0.8.23" } },
    },
    {
      name: "selected tag mismatch",
      options: { selectedTag: "v0.8.23" },
    },
  ]

  for (const current of cases) {
    const observation = structuredClone(tagged)
    current.mutate?.(observation)
    const plan = planRelease({ candidate: candidate(), observation, mode: "controller" })
    const harness = productionHarness(observation, plan.state, current.options)
    await assert.rejects(
      createAbandonmentArtifactContext(
        { candidate: candidate(), environment: ENVIRONMENT },
        harness.dependencies,
      ),
      /diagnostic|tag|candidate|selected|exact|conflict/iu,
      current.name,
    )
  }
})

test("requires the exact tag-bound cacheplane/dawnai workflow environment", async () => {
  const cases = [
    ["repository", { GITHUB_REPOSITORY: "fork/dawnai" }],
    ["ref", { GITHUB_REF: "refs/heads/main" }],
    ["SHA", { GITHUB_SHA: "f".repeat(40) }],
    ["run", { GITHUB_RUN_ID: "0" }],
    ["attempt", { GITHUB_RUN_ATTEMPT: "01" }],
    [
      "workflow ref",
      {
        GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/other.yml@refs/tags/v${VERSION}`,
      },
    ],
  ]
  for (const [name, override] of cases) {
    const harness = productionHarness(legalObservation("CANDIDATE_TAGGED"), "CANDIDATE_TAGGED")
    await assert.rejects(
      createAbandonmentArtifactContext(
        { candidate: candidate(), environment: { ...ENVIRONMENT, ...override } },
        harness.dependencies,
      ),
      /environment|repository|ref|candidate|run|workflow/iu,
      name,
    )
    assert.deepEqual(harness.calls.events, [], `${name} must fail before production reads`)
  }
})

test("rejects caller-authored context fields, accessors, symbols, and unsafe dependencies", async () => {
  const harness = productionHarness(legalObservation("CANDIDATE_TAGGED"), "CANDIDATE_TAGGED")
  await assert.rejects(
    createAbandonmentArtifactContext(
      {
        candidate: candidate(),
        environment: ENVIRONMENT,
        artifactContext: { forged: true },
      },
      harness.dependencies,
    ),
    /unknown|unsafe|field|option/iu,
  )

  let reads = 0
  const accessor = { candidate: candidate(), environment: { ...ENVIRONMENT } }
  Object.defineProperty(accessor, "artifactContext", {
    enumerable: true,
    get() {
      reads += 1
      return { forged: true }
    },
  })
  await assert.rejects(
    createAbandonmentArtifactContext(accessor, harness.dependencies),
    /unknown|unsafe|field|option/iu,
  )
  assert.equal(reads, 0)

  const candidateAccessor = candidate()
  Object.defineProperty(candidateAccessor, "commitSha", {
    enumerable: true,
    get() {
      reads += 1
      return COMMIT_SHA
    },
  })
  await assert.rejects(
    createAbandonmentArtifactContext(
      { candidate: candidateAccessor, environment: ENVIRONMENT },
      harness.dependencies,
    ),
    /candidate|JSON|accessor|field/iu,
  )
  assert.equal(reads, 0)

  const symbol = { candidate: candidate(), environment: ENVIRONMENT }
  symbol[Symbol("artifactContext")] = true
  await assert.rejects(
    createAbandonmentArtifactContext(symbol, harness.dependencies),
    /unknown|unsafe|symbol|field/iu,
  )

  const dependencies = { ...harness.dependencies }
  Object.defineProperty(dependencies, "artifactContext", {
    enumerable: true,
    get() {
      reads += 1
      return { forged: true }
    },
  })
  await assert.rejects(
    createAbandonmentArtifactContext(
      { candidate: candidate(), environment: ENVIRONMENT },
      dependencies,
    ),
    /dependency|unknown|unsafe|field/iu,
  )
  assert.equal(reads, 0)
})

test("rejects a changed Release body, identity, or base asset namespace", async () => {
  const cases = [
    ["body", (raw) => (raw.release.body = `${raw.release.body} `)],
    ["release identity", (raw) => (raw.release.id += 1)],
    ["asset name", (raw) => (raw.assets[0].name = "unexpected.json")],
    ["asset digest", (raw) => (raw.assets[0].digest = `sha256:${"f".repeat(64)}`)],
    ["missing asset", (raw) => raw.assets.pop()],
    [
      "newer release",
      (raw) =>
        raw.releases.push({
          ...raw.release,
          id: raw.release.id + 10,
          tag_name: "v0.8.23",
          name: "Dawn v0.8.23",
        }),
    ],
  ]
  for (const [name, mutate] of cases) {
    const observation = legalObservation("CANDIDATE_ESCROWED")
    const raw = rawReleaseFixture(observation)
    mutate(raw)
    const harness = productionHarness(observation, "CANDIDATE_ESCROWED", { raw })
    await assert.rejects(
      createAbandonmentArtifactContext(
        { candidate: candidate(), environment: ENVIRONMENT },
        harness.dependencies,
      ),
      /Release|asset|body|identity|namespace|newer|changed|exact/iu,
      name,
    )
  }
})

test("rechecks the exact annotated tag after observation before emitting context", async () => {
  const cases = [
    ["lightweight", (raw) => (raw.tagRef.object.type = "commit")],
    ["tag object", (raw) => (raw.tagRef.object.sha = "not-a-tag-object")],
    ["tag name", (raw) => (raw.gitTag.tag = "v0.8.23")],
    ["tag commit", (raw) => (raw.gitTag.object.sha = "f".repeat(40))],
  ]
  for (const [name, mutate] of cases) {
    const observation = legalObservation("CANDIDATE_TAGGED")
    const raw = rawReleaseFixture(observation)
    mutate(raw)
    const harness = productionHarness(observation, "CANDIDATE_TAGGED", { raw })
    await assert.rejects(
      createAbandonmentArtifactContext(
        { candidate: candidate(), environment: ENVIRONMENT },
        harness.dependencies,
      ),
      /annotated|tag|exact|identity/iu,
      name,
    )
  }
})

test("requires the initial production plan to be the exact normal predecessor transition", async () => {
  const observation = legalObservation("CANDIDATE_TAGGED")
  const harness = productionHarness(observation, "CANDIDATE_TAGGED")
  let plans = 0
  harness.dependencies.planRelease = (input) => {
    plans += 1
    const plan = planRelease(input)
    return plans === 1 ? { ...plan, disposition: "noop", nextTransition: null } : plan
  }
  await assert.rejects(
    createAbandonmentArtifactContext(
      { candidate: candidate(), environment: ENVIRONMENT },
      harness.dependencies,
    ),
    /production|plan|transition|exact/iu,
  )
})

test("parses only canonical artifact-context bytes", async () => {
  const harness = productionHarness(legalObservation("CANDIDATE_TAGGED"), "CANDIDATE_TAGGED")
  const context = await createAbandonmentArtifactContext(
    { candidate: candidate(), environment: ENVIRONMENT },
    harness.dependencies,
  )
  const compact = Buffer.from(JSON.stringify(context), "utf8")
  assert.throws(
    () => parseAbandonmentArtifactContext(compact, { candidate: candidate() }),
    /canonical/iu,
  )
})

function productionHarness(
  observation,
  state,
  {
    diagnostics = [],
    selectedCandidate = candidate(),
    selectedTag = `v${VERSION}`,
    selectionDisposition = "selected",
    selectionConflicts = [],
    raw = rawReleaseFixture(observation),
  } = {},
) {
  const calls = { events: [], inventoryRefs: [], plannerInputs: [], github: [] }
  const inventory = {
    async read({ ref }) {
      calls.inventoryRefs.push(ref)
      return { status: "valid", packages: observation.inventory.packages }
    },
  }
  const github = githubReader(raw, calls)
  return {
    calls,
    dependencies: {
      root: ROOT,
      git: Object.freeze({ kind: "git" }),
      github,
      npm: Object.freeze({ kind: "npm" }),
      npmAuditFactory: Object.freeze({ kind: "npm-audit" }),
      attestations: Object.freeze({ kind: "attestations" }),
      marker: Object.freeze({ schemaVersion: 1 }),
      inventory,
      classifyProductionEvent(event) {
        calls.events.push(structuredClone(event))
        return classifyProductionEvent(event)
      },
      async resolveProductionCandidate(input) {
        assert.deepEqual(input.event, {
          inputs: { version: VERSION, commitSha: COMMIT_SHA },
        })
        assert.equal(input.inventory, inventory)
        assert.equal(input.github, github)
        return {
          candidate: selectedCandidate,
          state,
          disposition: selectionDisposition,
          tag: selectedTag,
          conflicts: selectionConflicts,
        }
      },
      async observeProductionCandidate(input) {
        assert.deepEqual(input.candidate, candidate())
        assert.equal(input.inventory.status, "valid")
        return { observation, diagnostics }
      },
      createProductionInventoryReader() {
        assert.fail("injected inventory must remain the immutable production reader")
      },
      planRelease(input) {
        calls.plannerInputs.push(structuredClone(input))
        return planRelease(input)
      },
    },
  }
}

function githubReader(raw, calls) {
  return Object.freeze({
    async getRef({ ref }) {
      calls.github.push("getRef")
      assert.equal(ref, `tags/v${VERSION}`)
      return present("ref", raw.tagRef)
    },
    async getGitTag({ tagSha }) {
      calls.github.push("getGitTag")
      assert.equal(tagSha, raw.tagRef.object.sha)
      return present("git-tag", raw.gitTag)
    },
    async listReleases() {
      calls.github.push("listReleases")
      return present("releases", raw.releases)
    },
    async getReleaseByTag({ tag }) {
      calls.github.push("getReleaseByTag")
      assert.equal(tag, `v${VERSION}`)
      return present("release", raw.release)
    },
    async listReleaseAssets({ releaseId }) {
      calls.github.push("listReleaseAssets")
      assert.equal(releaseId, raw.release.id)
      return present("release-assets", raw.assets)
    },
  })
}

function rawReleaseFixture(observation) {
  const tagObjectSha = "e".repeat(40)
  const tagRef = {
    ref: `refs/tags/v${VERSION}`,
    object: { type: "tag", sha: tagObjectSha },
  }
  const gitTag = {
    tag: `v${VERSION}`,
    object: { type: "commit", sha: COMMIT_SHA },
  }
  if (observation.release.status === "absent") {
    return { releases: [], release: null, assets: [], tagRef, gitTag }
  }
  const release = {
    id: 901,
    name: `Dawn v${VERSION}`,
    tag_name: `v${VERSION}`,
    target_commitish: "main",
    draft: true,
    immutable: false,
    prerelease: false,
    body: releaseBody(observation),
  }
  const assets = observation.release.assets.map((asset, index) => ({
    id: 1_000 + index,
    name: asset.name,
    digest: `sha256:${asset.sha256}`,
    size: 128 + index,
  }))
  return { releases: [structuredClone(release)], release, assets, tagRef, gitTag }
}

function releaseBody(observation) {
  const body = canonicalReleaseBody({ marker: observation.release.marker, manifest: null })
  assert.equal(createHash("sha256").update(body).digest("hex"), observation.release.bodySha256)
  return body
}

function legalObservation(predecessor) {
  const observation = observationForMarker({ phase: "ESCROWED" })
  if (predecessor === "CANDIDATE_ESCROWED") return observation

  observation.release = absentObservedRelease()
  observation.escrow = { status: "absent", manifestSha256: null, assets: [] }
  observation.artifacts.manifestAttestationAsset.sha256 = null
  observation.artifacts.attestations = observation.artifacts.attestations.map((attestation) => ({
    ...attestation,
    status: "pending",
    sha256: null,
  }))
  observation.inventory.packages = observation.inventory.packages.map((pkg) => ({
    ...pkg,
    attestationSha256: null,
  }))
  observation.artifacts.status = "prepared"
  if (predecessor === "ARTIFACTS_PREPARED") {
    assert.equal(
      planRelease({ candidate: candidate(), observation, mode: "controller" }).state,
      predecessor,
    )
    return observation
  }

  observation.inventory.packages = observation.inventory.packages.map((pkg) => ({
    ...pkg,
    tarballSha256: null,
    integrity: null,
  }))
  observation.artifacts = {
    ...observation.artifacts,
    status: "absent",
    manifestVersion: null,
    manifestCommitSha: null,
    manifestSha256: null,
    files: observation.artifacts.files.map((file) => ({
      ...file,
      status: "pending",
      sha256: null,
      integrity: null,
    })),
    manifestAsset: { name: "manifest.json", sha256: null },
    releaseRecordAsset: { name: "release-record.json", sha256: null },
    manifestAttestationAsset: { name: "manifest.json.intoto.jsonl", sha256: null },
    attestations: observation.artifacts.attestations.map((attestation) => ({
      ...attestation,
      subjectSha256: null,
    })),
  }
  observation.smokes = observation.smokes.map((smoke) => ({ ...smoke, manifestSha256: null }))
  assert.equal(
    planRelease({ candidate: candidate(), observation, mode: "controller" }).state,
    predecessor,
  )
  return observation
}

function terminalAbandonmentObservation() {
  const observation = legalObservation("CANDIDATE_TAGGED")
  observation.abandonment = {
    requested: true,
    recorded: true,
    predecessor: "CANDIDATE_TAGGED",
  }
  return observation
}

function emptyArtifact() {
  return {
    manifestSha256: null,
    releaseRecordSha256: null,
    baseAssetSetSha256: null,
    attestationSet: null,
  }
}

function absentRelease() {
  return {
    status: "absent",
    releaseId: null,
    bodySha256: null,
    marker: null,
    assets: [],
  }
}

function absentObservedRelease() {
  return {
    status: "absent",
    tag: null,
    commitSha: null,
    immutable: null,
    bodySha256: null,
    marker: null,
    assets: [],
  }
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") return
  assert.ok(Object.isFrozen(value))
  for (const child of Object.values(value)) assertRecursivelyFrozen(child)
}
