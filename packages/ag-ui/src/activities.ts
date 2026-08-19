import { type ActivitySnapshotEvent, EventType } from "@ag-ui/core"

export const DAWN_PLAN_ACTIVITY_TYPE = "dawn.plan"
export const DAWN_SUBAGENT_ACTIVITY_TYPE = "dawn.subagent"

export interface DawnPlanActivityContent {
  readonly todos: ReadonlyArray<{
    readonly content: string
    readonly status: "pending" | "in_progress" | "completed"
  }>
}

export interface DawnSubagentActivityContent {
  readonly name: string
  readonly depth: number
  readonly status: "running" | "completed" | "failed"
  readonly todos?: DawnPlanActivityContent["todos"]
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly status: "running" | "completed" | "incomplete"
  }>
  readonly totalToolCount: number
  readonly error?: string
}

export type DawnActivityChunkType =
  | "plan_update"
  | "subagent.start"
  | "subagent.plan_update"
  | "subagent.tool_call"
  | "subagent.tool_result"
  | "subagent.message"
  | "subagent.end"

/** The two built-in orchestration tools that have canonical activities. */
export type OrchestrationToolName = "writeTodos" | "task"

/**
 * Correlation between a recognized activity and the root tool call that
 * produced it, keyed by the model/provider tool-call id (logical identity).
 * Package-private: it never reaches the wire. The suppression ledger is its
 * consumer — it decides whether the generic tool frames for that call are
 * redundant with the activity emitted here.
 */
export interface DawnActivityCorrelation {
  readonly toolCallId: string
  readonly toolName: OrchestrationToolName
}

/** An activity projection plus optional orchestration correlation. */
export interface ProjectedDawnActivity {
  readonly event: ActivitySnapshotEvent | null
  readonly orchestration?: DawnActivityCorrelation
}

export interface DawnActivityProjector {
  project(type: DawnActivityChunkType, data: unknown): ProjectedDawnActivity
}

interface SubagentIdentity {
  readonly callId: string
  readonly subagent: string
  readonly routeId: string
  readonly depth: number
}

interface InternalToolState {
  readonly id: string
  readonly name: string
  status: "running" | "completed" | "incomplete"
}

interface InternalSubagentState {
  readonly identity: SubagentIdentity
  status: "running" | "completed" | "failed"
  todos?: DawnPlanActivityContent["todos"]
  readonly seenToolIds: Set<string>
  tools: InternalToolState[]
  totalToolCount: number
  error?: string
  terminal: boolean
}

export function isDawnActivityChunkType(value: string): value is DawnActivityChunkType {
  switch (value) {
    case "plan_update":
    case "subagent.start":
    case "subagent.plan_update":
    case "subagent.tool_call":
    case "subagent.tool_result":
    case "subagent.message":
    case "subagent.end":
      return true
    default:
      return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseTodos(data: unknown): DawnPlanActivityContent["todos"] | null {
  try {
    if (!isRecord(data) || !Array.isArray(data.todos)) return null

    const parsed: Array<DawnPlanActivityContent["todos"][number]> = []
    for (const todo of data.todos) {
      if (!isRecord(todo)) return null
      const content = todo.content
      const status = todo.status
      if (typeof content !== "string" || content.trim().length === 0) return null
      if (status !== "pending" && status !== "in_progress" && status !== "completed") return null
      parsed.push({ content: content.trim(), status })
    }
    return parsed
  } catch {
    return null
  }
}

function parseSubagentIdentity(data: unknown): SubagentIdentity | null {
  try {
    if (!isRecord(data)) return null
    const callId = data.call_id
    const subagent = data.subagent
    const routeId = data.route_id
    const depth = data.depth
    if (typeof callId !== "string" || callId.trim().length === 0) return null
    if (typeof subagent !== "string" || subagent.trim().length === 0) return null
    if (typeof routeId !== "string" || routeId.trim().length === 0) return null
    if (!Number.isInteger(depth) || (depth as number) <= 0) return null
    return {
      callId,
      subagent,
      routeId,
      depth: depth as number,
    }
  } catch {
    return null
  }
}

function identitiesMatch(left: SubagentIdentity, right: SubagentIdentity): boolean {
  return (
    left.callId === right.callId &&
    left.subagent === right.subagent &&
    left.routeId === right.routeId &&
    left.depth === right.depth
  )
}

function readRawNonemptyString(data: unknown, key: string): string | null {
  try {
    if (!isRecord(data)) return null
    const value = data[key]
    return typeof value === "string" && value.trim().length > 0 ? value : null
  } catch {
    return null
  }
}

function readTrimmedNonemptyString(data: unknown, key: string): string | null {
  try {
    if (!isRecord(data)) return null
    const value = data[key]
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
  } catch {
    return null
  }
}

function parseEndError(
  data: unknown,
): { readonly valid: false } | { readonly valid: true; error?: string } {
  try {
    if (!isRecord(data)) return { valid: false }
    if (!Object.hasOwn(data, "error")) return { valid: true }
    const value = data.error
    if (typeof value !== "string") return { valid: false }
    const trimmed = value.trim()
    return trimmed.length === 0 ? { valid: true } : { valid: true, error: trimmed.slice(0, 400) }
  } catch {
    return { valid: false }
  }
}

function subagentSnapshot(state: InternalSubagentState): ActivitySnapshotEvent {
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: `dawn:subagent:${state.identity.callId}`,
    activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
    replace: true,
    content: {
      name: state.identity.subagent,
      depth: state.identity.depth,
      status: state.status,
      ...(state.todos !== undefined
        ? { todos: state.todos.map((todo) => ({ content: todo.content, status: todo.status })) }
        : {}),
      tools: state.tools.map((tool) => ({ name: tool.name, status: tool.status })),
      totalToolCount: state.totalToolCount,
      ...(state.error !== undefined ? { error: state.error } : {}),
    },
  }
}

function projectEvent(event: ActivitySnapshotEvent | null): ProjectedDawnActivity {
  return { event }
}

export function createDawnActivityProjector(runId: string): DawnActivityProjector {
  const subagents = new Map<string, InternalSubagentState>()

  return {
    project(type, data) {
      if (type === "plan_update") {
        const parsedTodos = parseTodos(data)
        if (parsedTodos === null) return projectEvent(null)
        const event: ActivitySnapshotEvent = {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: `dawn:plan:${runId}`,
          activityType: DAWN_PLAN_ACTIVITY_TYPE,
          replace: true,
          content: { todos: parsedTodos },
        }
        const toolCallId = readRawNonemptyString(data, "tool_call_id")
        return {
          event,
          ...(toolCallId !== null
            ? { orchestration: { toolCallId, toolName: "writeTodos" as const } }
            : {}),
        }
      }

      const parsedIdentity = parseSubagentIdentity(data)
      if (parsedIdentity === null) return projectEvent(null)
      const current = subagents.get(parsedIdentity.callId)

      if (type === "subagent.start") {
        if (current !== undefined) {
          return projectEvent(
            !current.terminal && identitiesMatch(current.identity, parsedIdentity)
              ? subagentSnapshot(current)
              : null,
          )
        }
        const state: InternalSubagentState = {
          identity: parsedIdentity,
          status: "running",
          seenToolIds: new Set(),
          tools: [],
          totalToolCount: 0,
          terminal: false,
        }
        subagents.set(parsedIdentity.callId, state)
        return {
          event: subagentSnapshot(state),
          orchestration: { toolCallId: parsedIdentity.callId, toolName: "task" as const },
        }
      }

      if (type === "subagent.plan_update") {
        if (
          current === undefined ||
          current.terminal ||
          !identitiesMatch(current.identity, parsedIdentity)
        ) {
          return projectEvent(null)
        }
        const parsedTodos = parseTodos(data)
        if (parsedTodos === null) return projectEvent(null)
        current.todos = parsedTodos
        return projectEvent(subagentSnapshot(current))
      }

      if (type === "subagent.tool_call") {
        if (
          current === undefined ||
          current.terminal ||
          !identitiesMatch(current.identity, parsedIdentity)
        ) {
          return projectEvent(null)
        }
        const id = readRawNonemptyString(data, "id")
        const name = readTrimmedNonemptyString(data, "tool")
        if (id === null || name === null) return projectEvent(null)

        const retainedIndex = current.tools.findIndex((tool) => tool.id === id)
        if (retainedIndex !== -1) current.tools.splice(retainedIndex, 1)
        if (!current.seenToolIds.has(id)) {
          current.seenToolIds.add(id)
          current.totalToolCount += 1
        }
        current.tools.push({ id, name, status: "running" })
        if (current.tools.length > 5) current.tools.shift()
        return projectEvent(subagentSnapshot(current))
      }

      if (type === "subagent.tool_result") {
        if (
          current === undefined ||
          current.terminal ||
          !identitiesMatch(current.identity, parsedIdentity)
        ) {
          return projectEvent(null)
        }
        const id = readRawNonemptyString(data, "id")
        if (id === null) return projectEvent(null)
        const tool = current.tools.find((candidate) => candidate.id === id)
        if (tool === undefined) return projectEvent(null)
        tool.status = "completed"
        return projectEvent(subagentSnapshot(current))
      }

      if (type === "subagent.end") {
        if (
          current === undefined ||
          current.terminal ||
          !identitiesMatch(current.identity, parsedIdentity)
        ) {
          return projectEvent(null)
        }
        const parsedError = parseEndError(data)
        if (!parsedError.valid) return projectEvent(null)
        for (const tool of current.tools) {
          if (tool.status === "running") tool.status = "incomplete"
        }
        if (parsedError.error !== undefined) {
          current.status = "failed"
          current.error = parsedError.error
        } else {
          current.status = "completed"
        }
        current.terminal = true
        return projectEvent(subagentSnapshot(current))
      }

      return projectEvent(null)
    },
  }
}
