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
 * What a successful parse actually yields: `DawnSubagentActivityContent`, but
 * with `todos` widened to admit an explicit `undefined`.
 *
 * This package compiles with `exactOptionalPropertyTypes`, which distinguishes
 * an absent `todos` from a present `todos: undefined`; zod does not — a
 * `strictObject` with an `.optional()` field passes an input's own
 * `todos: undefined` key straight through, so the parsed value can carry it and
 * is genuinely wider than the published exact-optional type.
 *
 * Only that one property is relaxed. Every other field name, its value type,
 * and the presence or absence of all other properties are still checked against
 * `DawnSubagentActivityContent` by the probe below, which is what keeps this
 * zod mirror honest. Exported from the `./react` entry, since it is the
 * parameter type consumers see on `dawnSubagentActivityRenderer.render` and on
 * `SubagentActivityCard`.
 */
export type SubagentActivityContentOutput = Omit<DawnSubagentActivityContent, "todos"> & {
  readonly todos?: DawnSubagentActivityContent["todos"] | undefined
}

function assignSubagentOutputToPublicType(
  content: z.output<typeof subagentActivityContentSchema>,
): SubagentActivityContentOutput {
  return content
}
void assignSubagentOutputToPublicType
