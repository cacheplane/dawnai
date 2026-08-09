import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"

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
  }
}

export class GitInputError extends GitReadError {
  constructor(message) {
    super(message)
    this.name = "GitInputError"
  }
}

export function createGitReader({ root, run = runCommand }) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new GitInputError("Git reader root must be an absolute path")
  }
  const options = { cwd: root, shell: false }
  return {
    showFile({ ref, path }) {
      assertValidRef(ref)
      assertValidPath(path)
      return run("git", ["show", `${ref}:${path}`], options)
    },
    listTree({ ref }) {
      assertValidRef(ref)
      return run("git", ["ls-tree", "-r", "--name-only", ref], options)
    },
    firstParent(ref) {
      assertValidRef(ref)
      return run("git", ["rev-parse", "--verify", `${ref}^1`], options).then((output) =>
        exactCommit(output),
      )
    },
    isAncestor({ ancestor, descendant }) {
      assertValidRef(ancestor)
      assertValidRef(descendant)
      return run("git", ["merge-base", "--is-ancestor", ancestor, descendant], options).then(
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
      return run(
        "git",
        ["rev-list", "--first-parent", `--max-count=${maxCount}`, ref],
        options,
      ).then((output) =>
        output
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => exactCommit(line)),
      )
    },
    resolveTag({ tag }) {
      assertValidTag(tag)
      return run("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], options).then(
        (output) => exactCommit(output),
      )
    },
  }
}

function assertValidRef(ref) {
  if (
    typeof ref !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+^/-]*$/u.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref
      .split("/")
      .some((segment) => segment === "" || segment.startsWith(".") || segment.endsWith(".lock"))
  ) {
    throw new GitInputError(`Invalid Git ref: ${String(ref)}`)
  }
}

function assertValidTag(tag) {
  try {
    assertValidRef(tag)
  } catch {
    throw new GitInputError(`Invalid Git tag: ${String(tag)}`)
  }
  if (tag.startsWith("refs/") || tag.includes("^")) {
    throw new GitInputError(`Invalid Git tag: ${String(tag)}`)
  }
}

function assertValidPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GitInputError(`Invalid repository path: ${String(path)}`)
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      reject(new GitReadError(`Git read failed: ${error.message}`, { cause: error }))
    })
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(
        new GitReadError(
          `Git read failed with exit code ${code}: ${stderr.trim() || "no error output"}`,
          {
            exitCode: code,
          },
        ),
      )
    })
  })
}

function exactCommit(output) {
  const value = output.trim()
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new GitReadError("Git did not return an exact commit identity")
  }
  return value
}
