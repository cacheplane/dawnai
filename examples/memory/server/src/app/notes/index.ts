import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt:
    "You are a note-taking assistant with long-term memory. Use the remember and recall tools.",
})
