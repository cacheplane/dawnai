import assert from "node:assert/strict"
import test from "node:test"

import {
  collectReleasePreflight,
  renderPreflightReport,
  runReleasePreflight,
} from "../preflight.mjs"

const VERSION = "0.8.21"
const SHA = "341678ea7932832ec860bdd915371669440bef7c"
const PACKAGES = ["@dawn-ai/core", "@dawn-ai/sdk"]
const WORKFLOW_PATH = ".github/workflows/release.yml"
const WORKFLOW_SOURCE = `
name: Release
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  release:
    permissions:
      contents: write
      pull-requests: write
      id-token: write
      attestations: write
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
      - name: Validate Release Candidate
        run: pnpm ci:validate
      - name: Create Release Pull Request or Publish
        uses: changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d
        with:
          publish: pnpm release:publish
`

test("preflight exposes the collector and deterministic report renderer", async () => {
  const module = await import("../preflight.mjs")

  assert.equal(typeof module.collectReleasePreflight, "function")
  assert.equal(typeof module.renderPreflightReport, "function")
})

test("preflight proves observable release prerequisites and preserves unprovable trust boundaries", async () => {
  const calls = []
  const report = await collectReleasePreflight({
    inventory: { packages: PACKAGES, version: VERSION },
    workflowSource: WORKFLOW_SOURCE,
    npm: npmReader(calls),
    github: githubReader(calls),
  })

  assert.equal(report.schemaVersion, 1)
  assert.equal(report.status, "UNPROVABLE")
  assert.deepEqual(
    report.checks.map(({ id }) => id),
    [...report.checks.map(({ id }) => id)].sort(),
  )
  assert.equal(check(report, "inventory").status, "PASS")
  assert.equal(check(report, "workflow-static-permissions").status, "PASS")
  assert.equal(check(report, "workflow-required-validation").status, "PASS")
  assert.equal(check(report, "npm-current-provenance").status, "PASS")
  assert.equal(check(report, "github-workflow-active").status, "PASS")
  assert.equal(check(report, "github-actions-permissions").status, "PASS")
  assert.equal(check(report, "github-default-workflow-permissions").status, "PASS")
  assert.equal(check(report, "github-environments").status, "WARN")
  assert.equal(check(report, "github-required-validate").status, "PASS")
  assert.equal(check(report, "npm-trusted-publisher").status, "UNPROVABLE")
  assert.equal(check(report, "future-write-oidc").status, "UNPROVABLE")
  assert.ok(Object.isFrozen(report))
  assert.ok(Object.isFrozen(report.checks))
  assert.deepEqual(
    calls.filter(([name]) => name === "npm.observePackageVersion"),
    PACKAGES.map((name) => ["npm.observePackageVersion", { name, version: VERSION }]),
  )
  assert.deepEqual(
    calls.filter(([name]) => name.startsWith("github.")),
    [
      ["github.getWorkflow", { workflow: "release.yml" }],
      ["github.getActionsPermissions", undefined],
      ["github.getWorkflowPermissions", undefined],
      ["github.listEnvironments", undefined],
      ["github.getBranchProtection", { branch: "main" }],
    ],
  )
})

test("preflight fails closed on malformed static policy and exact public evidence conflicts", async () => {
  const npm = npmReader([])
  npm.observePackageVersion = async ({ name, version }) =>
    present("package-version", "package", {
      ...publishedPackage(name, version),
      provenance: {
        status: "PRESENT",
        workflow: ".github/workflows/other.yml",
        commitSha: SHA,
      },
    })
  const github = githubReader([])
  github.getWorkflow = async () =>
    present("workflow", "value", { path: WORKFLOW_PATH, state: "disabled_manually" })
  github.getBranchProtection = async () =>
    present("branch-protection", "value", { required_status_checks: { contexts: [] } })

  const report = await collectReleasePreflight({
    inventory: { packages: PACKAGES, version: VERSION },
    workflowSource: "name: Release\njobs: {}\n",
    npm,
    github,
  })

  assert.equal(report.status, "FAIL")
  assert.equal(check(report, "workflow-static-permissions").status, "FAIL")
  assert.equal(check(report, "workflow-required-validation").status, "FAIL")
  assert.equal(check(report, "npm-current-provenance").status, "FAIL")
  assert.equal(check(report, "github-workflow-active").status, "FAIL")
  assert.equal(check(report, "github-required-validate").status, "FAIL")
})

test("preflight reports remote ambiguity as unprovable without promoting 404 or auth failures", async () => {
  const ambiguous = (operation, httpStatus, code) => ({
    status: "AMBIGUOUS",
    operation,
    httpStatus,
    code,
  })
  const github = {
    getWorkflow: async () => ambiguous("workflow", 404, "NOT_FOUND_OR_HIDDEN"),
    getActionsPermissions: async () => ambiguous("actions-permissions", 403, "FORBIDDEN"),
    getWorkflowPermissions: async () => ambiguous("workflow-permissions", 403, "FORBIDDEN"),
    listEnvironments: async () => ambiguous("environments", 403, "FORBIDDEN"),
    getBranchProtection: async () => ambiguous("branch-protection", 404, "NOT_FOUND_OR_HIDDEN"),
  }
  const npm = {
    observePackageVersion: async () => ambiguous("package-version", 429, "ERATELIMIT"),
  }

  const report = await collectReleasePreflight({
    inventory: { packages: PACKAGES, version: VERSION },
    workflowSource: WORKFLOW_SOURCE,
    npm,
    github,
  })

  for (const id of [
    "npm-current-provenance",
    "github-workflow-active",
    "github-actions-permissions",
    "github-default-workflow-permissions",
    "github-environments",
    "github-required-validate",
  ]) {
    assert.equal(check(report, id).status, "UNPROVABLE", id)
  }
})

test("preflight rendering is canonical, secret-safe, and distinguishes all four statuses", async () => {
  const report = {
    schemaVersion: 1,
    status: "FAIL",
    checks: [
      { id: "warn", status: "WARN", summary: "selected actions only" },
      { id: "pass", status: "PASS", summary: "active" },
      { id: "fail", status: "FAIL", summary: "Authorization: Bearer ghp_abcdef123456" },
      { id: "unknown", status: "UNPROVABLE", summary: "token=npm_abcdef123456" },
    ],
  }

  const jsonA = renderPreflightReport(report, { format: "json" })
  const jsonB = renderPreflightReport(structuredClone(report), { format: "json" })
  const markdown = renderPreflightReport(report, { format: "markdown" })

  assert.equal(jsonA, jsonB)
  assert.ok(jsonA.endsWith("\n"))
  assert.match(markdown, /^# Release Preflight Report\n/u)
  for (const status of ["PASS", "FAIL", "WARN", "UNPROVABLE"]) {
    assert.match(`${jsonA}\n${markdown}`, new RegExp(status, "u"))
  }
  assert.doesNotMatch(`${jsonA}\n${markdown}`, /ghp_|npm_|Bearer|Authorization/iu)
  assert.throws(
    () => renderPreflightReport({ ...report, status: "PASS" }, { format: "json" }),
    /Invalid preflight report/u,
  )
})

test("preflight CLI may audit an exact historical version without changing inventory membership", async () => {
  const observedVersions = []
  const code = await runReleasePreflight({
    argv: ["--version", "0.8.20", "--format", "json"],
    env: {},
    cwd: "/workspace",
    stdout: { write() {} },
    stderr: { write: assert.fail },
    dependencies: {
      readWorkflowSource: async () => WORKFLOW_SOURCE,
      readReleaseInventory: async () => ({}),
      assertValidReleaseInventory: () => ({ packages: PACKAGES, version: VERSION }),
      createNpmReader() {
        return {
          async observePackageVersion({ name, version }) {
            observedVersions.push(version)
            return present("package-version", "package", publishedPackage(name, version))
          },
        }
      },
      createGitHubReader: () => githubReader([]),
    },
  })

  assert.equal(code, 0)
  assert.deepEqual(observedVersions, ["0.8.20", "0.8.20"])
})

test("preflight CLI validates strict arguments, isolates the GitHub token, and fails strict on unprovable checks", async () => {
  let stdout = ""
  let stderr = ""
  let githubOptions
  const code = await runReleasePreflight({
    argv: [
      "--repository",
      "cacheplane/dawnai",
      "--workflow",
      WORKFLOW_PATH,
      "--version",
      VERSION,
      "--format",
      "json",
      "--strict",
    ],
    env: { GITHUB_TOKEN: "ghp_must_not_escape" },
    cwd: "/workspace",
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
    dependencies: {
      async readWorkflowSource(path) {
        assert.equal(path, "/workspace/.github/workflows/release.yml")
        return WORKFLOW_SOURCE
      },
      async readReleaseInventory() {
        return {}
      },
      assertValidReleaseInventory() {
        return { packages: PACKAGES, version: VERSION }
      },
      createNpmReader() {
        return npmReader([])
      },
      createGitHubReader(options) {
        githubOptions = options
        return githubReader([])
      },
    },
  })

  assert.equal(code, 1)
  assert.equal(stderr, "")
  assert.equal(githubOptions.token, "ghp_must_not_escape")
  assert.doesNotMatch(stdout, /ghp_must_not_escape|authorization|bearer/iu)

  let invalidError = ""
  const invalidCode = await runReleasePreflight({
    argv: ["--repository", "cacheplane/dawnai", "--workflow", "../release.yml", "--format", "json"],
    env: {},
    cwd: "/workspace",
    stdout: { write: assert.fail },
    stderr: { write: (value) => (invalidError += value) },
  })
  assert.equal(invalidCode, 2)
  assert.ok(invalidError.endsWith("\n"))
  assert.doesNotMatch(invalidError, /\.\.\/release|\n\s+at /u)
})

function check(report, id) {
  const value = report.checks.find((item) => item.id === id)
  assert.notEqual(value, undefined, id)
  return value
}

function npmReader(calls) {
  return {
    async observePackageVersion(input) {
      calls.push(["npm.observePackageVersion", input])
      return present("package-version", "package", publishedPackage(input.name, input.version))
    },
  }
}

function githubReader(calls) {
  return {
    async getWorkflow(input) {
      calls.push(["github.getWorkflow", input])
      return present("workflow", "value", { path: WORKFLOW_PATH, state: "active" })
    },
    async getActionsPermissions(input) {
      calls.push(["github.getActionsPermissions", input])
      return present("actions-permissions", "value", { enabled_actions: "all" })
    },
    async getWorkflowPermissions(input) {
      calls.push(["github.getWorkflowPermissions", input])
      return present("workflow-permissions", "value", {
        default_workflow_permissions: "read",
        can_approve_pull_request_reviews: false,
      })
    },
    async listEnvironments(input) {
      calls.push(["github.listEnvironments", input])
      return present("environments", "value", [])
    },
    async getBranchProtection(input) {
      calls.push(["github.getBranchProtection", input])
      return present("branch-protection", "value", {
        required_status_checks: { strict: true, contexts: ["validate"], checks: [] },
      })
    },
  }
}

function publishedPackage(name, version) {
  return {
    name,
    version,
    tarballUrl: `https://registry.npmjs.org/${name}/-/${version}.tgz`,
    shasum: "a".repeat(40),
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    signatures: [{ keyid: "key", sig: "signature" }],
    distTags: { latest: version },
    latest: version,
    provenance: {
      status: "PRESENT",
      workflow: WORKFLOW_PATH,
      commitSha: SHA,
    },
  }
}

function present(operation, payloadKey, payload) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, [payloadKey]: payload }
}
