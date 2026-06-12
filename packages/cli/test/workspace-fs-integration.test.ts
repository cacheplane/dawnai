import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []
let savedPermissionsMode: string | undefined

beforeEach(() => {
  savedPermissionsMode = process.env.DAWN_PERMISSIONS_MODE
  process.env.DAWN_PERMISSIONS_MODE = "non-interactive"
})

afterEach(async () => {
  if (savedPermissionsMode === undefined) {
    delete process.env.DAWN_PERMISSIONS_MODE
  } else {
    process.env.DAWN_PERMISSIONS_MODE = savedPermissionsMode
  }

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("ctx.fs end-to-end", () => {
  test("workflow entry and route tool share the sandboxed workspace handle", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/(public)/notes/index.ts": `import type { RuntimeContext } from "@dawn-ai/sdk"
export const workflow = async (
  state: { readonly name: string },
  ctx: RuntimeContext,
) => {
  await ctx.tools.stash({ name: state.name })
  const files = await ctx.fs.listDir("stash")
  return { ...state, files }
}
`,
      "src/app/(public)/notes/tools/stash.ts": `import type { DawnToolContext } from "@dawn-ai/sdk"
export default async (input: { readonly name: string }, ctx: DawnToolContext) => {
  await ctx.fs.writeFile(\`stash/\${input.name}.txt\`, \`stashed \${input.name}\`)
  return { ok: true }
}
`,
    })

    const result = await invoke(["run", "/notes", "--cwd", appRoot], {
      stdin: JSON.stringify({ name: "alpha" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      mode: "workflow",
      output: {
        files: ["alpha.txt"],
        name: "alpha",
      },
      routeId: "/notes",
      routePath: "src/app/(public)/notes/index.ts",
      status: "passed",
    })

    const onDisk = readFileSync(join(appRoot, "workspace", "stash", "alpha.txt"), "utf8")
    expect(onDisk).toBe("stashed alpha")
  })

  test("tool ctx.fs reads escaping the workspace fail closed in non-interactive mode", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/(public)/leaky/index.ts": `import type { RuntimeContext } from "@dawn-ai/sdk"
export const workflow = async (
  _state: unknown,
  ctx: RuntimeContext,
) => {
  return await ctx.tools.escape({})
}
`,
      "src/app/(public)/leaky/tools/escape.ts": `import type { DawnToolContext } from "@dawn-ai/sdk"
export default async (_input: unknown, ctx: DawnToolContext) => {
  return await ctx.fs.readFile("../outside.txt")
}
`,
    })
    await writeFile(join(appRoot, "outside.txt"), "secrets", "utf8")

    const result = await invoke(["run", "/leaky", "--cwd", appRoot], {
      stdin: JSON.stringify({}),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      error: {
        kind: "execution_error",
        message: expect.stringMatching(/Permission denied/),
      },
      routeId: "/leaky",
      routePath: "src/app/(public)/leaky/index.ts",
      status: "failed",
    })
  })
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-workspace-fs-"))
  tempDirs.push(appRoot)

  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )
  await mkdir(join(appRoot, "workspace"), { recursive: true })

  return appRoot
}

async function invoke(
  argv: readonly string[],
  options: {
    readonly stdin: string
  },
) {
  const stdout: string[] = []
  const stderr: string[] = []

  const exitCode = await run([...argv], {
    stderr: (message: string) => {
      stderr.push(message)
    },
    stdin: async () => options.stdin,
    stdout: (message: string) => {
      stdout.push(message)
    },
  })

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  }
}
