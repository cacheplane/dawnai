import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { runBuildCommand } from "../src/commands/build.js"
import { runCheckCommand } from "../src/commands/check.js"
import { buildTargets, DEFAULT_BUILD_TARGETS } from "../src/lib/build/targets/index.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, maxRetries: 5, recursive: true })),
  )
})

async function createFixtureApp(files: Readonly<Record<string, string>> = {}) {
  // realpath: macOS puts the tmpdir behind /var → /private/var, and the module
  // loader reports real paths — keep every path on the resolved side so the
  // namespace assertions line up.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "dawn-cli-hono-target-")))
  tempDirs.push(appRoot)

  const appFiles: Record<string, string> = {
    "dawn.config.ts": 'export default { build: { targets: ["hono"] } }\n',
    "package.json":
      '{ "name": "hono-fixture", "dependencies": { "@dawn-ai/cli": "workspace:*" } }\n',
    "src/app/chat/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Answer questions.",
})
`,
    ...files,
  }

  await Promise.all(
    Object.entries(appFiles).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )

  return appRoot
}

async function runBuild(appRoot: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  await runBuildCommand(
    { clean: true, cwd: appRoot },
    {
      stderr: (message) => stderr.push(message),
      stdout: (message) => stdout.push(message),
    },
  )
  // `dawn build` reports every emitted artifact as "  wrote <path>" — the only
  // channel the command exposes its artifact list on.
  const artifacts = stdout
    .filter((line) => line.startsWith("  wrote "))
    .map((line) => basename(line.slice("  wrote ".length).trim()))
  return { artifacts, stderr, stdout }
}

const buildFile = (appRoot: string, name: string) => join(appRoot, ".dawn", "build", name)
const readBuildFile = (appRoot: string, name: string) => readFile(buildFile(appRoot, name), "utf8")

/**
 * Decode the DawnConfig `app.mjs` inlines. It is emitted as
 * `JSON.parse("<json>")` rather than an object literal, so a quoted
 * `"__proto__"` config key cannot perform a prototype assignment.
 */
function inlinedConfig(entry: string): unknown {
  const match = /^const config = JSON\.parse\((".*")\)$/m.exec(entry)
  if (!match?.[1]) throw new Error(`no inlined config in:\n${entry}`)
  return JSON.parse(JSON.parse(match[1]) as string)
}

describe("dawn build — hono target", () => {
  test("emits the four edge artifacts", async () => {
    const appRoot = await createFixtureApp()

    const { artifacts, stderr } = await runBuild(appRoot)

    expect(stderr.join("")).toBe("")
    expect(artifacts).toEqual(
      expect.arrayContaining(["modules.edge.mjs", "stores.mjs", "app.mjs", "wrangler.toml"]),
    )
    for (const name of ["modules.edge.mjs", "stores.mjs", "app.mjs"]) {
      expect(existsSync(buildFile(appRoot, name))).toBe(true)
    }
    // wrangler.toml is the user's to keep, so it lands at the app root.
    expect(existsSync(join(appRoot, "wrangler.toml"))).toBe(true)
    // The hono target is edge-only: no node/langsmith artifacts alongside it.
    expect(existsSync(buildFile(appRoot, "server.mjs"))).toBe(false)
    expect(existsSync(buildFile(appRoot, "langgraph.json"))).toBe(false)
  })

  test("is opt-in: registered but not a default target", () => {
    expect(Object.keys(buildTargets)).toContain("hono")
    expect(DEFAULT_BUILD_TARGETS).not.toContain("hono")
  })

  test("known target name passes dawn check", async () => {
    const appRoot = await createFixtureApp()
    await expect(
      runCheckCommand({ cwd: appRoot }, { stderr: () => {}, stdout: () => {} }),
    ).resolves.toBeUndefined()
  })

  test("preserves an existing wrangler.toml", async () => {
    const appRoot = await createFixtureApp({ "wrangler.toml": "# mine\n" })

    const { stderr } = await runBuild(appRoot)

    expect(await readFile(join(appRoot, "wrangler.toml"), "utf8")).toBe("# mine\n")
    expect(stderr.join("")).toContain("wrangler.toml")
  })

  test("wrangler.toml scaffold carries no nodejs_compat flag", async () => {
    const appRoot = await createFixtureApp()

    await runBuild(appRoot)

    const wrangler = await readFile(join(appRoot, "wrangler.toml"), "utf8")
    // Spike-verified 2026-08-07: a bare name/main/compatibility_date boots the
    // handler. Adding the flag "for safety" would mask a regression in the
    // node-purge work this epic shipped.
    expect(wrangler).not.toContain("nodejs_compat")
    expect(wrangler).toContain('name = "hono-fixture"')
    expect(wrangler).toContain('main = ".dawn/build/app.mjs"')
    expect(wrangler).toMatch(/^compatibility_date = "\d{4}-\d{2}-\d{2}"$/m)
  })

  test("builds stores per request, never at module scope", async () => {
    const appRoot = await createFixtureApp()

    await runBuild(appRoot)

    const entry = await readBuildFile(appRoot, "app.mjs")
    // A module-scope pool hangs half of all requests on workerd (spike,
    // 2026-08-07). The generated entry must pass requestStores, not instances.
    expect(entry).toContain("requestStores")
    expect(entry).not.toMatch(/^const pool = /m)

    const stores = await readBuildFile(appRoot, "stores.mjs")
    expect(stores).toContain("export function createRequestStores")
    expect(stores).not.toMatch(/^const pool = /m)
    // The factory's whole point: a pool per invocation, closed on dispose.
    expect(stores).toContain("dispose")
    // `process` does not exist on workerd without nodejs_compat — every knob
    // must come off the per-request env binding.
    expect(stores).not.toContain("process.env")
  })

  test("app.mjs uses the same opaque appRoot namespace the manifest bakes in", async () => {
    const appRoot = await createFixtureApp()

    await runBuild(appRoot)

    const modules = await readBuildFile(appRoot, "modules.edge.mjs")
    const entry = await readBuildFile(appRoot, "app.mjs")
    const namespace = `/${basename(appRoot)}`
    expect(modules).toContain(`const appRoot = ${JSON.stringify(namespace)}`)
    expect(entry).toContain(JSON.stringify(namespace))
    // No build-machine paths in either file.
    expect(modules).not.toContain(appRoot)
    expect(entry).not.toContain(appRoot)
    expect(entry).not.toContain("node:")
    expect(modules).not.toContain("node:")
  })

  test("inlines the config minus its non-serializable fields", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  memory: { enabled: true, writes: "auto" },
  summarization: { enabled: true, maxTokens: 4096, tokenCounter: (text) => text.length },
  threadsStore: { list: async () => [] },
}
`,
    })

    await runBuild(appRoot)

    const entry = await readBuildFile(appRoot, "app.mjs")
    expect(inlinedConfig(entry)).toEqual({
      build: { targets: ["hono"] },
      memory: { enabled: true, writes: "auto" },
      summarization: { enabled: true, maxTokens: 4096 },
    })
    // Store instances come from stores.mjs; functions cannot cross a build.
    expect(entry).not.toContain("tokenCounter")
    expect(entry).not.toContain("threadsStore")
  })

  test("emits a static importer for the providers the routes actually use", async () => {
    const appRoot = await createFixtureApp({
      "src/app/claude/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "claude-sonnet-4-5",
  systemPrompt: "Answer questions.",
})
`,
    })

    await runBuild(appRoot)

    const entry = await readBuildFile(appRoot, "app.mjs")
    // Static specifiers: a bundler cannot follow `import(variable)`, so the
    // map is what puts the provider packages in the edge bundle at all.
    expect(entry).toContain('import("@langchain/openai")')
    expect(entry).toContain('import("@langchain/anthropic")')
    expect(entry).not.toContain('import("@langchain/mistralai")')
    expect(entry).toContain("seedModelImporter")
  })
})

/**
 * The edge serves an honest SUBSET of Dawn. Everything below asserts the build
 * says so BY NAME — the feature and the config key or file that introduced it —
 * instead of emitting artifacts that fail at request time in production.
 */
describe("hono target — edge capability gating", () => {
  const runCheck = async (appRoot: string) => {
    const stdout: string[] = []
    await runCheckCommand({ cwd: appRoot }, { stderr: () => {}, stdout: (m) => stdout.push(m) })
    return stdout.join("")
  }

  test("fails the build when a sandbox is configured", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  sandbox: { provider: { name: "docker" } },
}
`,
    })

    await expect(runBuild(appRoot)).rejects.toThrow(/"hono".*sandbox.*`sandbox`/is)
  })

  test("fails the build when the app has a workspace directory", async () => {
    const appRoot = await createFixtureApp({ "workspace/notes.md": "# notes\n" })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toMatch(/workspace/)
    // Named by the path that introduced it, relative to the app root.
    expect(String(error)).toContain("workspace/")
    expect(String(error)).toMatch(/runBash|readFile/)
  })

  test("fails the build when a route ships skills", async () => {
    const appRoot = await createFixtureApp({
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nDo research.\n",
    })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toMatch(/skills/)
    expect(String(error)).toContain(join("src", "app", "chat", "skills"))
  })

  test("fails the build when a route has long-term memory", async () => {
    const appRoot = await createFixtureApp({
      "src/app/chat/memory.ts": `import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"

export default defineMemory({ schema: z.object({ fact: z.string() }) })
`,
    })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toMatch(/memory/)
    // The file that introduced it AND the config key that cannot fix it.
    expect(String(error)).toContain(join("src", "app", "chat", "memory.ts"))
    expect(String(error)).toContain("memory.store")
  })

  test("fails the build when filesystem/exec backends are configured", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  backends: { exec: { runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } },
}
`,
    })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toContain("backends.exec")
  })

  test("reports every unsupported feature at once, not just the first", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  sandbox: { provider: { name: "docker" } },
}
`,
      "src/app/chat/memory.ts": `import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"

export default defineMemory({ schema: z.object({ fact: z.string() }) })
`,
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nGo.\n",
      "workspace/notes.md": "# notes\n",
    })

    const message = String(await runBuild(appRoot).catch((e: unknown) => e))

    // Fixing four build failures one build at a time is a bad experience.
    expect(message).toContain("`sandbox`")
    expect(message).toContain("workspace/")
    expect(message).toContain(join("src", "app", "chat", "skills"))
    expect(message).toContain("memory.store")
  })

  test("fails BEFORE emitting anything", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  sandbox: { provider: { name: "docker" } },
}
`,
    })

    await expect(runBuild(appRoot)).rejects.toThrow()

    // A half-built .dawn/build looks deployable. Nothing may reach disk.
    for (const name of ["modules.edge.mjs", "stores.mjs", "app.mjs", "wrangler.toml"]) {
      expect(existsSync(buildFile(appRoot, name))).toBe(false)
    }
    expect(existsSync(join(appRoot, "wrangler.toml"))).toBe(false)
  })

  test("does not fire for the node target", async () => {
    // Every gated feature at once — and none of it is the node target's
    // problem, so this app must keep building exactly as it does today.
    const appRoot = await createFixtureApp({
      "dawn.config.ts": `export default {
  build: { targets: ["node"] },
  sandbox: { provider: { name: "docker" } },
}
`,
      "src/app/chat/memory.ts": `import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"

export default defineMemory({ schema: z.object({ fact: z.string() }) })
`,
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nGo.\n",
      "workspace/notes.md": "# notes\n",
    })

    const { artifacts } = await runBuild(appRoot)

    expect(artifacts).toEqual(expect.arrayContaining(["server.mjs"]))
    expect(existsSync(buildFile(appRoot, "app.mjs"))).toBe(false)
  })

  test("dawn check mirrors the gating when hono is a configured target", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  sandbox: { provider: { name: "docker" } },
}
`,
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nGo.\n",
      "workspace/notes.md": "# notes\n",
    })

    const error = await runCheck(appRoot).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    const message = String(error)
    expect(message).toContain("`sandbox`")
    expect(message).toContain("workspace/")
    expect(message).toContain(join("src", "app", "chat", "skills"))
  })

  test("dawn check leaves a node-target app alone", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": 'export default { build: { targets: ["node"] } }\n',
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nGo.\n",
      "workspace/notes.md": "# notes\n",
    })

    await expect(runCheck(appRoot)).resolves.toBeTypeOf("string")
  })

  test("names the runtime packages the emitted entry imports but the app lacks", async () => {
    const appRoot = await createFixtureApp()

    const { stdout } = await runBuild(appRoot)

    const notice = stdout.join("")
    expect(notice).toContain("@dawn-ai/postgres-storage")
    expect(notice).toContain("@neondatabase/serverless")
    expect(notice).toContain("hono")
    expect(notice).toContain("dependencies")
  })

  test("says nothing when the app already depends on them", async () => {
    const appRoot = await createFixtureApp({
      "package.json": `${JSON.stringify({
        dependencies: {
          "@dawn-ai/cli": "workspace:*",
          "@dawn-ai/postgres-storage": "^0.8.18",
          "@neondatabase/serverless": "^1.1.0",
          hono: "^4.0.0",
        },
        name: "hono-fixture",
      })}\n`,
    })

    const { stdout } = await runBuild(appRoot)

    expect(stdout.join("")).not.toContain("@neondatabase/serverless")
  })
})

describe("hono target — per-request env binding", () => {
  /**
   * The contract `app.mjs` leans on: the runtime hands `requestStores` the very
   * Request object it was called with, so a WeakMap keyed on `c.req.raw` is a
   * sound carrier for a per-invocation `env`. Pinned here because the generated
   * entry is otherwise driven against a stub of this factory.
   */
  test("createRuntimeFetchHandler passes requestStores the identical Request", async () => {
    const seen: Request[] = []
    const handler = await createRuntimeFetchHandler({
      appRoot: "/ns",
      modules: { routes: [] },
      requestStores: (request) => {
        seen.push(request)
        return {}
      },
    })
    const first = new Request("http://x/healthz")
    const second = new Request("http://x/healthz")
    await handler.fetch(first)
    await handler.fetch(second)
    await handler.close()

    expect(seen[0]).toBe(first)
    expect(seen[1]).toBe(second)
  })

  test("two requests with different env reach different databases", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // Drive the REAL emitted app.mjs, replacing only its module boundaries:
    // the manifest (data), the store factory (the thing under observation),
    // hono, and @dawn-ai/cli/fetch. Node resolves the bare specifiers from the
    // stub packages below, which is why this runs in a child process rather
    // than through vitest's resolver.
    await writeFile(buildFile(appRoot, "modules.edge.mjs"), "export default { routes: [] }\n")
    await writeFile(
      buildFile(appRoot, "stores.mjs"),
      `export const seen = []
export function createRequestStores(env) {
  seen.push(env?.DATABASE_URL)
  return { dispose: async () => {} }
}
`,
    )
    await writeStubPackage(appRoot, "hono", HONO_STUB)
    await writeStubPackage(appRoot, "@dawn-ai/cli", CLI_FETCH_STUB, { "./fetch": "./index.mjs" })

    const observed = await driveEmittedApp(appRoot, [
      "postgres://one/db",
      "postgres://two/db",
      "postgres://three/db",
    ])

    // The naive sketch closes `requestStores` over the FIRST request's c.env,
    // so every later request reaches the first request's database. Three
    // requests, because the failure is invisible with one.
    expect(observed).toEqual(["postgres://one/db", "postgres://two/db", "postgres://three/db"])
  })
})

/**
 * A minimal `hono` stub with the shape the emitted entry uses. Mirrors real
 * Hono: `app.fetch(request, env, ctx)` is the Workers entry signature, `c.env`
 * is that per-invocation env, and `c.req.raw` is the incoming Request.
 */
const HONO_STUB = `export class Hono {
  #handler
  all(_pattern, handler) {
    this.#handler = handler
  }
  fetch = (request, env, executionCtx) => {
    return this.#handler({ env, executionCtx, req: { raw: request } })
  }
}
`

/**
 * A `@dawn-ai/cli/fetch` stub that records what the generated entry passes.
 * `requestStores` is invoked with the same Request the handler received —
 * the contract pinned by the identity test above.
 */
const CLI_FETCH_STUB = `export async function createRuntimeFetchHandler(options) {
  return {
    close: async () => {},
    fetch: async (request) => {
      const stores = await options.requestStores(request)
      await stores.dispose?.()
      return new Response("ok")
    },
  }
}
export function seedModelImporter() {}
`

async function writeStubPackage(
  appRoot: string,
  name: string,
  source: string,
  exportsMap?: Record<string, string>,
): Promise<void> {
  const dir = join(appRoot, "node_modules", ...name.split("/"))
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({
      exports: exportsMap ?? { ".": "./index.mjs" },
      name,
      type: "module",
      version: "0.0.0",
    })}\n`,
  )
  await writeFile(join(dir, "index.mjs"), source)
}

/**
 * Import the emitted `app.mjs` in a plain Node child process and drive one
 * request per supplied `DATABASE_URL`, returning what the store factory saw.
 */
async function driveEmittedApp(
  appRoot: string,
  databaseUrls: readonly string[],
): Promise<readonly (string | undefined)[]> {
  const driverPath = buildFile(appRoot, "drive.test.mjs")
  await writeFile(
    driverPath,
    `import app from "./app.mjs"
import { seen } from "./stores.mjs"

for (const databaseUrl of ${JSON.stringify(databaseUrls)}) {
  await app.fetch(new Request("http://x/healthz"), { DATABASE_URL: databaseUrl })
}
console.log(JSON.stringify(seen))
`,
  )
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const { stdout } = await promisify(execFile)(process.execPath, [driverPath], {
    cwd: appRoot,
  })
  return JSON.parse(stdout.trim()) as readonly (string | undefined)[]
}
