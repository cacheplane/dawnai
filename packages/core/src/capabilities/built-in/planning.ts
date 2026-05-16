import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { CapabilityMarker, PromptFragment, StreamTransformer } from "../types.js"
import { type PlanTodo, parsePlanMarkdown } from "./plan-md-parser.js"

const PLAN_MD = "plan.md"
const MAX_PLAN_BYTES = 64 * 1024

export interface RuntimeTodo {
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed"
}

const TODO_STATUS = z.enum(["pending", "in_progress", "completed"])
const WRITE_TODOS_INPUT = z.object({
  todos: z.array(
    z.object({
      content: z.string().min(1),
      status: TODO_STATUS,
    }),
  ),
})

const PLANNING_PROMPT_HEADER = `# Planning

For tasks with multiple steps, maintain a plan using \`write_todos({ todos: [...] })\`.
Mark items \`in_progress\` immediately before working on them and \`completed\` when
finished. Always include the full list — \`write_todos\` is full-replace, not incremental.`

export function createPlanningMarker(): CapabilityMarker {
  return {
    name: "planning",
    detect: async (routeDir) => existsSync(join(routeDir, PLAN_MD)),
    load: async (routeDir) => {
      const seedTodos = readSeedTodos(routeDir)

      const writeTodos = {
        name: "write_todos",
        description:
          "Replace the agent's plan with the given list of todos. Pass the full list every time; this tool is not incremental.",
        schema: WRITE_TODOS_INPUT,
        run: (input: unknown) => {
          // The actual state mutation happens in the langchain runtime;
          // this run() just echoes the canonicalized input back so the
          // tool result event carries the new todos.
          const validated = validateWriteTodosInput(input)
          return { todos: validated }
        },
      }

      const promptFragment: PromptFragment = {
        placement: "after_user_prompt",
        render: (state) => {
          const todos = (state.todos as ReadonlyArray<RuntimeTodo> | undefined) ?? []
          if (todos.length === 0) {
            return `${PLANNING_PROMPT_HEADER}\n\nCurrent plan: (empty)`
          }
          const lines = todos.map((t) => `- [${t.status}] ${t.content}`).join("\n")
          return `${PLANNING_PROMPT_HEADER}\n\nCurrent plan:\n${lines}`
        },
      }

      const streamTransformer: StreamTransformer = {
        observes: "tool_result",
        transform: async function* (input) {
          if (input.toolName !== "write_todos") return
          const out = input.toolOutput as { todos?: ReadonlyArray<RuntimeTodo> } | undefined
          yield {
            event: "plan_update",
            data: { todos: out?.todos ?? [] },
          }
        },
      }

      return {
        tools: [writeTodos],
        stateFields: [
          {
            name: "todos",
            reducer: "replace",
            default: seedTodos as readonly RuntimeTodo[],
          },
        ],
        promptFragment,
        streamTransformers: [streamTransformer],
      }
    },
  }
}

function readSeedTodos(routeDir: string): RuntimeTodo[] {
  const planPath = join(routeDir, PLAN_MD)
  if (!existsSync(planPath)) return []
  const size = statSync(planPath).size
  if (size > MAX_PLAN_BYTES) return []
  let raw: string
  try {
    raw = readFileSync(planPath, "utf8")
  } catch {
    return []
  }
  const parsed: PlanTodo[] = parsePlanMarkdown(raw)
  return parsed.map((t) => ({ content: t.content, status: t.status }))
}

function validateWriteTodosInput(input: unknown): RuntimeTodo[] {
  if (!isRecord(input)) {
    throw new Error("write_todos: input must be an object with a `todos` array")
  }
  const todos = input.todos
  if (!Array.isArray(todos)) {
    throw new Error("write_todos: `todos` must be an array")
  }
  return todos.map((t, i) => {
    if (!isRecord(t)) {
      throw new Error(`write_todos: todos[${i}] must be an object`)
    }
    const content = t.content
    const status = t.status
    if (typeof content !== "string" || content.length === 0) {
      throw new Error(`write_todos: todos[${i}].content must be a non-empty string`)
    }
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new Error(
        `write_todos: todos[${i}].status must be one of pending, in_progress, completed`,
      )
    }
    return { content, status }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
