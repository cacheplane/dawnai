import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, win32 } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  RECOMMENDED_VERCEL_CONFIG,
  reconcileVercelConfig,
  setVercelConfigFileOpsForTesting,
} from "../src/lib/build/targets/vercel-config.js"
import {
  isVercelPathWithin,
  VERCEL_BUILD_OUTPUT_CONFIG,
  VERCEL_FUNCTION_CONFIG,
  validateVercelOutput,
  writeVercelMetadata,
} from "../src/lib/build/targets/vercel-output.js"
import { CliError, type CommandIo } from "../src/lib/output.js"

const tempDirs: string[] = []
const EXPECTED_RECOMMENDED_VERCEL_CONFIG = {
  $schema: "https://openapi.vercel.sh/vercel.json",
  buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build",
  fluid: true,
} as const
const EXPECTED_RECOMMENDED_VERCEL_CONFIG_JSON = `{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build",
  "fluid": true
}\n`

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createOutputDir(): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), "dawn-vercel-output-"))
  tempDirs.push(outputDir)
  return outputDir
}

async function createVercelConfigDirs(): Promise<{ appRoot: string; buildDir: string }> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-vercel-app-"))
  const buildDir = await mkdtemp(join(tmpdir(), "dawn-vercel-build-"))
  tempDirs.push(appRoot, buildDir)
  return { appRoot, buildDir }
}

function collectIo(): { io: CommandIo; stderr: string[] } {
  const stderr: string[] = []
  return {
    io: { stderr: (message) => stderr.push(message), stdout: () => {} },
    stderr,
  }
}

function recommendedVercelConfig(): string {
  return EXPECTED_RECOMMENDED_VERCEL_CONFIG_JSON
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor)
  } else {
    Reflect.deleteProperty(target, key)
  }
}

function filesystemError(code: string): NodeJS.ErrnoException {
  const error = new Error(`injected ${code}`) as NodeJS.ErrnoException
  error.code = code
  return error
}

function functionDir(outputDir: string): string {
  return join(outputDir, "functions", "index.func")
}

function functionConfigPath(outputDir: string): string {
  return join(functionDir(outputDir), ".vc-config.json")
}

function entryPath(outputDir: string): string {
  return join(functionDir(outputDir), "index.mjs")
}

async function validOutput(outputDir: string): Promise<void> {
  await writeVercelMetadata(outputDir)
  await writeFile(entryPath(outputDir), 'import "node:fs"\nexport default {}\n', "utf8")
}

describe("Build Output contract", () => {
  test("writes the exact Build Output API v3 metadata without an entry module", async () => {
    const outputDir = await createOutputDir()

    const metadata = await writeVercelMetadata(outputDir)

    expect(VERCEL_BUILD_OUTPUT_CONFIG).toEqual({
      routes: [{ dest: "/index", src: "/(.*)" }],
      version: 3,
    })
    expect(VERCEL_FUNCTION_CONFIG).toEqual({
      handler: "index.mjs",
      launcherType: "Nodejs",
      runtime: "nodejs24.x",
    })
    expect(metadata).toEqual({
      configPath: join(outputDir, "config.json"),
      functionConfigPath: functionConfigPath(outputDir),
      functionDir: functionDir(outputDir),
    })
    await expect(readFile(metadata.configPath, "utf8")).resolves.toBe(
      '{\n  "routes": [\n    {\n      "dest": "/index",\n      "src": "/(.*)"\n    }\n  ],\n  "version": 3\n}\n',
    )
    await expect(readFile(metadata.functionConfigPath, "utf8")).resolves.toBe(
      '{\n  "handler": "index.mjs",\n  "launcherType": "Nodejs",\n  "runtime": "nodejs24.x"\n}\n',
    )
    await expect(lstat(entryPath(outputDir))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("accepts a complete self-contained function and in-tree dependency", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      'import "node:fs"\nimport { message } from "./message.mjs"\nexport { message }\n',
    )
    await writeFile(join(functionDir(outputDir), "message.mjs"), 'export const message = "ok"\n')

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test("accepts a genuine safe Node builtin", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      'import { basename } from "node:path"\nexport { basename }\n',
    )

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test.each(["node:test", "node:test/reporters", "node:sqlite"])(
    "accepts the prefix-only Node builtin %s",
    async (specifier) => {
      const outputDir = await createOutputDir()
      await validOutput(outputDir)
      await writeFile(entryPath(outputDir), `import "${specifier}"\n`)

      await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
    },
  )

  test("accepts an embedded data module bundled by esbuild", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      'import answer from "data:text/javascript,export default 42"\nexport { answer }\n',
    )

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test.each([
    {
      expected: (outputDir: string) => join(outputDir, "config.json"),
      mutate: async (outputDir: string) => rm(join(outputDir, "config.json")),
      name: "missing config.json",
    },
    {
      expected: functionConfigPath,
      mutate: async (outputDir: string) => rm(functionConfigPath(outputDir)),
      name: "missing function config",
    },
    {
      expected: entryPath,
      mutate: async (outputDir: string) => rm(entryPath(outputDir)),
      name: "missing entry module",
    },
    {
      expected: (outputDir: string) => `${join(outputDir, "config.json")} property "version"`,
      mutate: async (outputDir: string) =>
        writeFile(
          join(outputDir, "config.json"),
          '{\n  "routes": [{ "src": "/(.*)", "dest": "/index" }],\n  "version": 2\n}\n',
        ),
      name: "wrong Build Output version",
    },
    {
      expected: (outputDir: string) => `${functionConfigPath(outputDir)} property "runtime"`,
      mutate: async (outputDir: string) =>
        writeFile(
          functionConfigPath(outputDir),
          '{\n  "handler": "index.mjs",\n  "launcherType": "Nodejs",\n  "runtime": "nodejs22.x"\n}\n',
        ),
      name: "wrong function runtime",
    },
    {
      expected: (outputDir: string) =>
        `${join(outputDir, "config.json")} property "routes[0].dest"`,
      mutate: async (outputDir: string) =>
        writeFile(
          join(outputDir, "config.json"),
          '{\n  "routes": [{ "src": "/(.*)", "dest": "/wrong" }],\n  "version": 3\n}\n',
        ),
      name: "wrong route destination",
    },
    {
      expected: (outputDir: string) => `${join(outputDir, "config.json")} property "extra"`,
      mutate: async (outputDir: string) =>
        writeFile(
          join(outputDir, "config.json"),
          '{\n  "routes": [{ "src": "/(.*)", "dest": "/index" }],\n  "version": 3,\n  "extra": true\n}\n',
        ),
      name: "extra root config property",
    },
    {
      expected: (outputDir: string) =>
        `${join(outputDir, "config.json")} property "routes[0].extra"`,
      mutate: async (outputDir: string) =>
        writeFile(
          join(outputDir, "config.json"),
          '{\n  "routes": [{ "src": "/(.*)", "dest": "/index", "extra": true }],\n  "version": 3\n}\n',
        ),
      name: "extra route property",
    },
    {
      expected: (outputDir: string) => `${functionConfigPath(outputDir)} property "extra"`,
      mutate: async (outputDir: string) =>
        writeFile(
          functionConfigPath(outputDir),
          '{\n  "handler": "index.mjs",\n  "launcherType": "Nodejs",\n  "runtime": "nodejs24.x",\n  "extra": true\n}\n',
        ),
      name: "extra function config property",
    },
    {
      expected: (outputDir: string) => join(outputDir, "config.json"),
      mutate: async (outputDir: string) => writeFile(join(outputDir, "config.json"), "not json\n"),
      name: "invalid config JSON",
    },
    {
      expected: entryPath,
      mutate: async (outputDir: string) => {
        await rm(entryPath(outputDir))
        await mkdir(entryPath(outputDir))
      },
      name: "entry module directory",
    },
  ])("rejects $name with the precise invalid location", async ({ expected, mutate }) => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await mutate(outputDir)

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(expected(outputDir))
  })

  test("rejects a function-tree symlink that resolves outside index.func", async () => {
    const outputDir = await createOutputDir()
    const outsideDir = await mkdtemp(join(tmpdir(), "dawn-vercel-outside-"))
    tempDirs.push(outsideDir)
    await validOutput(outputDir)
    const outsideFile = join(outsideDir, "outside.mjs")
    const linkedFile = join(functionDir(outputDir), "linked.mjs")
    await writeFile(outsideFile, "export default {}\n")
    await symlink(outsideFile, linkedFile)

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(linkedFile)
  })

  test("rejects an escaping relative entry dependency", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), 'import "../outside.mjs"\n')
    const escapingDependency = join(outputDir, "functions", "outside.mjs")
    await writeFile(escapingDependency, "export default {}\n")

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(escapingDependency)
  })

  test("rejects an escaping literal dynamic entry dependency", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), 'await import("../../outside.mjs")\n')
    const escapingDependency = join(outputDir, "outside.mjs")
    await writeFile(escapingDependency, "export default {}\n")

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(escapingDependency)
  })

  test.each([
    {
      source: 'import/**/"../../outside.mjs"\n',
      title: "static import",
    },
    {
      source: 'export/**/{ value }/**/from/**/"../../outside.mjs"\n',
      title: "re-export",
    },
    {
      source: 'await import/**/("../../outside.mjs")\n',
      title: "dynamic import",
    },
  ])("rejects a comment-separated escaping $title", async ({ source }) => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), source)
    const escapingDependency = join(outputDir, "outside.mjs")
    await writeFile(escapingDependency, "export const value = true\n")

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(escapingDependency)
  })

  test("rejects unresolved bare runtime package dependencies", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), 'import "unbundled-runtime-package"\n')

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(entryPath(outputDir))
  })

  test("rejects a comment-separated bare runtime package dependency", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), 'import/**/"unbundled-runtime-package"\n')

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(entryPath(outputDir))
  })

  test.each([
    { specifier: "https://example.com/runtime.mjs", title: "URL import" },
    { specifier: "node:not-a-real-builtin", title: "unknown node builtin" },
  ])("rejects an external $title", async ({ specifier }) => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(entryPath(outputDir), `import "${specifier}"\n`)

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(specifier)
  })

  test("rejects node:module runtime-loader access", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(join(outputDir, "outside.cjs"), "module.exports = 42\n")
    await writeFile(
      entryPath(outputDir),
      'import { createRequire } from "node:module"\nconst require = createRequire(import.meta.url)\nexport const answer = require("../../outside.cjs")\n',
    )

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(/runtime loader|node:module/)
  })

  test("rejects a nonliteral dynamic runtime dependency", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      'const dependency = "../../outside.mjs"\nawait import(dependency)\n',
    )

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(entryPath(outputDir))
  })

  test("rejects a nonliteral dynamic import in a template expression", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      `const dependency = "../../outside.mjs"
const value = \`\${/}/.test("}") ? import(dependency) : ""}\`
export { value }
`,
    )

    await expect(validateVercelOutput(outputDir)).rejects.toThrow(entryPath(outputDir))
  })

  test("ignores an import-like regular expression literal", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      "const matcher = /import(variable)/\nexport { matcher }\n",
    )

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test("ignores an object method named import", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      "const moduleFactory = { import(value) { return value } }\nexport { moduleFactory }\n",
    )

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test("ignores import-like text in comments and strings", async () => {
    const outputDir = await createOutputDir()
    await validOutput(outputDir)
    await writeFile(
      entryPath(outputDir),
      '// import "../../outside.mjs"\n/*\nimport "unbundled-runtime-package"\n*/\nconst note = `import("../../outside.mjs")`\nexport { note }\n',
    )

    await expect(validateVercelOutput(outputDir)).resolves.toBeUndefined()
  })

  test("uses Windows semantics to reject cross-drive containment", () => {
    expect(isVercelPathWithin("C:\\output\\functions\\index.func", "D:\\outside.mjs", win32)).toBe(
      false,
    )
  })
})

describe("root vercel config", () => {
  test("writes the exact recommended config when the app has no root vercel.json", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const { io, stderr } = collectIo()

    expect(RECOMMENDED_VERCEL_CONFIG).toEqual(EXPECTED_RECOMMENDED_VERCEL_CONFIG)
    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: rootPath,
      created: true,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(recommendedVercelConfig())
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readdir(appRoot)).resolves.toEqual(["vercel.json"])
    expect(stderr).toEqual([])
  })

  test("preserves the generated root config on a second call", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    await reconcileVercelConfig({ appRoot, buildDir })
    const firstContents = await readFile(rootPath, "utf8")

    await expect(reconcileVercelConfig({ appRoot, buildDir })).resolves.toEqual({
      artifactPath: rootPath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(firstContents)
  })

  test("rejects a broken root symlink without creating its external target", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const outsideDir = await mkdtemp(join(tmpdir(), "dawn-vercel-outside-"))
    const externalPath = join(outsideDir, "vercel.json")
    tempDirs.push(outsideDir)
    await symlink(externalPath, rootPath)

    try {
      await reconcileVercelConfig({ appRoot, buildDir })
      throw new Error("expected broken root symlink to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect(error).toMatchObject({ message: expect.stringContaining(rootPath) })
      expect((error as CliError).cause).toBeDefined()
    }
    await expect(lstat(rootPath)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) })
    expect((await lstat(rootPath)).isSymbolicLink()).toBe(true)
    await expect(lstat(externalPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readdir(appRoot)).resolves.toEqual(["vercel.json"])
  })

  test("atomically replaces an existing reference symlink without changing its target", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const outsideDir = await mkdtemp(join(tmpdir(), "dawn-vercel-outside-"))
    const externalPath = join(outsideDir, "preserved.json")
    const externalContents = "external content\n"
    tempDirs.push(outsideDir)
    await writeFile(rootPath, '{ "buildCommand": "unknown", "fluid": true }\n')
    await writeFile(externalPath, externalContents)
    await symlink(externalPath, referencePath)

    await expect(reconcileVercelConfig({ appRoot, buildDir })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    expect((await lstat(referencePath)).isSymbolicLink()).toBe(false)
    await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
    await expect(readFile(externalPath, "utf8")).resolves.toBe(externalContents)
  })

  test("reconciles a compliant root created by a root publication race", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const racedContents =
      '{ "fluid": true, "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build" }\n'
    const linkError = filesystemError("EEXIST")
    const { io, stderr } = collectIo()
    const restoreFileOps = setVercelConfigFileOpsForTesting({
      link: async (_temporaryPath, destinationPath) => {
        expect(destinationPath).toBe(rootPath)
        await writeFile(rootPath, racedContents)
        throw linkError
      },
    })

    try {
      await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
        artifactPath: rootPath,
        created: false,
      })
    } finally {
      restoreFileOps()
    }
    await expect(readFile(rootPath, "utf8")).resolves.toBe(racedContents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readdir(appRoot)).resolves.toEqual(["vercel.json"])
    expect(stderr).toEqual([])
  })

  test.each(["temporary write", "hard-link publication"])(
    "cleans the root temporary file when %s fails",
    async (failurePoint) => {
      const { appRoot, buildDir } = await createVercelConfigDirs()
      const rootPath = join(appRoot, "vercel.json")
      const injectedError = filesystemError("EIO")
      const restoreFileOps = setVercelConfigFileOpsForTesting(
        failurePoint === "temporary write"
          ? { writeFile: async () => await Promise.reject(injectedError) }
          : { link: async () => await Promise.reject(injectedError) },
      )

      try {
        await expect(reconcileVercelConfig({ appRoot, buildDir })).rejects.toMatchObject({
          cause: injectedError,
          message: expect.stringContaining(rootPath),
        })
      } finally {
        restoreFileOps()
      }
      await expect(lstat(rootPath)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readdir(appRoot)).resolves.toEqual([])
    },
  )

  test.each(["temporary write", "rename publication"])(
    "preserves the existing reference and cleans the temporary file when %s fails",
    async (failurePoint) => {
      const { appRoot, buildDir } = await createVercelConfigDirs()
      const rootPath = join(appRoot, "vercel.json")
      const referencePath = join(buildDir, "vercel.json")
      const priorReference = "previous reference\n"
      const injectedError = filesystemError("EIO")
      await writeFile(rootPath, '{ "buildCommand": "unknown", "fluid": true }\n')
      await writeFile(referencePath, priorReference)
      const restoreFileOps = setVercelConfigFileOpsForTesting(
        failurePoint === "temporary write"
          ? { writeFile: async () => await Promise.reject(injectedError) }
          : { rename: async () => await Promise.reject(injectedError) },
      )

      try {
        await expect(reconcileVercelConfig({ appRoot, buildDir })).rejects.toMatchObject({
          cause: injectedError,
          message: expect.stringContaining(referencePath),
        })
      } finally {
        restoreFileOps()
      }
      await expect(readFile(referencePath, "utf8")).resolves.toBe(priorReference)
      await expect(readdir(buildDir)).resolves.toEqual(["vercel.json"])
    },
  )

  test("does not invoke root publication writes for an existing compliant root", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const contents =
      '{ "fluid": true, "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build" }\n'
    const unexpectedWrite = new Error("root publication should not write")
    await writeFile(rootPath, contents)
    const restoreFileOps = setVercelConfigFileOpsForTesting({
      writeFile: async () => await Promise.reject(unexpectedWrite),
    })

    try {
      await expect(reconcileVercelConfig({ appRoot, buildDir })).resolves.toEqual({
        artifactPath: rootPath,
        created: false,
      })
    } finally {
      restoreFileOps()
    }
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
  })

  test("preserves a compliant root config byte-for-byte without a warning or reference", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents =
      '{ "fluid": true, "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build" }\n'
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: rootPath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(stderr).toEqual([])
  })

  test.each([
    ["spaces", " node  node_modules/@dawn-ai/cli/dist/index.js   build "],
    ["tabs", "\tnode\t node_modules/@dawn-ai/cli/dist/index.js\tbuild\t"],
  ])("accepts a direct command with only ASCII %s", async (_kind, buildCommand) => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = `${JSON.stringify({ buildCommand, fluid: true }, null, 2)}\n`
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: rootPath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(stderr).toEqual([])
  })

  test.each([
    ["non-breaking space", "\u00a0node node_modules/@dawn-ai/cli/dist/index.js build"],
    ["form-feed", "\fnode node_modules/@dawn-ai/cli/dist/index.js build"],
    ["carriage return", "node node_modules/@dawn-ai/cli/dist/index.js build\r"],
    ["line feed", "node node_modules/@dawn-ai/cli/dist/index.js build\n"],
    ["command chain", "node node_modules/@dawn-ai/cli/dist/index.js build && echo nope"],
    ["semicolon", "node node_modules/@dawn-ai/cli/dist/index.js build; echo nope"],
    ["extra argument", "node node_modules/@dawn-ai/cli/dist/index.js build --prod"],
    ["environment prefix", "DAWN=1 node node_modules/@dawn-ai/cli/dist/index.js build"],
    ["alternate path", "node ./node_modules/@dawn-ai/cli/dist/index.js build"],
  ])("writes a reference and warning for a %s command variant", async (_kind, buildCommand) => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = `${JSON.stringify({ buildCommand, fluid: true }, null, 2)}\n`
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain(rootPath)
    expect(stderr[0]).toContain(referencePath)
  })

  test("does not establish or conflict with inherited build and fluid contracts", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = "{}\n"
    const { io, stderr } = collectIo()
    const buildCommandDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "buildCommand")
    const fluidDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "fluid")
    await writeFile(rootPath, contents)

    try {
      Object.defineProperty(Object.prototype, "buildCommand", {
        configurable: true,
        value: "node node_modules/@dawn-ai/cli/dist/index.js build",
      })
      Object.defineProperty(Object.prototype, "fluid", { configurable: true, value: false })

      await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
        artifactPath: referencePath,
        created: false,
      })
      await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
      await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
      expect(stderr).toHaveLength(1)
      expect(stderr[0]).toContain("buildCommand")
      expect(stderr[0]).toContain("fluid")
    } finally {
      restoreProperty(Object.prototype, "buildCommand", buildCommandDescriptor)
      restoreProperty(Object.prototype, "fluid", fluidDescriptor)
    }
  })

  test("leaves extra valid user settings authoritative", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = `{
  "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build",
  "fluid": true,
  "regions": ["sfo1"],
  "headers": [{ "source": "/(.*)", "headers": [{ "key": "x-user", "value": "kept" }] }]
}\n`
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir })).resolves.toEqual({
      artifactPath: rootPath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  test.each([
    ["missing", { fluid: true }],
    ["unknown", { buildCommand: "dawn build", fluid: true }],
    ["non-string", { buildCommand: 42, fluid: true }],
  ])("writes one reference and warning for a %s build command", async (_kind, config) => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = `${JSON.stringify(config, null, 2)}\n`
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain(rootPath)
    expect(stderr[0]).toContain(referencePath)
    expect(stderr[0]).toContain("buildCommand")
  })

  test.each([
    ["omitted", { buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build" }],
    [
      "non-true",
      { buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build", fluid: "true" },
    ],
  ])("writes a portability warning when fluid is %s", async (_kind, config) => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = `${JSON.stringify(config, null, 2)}\n`
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain("fluid")
    expect(stderr[0]).toMatch(/portability/i)
    expect(stderr[0]).toMatch(/Dashboard defaults.*do not establish.*committed contract/i)
  })

  test("consolidates missing build and fluid contracts into one warning", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = '{\n  "regions": ["sfo1"]\n}\n'
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain("buildCommand")
    expect(stderr[0]).toContain("fluid")
  })

  test("fails on explicit fluid false without changing the root or writing a reference", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents =
      '{ "buildCommand": "node node_modules/@dawn-ai/cli/dist/index.js build", "fluid": false }\n'
    const { io, stderr } = collectIo()
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir, io })).rejects.toThrow(
      /supported lifecycle.*fluid: true/i,
    )
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(stderr).toEqual([])
  })

  test("fails for invalid root JSON with its path and parse error as the cause", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = "{ invalid json\n"
    await writeFile(rootPath, contents)

    try {
      await reconcileVercelConfig({ appRoot, buildDir })
      throw new Error("expected invalid JSON to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect(error).toMatchObject({ message: expect.stringContaining(rootPath) })
      expect((error as CliError).cause).toBeInstanceOf(SyntaxError)
    }
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
    await expect(readFile(referencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("still writes a reference for an unproven config when no io is supplied", async () => {
    const { appRoot, buildDir } = await createVercelConfigDirs()
    const rootPath = join(appRoot, "vercel.json")
    const referencePath = join(buildDir, "vercel.json")
    const contents = '{ "buildCommand": "dawn build", "fluid": true }\n'
    await writeFile(rootPath, contents)

    await expect(reconcileVercelConfig({ appRoot, buildDir })).resolves.toEqual({
      artifactPath: referencePath,
      created: false,
    })
    await expect(readFile(referencePath, "utf8")).resolves.toBe(recommendedVercelConfig())
    await expect(readFile(rootPath, "utf8")).resolves.toBe(contents)
  })
})
