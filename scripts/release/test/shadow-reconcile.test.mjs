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

test("present npm evidence maps exact identity without converting failures to absence", async () => {
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

  assert.ok(result.observation.registry.packages.every((pkg) => pkg.status === "present"))
  assert.ok(result.observation.registry.packages.every((pkg) => pkg.signature.status === "valid"))
  assert.ok(result.observation.registry.packages.every((pkg) => pkg.tarballSha256 !== null))
  assert.deepEqual(result.diagnostics, [])
  const plan = planRelease({
    candidate: candidate(),
    observation: result.observation,
    mode: "shadow",
  })
  assert.equal(plan.state, "NPM_COMPLETE")
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
  assert.ok(result.diagnostics.every((item) => item.code === "NPM_BYTES_MISMATCH"))
  const plan = planRelease({
    candidate: candidate(),
    observation: result.observation,
    mode: "shadow",
  })
  assert.notEqual(plan.state, "NPM_COMPLETE")
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
      validateReleaseInventory() {
        return {
          packages: ["@dawn-ai/sdk"],
          version: "0.8.21",
          structuralErrors: [],
          versionMismatches: [],
          missing: [],
          extra: [],
        }
      },
    },
  })

  assert.equal(code, 0)
  const report = JSON.parse(output)
  assert.equal(report.run.workflowRunId, 31292769511)
  assert.equal(report.run.runAttempt, 1)
  assert.equal(report.manualRecoveryInputs.runAttempt, 1)
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
        value: [{ name: "validate", status: "completed", conclusion: "success" }],
      }
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
