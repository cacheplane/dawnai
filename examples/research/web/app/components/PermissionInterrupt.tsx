"use client"
import { type Interrupt, useInterrupt } from "@copilotkit/react-core/v2"
import { type ReactNode, useEffect, useRef } from "react"
import { neutralButton } from "./ui"

// Dawn's permission gate surfaces as an AG-UI *standard* interrupt: the run ends
// with `RUN_FINISHED{ outcome:{ type:"interrupt", interrupts:[…] } }`, and the
// client resumes via the top-level `RunAgentInput.resume` array. `useInterrupt`
// handles that path natively — `render` receives the `Interrupt` objects, and
// `resolve(payload, id)` records `{ status:"resolved", payload }` for that id
// (resuming once every open interrupt is addressed), while `cancel(id)` records
// `{ status:"cancelled" }`.
//
// @dawn-ai/ag-ui's `toAguiInterrupt` preserves the whole Dawn envelope under
// `interrupt.metadata`, so the command being gated is at
// `metadata.detail.command`. For a permission prompt, Dawn reads the resolved
// payload as its decision ("once" | "always").
//
// EVERY open interrupt gets a card, and every decision names its `interruptId`.
// `interrupts` is an ARRAY because a turn can park on more than one at once —
// `packages/ag-ui/src/outbound.ts` accumulates `pendingInterrupts` and ships the
// whole set on RUN_FINISHED, so two gated calls in one turn arrive together.
// Rendering only `interrupts[0]` and resolving without an id is a silent hang:
// CopilotKit's interrupt state stays `{ kind: "waiting" }` until every open
// interrupt is answered, so the resume never starts — no error, no spinner, a
// composer blocked on `pendingInterrupts.length > 0` forever, and only a thread
// switch to escape.
//
// DENIAL: always `cancel(id)`, never `resolve("deny")`. Both reach Dawn as a
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
   * True while the resumed run is in flight.
   *
   * NOT a double-submit guard — the library seals its interrupt state before
   * `resolve` returns, so a second click is already ignored. This is the
   * *affordance*: the buttons stay mounted through the whole resumed run, and
   * without this they look live while doing nothing. Dimming them and setting
   * `aria-busy` says the decision was taken and the run is working on it.
   */
  readonly isResuming: boolean
}

const ROW = "mt-1 text-[13px] leading-5 text-wb-muted"
const CODE = "rounded bg-wb-bg px-1 py-0.5 font-mono text-[12px] text-wb-text"
const BUTTON = neutralButton("sm")

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
 *
 * The effect is keyed on `focusKey` (the interrupt's id) rather than `[]` so
 * that a later gate in the same thread also takes focus, not just the first of
 * a conversation. Belt and braces with the `key` on the card itself: the key
 * already forces a remount per interrupt id, and the id-comparison here keeps
 * the behavior correct — focus once per interrupt, never re-stolen — even if a
 * re-render arrives without one.
 */
function InterruptCard({
  title,
  focusKey,
  autoFocus,
  isResuming,
  children,
  actions,
}: {
  title: string
  focusKey: string
  autoFocus: boolean
  isResuming: boolean
  children: ReactNode
  actions: ReactNode
}) {
  const actionsRef = useRef<HTMLDivElement>(null)
  const focusedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!autoFocus || focusedRef.current === focusKey) return
    focusedRef.current = focusKey
    actionsRef.current?.querySelector("button")?.focus()
  }, [autoFocus, focusKey])

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
    render: ({ interrupt, interrupts, resolve, cancel }) => {
      // A legacy (`on_interrupt`) interrupt has an empty `interrupts` array and
      // a null `interrupt`; it resumes without an id. Dawn emits standard
      // interrupts, but falling back to a single id-less card keeps that path
      // rendering something rather than nothing.
      const open: readonly (Interrupt | null)[] = interrupts.length > 0 ? interrupts : [interrupt]

      const decide = (decision: () => Promise<unknown> | unknown) => () => {
        Promise.resolve()
          .then(decision)
          .catch((error: unknown) => onError(error))
      }

      return (
        <>
          {open.length > 1 ? (
            <p className="text-[13px] text-wb-muted">
              This turn stopped on {open.length} requests. The run continues once every one of them
              is answered.
            </p>
          ) : null}
          {open.map((entry, index) => {
            const meta = (entry?.metadata ?? {}) as PermissionMetadata
            const id = entry?.id
            const deny = (
              <button
                type="button"
                className={BUTTON}
                aria-disabled={isResuming}
                onClick={decide(() => cancel(id))}
              >
                Deny
              </button>
            )
            const allow = (payload: "once" | "always", label: string) => (
              <button
                type="button"
                className={BUTTON}
                aria-disabled={isResuming}
                onClick={decide(() => resolve(payload, id))}
              >
                {label}
              </button>
            )
            const shared = {
              focusKey: id ?? "legacy",
              autoFocus: index === 0,
              isResuming,
            }

            if (meta.kind === "subagent") {
              const detail = meta.detail
              return (
                <InterruptCard
                  key={shared.focusKey}
                  title="Subagent approval required"
                  {...shared}
                  actions={
                    <>
                      {allow("once", "Once")}
                      {allow("always", "Always")}
                      {deny}
                    </>
                  }
                >
                  <p className={ROW}>
                    Parent <code className={CODE}>{detail?.parentRouteId ?? "unknown route"}</code>{" "}
                    wants to dispatch{" "}
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
                key={shared.focusKey}
                title="Permission required"
                {...shared}
                actions={
                  <>
                    {allow("once", "Allow once")}
                    {allow("always", "Allow always")}
                    {deny}
                  </>
                }
              >
                <p className={ROW}>
                  {entry?.reason ? `${entry.reason}: ` : ""}
                  <code className={CODE}>{command ?? entry?.message ?? JSON.stringify(meta)}</code>
                </p>
              </InterruptCard>
            )
          })}
        </>
      )
    },
  })
}
