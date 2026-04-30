import { spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-check-"))
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

async function buildCliExecutable() {
  const packageRoot = resolve(import.meta.dirname, "..")
  const distEntry = join(packageRoot, "dist", "index.js")

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("pnpm", ["exec", "tsc", "-b", "tsconfig.build.json", "--force"], {
      cwd: packageRoot,
      stdio: "inherit",
    })

    child.once("error", rejectPromise)
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      rejectPromise(new Error(`CLI build failed with exit code ${code ?? "unknown"}`))
    })
  })

  await chmod(distEntry, 0o755)

  return distEntry
}

async function executeCli(entryPath: string, args: readonly string[]) {
  return await new Promise<{
    readonly code: number | null
    readonly stdout: string
    readonly stderr: string
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(entryPath, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })

    child.once("error", rejectPromise)
    child.once("close", (code) => {
      resolvePromise({ code, stderr, stdout })
    })
  })
}

describe("dawn check", () => {
  test("passes for an app with a workflow index.ts and reports the route list", async () => {
    const appRoot = await createFixtureApp({
      "src/app/hello/index.ts": `import type { RuntimeContext } from "@dawn-ai/sdk"
export async function workflow(_input: unknown, _ctx: RuntimeContext) {
  return {}
}
`,
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Dawn app is valid")
    expect(result.stdout).toContain("1 routes discovered")
    expect(result.stdout).toContain("- /hello (workflow)")
  })

  test("passes for an app with a graph index.ts", async () => {
    const appRoot = await createFixtureApp({
      "src/app/support/[tenant]/index.ts": `import type { RuntimeContext } from "@dawn-ai/sdk"
export const graph = {
  invoke: async (_input: unknown, _ctx: RuntimeContext) => ({}),
}
`,
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Dawn app is valid")
    expect(result.stdout).toContain("- /support/[tenant] (graph)")
  })

  test("fails when an index.ts exports both workflow and graph", async () => {
    const appRoot = await createFixtureApp({
      "src/app/hello/index.ts": `export async function workflow() { return {} }
export const graph = { invoke: async () => ({}) }
`,
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Validation failed")
    expect(result.stderr).toContain(`must export exactly one of "workflow", "graph", or "chain"`)
  })

  test("ignores route directories that have no index.ts", async () => {
    const appRoot = await createFixtureApp({
      "src/app/hello/index.ts": `export async function workflow() { return {} }
`,
      "src/app/empty/notes.md": "# just notes\n",
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("1 routes discovered")
    expect(result.stdout).toContain("- /hello (workflow)")
    expect(result.stdout).not.toContain("/empty")
  })

  test("returns a nonzero exit code and a stable error prefix for invalid apps", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-check-invalid-"))
    tempDirs.push(appRoot)
    await writeFile(join(appRoot, "package.json"), '{"type":"module"}\n')
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {};\n")

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Validation failed")
    expect(result.stderr).toContain("Missing:")
  })

  test("runs check and verify from the built dawn executable for direct and symlinked invocation paths", {
    timeout: 30_000,
  }, async () => {
    const appRoot = await createFixtureApp({
      "src/app/hello/index.ts": `export async function workflow() { return {} }
`,
    })
    const builtCli = await buildCliExecutable()
    const builtSource = await readFile(builtCli, "utf8")
    const symlinkPath = join(appRoot, "dawn-link.js")

    await symlink(builtCli, symlinkPath)

    const directCheckResult = await executeCli(builtCli, ["check", "--cwd", appRoot])
    const directVerifyResult = await executeCli(builtCli, ["verify", "--cwd", appRoot])
    const symlinkCheckResult = await executeCli(symlinkPath, ["check", "--cwd", appRoot])
    const symlinkVerifyResult = await executeCli(symlinkPath, ["verify", "--cwd", appRoot])

    expect(builtSource.startsWith("#!/usr/bin/env node")).toBe(true)
    expect(directCheckResult.code).toBe(0)
    expect(directCheckResult.stderr).toBe("")
    expect(directCheckResult.stdout).toContain("Dawn app is valid")
    expect(directVerifyResult.code).toBe(0)
    expect(directVerifyResult.stderr).toBe("")
    expect(directVerifyResult.stdout).toContain("Dawn app integrity OK")
    expect(symlinkCheckResult.code).toBe(0)
    expect(symlinkCheckResult.stderr).toBe("")
    expect(symlinkCheckResult.stdout).toContain("Dawn app is valid")
    expect(symlinkVerifyResult.code).toBe(0)
    expect(symlinkVerifyResult.stderr).toBe("")
    expect(symlinkVerifyResult.stdout).toContain("Dawn app integrity OK")
  })

  test("passes when shared tools each have unique names derived from their filenames", async () => {
    const appRoot = await createFixtureApp({
      "src/tools/greet.ts": "export default async (input: unknown) => ({ greeting: 'hi' });\n",
      "src/tools/farewell.ts": "export default async (input: unknown) => ({ farewell: 'bye' });\n",
      "src/app/hello/[tenant]/index.ts": "export const workflow = async () => ({ ok: true });\n",
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Dawn app is valid")
  })

  test("passes when route-local tools each have unique names derived from their filenames", async () => {
    const appRoot = await createFixtureApp({
      "src/app/hello/[tenant]/index.ts": "export const workflow = async () => ({ ok: true });\n",
      "src/app/hello/[tenant]/tools/greet.ts":
        "export default async (input: unknown) => ({ greeting: 'hi' });\n",
      "src/app/hello/[tenant]/tools/farewell.ts":
        "export default async (input: unknown) => ({ farewell: 'bye' });\n",
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Dawn app is valid")
  })

  test("fails when a shared tool module does not default export a function", async () => {
    const appRoot = await createFixtureApp({
      "src/tools/broken.ts": "export default 'not a function';\n",
      "src/app/hello/[tenant]/index.ts": "export const workflow = async () => ({ ok: true });\n",
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Validation failed")
    expect(result.stderr).toContain(
      `Tool file ${join(appRoot, "src/tools/broken.ts")} must default export a function`,
    )
  })
})
