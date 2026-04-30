import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"

import {
  cleanupTrackedTempDirs,
  createPackagedInstaller,
  createTrackedTempDir,
  type TrackedTempDir,
} from "../../../test/harness/packaged-app.ts"
import { run } from "../src/index.js"

const tempDirs: TrackedTempDir[] = []

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
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

function resolveFileSpecifier(specifier: string): string {
  return specifier.startsWith("file://")
    ? fileURLToPath(specifier)
    : specifier.slice("file:".length)
}

describe("create-dawn-app", () => {
  test("scaffolds external mode from the packaged bin with published dist-tag specifiers", {
    timeout: 30_000,
  }, async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-standalone-", tempDirs)

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
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/index.ts"))
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/state.ts"))
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/tools/greet.ts"))

    const packageJson = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8")) as {
      readonly name: string
      readonly dependencies: Record<string, string>
      readonly devDependencies: Record<string, string>
      readonly scripts: Record<string, string>
    }

    expect(packageJson.name).toBe("hello-dawn")
    expect(packageJson.scripts.build).toBe("tsc -p tsconfig.json")
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit")
    expect(packageJson.dependencies["@dawn-ai/core"]).not.toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn-ai/cli"]).not.toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn-ai/langgraph"]).not.toMatch(/^file:/)
    expect(packageJson.devDependencies["@dawn-ai/config-typescript"]).not.toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn-ai/core"]).toBe("next")
    expect(packageJson.dependencies["@dawn-ai/cli"]).toBe("next")
    expect(packageJson.dependencies["@dawn-ai/langgraph"]).toBe("next")
    expect(packageJson.devDependencies["@dawn-ai/config-typescript"]).toBe("next")
    await expect(access(join(targetDir, ".npmrc"), constants.F_OK)).rejects.toThrow()
  })

  test("rejects packaged internal mode outside a Dawn monorepo checkout", {
    timeout: 30_000,
  }, async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-standalone-", tempDirs)

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
    const tempRoot = await createTrackedTempDir("create-dawn-app-internal-", tempDirs)

    const targetDir = join(tempRoot, "hello-dawn")

    const exitCode = await run([targetDir, "--mode", "internal"])

    expect(exitCode).toBe(0)

    const packageJson = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8")) as {
      readonly dependencies: Record<string, string>
      readonly devDependencies: Record<string, string>
      readonly scripts: Record<string, string>
    }

    expect(packageJson.scripts.build).toBe("tsc -p tsconfig.json")
    expect(packageJson.dependencies["@dawn-ai/core"]).toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn-ai/cli"]).toMatch(/^file:/)
    expect(packageJson.dependencies["@dawn-ai/langgraph"]).toMatch(/^file:/)
    expect(packageJson.devDependencies["@dawn-ai/config-typescript"]).toMatch(/^file:/)
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/index.ts"))
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/state.ts"))
    await assertExists(join(targetDir, "src/app/(public)/hello/[tenant]/tools/greet.ts"))
    await assertExists(join(targetDir, ".npmrc"))
  })

  test("writes contributor-local package specifiers and overrides as stable repo-local paths", async () => {
    const tempRoot = await createTrackedTempDir("create-dawn-app-internal-", tempDirs)
    const targetDir = join(tempRoot, "hello-dawn")
    const repoRoot = resolve(import.meta.dirname, "../../..")

    const exitCode = await run([targetDir, "--mode", "internal"])

    expect(exitCode).toBe(0)

    const packageJson = JSON.parse(await readFile(join(targetDir, "package.json"), "utf8")) as {
      readonly dependencies: Record<string, string>
      readonly devDependencies: Record<string, string>
      readonly pnpm?: {
        readonly overrides?: Record<string, string>
      }
    }

    expect(resolveFileSpecifier(packageJson.dependencies["@dawn-ai/core"])).toBe(
      resolve(repoRoot, "packages/core"),
    )
    expect(resolveFileSpecifier(packageJson.dependencies["@dawn-ai/cli"])).toBe(
      resolve(repoRoot, "packages/cli"),
    )
    expect(resolveFileSpecifier(packageJson.dependencies["@dawn-ai/langgraph"])).toBe(
      resolve(repoRoot, "packages/langgraph"),
    )
    expect(resolveFileSpecifier(packageJson.devDependencies["@dawn-ai/config-typescript"])).toBe(
      resolve(repoRoot, "packages/config-typescript"),
    )
    expect(resolveFileSpecifier(packageJson.pnpm?.overrides?.["@dawn-ai/core"] ?? "")).toBe(
      resolve(repoRoot, "packages/core"),
    )
    expect(resolveFileSpecifier(packageJson.pnpm?.overrides?.["@dawn-ai/cli"] ?? "")).toBe(
      resolve(repoRoot, "packages/cli"),
    )
    expect(resolveFileSpecifier(packageJson.pnpm?.overrides?.["@dawn-ai/langgraph"] ?? "")).toBe(
      resolve(repoRoot, "packages/langgraph"),
    )
    expect(
      resolveFileSpecifier(packageJson.pnpm?.overrides?.["@dawn-ai/config-typescript"] ?? ""),
    ).toBe(resolve(repoRoot, "packages/config-typescript"))
  })
})
