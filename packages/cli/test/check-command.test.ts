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

async function createFixtureApp(files: readonly string[]) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-check-"))
  tempDirs.push(appRoot)

  await Promise.all(
    files.map(async (relativePath) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, relativePath.endsWith(".json") ? "{}" : "export default {};\n")
    }),
  )

  return appRoot
}

async function createAuthoringFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-check-authoring-"))
  tempDirs.push(appRoot)

  const appFiles = {
    "package.json": "{}\n",
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
  test("exits cleanly for a valid fixture app and reports validation success", async () => {
    const appRoot = await createFixtureApp([
      "package.json",
      "dawn.config.ts",
      "src/app/page.tsx",
      "src/app/[tenant]/graph.ts",
    ])

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Dawn app is valid")
    expect(result.stdout).toContain("/[tenant]")
    expect(result.stderr).toBe("")
  })

  test("exits non-zero for an invalid fixture app and reports the failing validation", async () => {
    const appRoot = await createFixtureApp(["package.json", "dawn.config.ts"])

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Validation failed")
    expect(result.stderr).toContain("Missing:")
  })

  test("runs check and verify from the built dawn executable for direct and symlinked invocation paths", async () => {
    const appRoot = await createFixtureApp(["package.json", "dawn.config.ts", "src/app/page.tsx"])
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

  test("fails when shared tools collide within the same scope", async () => {
    const appRoot = await createAuthoringFixtureApp({
      "src/tools/a.ts": 'export default { name: "greet", run: async () => "hello from a" };\n',
      "src/tools/b.ts": 'export default { name: "greet", run: async () => "hello from b" };\n',
      "src/app/hello/[tenant]/route.ts":
        'export const route = { kind: "workflow", entry: "./workflow.ts" };\n',
      "src/app/hello/[tenant]/workflow.ts": "export const workflow = async () => ({ ok: true });\n",
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Validation failed")
    expect(result.stderr).toContain(
      `Duplicate shared Dawn tool name "greet" detected at ${join(appRoot, "src/tools/a.ts")} and ${join(appRoot, "src/tools/b.ts")}`,
    )
  })

  test("fails when route-local tools collide within the same scope", async () => {
    const appRoot = await createAuthoringFixtureApp({
      "src/app/hello/[tenant]/route.ts":
        'export const route = { kind: "workflow", entry: "./workflow.ts" };\n',
      "src/app/hello/[tenant]/workflow.ts": "export const workflow = async () => ({ ok: true });\n",
      "src/app/hello/[tenant]/tools/a.ts":
        'export default { name: "greet", run: async () => "hello from a" };\n',
      "src/app/hello/[tenant]/tools/b.ts":
        'export default { name: "greet", run: async () => "hello from b" };\n',
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Validation failed")
    expect(result.stderr).toContain(
      `Duplicate route-local Dawn tool name "greet" detected at ${join(appRoot, "src/app/hello/[tenant]/tools/a.ts")} and ${join(appRoot, "src/app/hello/[tenant]/tools/b.ts")}`,
    )
  })

  test("fails when route.ts binds to a missing executable file", async () => {
    const appRoot = await createAuthoringFixtureApp({
      "src/app/hello/[tenant]/route.ts":
        'export const route = { kind: "workflow", entry: "./workflow.ts" };\n',
      "src/app/hello/[tenant]/graph.ts": "export const graph = async () => ({ ok: true });\n",
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Validation failed")
    expect(result.stderr).toContain(
      `Route definition ${join(appRoot, "src/app/hello/[tenant]/route.ts")} binds to missing executable file: ${join(appRoot, "src/app/hello/[tenant]/workflow.ts")}`,
    )
  })

  test("fails when route.ts kind and entry do not match", async () => {
    const appRoot = await createAuthoringFixtureApp({
      "src/app/hello/[tenant]/route.ts":
        'export const route = { kind: "workflow", entry: "./graph.ts" };\n',
      "src/app/hello/[tenant]/graph.ts": "export const graph = async () => ({ ok: true });\n",
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Validation failed")
    expect(result.stderr).toContain(
      `Route definition ${join(appRoot, "src/app/hello/[tenant]/route.ts")} kind "workflow" must bind entry "./workflow.ts", received "./graph.ts"`,
    )
  })

  test("fails when a route.ts-bound workflow export is not callable", async () => {
    const appRoot = await createAuthoringFixtureApp({
      "src/app/hello/[tenant]/route.ts":
        'export const route = { kind: "workflow", entry: "./workflow.ts" };\n',
      "src/app/hello/[tenant]/workflow.ts":
        "export const workflow = { invoke: async () => ({ ok: true }) };\n",
    })

    const result = await invoke(["check", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Validation failed")
    expect(result.stderr).toContain(
      `Authoring workflow route at ${join(appRoot, "src/app/hello/[tenant]/workflow.ts")} must export a callable "workflow" handler`,
    )
  })
})
