import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { normalizeRouteModule } from "@dawn/langgraph"
import type {
  GraphRouteModule,
  RouteModule,
  WorkflowRouteModule,
} from "@dawn/langgraph/route-module"
import { afterEach, describe, expect, test } from "vitest"

const packageRoot = resolve(import.meta.dirname, "..")
const packageJsonPath = join(packageRoot, "package.json")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function runCommand(
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

function resolveTarballPath(packStdout: string, outputDir: string) {
  const tarballName = packStdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz"))

  if (!tarballName) {
    throw new Error("Could not determine @dawn/langgraph tarball name")
  }

  return join(outputDir, basename(tarballName))
}

describe("@dawn/langgraph route-module", () => {
  test("exposes publishable exports and types on the package surface", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      readonly exports: Record<string, { readonly types: string; readonly default: string }>
      readonly types: string
    }

    expect(packageJson.types).toBe("./dist/index.d.ts")
    expect(packageJson.exports["."]?.types).toBe("./dist/index.d.ts")
    expect(packageJson.exports["."]?.default).toBe("./dist/index.js")
    expect(packageJson.exports["./route-module"]?.types).toBe("./dist/route-module.d.ts")
  })

  test("exposes types and helpers that core and template apps can consume without a second runtime", () => {
    const graph = () => "graph"
    const workflow = () => "workflow"

    const graphModule = {
      graph,
      config: {
        runtime: "node",
      },
    } satisfies GraphRouteModule<typeof graph>

    const workflowModule = {
      workflow,
      config: {
        streaming: true,
      },
    } satisfies WorkflowRouteModule<typeof workflow>

    const normalizedGraph = normalizeRouteModule(graphModule satisfies RouteModule<typeof graph>)
    const normalizedWorkflow = normalizeRouteModule(
      workflowModule satisfies RouteModule<typeof workflow>,
    )

    expect(normalizedGraph.kind).toBe("graph")
    expect(normalizedWorkflow.kind).toBe("workflow")
  })

  test("packed consumers can resolve the route-module subpath export", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "dawn-langgraph-route-module-"))
    const consumerDir = join(tempRoot, "consumer")
    tempDirs.push(tempRoot)

    await writeFile(
      join(tempRoot, "package.json"),
      JSON.stringify({ name: "pack-root", private: true }),
    )
    await runCommand("pnpm", ["exec", "tsc", "-b", "tsconfig.json", "--force"], packageRoot)
    const packOutput = await runCommand(
      "pnpm",
      ["pack", "--pack-destination", tempRoot],
      packageRoot,
    )
    const tarballPath = resolveTarballPath(packOutput.stdout, tempRoot)
    await mkdir(consumerDir, { recursive: true })
    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify({ name: "consumer", private: true }, null, 2),
    )
    await runCommand("pnpm", ["add", tarballPath], consumerDir)

    const scriptPath = join(consumerDir, "route-module-check.mjs")
    await writeFile(
      scriptPath,
      [
        'import { normalizeRouteModule } from "@dawn/langgraph/route-module";',
        "const workflow = () => 'workflow';",
        "const normalized = normalizeRouteModule({ workflow, config: { runtime: 'node' } });",
        "if (normalized.kind !== 'workflow' || normalized.config.runtime !== 'node') {",
        "  throw new Error('packed subpath export failed');",
        "}",
      ].join("\n"),
    )

    await expect(runCommand("node", [scriptPath], consumerDir)).resolves.toEqual({
      stderr: "",
      stdout: "",
    })
  })
})
