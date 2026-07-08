import { CustomEventSchema, EventType, StateSnapshotEventSchema } from "@ag-ui/core"
import { describe, expect, it } from "vitest"
import { createAgUiTranslator } from "../src/translate.js"
import type { AgUiEvent } from "../src/types.js"

const opts = { threadId: "t1", runId: "r1" }
const type1 = (evs: AgUiEvent[]) => evs[0]?.type

describe("translator: capability events", () => {
  it("maps plan_update to a STATE_SNAPSHOT carrying todos", () => {
    const t = createAgUiTranslator(opts)
    const todos = [{ content: "search", status: "pending" }]
    const evs = t.translate({ type: "plan_update", data: { todos } })
    expect(type1(evs)).toBe(EventType.STATE_SNAPSHOT)
    const parsed = StateSnapshotEventSchema.parse(evs[0])
    expect((parsed.snapshot as { todos: unknown }).todos).toEqual(todos)
  })

  it("accumulates state across snapshots", () => {
    const t = createAgUiTranslator(opts)
    t.translate({ type: "plan_update", data: { todos: [{ content: "a", status: "pending" }] } })
    const evs = t.translate({ type: "report_update", data: { report: "hello" } })
    const snap = evs.find((e) => e.type === EventType.STATE_SNAPSHOT) as
      | { snapshot: Record<string, unknown> }
      | undefined
    expect(snap?.snapshot.todos).toBeDefined()
    expect(snap?.snapshot.report).toBe("hello")
  })

  it("maps subagent events to CUSTOM dawn.<type>", () => {
    const t = createAgUiTranslator(opts)
    const evs = t.translate({
      type: "subagent.start",
      data: { call_id: "c1", subagent: "researcher" },
    })
    expect(type1(evs)).toBe(EventType.CUSTOM)
    const parsed = CustomEventSchema.parse(evs[0])
    expect(parsed.name).toBe("dawn.subagent.start")
    expect((parsed.value as { call_id: string }).call_id).toBe("c1")
  })

  it("maps interrupt to CUSTOM on_interrupt", () => {
    const t = createAgUiTranslator(opts)
    const detail = { command: "node scripts/fetch-source.mjs x", suggestedPattern: "node scripts" }
    const evs = t.translate({
      type: "interrupt",
      data: { interruptId: "perm-1", type: "permission-request", kind: "command", detail },
    })
    expect(type1(evs)).toBe(EventType.CUSTOM)
    const parsed = CustomEventSchema.parse(evs[0])
    expect(parsed.name).toBe("on_interrupt")
    expect((parsed.value as { interruptId: string }).interruptId).toBe("perm-1")
    expect((parsed.value as { kind: string }).kind).toBe("command")
  })

  it("flushes open text before a capability event", () => {
    const t = createAgUiTranslator(opts)
    const evs = [
      ...t.translate({ type: "token", data: "hi" }),
      ...t.translate({ type: "subagent.start", data: { call_id: "c1" } }),
    ]
    expect(evs.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.CUSTOM,
    ])
  })
})
