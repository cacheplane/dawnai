import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("dawn test", () => {
  test("discovers all run.test.ts files under the configured routes root", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/alpha/graph.ts": "export const graph = async () => ({ route: 'alpha' });\n",
      "src/app/alpha/run.test.ts": scenarioModule([
        {
          expect: {
            output: {
              route: "alpha",
            },
            status: "passed",
          },
          input: {},
          name: "alpha graph passes",
          target: "./graph.ts",
        },
      ]),
      "src/app/beta/workflow.ts": "export const workflow = async () => ({ route: 'beta' });\n",
      "src/app/beta/run.test.ts": scenarioModule([
        {
          expect: {
            output: {
              route: "beta",
            },
            status: "passed",
          },
          input: {},
          name: "beta workflow passes",
          target: "./workflow.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS alpha graph passes")
    expect(result.stdout).toContain("PASS beta workflow passes")
    expect(result.stdout).toContain("Summary: 2 passed, 0 failed")
  })

  test("narrows to one scenario file", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/alpha/graph.ts": "export const graph = async () => ({ route: 'alpha' });\n",
      "src/app/alpha/run.test.ts": scenarioModule([
        {
          expect: { output: { route: "alpha" }, status: "passed" },
          input: {},
          name: "alpha graph passes",
          target: "./graph.ts",
        },
      ]),
      "src/app/beta/workflow.ts": "export const workflow = async () => ({ route: 'beta' });\n",
      "src/app/beta/run.test.ts": scenarioModule([
        {
          expect: { output: { route: "beta" }, status: "passed" },
          input: {},
          name: "beta workflow passes",
          target: "./workflow.ts",
        },
      ]),
    })

    const result = await invoke(["test", "src/app/beta/run.test.ts", "--cwd", appRoot], {
      cwd: appRoot,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("alpha graph passes")
    expect(result.stdout).toContain("PASS beta workflow passes")
    expect(result.stdout).toContain("Summary: 1 passed, 0 failed")
  })

  test("narrows to one route directory including descendants", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/docs/graph.ts": "export const graph = async () => ({ section: 'docs' });\n",
      "src/app/docs/run.test.ts": scenarioModule([
        {
          expect: { output: { section: "docs" }, status: "passed" },
          input: {},
          name: "docs graph passes",
          target: "./graph.ts",
        },
      ]),
      "src/app/docs/guides/workflow.ts":
        "export const workflow = async () => ({ section: 'guides' });\n",
      "src/app/docs/guides/run.test.ts": scenarioModule([
        {
          expect: { output: { section: "guides" }, status: "passed" },
          input: {},
          name: "guides workflow passes",
          target: "./workflow.ts",
        },
      ]),
      "src/app/marketing/graph.ts":
        "export const graph = async () => ({ section: 'marketing' });\n",
      "src/app/marketing/run.test.ts": scenarioModule([
        {
          expect: { output: { section: "marketing" }, status: "passed" },
          input: {},
          name: "marketing graph passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "src/app/docs", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS docs graph passes")
    expect(result.stdout).toContain("PASS guides workflow passes")
    expect(result.stdout).not.toContain("marketing graph passes")
  })

  test("supports caller-cwd-relative narrowing", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/docs/graph.ts": "export const graph = async () => ({ section: 'docs' });\n",
      "src/app/docs/run.test.ts": scenarioModule([
        {
          expect: { output: { section: "docs" }, status: "passed" },
          input: {},
          name: "docs graph passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "./docs"], {
      cwd: join(appRoot, "src/app"),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS docs graph passes")
  })

  test("supports app-root-relative narrowing", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/docs/graph.ts": "export const graph = async () => ({ section: 'docs' });\n",
      "src/app/docs/run.test.ts": scenarioModule([
        {
          expect: { output: { section: "docs" }, status: "passed" },
          input: {},
          name: "docs graph passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "src/app/docs", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS docs graph passes")
  })

  test("honors explicit local targets when both graph.ts and workflow.ts exist in the same route directory", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ mode: 'graph' });\n",
      "src/app/support/workflow.ts":
        "export const workflow = async () => ({ mode: 'workflow' });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { output: { mode: "graph" }, status: "passed" },
          input: {},
          name: "graph companion target passes",
          target: "./graph.ts",
        },
        {
          expect: { output: { mode: "workflow" }, status: "passed" },
          input: {},
          name: "workflow companion target passes",
          target: "./workflow.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS graph companion target passes")
    expect(result.stdout).toContain("PASS workflow companion target passes")
  })

  test("rejects route-file narrowing input in v1", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ mode: 'graph' });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { output: { mode: "graph" }, status: "passed" },
          input: {},
          name: "graph companion target passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "src/app/support/graph.ts", "--cwd", appRoot], {
      cwd: appRoot,
    })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Scenario-load failure")
    expect(result.stderr).toContain("Route-file narrowing is not supported in v1")
  })

  test("rejects missing or invalid targets", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ mode: 'graph' });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { output: { mode: "graph" }, status: "passed" },
          input: {},
          name: "invalid target",
          target: "graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Scenario-load failure")
    expect(result.stderr).toContain(
      'Scenario "invalid target" target must be exactly "./graph.ts" or "./workflow.ts"',
    )
  })

  test("rejects cross-directory targets", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ mode: 'graph' });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { output: { mode: "graph" }, status: "passed" },
          input: {},
          name: "cross-directory target",
          target: "../graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Scenario-load failure")
    expect(result.stderr).toContain(
      'Scenario "cross-directory target" target must be exactly "./graph.ts" or "./workflow.ts"',
    )
  })

  test("passes a scenario that expects a modeled route failure", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": `export const graph = async () => { throw new Error("expected route failure"); };\n`,
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            error: {
              kind: "execution_error",
              message: "expected route failure",
            },
            status: "failed",
          },
          input: {},
          name: "expected failure passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS expected failure passes")
  })

  test("fails when expect.status does not match the actual route result", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { status: "failed" },
          input: {},
          name: "status mismatch fails",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("FAIL status mismatch fails [assertion]")
    expect(result.stdout).toContain("Expected status failed but received passed")
  })

  test("fails when minimal output assertions do not match", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ greeting: 'hello' });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            output: {
              greeting: "goodbye",
            },
            status: "passed",
          },
          input: {},
          name: "output mismatch fails",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL output mismatch fails [assertion]")
    expect(result.stdout).toContain("Expected output.greeting to equal")
  })

  test("fails when optional error.kind does not match", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": `export const graph = async () => { throw new Error("kind mismatch"); };\n`,
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            error: {
              kind: "route_resolution_error",
            },
            status: "failed",
          },
          input: {},
          name: "error kind mismatch fails",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL error kind mismatch fails [assertion]")
    expect(result.stdout).toContain(
      "Expected error.kind route_resolution_error but received execution_error",
    )
  })

  test("fails when optional error.message does not match", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": `export const graph = async () => { throw new Error("actual message"); };\n`,
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            error: {
              message: "expected message",
            },
            status: "failed",
          },
          input: {},
          name: "error message mismatch fails",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL error message mismatch fails [assertion]")
    expect(result.stdout).toContain(
      'Expected error.message "expected message" but received "actual message"',
    )
  })

  test("fails when an unexpected route-execution failure occurs", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": `export const graph = async () => { throw new Error("unexpected execution failure"); };\n`,
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { status: "passed" },
          input: {},
          name: "unexpected execution failure",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL unexpected execution failure [execution]")
    expect(result.stdout).toContain("unexpected execution failure")
  })

  test("returns exit 1 when no scenarios are found", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ ok: true });\n",
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("No run.test.ts scenarios found")
  })
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-test-"))
  tempDirs.push(appRoot)

  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )

  return appRoot
}

async function invoke(
  argv: readonly string[],
  options: {
    readonly cwd: string
  },
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const previousCwd = process.cwd()
  process.chdir(options.cwd)

  try {
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
  } finally {
    process.chdir(previousCwd)
  }
}

function scenarioModule(scenarios: readonly unknown[]): string {
  return `export default ${JSON.stringify(scenarios, null, 2)};\n`
}
