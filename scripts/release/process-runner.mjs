import { execFile, spawn } from "node:child_process"

export const PREPARATION_COMMAND_TIMEOUT_MS = 10 * 60_000
export const PREPARATION_OVERALL_TIMEOUT_MS = 25 * 60_000
export const PREPARATION_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000
const MAX_OVERALL_TIMEOUT_MS = 60 * 60_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const TERMINATION_GRACE_MS = 250
const TERMINATION_FORCE_MS = 2_000
const TERMINATION_POLL_MS = 20

export function createReleasePreparationRunner({
  commandTimeoutMs = PREPARATION_COMMAND_TIMEOUT_MS,
  overallTimeoutMs = PREPARATION_OVERALL_TIMEOUT_MS,
  maxOutputBytes = PREPARATION_MAX_OUTPUT_BYTES,
  spawnImpl = spawn,
  platform = process.platform,
  runTaskkill = defaultTaskkill,
  now = Date.now,
} = {}) {
  assertBoundedInteger(commandTimeoutMs, 1, MAX_COMMAND_TIMEOUT_MS, "command timeout")
  assertBoundedInteger(overallTimeoutMs, 1, MAX_OVERALL_TIMEOUT_MS, "overall timeout")
  assertBoundedInteger(maxOutputBytes, 1, MAX_OUTPUT_BYTES, "output limit")
  if (
    typeof spawnImpl !== "function" ||
    typeof runTaskkill !== "function" ||
    typeof now !== "function" ||
    !["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"].includes(platform)
  ) {
    throw new TypeError("Preparation runner dependencies are invalid")
  }
  const overallDeadline = now() + overallTimeoutMs

  return function runPreparationCommand(command, args, options = {}) {
    validateInvocation(command, args, options)
    const remainingOverallMs = overallDeadline - now()
    if (remainingOverallMs <= 0) {
      return Promise.reject(new Error("Release preparation overall deadline expired"))
    }
    const timeoutMs = Math.min(commandTimeoutMs, remainingOverallMs)
    return executeCommand({
      command,
      args,
      options,
      timeoutMs,
      maxOutputBytes,
      spawnImpl,
      platform,
      runTaskkill,
    })
  }
}

function executeCommand({
  command,
  args,
  options,
  timeoutMs,
  maxOutputBytes,
  spawnImpl,
  platform,
  runTaskkill,
}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(command, args, {
        cwd: options.cwd,
        env: options.env ?? safeRuntimeEnvironment(),
        detached: platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      reject(new Error("Release preparation command could not be started", { cause: error }))
      return
    }

    let failure
    let settled = false
    let closed = false
    let resolveClosed
    const closedPromise = new Promise((resolvePromise) => {
      resolveClosed = resolvePromise
    })
    let outputBytes = 0
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => {
      void fail(new Error(`Release preparation command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const capture = (target) => (chunk) => {
      if (failure !== undefined) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += bytes.length
      if (outputBytes > maxOutputBytes) {
        void fail(
          new Error(`Release preparation command exceeded its ${maxOutputBytes}-byte output limit`),
        )
        return
      }
      target.push(Buffer.from(bytes))
    }

    child.stdout?.on("data", capture(stdout))
    child.stderr?.on("data", capture(stderr))
    child.once("error", (error) => {
      void fail(new Error("Release preparation command failed to spawn", { cause: error }))
    })
    child.once("close", (code, signal) => {
      closed = true
      resolveClosed()
      if (failure !== undefined) {
        return
      }
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(
          new Error(
            `Release preparation command exited unsuccessfully (${code ?? signal ?? "unknown"})`,
          ),
        )
        return
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })

    async function fail(error) {
      if (failure !== undefined) return
      failure = error
      clearTimeout(timer)
      let rejection = error
      try {
        await terminateProcessTree({
          child,
          closedPromise,
          isClosed: () => closed,
          platform,
          runTaskkill,
        })
      } catch (terminationError) {
        rejection = new AggregateError(
          [error, terminationError],
          "Release preparation command failed and its process tree could not be confirmed stopped",
        )
      }
      if (settled) return
      settled = true
      child.stdout?.destroy()
      child.stderr?.destroy()
      reject(rejection)
    }
  })
}

async function terminateProcessTree({ child, closedPromise, isClosed, platform, runTaskkill }) {
  if (!Number.isSafeInteger(child?.pid) || child.pid < 1) return
  if (platform === "win32") {
    try {
      await runTaskkill(child.pid, TERMINATION_FORCE_MS)
    } finally {
      signalDirectProcess(child, "SIGKILL")
    }
    if (await waitForClosed(closedPromise, isClosed, TERMINATION_FORCE_MS)) return
    throw new Error(`Preparation subprocess tree ${child.pid} did not close after taskkill`)
  }

  signalProcessGroup(child, "SIGTERM")
  if (await waitForProcessGroupExit(child.pid, closedPromise, TERMINATION_GRACE_MS)) return
  signalProcessGroup(child, "SIGKILL")
  if (await waitForProcessGroupExit(child.pid, closedPromise, TERMINATION_FORCE_MS)) return
  throw new Error(`Preparation subprocess group ${child.pid} survived forced termination`)
}

function signalProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code === "ESRCH") return
    signalDirectProcess(child, signal)
  }
}

function signalDirectProcess(child, signal) {
  try {
    child.kill(signal)
  } catch (error) {
    if (error?.code !== "ESRCH") throw error
  }
}

async function waitForProcessGroupExit(pid, closedPromise, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processGroupIsRunning(pid)) return true
    await Promise.race([closedPromise, delay(TERMINATION_POLL_MS)])
  }
  return !processGroupIsRunning(pid)
}

function processGroupIsRunning(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    if (error?.code === "EPERM") return true
    throw error
  }
}

async function waitForClosed(closedPromise, isClosed, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isClosed()) return true
    await Promise.race([closedPromise, delay(TERMINATION_POLL_MS)])
  }
  return isClosed()
}

function defaultTaskkill(pid, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { maxBuffer: 64 * 1024, timeout: timeoutMs, windowsHide: true },
      (error) => (error === null ? resolve() : reject(error)),
    )
  })
}

function safeRuntimeEnvironment() {
  const allowed = [
    "CI",
    "COLORTERM",
    "COMSPEC",
    "FORCE_COLOR",
    "GITHUB_ACTIONS",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
  ]
  return Object.fromEntries(
    allowed.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  )
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function validateInvocation(command, args, options) {
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    throw new TypeError("Preparation command must be a non-empty string")
  }
  if (
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === "string" && !arg.includes("\0"))
  ) {
    throw new TypeError("Preparation command arguments must be strings")
  }
  if (options === null || Array.isArray(options) || typeof options !== "object") {
    throw new TypeError("Preparation command options must be an object")
  }
  if (typeof options.cwd !== "string" || options.cwd.length === 0 || options.cwd.includes("\0")) {
    throw new TypeError("Preparation command cwd must be a non-empty string")
  }
  if (
    options.env !== undefined &&
    (options.env === null || Array.isArray(options.env) || typeof options.env !== "object")
  ) {
    throw new TypeError("Preparation command environment must be an object")
  }
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Preparation runner ${label} is invalid`)
  }
}
