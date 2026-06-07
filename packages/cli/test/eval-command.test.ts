import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { CommanderError } from "commander"
import { afterEach, describe, expect, it } from "vitest"

import { runEvalCommand } from "../src/commands/eval.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
// Create temp apps *inside* the repo tree so node module resolution walks up to
// the workspace root node_modules (where @dawn-ai/sdk is hoisted). @dawn-ai/evals
// and @dawn-ai/testing are not hoisted, so they are symlinked into the temp app's
// node_modules explicitly — this satisfies both the eval file's value imports and
// the command's importFromApp() resolution.
const scratchRoot = resolve(repoRoot, "packages", "cli", ".tmp-eval-apps")

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function makeApp(evalSource: string): Promise<string> {
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

  return root
}

function makePassingEvalApp(): Promise<string> {
  return makeApp(
    [
      'import { contains, defineEval } from "@dawn-ai/evals"',
      'import { script } from "@dawn-ai/testing"',
      "",
      "export default defineEval({",
      '  name: "filter",',
      "  dataset: [",
      "    {",
      '      name: "open",',
      '      input: "Filter open items",',
      '      fixtures: script().user("Filter open items").replies("Found 2 open items."),',
      "    },",
      "  ],",
      '  scorers: [contains("Found 2", { threshold: 1 })],',
      "  threshold: 1,",
      "})",
      "",
    ].join("\n"),
  )
}

function makeFailingEvalApp(): Promise<string> {
  return makeApp(
    [
      'import { contains, defineEval } from "@dawn-ai/evals"',
      'import { script } from "@dawn-ai/testing"',
      "",
      "export default defineEval({",
      '  name: "filter",',
      "  dataset: [",
      "    {",
      '      name: "open",',
      '      input: "Filter open items",',
      '      fixtures: script().user("Filter open items").replies("Found 2 open items."),',
      "    },",
      "  ],",
      '  scorers: [contains("nope-not-present", { threshold: 1 })],',
      "  threshold: 1,",
      "})",
      "",
    ].join("\n"),
  )
}

describe("dawn eval (replay)", () => {
  it("passes a satisfied eval (exit 0)", async () => {
    const root = await makePassingEvalApp()
    const lines: string[] = []
    await runEvalCommand(
      undefined,
      { cwd: root },
      { stdout: (m) => lines.push(m), stderr: () => {} },
    )
    expect(lines.join("")).toContain("PASS")
  }, 60_000)

  it("fails a below-threshold eval (exit 1)", async () => {
    const root = await makeFailingEvalApp()
    await expect(
      runEvalCommand(undefined, { cwd: root }, { stdout: () => {}, stderr: () => {} }),
    ).rejects.toBeInstanceOf(CommanderError)
  }, 60_000)
})
