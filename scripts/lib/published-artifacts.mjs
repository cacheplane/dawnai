import { spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

export const packageSets = {
  "ag-ui": ["@dawn-ai/ag-ui"],
  "memory-pgvector-core": ["@dawn-ai/memory-pgvector", "@dawn-ai/memory", "@dawn-ai/langchain"],
  public: null,
  "typescript-tooling": ["@dawn-ai/sdk", "@dawn-ai/core", "@dawn-ai/vite-plugin", "@dawn-ai/cli"],
}

export const MAX_WAIT_DELAY_MS = 59_999
export const NPM_VIEW_TIMEOUT_MS = 15_000
export const MAX_WAIT_TOTAL_MS = 600_000
export const MAX_WAIT_ATTEMPTS = Math.floor(MAX_WAIT_TOTAL_MS / NPM_VIEW_TIMEOUT_MS)

const RETRYABLE_NPM_VIEW_CODES = new Set([
  "E404",
  "E429",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
])
const FATAL_NPM_VIEW_CODES = new Set([
  "E401",
  "E403",
  "ECONFIG",
  "EINVALIDJSON",
  "EINVALIDRESPONSE",
  "EUSAGE",
])

const packageFileExpectations = {
  "@dawn-ai/ag-ui": [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/sse.js",
    "dist/sse.d.ts",
    "README.md",
    "package.json",
  ],
  "@dawn-ai/memory-pgvector": ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
  "@dawn-ai/postgres-storage": ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
  "@dawn-ai/memory": ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
  "@dawn-ai/langchain": ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
}

export function resolvePackageSet(name, publicPackages = []) {
  if (name === "public") {
    return publicPackages.map((pkg) => pkg.packageJson.name)
  }

  const packages = packageSets[name]
  if (!packages) {
    throw new Error(
      `Unknown package set "${name}". Known sets: ${Object.keys(packageSets).join(", ")}`,
    )
  }

  return packages
}

export function normalizeCliArgs(args) {
  return args[0] === "--" ? args.slice(1) : args
}

export function expectedFilesForPackage(packageName) {
  return packageFileExpectations[packageName] ?? ["README.md", "package.json"]
}

export function resolveRequestedVersion({ requested, tags }) {
  if (tags && Object.hasOwn(tags, requested)) {
    return tags[requested]
  }

  return requested
}

export async function readPublicPackages(rootDir = repoRoot) {
  const packagesDir = resolve(rootDir, "packages")
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const packages = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const dir = resolve(packagesDir, entry.name)
    const packageJson = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8"))

    if (packageJson.private !== true) {
      packages.push({ dir, packageJson })
    }
  }

  return packages.sort((left, right) => left.packageJson.name.localeCompare(right.packageJson.name))
}

export function assertCleanDependencySpecs(packageName, packageJson) {
  const bad = []

  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const [name, version] of Object.entries(packageJson[field] ?? {})) {
      if (String(version).startsWith("workspace:") || String(version).startsWith("file:")) {
        bad.push(`${field}.${name}@${version}`)
      }
    }
  }

  if (bad.length > 0) {
    throw new Error(`${packageName} contains unpublished dependency specs: ${bad.join(", ")}`)
  }
}

export function validatePackageMetadata(packageName, packageJson, expectedVersion) {
  const failures = []

  for (const field of [
    "name",
    "version",
    "license",
    "repository",
    "homepage",
    "bugs",
    "engines.node",
    "publishConfig.access",
  ]) {
    if (readField(packageJson, field) === undefined) {
      failures.push(`${packageName}: missing package.json ${field}`)
    }
  }

  if (packageJson.name !== undefined && packageJson.name !== packageName) {
    failures.push(`${packageName}: package.json name is ${packageJson.name}`)
  }

  if (
    expectedVersion !== undefined &&
    packageJson.version !== undefined &&
    packageJson.version !== expectedVersion
  ) {
    failures.push(
      `${packageName}: package.json version is ${packageJson.version}, expected ${expectedVersion}`,
    )
  }

  if (!packageJson.exports && !packageJson.bin) {
    failures.push(`${packageName}: package.json must expose exports or bin`)
  }

  if (packageJson.exports && exportsRequireTypes(packageJson.exports) && !packageJson.types) {
    failures.push(`${packageName}: package.json has exports but no top-level types`)
  }

  return failures
}

export async function assertInstalledCoreResolution({ consumerRoot, expectedCoreVersion }) {
  const rootRequire = createRequire(pathToFileURL(join(consumerRoot, "package.json")))
  const vitePackageJsonPath = join(
    consumerRoot,
    "node_modules",
    "@dawn-ai",
    "vite-plugin",
    "package.json",
  )
  const viteRequire = createRequire(pathToFileURL(vitePackageJsonPath))
  const rootCoreEntry = await realpath(rootRequire.resolve("@dawn-ai/core"))
  const viteCoreEntry = await realpath(viteRequire.resolve("@dawn-ai/core"))

  if (viteCoreEntry !== rootCoreEntry) {
    throw new Error(
      `Vite resolves @dawn-ai/core to ${viteCoreEntry}, expected root artifact ${rootCoreEntry}`,
    )
  }

  const coreManifestPath = join(consumerRoot, "node_modules", "@dawn-ai", "core", "package.json")
  const coreManifest = JSON.parse(await readFile(coreManifestPath, "utf8"))
  if (coreManifest.version !== expectedCoreVersion) {
    throw new Error(
      `resolved @dawn-ai/core version ${coreManifest.version}, expected version ${expectedCoreVersion}`,
    )
  }

  return rootCoreEntry
}

function exportsRequireTypes(exportsField) {
  return exportedTargets(exportsField).some((target) => !target.endsWith(".json"))
}

function exportedTargets(value) {
  if (typeof value === "string") {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => exportedTargets(entry))
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => exportedTargets(entry))
  }

  return []
}

export function readField(value, path) {
  return path.split(".").reduce((current, part) => current?.[part], value)
}

export async function npmJson(args, options = {}) {
  const output = await run("npm", [...args, "--json"], { ...options, stdio: "pipe" })
  return JSON.parse(output || "null")
}

export async function npmView(
  packageName,
  { requestTimeoutMs = NPM_VIEW_TIMEOUT_MS, npmJsonImpl = npmJson } = {},
) {
  try {
    const [versions, tags] = await Promise.all([
      npmJsonImpl(["view", packageName, "versions"], { timeoutMs: requestTimeoutMs }),
      npmJsonImpl(["view", packageName, "dist-tags"], { timeoutMs: requestTimeoutMs }),
    ])

    if (!Array.isArray(versions) || versions.some((version) => typeof version !== "string")) {
      throw registryError(`${packageName} npm versions response must be an array of strings`, {
        code: "EINVALIDRESPONSE",
        retryable: false,
      })
    }

    if (!isPlainObject(tags)) {
      throw registryError(`${packageName} npm dist-tags response must be an object`, {
        code: "EINVALIDRESPONSE",
        retryable: false,
      })
    }

    return { tags, versions }
  } catch (error) {
    throw normalizeNpmViewError(packageName, error)
  }
}

export function isRetryableNpmViewError(error) {
  const statusCode = error?.statusCode
  if (statusCode === 404 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) {
    return true
  }
  if (statusCode === 401 || statusCode === 403) {
    return false
  }

  const code = typeof error?.code === "string" ? error.code.toUpperCase() : ""
  if (RETRYABLE_NPM_VIEW_CODES.has(code) || /^E5\d\d$/.test(code)) {
    return true
  }
  if (FATAL_NPM_VIEW_CODES.has(code)) {
    return false
  }

  return error?.retryable === true
}

export function validatePublishedWaitOptions({
  attempts,
  delayMs,
  requestTimeoutMs = NPM_VIEW_TIMEOUT_MS,
}) {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new TypeError("attempts must be a positive integer within the safe integer range")
  }
  if (attempts > MAX_WAIT_ATTEMPTS) {
    throw new RangeError(`attempts must be at most ${MAX_WAIT_ATTEMPTS}; received ${attempts}`)
  }

  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new TypeError("delayMs must be a non-negative integer within the safe integer range")
  }
  if (delayMs > MAX_WAIT_DELAY_MS) {
    throw new RangeError(`delayMs must be at most ${MAX_WAIT_DELAY_MS}ms; received ${delayMs}ms`)
  }

  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError("requestTimeoutMs must be a positive integer within the safe integer range")
  }
  if (requestTimeoutMs > NPM_VIEW_TIMEOUT_MS) {
    throw new RangeError(
      `requestTimeoutMs must be at most ${NPM_VIEW_TIMEOUT_MS}ms; received ${requestTimeoutMs}ms`,
    )
  }

  const worstCaseMs = attempts * requestTimeoutMs + (attempts - 1) * delayMs
  if (!Number.isSafeInteger(worstCaseMs) || worstCaseMs > MAX_WAIT_TOTAL_MS) {
    throw new RangeError(
      `worst-case wait is ${worstCaseMs}ms; limit is ${MAX_WAIT_TOTAL_MS}ms ` +
        `(${attempts} request(s) × ${requestTimeoutMs}ms + ${attempts - 1} delay(s) × ${delayMs}ms)`,
    )
  }

  return { worstCaseMs }
}

export async function waitForPublishedVersions({
  packages,
  version,
  attempts,
  delayMs,
  requestTimeoutMs = NPM_VIEW_TIMEOUT_MS,
  npmViewImpl = npmView,
  delay = defaultDelay,
}) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new TypeError("packages must be a non-empty array")
  }

  if (packages.some((packageName) => typeof packageName !== "string" || packageName.length === 0)) {
    throw new TypeError("each package must be a non-empty string")
  }

  if (typeof version !== "string" || version.length === 0) {
    throw new TypeError("version must be a non-empty string")
  }

  validatePublishedWaitOptions({ attempts, delayMs, requestTimeoutMs })

  if (typeof npmViewImpl !== "function") {
    throw new TypeError("npmViewImpl must be a function")
  }

  if (typeof delay !== "function") {
    throw new TypeError("delay must be a function")
  }

  const missing = new Set(packages)
  const lastErrors = new Map()

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outstanding = [...missing]
    const results = await Promise.all(
      outstanding.map(async (packageName) => {
        try {
          const view = await withTimeout(
            () => npmViewImpl(packageName, { requestTimeoutMs }),
            requestTimeoutMs,
            packageName,
          )
          assertNpmViewResult(packageName, view)
          return { packageName, visible: view?.versions?.includes(version) === true }
        } catch (error) {
          return { error, packageName, visible: false }
        }
      }),
    )

    const fatal = results.find((result) => result.error && !isRetryableNpmViewError(result.error))
    if (fatal) {
      throw fatal.error
    }

    for (const result of results) {
      if (result.visible) {
        missing.delete(result.packageName)
        lastErrors.delete(result.packageName)
      } else if (result.error) {
        lastErrors.set(result.packageName, result.error)
      }
    }

    if (missing.size === 0) {
      return
    }

    if (attempt < attempts) {
      await delay(delayMs)
    }
  }

  const missingDetails = [...missing].map((packageName) => {
    const detail = lastErrors.get(packageName)?.message
    return `${packageName}@${version}${detail ? ` (last registry error: ${detail})` : ""}`
  })
  const scheduledDelayMs = Math.max(0, attempts - 1) * delayMs
  const timeoutError = new Error(
    `Timed out waiting for published version after ${attempts} attempts and ${scheduledDelayMs}ms scheduled delay; missing: ${missingDetails.join(", ")}`,
  )
  timeoutError.code = [...missing].every(
    (packageName) => lastErrors.get(packageName)?.code === "ETIMEDOUT",
  )
    ? "ETIMEDOUT"
    : "EPUBLISHWAIT"
  timeoutError.lastErrors = new Map(lastErrors)
  throw timeoutError
}

function assertNpmViewResult(packageName, view) {
  if (!view || !Array.isArray(view.versions)) {
    throw registryError(`${packageName} npm view versions must be an array`, {
      code: "EINVALIDRESPONSE",
      retryable: false,
    })
  }

  if (view.versions.some((version) => typeof version !== "string")) {
    throw registryError(`${packageName} npm view versions must contain only strings`, {
      code: "EINVALIDRESPONSE",
      retryable: false,
    })
  }
}

function withTimeout(operation, timeoutMs, packageName) {
  let timer
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          registryError(`${packageName} npm view timed out after ${timeoutMs}ms`, {
            code: "ETIMEDOUT",
            retryable: true,
          }),
        )
      }, timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function normalizeNpmViewError(packageName, error) {
  if (typeof error?.retryable === "boolean") {
    return error
  }

  if (error instanceof SyntaxError) {
    return registryError(`${packageName} npm view returned invalid JSON: ${error.message}`, {
      cause: error,
      code: "EINVALIDJSON",
      retryable: false,
    })
  }

  const details = `${error?.stderr ?? ""}\n${error?.message ?? ""}`
  const recognizedCode = details.match(
    /\b(E404|E429|E5\d\d|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|E401|E403|ECONFIG|EUSAGE)\b/i,
  )?.[1]
  const statusCodeText =
    recognizedCode?.match(/^E([45]\d\d)$/i)?.[1] ??
    details.match(/\b(?:http(?: status)?|status(?: code)?|npm error)\s*:?\s*([45]\d\d)\b/i)?.[1]
  const code = recognizedCode?.toUpperCase() ?? error?.code ?? "ENPMVIEW"
  const statusCode = statusCodeText === undefined ? undefined : Number(statusCodeText)
  const normalized = registryError(`${packageName} npm view failed: ${error?.message ?? error}`, {
    cause: error,
    code,
    ...(statusCode !== undefined ? { statusCode } : {}),
  })
  normalized.retryable = isRetryableNpmViewError(normalized)
  return normalized
}

function registryError(message, options = {}) {
  const error = new Error(
    message,
    options.cause === undefined ? undefined : { cause: options.cause },
  )
  if (options.code !== undefined) {
    error.code = options.code
  }
  if (options.statusCode !== undefined) {
    error.statusCode = options.statusCode
  }
  if (options.retryable !== undefined) {
    error.retryable = options.retryable
  }
  return error
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function defaultDelay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export async function makeTempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeDir(path) {
  await rm(path, { recursive: true, force: true })
}

export async function run(command, args, options = {}) {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new TypeError("timeoutMs must be a positive safe integer")
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childProcessEnv(
        { ...process.env, ...options.env },
        { includeOpenAi: options.includeOpenAi },
      ),
      shell: process.platform === "win32",
      stdio: options.stdio === "pipe" ? ["ignore", "pipe", "pipe"] : "inherit",
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let forceKillTimer
    const timeoutTimer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill("SIGTERM")
            forceKillTimer = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL")
              }
            }, 250)
            forceKillTimer.unref()
          }, options.timeoutMs)

    const rejectOnce = (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    }

    const cleanupTimers = () => {
      clearTimeout(timeoutTimer)
      clearTimeout(forceKillTimer)
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      cleanupTimers()
      if (timedOut) {
        rejectOnce(commandTimeoutError(command, args, options.timeoutMs, stderr, error))
      } else {
        rejectOnce(error)
      }
    })
    child.on("close", (code) => {
      cleanupTimers()
      if (timedOut) {
        rejectOnce(commandTimeoutError(command, args, options.timeoutMs, stderr))
        return
      }

      if (code === 0) {
        if (!settled) {
          settled = true
          resolvePromise(stdout)
        }
        return
      }

      const error = new Error(
        `${command} ${args.join(" ")} failed with exit code ${code}\n${stderr}`,
      )
      error.command = command
      error.exitCode = code
      error.stderr = stderr
      rejectOnce(error)
    })
  })
}

function commandTimeoutError(command, args, timeoutMs, stderr, cause) {
  const error = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`, {
    ...(cause !== undefined ? { cause } : {}),
  })
  error.code = "ETIMEDOUT"
  error.command = command
  error.stderr = stderr
  error.timeoutMs = timeoutMs
  return error
}

function childProcessEnv(env, options = {}) {
  const { OPENAI_API_KEY: openAiApiKey, ...sanitized } = env
  if (options.includeOpenAi && openAiApiKey !== undefined) {
    return { ...sanitized, OPENAI_API_KEY: openAiApiKey }
  }

  return sanitized
}
