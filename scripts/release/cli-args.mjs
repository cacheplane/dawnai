import path from "node:path"
import { isExactSemver, parseSemver } from "./semver.mjs"

const DEFAULT_REPOSITORY = "cacheplane/dawnai"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
const ARGUMENTS = new Set(["observation", "format", "version", "commit-sha", "repository"])

export function parseShadowArguments(argv, cwd) {
  if (!Array.isArray(argv)) throw new CliInputError("Arguments must be an array")
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (typeof flag !== "string" || !flag.startsWith("--") || value === undefined) {
      throw new CliInputError("Every option requires one value")
    }
    const name = flag.slice(2)
    if (!ARGUMENTS.has(name)) throw new CliInputError("Unknown option")
    if (values.has(name)) throw new CliInputError("Duplicate option")
    values.set(name, value)
  }
  const format = values.get("format")
  if (!["json", "markdown"].includes(format))
    throw new CliInputError("Format must be json or markdown")
  const observation = values.get("observation")
  const version = values.get("version")
  const commitSha = values.get("commit-sha")
  const repository = values.get("repository") ?? DEFAULT_REPOSITORY
  if (!REPOSITORY_PATTERN.test(repository)) throw new CliInputError("Invalid repository")
  if ((version === undefined) !== (commitSha === undefined))
    throw new CliInputError("Version and commit SHA must be supplied together")
  if (observation !== undefined && (version !== undefined || values.has("repository")))
    throw new CliInputError("Observation cannot be combined with live options")
  if (version !== undefined && (!isExactSemver(version) || parseSemver(version).build.length > 0))
    throw new CliInputError("Version must be an exact SemVer without build metadata")
  if (commitSha !== undefined && !SHA_PATTERN.test(commitSha))
    throw new CliInputError("Commit SHA must be 40 lowercase hexadecimal characters")
  return {
    format,
    repository,
    ...(observation === undefined ? {} : { observation: fixturePath(observation, cwd) }),
    ...(version === undefined ? {} : { version, commitSha }),
  }
}

function fixturePath(value, cwd) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value))
    throw new CliInputError("Invalid observation path")
  const resolved = path.resolve(cwd, value)
  const relative = path.relative(cwd, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(resolved) !== ".json")
    throw new CliInputError("Observation path must be a JSON file inside the repository")
  return resolved
}

export class CliInputError extends Error {}
