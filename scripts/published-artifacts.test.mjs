import assert from "node:assert/strict"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import {
  assertCleanDependencySpecs,
  expectedFilesForPackage,
  normalizeCliArgs,
  packageSets,
  resolvePackageSet,
  resolveRequestedVersion,
  run,
  validatePackageMetadata,
} from "./lib/published-artifacts.mjs"
import {
  resolveTypeScriptBin,
  runTypeScriptToolingProbe,
  typescriptToolingConsumerSource,
  typescriptToolingProbeSource,
  typescriptToolingSourceFiles,
  typescriptToolingTypeScriptConfig,
} from "./lib/typescript-tooling-probe.mjs"
import * as publishedSmoke from "./published-artifact-smoke.mjs"

const {
  agUiEsmProbeSource,
  agUiProbeCommands,
  agUiTypeProbeSource,
  agUiTypeScriptConfig,
  assertNoNativeInstallOutput,
  assertNoNativeLifecycleScripts,
  parseDockerMappedHostPort,
  pgvectorDatabaseUrl,
  readInstalledPackageManifests,
  runCommand,
  shouldRunAgUiProbe,
  shouldRunOpenAiSmoke,
} = publishedSmoke

const tempRoots = []
const typescriptPackagePath = fileURLToPath(import.meta.resolve("typescript/package.json"))
const typescriptPackage = JSON.parse(readFileSync(typescriptPackagePath, "utf8"))
const typescriptCompilerPath = resolvePackageBinPath(
  typescriptPackagePath,
  typescriptPackage,
  "tsc",
)

function resolvePackageBinPath(packagePath, packageManifest, binName) {
  const bin =
    typeof packageManifest.bin === "string" ? packageManifest.bin : packageManifest.bin?.[binName]
  if (!bin) {
    throw new Error(`Package manifest does not declare a ${binName} binary`)
  }
  return join(dirname(packagePath), bin)
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe("resolvePackageSet", () => {
  it("resolves the memory-pgvector-core package set", () => {
    assert.deepEqual(resolvePackageSet("memory-pgvector-core"), [
      "@dawn-ai/memory-pgvector",
      "@dawn-ai/memory",
      "@dawn-ai/langchain",
    ])
  })

  it("rejects unknown package sets", () => {
    assert.throws(() => resolvePackageSet("unknown"), /Unknown package set/)
  })
})

describe("packageSets", () => {
  it("includes the AG-UI package set", () => {
    assert.deepEqual(packageSets["ag-ui"], ["@dawn-ai/ag-ui"])
  })

  it("includes the public package set placeholder", () => {
    assert.equal(packageSets.public, null)
  })
})

describe("expectedFilesForPackage", () => {
  it("returns AG-UI entrypoint expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/ag-ui"), [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/sse.js",
      "dist/sse.d.ts",
      "README.md",
      "package.json",
    ])
  })

  it("returns memory-pgvector tarball expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/memory-pgvector"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
  })

  it("returns package-specific runtime expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/memory"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/langchain"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
  })

  it("defaults to metadata and README expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/unknown"), ["README.md", "package.json"])
  })
})

describe("AG-UI installed probes", () => {
  it("resolves the TypeScript 7 compiler from its exported package manifest", () => {
    assert.equal(typescriptPackage.version, "7.0.2")
    assert.equal(existsSync(typescriptCompilerPath), true)
  })

  it("generates an ESM probe for the exact canonical root surface", () => {
    const source = agUiEsmProbeSource()

    assert.match(source, /import \* as root from "@dawn-ai\/ag-ui"/)
    assert.match(source, /import \{ encodeAgUiSse \} from "@dawn-ai\/ag-ui\/sse"/)
    assert.ok(
      source.includes(`assert.deepEqual(Object.keys(root).sort(), [
  "createCounterIdFactory",
  "createDefaultIdFactory",
  "fromRunAgentInput",
  "toAguiEvents",
])`),
      "ESM probe must compare the complete sorted root export surface",
    )
    assert.ok(
      source.includes(`for (const exportName of [
  "createCounterIdFactory",
  "createDefaultIdFactory",
  "fromRunAgentInput",
  "toAguiEvents",
]) {
  assert.equal(typeof root[exportName], "function", \`canonical export \${exportName} must be a function\`)
}`),
      "ESM probe must verify every canonical root export is a function",
    )
    assert.match(source, /type: "RUN_STARTED"/)
    const exactSseAssertion = "assert.equal(encoded, `data: $" + "{JSON.stringify(event)}\\n\\n`)"
    assert.ok(source.includes(exactSseAssertion), "ESM probe must assert the exact SSE frame")
    assert.match(source, /JSON\.parse\(encoded\.slice\("data: "\.length, -2\)\)/)
    for (const field of ["type", "threadId", "runId"]) {
      assert.match(source, new RegExp(`payload\\.${field}`))
    }
  })

  it("generates a NodeNext consumer for root types and the SSE subpath", () => {
    const source = agUiTypeProbeSource()

    assert.match(source, /from "@dawn-ai\/ag-ui"/)
    for (const functionName of [
      "createCounterIdFactory",
      "createDefaultIdFactory",
      "fromRunAgentInput",
      "toAguiEvents",
    ]) {
      assert.match(source, new RegExp(`  ${functionName},`))
    }
    assert.ok(
      source.includes(`type RootValueSurface = readonly [
  typeof createCounterIdFactory,
  typeof createDefaultIdFactory,
  typeof fromRunAgentInput,
  typeof toAguiEvents,
]`),
      "type probe must type-use every canonical root function declaration",
    )
    for (const typeName of [
      "IdFactory",
      "DawnMessage",
      "DawnRunInput",
      "DawnInterruptEnvelope",
      "DawnResumeRequest",
      "AguiOutboundEvent",
      "ToAguiOptions",
      "DawnAgentStreamChunk",
      "RunContext",
    ]) {
      assert.match(source, new RegExp(`type ${typeName}`))
    }
    assert.ok(
      source.includes(`type RootTypeSurface = readonly [
  IdFactory,
  DawnMessage,
  DawnRunInput,
  DawnInterruptEnvelope,
  DawnResumeRequest,
  AguiOutboundEvent,
  ToAguiOptions,
  DawnAgentStreamChunk,
  RunContext,
]`),
      "type probe must exercise every canonical root type",
    )
    for (const removedTypeName of [
      "MappedRunInput",
      "ResumeDecision",
      "AgUiTranslator",
      "AgUiEvent",
      "DawnStreamChunk",
      "DawnToolCallData",
      "DawnToolResultData",
      "RawChunk",
      "TranslatorOptions",
    ]) {
      assert.ok(
        source.includes(`// @ts-expect-error ${removedTypeName} was removed from the canonical root
import type { ${removedTypeName} } from "@dawn-ai/ag-ui"`),
        `type probe must reject restored ${removedTypeName}`,
      )
    }
    for (const removedFunctionName of [
      "createAgUiTranslator",
      "mapRunInput",
      "encodeAgUiSse",
      "fromAguiResume",
      "toAguiInterrupt",
      "asToolCallData",
      "asToolResultData",
    ]) {
      assert.ok(
        source.includes(`// @ts-expect-error ${removedFunctionName} was removed from the canonical root
import { ${removedFunctionName} } from "@dawn-ai/ag-ui"`),
        `type probe must reject restored ${removedFunctionName}`,
      )
    }
    assert.match(source, /from "@dawn-ai\/ag-ui\/sse"/)
    assert.match(source, /typeof encodeAgUiSse/)
    assert.deepEqual(agUiTypeScriptConfig(), {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      files: ["smoke-ag-ui.ts"],
    })
  })

  it("installs TypeScript and runs both probes", () => {
    assert.deepEqual(agUiProbeCommands(), [
      { command: "node", args: ["smoke-ag-ui.mjs"] },
      { command: "npm", args: ["install", "--save-dev", "typescript@7.0.2"] },
      {
        command: "npm",
        args: ["exec", "--", "tsc", "--project", "tsconfig.ag-ui.json"],
      },
    ])
  })

  it("selects the AG-UI probe only when the package is installed", () => {
    assert.equal(shouldRunAgUiProbe([{ name: "@dawn-ai/ag-ui", version: "1.0.0" }]), true)
    assert.equal(shouldRunAgUiProbe([{ name: "@dawn-ai/core", version: "1.0.0" }]), false)
  })

  it("executes generated ESM and type probes against a local package fixture", async () => {
    const root = await createAgUiProbeFixture()

    await runCommand(process.execPath, ["smoke-ag-ui.mjs"], { cwd: root })
    await compileAgUiTypeProbe(root)
  })

  it("rejects an installed SSE encoder with incorrect event data", async () => {
    const root = await createAgUiProbeFixture({
      sseSource: `export function encodeAgUiSse(event) {
  return "data: " + JSON.stringify({ ...event, threadId: "wrong-thread" }) + "\\n\\n"
}
`,
    })

    await assert.rejects(
      runCommand(process.execPath, ["smoke-ag-ui.mjs"], { cwd: root }),
      /deepStrictEqual|strictEqual/,
    )
  })

  it("fails type compilation if a removed root type reappears", async () => {
    const root = await createAgUiProbeFixture({
      extraRootDeclarations: "export type MappedRunInput = unknown\n",
    })

    await assert.rejects(compileAgUiTypeProbe(root), /Unused '@ts-expect-error' directive/)
  })

  it("fails type compilation if a canonical function declaration is missing", async () => {
    const root = await createAgUiProbeFixture({
      omitCanonicalDeclaration: "createDefaultIdFactory",
    })

    await assert.rejects(compileAgUiTypeProbe(root), /createDefaultIdFactory/)
  })

  it("fails type compilation if a removed root function declaration reappears", async () => {
    const root = await createAgUiProbeFixture({
      extraRootDeclarations: "export declare function mapRunInput(input: unknown): unknown\n",
    })

    await assert.rejects(compileAgUiTypeProbe(root), /Unused '@ts-expect-error' directive/)
  })
})

describe("TypeScript tooling installed probe", () => {
  it("generates a clean installed-package runtime probe with exact extraction assertions", () => {
    const source = typescriptToolingProbeSource()

    assert.match(source, /from "@dawn-ai\/core"/)
    assert.match(source, /from "@dawn-ai\/vite-plugin"/)
    assert.doesNotMatch(source, /@dawn-ai\/core\/internal\/compiler/)
    assert.doesNotMatch(
      source,
      /(?:\.\.\/)+packages\/|packages\/core\/(?:src|dist)|packages\/vite-plugin\/(?:src|dist)/,
    )
    assert.match(source, /extractToolTypesForRoute/)
    assert.match(source, /extractToolSchemasForRoute/)
    assert.match(source, /dawnToolSchemaPlugin\(\)\.transform/)
    assert.match(source, /assert\.deepEqual\(types,/)
    assert.match(source, /assert\.deepEqual\(schemas,/)
    assert.match(source, /__dawnGeneratedDescription2/)
    assert.match(source, /__dawnGeneratedSchema2/)
    assert.match(source, /__dawnGeneratedZ2/)
    assert.match(source, /typescript\.version, expectedTypeScriptVersion/)
    assert.match(source, /coreCompiler\.version, "6\.0\.2"/)
    assert.match(source, /oldCompiler\.version, "6\.0\.2"/)
    assert.match(source, /coreCompilerManifest\.name, "@typescript\/typescript6"/)
    assert.match(source, /coreCompilerManifest\.version, "6\.0\.2"/)
    assert.match(source, /oldCompilerManifest\.name, "typescript"/)
    assert.match(source, /oldCompilerManifest\.version, "6\.0\.2"/)
    assert.match(source, /typeof coreCompiler\.createProgram, "function"/)
    assert.match(source, /typeof oldCompiler\.createSourceFile, "function"/)
    assert.match(source, /coreCompiler\.createProgram, oldCompiler\.createProgram/)
    assert.match(source, /coreCompiler\.createSourceFile, oldCompiler\.createSourceFile/)
  })

  it("builds representative shared and local tool sources without repository imports", () => {
    const files = typescriptToolingSourceFiles()

    assert.deepEqual(Object.keys(files).sort(), [
      "route/tools/fallback.ts",
      "route/tools/shadowed.ts",
      "shared/tool-inputs.ts",
      "shared/tools/mapped.ts",
      "shared/tools/shadowed.ts",
    ])
    assert.match(files["shared/tools/mapped.ts"], /import type .* from "\.\.\/tool-inputs\.js"/)
    assert.match(files["shared/tools/mapped.ts"], /\[K in keyof T\]\?: T\[K\]/)
    assert.match(files["shared/tools/mapped.ts"], /\/\*\*/)
    assert.match(files["route/tools/fallback.ts"], /Map<string, number> & \{ fixed: string \}/)
    assert.match(files["route/tools/shadowed.ts"], /Local shadow wins/)
    assert.match(files["shared/tools/shadowed.ts"], /must be shadowed/)
    for (const source of Object.values(files)) {
      assert.doesNotMatch(
        source,
        /(?:\.\.\/)+packages\/|packages\/(?:core|vite-plugin)\/(?:src|dist)/,
      )
    }
  })

  it("generates a NodeNext consumer and config that compile the transformed tool", () => {
    const source = typescriptToolingConsumerSource()

    assert.match(source, /from "\.\/generated-tool\.js"/)
    assert.match(source, /schema\.parse/)
    assert.match(source, /description/)
    assert.match(source, /async function runConsumer\(\)/)
    assert.doesNotMatch(source, /^const result:.*= await /m)
    assert.deepEqual(typescriptToolingTypeScriptConfig(), {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      files: ["generated-tool.ts", "typescript-tooling-consumer.ts"],
    })
  })

  it("writes all probe files and runs Node before the manifest-declared TypeScript 7 bin", async () => {
    const root = await createTypeScriptToolingRunnerFixture()
    const calls = []

    await runTypeScriptToolingProbe({
      root,
      expectedTypeScriptVersion: "7.0.2",
      async runCommand(command, args, options) {
        calls.push({ command, args, options })
      },
    })

    for (const relativePath of [
      ...Object.keys(typescriptToolingSourceFiles()),
      "typescript-tooling-probe.mjs",
      "typescript-tooling-consumer.ts",
      "tsconfig.typescript-tooling.json",
    ]) {
      assert.equal(existsSync(join(root, relativePath)), true, `${relativePath} must be written`)
    }
    assert.match(
      readFileSync(join(root, "typescript-tooling-probe.mjs"), "utf8"),
      /const expectedTypeScriptVersion = "7\.0\.2"/,
    )
    assert.deepEqual(calls, [
      {
        command: process.execPath,
        args: ["typescript-tooling-probe.mjs"],
        options: { cwd: root },
      },
      {
        command: process.execPath,
        args: [
          join(realpathSync(root), "node_modules", "typescript", "custom-bin", "tsc.mjs"),
          "--project",
          "tsconfig.typescript-tooling.json",
          "--noEmit",
        ],
        options: { cwd: root },
      },
    ])
  })

  it("resolves object and string TypeScript bins from the installed manifest", async () => {
    const objectRoot = await createTypeScriptToolingRunnerFixture()
    const stringRoot = await createTypeScriptToolingRunnerFixture({
      bin: "./custom-bin/tsc.mjs",
    })

    assert.equal(
      await resolveTypeScriptBin({
        root: objectRoot,
        expectedTypeScriptVersion: "7.0.2",
      }),
      join(realpathSync(objectRoot), "node_modules", "typescript", "custom-bin", "tsc.mjs"),
    )
    assert.equal(
      await resolveTypeScriptBin({
        root: stringRoot,
        expectedTypeScriptVersion: "7.0.2",
      }),
      join(realpathSync(stringRoot), "node_modules", "typescript", "custom-bin", "tsc.mjs"),
    )
  })

  it("rejects malformed or unsafe TypeScript bin declarations", async () => {
    const missingEntryRoot = await createTypeScriptToolingRunnerFixture({ bin: {} })
    await assert.rejects(
      resolveTypeScriptBin({
        root: missingEntryRoot,
        expectedTypeScriptVersion: "7.0.2",
      }),
      new RegExp(
        `${escapeRegExp(join(realpathSync(missingEntryRoot), "node_modules", "typescript"))}.*tsc`,
        "s",
      ),
    )

    const absoluteRoot = await createTypeScriptToolingRunnerFixture()
    const absoluteTarget = join(absoluteRoot, "absolute-tsc.mjs")
    await writeFile(absoluteTarget, "", "utf8")
    await writeTypeScriptManifest(absoluteRoot, { bin: { tsc: absoluteTarget } })
    await assert.rejects(
      resolveTypeScriptBin({ root: absoluteRoot, expectedTypeScriptVersion: "7.0.2" }),
      /absolute.*TypeScript.*bin|TypeScript.*bin.*absolute/i,
    )

    const traversalRoot = await createTypeScriptToolingRunnerFixture()
    await writeFile(join(traversalRoot, "node_modules", "outside-tsc.mjs"), "", "utf8")
    await writeTypeScriptManifest(traversalRoot, { bin: { tsc: "../outside-tsc.mjs" } })
    await assert.rejects(
      resolveTypeScriptBin({ root: traversalRoot, expectedTypeScriptVersion: "7.0.2" }),
      /outside.*TypeScript.*package|contain/i,
    )
  })

  it("rejects missing and non-file TypeScript bin targets with path-rich diagnostics", async () => {
    const missingRoot = await createTypeScriptToolingRunnerFixture()
    const missingTarget = join(
      realpathSync(missingRoot),
      "node_modules",
      "typescript",
      "custom-bin",
      "tsc.mjs",
    )
    await rm(missingTarget)
    await assert.rejects(
      resolveTypeScriptBin({ root: missingRoot, expectedTypeScriptVersion: "7.0.2" }),
      new RegExp(`${escapeRegExp(missingTarget)}.*(?:missing|unreadable)`, "is"),
    )

    const directoryRoot = await createTypeScriptToolingRunnerFixture()
    const directoryTarget = join(
      realpathSync(directoryRoot),
      "node_modules",
      "typescript",
      "custom-bin",
      "tsc.mjs",
    )
    await rm(directoryTarget)
    await mkdir(directoryTarget)
    await assert.rejects(
      resolveTypeScriptBin({ root: directoryRoot, expectedTypeScriptVersion: "7.0.2" }),
      new RegExp(`${escapeRegExp(directoryTarget)}.*regular file`, "is"),
    )
  })

  it("rejects a TypeScript bin symlink that escapes its package", async (t) => {
    const root = await createTypeScriptToolingRunnerFixture()
    const target = join(root, "node_modules", "typescript", "custom-bin", "tsc.mjs")
    const outsideTarget = join(root, "outside-tsc.mjs")
    await rm(target)
    await writeFile(outsideTarget, "", "utf8")
    try {
      await symlink(outsideTarget, target)
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip(`symlinks unavailable: ${error.code}`)
        return
      }
      throw error
    }

    await assert.rejects(
      resolveTypeScriptBin({ root, expectedTypeScriptVersion: "7.0.2" }),
      /outside.*TypeScript.*package|contain/i,
    )
  })

  it("reports the installed TypeScript manifest path when JSON is malformed", async () => {
    const root = await createTypeScriptToolingRunnerFixture()
    const manifestPath = join(root, "node_modules", "typescript", "package.json")
    await writeFile(manifestPath, "{", "utf8")

    await assert.rejects(
      resolveTypeScriptBin({ root, expectedTypeScriptVersion: "7.0.2" }),
      new RegExp(`${escapeRegExp(manifestPath)}.*valid.*manifest`, "is"),
    )
  })

  it("validates runner options and the installed TypeScript version", async () => {
    await assert.rejects(runTypeScriptToolingProbe(), /options object/)
    await assert.rejects(
      runTypeScriptToolingProbe({
        root: "",
        runCommand: async () => {},
        expectedTypeScriptVersion: "7.0.2",
      }),
      /root must be a non-empty string/,
    )
    await assert.rejects(
      runTypeScriptToolingProbe({
        root: "/tmp/example",
        runCommand: null,
        expectedTypeScriptVersion: "7.0.2",
      }),
      /runCommand must be a function/,
    )
    await assert.rejects(
      runTypeScriptToolingProbe({
        root: "/tmp/example",
        runCommand: async () => {},
        expectedTypeScriptVersion: "",
      }),
      /expectedTypeScriptVersion must be a non-empty string/,
    )

    const root = await createTypeScriptToolingRunnerFixture({ version: "7.0.1" })
    await assert.rejects(
      runTypeScriptToolingProbe({
        root,
        runCommand: async () => {},
        expectedTypeScriptVersion: "7.0.2",
      }),
      /installed TypeScript version 7\.0\.1, expected 7\.0\.2/,
    )
  })

  it("propagates command failures and does not continue to TypeScript", async () => {
    const root = await createTypeScriptToolingRunnerFixture()
    const failure = new Error("runtime probe failed")
    let calls = 0

    await assert.rejects(
      runTypeScriptToolingProbe({
        root,
        expectedTypeScriptVersion: "7.0.2",
        async runCommand() {
          calls += 1
          throw failure
        },
      }),
      (error) => error === failure,
    )
    assert.equal(calls, 1)
  })
})

describe("resolveRequestedVersion", () => {
  it("resolves latest through dist-tags", () => {
    assert.equal(
      resolveRequestedVersion({ requested: "latest", tags: { latest: "1.2.3" } }),
      "1.2.3",
    )
  })

  it("resolves arbitrary dist-tags through dist-tags", () => {
    assert.equal(
      resolveRequestedVersion({
        requested: "next",
        tags: { latest: "1.0.0", next: "1.1.0-beta.1" },
      }),
      "1.1.0-beta.1",
    )
  })

  it("passes explicit versions through", () => {
    assert.equal(
      resolveRequestedVersion({ requested: "0.8.11", tags: { latest: "0.8.12" } }),
      "0.8.11",
    )
  })
})

describe("normalizeCliArgs", () => {
  it("removes the npm script argument separator", () => {
    assert.deepEqual(normalizeCliArgs(["--", "--version", "latest"]), ["--version", "latest"])
  })

  it("leaves direct node invocation arguments unchanged", () => {
    assert.deepEqual(normalizeCliArgs(["--version", "latest"]), ["--version", "latest"])
  })
})

describe("assertCleanDependencySpecs", () => {
  it("rejects workspace and file dependency specs", () => {
    assert.throws(
      () =>
        assertCleanDependencySpecs("@dawn-ai/demo", {
          dependencies: { "@dawn-ai/core": "workspace:*", local: "file:../local" },
        }),
      /workspace:\*|file:/,
    )
  })
})

describe("validatePackageMetadata", () => {
  it("requires standard public package fields", () => {
    const failures = validatePackageMetadata("@dawn-ai/demo", {
      name: "@dawn-ai/demo",
      version: "1.0.0",
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/cacheplane/dawnai.git" },
      homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/demo#readme",
      bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
      exports: { ".": "./dist/index.js" },
      types: "./dist/index.d.ts",
    })

    assert.deepEqual(failures, [])
  })

  it("rejects package metadata with mismatched name or version", () => {
    const failures = validatePackageMetadata(
      "@dawn-ai/demo",
      {
        name: "@dawn-ai/other",
        version: "1.0.1",
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/cacheplane/dawnai.git" },
        homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/demo#readme",
        bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
        engines: { node: ">=22.13.0" },
        publishConfig: { access: "public" },
        exports: { ".": "./dist/index.js" },
        types: "./dist/index.d.ts",
      },
      "1.0.0",
    )

    assert.deepEqual(failures, [
      "@dawn-ai/demo: package.json name is @dawn-ai/other",
      "@dawn-ai/demo: package.json version is 1.0.1, expected 1.0.0",
    ])
  })

  it("accepts config packages with JSON exports and no top-level types", () => {
    const failures = validatePackageMetadata("@dawn-ai/config-biome", {
      name: "@dawn-ai/config-biome",
      version: "1.0.0",
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/cacheplane/dawnai.git" },
      homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/config-biome#readme",
      bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
      exports: {
        ".": "./biome.json",
        "./biome": "./biome.json",
      },
    })

    assert.deepEqual(failures, [])
  })
})

describe("shouldRunOpenAiSmoke", () => {
  it("skips when disabled", () => {
    assert.equal(shouldRunOpenAiSmoke({ enabled: false, env: {} }).status, "skip")
  })

  it("fails when enabled without OPENAI_API_KEY", () => {
    assert.throws(() => shouldRunOpenAiSmoke({ enabled: true, env: {} }), /OPENAI_API_KEY/)
  })
})

describe("parseDockerMappedHostPort", () => {
  it("extracts the dynamic localhost host and port from docker port output", () => {
    assert.deepEqual(parseDockerMappedHostPort("127.0.0.1:49157\n"), {
      host: "127.0.0.1",
      port: 49157,
    })
  })

  it("normalizes wildcard Docker hosts for client connections", () => {
    assert.deepEqual(parseDockerMappedHostPort("0.0.0.0:49157\n"), {
      host: "127.0.0.1",
      port: 49157,
    })
    assert.deepEqual(parseDockerMappedHostPort("[::]:49158\n"), {
      host: "127.0.0.1",
      port: 49158,
    })
  })
})

describe("pgvectorDatabaseUrl", () => {
  it("uses the mapped host and port", () => {
    assert.equal(
      pgvectorDatabaseUrl({ host: "127.0.0.1", port: 49157 }),
      "postgres://postgres:postgres@127.0.0.1:49157/postgres",
    )
  })
})

describe("runCommand", () => {
  it("removes OPENAI_API_KEY from child process environments by default", async () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-test-secret"

    try {
      const result = await runCommand(process.execPath, [
        "-e",
        "process.stdout.write(process.env.OPENAI_API_KEY ?? '')",
      ])

      assert.equal(result.stdout, "")
    } finally {
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey
      }
    }
  })

  it("passes OPENAI_API_KEY only when explicitly allowed", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.env.OPENAI_API_KEY ?? '')"],
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        includeOpenAi: true,
      },
    )

    assert.equal(result.stdout, "sk-test-secret")
  })
})

describe("run", () => {
  it("removes OPENAI_API_KEY from child process environments by default", async () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-test-secret"

    try {
      const output = await run(
        process.execPath,
        ["-e", "process.stdout.write(process.env.OPENAI_API_KEY ?? '')"],
        { stdio: "pipe" },
      )

      assert.equal(output, "")
    } finally {
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey
      }
    }
  })
})

describe("assertNoNativeLifecycleScripts", () => {
  it("rejects native lifecycle scripts", () => {
    assert.throws(
      () =>
        assertNoNativeLifecycleScripts([
          {
            manifest: {
              name: "native-addon",
              version: "1.0.0",
              scripts: { install: "node-gyp rebuild" },
            },
          },
        ]),
      /native-addon@1\.0\.0.*install.*node-gyp rebuild/,
    )
  })

  it("rejects bare prebuild lifecycle scripts", () => {
    assert.throws(
      () =>
        assertNoNativeLifecycleScripts([
          {
            manifest: {
              name: "native-addon",
              version: "1.0.0",
              scripts: { install: "prebuild --install" },
            },
          },
        ]),
      /native-addon@1\.0\.0.*install.*prebuild --install/,
    )
  })

  it("accepts ordinary JavaScript package scripts", () => {
    assert.doesNotThrow(() =>
      assertNoNativeLifecycleScripts([
        {
          manifest: {
            name: "plain-js",
            version: "1.0.0",
            scripts: {
              build: "tsc -p tsconfig.json",
              test: "node --test",
              postinstall: "node ./scripts/setup.js",
            },
          },
        },
      ]),
    )
  })

  it("rejects packages with binding.gyp even without lifecycle scripts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dawn-native-indicator-test-"))
    try {
      const packageDir = join(tempDir, "node_modules", "native-addon")
      await mkdir(packageDir, { recursive: true })
      await writeFile(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "native-addon", version: "1.0.0" }),
        "utf8",
      )
      await writeFile(join(packageDir, "binding.gyp"), "{}", "utf8")

      const manifests = await readInstalledPackageManifests(join(tempDir, "node_modules"))
      assert.throws(
        () => assertNoNativeLifecycleScripts(manifests),
        /native-addon@1\.0\.0.*binding\.gyp/,
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe("assertNoNativeInstallOutput", () => {
  it("rejects native install output markers beyond node-gyp", () => {
    for (const marker of [
      "prebuild",
      "node-pre-gyp",
      "cmake-js",
      "node-gyp-build",
      "prebuildify",
    ]) {
      assert.throws(
        () => assertNoNativeInstallOutput(`> native-addon install\n${marker} install\n`),
        /native build indicators/,
      )
    }
  })

  it("accepts ordinary npm install output", () => {
    assert.doesNotThrow(() =>
      assertNoNativeInstallOutput(
        "added 42 packages, and audited 42 packages in 1s\nfound 0 vulnerabilities\n",
      ),
    )
  })
})

async function createTypeScriptToolingRunnerFixture({
  bin = { tsc: "./custom-bin/tsc.mjs" },
  version = "7.0.2",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "dawn-typescript-tooling-probe-test-"))
  const typescriptRoot = join(root, "node_modules", "typescript")
  tempRoots.push(root)
  await mkdir(join(typescriptRoot, "custom-bin"), { recursive: true })
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8"),
    writeFile(
      join(typescriptRoot, "package.json"),
      JSON.stringify({
        name: "typescript",
        version,
        bin,
      }),
      "utf8",
    ),
    writeFile(join(typescriptRoot, "custom-bin", "tsc.mjs"), "", "utf8"),
  ])
  return root
}

async function writeTypeScriptManifest(root, overrides) {
  await writeFile(
    join(root, "node_modules", "typescript", "package.json"),
    JSON.stringify({ name: "typescript", version: "7.0.2", ...overrides }),
    "utf8",
  )
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function createAgUiProbeFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dawn-ag-ui-probe-test-"))
  const packageRoot = join(root, "node_modules", "@dawn-ai", "ag-ui")
  const distRoot = join(packageRoot, "dist")
  tempRoots.push(root)
  await mkdir(distRoot, { recursive: true })

  const packageJson = {
    name: "@dawn-ai/ag-ui",
    type: "module",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./sse": { types: "./dist/sse.d.ts", default: "./dist/sse.js" },
    },
  }
  const rootJavaScript = `export function createCounterIdFactory() {}
export function createDefaultIdFactory() {}
export function fromRunAgentInput(input) { return input }
export function toAguiEvents(events) { return events }
`
  const canonicalFunctionDeclarations = {
    createCounterIdFactory: "export declare function createCounterIdFactory(): IdFactory",
    createDefaultIdFactory: "export declare function createDefaultIdFactory(): IdFactory",
    fromRunAgentInput: "export declare function fromRunAgentInput(input: unknown): DawnRunInput",
    toAguiEvents: `export declare function toAguiEvents(
  events: AsyncIterable<DawnAgentStreamChunk>,
  context: RunContext,
  options?: ToAguiOptions,
): AsyncIterable<AguiOutboundEvent>`,
  }
  const includedFunctionDeclarations = Object.entries(canonicalFunctionDeclarations)
    .filter(([name]) => name !== options.omitCanonicalDeclaration)
    .map(([, declaration]) => declaration)
    .join("\n")
  const rootDeclarations = `export type IdFactory = (kind: string) => string
export interface DawnMessage { readonly role: string; readonly content: string }
export interface DawnRunInput { readonly messages: readonly DawnMessage[] }
export interface DawnInterruptEnvelope { readonly interruptId: string }
export interface DawnResumeRequest { readonly interruptId: string; readonly value: unknown }
export interface AguiOutboundEvent { readonly type: string }
export interface ToAguiOptions { readonly idFactory?: IdFactory }
export type DawnAgentStreamChunk = { readonly type: string; readonly data?: unknown }
export interface RunContext { readonly threadId: string; readonly runId: string }
${includedFunctionDeclarations}
${options.extraRootDeclarations ?? ""}`
  const sseJavaScript =
    options.sseSource ??
    `export function encodeAgUiSse(event) {
  return "data: " + JSON.stringify(event) + "\\n\\n"
}
`
  const sseDeclarations = `export declare function encodeAgUiSse(event: {
  readonly type: string
  readonly threadId: string
  readonly runId: string
}): string
`

  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8"),
    writeFile(join(root, "smoke-ag-ui.mjs"), agUiEsmProbeSource(), "utf8"),
    writeFile(join(root, "smoke-ag-ui.ts"), agUiTypeProbeSource(), "utf8"),
    writeFile(join(root, "tsconfig.ag-ui.json"), JSON.stringify(agUiTypeScriptConfig()), "utf8"),
    writeFile(join(packageRoot, "package.json"), JSON.stringify(packageJson), "utf8"),
    writeFile(join(distRoot, "index.js"), rootJavaScript, "utf8"),
    writeFile(join(distRoot, "index.d.ts"), rootDeclarations, "utf8"),
    writeFile(join(distRoot, "sse.js"), sseJavaScript, "utf8"),
    writeFile(join(distRoot, "sse.d.ts"), sseDeclarations, "utf8"),
  ])

  return root
}

async function compileAgUiTypeProbe(root) {
  return runCommand(
    process.execPath,
    [typescriptCompilerPath, "--project", "tsconfig.ag-ui.json"],
    { cwd: root },
  )
}
