import type { ReactActivityMessageRenderer } from "@copilotkit/react-core/v2"
import {
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
  type DawnPlanActivityContent,
  type DawnSubagentActivityContent,
} from "@dawn-ai/ag-ui"
import { planActivityContentSchema, subagentActivityContentSchema } from "./ActivitySchemas"
import { PlanActivityCard } from "./PlanActivityCard"
import { SubagentActivityCard } from "./SubagentActivityCard"

export const planActivityRenderer = {
  activityType: DAWN_PLAN_ACTIVITY_TYPE,
  content: planActivityContentSchema,
  render: ({ content }) => <PlanActivityCard content={content} />,
} satisfies ReactActivityMessageRenderer<DawnPlanActivityContent>

export const subagentActivityRenderer = {
  activityType: DAWN_SUBAGENT_ACTIVITY_TYPE,
  content: subagentActivityContentSchema,
  render: ({ content }) => <SubagentActivityCard content={content} />,
} satisfies ReactActivityMessageRenderer<DawnSubagentActivityContent>

export const activityMessageRenderers = [planActivityRenderer, subagentActivityRenderer]
