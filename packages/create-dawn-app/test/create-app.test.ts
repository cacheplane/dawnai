import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { createPackagedInstaller } from "../../../test/generated/harness.ts"
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

describe("create-dawn-app", () => {
  test("scaffolds external mode from the packaged bin with published dist-tag specifiers", {
    timeout: 30_000,
  }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "create-dawn-app-standalone-"))
    tempDirs.push(tempRoot)

    const { installerDir: installDir } = await createPackagedInstaller({
      tempRoot,
    })
    const targetDir = join(tempRoot, "hello-dawn")

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
      readonly scripts: Record<string, string>
    }

    expect(packageJson.name).toBe("hello-dawn")
    expect(packageJson.scripts.build).toBe("tsc -p tsconfig.json")
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit")
    expect(packageJson.dependencies["@dawn/core"]).not.toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn/cli"]).not.toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn/langgraph"]).not.toMatch(/^file:/)
    expect(packageJson.devDependencies["@dawn/config-typescript"]).not.toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn/core"]).toBe("next")
    expect(packageJson.dependencies["@dawn/cli"]).toBe("next")
    expect(packageJson.dependencies["@dawn/langgraph"]).toBe("next")
    expect(packageJson.devDependencies["@dawn/config-typescript"]).toBe("next")
    await expect(access(join(targetDir, ".npmrc"), constants.F_OK)).rejects.toThrow()
  })

  test("rejects packaged internal mode outside a Dawn monorepo checkout", {
    timeout: 30_000,
  }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "create-dawn-app-standalone-"))
    tempDirs.push(tempRoot)

    const { installerDir: installDir } = await createPackagedInstaller({
      tempRoot,
    })

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
      readonly scripts: Record<string, string>
    }

    expect(packageJson.scripts.build).toBe("tsc -p tsconfig.json")
    expect(packageJson.dependencies["@dawn/core"]).toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn/cli"]).toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn/langgraph"]).toMatch(/^file:/)
    expect(packageJson.devDependencies["@dawn/config-typescript"]).toMatch(/^file:/)
    await assertExists(join(targetDir, ".npmrc"))
  })
})
