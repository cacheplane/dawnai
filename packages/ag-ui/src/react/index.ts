/**
 * Entry point for the `@dawn-ai/ag-ui/react` subpath.
 *
 * React and `@copilotkit/react-core` are OPTIONAL peer dependencies: importing
 * the root (`@dawn-ai/ag-ui`) or `./sse` entry never loads this module, so a
 * server-only consumer installs nothing extra.
 *
 * Three layers, from drop-in to build-your-own:
 *
 * 1. `dawnActivityRenderers` — the whole set, ready to spread into
 *    CopilotKit's `renderActivityMessages`. This is the one-line default.
 * 2. `dawnPlanActivityRenderer` / `dawnSubagentActivityRenderer` — the
 *    individual renderers, for clients that want only one of them or that mix
 *    them with their own.
 * 3. `PlanActivityCard`, `SubagentActivityCard`, `ActivityChecklist` plus the
 *    content schemas — plain React components taking `content`, and the
 *    validators behind the renderers, for clients presenting the same
 *    activities their own way (with or without CopilotKit).
 *
 * The activity type constants and content types (`DAWN_PLAN_ACTIVITY_TYPE`,
 * `DawnPlanActivityContent`, …) live on the root entry and are not re-exported
 * here.
 */
export { ActivityChecklist } from "./ActivityChecklist.js"
export { PlanActivityCard } from "./PlanActivityCard.js"
export {
  dawnActivityRenderers,
  dawnPlanActivityRenderer,
  dawnSubagentActivityRenderer,
} from "./renderers.js"
export { SubagentActivityCard } from "./SubagentActivityCard.js"
export { planActivityContentSchema, subagentActivityContentSchema } from "./schemas.js"
