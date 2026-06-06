/**
 * Migrated SP5 / SP6a / SUMM regression scenarios onto the @dawn-ai/testing
 * Layer A harness (in-process, no pnpm pack / install required).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, expect, it } from "vitest"
import {
  createAgentHarness,
  expectFinalMessage,
  expectOffloaded,
  expectState,
  expectToolCalled,
  script,
  type FixtureSet,
} from "@dawn-ai/testing"

const probeAppRoot = fileURLToPath(new URL("./probe-app", import.meta.url))
const probeAppSummarizeRoot = fileURLToPath(new URL("./probe-app-summarize", import.meta.url))

// ---------------------------------------------------------------------------
// SP5: discriminated-union tool argument (applyFilter with anyOf sort field)
// ---------------------------------------------------------------------------

it("SP5: discriminated-union tool argument is accepted and anyOf schema is present", async () => {
  const h = await createAgentHarness({ appRoot: probeAppRoot, route: "/chat#agent" })
  try {
    // --- (a) Schema-shape assertion (closes false-green gap: #188 / SP5) ---
    // The harness runs typegen on construct, so .dawn/routes/<chat>/tools.json is present.
    const routesDir = join(probeAppRoot, ".dawn", "routes")
    const routeDirName = readdirSync(routesDir).find((d) => d.startsWith("chat"))
    expect(routeDirName, ".dawn/routes/<chat*> dir present").toBeDefined()
    const toolsJsonPath = join(routesDir, routeDirName as string, "tools.json")
    expect(existsSync(toolsJsonPath), `tools.json present at ${toolsJsonPath}`).toBe(true)

    const tools = JSON.parse(readFileSync(toolsJsonPath, "utf-8")) as Record<
      string,
      { description?: string; parameters?: { properties?: Record<string, unknown> } }
    >
    const sortSchema = tools.applyFilter?.parameters?.properties?.sort as
      | { anyOf?: unknown[] }
      | undefined

    expect(
      sortSchema?.anyOf,
      "applyFilter.sort is an anyOf union (not degraded to a plain/unknown type)",
    ).toBeDefined()
    expect(
      Array.isArray(sortSchema?.anyOf) && (sortSchema?.anyOf?.length ?? 0) >= 2,
      "applyFilter.sort anyOf has at least 2 members",
    ).toBe(true)

    for (const member of (sortSchema?.anyOf ?? []) as Array<{
      type?: string
      properties?: Record<string, unknown>
    }>) {
      expect(member.type, "each anyOf member has type=object").toBe("object")
      expect(
        JSON.stringify(member),
        "no charAt leak in member (original #188 bug)",
      ).not.toContain("charAt")
    }

    // --- (b) Run: model calls applyFilter with union arg, succeeds ---
    const run = await h.run({
      input: "Filter the open urgent/backend items, newest first.",
      fixtures: script()
        .user("Filter the open urgent/backend items, newest first.")
        .callsTool(
          "applyFilter",
          {
            filter: { status: "open", tags: ["urgent", "backend"] },
            pagination: { limit: 25 },
            labels: { team: "payments" },
            sort: { by: "date", dir: "desc" },
          },
          { id: "call_apply_filter_1" },
        )
        .replies("Matched 2 items."),
    })

    expectToolCalled(run, "applyFilter")
    expectFinalMessage(run).toContain("Matched 2")

    // Also assert the tool response didn't contain schema-rejection errors.
    // In-process, state.messages contains raw LangChain BaseMessage instances
    // (lc_id: ["langchain_core","messages","ToolMessage"]), not serialized JSON
    // objects (which would have id: [...] array). Handle both shapes.
    function isToolMsg(m: Record<string, unknown>, name: string): boolean {
      // Serialized JSON shape (used by HTTP AP endpoint, matchers.ts)
      const id = (m as { id?: string[] }).id
      const kw = (m as { kwargs?: { name?: string } }).kwargs
      if (Array.isArray(id) && id[2] === "ToolMessage" && kw?.name === name) return true
      // Raw BaseMessage instance shape (in-process harness)
      const lcId = (m as { lc_id?: string[] }).lc_id
      const msgName = (m as { name?: string }).name
      if (Array.isArray(lcId) && lcId[2] === "ToolMessage" && msgName === name) return true
      return false
    }

    function getToolContent(m: Record<string, unknown>): string {
      // Serialized shape: m.kwargs.content
      const kwContent = (m as { kwargs?: { content?: string } }).kwargs?.content
      if (typeof kwContent === "string") return kwContent
      // Raw instance shape: m.content
      const rawContent = (m as { content?: unknown }).content
      if (typeof rawContent === "string") return rawContent
      return ""
    }

    const toolMsg = run.messages.find((m) => isToolMsg(m, "applyFilter"))
    const content = toolMsg ? getToolContent(toolMsg) : ""
    expect(content, "no schema-rejection in tool content").not.toContain("did not match expected schema")
    expect(content, "no Invalid input in tool content").not.toContain("Invalid input")
    expect(content, 'expected "matched":2 in tool echo').toContain('"matched":2')
  } finally {
    await h.close()
  }
}, 120_000)

// ---------------------------------------------------------------------------
// SP6a: large output is offloaded (generateReport → stub)
// ---------------------------------------------------------------------------

it("SP6a: generateReport output is offloaded and expectOffloaded passes", async () => {
  // Use a raw FixtureSet (no userMessage constraint on reply) to ensure the
  // second fixture matches regardless of conversation state after offloading.
  const sp6aFixtures: FixtureSet = [
    {
      match: { turnIndex: 0, hasToolResult: false },
      response: {
        toolCalls: [{ id: "call_gen_report_1", name: "generateReport", arguments: { rows: 2000 } }],
      },
    },
    {
      match: { hasToolResult: true },
      response: { content: "Found the marker." },
    },
  ]
  const h = await createAgentHarness({ appRoot: probeAppRoot, route: "/chat#agent" })
  try {
    const run = await h.run({
      input: "Make a 2000-row report and quote the marker line.",
      fixtures: sp6aFixtures,
    })

    // The generateReport output exceeds 40k chars — Dawn offloads it to a stub.
    expectOffloaded(run, "generateReport")
    expectFinalMessage(run).toContain("Found the marker")
  } finally {
    await h.close()
  }
}, 120_000)

// ---------------------------------------------------------------------------
// SUMM: summarization populates runningSummary non-destructively
// ---------------------------------------------------------------------------

it("SUMM: summarization preserves full history + populates runningSummary across the threshold", async () => {
  const h = await createAgentHarness({
    appRoot: probeAppSummarizeRoot,
    route: "/chat#agent",
  })
  try {
    // Three sequential turns on the same thread (no h.reset() between them).
    // maxTokens:10 + keepRecentTurns:1 forces summarization from turn 2 onward.
    const turns = [
      { token: "APPLE_TURN", reply: "Noted about apples." },
      { token: "BANANA_TURN", reply: "Noted about bananas." },
      { token: "CHERRY_TURN", reply: "Noted about cherries." },
    ]

    let lastRun = null
    for (const { token, reply } of turns) {
      const input = `Question ${token} please.`
      lastRun = await h.run({
        input,
        fixtures: script().user(token).replies(reply),
      })
    }

    // (a) runningSummary is populated.
    expectState(lastRun!).field("runningSummary").toBeTruthy()

    // (b) runningSummary contains the deterministic summary string.
    const rs = lastRun!.state.runningSummary as
      | { summary?: string; coveredCount?: number }
      | null
      | undefined
    expect(rs?.summary, "runningSummary.summary should contain deterministic string").toContain(
      "DETERMINISTIC_SUMMARY_OF_OLD_TURNS",
    )
    expect(
      typeof rs?.coveredCount === "number" && (rs.coveredCount ?? 0) > 0,
      `runningSummary.coveredCount should be > 0, got ${rs?.coveredCount}`,
    ).toBe(true)

    // (c) 3 HumanMessages survive in the persisted history.
    const messages = lastRun!.messages
    const humanCount = messages.filter((m) => {
      const id = (m as { id?: string[] }).id
      if (Array.isArray(id) && id[2] === "HumanMessage") return true
      const typed = m as { type?: string; role?: string }
      return typed.type === "human" || typed.role === "user"
    }).length
    expect(
      humanCount,
      `expected 3 HumanMessages in persisted history, got ${humanCount}: ${JSON.stringify(messages).slice(0, 800)}`,
    ).toBe(3)

    // (d) Non-destructive: summary must NOT leak into persisted messages.
    const persisted = JSON.stringify(messages)
    expect(
      persisted.includes("DETERMINISTIC_SUMMARY_OF_OLD_TURNS"),
      "summary must NOT leak into persisted messages (non-destructive architecture)",
    ).toBe(false)
  } finally {
    await h.close()
  }
}, 120_000)
