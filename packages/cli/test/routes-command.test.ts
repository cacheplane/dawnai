import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-routes-"))
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

describe("dawn routes", () => {
  test("prints discovered route metadata as JSON with kind per route", async () => {
    const appRoot = await createFixtureApp({
      "src/app/index.ts": "export async function workflow() { return {} }\n",
      "src/app/docs/[...path]/index.ts": "export const graph = { invoke: async () => ({}) }\n",
    })

    const result = await invoke(["routes", "--cwd", appRoot, "--json"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      routes: [
        {
          entryFile: join(appRoot, "src/app/index.ts"),
          kind: "workflow",
          id: "/",
          pathname: "/",
          routeDir: join(appRoot, "src/app"),
          segments: [],
        },
        {
          entryFile: join(appRoot, "src/app/docs/[...path]/index.ts"),
          kind: "graph",
          id: "/docs/[...path]",
          pathname: "/docs/[...path]",
          routeDir: join(appRoot, "src/app/docs/[...path]"),
          segments: [
            { kind: "static", raw: "docs" },
            { kind: "catchall", name: "path", raw: "[...path]" },
          ],
        },
      ],
    })
  })

  test("omits the removed boundEntryFile and boundEntryKind fields from JSON output", async () => {
    const appRoot = await createFixtureApp({
      "src/app/hello/[tenant]/index.ts": "export const workflow = async () => ({ ok: true });\n",
    })

    const result = await invoke(["routes", "--cwd", appRoot, "--json"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as {
      readonly routes: readonly Record<string, unknown>[]
    }

    for (const route of payload.routes) {
      expect(route).not.toHaveProperty("boundEntryFile")
      expect(route).not.toHaveProperty("boundEntryKind")
      expect(route).not.toHaveProperty("entryKind")
    }
  })

  test("prints index.ts as the authoritative file in text output", async () => {
    const appRoot = await createFixtureApp({
      "src/app/hello/[tenant]/index.ts": "export const workflow = async () => ({ ok: true });\n",
    })

    const result = await invoke(["routes", "--cwd", appRoot])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain(
      `/hello/[tenant] -> ${join(appRoot, "src/app/hello/[tenant]/index.ts")}`,
    )
    expect(result.stdout).not.toContain("route.ts")
    expect(result.stdout).not.toContain("workflow.ts")
  })
})
