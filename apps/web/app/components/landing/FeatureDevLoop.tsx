import { DevLoopAnimation } from "./DevLoopAnimation"
import { FeatureBlock } from "./FeatureBlock"

export function FeatureDevLoop() {
  return (
    <FeatureBlock
      eyebrow="Dev loop"
      heading="Edit, save, continue at the same URL."
      paragraph="Any meaningful route, tool, state, config, or middleware change restarts the child runtime. The child-owned HTTP listener restarts with it, while the parent watcher/session retains the same URL. With the default SQLite stores, or another durable configured store, thread/checkpoint state remains available when the fresh child is ready."
      bullets={[
        "Fresh child runtime and listener after meaningful changes",
        "Parent watcher/session retains the same URL",
        "Durability follows the configured thread and checkpoint stores",
        "Type errors surface in the terminal and in your editor",
      ]}
      link={{ href: "/docs/dev-server", label: "See dev server docs" }}
      imageSide="left"
      visual={<DevLoopAnimation />}
    />
  )
}
