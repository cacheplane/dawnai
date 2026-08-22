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
 *
 * THE RULE BOTH CARDS FOLLOW — stated here once; `PlanCard.tsx` and
 * `SubagentCard.tsx` point back at it, so if the package ever ships its
 * stylesheet inside a layer, only this paragraph goes stale:
 *
 * A `classNames` entry may only set a property that `@dawn-ai/ag-ui`'s
 * stylesheet leaves unset on that same element. That sheet is plain, UNLAYERED
 * CSS, while Tailwind emits its utilities inside `@layer utilities`, and
 * unlayered rules beat layered ones regardless of specificity — so a utility
 * touching a property the package already claims on that element loses
 * silently. Confirmed in the built CSS: every `.dawn-activity*` rule sits at
 * top level, every utility inside `@layer utilities`.
 *
 * In practice that puts the card's own box out of reach from here: `background`,
 * `border`, `border-radius`, `color`, `font-size`, `margin` and `padding` are
 * all claimed on `.dawn-activity`. Radius and font-size have `--dawn-activity-*`
 * tokens instead (rung 1, applied in `app/theme.css`); padding and margin have
 * no token, so they cannot be changed at any rung short of ejecting.
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
