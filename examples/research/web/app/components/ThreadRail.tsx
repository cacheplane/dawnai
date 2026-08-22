import type { WorkbenchThread } from "../lib/thread-source"

/**
 * The conversation list.
 *
 * Pure props on purpose: no state, no `localStorage`, no CopilotKit. The rail
 * is the one piece of the shell with real branching (active vs not, titled vs
 * untitled, empty vs populated), and keeping it hook-free is what lets
 * `ThreadRail.test.tsx` render it with `renderToStaticMarkup` and assert that
 * branching directly.
 */
export interface ThreadRailProps {
  readonly threads: readonly WorkbenchThread[]
  readonly activeThreadId: string | undefined
  readonly onSelect: (threadId: string) => void
  readonly onCreate: () => void
}

/**
 * A thread has no title until its first user message is sent (see
 * `thread-source.ts`), so the rail needs a stand-in for the row the user is
 * most likely looking at: the one they just created.
 */
export const UNTITLED_THREAD_LABEL = "New conversation"

const ROW_BASE =
  "block w-full truncate rounded-[var(--wb-radius)] px-2.5 py-1.5 text-left text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-accent-from)]"

const ROW_ACTIVE = "bg-[var(--wb-surface)] font-medium text-[var(--wb-text)] shadow-xs"

const ROW_IDLE = "text-[var(--wb-muted)] hover:bg-[var(--wb-surface)] hover:text-[var(--wb-text)]"

export function ThreadRail({ threads, activeThreadId, onSelect, onCreate }: ThreadRailProps) {
  return (
    <nav aria-label="Conversations" className="flex min-h-0 flex-1 flex-col">
      <div className="px-3">
        <button
          type="button"
          onClick={onCreate}
          className="w-full rounded-[var(--wb-radius)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-3 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors hover:border-[var(--wb-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-accent-from)]"
        >
          + New conversation
        </button>
      </div>
      <p className="px-4 pt-6 pb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--wb-muted)]">
        Recent
      </p>
      {threads.length === 0 ? (
        <p className="px-4 text-[13px] text-[var(--wb-muted)]">No conversations yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
          {threads.map((thread) => {
            const label = thread.title ?? UNTITLED_THREAD_LABEL
            const isActive = thread.id === activeThreadId
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  // `aria-current` is the accessible name for "this is the one
                  // you are looking at"; the filled background is its visual
                  // half. Both, not either.
                  aria-current={isActive ? "true" : undefined}
                  title={label}
                  onClick={() => onSelect(thread.id)}
                  className={`${ROW_BASE} ${isActive ? ROW_ACTIVE : ROW_IDLE}`}
                >
                  {label}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </nav>
  )
}
