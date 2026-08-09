import { spawn } from "node:child_process"

export class GitReadError extends Error {
  constructor(message, options) {
    super(message)
    this.name = "GitReadError"
    if (options?.cause !== undefined) {
      this.cause = options.cause
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
  return {
    showFile({ ref, path }) {
      assertValidRef(ref)
      assertValidPath(path)
      return run("git", ["show", `${ref}:${path}`], { cwd: root })
    },
    listTree({ ref }) {
      assertValidRef(ref)
      return run("git", ["ls-tree", "-r", "--name-only", ref], { cwd: root })
    },
    firstParent(ref) {
      assertValidRef(ref)
      return run("git", ["rev-parse", "--verify", `${ref}^1`], { cwd: root }).then((output) =>
        output.trim(),
      )
    },
  }
}

function assertValidRef(ref) {
  if (
    typeof ref !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/@{}^~+/-]*$/u.test(ref) ||
    ref.includes("..") ||
    ref.includes("//")
  ) {
    throw new GitInputError(`Invalid Git ref: ${String(ref)}`)
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
        ),
      )
    })
  })
}
