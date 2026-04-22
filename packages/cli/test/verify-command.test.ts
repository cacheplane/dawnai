import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []
const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testDir, "../../..")

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-verify-"))
  tempDirs.push(appRoot)

  const appFiles = {
    "package.json": "{}\n",
    "dawn.config.ts": "export default {};\n",
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

async function invoke(argv: readonly string[]) {
  const stdout: string[] = []
  const stderr: string[] = []

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
}

function contractFixtureRoot(name: string) {
  return join(repoRoot, "test", "fixtures", "contracts", name)
}

describe("dawn verify", () => {
  test("succeeds for a valid index.ts app and reports a concise integrity summary", async () => {
    const appRoot = await createFixtureApp({
      "src/app/hello/index.ts": "export async function workflow() { return {} }\n",
      "src/app/support/[tenant]/index.ts": "export const graph = { invoke: async () => ({}) }\n",
    })

    const result = await invoke(["verify", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Dawn app integrity OK")
    expect(result.stdout).toContain("3 checks passed")
    expect(result.stdout).toContain("2 routes discovered")
  })

  test("resolves the Dawn app root from a child directory via --cwd", async () => {
    const appRoot = await createFixtureApp({
      "src/app/hello/index.ts": "export async function workflow() { return {} }\n",
      "src/app/settings/index.ts": "export async function workflow() { return {} }\n",
    })
    const childDir = join(appRoot, "src", "app", "settings")

    const result = await invoke(["verify", "--cwd", childDir])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Dawn app integrity OK")
    expect(result.stdout).toContain("2 routes discovered")
  })

  test("returns a nonzero exit code with a stable error prefix for invalid apps", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-verify-invalid-"))
    tempDirs.push(appRoot)
    await writeFile(join(appRoot, "package.json"), "{}\n")
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {};\n")

    const result = await invoke(["verify", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(/^Verify failed:/)
  })

  test("prints a normalized failure payload in json mode", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-verify-invalid-json-"))
    tempDirs.push(appRoot)
    await writeFile(join(appRoot, "package.json"), "{}\n")
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {};\n")

    const result = await invoke(["verify", "--cwd", appRoot, "--json"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      checks: [
        {
          error: {
            message: `Invalid Dawn app at ${appRoot}. Missing: ${join(appRoot, "src/app")}`,
          },
          name: "app",
          status: "failed",
        },
      ],
      counts: {
        failed: 1,
        passed: 0,
        total: 1,
      },
      status: "failed",
    })
  })

  test("preserves the discovered app root for invalid config failures in json mode", async () => {
    const appRoot = contractFixtureRoot("invalid-config")
    const childDir = join(appRoot, "src", "app", "hello")

    const result = await invoke(["verify", "--cwd", childDir, "--json"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      checks: [
        {
          error: {
            message:
              'Unsupported dawn.config.ts syntax: unexpected token "(". Supported subset: optional const string declarations followed by export default { appDir } or export default { appDir: "..." }.',
          },
          name: "app",
          status: "failed",
        },
      ],
      counts: {
        failed: 1,
        passed: 0,
        total: 1,
      },
      status: "failed",
    })
  })

  test("preserves staged checks and the discovered app root for invalid index.ts failures in json mode", async () => {
    const appRoot = contractFixtureRoot("invalid-companion")
    const childDir = join(appRoot, "src", "app", "broken")

    const result = await invoke(["verify", "--cwd", childDir, "--json"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      checks: [
        {
          appRoot,
          configPath: join(appRoot, "dawn.config.ts"),
          dawnDir: join(appRoot, ".dawn"),
          name: "app",
          routesDir: join(appRoot, "src", "app"),
          status: "passed",
        },
        {
          error: {
            message: expect.stringContaining(
              `must export exactly one of "workflow", "graph", or "chain"`,
            ),
          },
          name: "routes",
          status: "failed",
        },
      ],
      counts: {
        failed: 1,
        passed: 1,
        total: 2,
      },
      status: "failed",
    })
  })

  test("prints the normalized single-app verify result in json mode with kind on each route", async () => {
    const appRoot = await createFixtureApp({
      "src/app/hello/index.ts": "export async function workflow() { return {} }\n",
      "src/app/support/[tenant]/index.ts": "export const graph = { invoke: async () => ({}) }\n",
    })

    const result = await invoke(["verify", "--cwd", appRoot, "--json"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      checks: [
        {
          appRoot,
          configPath: join(appRoot, "dawn.config.ts"),
          dawnDir: join(appRoot, ".dawn"),
          name: "app",
          routesDir: join(appRoot, "src/app"),
          status: "passed",
        },
        {
          name: "routes",
          routeCount: 2,
          status: "passed",
        },
        {
          name: "typegen",
          renderedBytes: expect.any(Number),
          status: "passed",
        },
      ],
      counts: {
        failed: 0,
        passed: 3,
        total: 3,
      },
      status: "passed",
    })
  })
})
