import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { isAbsolute, join, relative, sep } from "node:path"
import { build } from "esbuild"

export const VERCEL_BUILD_OUTPUT_CONFIG = {
  routes: [{ dest: "/index", src: "/(.*)" }],
  version: 3,
} as const

export const VERCEL_FUNCTION_CONFIG = {
  handler: "index.mjs",
  launcherType: "Nodejs",
  runtime: "nodejs24.x",
} as const

type PathOperations = Pick<typeof import("node:path"), "isAbsolute" | "relative" | "sep">

export async function writeVercelMetadata(outputDir: string): Promise<{
  readonly configPath: string
  readonly functionConfigPath: string
  readonly functionDir: string
}> {
  const configPath = join(outputDir, "config.json")
  const functionDir = join(outputDir, "functions", "index.func")
  const functionConfigPath = join(functionDir, ".vc-config.json")

  await mkdir(functionDir, { recursive: true })
  await Promise.all([
    writeFile(configPath, stringifyJson(VERCEL_BUILD_OUTPUT_CONFIG), "utf8"),
    writeFile(functionConfigPath, stringifyJson(VERCEL_FUNCTION_CONFIG), "utf8"),
  ])

  return { configPath, functionConfigPath, functionDir }
}

export async function validateVercelOutput(outputDir: string): Promise<void> {
  const configPath = join(outputDir, "config.json")
  const functionDir = join(outputDir, "functions", "index.func")
  const functionConfigPath = join(functionDir, ".vc-config.json")
  const entryPath = join(functionDir, "index.mjs")

  validateBuildOutputConfig(await readJson(configPath), configPath)
  validateFunctionConfig(await readJson(functionConfigPath), functionConfigPath)

  const functionDirStats = await lstatOrThrow(
    functionDir,
    `Vercel function directory is missing: ${functionDir}`,
  )
  if (!functionDirStats.isDirectory()) {
    throw new Error(`Vercel function directory must be a directory: ${functionDir}`)
  }

  const entryStats = await lstatOrThrow(entryPath, `Vercel function entry is missing: ${entryPath}`)
  if (!entryStats.isFile()) {
    throw new Error(`Vercel function entry must be a regular file: ${entryPath}`)
  }

  const realFunctionDir = await realpathOrThrow(
    functionDir,
    `Unable to resolve Vercel function directory ${functionDir}`,
  )
  await validateFunctionTree(functionDir, realFunctionDir)
  await validateRuntimeDependencies(entryPath, functionDir, realFunctionDir)
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function readJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    throw errorWithCause(`Unable to read Vercel metadata ${path}`, error)
  }

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw errorWithCause(`Invalid JSON in Vercel metadata ${path}`, error)
  }
}

function validateBuildOutputConfig(value: unknown, configPath: string): void {
  const config = asRecord(value, configPath)
  validateExactProperties(config, ["routes", "version"], configPath)
  if (config.version !== VERCEL_BUILD_OUTPUT_CONFIG.version) {
    throw new Error(`${configPath} property "version" must be 3`)
  }
  if (!Array.isArray(config.routes) || config.routes.length !== 1) {
    throw new Error(`${configPath} property "routes" must contain exactly one catch-all route`)
  }

  const route = asRecord(config.routes[0], `${configPath} property "routes[0]"`)
  validateExactProperties(route, ["src", "dest"], configPath, "routes[0].")
  if (route.src !== VERCEL_BUILD_OUTPUT_CONFIG.routes[0].src) {
    throw new Error(`${configPath} property "routes[0].src" must be "/(.*)"`)
  }
  if (route.dest !== VERCEL_BUILD_OUTPUT_CONFIG.routes[0].dest) {
    throw new Error(`${configPath} property "routes[0].dest" must be "/index"`)
  }
}

function validateFunctionConfig(value: unknown, configPath: string): void {
  const config = asRecord(value, configPath)
  validateExactProperties(config, Object.keys(VERCEL_FUNCTION_CONFIG), configPath)
  for (const [property, expected] of Object.entries(VERCEL_FUNCTION_CONFIG)) {
    if (config[property] !== expected) {
      throw new Error(`${configPath} property "${property}" must be ${JSON.stringify(expected)}`)
    }
  }
}

function validateExactProperties(
  value: Record<string, unknown>,
  allowedProperties: readonly string[],
  location: string,
  propertyPrefix = "",
): void {
  for (const property of Object.keys(value)) {
    if (!allowedProperties.includes(property)) {
      throw new Error(`${location} property "${propertyPrefix}${property}" is not allowed`)
    }
  }
}

function asRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

async function lstatOrThrow(path: string, message: string) {
  try {
    return await lstat(path)
  } catch (error) {
    throw errorWithCause(message, error)
  }
}

async function realpathOrThrow(path: string, message: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw errorWithCause(message, error)
  }
}

async function validateFunctionTree(functionDir: string, realFunctionDir: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const entryStats = await lstat(path)
      if (entryStats.isSymbolicLink()) {
        const target = await realpathOrThrow(
          path,
          `Vercel function symlink cannot be resolved: ${path}`,
        )
        if (!isVercelPathWithin(realFunctionDir, target)) {
          throw new Error(
            `Vercel function symlink resolves outside ${functionDir}: ${path} -> ${target}`,
          )
        }
        continue
      }
      if (entryStats.isDirectory()) await visit(path)
    }
  }

  await visit(functionDir)
}

async function validateRuntimeDependencies(
  entryPath: string,
  functionDir: string,
  realFunctionDir: string,
): Promise<void> {
  let metafile: Awaited<ReturnType<typeof build>>["metafile"]
  try {
    const result = await build({
      absPaths: ["metafile"],
      bundle: true,
      entryPoints: [entryPath],
      external: ["node:*"],
      format: "esm",
      logLevel: "silent",
      metafile: true,
      platform: "node",
      supported: { "dynamic-import": false },
      write: false,
    })
    metafile = result.metafile
  } catch (error) {
    throw errorWithCause(`Unable to resolve Vercel function dependencies from ${entryPath}`, error)
  }

  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    validateExternalDependencies(inputPath, input.imports)
    if (isBundledDataModule(inputPath)) continue
    if (isVirtualInput(inputPath)) {
      throw new Error(`Vercel function contains unsupported virtual input ${inputPath}`)
    }

    const realInputPath = await realpathOrThrow(
      inputPath,
      `Unable to resolve Vercel function dependency input ${inputPath}`,
    )
    if (!isVercelPathWithin(realFunctionDir, realInputPath)) {
      throw new Error(
        `Vercel function dependency resolves outside ${functionDir}: ${inputPath} -> ${realInputPath}`,
      )
    }
  }
}

function validateExternalDependencies(
  importer: string,
  dependencies: ReadonlyArray<{ readonly external?: boolean; readonly path: string }>,
): void {
  for (const dependency of dependencies) {
    if (!dependency.external) continue
    if (dependency.path === "module" || dependency.path === "node:module") {
      throw new Error(
        `Vercel function runtime loader ${JSON.stringify(dependency.path)} is forbidden from ${importer}`,
      )
    }
    if (dependency.path === "<runtime>") {
      throw new Error(`Vercel function nonliteral dynamic import is forbidden from ${importer}`)
    }
    if (!isBuiltin(dependency.path)) {
      throw new Error(
        `Vercel function external dependency ${JSON.stringify(dependency.path)} from ${importer} is not an allowed Node builtin`,
      )
    }
  }
}

function isBundledDataModule(path: string): boolean {
  return path.startsWith("<data:") && path.endsWith(">")
}

function isVirtualInput(path: string): boolean {
  return path.startsWith("<") && path.endsWith(">")
}

export function isVercelPathWithin(
  root: string,
  path: string,
  pathOperations: PathOperations = { isAbsolute, relative, sep },
): boolean {
  const pathRelativeToRoot = pathOperations.relative(root, path)
  return (
    !pathOperations.isAbsolute(pathRelativeToRoot) &&
    (pathRelativeToRoot === "" ||
      (!pathRelativeToRoot.startsWith(`..${pathOperations.sep}`) && pathRelativeToRoot !== ".."))
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorWithCause(message: string, cause: unknown): Error {
  return new Error(`${message}: ${errorMessage(cause)}`, { cause })
}
