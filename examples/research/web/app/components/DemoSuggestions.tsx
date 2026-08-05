"use client"
import { useConfigureSuggestions } from "@copilotkit/react-core/v2"

// Starter prompts for the empty chat. The research agent's most interesting
// behavior is model-driven — it only dispatches a subagent, hits the permission
// gate, or proposes a memory if the question steers it there — so without a nudge
// a new user is unlikely to discover any of it.
//
// `useConfigureSuggestions` takes a static list ({ title, message }); `available`
// defaults to "before-first-message", so these appear on the empty chat and go
// away once the conversation starts.
//
// Each prompt is grounded in the bundled corpus (workspace/corpus/*.md) so the
// first click actually works:
// - "agent architectures" IS in the corpus  -> plan, researcher subagent, citations
// - "quantum computing" is deliberately NOT -> forces the gated external fetch,
//   which is what makes the approve/deny flow discoverable
// - the preference prompt drives remember() -> a candidate to approve in the panel
export function DemoSuggestions() {
  useConfigureSuggestions(
    {
      suggestions: [
        {
          title: "Research a topic",
          message: "What are common agent architectures? Write a short cited report.",
        },
        {
          title: "Trigger a permission prompt",
          message:
            "The corpus has nothing on quantum computing — run the external fetch script for it with runBash.",
        },
        {
          title: "Teach it a preference",
          message: "Remember that I prefer concise, cited reports.",
        },
      ],
    },
    [],
  )
  return null
}
