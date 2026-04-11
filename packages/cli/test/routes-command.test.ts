import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFixtureApp() {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-routes-"))
  tempDirs.push(appRoot)

  const files = [
    "package.json",
    "dawn.config.ts",
    "src/app/page.tsx",
    "src/app/docs/[...path]/workflow.ts",
  ]

  await Promise.all(
    files.map(async (relativePath) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, relativePath.endsWith(".json") ? "{}" : "export default {};\n")
    }),
  )

  return appRoot
}

describe("dawn routes", () => {
  test("prints discovered route metadata as JSON", async () => {
    const appRoot = await createFixtureApp()
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await run(["routes", "--cwd", appRoot, "--json"], {
      stderr: (message: string) => {
        stderr.push(message)
      },
      stdout: (message: string) => {
        stdout.push(message)
      },
    })

    expect(exitCode).toBe(0)
    expect(stderr.join("")).toBe("")
    expect(JSON.parse(stdout.join(""))).toEqual({
      appRoot,
      routes: [
        {
          entryFile: join(appRoot, "src/app/page.tsx"),
          entryKind: "page",
          id: "/",
          pathname: "/",
          routeDir: join(appRoot, "src/app"),
          segments: [],
        },
        {
          entryFile: join(appRoot, "src/app/docs/[...path]/workflow.ts"),
          entryKind: "workflow",
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
})
