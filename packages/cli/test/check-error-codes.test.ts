import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

const VALID_ROUTE = `import type { RuntimeContext } from "@dawn-ai/sdk"
export async function workflow(_input: unknown, _ctx: RuntimeContext) {
  return {}
}
`

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-check-codes-"))
  tempDirs.push(appRoot)
  const appFiles = {
    "package.json": '{"type":"module"}\n',
    "dawn.config.ts": "export default {};\n",
    "src/app/hello/index.ts": VALID_ROUTE,
    ...files,
  }
  await Promise.all(
    Object.entries(appFiles).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source)
    }),
  )
  return appRoot
}

async function invoke(argv: readonly string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = await run([...argv], {
    stderr: (message: string) => {
      stderr.push(message)
    },
    stdout: (message: string) => {
      stdout.push(message)
    },
  })
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") }
}

describe("dawn check emits error codes", () => {
  test("unknown build target → [DAWN_E1003] with docs link", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": 'export default { build: { targets: ["nonsense"] } };\n',
    })
    const result = await invoke(["check", "--cwd", appRoot])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Invalid build config")
    expect(result.stderr).toContain("[DAWN_E1003]")
    expect(result.stderr).toContain("https://dawnai.org/docs/deployment")
  })

  test("invalid sandbox config → [DAWN_E1002] with docs link", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": 'export default { sandbox: { provider: { name: "bad" } } };\n',
    })
    const result = await invoke(["check", "--cwd", appRoot])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Invalid sandbox config")
    expect(result.stderr).toContain("[DAWN_E1002]")
    expect(result.stderr).toContain("https://dawnai.org/docs/configuration#sandbox")
  })
})
