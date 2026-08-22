"use client"
import { useInterrupt } from "@copilotkit/react-core/v2"
import { type ReactNode, useEffect, useRef } from "react"
import { SECONDARY_BUTTON } from "./ui"

// Dawn's permission gate surfaces as an AG-UI *standard* interrupt: the run ends
// with `RUN_FINISHED{ outcome:{ type:"interrupt", interrupts:[…] } }`, and the
// client resumes via the top-level `RunAgentInput.resume` array. `useInterrupt`
// handles that path natively — `render` receives the `Interrupt` object, and
// `resolve(payload)` records `{ status:"resolved", payload }` for it (resuming
// once every open interrupt is addressed), while `cancel()` records
// `{ status:"cancelled" }`.
//
// @dawn-ai/ag-ui's `toAguiInterrupt` preserves the whole Dawn envelope under
// `interrupt.metadata`, so the command being gated is at
// `metadata.detail.command`. For a permission prompt, Dawn reads the resolved
// payload as its decision ("once" | "always").
//
// DENIAL: always `cancel()`, never `resolve("deny")`. Both reach Dawn as a
// denial — the runtime accepts a resolved "deny" payload and also maps
// `status:"cancelled"` to denial — so this is a choice, not a bug fix, and the
// two branches used to disagree about it. `cancel()` wins because it is the
// AG-UI *protocol's* way to say "the human declined", which stays correct if
// Dawn's payload vocabulary ever changes, whereas "deny" is a magic string
// this file would have to keep in sync with the server.
//
// `renderInChat: false` — NOT the default, and load-bearing. The default
// (`true`) publishes the element into `<CopilotChat>`/`<CopilotSidebar>` and
// returns `void`. This app renders its own transcript and mounts neither, so
// under the default the gate would render NOWHERE: the run parks on an
// interrupt with no approve/deny UI, no error, and green tests. With
// `renderInChat: false` the hook returns the element instead, and `Transcript`
// places it at the end of the message list — where the run stopped.
type PermissionMetadata = {
  kind?: string
  detail?: {
    command?: string
    suggestedPattern?: string
    parentRouteId?: string
    subagentName?: string
    subagentRouteId?: string
    inputPreview?: string
    reason?: string
  }
}

export interface PermissionInterruptProps {
  /**
   * Where a failed resume goes. `resolve`/`cancel` start a *run* (the resume),
   * so they reject exactly like the send path does — and being fired from an
   * onClick, an uncaught rejection would be an unhandled promise and nothing
   * on screen. Routed to the same failure surface as `runAgent`.
   */
  readonly onError: (error: unknown) => void
  /**
   * True while the resumed run is in flight. The library leaves this card's
   * buttons mounted through the resume, so without this a second click fires a
   * second resume against an interrupt that is already answered.
   */
  readonly isResuming: boolean
}

const ROW = "mt-1 text-[13px] leading-5 text-wb-muted"
const CODE = "rounded bg-wb-bg px-1 py-0.5 font-mono text-[12px] text-wb-text"

/**
 * The gate's own surface, deliberately NOT the workbench's neutral card: it is
 * the one thing in the transcript that stops the run and waits on a person, so
 * it carries an amber edge and a filled ground the rest of the app never uses.
 * (It borrows no gradient — that stays reserved for the brand mark and the send
 * button.)
 *
 * A real component rather than markup inlined in `render` so it can own an
 * effect: the card arrives at the bottom of a scrolling region, the composer
 * goes inert at the same moment, and neither event moves focus or says
 * anything. `role="alert"` announces it, and the effect puts the keyboard on
 * the first decision — otherwise a keyboard-only user is left tabbing through
 * a dead composer with no indication of why it stopped responding.
 */
function InterruptCard({
  title,
  isResuming,
  children,
  actions,
}: {
  title: string
  isResuming: boolean
  children: ReactNode
  actions: ReactNode
}) {
  const actionsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    actionsRef.current?.querySelector("button")?.focus()
  }, [])

  return (
    <div
      role="alert"
      aria-busy={isResuming}
      className="rounded-wb border border-amber-500/40 bg-amber-500/5 px-3.5 py-3 text-[13px]"
    >
      <p className="text-[13px] font-medium tracking-tight">{title}</p>
      {children}
      <div
        ref={actionsRef}
        // Inert, not disabled: `disabled` would drop focus to <body> the
        // instant the user's own click starts the resume.
        className={`mt-3 flex flex-wrap gap-2 ${isResuming ? "pointer-events-none opacity-50" : ""}`}
      >
        {actions}
      </div>
    </div>
  )
}

export function PermissionInterrupt({ onError, isResuming }: PermissionInterruptProps) {
  return useInterrupt({
    renderInChat: false,
    render: ({ interrupt, resolve, cancel }) => {
      const meta = (interrupt?.metadata ?? {}) as PermissionMetadata
      const decide = (decision: () => Promise<unknown> | unknown) => () => {
        if (isResuming) return
        Promise.resolve()
          .then(decision)
          .catch((error: unknown) => onError(error))
      }
      const deny = (
        <button
          type="button"
          className={SECONDARY_BUTTON}
          aria-disabled={isResuming}
          onClick={decide(() => cancel())}
        >
          Deny
        </button>
      )
      const allow = (payload: "once" | "always", label: string) => (
        <button
          type="button"
          className={SECONDARY_BUTTON}
          aria-disabled={isResuming}
          onClick={decide(() => resolve(payload))}
        >
          {label}
        </button>
      )

      if (meta.kind === "subagent") {
        const detail = meta.detail
        return (
          <InterruptCard
            title="Subagent approval required"
            isResuming={isResuming}
            actions={
              <>
                {allow("once", "Once")}
                {allow("always", "Always")}
                {deny}
              </>
            }
          >
            <p className={ROW}>
              Parent <code className={CODE}>{detail?.parentRouteId ?? "unknown route"}</code> wants
              to dispatch{" "}
              <code className={CODE}>{detail?.subagentName ?? "an unknown subagent"}</code>
              {detail?.subagentRouteId ? ` (${detail.subagentRouteId})` : null}.
            </p>
            <p className={ROW}>Input: {detail?.inputPreview ?? "no input preview"}</p>
            {detail?.reason ? <p className={ROW}>Reason: {detail.reason}</p> : null}
          </InterruptCard>
        )
      }

      const command = meta.detail?.command
      return (
        <InterruptCard
          title="Permission required"
          isResuming={isResuming}
          actions={
            <>
              {allow("once", "Allow once")}
              {allow("always", "Allow always")}
              {deny}
            </>
          }
        >
          <p className={ROW}>
            {interrupt?.reason ? `${interrupt.reason}: ` : ""}
            <code className={CODE}>{command ?? interrupt?.message ?? JSON.stringify(meta)}</code>
          </p>
        </InterruptCard>
      )
    },
  })
}
