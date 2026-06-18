import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runEvalCommand } from "../src/commands/eval.js"
import { startAimock } from "../../testing/dist/index.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
// Create temp apps *inside* the repo tree so node module resolution walks up to
// the workspace root node_modules (where @dawn-ai/sdk is hoisted). @dawn-ai/evals
// and @dawn-ai/testing are not hoisted, so they are symlinked into the temp app's
// node_modules explicitly — this satisfies both the eval file's value imports and
// the command's importFromApp() resolution.
const scratchRoot = resolve(repoRoot, "packages", "cli", ".tmp-eval-apps")

const tempDirs: string[] = []

// Save/restore env vars that record mode sets, so tests don't bleed into each other.
let savedApiKey: string | undefined
let savedRecordUpstream: string | undefined

beforeEach(() => {
  savedApiKey = process.env.OPENAI_API_KEY
  savedRecordUpstream = process.env.DAWN_RECORD_UPSTREAM
})

afterEach(async () => {
  // Restore env vars
  if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = savedApiKey
  if (savedRecordUpstream === undefined) delete process.env.DAWN_RECORD_UPSTREAM
  else process.env.DAWN_RECORD_UPSTREAM = savedRecordUpstream

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function makeApp(evalSource: string): Promise<{ root: string; routeDir: string }> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "app-"))
  tempDirs.push(root)

  await writeFile(join(root, "package.json"), '{ "name": "eval-temp-app", "type": "module" }\n')
  await writeFile(join(root, "dawn.config.ts"), "export default {}\n")

  // Symlink the non-hoisted workspace packages the eval file + command need.
  await mkdir(join(root, "node_modules", "@dawn-ai"), { recursive: true })
  await symlink(
    join(repoRoot, "packages", "evals"),
    join(root, "node_modules", "@dawn-ai", "evals"),
    "dir",
  )
  await symlink(
    join(repoRoot, "packages", "testing"),
    join(root, "node_modules", "@dawn-ai", "testing"),
    "dir",
  )

  // A real agent route the in-process harness can run, mirroring the testing
  // package's probe-app fixture (agent() + a route-local tool).
  const routeDir = join(root, "src", "app", "chat")
  await mkdir(join(routeDir, "tools"), { recursive: true })
  await writeFile(
    join(routeDir, "index.ts"),
    [
      'import { agent } from "@dawn-ai/sdk"',
      "export default agent({",
      '  model: "gpt-4o-mini",',
      '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
      "})",
      "",
    ].join("\n"),
  )
  await writeFile(
    join(routeDir, "tools", "applyFilter.ts"),
    [
      "/** Apply a status filter and report how many matched. */",
      "export default async function applyFilter(input: {",
      '  status: "open" | "closed"',
      "}): Promise<{ matched: number }> {",
      '  return { matched: input.status === "open" ? 2 : 0 }',
      "}",
      "",
    ].join("\n"),
  )

  await mkdir(join(routeDir, "evals"), { recursive: true })
  await writeFile(join(routeDir, "evals", "filter.eval.ts"), evalSource)

  return { root, routeDir }
}

/** Eval with a single NO-inline-fixture case (record scenario). */
function makeNoFixturesEvalApp(): Promise<{ root: string; routeDir: string }> {
  return makeApp(
    [
      'import { contains, defineEval } from "@dawn-ai/evals"',
      "",
      "export default defineEval({",
      '  name: "filter",',
      "  dataset: [",
      "    {",
      '      name: "open",',
      '      input: "Filter open items",',
      "    },",
      "  ],",
      '  scorers: [contains("from upstream", { threshold: 1 })],',
      "  threshold: 1,",
      "})",
      "",
    ].join("\n"),
  )
}

describe("dawn eval --record (guards)", () => {
  it("rejects --record + --live with a clear message", async () => {
    const { root } = await makeNoFixturesEvalApp()
    await expect(
      runEvalCommand(
        undefined,
        { cwd: root, record: true, live: true },
        { stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toThrow(/Choose one of --record or --live/)
  }, 10_000)

  it("rejects --record without OPENAI_API_KEY", async () => {
    const { root } = await makeNoFixturesEvalApp()
    delete process.env.OPENAI_API_KEY
    await expect(
      runEvalCommand(
        undefined,
        { cwd: root, record: true },
        { stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toThrow(/requires OPENAI_API_KEY/)
  }, 10_000)
})

describe("dawn eval --record (integration)", () => {
  it("records, writes sibling file, then replays PASS", async () => {
    // Start a local aimock as the "real upstream" (record mode will proxy to it).
    const upstream = await startAimock({
      fixtures: [
        {
          match: {},
          response: { content: "from upstream" },
        },
      ],
    })

    try {
      const { root, routeDir } = await makeNoFixturesEvalApp()

      // Point record mode at our local upstream (no /v1 suffix).
      process.env.OPENAI_API_KEY = "test-placeholder"
      process.env.DAWN_RECORD_UPSTREAM = upstream.baseUrl.replace(/\/v1$/, "")

      const io = { stdout: (m: string) => lines.push(m), stderr: () => {} }
      const lines: string[] = []

      // 1. Record run — should succeed (exit 0).
      await runEvalCommand(undefined, { cwd: root, record: true }, io)

      const out = lines.join("\n")
      expect(out).toContain("recorded")
      expect(out).toContain("→")

      // 2. Sibling file should now exist with fixtures.
      const siblingPath = join(routeDir, "evals", "filter.open.fixtures.json")
      const raw = await readFile(siblingPath, "utf-8")
      const parsed = JSON.parse(raw) as { fixtures: Array<{ match: { turnIndex?: number } }> }
      expect(parsed).toHaveProperty("fixtures")
      expect(Array.isArray(parsed.fixtures)).toBe(true)
      expect(parsed.fixtures.length).toBeGreaterThan(0)
      expect(parsed.fixtures[0]!.match.turnIndex).toBe(0)

      // 3. Replay run (no record, no upstream env vars) — should PASS from sibling file.
      delete process.env.OPENAI_API_KEY
      delete process.env.DAWN_RECORD_UPSTREAM

      const io2 = { stdout: (m: string) => lines2.push(m), stderr: () => {} }
      const lines2: string[] = []
      await runEvalCommand(undefined, { cwd: root }, io2)
      expect(lines2.join("\n")).toContain("PASS")
    } finally {
      await upstream.stop()
    }
  }, 120_000)
})
