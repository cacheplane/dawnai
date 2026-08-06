import { agent } from "@dawn-ai/sdk"

// Fixture for subagents-static.test.ts: a real, importable route entry whose
// default export carries a description. Used to prove the static path never
// imports it — if the import fired, THIS description would surface.
export default agent({
  description: "Imported description that must never surface on the static path.",
  model: "gpt-5-mini",
  systemPrompt: "You are a fixture.",
})
