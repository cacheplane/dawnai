export interface RunErrorProps {
  readonly message: string
  readonly onDismiss: () => void
}

/**
 * The shell's failure surface.
 *
 * `<CopilotSidebar>` used to render run errors; deleting it removed the only
 * place a failed run was visible, and a `console.error` is not a user-facing
 * state. Every rejection from `runAgent` — an unreachable Dawn server, a 500
 * from `/api/copilotkit`, a rejected resume — lands here instead.
 *
 * Deliberately an inline row in the transcript rather than a full-page connect
 * screen: the conversation above it is still real, and a dead backend is a
 * transient condition, not a mode. (The connect screen is SP2b.)
 */
export function RunError({ message, onDismiss }: RunErrorProps) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-[var(--wb-radius)] border border-red-500/40 bg-red-500/5 px-3.5 py-3 text-[13px]"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium tracking-tight">The run failed</p>
        <p className="mt-1 break-words leading-5 text-[var(--wb-muted)]">{message}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-[calc(var(--wb-radius)-3px)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-2.5 py-1 text-[12px] font-medium transition-colors hover:border-[var(--wb-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-accent-from)]"
      >
        Dismiss
      </button>
    </div>
  )
}
