import { DevLoopAnimation } from "./DevLoopAnimation"
import { FeatureBlock } from "./FeatureBlock"

export function FeatureDevLoop() {
  return (
    <FeatureBlock
      eyebrow="Dev loop"
      heading="Edit, save, continue on the same listener."
      paragraph="Any meaningful route, tool, state, config, or middleware change restarts the child runtime. The parent listener stays up, and persisted thread/checkpoint state remains available when the fresh child is ready."
      bullets={[
        "Fresh child runtime for meaningful application changes",
        "Stable parent listener across child restarts",
        "Persisted thread state remains available",
        "Type errors surface in the terminal and in your editor",
      ]}
      link={{ href: "/docs/dev-server", label: "See dev server docs" }}
      imageSide="left"
      visual={<DevLoopAnimation />}
    />
  )
}
