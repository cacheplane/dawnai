import { agent } from "@dawn-ai/sdk"
export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You are a note-taking test agent. Use remember to store facts.",
})
