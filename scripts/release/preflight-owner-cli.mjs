import { open } from "node:fs/promises"
import path from "node:path"

import { readBoundedFixture } from "./fixture-io.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "./manifest.mjs"
import {
  canonicalOwnerEvidenceBytes,
  captureOwnerEvidence,
  OWNER_PREFLIGHT_FILES,
  parseOwnerEvidence,
  renderOwnerPreflightReport,
  verifyOwnerEvidence,
} from "./preflight-owner.mjs"
import { createOwnerPreflightAdapters } from "./preflight-owner-adapters.mjs"

const DEFAULT_REPOSITORY = "cacheplane/dawnai"
const MAX_EVIDENCE_BYTES = 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const SHA_PATTERN = /^[0-9a-f]{40}$/u

export async function runOwnerPreflightCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  dependencies = {},
} = {}) {
  try {
    const options = parseArguments(argv, cwd)
    const now = dependencies.now ?? Date.now
    if (typeof now !== "function") throw new OwnerPreflightInputError("Invalid owner clock")
    if (options.command === "capture") {
      const adapters =
        dependencies.adapters ??
        createOwnerPreflightAdapters({
          cwd,
          environment: { ...environment, GITHUB_REPOSITORY: options.repository },
          ...(dependencies.run === undefined ? {} : { run: dependencies.run }),
        })
      const evidence = await captureOwnerEvidence({
        phase: options.phase,
        repository: options.repository,
        packageNames: CANONICAL_RELEASE_PACKAGE_ORDER,
        ...adapters,
        now,
      })
      await writeExclusive(options.output, canonicalOwnerEvidenceBytes(evidence))
      stdout.write("Owner evidence captured.\n")
      return 0
    }

    const evidenceBytes = await readBoundedFixture(options.evidence, {
      root: cwd,
      maxBytes: MAX_EVIDENCE_BYTES,
    })
    const evidence = parseOwnerEvidence(evidenceBytes)
    if (evidence.phase !== options.phase) throw new Error("Owner evidence phase does not match")
    const currentFiles = new Map()
    for (const filePath of OWNER_PREFLIGHT_FILES) {
      currentFiles.set(
        filePath,
        await readBoundedFixture(path.resolve(cwd, filePath), {
          root: cwd,
          maxBytes: MAX_FILE_BYTES,
        }),
      )
    }
    const report = verifyOwnerEvidence({
      evidence,
      currentHeadSha: options.headSha,
      currentFiles,
      now,
    })
    stdout.write(renderOwnerPreflightReport(report, { format: options.format }))
    return options.strict && report.status !== "PASS" ? 1 : 0
  } catch (error) {
    const input = error instanceof OwnerPreflightInputError
    stderr.write(input ? "Invalid owner preflight input.\n" : "Owner preflight failed.\n")
    return input ? 2 : 1
  }
}

function parseArguments(argv, cwd) {
  if (!Array.isArray(argv) || typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new OwnerPreflightInputError("Invalid owner preflight invocation")
  }
  const command = argv[0]
  if (!["capture", "verify"].includes(command)) {
    throw new OwnerPreflightInputError("Unknown owner preflight command")
  }
  const values = new Map()
  let strict = false
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--strict") {
      if (command !== "verify" || strict) {
        throw new OwnerPreflightInputError("Duplicate or invalid strict flag")
      }
      strict = true
      continue
    }
    const allowed =
      command === "capture"
        ? new Set(["--phase", "--repository", "--output"])
        : new Set(["--phase", "--evidence", "--head-sha", "--format"])
    if (!allowed.has(flag) || values.has(flag)) {
      throw new OwnerPreflightInputError("Unknown or duplicate owner preflight flag")
    }
    const value = argv[index + 1]
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new OwnerPreflightInputError("Owner preflight flag requires a value")
    }
    values.set(flag, value)
    index += 1
  }
  const phase = values.get("--phase")
  if (!["pre-enable", "post-enable"].includes(phase)) {
    throw new OwnerPreflightInputError("Owner preflight phase is required")
  }
  if (command === "capture") {
    const output = values.get("--output")
    const repository = values.get("--repository") ?? DEFAULT_REPOSITORY
    if (output === undefined) {
      throw new OwnerPreflightInputError("Owner evidence output is required")
    }
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(repository)) {
      throw new OwnerPreflightInputError("Owner repository is invalid")
    }
    return { command, phase, repository, output: resolveContained(cwd, output) }
  }
  const evidence = values.get("--evidence")
  const headSha = values.get("--head-sha")
  const format = values.get("--format") ?? "markdown"
  if (evidence === undefined || typeof headSha !== "string" || !SHA_PATTERN.test(headSha)) {
    throw new OwnerPreflightInputError("Explicit evidence and HEAD are required")
  }
  if (!["json", "markdown"].includes(format)) {
    throw new OwnerPreflightInputError("Owner preflight format is invalid")
  }
  return {
    command,
    phase,
    evidence: resolveContained(cwd, evidence),
    headSha,
    format,
    strict,
  }
}

function resolveContained(root, value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    throw new OwnerPreflightInputError("Owner preflight path is invalid")
  }
  const resolved = path.resolve(root, value)
  const relative = path.relative(root, resolved)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OwnerPreflightInputError("Owner preflight path escapes the repository")
  }
  return resolved
}

async function writeExclusive(target, bytes) {
  let handle
  try {
    handle = await open(target, "wx", 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

class OwnerPreflightInputError extends Error {}
