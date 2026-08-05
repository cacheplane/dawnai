import { describe, expect, it } from "vitest"
import {
  buildEpisode,
  extractToolNames,
  extractUserInputText,
} from "../src/lib/runtime/record-episode.js"

const START_ISO = "2026-08-08T04:40:00.000Z"

const BASE = {
  namespace: "workspace=app|route=/chat",
  input: "Please summarize the Q3 report and email it to the team",
  outcome: "ok" as const,
  toolsUsed: ["readFile", "sendEmail"],
  startedAt: Date.parse(START_ISO),
  finishedAt: Date.parse(START_ISO) + 4200,
  ttlMs: 30 * 86_400_000,
  runId: "run-123",
  threadId: "th-9",
}

describe("buildEpisode", () => {
  it("builds a deterministic, idempotent record", () => {
    const a = buildEpisode(BASE)
    const b = buildEpisode(BASE)
    expect(a.id).toBe(b.id)
    expect(a.id).toMatch(/^memory_ep_[0-9a-f]{16}$/)
    expect(a.kind).toBe("episodic")
    expect(a.status).toBe("active")
    expect(a.source).toEqual({ type: "run", id: "run-123" })
    expect(a.effectiveAt).toBe(new Date(BASE.startedAt).toISOString())
    expect(a.expiresAt).toBe(new Date(BASE.startedAt + BASE.ttlMs).toISOString())
    expect(a.data.durationMs).toBe(4200)
    expect(a.content).toMatch(/^run ok: /)
    expect(a.content).toContain("(2 tools, 4.2s)")
  })
  it("truncates input in content (~80 chars) and data (~500 chars)", () => {
    const long = buildEpisode({ ...BASE, input: "x".repeat(1000) })
    expect(long.content.length).toBeLessThan(120)
    expect((long.data.input as string).length).toBeLessThanOrEqual(500)
  })
  it("failure outcome renders and records", () => {
    const f = buildEpisode({ ...BASE, outcome: "error" })
    expect(f.content).toMatch(/^run error: /)
    expect(f.data.outcome).toBe("error")
  })
  it("different runIds produce different ids", () => {
    expect(buildEpisode(BASE).id).not.toBe(buildEpisode({ ...BASE, runId: "run-124" }).id)
  })
})

describe("extractToolNames", () => {
  it("collects unique, ordered tool names from AIMessage tool_calls and ToolMessage fallbacks", () => {
    // Fabricated final LangGraph state: mixes live-instance-shaped messages
    // (plain objects with type/tool_calls) and serialized-constructor-shaped
    // messages ({ lc, type: "constructor", id: [..., "AIMessage"], kwargs }),
    // duplicates, and unrelated messages.
    const output = {
      messages: [
        { type: "human", content: "Filter open items then deploy" },
        {
          type: "ai",
          content: "",
          tool_calls: [
            { id: "call_1", name: "applyFilter", args: { status: "open" } },
            { id: "call_2", name: "deployProd", args: {} },
          ],
        },
        { type: "tool", name: "applyFilter", content: '{"matched":2}' },
        { type: "tool", name: "deployProd", content: "ok" },
        {
          lc: 1,
          type: "constructor",
          id: ["langchain_core", "messages", "AIMessage"],
          kwargs: {
            content: "",
            // duplicate of applyFilter + one new name, in the serialized shape
            tool_calls: [
              { id: "call_3", name: "applyFilter", args: {} },
              { id: "call_4", name: "sendReport", args: {} },
            ],
          },
        },
        {
          lc: 1,
          type: "constructor",
          id: ["langchain_core", "messages", "ToolMessage"],
          kwargs: { name: "sendReport", content: "sent" },
        },
        { type: "ai", content: "All done." },
      ],
    }
    expect(extractToolNames(output)).toEqual(["applyFilter", "deployProd", "sendReport"])
  })
  it("returns [] for outputs without messages", () => {
    expect(extractToolNames(undefined)).toEqual([])
    expect(extractToolNames({})).toEqual([])
    expect(extractToolNames({ messages: "nope" })).toEqual([])
    expect(extractToolNames({ messages: [null, 42, "str"] })).toEqual([])
  })
})

describe("extractUserInputText", () => {
  it("returns a bare string input as-is", () => {
    expect(extractUserInputText("hello there")).toBe("hello there")
  })
  it("extracts the LAST human message's text from a messages envelope", () => {
    const input = {
      messages: [
        { role: "user", content: "first question" },
        { type: "ai", content: "answer" },
        { role: "user", content: "second question" },
      ],
    }
    expect(extractUserInputText(input)).toBe("second question")
  })
  it("joins text content parts and handles serialized HumanMessage shapes", () => {
    const parts = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "part one" },
            { type: "text", text: "part two" },
          ],
        },
      ],
    }
    expect(extractUserInputText(parts)).toBe("part one part two")
    const serialized = {
      messages: [
        {
          lc: 1,
          type: "constructor",
          id: ["langchain_core", "messages", "HumanMessage"],
          kwargs: { content: "from kwargs" },
        },
      ],
    }
    expect(extractUserInputText(serialized)).toBe("from kwargs")
  })
  it("falls back to empty string on anything unrecognized", () => {
    expect(extractUserInputText(undefined)).toBe("")
    expect(extractUserInputText({ messages: [] })).toBe("")
    expect(extractUserInputText({ messages: [{ type: "ai", content: "no humans" }] })).toBe("")
    expect(extractUserInputText(42)).toBe("")
  })
})
