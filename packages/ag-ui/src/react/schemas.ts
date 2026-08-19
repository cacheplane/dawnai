import { z } from "zod"
import type { DawnPlanActivityContent, DawnSubagentActivityContent } from "../activities.js"

const todoSchema = z.strictObject({
  content: z.string().trim().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
})

export const planActivityContentSchema = z.strictObject({
  todos: z.array(todoSchema),
})

function assignPlanOutputToPublicType(
  content: z.output<typeof planActivityContentSchema>,
): DawnPlanActivityContent {
  return content
}
void assignPlanOutputToPublicType

const toolSchema = z.strictObject({
  name: z.string().trim().min(1),
  status: z.enum(["running", "completed", "incomplete"]),
})

const subagentFields = {
  name: z.string().trim().min(1),
  depth: z.number().int().positive(),
  todos: z.array(todoSchema).optional(),
  tools: z.array(toolSchema).max(5),
  totalToolCount: z.number().int().nonnegative(),
}

export const subagentActivityContentSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ ...subagentFields, status: z.literal("running") }),
    z.strictObject({ ...subagentFields, status: z.literal("completed") }),
    z.strictObject({
      ...subagentFields,
      status: z.literal("failed"),
      error: z.string().trim().min(1).max(400),
    }),
  ])
  .refine((content) => content.totalToolCount >= content.tools.length, {
    message: "totalToolCount must include every displayed tool",
    path: ["totalToolCount"],
  })

/**
 * This package compiles with `exactOptionalPropertyTypes`, under which zod's
 * `todos?: T | undefined` is not assignable to the public `todos?: T` even
 * though a parse never produces the key with an explicit `undefined`. Only that
 * one property is relaxed — every other field is still checked exactly against
 * the public type, which is the point of this probe.
 */
type SubagentContentWithOptionalTodos = Omit<DawnSubagentActivityContent, "todos"> & {
  readonly todos?: DawnSubagentActivityContent["todos"] | undefined
}

function assignSubagentOutputToPublicType(
  content: z.output<typeof subagentActivityContentSchema>,
): SubagentContentWithOptionalTodos {
  return content
}
void assignSubagentOutputToPublicType
