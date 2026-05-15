import { agent } from "@dawn-ai/sdk"
import { HARNESS_SYSTEM_PROMPT } from "./system-prompt.js"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: HARNESS_SYSTEM_PROMPT,
})
