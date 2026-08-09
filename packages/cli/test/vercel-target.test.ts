import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, win32 } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import {
  isVercelPathWithin,
  VERCEL_BUILD_OUTPUT_CONFIG,
  VERCEL_FUNCTION_CONFIG,
  validateVercelOutput,
  writeVercelMetadata,
} from "../src/lib/build/targets/vercel-output.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createOutputDir(): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), "dawn-vercel-output-"))
  tempDirs.push(outputDir)
  return outputDir
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
