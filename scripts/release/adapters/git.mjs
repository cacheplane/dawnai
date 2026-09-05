import { execFile } from "node:child_process"
import { isAbsolute } from "node:path"

export const DEFAULT_GIT_TIMEOUT_MS = 15_000
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

const MAX_GIT_TIMEOUT_MS = 300_000
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_GIT_ROOT_BYTES = 4_096
const MAX_GIT_REF_BYTES = 1_024
const MAX_GIT_PATH_BYTES = 4_096

export class GitReadError extends Error {
  constructor(message, options) {
    super(message)
    this.name = "GitReadError"
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
    if (options?.exitCode !== undefined) {
      this.exitCode = options.exitCode
    }
    if (options?.code !== undefined) {
      this.code = options.code
    }
    if (options?.diagnostic !== undefined) {
      this.diagnostic = options.diagnostic
    }
  }
}

export class GitInputError extends GitReadError {
  constructor(message, code = "INVALID_INPUT") {
    super(message, { code })
    this.name = "GitInputError"
  }
}

export function createGitReader({
  root,
  run = runCommand,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_GIT_MAX_OUTPUT_BYTES,
}) {
  assertInputByteLength(root, MAX_GIT_ROOT_BYTES, "Git reader root")
  if (typeof root !== "string" || !isAbsolute(root) || hasControlCharacters(root)) {
    throw new GitInputError("Git reader root must be an absolute path")
  }
  if (typeof run !== "function") {
    throw new GitInputError("Git runner must be a function")
  }
  assertBoundedInteger(timeoutMs, 1, MAX_GIT_TIMEOUT_MS, "Git timeout")
  assertBoundedInteger(maxOutputBytes, 1, MAX_GIT_OUTPUT_BYTES, "Git maximum output bytes")
  const options = {
    cwd: root,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    encoding: "utf8",
    windowsHide: true,
  }
  const read = (args) => executeGit(run, args, options, maxOutputBytes)
  return {
    showFile({ ref, path }, request = {}) {
      assertValidRef(ref)
      assertValidPath(path)
      const overrides = {}
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).some((key) => !["signal", "timeoutMs"].includes(key))
      )
        throw new GitInputError("Invalid Git read options")
      if (request.timeoutMs !== undefined) {
        assertBoundedInteger(request.timeoutMs, 1, MAX_GIT_TIMEOUT_MS, "Git read timeout")
        overrides.timeout = Math.min(timeoutMs, request.timeoutMs)
      }
      if (request.signal !== undefined) {
        if (!(request.signal instanceof AbortSignal))
          throw new GitInputError("Invalid Git read abort signal")
        if (request.signal.aborted) throw gitFailure("ABORTED")
        overrides.signal = request.signal
      }
      return executeGit(
        run,
        ["show", `${ref}:${path}`],
        { ...options, ...overrides },
        maxOutputBytes,
      )
    },
    listTree({ ref }) {
      assertValidRef(ref)
      return read(["ls-tree", "-r", "--name-only", ref])
    },
    firstParent(ref) {
      assertValidRef(ref)
      return read(["rev-parse", "--verify", `${ref}^1`]).then((output) => exactCommit(output))
    },
    isAncestor({ ancestor, descendant }) {
      assertValidRef(ancestor)
      assertValidRef(descendant)
      return read(["merge-base", "--is-ancestor", ancestor, descendant]).then(
        () => true,
        (error) => {
          if (error instanceof GitReadError && error.exitCode === 1) {
            return false
          }
          throw error
        },
      )
    },
    listFirstParentHistory({ ref, maxCount = 1000 }) {
      assertValidRef(ref)
      if (!Number.isSafeInteger(maxCount) || maxCount <= 0 || maxCount > 10_000) {
        throw new GitInputError(`Invalid history limit: ${String(maxCount)}`)
      }
      return read(["rev-list", "--first-parent", `--max-count=${maxCount}`, ref]).then((output) =>
        output
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => exactCommit(line)),
      )
    },
    resolveTag({ tag }) {
      assertValidTag(tag)
      return read(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]).then((output) =>
        exactCommit(output),
      )
    },
  }
}

function assertValidRef(ref) {
  assertInputByteLength(ref, MAX_GIT_REF_BYTES, "Git ref")
  if (
    typeof ref !== "string" ||
    hasControlCharacters(ref) ||
    !/^[A-Za-z0-9][A-Za-z0-9._+^/-]*$/u.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref
      .split("/")
      .some((segment) => segment === "" || segment.startsWith(".") || segment.endsWith(".lock"))
  ) {
    throw new GitInputError("Invalid Git ref")
  }
}

function assertValidTag(tag) {
  assertInputByteLength(tag, MAX_GIT_REF_BYTES, "Git tag")
  try {
    assertValidRef(tag)
  } catch (error) {
    if (error?.code === "INPUT_TOO_LONG") {
      throw error
    }
    throw new GitInputError("Invalid Git tag")
  }
  if (tag.startsWith("refs/") || tag.includes("^")) {
    throw new GitInputError("Invalid Git tag")
  }
}

function assertValidPath(path) {
  assertInputByteLength(path, MAX_GIT_PATH_BYTES, "repository path")
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    hasControlCharacters(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GitInputError("Invalid repository path")
  }
}

function executeGit(run, args, options, maxOutputBytes) {
  return Promise.resolve()
    .then(() => run("git", args, options))
    .then(
      (output) => {
        if (typeof output !== "string") {
          throw gitFailure("MALFORMED_OUTPUT")
        }
        if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
          throw gitFailure("OUTPUT_TOO_LARGE")
        }
        return output
      },
      (error) => {
        throw normalizeRunError(error, args)
      },
    )
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error !== null) {
        if (Buffer.isBuffer(stderr)) {
          try {
            error.stderr = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stderr)
          } catch {
            error.stderr = null
          }
        }
        reject(error)
        return
      }
      try {
        // Exact source hashing must not silently replace invalid UTF-8 or strip a BOM.
        resolve(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout))
      } catch {
        reject(gitFailure("MALFORMED_OUTPUT"))
      }
    })
  })
}

function normalizeRunError(error, args) {
  if (error instanceof GitReadError && error.code === "MALFORMED_OUTPUT")
    return gitFailure("MALFORMED_OUTPUT")
  const exitCode = Number.isInteger(error?.exitCode)
    ? error.exitCode
    : Number.isInteger(error?.code)
      ? error.code
      : undefined
  let code = "SPAWN_ERROR"
  if (error?.code === "ABORT_ERR") {
    code = "ABORTED"
  } else if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    code = "OUTPUT_TOO_LARGE"
  } else if (
    error?.code === "ETIMEDOUT" ||
    (error?.killed === true && error?.signal !== undefined)
  ) {
    code = "TIMEOUT"
  } else if (exitCode !== undefined) {
    code = isExactMissingHistoryRef(error, args, exitCode) ? "REF_NOT_FOUND" : "EXIT_NONZERO"
  }
  return gitFailure(code, { exitCode, diagnostic: redactStderr(error?.stderr) })
}

function isExactMissingHistoryRef(error, args, exitCode) {
  return (
    exitCode === 128 &&
    args[0] === "rev-list" &&
    typeof error?.stderr === "string" &&
    /^fatal: (?:bad revision|ambiguous argument) /u.test(error.stderr)
  )
}

function gitFailure(code, { exitCode, diagnostic } = {}) {
  return new GitReadError(`Git read failed (${code})`, {
    code,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(diagnostic === null || diagnostic === undefined ? {} : { diagnostic }),
  })
}

function redactStderr(value) {
  return typeof value === "string" && value.length > 0 ? "Git stderr was redacted" : null
}

function exactCommit(output) {
  const value = output.trim()
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw gitFailure("MALFORMED_OUTPUT")
  }
  return value
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GitInputError(`Invalid ${label}: ${String(value)}`)
  }
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}

function assertInputByteLength(value, maximum, label) {
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > maximum) {
    throw new GitInputError(`${label} exceeds byte limit`, "INPUT_TOO_LONG")
  }
}
