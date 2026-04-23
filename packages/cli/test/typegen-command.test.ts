import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFixtureApp() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-typegen-"))
  tempDirs.push(appRoot)

  const fileEntries: ReadonlyArray<readonly [string, string]> = [
    ["package.json", '{"type":"module"}'],
    ["dawn.config.ts", "export default {};\n"],
    ["src/app/index.ts", "export const graph = async () => ({});\n"],
    ["src/app/[tenant]/index.ts", "export const graph = async () => ({});\n"],
  ]

  await Promise.all(
    fileEntries.map(async ([relativePath, contents]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, contents)
    }),
  )

  return appRoot
}

async function createCustomAppDirFixture() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-typegen-custom-"))
  tempDirs.push(appRoot)

  await mkdir(join(appRoot, "src", "custom-app", "[tenant]"), { recursive: true })

  await Promise.all([
    writeFile(join(appRoot, "package.json"), '{"type":"module"}'),
    writeFile(
      join(appRoot, "dawn.config.ts"),
      'const appDir = "src/custom-app";\nexport default { appDir };\n',
    ),
    writeFile(
      join(appRoot, "src", "custom-app", "index.ts"),
      "export const graph = async () => ({});\n",
    ),
    writeFile(
      join(appRoot, "src", "custom-app", "[tenant]", "index.ts"),
      "export const graph = async () => ({});\n",
    ),
  ])

  return appRoot
}

async function runCommand(command: string, args: readonly string[], cwd: string) {
  return await new Promise<{
    readonly code: number | null
    readonly stdout: string
    readonly stderr: string
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "pipe",
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

async function packPackage(packageName: string, outputDir: string) {
  const repoRoot = resolve(import.meta.dirname, "../../..")
  const buildResult = await runCommand("pnpm", ["--filter", packageName, "build"], repoRoot)

  if (buildResult.code !== 0) {
    throw new Error(buildResult.stderr || buildResult.stdout || `Failed to build ${packageName}`)
  }

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
    .find((line) => line.endsWith(".tgz"))

  if (!tarballName) {
    throw new Error(`Could not determine tarball name for ${packageName}`)
  }

  return join(outputDir, basename(tarballName))
}

describe("dawn typegen", () => {
  test("writes generated route types into the target app", async () => {
    const appRoot = await createFixtureApp()
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await run(["typegen", "--cwd", appRoot], {
      stderr: (message: string) => {
        stderr.push(message)
      },
      stdout: (message: string) => {
        stdout.push(message)
      },
    })

    const outputPath = join(appRoot, ".dawn/dawn.generated.d.ts")
    const output = await readFile(outputPath, "utf8")

    expect(exitCode).toBe(0)
    expect(stderr.join("")).toBe("")
    expect(stdout.join("")).toContain("Wrote route types")
    expect(output).toContain('export type DawnRoutePath = "/" | "/[tenant]";')
    expect(output).toContain('"/[tenant]": { tenant: string };')
  })

  test("writes generated route types into a custom configured appDir", async () => {
    const appRoot = await createCustomAppDirFixture()
    const verifyStdout: string[] = []
    const verifyStderr: string[] = []

    const verifyExitCode = await run(["verify", "--cwd", appRoot], {
      stderr: (message: string) => {
        verifyStderr.push(message)
      },
      stdout: (message: string) => {
        verifyStdout.push(message)
      },
    })

    const exitCode = await run(["typegen", "--cwd", appRoot], {
      stderr: () => {},
      stdout: () => {},
    })

    const output = await readFile(join(appRoot, ".dawn/dawn.generated.d.ts"), "utf8")

    expect(verifyExitCode).toBe(0)
    expect(verifyStderr.join("")).toBe("")
    expect(verifyStdout.join("")).toContain("Dawn app integrity OK")
    expect(exitCode).toBe(0)
    expect(output).toContain('export type DawnRoutePath = "/" | "/[tenant]";')
  })

  test("runs from an externally installed dawn bin against a custom appDir", {
    timeout: 30_000,
  }, async () => {
    const installerRoot = await mkdtemp(join(tmpdir(), "dawn-cli-packed-installer-"))
    const packsRoot = join(installerRoot, "packs")
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-typegen-external-"))
    tempDirs.push(installerRoot, appRoot)

    await mkdir(packsRoot, { recursive: true })
    await mkdir(join(appRoot, "src", "custom-app", "[tenant]"), { recursive: true })

    const cliTarball = await packPackage("@dawnai.org/cli", packsRoot)
    const coreTarball = await packPackage("@dawnai.org/core", packsRoot)
    const langchainTarball = await packPackage("@dawnai.org/langchain", packsRoot)
    const langgraphTarball = await packPackage("@dawnai.org/langgraph", packsRoot)
    const sdkTarball = await packPackage("@dawnai.org/sdk", packsRoot)

    await writeFile(
      join(installerRoot, "package.json"),
      JSON.stringify(
        {
          name: "installer",
          private: true,
          packageManager: "pnpm@10.33.0",
          dependencies: {
            "@dawnai.org/cli": `file:${cliTarball}`,
            "@dawnai.org/core": `file:${coreTarball}`,
            "@dawnai.org/langchain": `file:${langchainTarball}`,
            "@dawnai.org/langgraph": `file:${langgraphTarball}`,
          },
          pnpm: {
            overrides: {
              "@dawnai.org/core": `file:${coreTarball}`,
              "@dawnai.org/langchain": `file:${langchainTarball}`,
              "@dawnai.org/langgraph": `file:${langgraphTarball}`,
              "@dawnai.org/sdk": `file:${sdkTarball}`,
            },
          },
        },
        null,
        2,
      ),
    )

    const installResult = await runCommand("pnpm", ["install"], installerRoot)
    expect(
      installResult.code,
      `pnpm install failed:\n${installResult.stderr}\n${installResult.stdout}`,
    ).toBe(0)

    await Promise.all([
      writeFile(join(appRoot, "package.json"), '{"type":"module"}'),
      writeFile(
        join(appRoot, "dawn.config.ts"),
        'const appDir = "src/custom-app";\nexport default { appDir };\n',
      ),
      writeFile(
        join(appRoot, "src", "custom-app", "index.ts"),
        "export const graph = async () => ({});\n",
      ),
      writeFile(
        join(appRoot, "src", "custom-app", "[tenant]", "index.ts"),
        "export const graph = async () => ({});\n",
      ),
    ])

    const externalBin = join(installerRoot, "node_modules", ".bin", "dawn")
    const verifyResult = await runCommand(externalBin, ["verify", "--cwd", appRoot], installerRoot)
    const typegenResult = await runCommand(
      externalBin,
      ["typegen", "--cwd", appRoot],
      installerRoot,
    )

    expect(verifyResult.code).toBe(0)
    expect(verifyResult.stderr).toBe("")
    expect(verifyResult.stdout).toContain("Dawn app integrity OK")
    expect(typegenResult.code).toBe(0)
    expect(typegenResult.stderr).toBe("")
    await expect(
      readFile(join(appRoot, ".dawn", "dawn.generated.d.ts"), "utf8"),
    ).resolves.toContain('export type DawnRoutePath = "/" | "/[tenant]";')
  })
})
