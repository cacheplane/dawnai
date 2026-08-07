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
    // Declares every package the emitted entry imports, so the default fixture
    // builds with a genuinely silent stderr — the dependency notice is exercised
    // by the cases that deliberately drop them.
    "package.json": `${JSON.stringify({
      dependencies: {
        "@dawn-ai/cli": "workspace:*",
        "@dawn-ai/postgres-storage": "workspace:*",
        "@neondatabase/serverless": "^1.1.0",
        hono: "^4.12.28",
      },
      name: "hono-fixture",
    })}\n`,
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
  const artifactPaths = stdout
    .filter((line) => line.startsWith("  wrote "))
    .map((line) => line.slice("  wrote ".length).trim())
  return { artifactPaths, artifacts: artifactPaths.map((path) => basename(path)), stderr, stdout }
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

  test("a rebuild recognizes its own wrangler.toml", async () => {
    const appRoot = await createFixtureApp()

    const first = await runBuild(appRoot)
    const scaffold = await readFile(join(appRoot, "wrangler.toml"), "utf8")
    const second = await runBuild(appRoot)

    // The marker is written AND read back. Without the read-back a rebuild
    // treats its own output as a stranger's: a spurious ⚠, a redundant copy in
    // .dawn/build/, and — quietest — the reported artifact silently moving from
    // the app root to the build dir, so the file the operator deploys stops
    // being the one the build named.
    expect(second.stderr.join("")).toBe("")
    expect(existsSync(buildFile(appRoot, "wrangler.toml"))).toBe(false)
    // Reported paths are relative to cwd; what matters is that the wrangler.toml
    // the build names is still the app-root one, not a build-dir duplicate.
    expect(second.artifactPaths).toEqual(first.artifactPaths)
    expect(
      second.artifactPaths.some((path) => path.endsWith(join(".dawn", "build", "wrangler.toml"))),
    ).toBe(false)
    // Never overwritten, marker or not: a wrangler.toml accretes bindings.
    expect(await readFile(join(appRoot, "wrangler.toml"), "utf8")).toBe(scaffold)
  })

  test("worker name starts with a letter, as Cloudflare requires", async () => {
    const appRoot = await createFixtureApp({
      "package.json": '{ "name": "123-app" }\n',
    })

    await runBuild(appRoot)

    // `123-app` sanitizes to a name wrangler rejects outright at deploy time.
    expect(await readFile(join(appRoot, "wrangler.toml"), "utf8")).toContain('name = "app"')
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
    expect(stores).toContain("export async function createRequestStores")
    expect(stores).not.toMatch(/^const pool = /m)
    // The factory's whole point: a pool per invocation, closed on dispose.
    expect(stores).toContain("dispose")
    // `process` does not exist on workerd without nodejs_compat — every knob
    // must come off the per-request env binding.
    expect(stores).not.toContain("process.env")
  })

  test("migrates once per isolate, not once per request", async () => {
    const appRoot = await createFixtureApp()

    await runBuild(appRoot)

    const stores = await readBuildFile(appRoot, "stores.mjs")
    // Per-request stores memoize migrations on the INSTANCE, so without this
    // flag every request pays three migration transactions — each taking
    // pg_advisory_xact_lock, which also serializes concurrent requests.
    expect(stores).toMatch(/^let migrated = false$/m)
    expect(stores).toContain("assumeMigrated")
    // That the flag is only set AFTER the migration succeeded is not asserted
    // here: a text assertion on generated code is what let the ordering rot
    // undetected (an `indexOf("ready()")` that matched the doc comment ABOVE
    // the code, so moving the assignment before the await stayed green). It is
    // covered by running the emitted file instead — see "a failed cold start
    // leaves the next request to retry the migration".
  })

  test("names the missing binding instead of building a pool with no connection string", async () => {
    const appRoot = await createFixtureApp()

    await runBuild(appRoot)

    expect(await readBuildFile(appRoot, "stores.mjs")).toContain("DATABASE_URL is not set")
    // The other half: a Request that never passed through the catch-all has no
    // env bound, and `?? {}` turned that into the same silent empty pool.
    expect(await readBuildFile(appRoot, "app.mjs")).toContain("no Workers env is bound")
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
    // No store handle here: a configured store is now a BUILD ERROR (see
    // "fails the build on a config-supplied store…"), because stripping it
    // silently is what let the emitted Postgres store take its place unasked.
    // Functions are still stripped — they have no such replacement.
    const appRoot = await createFixtureApp({
      "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  memory: { enabled: true, writes: "auto" },
  summarization: { enabled: true, maxTokens: 4096, tokenCounter: (text) => text.length },
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
    expect(entry).not.toContain("tokenCounter")
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

  test("includes the summarization model's provider, which no route declares", async () => {
    // `defaultSummarize` calls resolveProvider + createChatModel on its own, so
    // an openai-only route set with an anthropic summarization model used to
    // build green and fail at runtime on a package that was never bundled.
    const appRoot = await createFixtureApp({
      "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  summarization: { enabled: true, model: "claude-sonnet-4-5" },
}
`,
    })

    await runBuild(appRoot)

    const entry = await readBuildFile(appRoot, "app.mjs")
    expect(entry).toContain('import("@langchain/openai")')
    expect(entry).toContain('import("@langchain/anthropic")')
  })

  test("fails the build when a route cannot be loaded, rather than narrowing the map", async () => {
    const appRoot = await createFixtureApp({
      "src/app/broken/index.ts":
        'import { nope } from "./missing-module.js"\nexport default nope\n',
    })

    const message = String(await runBuild(appRoot).catch((e: unknown) => e))

    // A skipped route contributes no provider, and the runtime's fallback then
    // advises "rebuild with `dawn build`" — which reproduces the same gap.
    expect(message).toMatch(/broken/)
    expect(existsSync(buildFile(appRoot, "app.mjs"))).toBe(false)
  })

  test("fails the build when an agent's provider cannot be determined", async () => {
    const appRoot = await createFixtureApp({
      "src/app/proxy/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "some-proxy-model",
  systemPrompt: "Answer questions.",
})
`,
    })

    const message = String(await runBuild(appRoot).catch((e: unknown) => e))

    expect(message).toContain("provider")
    expect(message).toContain("proxy")
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

  test("dawn check mirrors the store-handle gating, not just the loud features", async () => {
    // The silent-divergence class — and the one `dawn check` was NOT asserted
    // for. With only sandbox/workspace/skills covered here, narrowing the config
    // handed to `assertEdgeCapabilities` to `{ backends, sandbox }` left every
    // test in the repo green; tsc could not object either, because every
    // DawnConfig field is optional, so a `Pick` that omits the store keys still
    // satisfies the gate's parameter type.
    for (const [key, source] of [
      ["threadsStore", "threadsStore: { listThreads: async () => [] },"],
      ["checkpointer", "checkpointer: { getTuple: async () => undefined },"],
      ["permissions.store", "permissions: { store: { load: async () => {} } },"],
      ["memory.store", "memory: { store: { recall: async () => [] } },"],
    ] as const) {
      const appRoot = await createFixtureApp({
        "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  ${source}
}
`,
      })

      const error = await runCheck(appRoot).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain(`\`${key}\``)
    }
  })

  test("dawn check mirrors the backend and route-memory gating", async () => {
    // The other two classes the build path covered alone. `backends.*` and an
    // agent route's `memory.ts` are read from different places — the config and
    // the manifest — so neither stands in for the other.
    const appRoot = await createFixtureApp({
      "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  backends: { exec: { runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } },
}
`,
      "src/app/chat/memory.ts": `import { defineMemory } from "@dawn-ai/sdk"
import { z } from "zod"

export default defineMemory({ schema: z.object({ fact: z.string() }) })
`,
    })

    const error = await runCheck(appRoot).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    const message = String(error)
    expect(message).toContain("backends.exec")
    expect(message).toContain(join("src", "app", "chat", "memory.ts"))
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
    const appRoot = await createFixtureApp({
      "package.json": '{ "name": "hono-fixture", "dependencies": { "@dawn-ai/cli": "*" } }\n',
    })

    // stderr, matching the node target's own runtime-dependency ⚠. stdout is the
    // artifact report a caller parses; a warning about a deploy that will fail
    // to resolve an import does not belong in it.
    const { stderr, stdout } = await runBuild(appRoot)

    const notice = stderr.join("")
    expect(notice).toContain("@dawn-ai/postgres-storage")
    expect(notice).toContain("@neondatabase/serverless")
    expect(notice).toContain("hono")
    expect(notice).toContain("dependencies")
    expect(stdout.join("")).not.toContain("@neondatabase/serverless")
  })

  test("says nothing when the app already depends on them", async () => {
    const appRoot = await createFixtureApp()

    const { stderr } = await runBuild(appRoot)

    expect(stderr.join("")).not.toContain("@neondatabase/serverless")
  })

  test("counts a devDependency as declared — wrangler bundles from the source tree", async () => {
    // Unlike the node image's `npm ci --omit=dev`, `wrangler deploy` resolves
    // from the tree it bundles, so a devDependency is genuinely there. Naming
    // one as missing would be a false alarm.
    const appRoot = await createFixtureApp({
      "package.json": `${JSON.stringify({
        dependencies: { "@dawn-ai/cli": "*" },
        devDependencies: {
          "@dawn-ai/postgres-storage": "*",
          "@neondatabase/serverless": "*",
          hono: "*",
        },
        name: "hono-fixture",
      })}\n`,
    })

    const { stderr } = await runBuild(appRoot)

    expect(stderr.join("")).toBe("")
  })

  test("fails the build on a config-supplied store instead of silently swapping it", async () => {
    for (const [key, source] of [
      ["threadsStore", "threadsStore: { listThreads: async () => [] },"],
      ["checkpointer", "checkpointer: { getTuple: async () => undefined },"],
      ["permissions.store", "permissions: { store: { load: async () => {} } },"],
      ["memory.store", "memory: { store: { recall: async () => [] } },"],
    ] as const) {
      const appRoot = await createFixtureApp({
        "dawn.config.ts": `export default {
  build: { targets: ["hono"] },
  ${source}
}
`,
      })

      const message = String(await runBuild(appRoot).catch((e: unknown) => e))

      // The silent-divergence class: the handle is stripped by the serializer
      // and the emitted Postgres store takes its place with nothing said.
      expect(message).toContain(`\`${key}\``)
      expect(existsSync(buildFile(appRoot, "app.mjs"))).toBe(false)
    }
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

  test("seeds Dawn's runtime-env fallback once per isolate, from the first env", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    await writeFile(buildFile(appRoot, "modules.edge.mjs"), "export default { routes: [] }\n")
    await writeFile(
      buildFile(appRoot, "stores.mjs"),
      `export function createRequestStores() {
  return { dispose: async () => {} }
}
`,
    )
    await writeStubPackage(appRoot, "hono", HONO_STUB)
    await writeStubPackage(appRoot, "@dawn-ai/cli", CLI_FETCH_STUB, { "./fetch": "./index.mjs" })

    const seeded = await driveEmittedApp(
      appRoot,
      ["postgres://one/db", "postgres://two/db", "postgres://three/db"],
      {
        expression: "seededEnvs",
        imports: 'import { seededEnvs } from "@dawn-ai/cli/fetch"',
      },
    )

    // ONCE, and with the first request's env — the counterpart of the WeakMap
    // above, not a copy of it. `seedRuntimeEnv` installs PROCESS-GLOBAL state,
    // so re-seeding it per request would let a request that is mid-await
    // observe another request's configuration. Three requests with different
    // envs is what tells "seeded once" apart from "seeded every time with the
    // same value" — the latter passes any single-request test.
    expect(seeded).toEqual([{ DATABASE_URL: "postgres://one/db" }])
  })

  test("keeps non-string bindings out of the process-global env map", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    await writeFile(buildFile(appRoot, "modules.edge.mjs"), "export default { routes: [] }\n")
    await writeFile(
      buildFile(appRoot, "stores.mjs"),
      `export function createRequestStores() {
  return { dispose: async () => {} }
}
`,
    )
    await writeStubPackage(appRoot, "hono", HONO_STUB)
    await writeStubPackage(appRoot, "@dawn-ai/cli", CLI_FETCH_STUB, { "./fetch": "./index.mjs" })

    // Only Workers hands the fetch handler a bindings object. `@hono/node-server`
    // — which the round-trip test boots this same entry under — passes
    // `{ incoming, outgoing }`, i.e. live Node request/response handles.
    const seeded = await driveEmittedApp(appRoot, ["postgres://one/db"], {
      envExpression: "{ DATABASE_URL: databaseUrl, incoming: new Map(), PORT: '3000' }",
      expression: "seededEnvs",
      imports: 'import { seededEnvs } from "@dawn-ai/cli/fetch"',
    })

    expect(seeded).toEqual([{ DATABASE_URL: "postgres://one/db", PORT: "3000" }])
  })
})

describe("hono target — bindings on a host that has none", () => {
  /**
   * Stubs for what the emitted `stores.mjs` imports, so the REAL emitted file
   * can be executed and asked where it got its connection string.
   */
  const POSTGRES_STORAGE_STUB = `const store = { ready: async () => {} }
export const createPostgresPermissionsStore = () => store
export const createPostgresThreadsStore = () => store
export const postgresCheckpointer = () => store
`

  /**
   * The same store trio, but whose FIRST `ready()` rejects — a failed cold
   * start. Counts every call so a later request's migration pass is visible.
   */
  const FAILING_READY_STORAGE_STUB = `export const readyCalls = []
let failNext = true
const store = {
  ready: async () => {
    readyCalls.push(1)
    if (!failNext) return
    failNext = false
    throw new Error("cold start failed")
  },
}
export const createPostgresPermissionsStore = () => store
export const createPostgresThreadsStore = () => store
export const postgresCheckpointer = () => store
`

  /**
   * `@neondatabase/serverless`, stubbed at the two seams the emitted stores.mjs
   * actually uses.
   *
   * `Client` carries the driver's REAL per-instance defaults (TLS on), and
   * `Pool` reproduces the ordering that makes the per-instance override work at
   * all: the real Pool overwrites `this.Client` with its own class inside its
   * constructor, and stores.mjs assigns over it afterwards. Clients are built
   * lazily here exactly as the real Pool builds them — `new this.Client(this.options)`
   * — which is why the pools, not the clients, are what gets recorded.
   */
  const NEON_STUB = `export class Client {
  constructor(config) {
    this.config = config
    this.neonConfig = { pipelineConnect: "password", pipelineTLS: false, useSecureWebSocket: true }
  }
}
/** Every pool built, in order. */
export const pools = []
export class Pool {
  constructor(options) {
    this.options = options
    this.Client = Client
    pools.push(this)
  }
  end() {
    return Promise.resolve()
  }
}
/** What the real Pool does when it opens a connection, per pool, in order. */
export const poolConnections = () =>
  pools.map((pool) => {
    const client = new pool.Client(pool.options)
    return {
      connectionString: pool.options.connectionString ?? null,
      useSecureWebSocket: client.neonConfig.useSecureWebSocket,
      wsProxy: client.neonConfig.wsProxy?.("dawn-pg", 5432) ?? null,
    }
  })
`

  /** A `@dawn-ai/cli/fetch` stub whose runtime env knows nothing. */
  const EMPTY_RUNTIME_ENV_STUB = `export function readRuntimeEnv() {
  return undefined
}
`

  /**
   * A `@dawn-ai/cli/fetch` stub that supplies DATABASE_URL but NOT the wsproxy
   * knob — so a request's proxy setting can only have come from its own env.
   */
  const NO_PROXY_RUNTIME_ENV_STUB = `export function readRuntimeEnv(name) {
  return { DATABASE_URL: "postgres://from-runtime-env/db" }[name]
}
`

  async function driveEmittedStores(
    appRoot: string,
    envs: readonly unknown[],
    options: {
      readonly cliStub?: string
      /** Expression printed after the last request. */
      readonly report?: string
      readonly reportImports?: string
      readonly storageStub?: string
      /** Keep going (and record the message) when a request throws. */
      readonly tolerateRequestFailures?: boolean
    } = {},
  ): Promise<unknown> {
    await writeStubPackage(
      appRoot,
      "@dawn-ai/postgres-storage",
      options.storageStub ?? POSTGRES_STORAGE_STUB,
    )
    await writeStubPackage(appRoot, "@neondatabase/serverless", NEON_STUB)
    await writeStubPackage(appRoot, "@dawn-ai/cli", options.cliStub ?? CLI_FETCH_STUB, {
      "./fetch": "./index.mjs",
    })

    const driverPath = buildFile(appRoot, "drive-stores.test.mjs")
    await writeFile(
      driverPath,
      `import { poolConnections } from "@neondatabase/serverless"
${options.reportImports ?? ""}

import { createRequestStores } from "./stores.mjs"

const requestErrors = []
for (const env of ${JSON.stringify(envs)}) {
  try {
    const stores = await createRequestStores(env)
    await stores.dispose()
  } catch (error) {
    if (!${options.tolerateRequestFailures ? "true" : "false"}) throw error
    requestErrors.push(String(error?.message ?? error))
  }
}
console.log(JSON.stringify(${options.report ?? "poolConnections()"}))
`,
    )
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const { stdout } = await promisify(execFile)(process.execPath, [driverPath], { cwd: appRoot })
    return JSON.parse(stdout.trim()) as unknown
  }

  test("falls back to the runtime env when the host passes no bindings", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // Three hosts, in the three shapes a fetch handler's second argument
    // actually takes: a Workers bindings object; `@hono/node-server`'s
    // `{ incoming, outgoing }` (Node handles, no bindings in them at all);
    // and nothing.
    const observed = await driveEmittedStores(appRoot, [
      { DATABASE_URL: "postgres://from-binding/db" },
      { incoming: {}, outgoing: {} },
      undefined,
    ])

    // The binding wins where there is one. Where there is not — which is EVERY
    // non-Workers host, and is why `serve({ fetch: app.fetch })` used to build
    // a pool with `connectionString: undefined` — the same value is read
    // through `readRuntimeEnv`, which prefers the process environment. That is
    // what makes the emitted entry's Workers/Vercel/Bun claim true rather than
    // aspirational, and it reintroduces no `process` global to do it.
    //
    // The proxy knob takes the same route, so a Node host can reach a local
    // wsproxy without inventing a bindings object to carry it — and it lands on
    // the connection this pool opens, which is the only place it may land.
    expect(observed).toEqual([
      {
        connectionString: "postgres://from-binding/db",
        useSecureWebSocket: false,
        wsProxy: "proxy:8080/v1?address=dawn-pg:5432",
      },
      {
        connectionString: "postgres://from-runtime-env/db",
        useSecureWebSocket: false,
        wsProxy: "proxy:8080/v1?address=dawn-pg:5432",
      },
      {
        connectionString: "postgres://from-runtime-env/db",
        useSecureWebSocket: false,
        wsProxy: "proxy:8080/v1?address=dawn-pg:5432",
      },
    ])
  })

  test("a request without the proxy binding still connects with TLS", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // The wsproxy switches turn TLS OFF. Written to the driver's process-wide
    // `neonConfig` — which is what this used to do, with no `else` — one request
    // carrying DAWN_PG_WS_PROXY would leave every LATER request in the isolate
    // talking plaintext through the previous request's proxy. That binding ships
    // in every generated stores.mjs, so setting it by accident (or by copying
    // the CI lane's config) would silently drop TLS to a production database.
    const observed = await driveEmittedStores(appRoot, [{ DAWN_PG_WS_PROXY: "proxy:8080" }, {}], {
      cliStub: NO_PROXY_RUNTIME_ENV_STUB,
    })

    expect(observed).toEqual([
      {
        connectionString: "postgres://from-runtime-env/db",
        useSecureWebSocket: false,
        wsProxy: "proxy:8080/v1?address=dawn-pg:5432",
      },
      // The second request asked for no proxy, so it gets the secure defaults —
      // it cannot inherit a decision the first request made.
      {
        connectionString: "postgres://from-runtime-env/db",
        useSecureWebSocket: true,
        wsProxy: null,
      },
    ])
  })

  test("a failed cold start leaves the next request to retry the migration", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // The invariant `migrated` exists for: it is set only AFTER the migration
    // actually succeeded. Set it before the await and a failed cold start
    // convinces every later request in the isolate that the schema is there —
    // which it is not, so every request fails on a missing table instead.
    //
    // Three `ready()` calls per cold-start pass (threads, permissions,
    // checkpointer), so a retried pass is six and a skipped one is three.
    const observed = await driveEmittedStores(appRoot, [{}, {}], {
      report: "{ readyCalls: readyCalls.length, requestErrors }",
      reportImports: 'import { readyCalls } from "@dawn-ai/postgres-storage"',
      storageStub: FAILING_READY_STORAGE_STUB,
      tolerateRequestFailures: true,
    })

    expect(observed).toEqual({ readyCalls: 6, requestErrors: ["cold start failed"] })
  })

  test("still names the missing binding when neither source has it", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // Same stubs, but a `readRuntimeEnv` that knows nothing — the genuinely
    // unconfigured deploy. The fallback must not turn a named error into a
    // driver-level connection failure with no hint of which binding is missing.
    await expect(
      driveEmittedStores(appRoot, [{}], { cliStub: EMPTY_RUNTIME_ENV_STUB }),
    ).rejects.toThrow(/DATABASE_URL is not set/)
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
/** Every seeding call, in order — the observable for a once-per-isolate seam. */
export const seededEnvs = []
export function seedRuntimeEnv(env) {
  seededEnvs.push(env)
}
/**
 * Stands in for the real seam, whose own precedence (process.env first, seeded
 * map second) is @dawn-ai/core's tested contract. What the emitted stores.mjs
 * has to get right — and what this records — is that it CONSULTS the seam at
 * all when a binding is absent, and uses what comes back.
 */
export function readRuntimeEnv(name) {
  return { DATABASE_URL: "postgres://from-runtime-env/db", DAWN_PG_WS_PROXY: "proxy:8080" }[name]
}
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
 *
 * `report` names what to print instead: the emitted entry has two observables
 * that live in different modules (the store factory's per-request env, and the
 * `@dawn-ai/cli/fetch` stub's seeding journal), and both are read out of the
 * child's own module instances rather than reconstructed from stdout chatter.
 */
async function driveEmittedApp(
  appRoot: string,
  databaseUrls: readonly string[],
  report: {
    /** How each request's Workers `env` is built from `databaseUrl`. */
    readonly envExpression?: string
    readonly expression: string
    readonly imports: string
  } = { expression: "seen", imports: 'import { seen } from "./stores.mjs"' },
): Promise<unknown> {
  const driverPath = buildFile(appRoot, "drive.test.mjs")
  await writeFile(
    driverPath,
    `import app from "./app.mjs"
${report.imports}

for (const databaseUrl of ${JSON.stringify(databaseUrls)}) {
  await app.fetch(new Request("http://x/healthz"), ${report.envExpression ?? "{ DATABASE_URL: databaseUrl }"})
}
console.log(JSON.stringify(${report.expression}))
`,
  )
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const { stdout } = await promisify(execFile)(process.execPath, [driverPath], {
    cwd: appRoot,
  })
  return JSON.parse(stdout.trim()) as unknown
}
