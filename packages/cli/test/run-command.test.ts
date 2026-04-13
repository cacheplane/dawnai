import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("dawn run", () => {
  test("executes a graph route from an app-root-relative path and prints the normalized JSON result", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/graph.ts": `export const graph = async (input: { tenant: string }) => ({ tenant: input.tenant, greeting: \`Hello, \${input.tenant}!\` });\n`,
    })

    const result = await invoke(["run", "src/app/support/[tenant]/graph.ts", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "graph-tenant" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      mode: "graph",
      output: {
        greeting: "Hello, graph-tenant!",
        tenant: "graph-tenant",
      },
      routePath: "src/app/support/[tenant]/graph.ts",
      status: "passed",
    })
  })

  test("executes a workflow route and prints the normalized JSON result", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/workflow.ts": `export const workflow = async (input: { tenant: string }) => ({ tenant: input.tenant, greeting: \`Hello, \${input.tenant}!\` });\n`,
    })

    const result = await invoke(["run", "src/app/support/[tenant]/workflow.ts", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "workflow-tenant" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      mode: "workflow",
      output: {
        greeting: "Hello, workflow-tenant!",
        tenant: "workflow-tenant",
      },
      routePath: "src/app/support/[tenant]/workflow.ts",
      status: "passed",
    })
  })

  test("resolves dot-relative route paths from the caller working directory", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/graph.ts": `export const graph = async (input: { tenant: string }) => ({ tenant: input.tenant, greeting: \`Hello, \${input.tenant}!\` });\n`,
    })
    const routeDir = join(appRoot, "src/app/support/[tenant]")

    const result = await invoke(["run", "./graph.ts"], {
      cwd: routeDir,
      stdin: JSON.stringify({ tenant: "relative-tenant" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expect({
      ...payload,
      appRoot: normalizePrivatePath(String(payload.appRoot)),
    }).toEqual({
      appRoot: normalizePrivatePath(appRoot),
      mode: "graph",
      output: {
        greeting: "Hello, relative-tenant!",
        tenant: "relative-tenant",
      },
      routePath: "./graph.ts",
      status: "passed",
    })
  })

  test("returns a modeled app discovery failure as JSON with exit 1", async () => {
    const outsideAppRoot = await mkdtemp(join(tmpdir(), "dawn-cli-run-outside-"))
    tempDirs.push(outsideAppRoot)

    const result = await invoke(["run", "src/app/support/[tenant]/graph.ts"], {
      cwd: outsideAppRoot,
      stdin: JSON.stringify({ tenant: "missing-app" }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as {
      readonly appRoot: string | null
      readonly error: {
        readonly kind: string
        readonly message: string
      }
      readonly mode: string | null
      readonly routePath: string
      readonly status: string
    }

    expect({
      ...payload,
      error: {
        ...payload.error,
        message: normalizePrivatePath(payload.error.message),
      },
    }).toEqual({
      appRoot: null,
      error: {
        kind: "app_discovery_error",
        message: `Could not find dawn.config.ts from ${normalizePrivatePath(outsideAppRoot)}`,
      },
      mode: null,
      routePath: "src/app/support/[tenant]/graph.ts",
      status: "failed",
    })
  })

  test("returns a modeled route resolution failure as JSON with exit 1", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/page.tsx": "export default {};\n",
    })

    const result = await invoke(["run", "src/app/support/[tenant]/graph.ts", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "missing-route" }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      error: {
        kind: "route_resolution_error",
        message: `Route file does not exist: ${join(appRoot, "src/app/support/[tenant]/graph.ts")}`,
      },
      mode: "graph",
      routePath: "src/app/support/[tenant]/graph.ts",
      status: "failed",
    })
  })

  test("returns an unsupported boundary failure as JSON with exit 1", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/graph.ts":
        "export const workflow = async (input: { tenant: string }) => ({ tenant: input.tenant });\n",
    })

    const result = await invoke(["run", "src/app/support/[tenant]/graph.ts", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "unsupported-tenant" }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      error: {
        kind: "unsupported_route_boundary",
        message: `Expected graph route at ${join(appRoot, "src/app/support/[tenant]/graph.ts")}, received workflow`,
      },
      mode: "graph",
      routePath: "src/app/support/[tenant]/graph.ts",
      status: "failed",
    })
  })

  test("returns modeled execution failures as JSON with exit 1", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/graph.ts": `export const graph = async (input: { tenant: string }) => { throw new Error(\`Graph exploded for \${input.tenant}\`); };\n`,
    })

    const result = await invoke(["run", "src/app/support/[tenant]/graph.ts", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "boom" }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual({
      appRoot,
      error: {
        kind: "execution_error",
        message: "Graph exploded for boom",
      },
      mode: "graph",
      routePath: "src/app/support/[tenant]/graph.ts",
      status: "failed",
    })
  })

  test("uses stderr-only exit 2 failures for malformed JSON input", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/graph.ts":
        "export const graph = async (input: { tenant: string }) => ({ tenant: input.tenant });\n",
    })

    const result = await invoke(["run", "src/app/support/[tenant]/graph.ts", "--cwd", appRoot], {
      stdin: "{not-json",
    })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Failed to read JSON from stdin")
  })
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-run-"))
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
    readonly cwd?: string
    readonly stdin: string
  },
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const previousCwd = process.cwd()

  if (options.cwd) {
    process.chdir(options.cwd)
  }

  try {
    const exitCode = await run([...argv], {
      stderr: (message: string) => {
        stderr.push(message)
      },
      stdin: async () => options.stdin,
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

function normalizePrivatePath(path: string): string {
  return path.replaceAll("/private/var/", "/var/")
}
