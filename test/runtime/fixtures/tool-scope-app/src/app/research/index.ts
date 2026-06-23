import { agent } from "@dawn-ai/sdk"

// The `researcher` subagent is discovered by convention from
// ./subagents/researcher (mirrors examples/chat coordinator). We deliberately
// do NOT also list it in `subagents: [...]` — that would collide with the
// convention discovery ("duplicate leaf name") in the subagents marker.
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "Research coordinator.",
})
