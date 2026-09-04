#!/usr/bin/env node

import { createHash, randomUUID as defaultRandomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  assertInstalledCoreResolution,
  makeTempDir,
  publicNpmEnvironment,
  readBoundedRegularFile,
  removeDir,
} from "../../lib/published-artifacts.mjs"
import { runTypeScriptToolingProbe } from "../../lib/typescript-tooling-probe.mjs"
import {
  installTypeScriptTooling,
  runAgUiInstalledProbe,
  runDockerSandboxInstalledProbe,
  TYPESCRIPT_VERSION,
} from "../../published-artifact-smoke.mjs"
import { snapshotJson } from "../adapter-normalize.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import {
  CANONICAL_RELEASE_PACKAGE_ORDER,
  canonicalManifestBytes,
  parseSealedReleaseManifest,
} from "../manifest.mjs"
import { parseNpmAuditSignatures as parseVerifiedNpmAuditSignatures } from "../npm-audit.mjs"
import {
  createStrictSmokeProcessRunner,
  pickStrictSmokeCommandOptions,
  strictContainmentReceiptDetail,
} from "../smoke-process-runner.mjs"
import { executeSmokeLane, parseSmokeLaneArgs } from "../smoke-result.mjs"
import { dockerUuidToken, removeAndVerifyDockerResource } from "./docker-identity.mjs"

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024
const AUDIT_OUTPUT_BYTES = 2 * 1024 * 1024

export async function runPublishedHarnessSmoke(options, overrides = {}) {
  if (overrides.runCommand !== undefined || overrides.probeContainment !== undefined) {
    throw new TypeError("Published-harness smoke command execution requires a strictRunner")
  }
  const strictRunner = overrides.strictRunner ?? createStrictSmokeProcessRunner()
  const runCommand = (command, args, runOptions) =>
    strictRunner.runCommand(command, args, productionCommandOptions(runOptions))
  const dependencies = {
    makeTempDir,
    randomUUID: defaultRandomUUID,
    readManifest: defaultReadManifest,
    removeDir,
    runHarnessAssertion: (root, lane, version) =>
      defaultRunHarnessAssertion(root, lane, version, runCommand),
    ...overrides,
    cleanupDockerProbe: (identity) => cleanupDockerSandboxResources(identity, { runCommand }),
    probeContainment: strictRunner.probe,
    runCommand,
  }
  dependencies.runAgUiProbe ??= (root) =>
    runAgUiInstalledProbe(root, { runCommand: dependencies.runCommand })
  dependencies.runDockerProbe ??= (root, identity) =>
    runDockerSandboxInstalledProbe(root, {
      runCommand: dependencies.runCommand,
      threadId: identity.threadId,
    })
  dependencies.runTypeScriptProbe ??= (root) =>
    runInstalledTypeScriptProbe(root, dependencies.runCommand, options.version)
  const dockerIdentity = publishedDockerProbeIdentity(dependencies.randomUUID)

  return executeSmokeLane(
    { lane: "published-harness", ...options },
    async ({ check, deferCleanup }) => {
      await check(
        "containment",
        strictContainmentReceiptDetail(dependencies.env),
        dependencies.probeContainment,
      )
      const manifest = await check(
        "manifest",
        "canonical sealed manifest matched the exact release candidate",
        () => dependencies.readManifest(options),
      )
      const root = await check(
        "temporary-project",
        "clean published harness consumer created",
        () => dependencies.makeTempDir("dawn-published-harness-"),
      )
      deferCleanup("cleanup", "published harness consumer removed", () =>
        dependencies.removeDir(root),
      )
      deferCleanup("cleanup-docker-probe", "installed Docker probe resources removed", () =>
        dependencies.cleanupDockerProbe(dockerIdentity),
      )

      await check(
        "exact-install",
        "exact fixed-group packages installed from public npm",
        async () => {
          await dependencies.runCommand("npm", ["init", "-y"], { cwd: root })
          await dependencies.runCommand(
            "npm",
            [
              "install",
              "--ignore-scripts",
              "--save-exact",
              ...CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => `${name}@${options.version}`),
            ],
            { cwd: root },
          )
        },
      )
      await check(
        "npm-signatures",
        "official npm CLI verified exact registry signatures and provenance attestations",
        async () => {
          const audit = await dependencies.runCommand(
            "npm",
            ["audit", "signatures", "--json", "--include-attestations"],
            {
              cwd: root,
              maxOutputBytes: AUDIT_OUTPUT_BYTES,
              acceptedExitCodes: [0, 1],
            },
          )
          validateNpmAuditSignatures(audit.stdout, {
            version: options.version,
            requiredPackages: CANONICAL_RELEASE_PACKAGE_ORDER,
            candidate: {
              version: options.version,
              commitSha: options.commitSha,
              publisherWorkflow: ".github/workflows/release.yml",
            },
            manifest,
          })
        },
      )
      await check("ag-ui", "installed AG-UI ESM and TypeScript probes passed", () =>
        dependencies.runAgUiProbe(root),
      )
      await check("typescript-tooling", "installed TypeScript tooling probe passed", () =>
        dependencies.runTypeScriptProbe(root),
      )
      await check("docker-pid-recovery", "installed Docker PID recovery probe passed", () =>
        dependencies.runDockerProbe(root, dockerIdentity),
      )
      for (const lane of ["framework", "runtime", "smoke"]) {
        await check(`${lane}-assertions`, `${lane} installed-package assertions passed`, () =>
          dependencies.runHarnessAssertion(root, lane, options.version),
        )
      }
    },
    overrides,
  )
}

export function publishedDockerProbeIdentity(randomUUID = defaultRandomUUID) {
  const token = dockerUuidToken(randomUUID, "Published Docker probe")
  const threadId = `published-uuid-${token}`
  return Object.freeze({
    threadId,
    containerName: `dawn-sbx-${threadId}`,
    volumeName: `dawn-sbx-vol-${threadId}`,
  })
}

export async function cleanupDockerSandboxResources(identity, { runCommand } = {}) {
  assertDockerProbeIdentity(identity)
  if (typeof runCommand !== "function") {
    throw new TypeError("Published Docker cleanup requires a strict runner")
  }
  const errors = []
  for (const resource of [
    { kind: "container", name: identity.containerName },
    { kind: "volume", name: identity.volumeName },
  ]) {
    try {
      await removeAndVerifyDockerResource({ ...resource, runCommand })
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, "Published Docker probe cleanup failed")
}

function assertDockerProbeIdentity(identity) {
  if (
    identity === null ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join(",") !== "containerName,threadId,volumeName" ||
    !/^published-uuid-[0-9a-f]{32}$/u.test(identity.threadId) ||
    identity.containerName !== `dawn-sbx-${identity.threadId}` ||
    identity.volumeName !== `dawn-sbx-vol-${identity.threadId}`
  ) {
    throw new TypeError("Published Docker probe identity is invalid")
  }
}

async function defaultReadManifest(options) {
  if (typeof options.manifest !== "string" || options.manifest.length === 0) {
    throw new Error("--manifest is required for the published harness smoke")
  }
  const bytes = await readBoundedRegularFile(
    options.manifest,
    RELEASE_PAYLOAD_LIMITS.manifestBytes,
    "Published harness manifest",
  )
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (digest !== options.manifestSha256) {
    throw new Error("Published harness manifest digest does not match --manifest-sha256")
  }
  const manifest = parseSealedReleaseManifest(bytes, {
    candidate: { version: options.version, commitSha: options.commitSha },
  })
  if (!bytes.equals(canonicalManifestBytes(manifest))) {
    throw new Error("Published harness manifest bytes must be canonical")
  }
  return manifest
}

async function runInstalledTypeScriptProbe(root, runCommand, version) {
  await installTypeScriptTooling(root, { runCommand })
  await assertInstalledCoreResolution({
    consumerRoot: root,
    expectedCoreVersion: version,
  })
  await runTypeScriptToolingProbe({
    expectedTypeScriptVersion: TYPESCRIPT_VERSION,
    root,
    runCommand,
  })
}

export function validateNpmAuditSignatures(output, options) {
  let context
  try {
    context = snapshotJson(options)
  } catch (error) {
    throw new Error("npm audit signature candidate or manifest context is malformed", {
      cause: error,
    })
  }
  if (
    context === null ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    Object.keys(context).sort().join(",") !== "candidate,manifest,requiredPackages,version" ||
    context.candidate === null ||
    typeof context.candidate !== "object" ||
    Array.isArray(context.candidate) ||
    Object.keys(context.candidate).sort().join(",") !== "commitSha,publisherWorkflow,version" ||
    context.candidate.version !== context.version ||
    context.candidate.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new Error("npm audit signature candidate or manifest context is malformed")
  }
  const requiredPackages = context.requiredPackages
  if (
    !Array.isArray(requiredPackages) ||
    requiredPackages.length === 0 ||
    requiredPackages.some((name) => typeof name !== "string" || name.length === 0)
  ) {
    throw new Error("Required npm audit package set is empty")
  }
  const required = new Set(requiredPackages)
  if (required.size !== requiredPackages.length)
    throw new Error("Required npm audit package set is duplicate")
  let manifest
  try {
    manifest = parseSealedReleaseManifest(canonicalManifestBytes(context.manifest), {
      candidate: context.candidate,
    })
  } catch (error) {
    throw new Error("npm audit signature manifest does not match the exact release candidate", {
      cause: error,
    })
  }
  if (manifest.version !== context.version) {
    throw new Error("npm audit signature manifest does not match the exact release version")
  }
  const entries = new Map(manifest.packages.map((entry) => [entry.name, entry]))
  const verified = []
  for (const name of requiredPackages) {
    const entry = entries.get(name)
    if (entry === undefined) {
      throw new Error(`Required npm audit package ${name} is absent from the release manifest`)
    }
    const result = parseVerifiedNpmAuditSignatures(output, {
      entry,
      candidate: context.candidate,
    })
    if (result.status !== "verified") {
      throw new Error(
        `npm audit signatures did not verify exact ${name}@${context.version} provenance`,
      )
    }
    verified.push(name)
  }
  return Object.freeze(verified.sort())
}

async function defaultRunHarnessAssertion(root, lane, version, runCommand) {
  const probePath = path.join(root, "published-harness.mjs")
  await writeFile(probePath, publishedHarnessProbeSource(), "utf8")
  await runCommand("node", [probePath, lane, version], { cwd: root })
}

export function publishedHarnessProbeSource() {
  return `import assert from "node:assert/strict"
import { agent, allow, defineMiddleware, reject } from "@dawn-ai/sdk"
import { discoverRoutes } from "@dawn-ai/core/node"
import { graphAdapter } from "@dawn-ai/langgraph"
import { createAimock } from "@dawn-ai/testing"
import { toAguiEvents } from "@dawn-ai/ag-ui"

const lane = process.argv[2]
const version = process.argv[3]
assert.match(version, /^\\d+\\.\\d+\\.\\d+/)
const surfaces = {
  framework: { agent, allow, defineMiddleware, reject },
  runtime: { discoverRoutes, graphAdapter },
  smoke: { createAimock, toAguiEvents },
}
assert.ok(surfaces[lane], "unknown harness lane")
for (const [name, value] of Object.entries(surfaces[lane])) {
  assert.equal(typeof value, "function", name + " must be a function")
}
`
}

function productionCommandOptions(options = {}) {
  return {
    ...pickStrictSmokeCommandOptions(options),
    env: publicNpmEnvironment({ home: options.cwd ?? process.cwd(), extra: options.env }),
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? COMMAND_OUTPUT_BYTES,
  }
}

async function main() {
  await runPublishedHarnessSmoke(parseSmokeLaneArgs(process.argv.slice(2)))
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    await main()
  } catch (error) {
    console.error(
      `PUBLISHED HARNESS SMOKE FAIL ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
