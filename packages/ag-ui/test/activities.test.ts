import { ActivitySnapshotEventSchema, EventType } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import {
  createDawnActivityProjector as createUncheckedDawnActivityProjector,
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
  isDawnActivityChunkType,
} from "../src/activities.ts"

const identity = {
  call_id: "call-research-1",
  subagent: "researcher",
  route_id: "/research#researcher",
  depth: 1,
} as const

const todos = [
  { content: "Search the corpus", status: "completed" },
  { content: "Read the best source", status: "in_progress" },
] as const

function createDawnActivityProjector(runId: string) {
  const projector = createUncheckedDawnActivityProjector(runId)
  return {
    project(...args: Parameters<typeof projector.project>) {
      const event = projector.project(...args)
      if (event !== null) expect(ActivitySnapshotEventSchema.parse(event)).toEqual(event)
      return event
    },
  }
}

describe("isDawnActivityChunkType", () => {
  test("recognizes exactly the seven activity chunk types", () => {
    for (const type of [
      "plan_update",
      "subagent.start",
      "subagent.plan_update",
      "subagent.tool_call",
      "subagent.tool_result",
      "subagent.message",
      "subagent.end",
    ]) {
      expect(isDawnActivityChunkType(type)).toBe(true)
    }

    for (const type of [
      "token",
      "tool_call",
      "done",
      "capability.unknown",
      "subagent.unknown",
      "subagent.start.extra",
    ]) {
      expect(isDawnActivityChunkType(type)).toBe(false)
    }
  })
})

describe("createDawnActivityProjector", () => {
  test("emits complete plan replacements with one stable run-scoped id", () => {
    const projector = createDawnActivityProjector("run-1")
    const first = projector.project("plan_update", { todos: [todos[0]] })
    const second = projector.project("plan_update", { todos })

    expect(first).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "dawn:plan:run-1",
      activityType: DAWN_PLAN_ACTIVITY_TYPE,
      replace: true,
      content: { todos: [todos[0]] },
    })
    expect(second).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "dawn:plan:run-1",
      activityType: DAWN_PLAN_ACTIVITY_TYPE,
      replace: true,
      content: { todos },
    })
    expect(DAWN_SUBAGENT_ACTIVITY_TYPE).toBe("dawn.subagent")
    expect(ActivitySnapshotEventSchema.parse(first)).toEqual(first)
    expect(ActivitySnapshotEventSchema.parse(second)).toEqual(second)
  })

  test("starts a subagent and replaces its complete child plan", () => {
    const projector = createDawnActivityProjector("run-1")
    const start = projector.project("subagent.start", identity)
    const plan = projector.project("subagent.plan_update", { ...identity, todos })

    expect(start).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "dawn:subagent:call-research-1",
      activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
      replace: true,
      content: {
        name: "researcher",
        depth: 1,
        status: "running",
        tools: [],
        totalToolCount: 0,
      },
    })
    expect(plan).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "dawn:subagent:call-research-1",
      activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
      replace: true,
      content: {
        name: "researcher",
        depth: 1,
        status: "running",
        todos,
        tools: [],
        totalToolCount: 0,
      },
    })
    expect(ActivitySnapshotEventSchema.parse(start)).toEqual(start)
    expect(ActivitySnapshotEventSchema.parse(plan)).toEqual(plan)
  })

  test("ignores child plans before start and payloads without canonical identity", () => {
    const projector = createDawnActivityProjector("run-1")

    expect(projector.project("subagent.plan_update", { ...identity, todos })).toBeNull()
    expect(
      projector.project("subagent.start", {
        call_id: identity.call_id,
        subagent: identity.subagent,
        depth: identity.depth,
      }),
    ).toBeNull()
  })

  test("ignores identity conflicts after start", () => {
    const projector = createDawnActivityProjector("run-1")
    expect(projector.project("subagent.start", identity)).not.toBeNull()

    expect(
      projector.project("subagent.start", { ...identity, route_id: "/research#writer" }),
    ).toBeNull()
    expect(
      projector.project("subagent.plan_update", {
        ...identity,
        subagent: "writer",
        todos,
      }),
    ).toBeNull()
  })

  test("requires byte-exact identity fields after start", () => {
    for (const paddedIdentity of [
      { ...identity, call_id: `  ${identity.call_id}  ` },
      { ...identity, subagent: `  ${identity.subagent}  ` },
      { ...identity, route_id: `  ${identity.route_id}  ` },
    ]) {
      const projector = createDawnActivityProjector("run-1")
      expect(projector.project("subagent.start", identity)).not.toBeNull()
      expect(projector.project("subagent.plan_update", { ...paddedIdentity, todos })).toBeNull()
    }
  })

  test("correlates child tool calls and results without exposing inputs or outputs", () => {
    const projector = createDawnActivityProjector("run-1")
    projector.project("subagent.start", identity)

    const call = projector.project("subagent.tool_call", {
      ...identity,
      id: "tool-1",
      tool: "searchCorpus",
      input: { secret: "private prompt" },
    })
    const result = projector.project("subagent.tool_result", {
      ...identity,
      id: "tool-1",
      tool: "wrong-name-must-not-be-read",
      output: { secret: "private result" },
    })

    expect(call?.content).toMatchObject({
      tools: [{ name: "searchCorpus", status: "running" }],
      totalToolCount: 1,
    })
    expect(result?.content).toMatchObject({
      tools: [{ name: "searchCorpus", status: "completed" }],
      totalToolCount: 1,
    })
    expect(JSON.stringify([call, result])).not.toMatch(/private prompt|private result|wrong-name/)
    expect(ActivitySnapshotEventSchema.parse(call)).toEqual(call)
    expect(ActivitySnapshotEventSchema.parse(result)).toEqual(result)
  })

  test("preserves tool ids for exact correlation while trimming public names", () => {
    const projector = createDawnActivityProjector("run-1")
    projector.project("subagent.start", identity)

    const called = projector.project("subagent.tool_call", {
      ...identity,
      id: "tool-1",
      tool: "  searchCorpus  ",
    })
    expect(called?.content).toMatchObject({
      tools: [{ name: "searchCorpus", status: "running" }],
      totalToolCount: 1,
    })

    expect(
      projector.project("subagent.tool_result", {
        ...identity,
        id: "  tool-1  ",
      }),
    ).toBeNull()

    const completed = projector.project("subagent.tool_result", {
      ...identity,
      id: "tool-1",
    })
    expect(completed?.content).toMatchObject({
      tools: [{ name: "searchCorpus", status: "completed" }],
      totalToolCount: 1,
    })

    const padded = projector.project("subagent.tool_call", {
      ...identity,
      id: "  tool-1  ",
      tool: "  searchCorpusAgain  ",
    })
    expect(padded?.content).toMatchObject({
      tools: [
        { name: "searchCorpus", status: "completed" },
        { name: "searchCorpusAgain", status: "running" },
      ],
      totalToolCount: 2,
    })

    const paddedCompleted = projector.project("subagent.tool_result", {
      ...identity,
      id: "  tool-1  ",
    })
    expect(paddedCompleted?.content).toMatchObject({
      tools: [
        { name: "searchCorpus", status: "completed" },
        { name: "searchCorpusAgain", status: "completed" },
      ],
      totalToolCount: 2,
    })
  })

  test("retains only the five newest tool summaries while counting each id once", () => {
    const projector = createDawnActivityProjector("run-1")
    projector.project("subagent.start", identity)

    let snapshot = null
    for (let index = 1; index <= 6; index += 1) {
      snapshot = projector.project("subagent.tool_call", {
        ...identity,
        id: `tool-${index}`,
        tool: `toolName${index}`,
      })
    }

    expect(snapshot?.content).toMatchObject({
      tools: [
        { name: "toolName2", status: "running" },
        { name: "toolName3", status: "running" },
        { name: "toolName4", status: "running" },
        { name: "toolName5", status: "running" },
        { name: "toolName6", status: "running" },
      ],
      totalToolCount: 6,
    })
    expect(projector.project("subagent.tool_result", { ...identity, id: "tool-1" })).toBeNull()

    const completed = projector.project("subagent.tool_result", {
      ...identity,
      id: "tool-6",
    })
    expect(completed?.content).toMatchObject({
      tools: [
        { name: "toolName2", status: "running" },
        { name: "toolName3", status: "running" },
        { name: "toolName4", status: "running" },
        { name: "toolName5", status: "running" },
        { name: "toolName6", status: "completed" },
      ],
      totalToolCount: 6,
    })

    const reinserted = projector.project("subagent.tool_call", {
      ...identity,
      id: "tool-1",
      tool: "toolName1",
    })
    expect(reinserted?.content).toMatchObject({
      tools: [
        { name: "toolName3", status: "running" },
        { name: "toolName4", status: "running" },
        { name: "toolName5", status: "running" },
        { name: "toolName6", status: "completed" },
        { name: "toolName1", status: "running" },
      ],
      totalToolCount: 6,
    })
    expect(ActivitySnapshotEventSchema.parse(reinserted)).toEqual(reinserted)
  })

  test("completes once, marks running tools incomplete, and freezes terminal state", () => {
    const projector = createDawnActivityProjector("run-1")
    projector.project("subagent.start", identity)
    projector.project("subagent.plan_update", { ...identity, todos })
    projector.project("subagent.tool_call", {
      ...identity,
      id: "tool-running",
      tool: "searchCorpus",
    })
    projector.project("subagent.tool_call", {
      ...identity,
      id: "tool-completed",
      tool: "readDoc",
    })
    projector.project("subagent.tool_result", { ...identity, id: "tool-completed" })

    const ended = projector.project("subagent.end", {
      ...identity,
      final_message: "private child answer",
    })
    expect(ended?.content).toEqual({
      name: "researcher",
      depth: 1,
      status: "completed",
      todos,
      tools: [
        { name: "searchCorpus", status: "incomplete" },
        { name: "readDoc", status: "completed" },
      ],
      totalToolCount: 2,
    })
    expect(JSON.stringify(ended)).not.toContain("private child answer")
    expect(ActivitySnapshotEventSchema.parse(ended)).toEqual(ended)

    expect(projector.project("subagent.end", identity)).toBeNull()
    expect(projector.project("subagent.start", identity)).toBeNull()
    expect(
      projector.project("subagent.tool_call", {
        ...identity,
        id: "tool-late",
        tool: "lateTool",
      }),
    ).toBeNull()
    expect(projector.project("subagent.plan_update", { ...identity, todos: [] })).toBeNull()
  })

  test("caps failure errors at 400 characters", () => {
    const projector = createDawnActivityProjector("run-1")
    projector.project("subagent.start", identity)

    const ended = projector.project("subagent.end", {
      ...identity,
      error: "x".repeat(500),
    })

    expect(ended?.content).toMatchObject({
      status: "failed",
      error: "x".repeat(400),
    })
    expect(ActivitySnapshotEventSchema.parse(ended)).toEqual(ended)
  })

  test("rejects a present non-string error without ending, while whitespace completes", () => {
    const projector = createDawnActivityProjector("run-1")
    projector.project("subagent.start", identity)

    expect(
      projector.project("subagent.end", { ...identity, error: { message: "private" } }),
    ).toBeNull()
    const ended = projector.project("subagent.end", { ...identity, error: "   " })
    expect(ended?.content).toMatchObject({ status: "completed" })
    expect(ended?.content).not.toHaveProperty("error")
    expect(ActivitySnapshotEventSchema.parse(ended)).toEqual(ended)
  })

  test("re-emits an identical repeated start without discarding progress", () => {
    const projector = createDawnActivityProjector("run-1")
    projector.project("subagent.start", identity)
    projector.project("subagent.plan_update", { ...identity, todos })
    projector.project("subagent.tool_call", {
      ...identity,
      id: "tool-1",
      tool: "searchCorpus",
    })

    const repeated = projector.project("subagent.start", identity)
    expect(repeated?.content).toEqual({
      name: "researcher",
      depth: 1,
      status: "running",
      todos,
      tools: [{ name: "searchCorpus", status: "running" }],
      totalToolCount: 1,
    })
    expect(ActivitySnapshotEventSchema.parse(repeated)).toEqual(repeated)
  })

  test("ignores lifecycle events received before start", () => {
    const projector = createDawnActivityProjector("run-1")

    expect(
      projector.project("subagent.tool_call", {
        ...identity,
        id: "tool-1",
        tool: "searchCorpus",
      }),
    ).toBeNull()
    expect(projector.project("subagent.tool_result", { ...identity, id: "tool-1" })).toBeNull()
    expect(projector.project("subagent.message", { ...identity, content: "private" })).toBeNull()
    expect(projector.project("subagent.end", identity)).toBeNull()
  })

  test("keeps interleaved call ids isolated", () => {
    const projector = createDawnActivityProjector("run-1")
    const writerIdentity = {
      call_id: "call-writer-1",
      subagent: "writer",
      route_id: "/research#writer",
      depth: 2,
    } as const
    projector.project("subagent.start", identity)
    projector.project("subagent.start", writerIdentity)
    projector.project("subagent.tool_call", {
      ...identity,
      id: "research-tool",
      tool: "searchCorpus",
    })
    projector.project("subagent.tool_call", {
      ...writerIdentity,
      id: "writer-tool",
      tool: "draftReport",
    })

    const researchEnded = projector.project("subagent.end", identity)
    const writerProgress = projector.project("subagent.tool_result", {
      ...writerIdentity,
      id: "writer-tool",
    })
    expect(researchEnded?.messageId).toBe("dawn:subagent:call-research-1")
    expect(researchEnded?.content).toMatchObject({
      name: "researcher",
      status: "completed",
      tools: [{ name: "searchCorpus", status: "incomplete" }],
    })
    expect(writerProgress?.messageId).toBe("dawn:subagent:call-writer-1")
    expect(writerProgress?.content).toMatchObject({
      name: "writer",
      status: "running",
      tools: [{ name: "draftReport", status: "completed" }],
    })
    expect(ActivitySnapshotEventSchema.parse(researchEnded)).toEqual(researchEnded)
    expect(ActivitySnapshotEventSchema.parse(writerProgress)).toEqual(writerProgress)
  })

  test("consumes child messages and exposes only allowlisted public fields", () => {
    const projector = createDawnActivityProjector("run-1")
    projector.project("subagent.start", { ...identity, private_start: "secret-start" })
    expect(
      projector.project("subagent.message", {
        ...identity,
        content: "private child prose",
        reasoning: "private reasoning",
      }),
    ).toBeNull()
    const call = projector.project("subagent.tool_call", {
      ...identity,
      id: "private-tool-id",
      tool: "searchCorpus",
      input: { query: "private query" },
    })
    projector.project("subagent.tool_result", {
      ...identity,
      id: "private-tool-id",
      tool: "private result tool name",
      output: "private tool output",
    })
    const ended = projector.project("subagent.end", {
      ...identity,
      final_message: "private final child answer",
    })

    expect(Object.keys(call?.content ?? {}).sort()).toEqual([
      "depth",
      "name",
      "status",
      "tools",
      "totalToolCount",
    ])
    expect(Object.keys(ended?.content ?? {}).sort()).toEqual([
      "depth",
      "name",
      "status",
      "tools",
      "totalToolCount",
    ])
    const serializedContent = JSON.stringify([call?.content, ended?.content])
    for (const privateValue of [
      identity.call_id,
      identity.route_id,
      "private-tool-id",
      "private child prose",
      "private reasoning",
      "private query",
      "private tool output",
      "private result tool name",
      "private final child answer",
      "secret-start",
    ]) {
      expect(serializedContent).not.toContain(privateValue)
    }
  })

  test("rejects malformed plans and canonical subagent fields", () => {
    const malformedPlanProjector = createDawnActivityProjector("run-plan")
    for (const data of [
      null,
      [],
      { todos: {} },
      { todos: [null] },
      { todos: [{ content: "", status: "pending" }] },
      { todos: [{ content: "   ", status: "pending" }] },
      { todos: [{ content: "valid", status: "unknown" }] },
    ]) {
      expect(malformedPlanProjector.project("plan_update", data)).toBeNull()
    }

    const malformedIdentities = [
      [],
      { ...identity, call_id: " " },
      { ...identity, subagent: " " },
      { ...identity, route_id: " " },
      { ...identity, depth: 0 },
      { ...identity, depth: -1 },
      { ...identity, depth: 1.5 },
      { ...identity, depth: "1" },
    ]
    for (const data of malformedIdentities) {
      const projector = createDawnActivityProjector("run-subagent")
      expect(projector.project("subagent.start", data)).toBeNull()
    }
  })

  test("normalizes todo prose but preserves accepted identity strings", () => {
    const projector = createDawnActivityProjector("run-1")
    const plan = projector.project("plan_update", {
      todos: [{ content: "  Search the corpus  ", status: "pending" }],
    })
    const paddedIdentity = {
      call_id: "  call-trimmed  ",
      subagent: "  researcher  ",
      route_id: "  /research#researcher  ",
      depth: 1,
    } as const
    const start = projector.project("subagent.start", paddedIdentity)

    expect(plan?.content).toEqual({
      todos: [{ content: "Search the corpus", status: "pending" }],
    })
    expect(start?.messageId).toBe("dawn:subagent:  call-trimmed  ")
    expect(start?.content).toMatchObject({ name: "  researcher  " })
    expect(
      projector.project("subagent.plan_update", {
        call_id: "call-trimmed",
        subagent: "researcher",
        route_id: "/research#researcher",
        depth: 1,
        todos,
      }),
    ).toBeNull()
    expect(projector.project("subagent.plan_update", { ...paddedIdentity, todos })).not.toBeNull()
  })

  test("rejects malformed child plans, tool ids, tool names, and unknown results", () => {
    const projector = createDawnActivityProjector("run-1")
    projector.project("subagent.start", identity)

    expect(
      projector.project("subagent.plan_update", {
        ...identity,
        todos: [{ content: "valid", status: "invalid" }],
      }),
    ).toBeNull()
    expect(
      projector.project("subagent.tool_call", {
        ...identity,
        id: " ",
        tool: "searchCorpus",
      }),
    ).toBeNull()
    expect(
      projector.project("subagent.tool_call", {
        ...identity,
        id: "tool-1",
        tool: " ",
      }),
    ).toBeNull()
    expect(projector.project("subagent.tool_result", { ...identity, id: "unknown" })).toBeNull()
  })

  test("returns null without throwing for hostile getters and never reads ignored prose", () => {
    const throwingIdentity = Object.defineProperty({}, "call_id", {
      get() {
        throw new Error("hostile identity")
      },
    })
    const throwingTodos = Object.defineProperty({}, "todos", {
      get() {
        throw new Error("hostile todos")
      },
    })
    expect(() =>
      createDawnActivityProjector("run-1").project("subagent.start", throwingIdentity),
    ).not.toThrow()
    expect(
      createDawnActivityProjector("run-1").project("subagent.start", throwingIdentity),
    ).toBeNull()
    expect(() =>
      createDawnActivityProjector("run-1").project("plan_update", throwingTodos),
    ).not.toThrow()
    expect(createDawnActivityProjector("run-1").project("plan_update", throwingTodos)).toBeNull()

    const projector = createDawnActivityProjector("run-1")
    projector.project("subagent.start", identity)
    const hostileTool = Object.defineProperty({ ...identity, tool: "searchCorpus" }, "id", {
      get() {
        throw new Error("hostile tool id")
      },
    })
    expect(() => projector.project("subagent.tool_call", hostileTool)).not.toThrow()
    expect(projector.project("subagent.tool_call", hostileTool)).toBeNull()

    const hostileMessage = Object.defineProperty({ ...identity }, "content", {
      get() {
        throw new Error("child prose must not be read")
      },
    })
    expect(() => projector.project("subagent.message", hostileMessage)).not.toThrow()
    expect(projector.project("subagent.message", hostileMessage)).toBeNull()

    const hostileEnd = Object.defineProperty({ ...identity }, "final_message", {
      get() {
        throw new Error("final child answer must not be read")
      },
    })
    expect(() => projector.project("subagent.end", hostileEnd)).not.toThrow()
  })
})
