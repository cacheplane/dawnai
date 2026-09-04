import { createSystemdCgroupContainment } from "./smoke-containment.mjs"

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000
const DEFAULT_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_TIMEOUT_MS = 20 * 60 * 1_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export function createStrictSmokeProcessRunner({
  containment = createSystemdCgroupContainment(),
} = {}) {
  if (
    containment === null ||
    typeof containment !== "object" ||
    typeof containment.probe !== "function" ||
    typeof containment.runContained !== "function"
  ) {
    throw new TypeError("Strict smoke runner requires a containment adapter")
  }
  let capability = null
  let probePromise = null

  return Object.freeze({
    async probe(options = {}) {
      assertProbeOptions(options)
      probePromise ??= Promise.resolve(containment.probe(options))
      try {
        capability = validateCapability(await probePromise)
        return capability
      } catch (error) {
        probePromise = null
        capability = null
        throw error
      }
    },

    async runCommand(command, args, options = {}) {
      if (capability === null) {
        throw new Error("Strict smoke containment capability probe must succeed before spawning")
      }
      const invocation = normalizeInvocation(command, args, options)
      const result = await containment.runContained(invocation)
      if (
        result === null ||
        typeof result !== "object" ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        !Number.isSafeInteger(result.exitCode)
      ) {
        throw new Error("Strict smoke containment returned a malformed command result")
      }
      const accepted = new Set(invocation.acceptedExitCodes)
      if (!accepted.has(result.exitCode)) {
        const error = new Error(
          `${command} ${args.join(" ")} failed with exit code ${result.exitCode}\n${result.stderr}`,
        )
        error.code = "ECHILD"
        error.command = command
        error.exitCode = result.exitCode
        error.stderr = result.stderr
        throw error
      }
      return { stdout: result.stdout, stderr: result.stderr }
    },
  })
}

export function strictContainmentReceiptDetail(environment = process.env) {
  const imageOS = boundedReceiptValue(environment?.ImageOS)
  const imageVersion = boundedReceiptValue(environment?.ImageVersion)
  return `strict systemd/cgroup-v2 containment available (ImageOS=${imageOS}, ImageVersion=${imageVersion})`
}

export const STRICT_SMOKE_COMMAND_OPTION_FIELDS = Object.freeze([
  "acceptedExitCodes",
  "cwd",
  "env",
  "maxOutputBytes",
  "signal",
  "timeoutMs",
])

const STRICT_SMOKE_COMMAND_OPTION_FIELD_SET = new Set(STRICT_SMOKE_COMMAND_OPTION_FIELDS)

export function pickStrictSmokeCommandOptions(options = {}) {
  if (options === null || Array.isArray(options) || typeof options !== "object") {
    throw new TypeError("Strict smoke command options are invalid")
  }
  const picked = {}
  for (const field of STRICT_SMOKE_COMMAND_OPTION_FIELDS) {
    if (options[field] !== undefined) picked[field] = options[field]
  }
  return picked
}

export function assertStrictSmokeCommandOptions(options) {
  if (options === null || Array.isArray(options) || typeof options !== "object") {
    throw new TypeError("Strict smoke command options are invalid")
  }
  if (
    Reflect.ownKeys(options).some(
      (key) => typeof key !== "string" || !STRICT_SMOKE_COMMAND_OPTION_FIELD_SET.has(key),
    )
  ) {
    throw new TypeError("Strict smoke command options contain an unexpected field")
  }
}

function normalizeInvocation(command, args, options) {
  if (
    typeof command !== "string" ||
    command.length < 1 ||
    command.length > 4_096 ||
    /\0/u.test(command)
  ) {
    throw new TypeError("Strict smoke command is invalid")
  }
  if (!Array.isArray(args) || args.length > 4_096) {
    throw new TypeError("Strict smoke command arguments are invalid")
  }
  const normalizedArgs = args.map((value) => {
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > 64 * 1024 ||
      /\0/u.test(value)
    ) {
      throw new TypeError("Strict smoke command argument is invalid")
    }
    return value
  })
  assertStrictSmokeCommandOptions(options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError("Strict smoke command timeout is outside its bound")
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > MAX_OUTPUT_BYTES
  ) {
    throw new TypeError("Strict smoke command output limit is outside its bound")
  }
  const acceptedExitCodes = normalizeAcceptedExitCodes(options.acceptedExitCodes ?? [0])
  const cwd = options.cwd ?? process.cwd()
  if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > 4_096 || /\0/u.test(cwd)) {
    throw new TypeError("Strict smoke command working directory must be absolute")
  }
  const env = normalizeEnvironment(options.env ?? process.env)
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new TypeError("Strict smoke command signal must be an AbortSignal")
  }
  return Object.freeze({
    command,
    args: Object.freeze(normalizedArgs),
    cwd,
    env,
    timeoutMs,
    maxOutputBytes,
    acceptedExitCodes,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

function normalizeEnvironment(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("Strict smoke command environment is invalid")
  }
  const entries = []
  let totalBytes = 0
  for (const key of Object.keys(value).sort()) {
    const entry = value[key]
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof entry !== "string" || /\0/u.test(entry)) {
      throw new TypeError("Strict smoke command environment entry is invalid")
    }
    totalBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(entry, "utf8") + 2
    if (entries.length >= 512 || totalBytes > 256 * 1024) {
      throw new TypeError("Strict smoke command environment exceeds its bound")
    }
    entries.push([key, entry])
  }
  return Object.freeze(Object.fromEntries(entries))
}

function normalizeAcceptedExitCodes(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) {
    throw new TypeError("Strict smoke accepted exit codes are invalid")
  }
  const normalized = values.map((value) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
      throw new TypeError("Strict smoke accepted exit code is invalid")
    }
    return value
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("Strict smoke accepted exit codes are duplicated")
  }
  return Object.freeze(normalized)
}

function validateCapability(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    value.adapter !== "systemd-cgroup-v2" ||
    typeof value.imageOS !== "string" ||
    typeof value.imageVersion !== "string"
  ) {
    throw new Error("Strict smoke containment capability result is invalid")
  }
  return Object.freeze({
    adapter: value.adapter,
    imageOS: value.imageOS,
    imageVersion: value.imageVersion,
  })
}

function assertProbeOptions(options) {
  if (
    options === null ||
    Array.isArray(options) ||
    typeof options !== "object" ||
    Reflect.ownKeys(options).some((key) => key !== "signal") ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  ) {
    throw new TypeError("Strict smoke containment probe options are invalid")
  }
}

function boundedReceiptValue(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._+-]+$/u.test(value)
  ) {
    return "invalid"
  }
  return value
}
