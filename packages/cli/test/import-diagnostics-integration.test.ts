import { spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

/**
 * End-to-end coverage for Dawn's enriched import diagnostics.
 *
 * This MUST exercise the compiled CLI as a real Node subprocess. An in-process
 * `run()` test does NOT reproduce the failure: vitest's Vite layer intercepts
 * dynamic `import()` and resolves missing named imports to `undefined`, so the
 * genuine "does not provide an export named" loader error never fires. Only the
 * real Node/tsx loader (running in a spawned `dawn` process) produces it, which
 * is what `diagnose()` + `importModule` classify and enrich.
 */

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-import-diag-"))
  tempDirs.push(appRoot)

  const appFiles = {
    "package.json": '{"type":"module"}\n',
    "dawn.config.ts": "export default {};\n",
    // A real CommonJS dependency in the app's node_modules. The named export is
    // written as `exports.present = ...` (not `module.exports = { present }`) so
    // that Node's cjs-module-lexer can statically detect it — that detection is
    // exactly what lets the control case bind `present` successfully while a
    // genuinely-absent name still throws the opaque ESM loader error.
    "node_modules/legacy-dep/package.json":
      '{ "name": "legacy-dep", "version": "1.0.0", "type": "commonjs", "main": "index.js" }\n',
    "node_modules/legacy-dep/index.js": "exports.present = 1\n",
    // A valid workflow route. A workflow needs no runtime sdk import (the type is
    // erased by tsx), so the spawned CLI resolves it without workspace wiring,
    // and tool discovery still descends into the route-local `tools/` directory.
    "src/app/x/index.ts": "export const workflow = async () => ({ ok: true })\n",
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

async function buildCliExecutable() {
  const packageRoot = resolve(import.meta.dirname, "..")
  const distEntry = join(packageRoot, "dist", "index.js")

  await new Promise<void>((resolvePromise, rejectPromise) => {
    // No `--force`: it rebuilds every referenced project (incl. @dawn-ai/core)
    // unconditionally, rewriting the SHARED packages/core/dist mid-suite. Under
    // vitest's parallel files that races other tests spawning processes which
    // import @dawn-ai/core from that dist (a half-written dist → "does not
    // provide an export" crash). Plain `tsc -b` is a no-op when already built.
    const child = spawn("pnpm", ["exec", "tsc", "-b", "tsconfig.build.json"], {
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
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
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

describe("dawn check import diagnostics (subprocess)", () => {
  test("enriches a stale/CommonJS named-import failure with package, CommonJS hint, and the missing export", {
    timeout: 60_000,
  }, async () => {
    const appRoot = await createFixtureApp({
      // A route-local tool that imports a guaranteed-absent named binding from
      // the CommonJS dependency. The real Node/tsx loader throws the opaque
      // "does not provide an export named" error, which Dawn enriches.
      "src/app/x/tools/load.ts":
        'import { absent } from "legacy-dep"\n\nexport default async () => absent\n',
    })
    const builtCli = await buildCliExecutable()

    const result = await executeCli(builtCli, ["check", "--cwd", appRoot])
    const combined = `${result.stdout}${result.stderr}`

    expect(result.code).not.toBe(0)
    expect(combined).toContain("legacy-dep")
    expect(combined).toMatch(/CommonJS/i)
    expect(combined).toContain("absent")
  })

  test("control: an existing named import from the same dependency passes with no diagnostic", {
    timeout: 60_000,
  }, async () => {
    const appRoot = await createFixtureApp({
      // Identical fixture except the tool imports `present`, which the CJS dep
      // actually exposes. This proves the diagnostic is not a false positive.
      "src/app/x/tools/load.ts":
        'import { present } from "legacy-dep"\n\nexport default async () => present\n',
    })
    const builtCli = await buildCliExecutable()

    const result = await executeCli(builtCli, ["check", "--cwd", appRoot])
    const combined = `${result.stdout}${result.stderr}`

    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Dawn app is valid")
    expect(combined).not.toMatch(/CommonJS/i)
  })
})
