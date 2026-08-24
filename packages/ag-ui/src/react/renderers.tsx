import type { ReactActivityMessageRenderer } from "@copilotkit/react-core/v2"
import {
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
  type DawnPlanActivityContent,
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
 * Typed against `SubagentActivityContentOutput`, not the published
 * `DawnSubagentActivityContent`: zod passes an input's own `todos: undefined`
 * key straight through, so the parsed value is genuinely wider than the
 * exact-optional public type this package compiles against. `SubagentActivityCard`
 * branches on `content.todos !== undefined` and renders both shapes identically.
 */
export const dawnSubagentActivityRenderer = {
  activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
  content: subagentActivityContentSchema,
  render: ({ content }) => <SubagentActivityCard content={content} />,
} satisfies ReactActivityMessageRenderer<SubagentActivityContentOutput>

/**
 * Both built-in Dawn activity renderers, ready to hand to CopilotKit:
 *
 * ```tsx
 * import { CopilotKit } from "@copilotkit/react-core/v2"
 *
 * <CopilotKit
 *   runtimeUrl="/api/copilotkit"
 *   useSingleEndpoint={false}
 *   renderActivityMessages={dawnActivityRenderers}
 * >
 * ```
 *
 * Dawn presents `writeTodos` and a started `task` ONLY as these activities —
 * a client that registers no renderer for them shows nothing for that work.
 */
export const dawnActivityRenderers = [dawnPlanActivityRenderer, dawnSubagentActivityRenderer]
