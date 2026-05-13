import { DevLoopAnimation } from "./DevLoopAnimation"
import { FeatureBlock } from "./FeatureBlock"

export function FeatureDevLoop() {
  return (
    <FeatureBlock
      eyebrow="Dev loop"
      heading="Edit, save, reload — without restarting the graph."
      paragraph="Dawn's dev server keeps your graph state across edits. Change a prompt, save, and the next conversation continues from where you left off. Tool handlers, system prompts, route files, and Zod schemas all hot-reload — only schema-incompatible state changes cost a graph restart."
      bullets={[
        "HMR for routes, tools, and prompts",
        "Graph state preserved across compatible edits",
        "Type errors surface in the terminal and in your editor",
        "First compile in ~400ms; incremental in tens of ms",
      ]}
      link={{ href: "/docs/dev-server", label: "See dev server docs" }}
      imageSide="left"
      visual={<DevLoopAnimation />}
    />
  )
}
