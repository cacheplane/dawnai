import { execFile } from "node:child_process"
import { isAbsolute } from "node:path"

import { isExactSemver, parseSemver } from "../semver.mjs"

const SHA_PATTERN = /^[0-9a-f]{40}$/u
const MAX_ROOT_BYTES = 4_096
const MAX_MESSAGE_BYTES = 4_096
const MAX_OUTPUT_BYTES = 1024 * 1024
const COMMAND_TIMEOUT_MS = 15_000

export function createCandidateTagWriter({ root, run = runCommand }) {
  validateRoot(root)
  if (typeof run !== "function") throw new TypeError("Git tag runner must be a function")

  const options = {
    cwd: root,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: "utf8",
    windowsHide: true,
  }
  const execute = async (args) => {
    const output = await run("git", args, options)
    if (typeof output !== "string") throw new Error("Git tag operation returned malformed output")
    if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
      throw new Error("Git tag operation exceeded its output limit")
    }
    return output
  }

  return Object.freeze({
    async createAnnotatedTag({ tag, sha, message }) {
      validateCandidateTag(tag)
      validateSha(sha)
      validateMessage(message)
      await requireMainAncestry(execute, sha)

      const existingSha = await resolveLocalTag(execute, tag)
      if (existingSha !== null) {
        if (existingSha !== sha) throw tagConflict(tag)
        return Object.freeze({ status: "present", tag, sha })
      }

      await execute(["tag", "--annotate", tag, "--message", message, sha])
      return Object.freeze({ status: "created", tag, sha })
    },

    async pushTag({ tag }) {
      validateCandidateTag(tag)
      const sha = await resolveLocalTag(execute, tag)
      if (sha === null) throw new Error(`Candidate tag ${tag} does not exist locally`)
      await requireMainAncestry(execute, sha)

      const remote = parseRemoteTag(
        await execute(["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]),
        tag,
      )
      if (remote !== null) {
        if (remote !== sha) throw tagConflict(tag)
        return Object.freeze({ status: "present", tag, sha })
      }

      await execute(["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`])
      return Object.freeze({ status: "pushed", tag, sha })
    },
  })
}

async function requireMainAncestry(execute, sha) {
  try {
    await execute(["merge-base", "--is-ancestor", sha, "refs/heads/main"])
  } catch (error) {
    if (exitCode(error) === 1) {
      throw new Error(`Candidate SHA ${sha} is not reachable from main`)
    }
    throw error
  }
}

async function resolveLocalTag(execute, tag) {
  try {
    await execute(["show-ref", "--verify", "--quiet", `refs/tags/${tag}`])
  } catch (error) {
    if (exitCode(error) === 1) return null
    throw error
  }
  return exactSha(await execute(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]))
}

function parseRemoteTag(output, tag) {
  if (output.length === 0) return null
  const directRef = `refs/tags/${tag}`
  const peeledRef = `${directRef}^{}`
  let direct = null
  let peeled = null
  for (const line of output.split("\n").filter((entry) => entry.length > 0)) {
    const match = /^([0-9a-f]{40})\t(.+)$/u.exec(line)
    if (match === null || (match[2] !== directRef && match[2] !== peeledRef)) {
      throw new Error("Remote candidate tag identity is malformed")
    }
    if (match[2] === directRef) {
      if (direct !== null && direct !== match[1]) {
        throw new Error("Remote candidate tag identity is ambiguous")
      }
      direct = match[1]
    } else {
      if (peeled !== null && peeled !== match[1]) {
        throw new Error("Remote candidate tag identity is ambiguous")
      }
      peeled = match[1]
    }
  }
  return peeled ?? direct
}

function validateCandidateTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    throw new TypeError("Candidate tag must use exact v<SemVer> syntax")
  }
  const version = tag.slice(1)
  if (!isExactSemver(version) || parseSemver(version).build.length > 0 || tag !== `v${version}`) {
    throw new TypeError("Candidate tag must use exact v<SemVer> syntax without build metadata")
  }
}

function validateSha(sha) {
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
    throw new TypeError("Candidate SHA must be a full lowercase hexadecimal SHA")
  }
}

function validateMessage(message) {
  if (
    typeof message !== "string" ||
    message.trim().length === 0 ||
    message.includes("\0") ||
    Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES
  ) {
    throw new TypeError("Candidate tag message must be a non-empty bounded string")
  }
}

function validateRoot(root) {
  if (
    typeof root !== "string" ||
    !isAbsolute(root) ||
    hasControlCharacters(root) ||
    Buffer.byteLength(root, "utf8") > MAX_ROOT_BYTES
  ) {
    throw new TypeError("Git tag writer root must be a bounded absolute path")
  }
}

function exactSha(output) {
  const sha = output.trim()
  if (!SHA_PATTERN.test(sha)) throw new Error("Candidate tag did not resolve to an exact SHA")
  return sha
}

function exitCode(error) {
  return Number.isInteger(error?.exitCode)
    ? error.exitCode
    : Number.isInteger(error?.code)
      ? error.code
      : null
}

function tagConflict(tag) {
  return new Error(`Candidate tag ${tag} already resolves to another commit`)
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}
