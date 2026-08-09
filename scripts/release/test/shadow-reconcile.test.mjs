import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { discoverShadowCandidate, observeCandidate } from "../observe.mjs"
import { planRelease } from "../planner.mjs"
import { runShadowReconcile } from "../shadow-reconcile.mjs"

const SHA = "341678ea7932832ec860bdd915371669440bef7c"
const PARENT_SHA = "c2c19da9e6026feeae873df1ce52d6b3e36bb06c"
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/incidents/0.8.21-publish-metadata-failure.json",
)

test("candidate discovery compares exact ref inventory with its first parent", async () => {
  const calls = []
  const git = {
    async listFirstParentHistory(input) {
      calls.push(["history", input])
      return [SHA]
    },
    async firstParent(ref) {
      calls.push(["parent", ref])
      return PARENT_SHA
    },
  }
  const inventory = {
    async read({ ref }) {
      calls.push(["inventory", ref])
      return releaseInventory(ref === SHA ? "0.8.21" : "0.8.20")
    },
  }

  const candidate = await discoverShadowCandidate({ ref: "origin/main", git, inventory })

  assert.deepEqual(candidate, {
    version: "0.8.21",
    commitSha: SHA,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  })
  assert.deepEqual(calls, [
    ["history", { ref: "origin/main", maxCount: 1 }],
    ["parent", SHA],
    ["inventory", SHA],
    ["inventory", PARENT_SHA],
  ])
})

test("candidate discovery returns null for an unchanged fixed-group version", async () => {
  const git = {
    async listFirstParentHistory() {
      return [SHA]
    },
    async firstParent() {
      return PARENT_SHA
    },
  }
  const inventory = {
    async read() {
      return releaseInventory("0.8.21")
    },
  }

  assert.equal(await discoverShadowCandidate({ ref: "main", git, inventory }), null)
})

test("candidate discovery rejects nonuniform deltas and package-set drift", async () => {
  const git = {
    async listFirstParentHistory() {
      return [SHA]
    },
    async firstParent() {
      return PARENT_SHA
    },
  }
  for (const current of [
    {
      status: "valid",
      packages: [
        { name: "@dawn-ai/a", version: "0.8.21" },
        { name: "@dawn-ai/b", version: "0.8.20" },
      ],
    },
    { status: "valid", packages: [{ name: "@dawn-ai/a", version: "0.8.21" }] },
  ]) {
    let reads = 0
    const inventory = {
      async read() {
        reads += 1
        return reads === 1 ? current : releaseInventory("0.8.20")
      },
    }
    await assert.rejects(
      discoverShadowCandidate({ ref: "main", git, inventory }),
      /uniform|package set/u,
    )
  }
})

test("current-main inventory validation fails closed for every release policy defect", async () => {
  const categories = [
    "structuralErrors",
    "workspaceDuplicates",
    "duplicates",
    "extra",
    "missing",
    "privateMembers",
    "unknownMembers",
    "versionMismatches",
  ]
  for (const category of categories) {
    let assertions = 0
    let stderr = ""
    const code = await runShadowReconcile({
      argv: ["--repository", "cacheplane/dawnai", "--format", "json"],
      env: {},
      stdout: { write: assert.fail },
      stderr: { write: (value) => (stderr += value) },
      dependencies: {
        createGitReader() {
          return {
            async listFirstParentHistory() {
              return [SHA]
            },
          }
        },
        createNpmReader() {
          return {}
        },
        createGitHubReader() {
          return {}
        },
        async readReleaseInventory() {
          return { category }
        },
        assertValidReleaseInventory(raw) {
          assertions += 1
          throw new Error(`inventory-${raw.category}`)
        },
        async discoverShadowCandidate({ ref, inventory }) {
          await inventory.read({ ref })
          return null
        },
      },
    })

    assert.equal(code, 1, category)
    assert.equal(assertions, 1, category)
    assert.match(stderr, new RegExp(`inventory-${category}`, "u"))
  }
})

test("current-main fallback is limited to typed ref absence and reports exact selected identity", async () => {
  for (const scenario of [
    { missingOrigin: false, selectedRef: "origin/main", resolvedCommitSha: SHA },
    { missingOrigin: true, selectedRef: "main", resolvedCommitSha: PARENT_SHA },
  ]) {
    const calls = []
    let output = ""
    const code = await runShadowReconcile({
      argv: ["--repository", "cacheplane/dawnai", "--format", "json"],
      env: {},
      stdout: { write: (value) => (output += value) },
      stderr: { write: assert.fail },
      dependencies: currentMainDependencies({ scenario, calls }),
    })

    assert.equal(code, 0)
    const report = JSON.parse(output)
    assert.equal(report.source.requestedRef, "origin/main")
    assert.equal(report.source.selectedRef, scenario.selectedRef)
    assert.equal(report.source.resolvedCommitSha, scenario.resolvedCommitSha)
    assert.deepEqual(
      calls.filter(([operation]) => operation === "discover"),
      [["discover", scenario.resolvedCommitSha]],
    )
  }
})

test("current-main does not fall back on policy, parse, auth, or unrelated Git failures", async () => {
  for (const failure of [
    Object.assign(new Error("inventory policy failed"), { code: "INVENTORY_INVALID" }),
    Object.assign(new Error("configuration parse failed"), { code: "PARSE_FAILED" }),
    Object.assign(new Error("authentication failed"), { code: "AUTH_FAILED" }),
    Object.assign(new Error("Git read failed"), { code: "TIMEOUT" }),
  ]) {
    let mainReads = 0
    let stderr = ""
    const dependencies = currentMainDependencies({
      scenario: { missingOrigin: false, selectedRef: "origin/main", resolvedCommitSha: SHA },
      calls: [],
    })
    dependencies.createGitReader = () => ({
      async listFirstParentHistory({ ref }) {
        if (ref === "main") mainReads += 1
        throw failure
      },
    })
    const code = await runShadowReconcile({
      argv: ["--repository", "cacheplane/dawnai", "--format", "json"],
      env: {},
      stdout: { write: assert.fail },
      stderr: { write: (value) => (stderr += value) },
      dependencies,
    })

    assert.equal(code, 1, failure.code)
    assert.equal(mainReads, 0, failure.code)
    assert.match(stderr, new RegExp(failure.message, "u"))
  }
})

test("observation composition calls only named readers in inventory order and preserves ambiguity", async () => {
  const calls = []
  const inventory = managedInventory()
  const git = {
    async resolveTag(input) {
      calls.push(["git.resolveTag", input])
      return SHA
    },
  }
  const npm = {
    async observePackageVersion(input) {
      calls.push(["npm.observePackageVersion", input])
      return {
        status: "AMBIGUOUS",
        operation: "package-version",
        httpStatus: 429,
        code: "RATE_LIMITED",
      }
    },
  }
  const github = ambiguousGitHub(calls)

  const result = await observeCandidate({
    candidate: candidate(),
    inventory,
    git,
    npm,
    github,
  })

  assert.equal(result.observation.ci.status, "ambiguous")
  assert.equal(result.observation.tag.status, "ambiguous")
  assert.equal(result.observation.registry.packages[0].status, "ambiguous")
  assert.equal(result.observation.release.status, "ambiguous")
  assert.ok(result.diagnostics.every((item) => item.code !== null))
  assert.ok(result.diagnostics.some((item) => item.code === "RATE_LIMITED"))
  assert.deepEqual(
    calls.filter(([name]) => name === "npm.observePackageVersion"),
    inventory.packages.map((pkg) => [
      "npm.observePackageVersion",
      { name: pkg.name, version: "0.8.21" },
    ]),
  )
  assert.doesNotMatch(JSON.stringify(result), /authorization|bearer|token|secret/iu)
})

test("CI success requires independently correlated workflow-run and validate-check evidence", async () => {
  const exactRun = {
    id: 101,
    run_attempt: 1,
    name: "CI",
    path: ".github/workflows/ci.yml",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    check_suite_id: 501,
  }
  const exactCheck = {
    name: "validate",
    status: "completed",
    conclusion: "success",
    head_sha: SHA,
    check_suite: { id: 501 },
  }
  const cases = [
    {
      name: "exact pair",
      runs: [exactRun],
      checks: [exactCheck],
      expected: "success",
      workflow: "CI",
      commitSha: SHA,
    },
    {
      name: "wrong workflow",
      runs: [{ ...exactRun, name: "Release" }],
      checks: [exactCheck],
      expected: "ambiguous",
      workflow: "Release",
      commitSha: SHA,
    },
    {
      name: "missing workflow",
      runs: [],
      checks: [exactCheck],
      expected: "ambiguous",
      workflow: null,
      commitSha: SHA,
    },
    {
      name: "check only",
      runs: null,
      checks: [exactCheck],
      expected: "ambiguous",
      workflow: null,
      commitSha: SHA,
    },
    {
      name: "wrong SHA",
      runs: [{ ...exactRun, head_sha: PARENT_SHA }],
      checks: [exactCheck],
      expected: "ambiguous",
      workflow: "CI",
      commitSha: null,
    },
    {
      name: "wrong run",
      runs: [exactRun],
      checks: [{ ...exactCheck, check_suite: { id: 999 } }],
      expected: "ambiguous",
      workflow: "CI",
      commitSha: SHA,
    },
    ...[
      {
        name: "both suite IDs missing",
        run: withoutFields(exactRun, ["check_suite_id"]),
        check: withoutFields(exactCheck, ["check_suite"]),
      },
      {
        name: "workflow suite ID missing",
        run: withoutFields(exactRun, ["check_suite_id"]),
        check: exactCheck,
      },
      {
        name: "check suite ID missing",
        run: exactRun,
        check: withoutFields(exactCheck, ["check_suite"]),
      },
      {
        name: "workflow suite ID zero",
        run: { ...exactRun, check_suite_id: 0 },
        check: exactCheck,
      },
      {
        name: "check suite ID malformed",
        run: exactRun,
        check: { ...exactCheck, check_suite: { id: "501" } },
      },
      { name: "workflow run ID missing", run: withoutFields(exactRun, ["id"]), check: exactCheck },
      { name: "workflow run ID zero", run: { ...exactRun, id: 0 }, check: exactCheck },
      { name: "workflow run ID malformed", run: { ...exactRun, id: "101" }, check: exactCheck },
      {
        name: "workflow attempt missing",
        run: withoutFields(exactRun, ["run_attempt"]),
        check: exactCheck,
      },
      { name: "workflow attempt zero", run: { ...exactRun, run_attempt: 0 }, check: exactCheck },
      {
        name: "workflow attempt malformed",
        run: { ...exactRun, run_attempt: "1" },
        check: exactCheck,
      },
    ].map(({ name, run, check }) => ({
      name,
      runs: [run],
      checks: [check],
      expected: "ambiguous",
      workflow: "CI",
      commitSha: SHA,
    })),
  ]

  for (const item of cases) {
    const github = absentGitHub()
    github.getCommitCheckRuns = async () => presentEnvelope("commit-check-runs", item.checks)
    github.listWorkflowRuns = async () =>
      item.runs === null
        ? {
            status: "AMBIGUOUS",
            operation: "workflow-runs",
            httpStatus: 503,
            code: "SERVER_ERROR",
          }
        : presentEnvelope("workflow-runs", item.runs)
    const result = await observeCandidate({
      candidate: candidate(),
      inventory: managedInventory(),
      git: {
        async resolveTag() {
          return SHA
        },
      },
      npm: {
        async observePackageVersion() {
          return ambiguousEnvelope("package-version")
        },
      },
      github,
    })

    assert.equal(result.observation.ci.status, item.expected, item.name)
    assert.equal(result.observation.ci.workflow, item.workflow, item.name)
    assert.equal(result.observation.ci.check, "validate", item.name)
    assert.equal(result.observation.ci.commitSha, item.commitSha, item.name)
  }
})

test("raw npm signature records never become cryptographically valid managed evidence", async () => {
  const inventory = managedInventory()
  const result = await observeCandidate({
    candidate: candidate(),
    inventory,
    git: {
      async resolveTag() {
        return SHA
      },
    },
    npm: {
      async observePackageVersion({ name, version }) {
        const pkg = inventory.packages.find((item) => item.name === name)
        return {
          status: "PRESENT",
          operation: "package-version",
          httpStatus: 200,
          code: null,
          package: {
            name,
            version,
            tarballUrl: "https://registry.npmjs.org/example.tgz",
            shasum: "a".repeat(40),
            integrity: pkg.integrity,
            signatures: [{ keyid: "key", sig: "signature" }],
            distTags: { latest: version },
            latest: version,
            provenance: {
              status: "PRESENT",
              url: "https://registry.npmjs.org/-/npm/v1/attestations/example",
              predicateTypes: ["https://slsa.dev/provenance/v1"],
              workflow: ".github/workflows/release.yml",
              commitSha: SHA,
            },
          },
        }
      },
    },
    github: absentGitHub(),
  })

  assert.ok(result.observation.registry.packages.every((pkg) => pkg.status === "ambiguous"))
  assert.ok(
    result.observation.registry.packages.every((pkg) => pkg.signature.status === "ambiguous"),
  )
  assert.ok(result.observation.registry.packages.every((pkg) => pkg.tarballSha256 === null))
  assert.ok(result.diagnostics.every((item) => item.code === "NPM_SIGNATURE_UNVERIFIED"))
  assert.ok(result.diagnostics.every((item) => item.evidenceCount === 1))
  const plan = planRelease({
    candidate: candidate(),
    observation: result.observation,
    mode: "shadow",
  })
  assert.notEqual(plan.state, "NPM_COMPLETE")
  assert.ok(!plan.conflicts.includes("observation-schema-invalid"))
  assert.equal(Object.isFrozen(result), true)
})

test("npm integrity mismatch cannot manufacture a managed tarball SHA-256", async () => {
  const inventory = managedInventory()
  const result = await observeCandidate({
    candidate: candidate(),
    inventory,
    git: {
      async resolveTag() {
        return SHA
      },
    },
    npm: {
      async observePackageVersion({ name, version }) {
        return {
          ...historicalPresentPackage(name, version),
          package: {
            ...historicalPresentPackage(name, version).package,
            integrity: "sha512-not-the-managed-bytes",
          },
        }
      },
    },
    github: absentGitHub(),
  })

  assert.ok(result.observation.registry.packages.every((pkg) => pkg.status === "ambiguous"))
  assert.ok(result.observation.registry.packages.every((pkg) => pkg.tarballSha256 === null))
  assert.ok(result.diagnostics.some((item) => item.code === "NPM_BYTES_MISMATCH"))
  assert.ok(
    result.diagnostics.some(
      (item) => item.code === "NPM_SIGNATURE_UNVERIFIED" && item.evidenceCount === 1,
    ),
  )
  const plan = planRelease({
    candidate: candidate(),
    observation: result.observation,
    mode: "shadow",
  })
  assert.notEqual(plan.state, "NPM_COMPLETE")
})

test("Release observation preserves duplicate, extra, mismatched, and digest-ambiguous assets", async () => {
  const inventory = {
    ...managedInventory(),
    releaseRecordSha256: "8".repeat(64),
    manifestAttestationSha256: "9".repeat(64),
  }
  const expected = expectedReleaseAssets(inventory)
  const rawAssets = [
    ...expected.map((asset, index) => ({
      id: index + 1,
      name: asset.name,
      digest: `sha256:${asset.sha256}`,
    })),
    {
      id: 100,
      name: "manifest.json",
      digest: `sha256:${"a".repeat(64)}`,
    },
    {
      id: 1,
      name: "unexpected-managed.txt",
      digest: `sha256:${"b".repeat(64)}`,
    },
    { id: 102, name: "missing-digest.txt" },
  ]
  const github = absentGitHub()
  github.getReleaseByTag = async () =>
    presentEnvelope("release", {
      id: 77,
      draft: true,
      tag_name: "v0.8.21",
      target_commitish: SHA,
    })
  github.listReleaseAssets = async () => presentEnvelope("release-assets", rawAssets)

  const result = await observeCandidate({
    candidate: candidate(),
    inventory,
    git: {
      async resolveTag() {
        return SHA
      },
    },
    npm: {
      async observePackageVersion() {
        return ambiguousEnvelope("package-version")
      },
    },
    github,
  })

  assert.equal(result.observation.release.assets.length, rawAssets.length)
  assert.equal(
    result.observation.release.assets.filter((asset) => asset.name === "manifest.json").length,
    2,
  )
  assert.ok(
    result.observation.release.assets.some(
      (asset) => asset.name === "unexpected-managed.txt" && asset.status === "ambiguous",
    ),
  )
  assert.deepEqual(
    result.observation.release.assets.find((asset) => asset.name === "missing-digest.txt"),
    { name: "missing-digest.txt", status: "ambiguous", sha256: null },
  )
  assert.ok(result.diagnostics.some((item) => item.code === "REMOTE_ASSET_ID_DUPLICATE"))
  const plan = planRelease({
    candidate: candidate(),
    observation: result.observation,
    mode: "shadow",
  })
  for (const conflict of [
    "github-asset-duplicate",
    "github-managed-asset-unexpected",
    "github-asset-bytes-mismatch",
    "github-asset-ambiguous",
  ]) {
    assert.ok(plan.conflicts.includes(conflict), conflict)
  }
})

test("fixture CLI performs no Git or network work and renders twice identically", async () => {
  const source = await readFile(FIXTURE, "utf8")
  let outputA = ""
  let outputB = ""
  const forbidden = () => assert.fail("fixture mode must not create live readers")
  const dependencies = {
    readFile: async (path) => {
      assert.equal(path, FIXTURE)
      return source
    },
    createGitReader: forbidden,
    createNpmReader: forbidden,
    createGitHubReader: forbidden,
  }

  const first = await runShadowReconcile({
    argv: ["--observation", FIXTURE, "--format", "json"],
    env: { GITHUB_TOKEN: "must-not-be-read" },
    stdout: {
      write(value) {
        outputA += value
      },
    },
    stderr: { write: assert.fail },
    dependencies,
  })
  const second = await runShadowReconcile({
    argv: ["--format", "json", "--observation", FIXTURE],
    env: {},
    stdout: {
      write(value) {
        outputB += value
      },
    },
    stderr: { write: assert.fail },
    dependencies,
  })

  assert.equal(first, 0)
  assert.equal(second, 0)
  assert.equal(outputA, outputB)
  assert.doesNotMatch(outputA, /must-not-be-read|authorization|bearer/iu)
})

test("live 0.8.21 reporting preserves the frozen incident run attempt", async () => {
  let output = ""
  const code = await runShadowReconcile({
    argv: [
      "--repository",
      "cacheplane/dawnai",
      "--version",
      "0.8.21",
      "--commit-sha",
      SHA,
      "--format",
      "json",
    ],
    env: {},
    stdout: {
      write(value) {
        output += value
      },
    },
    stderr: { write: assert.fail },
    dependencies: {
      createGitReader() {
        return {}
      },
      createNpmReader() {
        return {
          async observePackageVersion({ name, version }) {
            return historicalPresentPackage(name, version)
          },
        }
      },
      createGitHubReader() {
        return {
          async listWorkflowRuns() {
            return {
              status: "PRESENT",
              operation: "workflow-runs",
              httpStatus: 200,
              code: null,
              value: [
                {
                  id: 31292769511,
                  run_attempt: 2,
                  head_sha: SHA,
                  created_at: "2026-08-09T03:36:20Z",
                },
              ],
            }
          },
        }
      },
      async readReleaseInventory() {
        return {}
      },
      assertValidReleaseInventory() {
        assert.fail("pre-controller exact-version audit is not managed discovery")
      },
      validateReleaseInventory() {
        return {
          packages: ["@dawn-ai/sdk"],
          version: "0.8.21",
          structuralErrors: [],
          workspaceDuplicates: [],
          duplicates: [],
          privateMembers: [],
          unknownMembers: [],
          versionMismatches: [],
          extra: [],
          missing: ["@dawn-ai/sandbox"],
        }
      },
    },
  })

  assert.equal(code, 0)
  const report = JSON.parse(output)
  assert.equal(report.run.workflowRunId, 31292769511)
  assert.equal(report.run.runAttempt, 1)
  assert.equal(report.manualRecoveryInputs.runAttempt, 1)
  assert.equal(report.source.requestedRef, SHA)
  assert.equal(report.source.selectedRef, SHA)
  assert.equal(report.source.resolvedCommitSha, SHA)
})

test("CLI rejects duplicate, unknown, unpaired, and unsafe arguments without stacks", async () => {
  const cases = [
    ["--format", "json", "--format", "markdown"],
    ["--unknown", "value"],
    ["--version", "0.8.21", "--format", "json"],
    ["--commit-sha", SHA, "--format", "json"],
    ["--repository", "../owner/repo", "--format", "json"],
    ["--observation", "../escape.json", "--format", "json"],
    ["--observation", FIXTURE, "--format", "yaml"],
  ]
  for (const argv of cases) {
    let stderr = ""
    const code = await runShadowReconcile({
      argv,
      env: {},
      stdout: { write: assert.fail },
      stderr: {
        write(value) {
          stderr += value
        },
      },
      dependencies: {},
    })
    assert.equal(code, 2, argv.join(" "))
    assert.ok(stderr.endsWith("\n"))
    assert.doesNotMatch(stderr, /\n\s+at |Error:/u)
  }
})

function candidate() {
  return {
    version: "0.8.21",
    commitSha: SHA,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
}

function releaseInventory(version) {
  return {
    status: "valid",
    packages: ["@dawn-ai/a", "@dawn-ai/b"].map((name) => ({ name, version })),
  }
}

function managedInventory() {
  return {
    status: "valid",
    manifestSha256: "e".repeat(64),
    requiredSmokeLanes: [],
    packages: ["@dawn-ai/a", "@dawn-ai/b"].map((name, index) => ({
      name,
      version: "0.8.21",
      filename: `dawn-ai-${name.endsWith("a") ? "a" : "b"}-0.8.21.tgz`,
      tarballSha256: String(index + 1).repeat(64),
      attestationFilename: `dawn-ai-${name.endsWith("a") ? "a" : "b"}-0.8.21.tgz.intoto.jsonl`,
      attestationSha256: String(index + 3).repeat(64),
      integrity: `sha512-${name.endsWith("a") ? "a" : "b"}`,
    })),
  }
}

function ambiguousGitHub(calls) {
  const ambiguous = (operation) => ({
    status: "AMBIGUOUS",
    operation,
    httpStatus: 503,
    code: "SERVER_ERROR",
  })
  return {
    async getCommitCheckRuns(input) {
      calls.push(["github.getCommitCheckRuns", input])
      return ambiguous("commit-check-runs")
    },
    async listWorkflowRuns(input) {
      calls.push(["github.listWorkflowRuns", input])
      return ambiguous("workflow-runs")
    },
    async getRef(input) {
      calls.push(["github.getRef", input])
      return ambiguous("ref")
    },
    async getReleaseByTag(input) {
      calls.push(["github.getReleaseByTag", input])
      return ambiguous("release")
    },
    async listActionsArtifacts(input) {
      calls.push(["github.listActionsArtifacts", input])
      return ambiguous("actions-artifacts")
    },
  }
}

function absentGitHub() {
  return {
    async getCommitCheckRuns() {
      return {
        status: "PRESENT",
        operation: "commit-check-runs",
        httpStatus: 200,
        code: null,
        value: [
          {
            name: "validate",
            status: "completed",
            conclusion: "success",
            head_sha: SHA,
            check_suite: { id: 501 },
          },
        ],
      }
    },
    async listWorkflowRuns() {
      return presentEnvelope("workflow-runs", [
        {
          id: 101,
          run_attempt: 1,
          name: "CI",
          path: ".github/workflows/ci.yml",
          head_sha: SHA,
          status: "completed",
          conclusion: "success",
          check_suite_id: 501,
        },
      ])
    },
    async getRef() {
      return { status: "ABSENT", operation: "ref", httpStatus: 404, code: "NOT_FOUND" }
    },
    async getReleaseByTag() {
      return { status: "ABSENT", operation: "release", httpStatus: 404, code: "NOT_FOUND" }
    },
    async listActionsArtifacts() {
      return {
        status: "PRESENT",
        operation: "actions-artifacts",
        httpStatus: 200,
        code: null,
        value: [],
      }
    },
  }
}

function historicalPresentPackage(name, version) {
  return {
    status: "PRESENT",
    operation: "package-version",
    httpStatus: 200,
    code: null,
    package: {
      name,
      version,
      shasum: "a".repeat(40),
      integrity: `sha512-${"A".repeat(86)}==`,
      signatures: [{ keyid: "key", sig: "signature" }],
      latest: version,
      provenance: {
        status: "PRESENT",
        workflow: ".github/workflows/release.yml",
        commitSha: SHA,
      },
    },
  }
}

function currentMainDependencies({ scenario, calls }) {
  return {
    createGitReader() {
      return {
        async listFirstParentHistory({ ref }) {
          calls.push(["resolve", ref])
          if (ref === "origin/main" && scenario.missingOrigin) {
            throw Object.assign(new Error("origin/main was not found"), {
              code: "REF_NOT_FOUND",
            })
          }
          return [scenario.resolvedCommitSha]
        },
      }
    },
    createNpmReader() {
      return {}
    },
    createGitHubReader() {
      return {}
    },
    async readReleaseInventory() {
      return {}
    },
    assertValidReleaseInventory() {
      return { packages: ["@dawn-ai/sdk"], version: "0.8.21" }
    },
    async discoverShadowCandidate({ ref }) {
      calls.push(["discover", ref])
      return null
    },
  }
}

function presentEnvelope(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function ambiguousEnvelope(operation) {
  return { status: "AMBIGUOUS", operation, httpStatus: 503, code: "SERVER_ERROR" }
}

function expectedReleaseAssets(inventory) {
  return [
    { name: "release-record.json", sha256: inventory.releaseRecordSha256 },
    { name: "manifest.json", sha256: inventory.manifestSha256 },
    { name: "manifest.json.intoto.jsonl", sha256: inventory.manifestAttestationSha256 },
    ...inventory.packages.map((pkg) => ({ name: pkg.filename, sha256: pkg.tarballSha256 })),
    ...inventory.packages.map((pkg) => ({
      name: pkg.attestationFilename,
      sha256: pkg.attestationSha256,
    })),
  ]
}

function withoutFields(value, fields) {
  const copy = structuredClone(value)
  for (const field of fields) delete copy[field]
  return copy
}
