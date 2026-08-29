#!/usr/bin/env node

import path from "node:path"
import { pathToFileURL } from "node:url"

const REPOSITORY = "cacheplane/dawnai"
const API_ORIGIN = "https://api.github.com"
const WORKFLOW = ".github/workflows/release.yml"
const API_VERSION = "2026-03-10"
const MAX_RESPONSE_BYTES = 16 * 1024
const MAX_TOKEN_BYTES = 16 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const RELEASE_TAG_REF_PATTERN =
  /^refs\/tags\/v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
const OPTION_FIELDS = Object.freeze(["argv", "environment", "fetchImpl", "signal"])

export function parseImmutableReleasesGateEnvironment(environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw gateError("IMMUTABLE_RELEASES_INVOCATION_INVALID")
  }
  const repository = environmentValue(environment, "GITHUB_REPOSITORY")
  const apiOrigin = environmentValue(environment, "GITHUB_API_URL")
  const eventName = environmentValue(environment, "GITHUB_EVENT_NAME")
  const workflowRef = environmentValue(environment, "GITHUB_WORKFLOW_REF")
  const ref = environmentValue(environment, "GITHUB_REF")
  const commitSha = environmentValue(environment, "GITHUB_SHA")
  const token = environmentValue(environment, "GITHUB_TOKEN")

  const mainRef = ref === "refs/heads/main"
  const tagRef = RELEASE_TAG_REF_PATTERN.test(ref)
  const eventMatchesRef =
    (eventName === "push" && mainRef) ||
    (eventName === "schedule" && mainRef) ||
    (eventName === "workflow_dispatch" && (mainRef || tagRef))
  if (
    repository !== REPOSITORY ||
    apiOrigin !== API_ORIGIN ||
    !eventMatchesRef ||
    workflowRef !== `${REPOSITORY}/${WORKFLOW}@${ref}` ||
    !SHA_PATTERN.test(commitSha) ||
    token.length === 0 ||
    Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES ||
    /[\0\r\n]/u.test(token)
  ) {
    throw gateError("IMMUTABLE_RELEASES_INVOCATION_INVALID")
  }
  return deepFreeze({ repository, apiOrigin, ref, commitSha, token })
}

export async function verifyImmutableReleasesEnabled(options = {}) {
  validateOptions(options)
  const argvOption = option(options, "argv")
  const argv = argvOption === undefined ? [] : argvOption
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new TypeError("Immutable Releases gate accepts no arguments")
  }
  const environmentOption = option(options, "environment")
  const environment = environmentOption === undefined ? process.env : environmentOption
  const fetchOption = option(options, "fetchImpl")
  const fetchImpl = fetchOption === undefined ? fetch : fetchOption
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Immutable Releases gate fetch implementation is invalid")
  }
  const invocation = parseImmutableReleasesGateEnvironment(environment)
  const suppliedSignal = option(options, "signal")
  if (suppliedSignal !== undefined && !(suppliedSignal instanceof AbortSignal)) {
    throw new TypeError("Immutable Releases gate signal is invalid")
  }
  const signal = suppliedSignal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const url = `${invocation.apiOrigin}/repos/${invocation.repository}/immutable-releases`
  let response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${invocation.token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
    })
  } catch {
    throw gateError("IMMUTABLE_RELEASES_REQUEST_FAILED")
  }
  if (response === null || typeof response !== "object" || !Number.isInteger(response.status)) {
    throw gateError("IMMUTABLE_RELEASES_RESPONSE_INVALID")
  }
  if (response.status !== 200) {
    throw gateError(
      response.status === 404 ? "IMMUTABLE_RELEASES_DISABLED" : "IMMUTABLE_RELEASES_UNAVAILABLE",
    )
  }
  const value = await readBoundedJson(response)
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw gateError("IMMUTABLE_RELEASES_RESPONSE_INVALID")
  }
  if (value.enabled !== true) {
    throw gateError(
      value.enabled === false
        ? "IMMUTABLE_RELEASES_DISABLED"
        : "IMMUTABLE_RELEASES_RESPONSE_INVALID",
    )
  }
  if (value.enforced_by_owner !== undefined && typeof value.enforced_by_owner !== "boolean") {
    throw gateError("IMMUTABLE_RELEASES_RESPONSE_INVALID")
  }
  return deepFreeze({
    repository: invocation.repository,
    enabled: true,
    enforcedByOwner: value.enforced_by_owner ?? null,
  })
}

async function readBoundedJson(response) {
  const contentLength = response.headers?.get?.("content-length")
  if (
    contentLength !== null &&
    contentLength !== undefined &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    throw gateError("IMMUTABLE_RELEASES_RESPONSE_INVALID")
  }
  if (typeof response.arrayBuffer !== "function") {
    throw gateError("IMMUTABLE_RELEASES_RESPONSE_INVALID")
  }
  let bytes
  try {
    bytes = Buffer.from(await response.arrayBuffer())
  } catch {
    throw gateError("IMMUTABLE_RELEASES_RESPONSE_INVALID")
  }
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw gateError("IMMUTABLE_RELEASES_RESPONSE_INVALID")
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw gateError("IMMUTABLE_RELEASES_RESPONSE_INVALID")
  }
}

function validateOptions(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  ) {
    throw new TypeError("Immutable Releases gate options must be a plain object")
  }
  for (const key of Reflect.ownKeys(options)) {
    const descriptor =
      typeof key === "string" ? Object.getOwnPropertyDescriptor(options, key) : null
    if (
      typeof key !== "string" ||
      !OPTION_FIELDS.includes(key) ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("Immutable Releases gate options contain an unsafe field")
    }
  }
}

function option(options, name) {
  return Object.getOwnPropertyDescriptor(options, name)?.value
}

function environmentValue(environment, name) {
  const descriptor = Object.getOwnPropertyDescriptor(environment, name)
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string"
  ) {
    throw gateError("IMMUTABLE_RELEASES_INVOCATION_INVALID")
  }
  return descriptor.value
}

function gateError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const executedPath =
  process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href
if (executedPath === import.meta.url) {
  try {
    const result = await verifyImmutableReleasesEnabled({ argv: process.argv.slice(2) })
    process.stdout.write(`Immutable Releases are enabled for ${result.repository}.\n`)
  } catch (error) {
    const code =
      typeof error?.code === "string" && /^IMMUTABLE_RELEASES_[A-Z_]+$/u.test(error.code)
        ? error.code
        : "IMMUTABLE_RELEASES_GATE_FAILED"
    process.stderr.write(`Immutable Releases gate failed: ${code}\n`)
    process.exitCode = 1
  }
}
