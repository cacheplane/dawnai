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
const typescriptCliPath = resolve(repoRoot, "node_modules/typescript/bin/tsc")
const compilerTimeoutMs = 10_000
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf8")
}

test("generated scenario declarations compile with private application tool types", {
  timeout: 15_000,
}, async () => {
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

  const result = await runCompilerProcess({
    compilerPath: typescriptCliPath,
    timeoutMs: compilerTimeoutMs,
    tsconfigPath,
  })
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

test("terminates the compiler process when its timeout expires", { timeout: 5_000 }, async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-scenario-compiler-timeout-"))
  tempDirs.push(appRoot)
  const compilerPath = join(appRoot, "hanging-compiler.mjs")
  await createFile(
    compilerPath,
    [
      'process.stdout.write("compiler stdout\\n")',
      'process.stderr.write("compiler stderr\\n")',
      "setInterval(() => {}, 1_000)",
      "",
    ].join("\n"),
  )

  let error: unknown
  try {
    await runCompilerProcess({
      compilerPath,
      timeoutMs: 1_000,
      tsconfigPath: join(appRoot, "unused-tsconfig.json"),
    })
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain("timed out after 1000ms")
  expect((error as Error).message).toContain("compiler stdout")
  expect((error as Error).message).toContain("compiler stderr")
})

async function runCompilerProcess(options: {
  readonly compilerPath: string
  readonly timeoutMs: number
  readonly tsconfigPath: string
}): Promise<{
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [options.compilerPath, "-p", options.tsconfigPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, options.timeoutMs)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      rejectPromise(
        new Error(
          formatCompilerFailure(
            `Failed to start TypeScript compiler: ${error.message}`,
            stdout,
            stderr,
          ),
        ),
      )
    })
    child.once("close", (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (timedOut) {
        rejectPromise(
          new Error(
            formatCompilerFailure(
              `TypeScript compiler timed out after ${options.timeoutMs}ms`,
              stdout,
              stderr,
            ),
          ),
        )
        return
      }
      resolvePromise({ exitCode, stderr, stdout })
    })
  })
}

function formatCompilerFailure(summary: string, stdout: string, stderr: string): string {
  return [summary, `stdout:\n${stdout}`, `stderr:\n${stderr}`].join("\n")
}
