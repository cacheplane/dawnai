import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFixtureApp(files: readonly string[]) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-verify-"))
  tempDirs.push(appRoot)

  await Promise.all(
    files.map(async (relativePath) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, relativePath.endsWith(".json") ? "{}" : "export default {};\n")
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

describe("dawn verify", () => {
  test("succeeds for a valid fixture app and reports a concise integrity summary", async () => {
    const appRoot = await createFixtureApp([
      "package.json",
      "dawn.config.ts",
      "src/app/page.tsx",
      "src/app/[tenant]/graph.ts",
    ])

    const result = await invoke(["verify", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Dawn app integrity OK")
    expect(result.stdout).toContain("3 checks passed")
    expect(result.stdout).toContain("2 routes discovered")
  })

  test("resolves the Dawn app root from a child directory via --cwd", async () => {
    const appRoot = await createFixtureApp([
      "package.json",
      "dawn.config.ts",
      "src/app/page.tsx",
      "src/app/settings/page.tsx",
    ])
    const childDir = join(appRoot, "src", "app", "settings")

    const result = await invoke(["verify", "--cwd", childDir])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Dawn app integrity OK")
    expect(result.stdout).toContain("2 routes discovered")
  })

  test("returns a nonzero exit code with a stable error prefix for invalid apps", async () => {
    const appRoot = await createFixtureApp(["package.json", "dawn.config.ts"])

    const result = await invoke(["verify", "--cwd", appRoot])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(/^Verify failed:/)
  })

  test("prints the normalized single-app verify result in json mode", async () => {
    const appRoot = await createFixtureApp([
      "package.json",
      "dawn.config.ts",
      "src/app/page.tsx",
      "src/app/[tenant]/graph.ts",
    ])

    const result = await invoke(["verify", "--cwd", appRoot, "--json"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      checks: [
        {
          appRoot,
          configPath: join(appRoot, "dawn.config.ts"),
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
