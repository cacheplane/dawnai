import { execFile } from "node:child_process"
import { isAbsolute } from "node:path"

import { isExactSemver, parseSemver } from "../semver.mjs"

const SHA_PATTERN = /^[0-9a-f]{40}$/u
const MAX_ROOT_BYTES = 4_096
const MAX_MESSAGE_BYTES = 4_096
const MAX_OUTPUT_BYTES = 1024 * 1024
const COMMAND_TIMEOUT_MS = 15_000
const PRODUCTION_MAIN_REF = "refs/remotes/origin/main"
const RELEASE_TAGGER_NAME = "Dawn Release Bot"
const RELEASE_TAGGER_EMAIL = "dawn-release-bot@users.noreply.github.com"

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
        if (existingSha.commitSha !== sha) throw tagConflict(tag)
        return Object.freeze({ status: "present", tag, sha })
      }

      await execute([
        "-c",
        `user.name=${RELEASE_TAGGER_NAME}`,
        "-c",
        `user.email=${RELEASE_TAGGER_EMAIL}`,
        "tag",
        "--annotate",
        tag,
        "--message",
        message,
        sha,
      ])
      return Object.freeze({ status: "created", tag, sha })
    },

    async pushTag({ tag }) {
      validateCandidateTag(tag)
      const local = await resolveLocalTag(execute, tag)
      if (local === null) throw new Error(`Candidate tag ${tag} does not exist locally`)
      await requireMainAncestry(execute, local.commitSha)

      const remote = parseRemoteTag(
        await execute(["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]),
        tag,
      )
      if (remote !== null) {
        requireExactRemoteTag(remote, local, tag)
        return Object.freeze({ status: "present", tag, sha: local.commitSha })
      }

      await execute(["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`])
      const pushed = parseRemoteTag(
        await execute(["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]),
        tag,
      )
      if (pushed === null) throw new Error(`Remote candidate tag ${tag} is absent after push`)
      requireExactRemoteTag(pushed, local, tag)
      return Object.freeze({ status: "pushed", tag, sha: local.commitSha })
    },
  })
}

async function requireMainAncestry(execute, sha) {
  try {
    await execute(["merge-base", "--is-ancestor", sha, PRODUCTION_MAIN_REF])
  } catch (error) {
    if (exitCode(error) === 1) {
      throw new Error(`Candidate SHA ${sha} is not reachable from main`)
    }
    throw error
  }
}

async function resolveLocalTag(execute, tag) {
  const ref = `refs/tags/${tag}`
  try {
    await execute(["show-ref", "--verify", "--quiet", ref])
  } catch (error) {
    if (exitCode(error) === 1) return null
    throw error
  }
  const objectType = (await execute(["cat-file", "-t", ref])).trim()
  if (objectType !== "tag") {
    throw new Error(`Candidate tag ${tag} must be an annotated Git tag object`)
  }
  const objectSha = exactSha(await execute(["rev-parse", "--verify", ref]))
  const commitSha = exactSha(await execute(["rev-parse", "--verify", `${ref}^{commit}`]))
  return Object.freeze({ objectSha, commitSha })
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
      if (direct !== null) throw new Error("Remote candidate tag identity is ambiguous")
      direct = match[1]
    } else {
      if (peeled !== null) throw new Error("Remote candidate tag identity is ambiguous")
      peeled = match[1]
    }
  }
  if (direct === null || peeled === null) {
    throw new Error("Remote candidate tag identity must be one exact direct/peeled pair")
  }
  return Object.freeze({ objectSha: direct, commitSha: peeled })
}

function requireExactRemoteTag(remote, local, tag) {
  if (remote.objectSha !== local.objectSha) {
    throw new Error(`Remote candidate tag ${tag} resolves to another annotated tag object`)
  }
  if (remote.commitSha !== local.commitSha) throw tagConflict(tag)
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
