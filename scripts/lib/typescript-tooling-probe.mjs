import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

const DEFAULT_TYPESCRIPT_VERSION = "7.0.2"
const PROBE_FILE = "typescript-tooling-probe.mjs"
const CONSUMER_FILE = "typescript-tooling-consumer.ts"
const TSCONFIG_FILE = "tsconfig.typescript-tooling.json"

export function typescriptToolingSourceFiles() {
  return {
    "shared/tool-inputs.ts": `export interface ContactInput {
  /** Contact email address. */
  email: string
  /** Maximum retry count. */
  retries: number
}

export interface LocalInput {
  /** Local record identifier. */
  id: string
}
`,
    "shared/tools/mapped.ts": `import type { ContactInput } from "../tool-inputs.js"

type OptionalFields<T> = { [K in keyof T]?: T[K] }

/** Update optional contact fields. */
export default async function mapped(
  input: OptionalFields<ContactInput>,
): Promise<{ updated: boolean }> {
  return { updated: input.email !== undefined }
}
`,
    "shared/tools/shadowed.ts": `/** This shared tool must be shadowed. */
export default async function shadowed(
  input: { shared: string },
): Promise<{ source: "shared" }> {
  return { source: "shared" }
}
`,
    "route/tools/fallback.ts": `/** Exercise the neutral root-intersection fallback. */
export default async function fallback(
  input: Map<string, number> & { fixed: string },
): Promise<{ accepted: boolean }> {
  return { accepted: input.has(input.fixed) }
}
`,
    "route/tools/shadowed.ts": `import type { LocalInput } from "../../shared/tool-inputs.js"

/** Local shadow wins. */
export default async function shadowed(
  input: LocalInput,
): Promise<{ source: "local" }> {
  void input
  return { source: "local" }
}
`,
  }
}

export function typescriptToolingProbeSource({
  expectedTypeScriptVersion = DEFAULT_TYPESCRIPT_VERSION,
} = {}) {
  return `import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  extractToolSchemasForRoute,
  extractToolTypesForRoute,
} from "@dawn-ai/core"
import { dawnToolSchemaPlugin } from "@dawn-ai/vite-plugin"
import typescript from "typescript"

const expectedTypeScriptVersion = ${JSON.stringify(expectedTypeScriptVersion)}
const root = dirname(fileURLToPath(import.meta.url))
const routeDir = join(root, "route")
const sharedToolsDir = join(root, "shared")

assert.equal(typescript.version, expectedTypeScriptVersion)

const coreRequire = createRequire(import.meta.resolve("@dawn-ai/core"))
const coreCompilerPackagePath = coreRequire.resolve("typescript/package.json")
const oldCompilerPackagePath = coreRequire.resolve("@typescript/old/package.json")
const coreCompilerManifest = coreRequire(coreCompilerPackagePath)
const oldCompilerManifest = coreRequire(oldCompilerPackagePath)
const coreCompiler = coreRequire("typescript")
const oldCompiler = coreRequire("@typescript/old")
assert.equal(coreCompilerManifest.name, "@typescript/typescript6")
assert.equal(coreCompilerManifest.version, "6.0.2")
assert.equal(oldCompilerManifest.name, "typescript")
assert.equal(oldCompilerManifest.version, "6.0.2")
assert.equal(coreCompiler.version, "6.0.2")
assert.equal(oldCompiler.version, "6.0.2")
assert.equal(typeof coreCompiler.createProgram, "function")
assert.equal(typeof coreCompiler.createSourceFile, "function")
assert.equal(typeof oldCompiler.createProgram, "function")
assert.equal(typeof oldCompiler.createSourceFile, "function")
assert.equal(coreCompiler.createProgram, oldCompiler.createProgram)
assert.equal(coreCompiler.createSourceFile, oldCompiler.createSourceFile)

const extractionOptions = { routeDir, sharedToolsDir }
const types = await extractToolTypesForRoute(extractionOptions)
const schemas = await extractToolSchemasForRoute(extractionOptions)

assert.deepEqual(types, [
  {
    name: "fallback",
    description: "Exercise the neutral root-intersection fallback.",
    inputType: "Map<string, number> & { fixed: string; }",
    outputType: "{ accepted: boolean; }",
  },
  {
    name: "mapped",
    description: "Update optional contact fields.",
    inputType: "OptionalFields<ContactInput>",
    outputType: "{ updated: boolean; }",
  },
  {
    name: "shadowed",
    description: "Local shadow wins.",
    inputType: "LocalInput",
    outputType: '{ source: "local"; }',
  },
])

assert.deepEqual(schemas, [
  {
    name: "fallback",
    description: "Exercise the neutral root-intersection fallback.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "mapped",
    description: "Update optional contact fields.",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string", description: "Contact email address." },
        retries: { type: "number", description: "Maximum retry count." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "shadowed",
    description: "Local shadow wins.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Local record identifier." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
])

const transformInput = \`const __dawnGeneratedDescription = "occupied"
const __dawnGeneratedSchema = "occupied"
const __dawnGeneratedZ = "occupied"

/**
 * Generate collision-safe metadata.
 * @param label - Human-readable label.
 */
export default async function generated(input: { label: string; tags?: string[] }) {
  return { label: input.label, tags: input.tags ?? [] }
}
\`
const transformed = dawnToolSchemaPlugin().transform(
  transformInput,
  join(root, "route", "tools", "generated.ts"),
)
assert.ok(transformed)
assert.match(transformed.code, /import \\{ z as __dawnGeneratedZ2 \\} from "zod"/)
assert.match(transformed.code, /const __dawnGeneratedDescription2 = "Generate collision-safe metadata\\."/)
assert.match(transformed.code, /export \\{ __dawnGeneratedDescription2 as description \\}/)
assert.match(transformed.code, /const __dawnGeneratedSchema2 = __dawnGeneratedZ2\\.object/)
assert.match(transformed.code, /export \\{ __dawnGeneratedSchema2 as schema \\}/)
assert.match(transformed.code, /__dawnGeneratedZ2\\.string\\(\\)\\.describe\\("Human-readable label\\."\\)/)
await writeFile(join(root, "generated-tool.ts"), transformed.code, "utf8")
`
}

export function typescriptToolingConsumerSource() {
  return `import generated, { description, schema } from "./generated-tool.js"

async function runConsumer(): Promise<void> {
  const parsed = schema.parse({ label: "consumer", tags: ["typescript-7"] })
  const result: Awaited<ReturnType<typeof generated>> = await generated(parsed)
  const summary: string = description + ": " + result.label

  void summary
}

void runConsumer()
`
}

export function typescriptToolingTypeScriptConfig() {
  return {
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2022",
    },
    files: ["generated-tool.ts", CONSUMER_FILE],
  }
}

/**
 * Writes and runs the probe inside a caller-owned project root.
 * The caller remains responsible for cleaning up that root and every generated file.
 */
export async function runTypeScriptToolingProbe(options) {
  validateRunnerOptions(options)
  const { expectedTypeScriptVersion, runCommand } = options
  const root = resolve(options.root)
  const sourceFiles = {
    ...typescriptToolingSourceFiles(),
    [PROBE_FILE]: typescriptToolingProbeSource({ expectedTypeScriptVersion }),
    [CONSUMER_FILE]: typescriptToolingConsumerSource(),
    [TSCONFIG_FILE]: `${JSON.stringify(typescriptToolingTypeScriptConfig(), null, 2)}\n`,
  }

  await Promise.all(
    Object.entries(sourceFiles).map(async ([relativePath, source]) => {
      const outputPath = join(root, relativePath)
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, source, "utf8")
    }),
  )

  const typescriptBin = await resolveTypeScriptBin({ root, expectedTypeScriptVersion })
  await runCommand(process.execPath, [PROBE_FILE], { cwd: root })
  await runCommand(process.execPath, [typescriptBin, "--project", TSCONFIG_FILE, "--noEmit"], {
    cwd: root,
  })
}

function validateRunnerOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("TypeScript tooling probe options must be an options object")
  }
  if (typeof options.root !== "string" || options.root.trim().length === 0) {
    throw new TypeError("TypeScript tooling probe root must be a non-empty string")
  }
  if (typeof options.runCommand !== "function") {
    throw new TypeError("TypeScript tooling probe runCommand must be a function")
  }
  if (
    typeof options.expectedTypeScriptVersion !== "string" ||
    options.expectedTypeScriptVersion.trim().length === 0
  ) {
    throw new TypeError(
      "TypeScript tooling probe expectedTypeScriptVersion must be a non-empty string",
    )
  }
}

export async function resolveTypeScriptBin({ root, expectedTypeScriptVersion }) {
  const resolvedRoot = resolve(root)
  const consumerRequire = createRequire(pathToFileURL(join(resolvedRoot, "package.json")))
  let packagePath
  try {
    packagePath = consumerRequire.resolve("typescript/package.json")
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; unable to resolve a valid TypeScript manifest from ${resolvedRoot}`,
      { cause: error },
    )
  }

  let manifest
  try {
    manifest = JSON.parse(await readFile(packagePath, "utf8"))
  } catch (error) {
    throw new Error(`Unable to read a valid TypeScript package manifest at ${packagePath}`, {
      cause: error,
    })
  }
  if (manifest.version !== expectedTypeScriptVersion) {
    throw new Error(
      `installed TypeScript version ${manifest.version ?? "unknown"}, expected ${expectedTypeScriptVersion} (manifest ${packagePath})`,
    )
  }
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tsc
  const packageRoot = dirname(packagePath)
  if (typeof bin !== "string" || bin.trim().length === 0) {
    throw new Error(
      `TypeScript package manifest ${packagePath} does not declare a non-empty tsc bin entry`,
    )
  }
  if (isAbsolute(bin)) {
    throw new Error(
      `TypeScript package manifest ${packagePath} declares an absolute tsc bin path: ${bin}`,
    )
  }

  let realPackageRoot
  try {
    realPackageRoot = await realpath(packageRoot)
  } catch (error) {
    throw new Error(`Unable to resolve TypeScript package root ${packageRoot}`, { cause: error })
  }
  const target = resolve(realPackageRoot, bin)
  assertContainedPath(realPackageRoot, target, packagePath)

  let realTarget
  try {
    realTarget = await realpath(target)
  } catch (error) {
    throw new Error(`TypeScript tsc bin target ${target} is missing or unreadable`, {
      cause: error,
    })
  }
  assertContainedPath(realPackageRoot, realTarget, packagePath)

  let targetStat
  try {
    targetStat = await stat(realTarget)
  } catch (error) {
    throw new Error(`Unable to inspect TypeScript tsc bin target ${realTarget}`, { cause: error })
  }
  if (!targetStat.isFile()) {
    throw new Error(`TypeScript tsc bin target ${realTarget} is not a regular file`)
  }
  return realTarget
}

function assertContainedPath(realPackageRoot, target, packagePath) {
  const relativeTarget = relative(realPackageRoot, target)
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(
      `TypeScript tsc bin target ${target} is outside package root ${realPackageRoot} from ${packagePath}`,
    )
  }
}
