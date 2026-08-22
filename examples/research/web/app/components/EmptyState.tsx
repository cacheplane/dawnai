"use client"
import { useSuggestions } from "@copilotkit/react-core/v2"
import { useEffect } from "react"

export interface EmptyStateProps {
  readonly onSelectSuggestion: (message: string) => void
}

/**
 * The first screen after `npm create dawn-ai-app`, so the suggestions are the
 * point of it rather than a footnote: the research agent's plan, subagent,
 * permission-gate and memory behavior are all model-driven, and a cold user
 * finds none of it from a blank input.
 *
 * `DemoSuggestions` is the registration half (`useConfigureSuggestions`); this
 * is the read half. The `reloadSuggestions()` below is NOT redundant with it.
 * The static list is only materialized when something calls `reloadSuggestions`
 * — `useConfigureSuggestions` does that once, on registration, against whatever
 * agents the runtime had synced at that moment, and `<CopilotChat>` (which this
 * app no longer mounts) is what normally re-runs it afterwards. Reloading here
 * is what makes the pills appear for the agent this chat is actually bound to,
 * whenever the transcript is empty. It is safe to repeat: the engine clears and
 * re-adds, and static suggestions never hit the model.
 */
export function EmptyState({ onSelectSuggestion }: EmptyStateProps) {
  const { suggestions, reloadSuggestions } = useSuggestions()

  useEffect(() => {
    reloadSuggestions()
  }, [reloadSuggestions])

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col justify-center px-6 py-16">
      <h1 className="wb-brand-mark text-3xl font-semibold tracking-tight">Dawn research</h1>
      <p className="mt-3 text-sm leading-6 text-wb-muted">
        A research agent that plans its work, dispatches subagents, cites a local corpus, and asks
        before it does anything you have not allowed yet.
      </p>
      {suggestions.length > 0 ? (
        <ul className="mt-8 grid gap-2">
          {suggestions.map((suggestion) => (
            <li key={suggestion.title + suggestion.message}>
              <button
                type="button"
                onClick={() => onSelectSuggestion(suggestion.message)}
                className="group block w-full rounded-wb border border-wb-border bg-wb-surface px-4 py-3 text-left transition-colors hover:border-wb-muted wb-focus"
              >
                <span className="block text-[13px] font-medium tracking-tight">
                  {suggestion.title}
                </span>
                <span className="mt-1 block text-[13px] leading-5 text-wb-muted">
                  {suggestion.message}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
