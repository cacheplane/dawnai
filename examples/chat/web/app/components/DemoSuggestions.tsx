"use client"
import { useConfigureSuggestions } from "@copilotkit/react-core/v2"

// Starter prompts for the empty chat. The permission gate in particular is only
// reachable if the user asks for a command that isn't on dawn.config.ts's
// allow-list, which is not something a first-time visitor would guess.
//
// `useConfigureSuggestions` takes a static list ({ title, message }); `available`
// defaults to "before-first-message", so these appear on the empty chat only.
export function DemoSuggestions() {
  useConfigureSuggestions(
    {
      suggestions: [
        {
          title: "Explore the workspace",
          message: "List the files in the workspace and summarize what you find.",
        },
        {
          title: "Trigger a permission prompt",
          message: "Run `node --version` with runBash.",
        },
      ],
    },
    [],
  )
  return null
}
