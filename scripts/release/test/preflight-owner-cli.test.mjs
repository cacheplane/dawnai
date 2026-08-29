import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import {
  canonicalOwnerEvidenceBytes,
  captureOwnerEvidence,
  OWNER_PREFLIGHT_FILES,
  parseOwnerEvidence,
} from "../preflight-owner.mjs"
import { runOwnerPreflightCli } from "../preflight-owner-cli.mjs"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const REPOSITORY = "cacheplane/dawnai"
const SHA = "0123456789abcdef0123456789abcdef01234567"
const OTHER_SHA = "1123456789abcdef0123456789abcdef01234567"
const BLOB_SHA = "2123456789abcdef0123456789abcdef01234567"
const NOW = Date.parse("2026-08-25T12:00:00Z")
const RELEASE_WORKFLOW = ".github/workflows/release.yml"
const POLICY_PATH = "scripts/release/abandonment-workflow-policy.json"
const EXPECTED_OWNER_FILES = [
  ".github/workflows/version-pr.yml",
  RELEASE_WORKFLOW,
  ".github/workflows/published-artifact-verify.yml",
  ".github/workflows/publish-chart.yml",
  "scripts/release/controller-schema.json",
  POLICY_PATH,
]
const WORKFLOW_PATHS = EXPECTED_OWNER_FILES.filter((filePath) => filePath.endsWith(".yml"))
const NONTERMINAL_STATUSES = ["in_progress", "pending", "queued", "requested", "waiting"]
const DISABLED_BYTES = await readFile(
  `${ROOT}/scripts/release/test/fixtures/release-workflow-disabled.yml`,
)
const POLICY_BYTES = await readFile(`${ROOT}/${POLICY_PATH}`)

test("capture writes one exclusive canonical v2 owner evidence file", async (t) => {
  const fixture = await workspaceFixture(t)
  const output = path.join(fixture.root, "evidence.json")
  const stdout = sink()
  const stderr = sink()
  const exitCode = await runOwnerPreflightCli({
    argv: ["capture", "--phase", "pre-enable", "--output", output],
    cwd: fixture.root,
    environment: {},
    stdout,
    stderr,
    dependencies: { adapters: fixture.adapters, now: () => NOW },
  })

  assert.equal(exitCode, 0, `${stderr.value}\n${stdout.value}`)
  assert.equal(stderr.value, "")
  assert.match(stdout.value, /captured/iu)
  const originalBytes = await readFile(output)
  const evidence = parseOwnerEvidence(originalBytes)
  assert.equal(evidence.schemaVersion, 2)
  assert.equal(evidence.phase, "pre-enable")
  assert.equal(evidence.packages.length, 21)
  assert.equal(evidence.github.abandonmentMode, "disabled")
  assert.equal(evidence.github.abandonmentEnvironment, null)
  assert.deepEqual(evidence.github.managedCandidateRefs, [])
  assert.deepEqual(evidence.github.nonterminalReleaseRuns, [])
  assert.deepEqual(OWNER_PREFLIGHT_FILES, EXPECTED_OWNER_FILES)

  assert.equal(
    await runOwnerPreflightCli({
      argv: ["capture", "--phase", "pre-enable", "--output", output],
      cwd: fixture.root,
      environment: {},
      stdout: sink(),
      stderr: sink(),
      dependencies: { adapters: fixture.adapters, now: () => NOW },
    }),
    1,
    "capture may not overwrite owner evidence",
  )
  assert.deepEqual(await readFile(output), originalBytes)
})

test("capture structural and local-policy failures leave no output file", async (t) => {
  const structural = await workspaceFixture(t)
  structural.github.getDefaultBranchRef = async () => ({
    status: "unavailable",
    httpStatus: null,
    value: null,
  })
  const structuralOutput = path.join(structural.root, "structural.json")
  assert.equal(
    await runOwnerPreflightCli({
      argv: ["capture", "--phase", "pre-enable", "--output", structuralOutput],
      cwd: structural.root,
      environment: {},
      stdout: sink(),
      stderr: sink(),
      dependencies: { adapters: structural.adapters, now: () => NOW },
    }),
    1,
  )
  await assert.rejects(() => readFile(structuralOutput), { code: "ENOENT" })

  const invalidWorkflow = await workspaceFixture(t)
  invalidWorkflow.bytes.set(RELEASE_WORKFLOW, Buffer.from("name: Release\n"))
  const invalidOutput = path.join(invalidWorkflow.root, "invalid.json")
  assert.equal(
    await runOwnerPreflightCli({
      argv: ["capture", "--phase", "pre-enable", "--output", invalidOutput],
      cwd: invalidWorkflow.root,
      environment: {},
      stdout: sink(),
      stderr: sink(),
      dependencies: { adapters: invalidWorkflow.adapters, now: () => NOW },
    }),
    1,
  )
  await assert.rejects(() => readFile(invalidOutput), { code: "ENOENT" })
})

test("verify performs no command execution and strictly checks phase, HEAD, and all six files", async (t) => {
  const fixture = await workspaceFixture(t)
  const evidence = await captureOwnerEvidence({
    phase: "pre-enable",
    repository: REPOSITORY,
    packageNames: CANONICAL_RELEASE_PACKAGE_ORDER,
    ...fixture.adapters,
    now: () => NOW,
  })
  const evidencePath = path.join(fixture.root, "evidence.json")
  await writeFile(evidencePath, canonicalOwnerEvidenceBytes(evidence))
  let commands = 0
  const stdout = sink()
  const exitCode = await runOwnerPreflightCli({
    argv: [
      "verify",
      "--phase",
      "pre-enable",
      "--evidence",
      evidencePath,
      "--head-sha",
      SHA,
      "--format",
      "json",
      "--strict",
    ],
    cwd: fixture.root,
    environment: {},
    stdout,
    stderr: sink(),
    dependencies: {
      run() {
        commands += 1
        assert.fail("owner evidence verification must not shell out")
      },
      now: () => NOW + 1,
    },
  })

  assert.equal(exitCode, 0, stdout.value)
  assert.equal(commands, 0)
  assert.equal(JSON.parse(stdout.value).status, "PASS")

  assert.equal(
    await verifyCli(fixture.root, evidencePath, {
      phase: "post-enable",
      headSha: SHA,
    }),
    1,
    "the requested phase must match the captured phase",
  )
  assert.equal(
    await verifyCli(fixture.root, evidencePath, {
      phase: "pre-enable",
      headSha: OTHER_SHA,
    }),
    1,
    "strict verification must reject another HEAD",
  )

  await writeFile(path.join(fixture.root, POLICY_PATH), Buffer.from("{}\n"))
  assert.equal(
    await verifyCli(fixture.root, evidencePath, {
      phase: "pre-enable",
      headSha: SHA,
    }),
    1,
    "strict verification must bind the production policy file",
  )
})

test("owner CLI rejects unknown, duplicate, missing, and implicit verification inputs", async () => {
  for (const argv of [
    [],
    ["capture", "--phase", "pre-enable"],
    ["verify", "--phase", "pre-enable", "--evidence", "evidence.json"],
    ["verify", "--phase", "pre-enable", "--phase", "post-enable"],
    ["verify", "--unknown", "value"],
  ]) {
    assert.equal(
      await runOwnerPreflightCli({
        argv,
        cwd: "/workspace",
        environment: {},
        stdout: sink(),
        stderr: sink(),
      }),
      2,
    )
  }
})

async function workspaceFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "dawn-owner-preflight-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = new Map()
  for (const [index, filePath] of EXPECTED_OWNER_FILES.entries()) {
    const target = path.join(root, filePath)
    await mkdir(path.dirname(target), { recursive: true })
    let source
    if (filePath === "scripts/release/controller-schema.json") {
      source = Buffer.from(
        `${JSON.stringify({
          schemaVersion: 1,
          publishingOwner: "release-controller",
          epoch: "fixed-group-v1",
          npmTrustedPublisherEnvironment: null,
          abandonmentEnvironment: "release-abandonment",
        })}\n`,
      )
    } else if (filePath === RELEASE_WORKFLOW) {
      source = Buffer.from(DISABLED_BYTES)
    } else if (filePath === POLICY_PATH) {
      source = Buffer.from(POLICY_BYTES)
    } else {
      source = Buffer.from(`name: fixture-${index}\n`)
    }
    await writeFile(target, source)
    bytes.set(filePath, source)
  }

  const github = {
    async version() {
      return "2.95.0"
    },
    async getRepository() {
      return present({
        id: 1,
        full_name: REPOSITORY,
        default_branch: "main",
        permissions: { admin: true },
      })
    },
    async getWorkflow(filePath) {
      return present({
        id: WORKFLOW_PATHS.indexOf(filePath) + 1,
        path: filePath,
        state: [RELEASE_WORKFLOW, ".github/workflows/publish-chart.yml"].includes(filePath)
          ? "disabled_manually"
          : "active",
      })
    },
    async getDefaultBranchRef() {
      return present({
        ref: "refs/heads/main",
        object: { type: "commit", sha: SHA },
      })
    },
    async getWorkflowContent(_repository, _workflowPath, commitSha) {
      assert.equal(commitSha, SHA)
      return present({
        path: RELEASE_WORKFLOW,
        sha: BLOB_SHA,
        contentBase64: bytes.get(RELEASE_WORKFLOW).toString("base64"),
      })
    },
    async listManagedCandidateRefs() {
      return present([])
    },
    async getAnnotatedTag() {
      assert.fail("zero managed refs must not read an annotated tag")
    },
    async listReleaseRuns(_repository, workflowPath, status) {
      assert.equal(workflowPath, RELEASE_WORKFLOW)
      assert.ok(NONTERMINAL_STATUSES.includes(status))
      return present([])
    },
    async getEnvironment() {
      assert.fail("disabled capture must not read the environment")
    },
    async getImmutableReleases() {
      return present({ enabled: false, enforced_by_owner: false })
    },
  }
  const adapters = {
    files: {
      async read(filePath) {
        return bytes.get(filePath)
      },
    },
    git: {
      async headSha() {
        return SHA
      },
    },
    npm: {
      async version() {
        return "11.17.0"
      },
      async trustList(name) {
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
  }
  return { root, bytes, github, adapters }
}

async function verifyCli(root, evidencePath, { phase, headSha }) {
  return runOwnerPreflightCli({
    argv: [
      "verify",
      "--phase",
      phase,
      "--evidence",
      evidencePath,
      "--head-sha",
      headSha,
      "--strict",
    ],
    cwd: root,
    environment: {},
    stdout: sink(),
    stderr: sink(),
    dependencies: { now: () => NOW + 1 },
  })
}

function present(value) {
  return { status: "present", httpStatus: 200, value }
}

function sink() {
  return {
    value: "",
    write(value) {
      this.value += value
    },
  }
}
