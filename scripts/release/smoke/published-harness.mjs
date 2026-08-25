#!/usr/bin/env node

import { writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  assertInstalledCoreResolution,
  makeTempDir,
  publicNpmEnvironment,
  removeDir,
  run,
} from "../../lib/published-artifacts.mjs"
import { runTypeScriptToolingProbe } from "../../lib/typescript-tooling-probe.mjs"
import {
  installTypeScriptTooling,
  runAgUiInstalledProbe,
  runDockerSandboxInstalledProbe,
  TYPESCRIPT_VERSION,
} from "../../published-artifact-smoke.mjs"
import { snapshotJson } from "../adapter-normalize.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import { executeSmokeLane, parseSmokeLaneArgs } from "../smoke-result.mjs"

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024
const AUDIT_OUTPUT_BYTES = 2 * 1024 * 1024
const PUBLIC_REGISTRY = "https://registry.npmjs.org"

export async function runPublishedHarnessSmoke(options, overrides = {}) {
  const dependencies = {
    makeTempDir,
    removeDir,
    runCommand: defaultRunCommand,
    runHarnessAssertion: defaultRunHarnessAssertion,
    ...overrides,
  }
  dependencies.runAgUiProbe ??= (root) =>
    runAgUiInstalledProbe(root, { runCommand: dependencies.runCommand })
  dependencies.runDockerProbe ??= (root) =>
    runDockerSandboxInstalledProbe(root, {
      runCommand: dependencies.runCommand,
    })
  dependencies.runTypeScriptProbe ??= (root) =>
    runInstalledTypeScriptProbe(root, dependencies.runCommand, options.version)

  return executeSmokeLane(
    { lane: "published-harness", ...options },
    async ({ check, deferCleanup }) => {
      const root = await check(
        "temporary-project",
        "clean published harness consumer created",
        () => dependencies.makeTempDir("dawn-published-harness-"),
      )
      deferCleanup("cleanup", "published harness consumer removed", () =>
        dependencies.removeDir(root),
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
            { cwd: root },
          )
          validateNpmAuditSignatures(audit.stdout, {
            version: options.version,
            requiredPackages: CANONICAL_RELEASE_PACKAGE_ORDER,
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
        dependencies.runDockerProbe(root),
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

export function validateNpmAuditSignatures(output, { version, requiredPackages }) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > AUDIT_OUTPUT_BYTES) {
    throw new Error("npm audit signatures output is missing or exceeds its byte limit")
  }
  let parsed
  try {
    parsed = snapshotJson(JSON.parse(output))
  } catch (error) {
    throw new Error("npm audit signatures output is malformed", {
      cause: error,
    })
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.invalid) ||
    !Array.isArray(parsed.missing) ||
    !Array.isArray(parsed.verified) ||
    Object.keys(parsed).sort().join(",") !== "invalid,missing,verified"
  ) {
    throw new Error("npm audit signatures output is malformed")
  }
  if (parsed.invalid.length > 0) {
    throw new Error(
      `npm audit signatures reported invalid evidence for ${auditNames(parsed.invalid)}`,
    )
  }
  if (parsed.missing.length > 0) {
    throw new Error(
      `npm audit signatures reported missing signature for ${auditNames(parsed.missing)}`,
    )
  }
  if (!Array.isArray(requiredPackages) || requiredPackages.length === 0) {
    throw new Error("Required npm audit package set is empty")
  }
  const required = new Set(requiredPackages)
  if (required.size !== requiredPackages.length)
    throw new Error("Required npm audit package set is duplicate")
  const verified = new Map()
  for (const item of parsed.verified) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("npm audit signatures verified entry is malformed")
    }
    if (!required.has(item.name)) continue
    if (
      Object.keys(item).sort().join(",") !==
        "attestationBundles,attestations,location,name,registry,version" ||
      typeof item.name !== "string" ||
      typeof item.version !== "string" ||
      typeof item.location !== "string" ||
      typeof item.registry !== "string" ||
      item.location !== `node_modules/${item.name}`
    ) {
      throw new Error("npm audit signatures verified entry is malformed")
    }
    if (verified.has(item.name)) throw new Error(`npm audit signatures duplicate ${item.name}`)
    if (item.version !== version) {
      throw new Error(`${item.name} was not verified at exact ${version}`)
    }
    if (
      item.registry !== `${PUBLIC_REGISTRY}/` ||
      item.attestations === null ||
      typeof item.attestations !== "object" ||
      Array.isArray(item.attestations) ||
      Object.keys(item.attestations).length === 0 ||
      !Array.isArray(item.attestationBundles) ||
      item.attestationBundles.length === 0 ||
      item.attestationBundles.some(
        (bundle) => bundle === null || typeof bundle !== "object" || Array.isArray(bundle),
      )
    ) {
      throw new Error(`${item.name}@${version} lacks verified provenance attestation bundles`)
    }
    verified.set(item.name, item)
  }
  const absent = requiredPackages.filter((name) => !verified.has(name))
  if (absent.length > 0) {
    throw new Error(`npm audit signatures did not verify exact ${version} for ${absent.join(", ")}`)
  }
  return Object.freeze([...verified.keys()].sort())
}

async function defaultRunHarnessAssertion(root, lane, version) {
  const probePath = path.join(root, "published-harness.mjs")
  await writeFile(probePath, publishedHarnessProbeSource(), "utf8")
  await defaultRunCommand("node", [probePath, lane, version], { cwd: root })
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

async function defaultRunCommand(command, args, options = {}) {
  const stdout = await run(command, args, {
    ...options,
    env: publicNpmEnvironment({ home: options.cwd, extra: options.env }),
    replaceEnv: true,
    stdio: "pipe",
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_OUTPUT_BYTES,
  })
  return { stdout, stderr: "" }
}

function auditNames(entries) {
  return entries
    .map((entry) => `${entry?.name ?? "<unknown>"}@${entry?.version ?? "<unknown>"}`)
    .join(", ")
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
