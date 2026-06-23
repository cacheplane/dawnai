import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "RESEARCHER_SUBAGENT_MARKER read-only researcher.",
  tools: { allow: ["readFile"] },
})
