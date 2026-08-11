import { randomUUID } from "node:crypto"
import { link, lstat, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../../output.js"

const DAWN_VERCEL_BUILD_COMMAND = "node node_modules/@dawn-ai/cli/dist/index.js build"

export const RECOMMENDED_VERCEL_CONFIG = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  buildCommand: DAWN_VERCEL_BUILD_COMMAND,
  fluid: true,
} as const

interface VercelConfigFileOps {
  readonly link: typeof link
  readonly lstat: typeof lstat
  readonly readFile: typeof readFile
  readonly rename: typeof rename
  readonly rm: typeof rm
  readonly writeFile: typeof writeFile
}

const defaultFileOps: VercelConfigFileOps = { link, lstat, readFile, rename, rm, writeFile }
let fileOps = defaultFileOps

/** @internal Test seam for deterministic filesystem races and failures. */
export function setVercelConfigFileOpsForTesting(
  overrides: Partial<VercelConfigFileOps>,
): () => void {
  const previousFileOps = fileOps
  fileOps = { ...fileOps, ...overrides }
  return () => {
    fileOps = previousFileOps
  }
}

export async function reconcileVercelConfig(input: {
  readonly appRoot: string
  readonly buildDir: string
  readonly io?: CommandIo
}): Promise<{ readonly artifactPath: string; readonly created: boolean }> {
  const rootPath = join(input.appRoot, "vercel.json")
  const recommendedConfig = formatRecommendedConfig()
  let rootContents: string

  try {
    rootContents = await fileOps.readFile(rootPath, "utf8")
  } catch (error) {
    if (!isMissingFile(error)) throw error
    if (await publishMissingRootConfig(rootPath, recommendedConfig)) {
      return { artifactPath: rootPath, created: true }
    }
    return await reconcileVercelConfig(input)
  }

  return await reconcileExistingRootConfig(input, rootPath, rootContents, recommendedConfig)
}

async function reconcileExistingRootConfig(
  input: { readonly appRoot: string; readonly buildDir: string; readonly io?: CommandIo },
  rootPath: string,
  rootContents: string,
  recommendedConfig: string,
): Promise<{ readonly artifactPath: string; readonly created: boolean }> {
  const referencePath = join(input.buildDir, "vercel.json")
  let config: unknown
  try {
    config = JSON.parse(rootContents)
  } catch (error) {
    throw new CliError(`Could not parse ${rootPath}: ${formatErrorMessage(error)}`, 1, {
      cause: error,
    })
  }

  const record = isRecord(config) ? config : undefined
  const buildCommand = ownProperty(record, "buildCommand")
  const fluid = ownProperty(record, "fluid")
  if (fluid === false) {
    throw new CliError(
      `${rootPath} sets fluid: false, which conflicts with the supported lifecycle; fluid: true is required.`,
    )
  }

  const buildCommandEstablished = hasProvenBuildCommand(buildCommand)
  const fluidEstablished = fluid === true
  if (buildCommandEstablished && fluidEstablished) {
    return { artifactPath: rootPath, created: false }
  }

  await publishReferenceConfig(referencePath, recommendedConfig)
  if (input.io) {
    writeLine(
      input.io.stderr,
      reconciliationWarning({
        buildCommandEstablished,
        fluidEstablished,
        referencePath,
        rootPath,
      }),
    )
  }
  return { artifactPath: referencePath, created: false }
}

async function publishMissingRootConfig(rootPath: string, contents: string): Promise<boolean> {
  const temporaryPath = temporaryConfigPath(rootPath)
  let removeTemporary = false

  try {
    try {
      removeTemporary = true
      await fileOps.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" })
    } catch (error) {
      if (isAlreadyExists(error)) removeTemporary = false
      throw filesystemError("Could not prepare an atomic root config", rootPath, error)
    }

    try {
      await fileOps.link(temporaryPath, rootPath)
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw filesystemError("Could not publish the atomic root config", rootPath, error)
      }

      let rootStats: Awaited<ReturnType<typeof lstat>>
      try {
        rootStats = await fileOps.lstat(rootPath)
      } catch (lstatError) {
        throw filesystemError("Could not inspect concurrent root config", rootPath, lstatError)
      }
      if (rootStats.isSymbolicLink()) {
        throw new CliError(
          `Cannot safely create ${rootPath}: a broken symbolic link already occupies the root config path.`,
          1,
          { cause: error },
        )
      }
      return false
    }

    return true
  } finally {
    if (removeTemporary) await removeTemporaryConfig(temporaryPath)
  }
}

async function publishReferenceConfig(referencePath: string, contents: string): Promise<void> {
  const temporaryPath = temporaryConfigPath(referencePath)
  let removeTemporary = false

  try {
    try {
      removeTemporary = true
      await fileOps.writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" })
    } catch (error) {
      if (isAlreadyExists(error)) removeTemporary = false
      throw filesystemError("Could not prepare an atomic Vercel reference", referencePath, error)
    }

    try {
      await fileOps.rename(temporaryPath, referencePath)
      removeTemporary = false
    } catch (error) {
      throw filesystemError("Could not publish the atomic Vercel reference", referencePath, error)
    }
  } finally {
    if (removeTemporary) await removeTemporaryConfig(temporaryPath)
  }
}

async function removeTemporaryConfig(temporaryPath: string): Promise<void> {
  try {
    await fileOps.rm(temporaryPath, { force: true })
  } catch {
    // A cleanup failure must not hide the root/reference error that caused it.
  }
}

function temporaryConfigPath(targetPath: string): string {
  return join(dirname(targetPath), `.dawn-vercel-config-${randomUUID()}.tmp`)
}

function filesystemError(action: string, targetPath: string, cause: unknown): CliError {
  return new CliError(`${action} at ${targetPath}: ${formatErrorMessage(cause)}`, 1, { cause })
}

function formatRecommendedConfig(): string {
  return `${JSON.stringify(RECOMMENDED_VERCEL_CONFIG, null, 2)}\n`
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ownProperty(record: Readonly<Record<string, unknown>> | undefined, key: string): unknown {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined
}

function hasProvenBuildCommand(value: unknown): boolean {
  if (typeof value !== "string") return false
  const command = value.replace(/^[ \t]+|[ \t]+$/g, "")
  return command.split(/[ \t]+/).join(" ") === DAWN_VERCEL_BUILD_COMMAND
}

function reconciliationWarning(input: {
  readonly buildCommandEstablished: boolean
  readonly fluidEstablished: boolean
  readonly referencePath: string
  readonly rootPath: string
}): string {
  const unavailableContracts = [
    ...(input.buildCommandEstablished
      ? []
      : [
          'the buildCommand contract (a string command demonstrably invoking "node_modules/@dawn-ai/cli/dist/index.js build")',
        ]),
    ...(input.fluidEstablished ? [] : ["the required fluid: true contract"]),
  ]
  const fluidGuidance = input.fluidEstablished
    ? ""
    : " Fluid cannot be guaranteed from source, so deployment portability cannot be guaranteed; Dashboard defaults do not establish the committed contract."

  return `Warning: ${input.rootPath} is user-owned and was not modified. Could not establish ${unavailableContracts.join(" and ")}. Wrote the exact recommended reference to ${input.referencePath}; update the committed root config to establish these contracts.${fluidGuidance}`
}
