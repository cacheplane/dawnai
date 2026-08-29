import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import {
  canonicalOwnerEvidenceBytes,
  captureOwnerEvidence,
  OWNER_PREFLIGHT_FILES,
  parseOwnerEvidence,
  verifyOwnerEvidence,
} from "../preflight-owner.mjs"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const FIXTURE_ROOT = `${ROOT}/scripts/release/test/fixtures`
const REPOSITORY = "cacheplane/dawnai"
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
const OTHER_HEAD_SHA = "1123456789abcdef0123456789abcdef01234567"
const TAG_OBJECT_SHA_1 = "2123456789abcdef0123456789abcdef01234567"
const TAG_OBJECT_SHA_2 = "3123456789abcdef0123456789abcdef01234567"
const PEELED_SHA_1 = "4123456789abcdef0123456789abcdef01234567"
const PEELED_SHA_2 = "5123456789abcdef0123456789abcdef01234567"
const BLOB_SHA = "6123456789abcdef0123456789abcdef01234567"
const NOW = Date.parse("2026-08-25T12:00:00Z")
const RELEASE_WORKFLOW = ".github/workflows/release.yml"
const CONTROLLER_SCHEMA = "scripts/release/controller-schema.json"
const POLICY_PATH = "scripts/release/abandonment-workflow-policy.json"
const EXPECTED_OWNER_FILES = [
  ".github/workflows/version-pr.yml",
  RELEASE_WORKFLOW,
  ".github/workflows/published-artifact-verify.yml",
  ".github/workflows/publish-chart.yml",
  CONTROLLER_SCHEMA,
  POLICY_PATH,
]
const WORKFLOW_PATHS = EXPECTED_OWNER_FILES.filter((path) => path.endsWith(".yml"))
const DISABLED_BYTES = await readFile(`${FIXTURE_ROOT}/release-workflow-disabled.yml`)
const PROTECTED_BYTES = await readFile(`${FIXTURE_ROOT}/release-workflow-protected.yml`)
const POLICY_BYTES = await readFile(`${ROOT}/${POLICY_PATH}`)

test("disabled capture binds v2 evidence in authority-safe order without reading the environment", async () => {
  const fixture = captureFixture({ phase: "pre-enable", localMode: "disabled" })
  const evidence = await captureOwnerEvidence(fixture.input)

  assert.deepEqual(OWNER_PREFLIGHT_FILES, EXPECTED_OWNER_FILES)
  assert.deepEqual(
    fixture.calls.slice(0, EXPECTED_OWNER_FILES.length),
    EXPECTED_OWNER_FILES.map((path) => ["file", "read", path]),
  )
  assert.deepEqual(
    fixture.calls.filter(([kind]) => kind === "github").map((call) => call.slice(1)),
    [
      ["repository", REPOSITORY],
      ...WORKFLOW_PATHS.map((path) => ["workflow", path]),
      ["default-branch-ref", REPOSITORY, "main"],
      ["workflow-content", REPOSITORY, RELEASE_WORKFLOW, HEAD_SHA],
      ["managed-candidate-refs", REPOSITORY],
      ["release-runs", REPOSITORY, RELEASE_WORKFLOW],
      ["immutable-releases", REPOSITORY],
    ],
  )
  assert.deepEqual(
    fixture.calls.filter(([kind]) => kind === "npm"),
    CANONICAL_RELEASE_PACKAGE_ORDER.flatMap((name) => [["npm", "trust-list", name]]),
  )
  assert.equal(fixture.environmentBindings.count, 0)
  assert.equal(fixture.environmentReads.count, 0)
  assert.equal(evidence.schemaVersion, 2)
  assert.deepEqual(Object.keys(evidence), [
    "schemaVersion",
    "phase",
    "repository",
    "defaultBranch",
    "headSha",
    "capturedAt",
    "expiresAt",
    "tools",
    "files",
    "packages",
    "github",
  ])
  assert.deepEqual(Object.keys(evidence.github), [
    "repository",
    "workflows",
    "abandonmentMode",
    "remoteDefaultBranch",
    "managedCandidateRefs",
    "nonterminalReleaseRuns",
    "abandonmentEnvironment",
    "immutableReleases",
  ])
  assert.equal(evidence.github.abandonmentMode, "disabled")
  assert.equal(evidence.github.abandonmentEnvironment, null)
  assert.deepEqual(evidence.github.remoteDefaultBranch, {
    ref: "refs/heads/main",
    commitSha: HEAD_SHA,
    workflow: {
      status: "present",
      path: RELEASE_WORKFLOW,
      sha256: sha256(DISABLED_BYTES),
      mode: "disabled",
    },
  })
  assert.deepEqual(evidence.github.managedCandidateRefs, [])
  assert.deepEqual(evidence.github.nonterminalReleaseRuns, [])
  assert.deepEqual(
    evidence.files.map(({ path }) => path),
    EXPECTED_OWNER_FILES,
  )
  assert.equal(evidence.packages.length, 21)
  assert.equal(evidence.headSha, HEAD_SHA)
  assert.equal(evidence.expiresAt, "2026-08-25T12:15:00.000Z")
  assert.equal(JSON.stringify(evidence).includes("secret"), false)
  assertFrozen(evidence)
  assert.deepEqual(parseOwnerEvidence(canonicalOwnerEvidenceBytes(evidence)), evidence)
})

test("protected capture reads the environment after every ref and run and retains reviewer protection", async () => {
  const fixture = captureFixture({
    phase: "post-enable",
    localMode: "protected",
    immutableEnabled: true,
    candidates: [candidate("refs/tags/v0.1.0", TAG_OBJECT_SHA_1, PEELED_SHA_1, PROTECTED_BYTES)],
  })
  const evidence = await captureOwnerEvidence(fixture.input)
  const githubCalls = fixture.calls.filter(([kind]) => kind === "github")
  const environmentIndex = githubCalls.findIndex((call) => call[1] === "environment")
  const lastRunIndex = githubCalls.findLastIndex((call) => call[1] === "release-runs")
  const lastRefReadIndex = githubCalls.findLastIndex((call) =>
    ["managed-candidate-refs", "annotated-tag", "workflow-content"].includes(call[1]),
  )

  assert.equal(fixture.environmentBindings.count, 1)
  assert.equal(fixture.environmentReads.count, 1)
  assert.ok(environmentIndex > lastRunIndex)
  assert.ok(environmentIndex > lastRefReadIndex)
  assert.equal(evidence.github.abandonmentMode, "protected")
  assert.deepEqual(evidence.github.abandonmentEnvironment.protectionRules, [
    {
      type: "required_reviewers",
      preventSelfReview: true,
      reviewers: [{ type: "Team", name: "release-owners" }],
    },
  ])
  const report = verify(evidence, fixture.files)
  assert.equal(check(report, "abandonment-reachability").status, "FAIL")
  assert.equal(check(report, "abandonment-environment").status, "PASS")
})

test("pre-enable and post-enable accept only the exact disabled empty cutover snapshot", async () => {
  for (const [phase, immutableEnabled] of [
    ["pre-enable", false],
    ["post-enable", true],
  ]) {
    const fixture = captureFixture({ phase, localMode: "disabled", immutableEnabled })
    const evidence = await captureOwnerEvidence(fixture.input)
    const report = verify(evidence, fixture.files)

    assert.equal(report.status, "PASS", phase)
    for (const id of [
      "remote-default-branch",
      "abandonment-reachability",
      "managed-candidate-refs",
      "nonterminal-release-runs",
    ]) {
      assert.equal(check(report, id).status, "PASS", `${phase}:${id}`)
    }
    assert.equal(check(report, "workflow-states").status, "PASS")
    assert.equal(check(report, "immutable-releases").status, "PASS")
    assert.equal(check(report, "npm-trusted-publishers").status, "PASS")
  }
})

test("workflow-state verification enforces the exact four-workflow pre/post topology", async () => {
  const pre = captureFixture({ phase: "pre-enable", localMode: "disabled" })
  const preEvidence = await captureOwnerEvidence(pre.input)
  const post = captureFixture({
    phase: "post-enable",
    localMode: "disabled",
    immutableEnabled: true,
  })
  const postEvidence = await captureOwnerEvidence(post.input)
  assert.deepEqual(
    [
      check(verify(preEvidence, pre.files), "workflow-states").summary,
      check(verify(postEvidence, post.files), "workflow-states").summary,
    ],
    [
      "Version PR and Published Artifact Verify are active; Release and Publish Chart are manually disabled before cutover.",
      "All four controller workflows are active after cutover.",
    ],
  )

  const preCases = [
    ["version workflow disabled", 0, "disabled_manually"],
    ["release workflow active", 1, "active"],
    ["artifact verifier disabled", 2, "disabled_manually"],
    ["chart workflow active", 3, "active"],
  ]
  for (const [name, index, state] of preCases) {
    const changed = structuredClone(preEvidence)
    changed.github.workflows[index].state = state
    assert.equal(check(verify(changed, pre.files), "workflow-states").status, "FAIL", name)
  }

  for (const [index, workflow] of postEvidence.github.workflows.entries()) {
    const changed = structuredClone(postEvidence)
    changed.github.workflows[index].state = "disabled_manually"
    assert.equal(
      check(verify(changed, post.files), "workflow-states").status,
      "FAIL",
      workflow.path,
    )
  }
})

test("schema v1 is rejected while canonical v2 round-trips, sorts, freezes, and stays bounded", async () => {
  const fixture = captureFixture({
    phase: "pre-enable",
    candidates: [
      candidate("refs/tags/v0.2.0", TAG_OBJECT_SHA_2, PEELED_SHA_2, null),
      candidate("refs/tags/v0.1.0", TAG_OBJECT_SHA_1, PEELED_SHA_1, DISABLED_BYTES),
    ],
    runs: [
      releaseRun(20, 2, "waiting"),
      releaseRun(3, 1, "in_progress"),
      releaseRun(10, 1, "queued"),
    ],
  })
  const evidence = await captureOwnerEvidence(fixture.input)
  const legacy = structuredClone(evidence)
  legacy.schemaVersion = 1
  assert.throws(() => canonicalOwnerEvidenceBytes(legacy), /identity|schema/u)
  assert.throws(
    () => parseOwnerEvidence(Buffer.from(`${JSON.stringify(canonicalize(legacy))}\n`)),
    /identity|schema/u,
  )

  const unsorted = structuredClone(evidence)
  unsorted.github.managedCandidateRefs.reverse()
  unsorted.github.nonterminalReleaseRuns.reverse()
  const canonical = parseOwnerEvidence(canonicalOwnerEvidenceBytes(unsorted))
  assert.deepEqual(
    canonical.github.managedCandidateRefs.map(({ ref }) => ref),
    ["refs/tags/v0.1.0", "refs/tags/v0.2.0"],
  )
  assert.deepEqual(
    canonical.github.nonterminalReleaseRuns.map(({ id, runAttempt }) => [id, runAttempt]),
    [
      [3, 1],
      [10, 1],
      [20, 2],
    ],
  )
  assertFrozen(canonical)
  assert.throws(
    () => parseOwnerEvidence(Buffer.from(`${JSON.stringify(canonicalize(unsorted))}\n`)),
    /canonical/u,
  )
  assert.throws(() => parseOwnerEvidence(Buffer.alloc(1024 * 1024 + 1, 0x20)), /bounds/u)

  const accessor = structuredClone(evidence)
  let accessed = false
  Object.defineProperty(accessor.github.remoteDefaultBranch, "commitSha", {
    enumerable: true,
    get() {
      accessed = true
      return HEAD_SHA
    },
  })
  assert.throws(() => canonicalOwnerEvidenceBytes(accessor), /descriptor-unsafe/u)
  assert.equal(accessed, false)
})

test("capture rejects remote main and remote/local workflow byte mismatches", async () => {
  const wrongHead = captureFixture({ remoteHeadSha: OTHER_HEAD_SHA })
  await assert.rejects(() => captureOwnerEvidence(wrongHead.input), /default branch|HEAD/u)

  const wrongWorkflow = captureFixture({ remoteDefaultBytes: PROTECTED_BYTES })
  await assert.rejects(() => captureOwnerEvidence(wrongWorkflow.input), /workflow.*match|bytes/u)
})

test("unknown policy and invalid local workflow fail before any GitHub authority read", async () => {
  const unknownPolicy = captureFixture()
  const policy = JSON.parse(POLICY_BYTES.toString("utf8"))
  policy.variants[0].canonicalSha256 = "f".repeat(64)
  unknownPolicy.files.set(POLICY_PATH, Buffer.from(`${JSON.stringify(policy)}\n`))
  await assert.rejects(() => captureOwnerEvidence(unknownPolicy.input), /policy/u)
  assert.deepEqual(
    unknownPolicy.calls.filter(([kind]) => kind === "github"),
    [],
  )

  const invalidWorkflow = captureFixture()
  invalidWorkflow.files.set(RELEASE_WORKFLOW, Buffer.from("name: Release\n"))
  await assert.rejects(() => captureOwnerEvidence(invalidWorkflow.input), /workflow/u)
  assert.deepEqual(
    invalidWorkflow.calls.filter(([kind]) => kind === "github"),
    [],
  )
})

test("all Task 4 methods are bound before remote reads while disabled mode never binds environment", async () => {
  const fixture = captureFixture()
  delete fixture.githubTarget.getAnnotatedTag
  await assert.rejects(() => captureOwnerEvidence(fixture.input), /getAnnotatedTag/u)
  assert.deepEqual(
    fixture.calls.filter(([kind]) => kind === "github"),
    [],
  )
  assert.equal(fixture.environmentBindings.count, 0)
})

test("managed annotated refs are sorted and bind each exact peel and workflow presence", async () => {
  const fixture = captureFixture({
    candidates: [
      candidate("refs/tags/v0.2.0", TAG_OBJECT_SHA_2, PEELED_SHA_2, null),
      candidate("refs/tags/v0.1.0", TAG_OBJECT_SHA_1, PEELED_SHA_1, DISABLED_BYTES),
    ],
  })
  const evidence = await captureOwnerEvidence(fixture.input)

  assert.deepEqual(evidence.github.managedCandidateRefs, [
    {
      ref: "refs/tags/v0.1.0",
      object: { type: "tag", sha: TAG_OBJECT_SHA_1 },
      peeledCommitSha: PEELED_SHA_1,
      workflow: {
        status: "present",
        path: RELEASE_WORKFLOW,
        sha256: sha256(DISABLED_BYTES),
        mode: "disabled",
      },
    },
    {
      ref: "refs/tags/v0.2.0",
      object: { type: "tag", sha: TAG_OBJECT_SHA_2 },
      peeledCommitSha: PEELED_SHA_2,
      workflow: {
        status: "absent",
        path: RELEASE_WORKFLOW,
        sha256: null,
        mode: null,
      },
    },
  ])
  assert.equal(check(verify(evidence, fixture.files), "managed-candidate-refs").status, "FAIL")
})

test("lightweight, nested, wrong-peel, duplicate-ref, and duplicate-object candidates reject", async () => {
  const cases = [
    [
      "lightweight",
      (fixture) => {
        fixture.githubTarget.listManagedCandidateRefs = async () =>
          present([{ ref: "refs/tags/v0.1.0", object: { type: "commit", sha: PEELED_SHA_1 } }])
      },
    ],
    [
      "nested",
      (fixture) => {
        fixture.githubTarget.getAnnotatedTag = async () =>
          present({ sha: TAG_OBJECT_SHA_1, object: { type: "tag", sha: PEELED_SHA_1 } })
      },
    ],
    [
      "wrong peel",
      (fixture) => {
        fixture.githubTarget.getAnnotatedTag = async () =>
          present({ sha: TAG_OBJECT_SHA_2, object: { type: "commit", sha: PEELED_SHA_1 } })
      },
    ],
    [
      "duplicate ref",
      (fixture) => {
        fixture.githubTarget.listManagedCandidateRefs = async () =>
          present([
            { ref: "refs/tags/v0.1.0", object: { type: "tag", sha: TAG_OBJECT_SHA_1 } },
            { ref: "refs/tags/v0.1.0", object: { type: "tag", sha: TAG_OBJECT_SHA_2 } },
          ])
      },
    ],
    [
      "duplicate object",
      (fixture) => {
        fixture.githubTarget.listManagedCandidateRefs = async () =>
          present([
            { ref: "refs/tags/v0.1.0", object: { type: "tag", sha: TAG_OBJECT_SHA_1 } },
            { ref: "refs/tags/v0.2.0", object: { type: "tag", sha: TAG_OBJECT_SHA_1 } },
          ])
      },
    ],
  ]
  for (const [name, mutate] of cases) {
    const fixture = captureFixture({
      candidates: [candidate("refs/tags/v0.1.0", TAG_OBJECT_SHA_1, PEELED_SHA_1, DISABLED_BYTES)],
    })
    mutate(fixture)
    await assert.rejects(() => captureOwnerEvidence(fixture.input), undefined, name)
  }
})

test("unavailable or malformed structural ref, content, and run reads abort capture", async () => {
  const cases = [
    ["default ref unavailable", "getDefaultBranchRef", unavailable()],
    ["default content unavailable", "getWorkflowContent", unavailable()],
    ["managed refs unavailable", "listManagedCandidateRefs", unavailable()],
    ["managed refs malformed", "listManagedCandidateRefs", present({})],
    ["release runs unavailable", "listReleaseRuns", unavailable()],
    ["release runs malformed", "listReleaseRuns", present({})],
  ]
  for (const [name, method, result] of cases) {
    const fixture = captureFixture()
    fixture.githubTarget[method] = async () => result
    await assert.rejects(() => captureOwnerEvidence(fixture.input), undefined, name)
  }

  const candidateFixture = captureFixture({
    candidates: [candidate("refs/tags/v0.1.0", TAG_OBJECT_SHA_1, PEELED_SHA_1, DISABLED_BYTES)],
  })
  candidateFixture.githubTarget.getWorkflowContent = async (_repository, _path, sha) =>
    sha === HEAD_SHA ? workflowContent(DISABLED_BYTES) : unavailable()
  await assert.rejects(() => captureOwnerEvidence(candidateFixture.input))
})

test("release runs preserve statuses, sort deterministically, and reject any repeated run id", async () => {
  const fixture = captureFixture({
    runs: [
      releaseRun(20, 2, "waiting"),
      releaseRun(3, 1, "in_progress"),
      releaseRun(20, 1, "queued"),
      releaseRun(10, 1, "requested"),
    ],
  })
  await assert.rejects(
    () => captureOwnerEvidence(fixture.input),
    /duplicate|conflict|identity/u,
    "same run id across any status/attempt conflicts",
  )

  const sortedFixture = captureFixture({
    runs: [
      releaseRun(20, 2, "waiting"),
      releaseRun(3, 1, "in_progress"),
      releaseRun(10, 1, "requested"),
    ],
  })
  const evidence = await captureOwnerEvidence(sortedFixture.input)
  assert.deepEqual(
    evidence.github.nonterminalReleaseRuns.map(({ id, runAttempt, status }) => [
      id,
      runAttempt,
      status,
    ]),
    [
      [3, 1, "in_progress"],
      [10, 1, "requested"],
      [20, 2, "waiting"],
    ],
  )
  assert.equal(
    check(verify(evidence, sortedFixture.files), "nonterminal-release-runs").status,
    "FAIL",
  )
})

test("one unfiltered capture records runs after formerly evasive multi-transition paths", async (t) => {
  for (const [name, statuses] of [
    ["queued to in_progress to waiting", ["queued", "in_progress", "waiting"]],
    ["requested to pending to queued", ["requested", "pending", "queued"]],
  ]) {
    await t.test(name, async () => {
      const fixture = captureFixture()
      let calls = 0
      fixture.githubTarget.listReleaseRuns = async (repository, path, ...extraArguments) => {
        fixture.calls.push(["github", "release-runs", repository, path])
        assert.deepEqual(extraArguments, [])
        calls += 1
        let currentStatus = statuses[0]
        for (const nextStatus of statuses.slice(1)) currentStatus = nextStatus
        return present([releaseRun(30, 1, currentStatus)])
      }

      const evidence = await captureOwnerEvidence(fixture.input)
      assert.equal(calls, 1)
      assert.deepEqual(evidence.github.nonterminalReleaseRuns, [releaseRun(30, 1, statuses.at(-1))])

      const report = verify(evidence, fixture.files)
      assert.equal(check(report, "nonterminal-release-runs").status, "FAIL")
      assert.equal(report.status, "FAIL")
    })
  }
})

test("normalization rejects nested extras, duplicate identities, and mode/environment contradictions", async () => {
  const disabledFixture = captureFixture({
    candidates: [candidate("refs/tags/v0.1.0", TAG_OBJECT_SHA_1, PEELED_SHA_1, DISABLED_BYTES)],
  })
  const disabled = await captureOwnerEvidence(disabledFixture.input)
  const protectedFixture = captureFixture({ localMode: "protected" })
  const protectedEvidence = await captureOwnerEvidence(protectedFixture.input)
  const mutations = [
    (value) => (value.github.remoteDefaultBranch.workflow.extra = true),
    (value) =>
      value.github.managedCandidateRefs.push(structuredClone(value.github.managedCandidateRefs[0])),
    (value) => {
      value.github.managedCandidateRefs.push(structuredClone(value.github.managedCandidateRefs[0]))
      value.github.managedCandidateRefs[1].ref = "refs/tags/v0.2.0"
    },
    (value) =>
      (value.github.abandonmentEnvironment = protectedEvidence.github.abandonmentEnvironment),
    (value) => {
      value.github.abandonmentMode = "protected"
      value.github.abandonmentEnvironment = null
    },
    (value) => (value.github.managedCandidateRefs[0].workflow.mode = "protected"),
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(disabled)
    mutate(changed)
    assert.throws(() => canonicalOwnerEvidenceBytes(changed))
  }

  const protectedWithoutEnvironment = structuredClone(protectedEvidence)
  protectedWithoutEnvironment.github.abandonmentEnvironment = null
  assert.throws(() => canonicalOwnerEvidenceBytes(protectedWithoutEnvironment))
})

test("owner evidence hashes require primitive strings and reject duplicate array identities", async (t) => {
  const fixture = captureFixture({
    candidates: [
      candidate("refs/tags/v0.2.0", TAG_OBJECT_SHA_2, PEELED_SHA_2, DISABLED_BYTES),
      candidate("refs/tags/v0.1.0", TAG_OBJECT_SHA_1, PEELED_SHA_1, DISABLED_BYTES),
    ],
    runs: [releaseRun(3, 1, "in_progress")],
  })
  const evidence = await captureOwnerEvidence(fixture.input)
  const mutations = [
    ["file SHA-256", (value) => (value.files[0].sha256 = [value.files[0].sha256])],
    [
      "candidate object SHA",
      (value) =>
        (value.github.managedCandidateRefs[0].object.sha = [
          value.github.managedCandidateRefs[0].object.sha,
        ]),
    ],
    [
      "nested peeled SHA",
      (value) =>
        (value.github.managedCandidateRefs[0].peeledCommitSha = [
          [value.github.managedCandidateRefs[0].peeledCommitSha],
        ]),
    ],
    [
      "candidate workflow SHA-256",
      (value) =>
        (value.github.managedCandidateRefs[0].workflow.sha256 = [
          value.github.managedCandidateRefs[0].workflow.sha256,
        ]),
    ],
    [
      "nested run head SHA",
      (value) =>
        (value.github.nonterminalReleaseRuns[0].headSha = [
          [value.github.nonterminalReleaseRuns[0].headSha],
        ]),
    ],
  ]
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const changed = structuredClone(evidence)
      mutate(changed)
      assert.throws(() => parseOwnerEvidence(canonicalOwnerEvidenceBytes(changed)))
    })
  }

  await t.test("duplicate tag object SHA arrays", () => {
    const duplicateArrays = structuredClone(evidence)
    duplicateArrays.github.managedCandidateRefs[0].object.sha = [TAG_OBJECT_SHA_1]
    duplicateArrays.github.managedCandidateRefs[1].object.sha = [TAG_OBJECT_SHA_1]
    assert.throws(() => parseOwnerEvidence(canonicalOwnerEvidenceBytes(duplicateArrays)))
  })

  await t.test("capture adapter blob SHA array", async () => {
    const capture = captureFixture()
    capture.githubTarget.getWorkflowContent = async () =>
      present({
        path: RELEASE_WORKFLOW,
        sha: [BLOB_SHA],
        contentBase64: DISABLED_BYTES.toString("base64"),
      })
    await assert.rejects(() => captureOwnerEvidence(capture.input))
  })
})

test("new verification checks fail or become unprovable on relevant mutations", async () => {
  const baseFixture = captureFixture()
  const base = await captureOwnerEvidence(baseFixture.input)
  const changedHead = verifyOwnerEvidence({
    evidence: base,
    currentHeadSha: OTHER_HEAD_SHA,
    currentFiles: baseFixture.files,
    now: () => NOW + 1,
  })
  assert.equal(check(changedHead, "remote-default-branch").status, "FAIL")

  const protectedFixture = captureFixture({ localMode: "protected" })
  const protectedEvidence = await captureOwnerEvidence(protectedFixture.input)
  assert.equal(
    check(verify(protectedEvidence, protectedFixture.files), "abandonment-reachability").status,
    "FAIL",
  )

  const unavailableEnvironment = structuredClone(protectedEvidence)
  unavailableEnvironment.github.abandonmentEnvironment = environmentEvidence({
    status: "unavailable",
  })
  const unavailableReport = verify(unavailableEnvironment, protectedFixture.files)
  assert.equal(check(unavailableReport, "abandonment-environment").status, "UNPROVABLE")
  assert.equal(check(unavailableReport, "abandonment-reachability").status, "FAIL")
})

test("historical repository, workflow-state, immutable, and npm unavailable reads remain evidence", async () => {
  const fixture = captureFixture()
  fixture.githubTarget.getRepository = async () => unavailable()
  fixture.githubTarget.getWorkflow = async () => unavailable()
  fixture.githubTarget.getImmutableReleases = async () => unavailable()
  fixture.input.npm.trustList = async () => ({ status: "unavailable", code: "E401" })
  const evidence = await captureOwnerEvidence(fixture.input)
  const report = verify(evidence, fixture.files)

  assert.equal(check(report, "repository-capability").status, "UNPROVABLE")
  assert.equal(check(report, "workflow-states").status, "UNPROVABLE")
  assert.equal(check(report, "immutable-releases").status, "UNPROVABLE")
  assert.equal(check(report, "npm-trusted-publishers").status, "UNPROVABLE")
})

test("verification rejects stale, future, changed-file, malformed, and descriptor-unsafe evidence", async () => {
  const fixture = captureFixture()
  const evidence = await captureOwnerEvidence(fixture.input)
  const cases = [
    ["expired", NOW + 15 * 60_000 + 1, HEAD_SHA, fixture.files, "UNPROVABLE"],
    ["future", NOW - 1, HEAD_SHA, fixture.files, "FAIL"],
    [
      "file",
      NOW + 1,
      HEAD_SHA,
      new Map(fixture.files).set(EXPECTED_OWNER_FILES[0], Buffer.from("changed")),
      "FAIL",
    ],
  ]
  for (const [name, now, head, files, status] of cases) {
    assert.equal(
      verifyOwnerEvidence({ evidence, currentHeadSha: head, currentFiles: files, now: () => now })
        .status,
      status,
      name,
    )
  }

  const extra = structuredClone(evidence)
  extra.extra = true
  assert.throws(() => canonicalOwnerEvidenceBytes(extra), /fields/u)

  const accessor = structuredClone(evidence)
  Object.defineProperty(accessor, "repository", {
    enumerable: true,
    get() {
      assert.fail("owner evidence accessors must not execute")
    },
  })
  assert.throws(
    () =>
      verifyOwnerEvidence({
        evidence: accessor,
        currentHeadSha: HEAD_SHA,
        currentFiles: fixture.files,
      }),
    /descriptor-unsafe/u,
  )
})

function captureFixture({
  phase = "pre-enable",
  localMode = "disabled",
  immutableEnabled = phase === "post-enable",
  remoteHeadSha = HEAD_SHA,
  remoteDefaultBytes,
  candidates = [],
  runs = [],
} = {}) {
  const calls = []
  const environmentBindings = { count: 0 }
  const environmentReads = { count: 0 }
  const localWorkflowBytes = localMode === "protected" ? PROTECTED_BYTES : DISABLED_BYTES
  const files = new Map(
    EXPECTED_OWNER_FILES.map((filePath, index) => [filePath, Buffer.from(`fixture-${index}\n`)]),
  )
  files.set(RELEASE_WORKFLOW, Buffer.from(localWorkflowBytes))
  files.set(CONTROLLER_SCHEMA, controllerSchemaBytes())
  files.set(POLICY_PATH, Buffer.from(POLICY_BYTES))

  const githubTarget = {
    async version() {
      calls.push(["tool", "gh-version"])
      return "2.95.0"
    },
    async getRepository(repository) {
      calls.push(["github", "repository", repository])
      return present({
        id: 123,
        full_name: REPOSITORY,
        default_branch: "main",
        permissions: { admin: true },
      })
    },
    async getWorkflow(path) {
      calls.push(["github", "workflow", path])
      const preEnabled = [
        ".github/workflows/version-pr.yml",
        ".github/workflows/published-artifact-verify.yml",
      ].includes(path)
      return present({
        id: 500 + WORKFLOW_PATHS.indexOf(path),
        path,
        state: phase === "pre-enable" && !preEnabled ? "disabled_manually" : "active",
      })
    },
    async getDefaultBranchRef(repository, branch) {
      calls.push(["github", "default-branch-ref", repository, branch])
      return present({
        ref: "refs/heads/main",
        object: { type: "commit", sha: remoteHeadSha },
      })
    },
    async getWorkflowContent(repository, path, commitSha) {
      calls.push(["github", "workflow-content", repository, path, commitSha])
      if (commitSha === remoteHeadSha) {
        return workflowContent(remoteDefaultBytes ?? localWorkflowBytes)
      }
      const item = candidates.find((candidate) => candidate.peeledCommitSha === commitSha)
      if (item === undefined) return unavailable()
      return item.workflowBytes === null ? absent() : workflowContent(item.workflowBytes)
    },
    async listManagedCandidateRefs(repository) {
      calls.push(["github", "managed-candidate-refs", repository])
      return present(
        candidates.map(({ ref, tagObjectSha }) => ({
          ref,
          object: { type: "tag", sha: tagObjectSha },
        })),
      )
    },
    async getAnnotatedTag(repository, tagObjectSha) {
      calls.push(["github", "annotated-tag", repository, tagObjectSha])
      const item = candidates.find((candidate) => candidate.tagObjectSha === tagObjectSha)
      return item === undefined
        ? unavailable()
        : present({
            sha: item.tagObjectSha,
            object: { type: "commit", sha: item.peeledCommitSha },
          })
    },
    async listReleaseRuns(repository, path) {
      calls.push(["github", "release-runs", repository, path])
      return present(runs.map((run) => ({ ...run })))
    },
    async getImmutableReleases(repository) {
      calls.push(["github", "immutable-releases", repository])
      return present({ enabled: immutableEnabled, enforced_by_owner: false })
    },
  }
  if (localMode === "protected") {
    githubTarget.getEnvironment = async (name) => {
      environmentReads.count += 1
      calls.push(["github", "environment", name])
      return present({
        name,
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: true,
            reviewers: [{ type: "Team", reviewer: { slug: "release-owners" } }],
          },
        ],
      })
    }
  } else {
    Object.defineProperty(githubTarget, "getEnvironment", {
      enumerable: true,
      configurable: true,
      get() {
        environmentReads.count += 1
        throw new Error("disabled capture must not read the environment adapter")
      },
    })
  }
  const github = new Proxy(githubTarget, {
    getOwnPropertyDescriptor(target, property) {
      if (property === "getEnvironment") environmentBindings.count += 1
      return Reflect.getOwnPropertyDescriptor(target, property)
    },
  })
  const input = {
    phase,
    repository: REPOSITORY,
    packageNames: CANONICAL_RELEASE_PACKAGE_ORDER,
    files: {
      async read(path) {
        calls.push(["file", "read", path])
        return files.get(path)
      },
    },
    git: {
      async headSha() {
        calls.push(["git", "head"])
        return HEAD_SHA
      },
    },
    npm: {
      async version() {
        calls.push(["tool", "npm-version"])
        return "11.17.0"
      },
      async trustList(name) {
        calls.push(["npm", "trust-list", name])
        return present({
          id: `trust-${name}`,
          type: "github",
          file: "release.yml",
          repository: REPOSITORY,
          permissions: ["createPackage"],
        })
      },
    },
    github,
    now: () => NOW,
  }
  return {
    calls,
    environmentBindings,
    environmentReads,
    files,
    githubTarget,
    input,
  }
}

function candidate(ref, tagObjectSha, peeledCommitSha, workflowBytes) {
  return { ref, tagObjectSha, peeledCommitSha, workflowBytes }
}

function releaseRun(id, runAttempt, status) {
  return {
    id,
    runAttempt,
    status,
    event: "workflow_dispatch",
    headSha: HEAD_SHA,
    headBranch: "main",
  }
}

function present(value) {
  return { status: "present", httpStatus: 200, value }
}

function absent() {
  return { status: "absent", httpStatus: 404, value: null }
}

function unavailable() {
  return { status: "unavailable", httpStatus: null, value: null }
}

function workflowContent(bytes) {
  return present({
    path: RELEASE_WORKFLOW,
    sha: BLOB_SHA,
    contentBase64: Buffer.from(bytes).toString("base64"),
  })
}

function controllerSchemaBytes() {
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      publishingOwner: "release-controller",
      epoch: "fixed-group-v1",
      npmTrustedPublisherEnvironment: null,
      abandonmentEnvironment: "release-abandonment",
    })}\n`,
  )
}

function environmentEvidence({ status = "present" } = {}) {
  if (status === "unavailable") {
    return {
      operation: "GET /repos/{owner}/{repo}/environments/release-abandonment",
      status: "unavailable",
      httpStatus: null,
      name: "release-abandonment",
      protectionRules: [],
    }
  }
  return {
    operation: "GET /repos/{owner}/{repo}/environments/release-abandonment",
    status: "present",
    httpStatus: 200,
    name: "release-abandonment",
    protectionRules: [
      {
        type: "required_reviewers",
        preventSelfReview: true,
        reviewers: [{ type: "Team", name: "release-owners" }],
      },
    ],
  }
}

function verify(evidence, currentFiles) {
  return verifyOwnerEvidence({
    evidence,
    currentHeadSha: HEAD_SHA,
    currentFiles,
    now: () => NOW + 1,
  })
}

function check(report, id) {
  const value = report.checks.find((item) => item.id === id)
  assert.ok(value, `missing check ${id}`)
  return value
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function assertFrozen(value) {
  if (value !== null && typeof value === "object") {
    assert.equal(Object.isFrozen(value), true)
    for (const child of Object.values(value)) assertFrozen(child)
  }
}
