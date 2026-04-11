import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function assertExists(path: string) {
  await expect(access(path, constants.F_OK)).resolves.toBeUndefined()
}

async function runCommand(command: string, args: readonly string[], cwd: string) {
  return await new Promise<{
    readonly code: number | null
    readonly stdout: string
    readonly stderr: string
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd,
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

async function packPackage(repoRoot: string, packageName: string, outputDir: string) {
  const packResult = await runCommand(
    "pnpm",
    ["--filter", packageName, "pack", "--pack-destination", outputDir],
    repoRoot,
  )

  if (packResult.code !== 0) {
    throw new Error(packResult.stderr || packResult.stdout || `Failed to pack ${packageName}`)
  }

  const tarballName = packResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => line.endsWith(".tgz"))

  if (!tarballName) {
    throw new Error(`Could not find tarball name for ${packageName}`)
  }

  return join(outputDir, basename(tarballName))
}

describe("create-dawn-app", () => {
  test("packs and installs create-dawn-app outside the repo workspace and scaffolds default published dependencies", {
    timeout: 30_000,
  }, async () => {
    const repoRoot = resolve(import.meta.dirname, "../../..")
    const buildResult = await runCommand("pnpm", ["--filter", "create-dawn-app", "build"], repoRoot)

    expect(buildResult.code).toBe(0)

    const tempRoot = await mkdtemp(join(tmpdir(), "create-dawn-app-standalone-"))
    tempDirs.push(tempRoot)

    const packDir = join(tempRoot, "packs")
    const installDir = join(tempRoot, "installer")
    const targetDir = join(tempRoot, "hello-dawn")

    await mkdir(packDir, { recursive: true })
    await mkdir(installDir, { recursive: true })

    const devkitTarball = await packPackage(repoRoot, "@dawn/devkit", packDir)
    const createAppTarball = await packPackage(repoRoot, "create-dawn-app", packDir)

    await writeFile(
      join(installDir, "package.json"),
      JSON.stringify(
        {
          name: "installer",
          private: true,
          pnpm: {
            overrides: {
              "@dawn/devkit": devkitTarball,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    )

    const installDevkitResult = await runCommand("pnpm", ["add", devkitTarball], installDir)
    expect(installDevkitResult.code).toBe(0)

    const installResult = await runCommand("pnpm", ["add", createAppTarball], installDir)
    expect(installResult.code).toBe(0)

    const scaffoldResult = await runCommand(
      "pnpm",
      ["exec", "create-dawn-app", targetDir, "--dist-tag", "next"],
      installDir,
    )
    expect(scaffoldResult.code).toBe(0)

    await assertExists(join(targetDir, "package.json"))
    await assertExists(join(targetDir, "dawn.config.ts"))
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/workflow.ts"))

    const packageJson = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8")) as {
      readonly name: string
      readonly dependencies: Record<string, string>
      readonly devDependencies: Record<string, string>
    }

    expect(packageJson.name).toBe("hello-dawn")
    expect(packageJson.dependencies["@dawn/core"]).not.toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn/cli"]).not.toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn/langgraph"]).not.toMatch(/^file:/)
    expect(packageJson.devDependencies["@dawn/config-typescript"]).not.toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn/core"]).toBe("next")
    expect(packageJson.dependencies["@dawn/cli"]).toBe("next")
    expect(packageJson.dependencies["@dawn/langgraph"]).toBe("next")
    expect(packageJson.devDependencies["@dawn/config-typescript"]).toBe("next")
    await expect(access(join(targetDir, ".npmrc"), constants.F_OK)).rejects.toThrow()

    const invalidInternalTargetDir = join(tempRoot, "hello-dawn-internal")
    const internalModeResult = await runCommand(
      "pnpm",
      ["exec", "create-dawn-app", invalidInternalTargetDir, "--mode", "internal"],
      installDir,
    )

    expect(internalModeResult.code).toBe(1)
    expect(internalModeResult.stderr).toContain("Internal mode requires a Dawn monorepo checkout")
  })

  test("supports explicit internal dev scaffolding with repo-local package edges", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "create-dawn-app-internal-"))
    tempDirs.push(tempRoot)

    const targetDir = join(tempRoot, "hello-dawn")

    const exitCode = await run([targetDir, "--mode", "internal"])

    expect(exitCode).toBe(0)

    const packageJson = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8")) as {
      readonly dependencies: Record<string, string>
      readonly devDependencies: Record<string, string>
    }

    expect(packageJson.dependencies["@dawn/core"]).toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn/cli"]).toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn/langgraph"]).toMatch(/^file:/)
    expect(packageJson.devDependencies["@dawn/config-typescript"]).toMatch(/^file:/)
    await assertExists(join(targetDir, ".npmrc"))
  })
})
