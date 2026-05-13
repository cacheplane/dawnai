import { FeatureBlock } from "./FeatureBlock"
import { IntelliSenseVisual } from "./IntelliSenseVisual"

export function FeatureTypes() {
  return (
    <FeatureBlock
      eyebrow="Types"
      heading="Types that follow the data."
      paragraph="Define your agent state in one Zod schema. Dawn generates types that flow into route handlers, tool handlers, and your client code — so the editor catches an out-of-shape state mutation the moment you type it, not at 3am when the graph throws on a missing field."
      bullets={[
        "Single Zod schema → typed agent state everywhere",
        "Tool input/output types inferred and propagated",
        "Generated types refresh on save (HMR)",
        "Works with your existing tsconfig.json",
      ]}
      link={{ href: "/docs/state", label: "See type generation docs" }}
      visual={<IntelliSenseVisual />}
    />
  )
}
