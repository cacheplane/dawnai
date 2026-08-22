import { SECONDARY_BUTTON } from "./ui"

export interface RunErrorProps {
  /** Headline for the failure, chosen from the error's code by `AppShell`. */
  readonly title: string
  readonly message: string
  readonly onDismiss: () => void
}

/**
 * The shell's failure surface.
 *
 * `<CopilotSidebar>` used to render run errors; deleting it removed the only
 * place a failed run was visible, and a `console.error` is not a user-facing
 * state. Failures from CopilotKit core land here instead.
 *
 * Deliberately an inline row in the transcript rather than a full-page connect
 * screen: the conversation above it is still real, and a dead backend is a
 * transient condition, not a mode. (The connect screen is SP2b.)
 */
export function RunError({ title, message, onDismiss }: RunErrorProps) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-wb border border-red-500/40 bg-red-500/5 px-3.5 py-3 text-[13px]"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium tracking-tight">{title}</p>
        <p className="mt-1 break-words leading-5 text-wb-muted">{message}</p>
      </div>
      <button type="button" onClick={onDismiss} className={`${SECONDARY_BUTTON} shrink-0`}>
        Dismiss
      </button>
    </div>
  )
}
