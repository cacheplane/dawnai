import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { SCENARIO_TYPES_FILE } from "@dawn-ai/core"
import { discoverRoutes } from "@dawn-ai/core/node"
import { afterEach, expect, test } from "vitest"

import { runTypegen } from "../src/lib/typegen/run-typegen.js"

const repoRoot = resolve(import.meta.dirname, "../../..")
const sdkTestingEntry = resolve(import.meta.dirname, "../../sdk/src/testing/index.ts")
const nodeTypesRoot = resolve(import.meta.dirname, "../node_modules/@types")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf8")
}

test("generated scenario declarations compile with private application tool types", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-scenario-typegen-contract-"))
  tempDirs.push(appRoot)

  await Promise.all([
    createFile(join(appRoot, "package.json"), '{"type":"module"}\n'),
    createFile(join(appRoot, "dawn.config.ts"), "export default {}\n"),
    createFile(
      join(appRoot, "src", "app", "hello", "index.ts"),
      "export const agent = async () => ({})\n",
    ),
    createFile(
      join(appRoot, "src", "app", "hello", "tools", "greet.ts"),
      [
        "interface GreetInput {",
        "  readonly name: string",
        '  readonly punctuation?: "!" | "?"',
        "}",
        "",
        "interface GreetOutput {",
        "  readonly message: string",
        "  readonly nameLength: number",
        "}",
        "",
        "export default async function greet(input: GreetInput): Promise<GreetOutput> {",
        "  return {",
        '    message: "Hello, " + input.name + (input.punctuation ?? "!"),',
        "    nameLength: input.name.length,",
        "  }",
        "}",
        "",
      ].join("\n"),
    ),
    createFile(
      join(appRoot, "run.test.ts"),
      [
        'import { expectOutput, scenarios } from "@dawn-ai/sdk/testing"',
        "",
        'export default scenarios("/hello").scenario("greets with a mocked tool", (scenario) =>',
        "  scenario",
        '    .input({ name: "Ada" })',
        '    .mockTool("greet", async (input) => ({',
        '      message: "Hello, " + input.name + (input.punctuation ?? "!"),',
        "      nameLength: input.name.length,",
        "    }))",
        "    .expectPassed()",
        "    .assert((result) => {",
        '      expectOutput(result, { message: "Hello, Ada!", nameLength: 3 })',
        "    }),",
        ")",
        "",
      ].join("\n"),
    ),
  ])

  const manifest = await discoverRoutes({ appRoot })
  await runTypegen({ appRoot, manifest })

  const tsconfigPath = join(appRoot, "tsconfig.scenarios.json")
  await createFile(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          paths: {
            "@dawn-ai/sdk/testing": [sdkTestingEntry],
          },
          strict: true,
          target: "ES2022",
          typeRoots: [nodeTypesRoot],
          types: ["node"],
        },
        files: ["run.test.ts", ".dawn/dawn.generated.d.ts", `.dawn/${SCENARIO_TYPES_FILE}`],
      },
      null,
      2,
    )}\n`,
  )

  const result = await spawnTsc(tsconfigPath)
  expect(
    result.exitCode,
    [`tsc exited with ${result.exitCode}`, `stdout:\n${result.stdout}`, `stderr:\n${result.stderr}`]
      .filter(Boolean)
      .join("\n"),
  ).toBe(0)

  const scenarioTypesPath = join(appRoot, ".dawn", SCENARIO_TYPES_FILE)
  const scenarioTypes = await readFile(scenarioTypesPath, "utf8")
  expect(scenarioTypes).toContain(
    'Parameters<typeof import("../src/app/hello/tools/greet.js").default>[0]',
  )
  expect(scenarioTypes).toContain(
    'Awaited<ReturnType<typeof import("../src/app/hello/tools/greet.js").default>>',
  )
})

async function spawnTsc(tsconfigPath: string): Promise<{
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("pnpm", ["exec", "tsc", "-p", tsconfigPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", rejectPromise)
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode, stderr, stdout })
    })
  })
}
