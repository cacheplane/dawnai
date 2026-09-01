import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { TextDecoder } from "node:util"

export const METADATA_ONLY_PATHS = Object.freeze(["apps/web/app/seo/lastmod.generated.json"])

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const METADATA_ONLY_PATH_SET = new Set(METADATA_ONLY_PATHS)

function expectCommitSha(value, name) {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`Pull-request ${name} SHA must be exactly 40 lowercase hexadecimal characters`)
  }
  return value
}

function parseNulDelimitedPaths(output) {
  if (output.length === 0) return []
  if (output[output.length - 1] !== 0) {
    throw new Error("Malformed NUL-delimited Git diff output: missing final NUL byte")
  }

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const paths = []
  let start = 0
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue
    if (index === start) {
      throw new Error("Malformed NUL-delimited Git diff output: empty filename")
    }
    try {
      paths.push(decoder.decode(output.subarray(start, index)))
    } catch (cause) {
      throw new Error("Malformed Git diff filename: expected valid UTF-8", { cause })
    }
    start = index + 1
  }
  return paths
}

async function runGitCommand(file, args) {
  return {
    stdout: execFileSync(file, args, {
      encoding: "buffer",
      maxBuffer: 32 * 1_024 * 1_024,
      timeout: 30_000,
    }),
  }
}

export async function classifyMetadataOnlyScope(request, runCommand = runGitCommand) {
  if (request.event === "push") return false
  if (request.event !== "pull_request") {
    throw new Error(`Unknown CI scope event mode: ${String(request.event)}`)
  }

  const base = expectCommitSha(request.base, "base")
  const head = expectCommitSha(request.head, "head")
  await runCommand("git", ["cat-file", "-e", `${base}^{commit}`])
  await runCommand("git", ["cat-file", "-e", `${head}^{commit}`])
  const { stdout } = await runCommand("git", [
    "diff",
    "--merge-base",
    "--no-renames",
    "--name-only",
    "-z",
    base,
    head,
  ])
  if (!Buffer.isBuffer(stdout)) {
    throw new Error("Malformed Git diff output: expected a Buffer")
  }

  const paths = parseNulDelimitedPaths(stdout)
  return paths.length > 0 && paths.every((path) => METADATA_ONLY_PATH_SET.has(path))
}

function parseCliArgs(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === undefined || !["--event", "--base", "--head"].includes(flag)) {
      throw new Error(`Unknown flag: ${String(flag)}`)
    }
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`Missing value for flag: ${flag}`)
    }
    if (flags.has(flag)) throw new Error(`Duplicate flag: ${flag}`)
    flags.set(flag, value)
  }

  const event = flags.get("--event")
  if (event === undefined) throw new Error("Missing required flag: --event")
  if (event === "push" && (flags.has("--base") || flags.has("--head"))) {
    throw new Error("push scope does not accept pull-request SHA flags")
  }
  return {
    event,
    ...(flags.has("--base") ? { base: flags.get("--base") } : {}),
    ...(flags.has("--head") ? { head: flags.get("--head") } : {}),
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  classifyMetadataOnlyScope(parseCliArgs(process.argv.slice(2)))
    .then((metadataOnly) => process.stdout.write(`${String(metadataOnly)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      )
      process.exitCode = 1
    })
}
