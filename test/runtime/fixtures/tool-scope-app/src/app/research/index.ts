import { agent } from "@dawn-ai/sdk"

// The `researcher` subagent is discovered by convention from
// ./subagents/researcher (mirrors examples/chat coordinator). This fixture
// needs only the convention identity and the parent's default delegation rule,
// so it does not add an explicit keyed registration.
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "Research coordinator.",
})
