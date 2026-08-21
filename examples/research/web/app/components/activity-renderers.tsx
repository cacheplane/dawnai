import type { ReactActivityMessageRenderer } from "@copilotkit/react-core/v2"
import {
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
  type DawnPlanActivityContent,
} from "@dawn-ai/ag-ui"
import {
  planActivityContentSchema,
  type SubagentActivityContentOutput,
  subagentActivityContentSchema,
} from "@dawn-ai/ag-ui/react"
import { PlanCard } from "./PlanCard"
import { SubagentCard } from "./SubagentCard"

/**
 * The workbench registers its own wrappers rather than `dawnActivityRenderers`
 * so the cards are the app's to restyle — the same source a scaffolded app will
 * own. The schemas still come from the package, so validation stays identical.
 */
const planRenderer = {
  activityType: DAWN_PLAN_ACTIVITY_TYPE,
  content: planActivityContentSchema,
  render: ({ content }) => <PlanCard content={content} />,
} satisfies ReactActivityMessageRenderer<DawnPlanActivityContent>

/**
 * Typed against `SubagentActivityContentOutput` for the same reason the package
 * renderer is: zod passes an input's own `todos: undefined` through, so the
 * parsed value is wider than the exact-optional published type.
 */
const subagentRenderer = {
  activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
  content: subagentActivityContentSchema,
  render: ({ content }) => <SubagentCard content={content} />,
} satisfies ReactActivityMessageRenderer<SubagentActivityContentOutput>

export const workbenchActivityRenderers = [planRenderer, subagentRenderer]
