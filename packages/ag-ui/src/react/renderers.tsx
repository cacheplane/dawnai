import type { ReactActivityMessageRenderer } from "@copilotkit/react-core/v2"
import {
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
  type DawnPlanActivityContent,
  type DawnSubagentActivityContent,
} from "../activities.js"
import { PlanActivityCard } from "./PlanActivityCard.js"
import { SubagentActivityCard } from "./SubagentActivityCard.js"
import {
  planActivityContentSchema,
  type SubagentActivityContentOutput,
  subagentActivityContentSchema,
} from "./schemas.js"

export const dawnPlanActivityRenderer = {
  activityType: DAWN_PLAN_ACTIVITY_TYPE,
  content: planActivityContentSchema,
  render: ({ content }) => <PlanActivityCard content={content} />,
} satisfies ReactActivityMessageRenderer<DawnPlanActivityContent>

/**
 * zod cannot express an exact optional property: it types `todos` as
 * `T | undefined`, while the public content type declares `todos?: T` and this
 * package compiles with `exactOptionalPropertyTypes`. A parse never produces
 * the key carrying an explicit `undefined`, so this drops it rather than
 * asserting the difference away.
 */
function toPublicSubagentContent(
  content: SubagentActivityContentOutput,
): DawnSubagentActivityContent {
  const { todos, ...rest } = content
  return todos === undefined ? rest : { ...rest, todos }
}

export const dawnSubagentActivityRenderer = {
  activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
  content: subagentActivityContentSchema,
  render: ({ content }) => <SubagentActivityCard content={toPublicSubagentContent(content)} />,
} satisfies ReactActivityMessageRenderer<SubagentActivityContentOutput>

/**
 * Both built-in Dawn activity renderers, ready to hand to CopilotKit:
 *
 * ```tsx
 * <CopilotKit runtimeUrl="/api/copilotkit" renderActivityMessages={dawnActivityRenderers}>
 * ```
 *
 * Dawn presents `writeTodos` and a started `task` ONLY as these activities —
 * a client that registers no renderer for them shows nothing for that work.
 */
export const dawnActivityRenderers = [dawnPlanActivityRenderer, dawnSubagentActivityRenderer]
