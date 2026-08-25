import path from "node:path"

import { readBoundedFixture } from "./fixture-io.mjs"
import { createReleasePreparationRunner } from "./process-runner.mjs"

const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/u
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const MAX_FILE_BYTES = 2 * 1024 * 1024
const API_VERSION = "2026-03-10"

export function createOwnerPreflightAdapters({
  cwd,
  environment = process.env,
  readFile,
  run,
} = {}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new TypeError("Owner preflight adapter root is invalid")
  }
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Owner preflight adapter environment is invalid")
  }
  const execute =
    run ??
    createReleasePreparationRunner({
      commandTimeoutMs: 15_000,
      overallTimeoutMs: 10 * 60_000,
      maxOutputBytes: 2 * 1024 * 1024,
    })
  if (typeof execute !== "function")
    throw new TypeError("Owner preflight command runner is invalid")
  const read =
    readFile ??
    ((filePath) =>
      readBoundedFixture(path.resolve(cwd, filePath), { root: cwd, maxBytes: MAX_FILE_BYTES }))
  if (typeof read !== "function") throw new TypeError("Owner preflight file reader is invalid")
  const baseEnvironment = safeEnvironment(environment)
  const githubEnvironment = {
    ...baseEnvironment,
    ...(credential(environment) === null ? {} : { GH_TOKEN: credential(environment) }),
  }

  async function executeExact(command, args, options = {}) {
    const result = await execute(command, args, {
      cwd,
      env: options.github === true ? githubEnvironment : baseEnvironment,
      ...(options.acceptedExitCodes === undefined
        ? {}
        : { acceptedExitCodes: options.acceptedExitCodes }),
    })
    if (
      result === null ||
      typeof result !== "object" ||
      !Number.isSafeInteger(result.exitCode) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string"
    ) {
      throw new TypeError("Owner preflight command result is malformed")
    }
    return result
  }

  async function readGitHub(endpoint, { absenceAllowed = false } = {}) {
    let result
    try {
      result = await executeExact("gh", apiArguments(endpoint), {
        github: true,
        acceptedExitCodes: [0, 1],
      })
    } catch {
      return { status: "unavailable", httpStatus: null, value: null }
    }
    const response = parseIncludedResponse(result.stdout)
    if (result.exitCode === 0 && response.httpStatus === 200) {
      if (response.value === null || typeof response.value !== "object") {
        throw new TypeError("Owner preflight GitHub response is malformed")
      }
      return { status: "present", httpStatus: 200, value: response.value }
    }
    if (absenceAllowed && response.httpStatus === 404) {
      return { status: "absent", httpStatus: 404, value: null }
    }
    return { status: "unavailable", httpStatus: response.httpStatus, value: null }
  }

  return Object.freeze({
    files: Object.freeze({
      async read(filePath) {
        if (typeof filePath !== "string" || filePath.length === 0 || path.isAbsolute(filePath)) {
          throw new TypeError("Owner preflight file path is invalid")
        }
        const value = await read(filePath)
        return Buffer.isBuffer(value) || value instanceof Uint8Array
          ? Buffer.from(value).toString("utf8")
          : value
      },
    }),
    git: Object.freeze({
      async headSha() {
        const result = await executeExact("git", ["rev-parse", "--verify", "HEAD^{commit}"])
        const value = result.stdout.trim()
        if (!/^[0-9a-f]{40}$/u.test(value)) {
          throw new TypeError("Owner preflight Git HEAD output is malformed")
        }
        return value
      },
    }),
    npm: Object.freeze({
      async version() {
        const result = await executeExact("npm", ["--version"])
        return exactVersion(result.stdout, "npm")
      },
      async trustList(name) {
        if (typeof name !== "string" || !PACKAGE_PATTERN.test(name)) {
          throw new TypeError("Owner preflight npm package is invalid")
        }
        let result
        try {
          result = await executeExact("npm", ["trust", "list", name, "--json"], {
            acceptedExitCodes: [0, 1],
          })
        } catch {
          return { status: "unavailable", code: "READ_FAILED" }
        }
        let value
        try {
          value = JSON.parse(result.stdout)
        } catch (error) {
          if (result.exitCode !== 0) return { status: "unavailable", code: "READ_FAILED" }
          throw new TypeError("Owner preflight npm trust JSON is malformed", { cause: error })
        }
        if (result.exitCode !== 0) {
          const code = value?.error?.code
          return {
            status: "unavailable",
            code: typeof code === "string" && CODE_PATTERN.test(code) ? code : "READ_FAILED",
          }
        }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError("Owner preflight npm trust JSON is malformed")
        }
        return { status: "present", value }
      },
    }),
    github: Object.freeze({
      async version() {
        const result = await executeExact("gh", ["--version"], { github: true })
        const match = /^gh version ([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/u.exec(result.stdout)
        if (match === null) throw new TypeError("Owner preflight gh version is malformed")
        return match[1]
      },
      async getRepository(repository) {
        assertRepository(repository)
        return readGitHub(`repos/${repository}`)
      },
      async getWorkflow(workflowPath) {
        if (typeof workflowPath !== "string" || !WORKFLOW_PATH_PATTERN.test(workflowPath)) {
          throw new TypeError("Owner preflight workflow path is invalid")
        }
        const repository = repositoryFromEnvironment(environment)
        return readGitHub(`repos/${repository}/actions/workflows/${path.basename(workflowPath)}`, {
          absenceAllowed: true,
        })
      },
      async getEnvironment(name) {
        if (typeof name !== "string" || !ENVIRONMENT_PATTERN.test(name)) {
          throw new TypeError("Owner preflight environment name is invalid")
        }
        const repository = repositoryFromEnvironment(environment)
        return readGitHub(`repos/${repository}/environments/${encodeURIComponent(name)}`)
      },
      async getImmutableReleases(repository) {
        assertRepository(repository)
        return readGitHub(`repos/${repository}/immutable-releases`, { absenceAllowed: true })
      },
    }),
  })
}

function apiArguments(endpoint) {
  return [
    "api",
    "--include",
    "--method",
    "GET",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    `X-GitHub-Api-Version: ${API_VERSION}`,
    endpoint,
  ]
}

function parseIncludedResponse(stdout) {
  const matches = [...stdout.matchAll(/^HTTP\/\S+\s+([0-9]{3})[^\r\n]*\r?$/gmu)]
  const match = matches.at(-1)
  if (match === undefined) throw new TypeError("Owner preflight GitHub HTTP response is malformed")
  const remainder = stdout.slice(match.index + match[0].length).replace(/^\r?\n/u, "")
  const separator = /\r?\n\r?\n/u.exec(remainder)
  if (separator === null) throw new TypeError("Owner preflight GitHub HTTP headers are malformed")
  const body = remainder.slice(separator.index + separator[0].length).trim()
  let value = null
  if (body.length > 0) {
    try {
      value = JSON.parse(body)
    } catch (error) {
      throw new TypeError("Owner preflight GitHub response JSON is malformed", { cause: error })
    }
  }
  return { httpStatus: Number(match[1]), value }
}

function exactVersion(value, label) {
  const normalized = value.trim()
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(normalized)) {
    throw new TypeError(`Owner preflight ${label} version is malformed`)
  }
  return normalized
}

function repositoryFromEnvironment(environment) {
  const repository = environment.GITHUB_REPOSITORY ?? "cacheplane/dawnai"
  assertRepository(repository)
  return repository
}

function assertRepository(value) {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) {
    throw new TypeError("Owner preflight repository is invalid")
  }
}

function credential(environment) {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = environment[name]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function safeEnvironment(environment) {
  const names = ["CI", "HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR", "USERPROFILE"]
  return {
    ...Object.fromEntries(
      names.flatMap((name) =>
        typeof environment[name] === "string" ? [[name, environment[name]]] : [],
      ),
    ),
    NO_COLOR: "1",
  }
}
