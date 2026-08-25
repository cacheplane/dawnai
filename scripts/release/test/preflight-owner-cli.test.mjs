import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import {
  captureOwnerEvidence,
  OWNER_PREFLIGHT_FILES,
  parseOwnerEvidence,
} from "../preflight-owner.mjs"
import { runOwnerPreflightCli } from "../preflight-owner-cli.mjs"

const SHA = "0123456789abcdef0123456789abcdef01234567"
const NOW = Date.parse("2026-08-25T12:00:00Z")

test("capture writes one canonical short-lived owner evidence file", async (t) => {
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

  assert.equal(exitCode, 0)
  assert.equal(stderr.value, "")
  assert.match(stdout.value, /captured/iu)
  const evidence = parseOwnerEvidence(await readFile(output))
  assert.equal(evidence.phase, "pre-enable")
  assert.equal(evidence.packages.length, 21)

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
})

test("verify performs no command execution and strictly checks explicit HEAD and evidence", async (t) => {
  const fixture = await workspaceFixture(t)
  const evidence = await captureOwnerEvidence({
    phase: "pre-enable",
    repository: "cacheplane/dawnai",
    packageNames: CANONICAL_RELEASE_PACKAGE_ORDER,
    ...fixture.adapters,
    now: () => NOW,
  })
  const evidencePath = path.join(fixture.root, "evidence.json")
  await writeFile(evidencePath, `${JSON.stringify(canonicalize(evidence))}\n`)
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

  assert.equal(exitCode, 0)
  assert.equal(commands, 0)
  assert.equal(JSON.parse(stdout.value).status, "PASS")

  assert.equal(
    await runOwnerPreflightCli({
      argv: [
        "verify",
        "--phase",
        "post-enable",
        "--evidence",
        evidencePath,
        "--head-sha",
        SHA,
        "--strict",
      ],
      cwd: fixture.root,
      environment: {},
      stdout: sink(),
      stderr: sink(),
      dependencies: { now: () => NOW + 1 },
    }),
    1,
    "the requested phase must match the captured phase",
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
  for (const [index, filePath] of OWNER_PREFLIGHT_FILES.entries()) {
    const target = path.join(root, filePath)
    await mkdir(path.dirname(target), { recursive: true })
    const source =
      filePath === "scripts/release/controller-schema.json"
        ? `${JSON.stringify({
            schemaVersion: 1,
            publishingOwner: "release-controller",
            epoch: "fixed-group-v1",
            npmTrustedPublisherEnvironment: null,
            abandonmentEnvironment: "release-abandonment",
          })}\n`
        : `name: fixture-${index}\n`
    await writeFile(target, source)
    bytes.set(filePath, Buffer.from(source))
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
        return {
          status: "present",
          value: {
            id: `trust-${name}`,
            type: "github",
            file: "release.yml",
            repository: "cacheplane/dawnai",
            permissions: ["createPackage"],
          },
        }
      },
    },
    github: {
      async version() {
        return "2.95.0"
      },
      async getRepository() {
        return {
          status: "present",
          httpStatus: 200,
          value: {
            id: 1,
            full_name: "cacheplane/dawnai",
            default_branch: "main",
            permissions: { admin: true },
          },
        }
      },
      async getWorkflow(filePath) {
        return {
          status: "present",
          httpStatus: 200,
          value: {
            id: OWNER_PREFLIGHT_FILES.indexOf(filePath) + 1,
            path: filePath,
            state: ["release.yml", "publish-chart.yml"].some((name) => filePath.endsWith(name))
              ? "disabled_manually"
              : "active",
          },
        }
      },
      async getEnvironment(name) {
        return {
          status: "present",
          httpStatus: 200,
          value: {
            name,
            protection_rules: [
              {
                type: "required_reviewers",
                prevent_self_review: true,
                reviewers: [{ type: "Team", reviewer: { slug: "release-owners" } }],
              },
            ],
          },
        }
      },
      async getImmutableReleases() {
        return {
          status: "present",
          httpStatus: 200,
          value: { enabled: false, enforced_by_owner: false },
        }
      },
    },
  }
  return { root, adapters }
}

function sink() {
  return {
    value: "",
    write(value) {
      this.value += value
    },
  }
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
