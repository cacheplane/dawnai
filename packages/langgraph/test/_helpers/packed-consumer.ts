import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

export interface PackedConsumer {
  readonly consumerDir: string
  readonly tarballPath: string
  readonly sdkTarballPath: string
  readonly tempRoot: string
}

const LANGGRAPH_PACKAGE_ROOT = resolve(import.meta.dirname, "../..")
const SDK_PACKAGE_ROOT = resolve(import.meta.dirname, "../../../sdk")

export async function createPackedConsumer(): Promise<PackedConsumer> {
  const tempRoot = await mkdtemp(join(tmpdir(), "dawn-langgraph-pack-"))
  const consumerDir = join(tempRoot, "consumer")

  await writeFile(
    join(tempRoot, "package.json"),
    JSON.stringify({ name: "pack-root", private: true }),
  )

  await runCommand("pnpm", ["exec", "tsc", "-b", "tsconfig.json", "--force"], SDK_PACKAGE_ROOT)
  const sdkPackOutput = await runCommand(
    "pnpm",
    ["pack", "--pack-destination", tempRoot],
    SDK_PACKAGE_ROOT,
  )
  const sdkTarballPath = resolveTarballPath(sdkPackOutput.stdout, tempRoot, "@dawn-ai/sdk")

  await runCommand(
    "pnpm",
    ["exec", "tsc", "-b", "tsconfig.json", "--force"],
    LANGGRAPH_PACKAGE_ROOT,
  )
  const packOutput = await runCommand(
    "pnpm",
    ["pack", "--pack-destination", tempRoot],
    LANGGRAPH_PACKAGE_ROOT,
  )
  const tarballPath = resolveTarballPath(packOutput.stdout, tempRoot, "@dawn-ai/langgraph")

  await mkdir(consumerDir, { recursive: true })
  await writeFile(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "consumer",
        private: true,
        pnpm: { overrides: { "@dawn-ai/sdk": `file:${sdkTarballPath}` } },
      },
      null,
      2,
    ),
  )
  await runCommand("pnpm", ["add", sdkTarballPath, tarballPath], consumerDir)

  return {
    consumerDir,
    sdkTarballPath,
    tarballPath,
    tempRoot,
  }
}

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await new Promise<{ readonly stdout: string; readonly stderr: string }>(
    (resolvePromise, rejectPromise) => {
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
        if (code === 0) {
          resolvePromise({ stderr, stdout })
          return
        }

        rejectPromise(
          new Error(
            [`${command} ${args.join(" ")} failed`, stdout, stderr].filter(Boolean).join("\n"),
          ),
        )
      })
    },
  )
}

function resolveTarballPath(packStdout: string, outputDir: string, packageName: string): string {
  const tarballName = packStdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz"))

  if (!tarballName) {
    throw new Error(`Could not determine ${packageName} tarball name`)
  }

  return join(outputDir, basename(tarballName))
}
