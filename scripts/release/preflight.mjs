#!/usr/bin/env node

import path from "node:path"
import { pathToFileURL } from "node:url"
import { parse } from "yaml"

import { normalizeAdapterEnvelope, snapshotJson } from "./adapter-normalize.mjs"
import { createGitHubReader as defaultCreateGitHubReader } from "./adapters/github.mjs"
import { createNpmReader as defaultCreateNpmReader } from "./adapters/npm.mjs"
import { readBoundedFixture as defaultReadWorkflowSource } from "./fixture-io.mjs"
import {
  assertValidReleaseInventory as defaultAssertValidReleaseInventory,
  readReleaseInventory as defaultReadReleaseInventory,
} from "./inventory.mjs"
import { redactCredentialText } from "./report-render.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"

const STATUSES = new Set(["PASS", "FAIL", "WARN", "UNPROVABLE"])
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const WORKFLOW_PATH = ".github/workflows/release.yml"
const DEFAULT_REPOSITORY = "cacheplane/dawnai"
const MAX_WORKFLOW_BYTES = 1024 * 1024

export async function collectReleasePreflight({ inventory, workflowSource, npm, github }) {
  const checks = []
  const releaseInventory = normalizeInventory(inventory)
  checks.push(
    releaseInventory === null
      ? result("inventory", "FAIL", "Release inventory is invalid or incomplete.")
      : result(
          "inventory",
          "PASS",
          `Release inventory contains ${releaseInventory.packages.length} uniformly versioned public packages.`,
        ),
  )

  const workflow = parseWorkflow(workflowSource)
  checks.push(staticPermissionsCheck(workflow), requiredValidationCheck(workflow))

  checks.push(await npmProvenanceCheck(releaseInventory, npm))
  checks.push(
    await githubCheck({
      id: "github-workflow-active",
      reader: github,
      method: "getWorkflow",
      args: { workflow: "release.yml" },
      operation: "workflow",
      evaluate(value) {
        return value?.path === WORKFLOW_PATH && value.state === "active"
          ? result("github-workflow-active", "PASS", "The legacy release workflow is active.")
          : result(
              "github-workflow-active",
              "FAIL",
              "The legacy release workflow is inactive or has an unexpected identity.",
            )
      },
    }),
    await githubCheck({
      id: "github-actions-permissions",
      reader: github,
      method: "getActionsPermissions",
      operation: "actions-permissions",
      evaluate(value) {
        if (value?.enabled_actions === "all")
          return result("github-actions-permissions", "PASS", "Repository Actions are enabled.")
        if (["selected", "local_only"].includes(value?.enabled_actions))
          return result(
            "github-actions-permissions",
            "WARN",
            "Repository Actions use a restricted allowlist that requires manual review.",
          )
        return result("github-actions-permissions", "FAIL", "Repository Actions are disabled.")
      },
    }),
    await githubCheck({
      id: "github-default-workflow-permissions",
      reader: github,
      method: "getWorkflowPermissions",
      operation: "workflow-permissions",
      evaluate(value) {
        if (value?.default_workflow_permissions === "read")
          return result(
            "github-default-workflow-permissions",
            "PASS",
            "Repository workflow permissions default to read-only.",
          )
        if (value?.default_workflow_permissions === "write")
          return result(
            "github-default-workflow-permissions",
            "WARN",
            "Repository workflow permissions default to write; job-level review is required.",
          )
        return result(
          "github-default-workflow-permissions",
          "FAIL",
          "Repository default workflow permissions are malformed.",
        )
      },
    }),
    await githubCheck({
      id: "github-environments",
      reader: github,
      method: "listEnvironments",
      operation: "environments",
      evaluate(value) {
        if (!Array.isArray(value))
          return result("github-environments", "FAIL", "Visible environment evidence is malformed.")
        return value.length > 0
          ? result(
              "github-environments",
              "PASS",
              `${value.length} repository environment${value.length === 1 ? " is" : "s are"} visible.`,
            )
          : result(
              "github-environments",
              "WARN",
              "No repository environments are visible to this read-only observer.",
            )
      },
    }),
    await githubCheck({
      id: "github-required-validate",
      reader: github,
      method: "getBranchProtection",
      args: { branch: "main" },
      operation: "branch-protection",
      evaluate(value) {
        const required = value?.required_status_checks
        const contexts = Array.isArray(required?.contexts) ? required.contexts : []
        const checks = Array.isArray(required?.checks) ? required.checks : []
        const hasValidate =
          contexts.includes("validate") || checks.some((item) => item?.context === "validate")
        return hasValidate
          ? result(
              "github-required-validate",
              "PASS",
              "The main branch requires the validate status check.",
            )
          : result(
              "github-required-validate",
              "FAIL",
              "The main branch does not require the validate status check.",
            )
      },
    }),
  )

  checks.push(
    result(
      "npm-trusted-publisher",
      "UNPROVABLE",
      "Current npm trusted-publisher enrollment is not exposed by public registry evidence.",
    ),
    result(
      "future-write-oidc",
      "UNPROVABLE",
      "Future GitHub write and OIDC authority requires authenticated owner evidence.",
    ),
  )
  checks.sort((left, right) => compareText(left.id, right.id))
  return deepFreeze({ schemaVersion: 1, status: overallStatus(checks), checks })
}

export function renderPreflightReport(input, { format }) {
  const report = normalizeReport(input)
  if (format === "json") return `${JSON.stringify(canonicalize(report), null, 2)}\n`
  if (format !== "markdown") throw new TypeError("Preflight format must be json or markdown")
  return [
    "# Release Preflight Report",
    "",
    `Overall status: ${inlineCode(report.status)}`,
    "",
    "## Checks",
    "",
    ...report.checks.map(
      (check) =>
        `- ${inlineCode(check.status)} ${inlineCode(check.id)} — ${escapeMarkdown(check.summary)}`,
    ),
    "",
  ].join("\n")
}

export async function runReleasePreflight({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  dependencies = {},
} = {}) {
  try {
    const options = parseArguments(argv, cwd)
    const readReleaseInventory = dependencies.readReleaseInventory ?? defaultReadReleaseInventory
    const assertValidReleaseInventory =
      dependencies.assertValidReleaseInventory ?? defaultAssertValidReleaseInventory
    const readWorkflowSource = dependencies.readWorkflowSource ?? defaultReadWorkflowSource
    const createNpmReader = dependencies.createNpmReader ?? defaultCreateNpmReader
    const createGitHubReader = dependencies.createGitHubReader ?? defaultCreateGitHubReader
    const rawInventory = await readReleaseInventory({ root: cwd, ref: "HEAD" })
    const validated = assertValidReleaseInventory(rawInventory)
    const inventory = {
      packages: validated.packages,
      version: options.version ?? validated.version,
      repository: options.repository,
    }
    const workflowSource = await readWorkflowSource(options.workflow, {
      root: cwd,
      maxBytes: MAX_WORKFLOW_BYTES,
    })
    const [owner, repo] = options.repository.split("/")
    const token = env.GITHUB_TOKEN
    const report = await collectReleasePreflight({
      inventory,
      workflowSource,
      npm: createNpmReader(),
      github: createGitHubReader({
        owner,
        repo,
        ...(token === undefined || token === "" ? {} : { token }),
      }),
    })
    stdout.write(renderPreflightReport(report, { format: options.format }))
    return options.strict && ["FAIL", "UNPROVABLE"].includes(report.status) ? 1 : 0
  } catch (error) {
    const input = error instanceof PreflightInputError || error instanceof TypeError
    stderr.write(`${safeMessage(error, input ? "Invalid preflight input" : "Preflight failed")}\n`)
    return input ? 2 : 1
  }
}

function normalizeInventory(value) {
  try {
    const snapshot = snapshotJson(value)
    if (
      !isRecord(snapshot) ||
      !Array.isArray(snapshot.packages) ||
      snapshot.packages.length === 0 ||
      !isReleaseVersion(snapshot.version) ||
      typeof snapshot.repository !== "string" ||
      !REPOSITORY_PATTERN.test(snapshot.repository) ||
      !snapshot.packages.every((name) => typeof name === "string" && PACKAGE_PATTERN.test(name)) ||
      new Set(snapshot.packages).size !== snapshot.packages.length
    ) {
      return null
    }
    return {
      packages: [...snapshot.packages].sort(compareText),
      version: snapshot.version,
      repository: snapshot.repository,
    }
  } catch {
    return null
  }
}

function parseWorkflow(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_WORKFLOW_BYTES)
    return null
  try {
    const value = parse(source, { maxAliasCount: 0, uniqueKeys: true })
    return isRecord(value) ? snapshotJson(value) : null
  } catch {
    return null
  }
}

function staticPermissionsCheck(workflow) {
  const top = workflow?.permissions
  const job = workflow?.jobs?.release
  const jobPermissions = job?.permissions
  const valid =
    exactRecord(top, { contents: "read" }) &&
    exactRecord(jobPermissions, {
      attestations: "write",
      contents: "write",
      "id-token": "write",
      "pull-requests": "write",
    })
  return valid
    ? result(
        "workflow-static-permissions",
        "PASS",
        "Legacy workflow permissions are explicit and match current publisher requirements.",
      )
    : result(
        "workflow-static-permissions",
        "FAIL",
        "Legacy workflow permissions are missing, implicit, or unexpected.",
      )
}

function requiredValidationCheck(workflow) {
  const job = workflow?.jobs?.release
  const steps = job?.steps
  const matches = Array.isArray(steps)
    ? steps.flatMap((step, index) => (isExactValidateStep(step) ? [index] : []))
    : []
  const validateIndex = matches[0]
  const trustedContext =
    isRecord(workflow) &&
    exactKeys(workflow.jobs, ["release"]) &&
    workflow.env === undefined &&
    workflow.defaults === undefined &&
    isRecord(job) &&
    exactKeys(job, ["env", "permissions", "runs-on", "steps", "timeout-minutes"]) &&
    job["runs-on"] === "ubuntu-latest" &&
    job["timeout-minutes"] === 30 &&
    exactRecord(job.env, { NPM_CONFIG_PROVENANCE: "true" })
  const trustedPrevalidation =
    validateIndex !== undefined && steps.slice(0, validateIndex).every(isTrustedPrevalidationStep)
  const enforcing = trustedContext && matches.length === 1 && trustedPrevalidation
  return enforcing
    ? result(
        "workflow-required-validation",
        "PASS",
        "Legacy publication runs the required validation command exactly once.",
      )
    : result(
        "workflow-required-validation",
        "FAIL",
        "Legacy publication does not run the required validation command exactly once.",
      )
}

function isExactValidateStep(step) {
  return (
    isRecord(step) &&
    step.run === "pnpm ci:validate" &&
    step.env === undefined &&
    step.if === undefined &&
    step["continue-on-error"] === undefined &&
    step["working-directory"] === undefined &&
    step.shell === undefined &&
    step["timeout-minutes"] === undefined
  )
}

function isTrustedPrevalidationStep(step) {
  if (!isRecord(step)) return false
  if (exactKeys(step, ["name", "run"]))
    return step.name === "Install" && step.run === "pnpm install --frozen-lockfile"
  if (!exactKeys(step, ["name", "uses", "with"])) return false
  if (step.name === "Checkout")
    return (
      step.uses === "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0" &&
      exactRecord(step.with, { "fetch-depth": 0 })
    )
  if (step.name === "Setup pnpm")
    return (
      step.uses === "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271" &&
      exactRecord(step.with, { version: "10.33.0" })
    )
  return (
    step.name === "Setup Node.js" &&
    step.uses === "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e" &&
    exactRecord(step.with, { cache: "pnpm", "node-version": "24.17.0" })
  )
}

async function npmProvenanceCheck(inventory, reader) {
  if (inventory === null)
    return result(
      "npm-current-provenance",
      "FAIL",
      "Current npm provenance cannot be evaluated for an invalid inventory.",
    )
  if (!isRecord(reader) || typeof reader.observePackageVersion !== "function")
    return result("npm-current-provenance", "UNPROVABLE", "The npm reader is unavailable.")
  let unprovable = false
  const commits = new Set()
  const expectedRepository = `https://github.com/${inventory.repository}`
  for (const name of inventory.packages) {
    const envelope = await safeEnvelope(
      () => reader.observePackageVersion({ name, version: inventory.version }),
      { source: "npm", operation: "package-version", payloadKey: "package" },
    )
    if (["AMBIGUOUS", "ERROR"].includes(envelope.status)) {
      unprovable = true
      continue
    }
    if (envelope.status !== "PRESENT")
      return result(
        "npm-current-provenance",
        "FAIL",
        "At least one exact public package version is absent.",
      )
    const pkg = envelope.package
    if (
      pkg?.name !== name ||
      pkg.version !== inventory.version ||
      pkg.provenance?.status !== "PRESENT" ||
      pkg.provenance.workflow !== WORKFLOW_PATH ||
      pkg.provenance.repository !== expectedRepository ||
      pkg.provenance.ref !== "refs/heads/main" ||
      typeof pkg.provenance.commitSha !== "string" ||
      !SHA_PATTERN.test(pkg.provenance.commitSha)
    ) {
      return result(
        "npm-current-provenance",
        "FAIL",
        "Current npm provenance is missing or does not match the legacy publisher workflow.",
      )
    }
    commits.add(pkg.provenance.commitSha)
  }
  if (commits.size > 1)
    return result(
      "npm-current-provenance",
      "FAIL",
      "Current npm provenance does not identify one common release commit.",
    )
  return unprovable
    ? result(
        "npm-current-provenance",
        "UNPROVABLE",
        "Current npm provenance is ambiguous for at least one package.",
      )
    : result(
        "npm-current-provenance",
        "PASS",
        "Every current public package has exact legacy-workflow npm provenance.",
      )
}

async function githubCheck({ id, reader, method, args, operation, evaluate }) {
  if (!isRecord(reader) || typeof reader[method] !== "function")
    return result(id, "UNPROVABLE", "The required GitHub read capability is unavailable.")
  const envelope = await safeEnvelope(() => reader[method](args), {
    source: "github",
    operation,
    payloadKey: "value",
  })
  if (envelope.status !== "PRESENT")
    return result(id, "UNPROVABLE", "GitHub evidence is unavailable or ambiguous.")
  return evaluate(envelope.value)
}

async function safeEnvelope(read, options) {
  try {
    return normalizeAdapterEnvelope(await read(), options)
  } catch {
    return { status: "ERROR", operation: options.operation, httpStatus: null, code: "READ_FAILED" }
  }
}

function result(id, status, summary) {
  return { id, status, summary }
}

function overallStatus(checks) {
  for (const status of ["FAIL", "UNPROVABLE", "WARN"]) {
    if (checks.some((check) => check.status === status)) return status
  }
  return "PASS"
}

function normalizeReport(value) {
  let snapshot
  try {
    snapshot = snapshotJson(value)
  } catch {
    throw new TypeError("Invalid preflight report")
  }
  if (
    !isRecord(snapshot) ||
    snapshot.schemaVersion !== 1 ||
    !STATUSES.has(snapshot.status) ||
    !Array.isArray(snapshot.checks) ||
    snapshot.checks.length === 0
  ) {
    throw new TypeError("Invalid preflight report")
  }
  const checks = snapshot.checks.map((check) => {
    if (
      !isRecord(check) ||
      Object.keys(check).length !== 3 ||
      typeof check.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(check.id) ||
      !STATUSES.has(check.status) ||
      typeof check.summary !== "string" ||
      Buffer.byteLength(check.summary, "utf8") > 4096
    ) {
      throw new TypeError("Invalid preflight report")
    }
    return check
  })
  checks.sort((left, right) => compareText(left.id, right.id))
  if (new Set(checks.map(({ id }) => id)).size !== checks.length)
    throw new TypeError("Invalid preflight report")
  if (snapshot.status !== overallStatus(checks)) throw new TypeError("Invalid preflight report")
  return { schemaVersion: 1, status: snapshot.status, checks }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === "string") return redactCredentialText(value)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, canonicalize(value[key])]),
  )
}

function parseArguments(argv, cwd) {
  if (!Array.isArray(argv) || typeof cwd !== "string" || !path.isAbsolute(cwd))
    throw new PreflightInputError("Invalid preflight arguments")
  const values = new Map()
  let strict = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--strict") {
      if (strict) throw new PreflightInputError("Duplicate preflight option")
      strict = true
      continue
    }
    if (!["--repository", "--workflow", "--version", "--format"].includes(flag))
      throw new PreflightInputError("Unknown preflight option")
    if (values.has(flag)) throw new PreflightInputError("Duplicate preflight option")
    const next = argv[index + 1]
    if (typeof next !== "string" || next.startsWith("--"))
      throw new PreflightInputError("Preflight option requires a value")
    values.set(flag, next)
    index += 1
  }
  const repository = values.get("--repository") ?? DEFAULT_REPOSITORY
  const workflow = values.get("--workflow") ?? WORKFLOW_PATH
  const format = values.get("--format") ?? "markdown"
  const version = values.get("--version")
  if (!REPOSITORY_PATTERN.test(repository)) throw new PreflightInputError("Invalid repository")
  if (workflow !== WORKFLOW_PATH) throw new PreflightInputError("Invalid release workflow path")
  if (!["json", "markdown"].includes(format)) throw new PreflightInputError("Invalid report format")
  if (version !== undefined && !isReleaseVersion(version))
    throw new PreflightInputError("Invalid release version")
  return {
    repository,
    workflow: path.resolve(cwd, workflow),
    format,
    strict,
    ...(version === undefined ? {} : { version }),
  }
}

function exactRecord(value, expected) {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort(compareText)
  const expectedKeys = Object.keys(expected).sort(compareText)
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index] && value[key] === expected[key])
  )
}

function exactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort(compareText)
  const expected = [...expectedKeys].sort(compareText)
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function inlineCode(value) {
  const text = safeLine(redactCredentialText(value))
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length))
  const delimiter = "`".repeat(longest + 1)
  return `${delimiter}${text}${delimiter}`
}

function escapeMarkdown(value) {
  return safeLine(redactCredentialText(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|-])/gu, "\\$1")
}

function safeLine(value) {
  return [...String(value)]
    .map((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029
        ? " "
        : character
    })
    .join("")
}

function safeMessage(error, fallback) {
  const message = error instanceof Error ? error.message : fallback
  return safeLine(redactCredentialText(message)).slice(0, 1024)
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

class PreflightInputError extends Error {}

const executedPath =
  process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href
if (executedPath === import.meta.url) process.exitCode = await runReleasePreflight()
