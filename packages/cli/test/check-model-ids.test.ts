import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-check-models-"))
  tempDirs.push(appRoot)

  const appFiles = {
    "package.json": '{"type":"module"}\n',
    "dawn.config.ts": "export default {};\n",
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

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  }
}

describe("dawn check model id warnings", () => {
  test("warns with suggestions for an unknown model id but still exits 0", async () => {
    const appRoot = await createFixtureApp({
      "src/app/(public)/draft/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5",
  systemPrompt: "You draft things.",
})
`,
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`model "gpt-5" is not a known openai model id`)
    expect(result.stdout).toContain("gpt-5.4")
    expect(result.stdout).toContain("gpt-5.5")
    expect(result.stdout).toContain("/draft")
    expect(result.stdout).toContain("Dawn app is valid")
  })

  test("stays silent for a curated model id", async () => {
    const appRoot = await createFixtureApp({
      "src/app/(public)/draft/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5.5",
  systemPrompt: "You draft things.",
})
`,
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("is not a known")
  })

  test("stays silent for providers without a curated list", async () => {
    const appRoot = await createFixtureApp({
      "src/app/(public)/draft/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "llama3.1",
  provider: "ollama",
  systemPrompt: "You draft things.",
})
`,
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("is not a known")
  })
})
