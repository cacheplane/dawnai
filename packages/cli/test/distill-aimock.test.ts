import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { type MemoryRecord, sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, describe, expect, it } from "vitest"

import { type AimockFixture, createAimock } from "../../testing/dist/index.js"
import { runMemoryCommand } from "../src/commands/memory.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

// Temp apps live inside the repo tree so node module resolution walks up to the
// workspace node_modules (same rule as eval-command/episodic-recorder tests).
const scratchRoot = resolve(repoRoot, "packages", "cli", ".tmp-distill-apps")

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// aimock: a real OpenAI-shaped server behind OPENAI_BASE_URL. The distillation
// commands go through the REAL `resolveProvider` → `createChatModel` →
// `ChatOpenAI` path — no stub model anywhere in this file.
//
// Fixtures match on a substring of the last user message, and the two prompts
// from @dawn-ai/memory are distinguishable by their opening line, so ONE mock
// can serve consolidation and reflection without ambiguity. An unmatched
// request gets a 404, which is how the failure cases below are provoked.
// ---------------------------------------------------------------------------

const CONSOLIDATION_PROMPT_MARKER = "compacting an agent's run history"
const REFLECTION_PROMPT_MARKER = "deriving durable insights"

async function startAimock(fixtures: readonly AimockFixture[]): Promise<void> {
  const aimock = await createAimock({ fixtures })
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(async () => {
    await aimock.close()
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
}

// ---------------------------------------------------------------------------
// Fixture app + store seeding
// ---------------------------------------------------------------------------

/** Thresholds low enough that a handful of seeded rows is real work; the model
 *  id and provider stay at their documented defaults (gpt-5-mini / openai) so
 *  this exercises the shipped provider resolution, not a test-only shortcut. */
const DAWN_CONFIG = [
  "export default {",
  "  memory: {",
  "    distill: {",
  "      consolidate: { olderThanMs: 0, minBatchSize: 2, maxBatchSize: 50 },",
  "      reflect: { minNewRecords: 2, maxRecords: 100 },",
  "    },",
  "  },",
  "}",
  "",
].join("\n")

async function makeApp(): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "app-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  await writeFile(join(root, "package.json"), '{ "name": "distill-temp-app", "type": "module" }\n')
  await writeFile(join(root, "dawn.config.ts"), DAWN_CONFIG)
  return root
}

const NAMESPACE = "ws=app|route=/chat"

// 2026-07-06 is a Monday, so Jul 6..10 is one ISO week — one namespace-week batch.
function episode(id: string, day: number, namespace = NAMESPACE): MemoryRecord {
  const at = `2026-07-${String(day).padStart(2, "0")}T09:00:00.000Z`
  return {
    id,
    kind: "episodic",
    namespace,
    content: `run ${id}: deployed the billing service`,
    data: {},
    source: { type: "run", id },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: at,
    updatedAt: at,
    effectiveAt: at,
  }
}

async function seed(appRoot: string, records: readonly MemoryRecord[]) {
  const store = sqliteMemoryStore({ path: join(appRoot, ".dawn/memory.sqlite") })
  for (const record of records) await store.put(record)
  return store
}

// ---------------------------------------------------------------------------
// The end-to-end proofs
// ---------------------------------------------------------------------------

describe("distillation through the real chat-model path (aimock)", () => {
  it("consolidate: prompt → model → summary row written and sources superseded", async () => {
    await startAimock([
      {
        match: { userMessage: CONSOLIDATION_PROMPT_MARKER },
        response: { content: '{"summary":"five billing deploys, no rollbacks"}' },
      },
    ])
    const appRoot = await makeApp()
    const store = await seed(
      appRoot,
      [6, 7, 8, 9, 10].map((d) => episode(`e${d}`, d)),
    )

    const out: string[] = []
    const err: string[] = []
    await runMemoryCommand(
      ["consolidate"],
      { cwd: appRoot },
      { stdout: (m) => out.push(m), stderr: (m) => err.push(m) },
    )

    expect(err.join("")).toBe("")
    expect(out.join("")).toMatch(/consolidated 5 records in ws=app\|route=\/chat → memory_sum_/)
    expect(out.join("")).toMatch(/consolidate: 1 batch\(es\), 1 written, 0 failed/)

    const summaries = (await store.browse({ kind: "episodic", limit: 100 })).records.filter((r) =>
      r.tags.includes("consolidated"),
    )
    expect(summaries).toHaveLength(1)
    const summary = summaries[0] as MemoryRecord
    expect(summary.content).toBe("five billing deploys, no rollbacks")
    expect(summary.namespace).toBe(NAMESPACE)
    expect(summary.data.derivedFrom).toEqual(["e6", "e7", "e8", "e9", "e10"])
    expect(summary.data.sourceCount).toBe(5)
    for (const d of [6, 7, 8, 9, 10]) {
      expect((await store.get(`e${d}`))?.status).toBe("superseded")
    }
    expect(summary.supersedes).toEqual(expect.arrayContaining(["e6", "e10"]))
  }, 60_000)

  it("reflect: prompt → model → candidate insight row with the watermark", async () => {
    await startAimock([
      {
        match: { userMessage: REFLECTION_PROMPT_MARKER },
        response: {
          content:
            '{"insights":[{"insight":"billing deploys cluster mid-week","confidence":0.7,"tags":["ops"]}]}',
        },
      },
    ])
    const appRoot = await makeApp()
    const store = await seed(
      appRoot,
      [6, 7, 8, 9, 10].map((d) => episode(`e${d}`, d)),
    )

    const out: string[] = []
    const err: string[] = []
    await runMemoryCommand(
      ["reflect"],
      { cwd: appRoot },
      { stdout: (m) => out.push(m), stderr: (m) => err.push(m) },
    )

    expect(err.join("")).toBe("")
    expect(out.join("")).toMatch(/reflected on 5 records in .* → 1 candidate insight\(s\)/)
    expect(out.join("")).toMatch(/reflect: 1 batch\(es\), 1 written, 0 failed/)

    const reflections = (await store.browse({ kind: "reflection", limit: 100 })).records
    expect(reflections).toHaveLength(1)
    const insight = reflections[0] as MemoryRecord
    expect(insight.status).toBe("candidate")
    expect(insight.content).toBe("billing deploys cluster mid-week")
    expect(insight.confidence).toBe(0.7)
    expect(insight.tags).toContain("ops")
    expect(insight.namespace).toBe(NAMESPACE)
    expect(insight.data.coveredUntil).toBe("2026-07-10T09:00:00.000Z")
    expect(insight.data.derivedFrom).toHaveLength(5)

    // The watermark is real: a second pass has nothing new to reflect on and
    // therefore never calls the model (the fixture would still match if it did).
    const second: string[] = []
    await runMemoryCommand(
      ["reflect"],
      { cwd: appRoot },
      { stdout: (m) => second.push(m), stderr: () => {} },
    )
    expect(second.join("")).toMatch(/nothing to reflect/)
    expect((await store.browse({ kind: "reflection", limit: 100 })).total).toBe(1)
  }, 60_000)

  it("partial failure: the good batch is reported AND the command exits non-zero", async () => {
    // Only the /good namespace's prompt has a fixture; /bad 404s at the mock.
    await startAimock([
      {
        match: { userMessage: "ws=app|route=/good" },
        response: { content: '{"summary":"good namespace summary"}' },
      },
    ])
    const appRoot = await makeApp()
    const store = await seed(appRoot, [
      ...[6, 7].map((d) => episode(`g${d}`, d, "ws=app|route=/good")),
      ...[6, 7].map((d) => episode(`b${d}`, d, "ws=app|route=/bad")),
    ])

    const out: string[] = []
    const err: string[] = []
    const failure = await runMemoryCommand(
      ["consolidate"],
      { cwd: appRoot },
      { stdout: (m) => out.push(m), stderr: (m) => err.push(m) },
    ).then(
      () => null,
      (e: unknown) => e as { message: string; exitCode?: number },
    )

    // Non-zero exit …
    expect(failure).not.toBeNull()
    expect(failure?.exitCode).toBe(1)
    expect(failure?.message).toMatch(/consolidate finished with 1 failed batch\(es\)/)
    // … AND the successful batch's progress was printed, not swallowed.
    expect(out.join("")).toMatch(/consolidated 2 records in ws=app\|route=\/good → memory_sum_/)
    expect(out.join("")).toMatch(/consolidate: 2 batch\(es\), 1 written, 1 failed/)
    expect(err.join("")).toMatch(/consolidation failed for ws=app\|route=\/bad/)

    // The good batch's writes landed; the bad batch's sources are untouched.
    expect((await store.get("g6"))?.status).toBe("superseded")
    expect((await store.get("b6"))?.status).toBe("active")
    const summaries = (await store.browse({ kind: "episodic", limit: 100 })).records.filter((r) =>
      r.tags.includes("consolidated"),
    )
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.content).toBe("good namespace summary")
  }, 60_000)

  it("an authored provider survives a --model override (end to end)", async () => {
    // The positive half of the provider-selection story: `provider: "openai"`
    // is authored, `--model gpt-5` overrides only the model id, and the run
    // completes against the OpenAI-shaped mock — the authored provider was
    // honored and the flag's model id reached the wire.
    await startAimock([
      {
        match: { userMessage: CONSOLIDATION_PROMPT_MARKER },
        response: { content: '{"summary":"summarized by the authored provider"}' },
      },
    ])
    const appRoot = await makeApp()
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      DAWN_CONFIG.replace("distill: {", 'distill: { provider: "openai",'),
    )
    const store = await seed(
      appRoot,
      [6, 7].map((d) => episode(`e${d}`, d)),
    )

    const out: string[] = []
    const err: string[] = []
    await runMemoryCommand(
      ["consolidate", "--model", "gpt-5"],
      { cwd: appRoot },
      { stdout: (m) => out.push(m), stderr: (m) => err.push(m) },
    )

    expect(err.join("")).toBe("")
    expect(out.join("")).toMatch(/consolidate: 1 batch\(es\), 1 written, 0 failed/)
    const summaries = (await store.browse({ kind: "episodic", limit: 100 })).records.filter((r) =>
      r.tags.includes("consolidated"),
    )
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.content).toBe("summarized by the authored provider")
  }, 60_000)

  it("the real chat model's .content is a plain string for this path", async () => {
    // Documents the shape the engine parses. `createChatModel` returns a
    // LangChain chat model; over the OpenAI chat-completions wire (which is
    // what aimock speaks) `.content` is a string, not an array of parts.
    await startAimock([
      { match: { userMessage: "shape probe" }, response: { content: "plain text reply" } },
    ])
    const { createChatModel, resolveProvider } = await import("@dawn-ai/langchain")
    const provider = resolveProvider({ model: "gpt-5-mini", provider: "openai" })
    const model = (await createChatModel({ model: "gpt-5-mini", provider })) as {
      invoke(prompt: string): Promise<{ content: unknown }>
    }

    const response = await model.invoke("shape probe")
    expect(typeof response.content).toBe("string")
    expect(response.content).toBe("plain text reply")
  }, 60_000)
})
