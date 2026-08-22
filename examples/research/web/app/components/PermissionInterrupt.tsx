"use client"
import { useInterrupt } from "@copilotkit/react-core/v2"

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
// payload as its decision ("once" | "always"); cancelling maps to denial.
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

/**
 * The gate's own surface, deliberately NOT the workbench's neutral card: it is
 * the one thing in the transcript that stops the run and waits on a person, so
 * it carries an amber edge and a filled ground the rest of the app never uses.
 * (It borrows no gradient — that stays reserved for the brand mark and the send
 * button.)
 */
const CARD =
  "rounded-[var(--wb-radius)] border border-amber-500/40 bg-amber-500/5 px-3.5 py-3 text-[13px]"
const TITLE = "text-[13px] font-medium tracking-tight"
const ROW = "mt-1 text-[13px] leading-5 text-[var(--wb-muted)]"
const CODE = "rounded bg-[var(--wb-bg)] px-1 py-0.5 font-mono text-[12px] text-[var(--wb-text)]"
const ACTIONS = "mt-3 flex flex-wrap gap-2"
const BUTTON =
  "rounded-[calc(var(--wb-radius)-3px)] border border-[var(--wb-border)] bg-[var(--wb-surface)] px-2.5 py-1 text-[12px] font-medium transition-colors hover:border-[var(--wb-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-accent-from)]"

export interface PermissionInterruptProps {
  /**
   * Where a failed resume goes. `resolve`/`cancel` start a *run* (the resume),
   * so they reject exactly like the send path does — and being fired from an
   * onClick, an uncaught rejection would be an unhandled promise and nothing
   * on screen. Routed to the same failure surface as `runAgent`.
   */
  readonly onError: (error: unknown) => void
}

export function PermissionInterrupt({ onError }: PermissionInterruptProps) {
  return useInterrupt({
    renderInChat: false,
    render: ({ interrupt, resolve, cancel }) => {
      const decide = (decision: () => Promise<unknown> | unknown) => () => {
        Promise.resolve()
          .then(decision)
          .catch((error: unknown) => onError(error))
      }
      const meta = (interrupt?.metadata ?? {}) as PermissionMetadata
      if (meta.kind === "subagent") {
        const detail = meta.detail
        return (
          <div className={CARD}>
            <p className={TITLE}>Subagent approval required</p>
            <p className={ROW}>
              Parent <code className={CODE}>{detail?.parentRouteId ?? "unknown route"}</code> wants
              to dispatch{" "}
              <code className={CODE}>{detail?.subagentName ?? "an unknown subagent"}</code>
              {detail?.subagentRouteId ? ` (${detail.subagentRouteId})` : null}.
            </p>
            <p className={ROW}>Input: {detail?.inputPreview ?? "no input preview"}</p>
            {detail?.reason ? <p className={ROW}>Reason: {detail.reason}</p> : null}
            <div className={ACTIONS}>
              <button type="button" className={BUTTON} onClick={decide(() => resolve("once"))}>
                Once
              </button>
              <button type="button" className={BUTTON} onClick={decide(() => resolve("always"))}>
                Always
              </button>
              <button type="button" className={BUTTON} onClick={decide(() => resolve("deny"))}>
                Deny
              </button>
            </div>
          </div>
        )
      }
      const command = meta.detail?.command
      return (
        <div className={CARD}>
          <p className={TITLE}>Permission required</p>
          <p className={ROW}>
            {interrupt?.reason ? `${interrupt.reason}: ` : ""}
            <code className={CODE}>{command ?? interrupt?.message ?? JSON.stringify(meta)}</code>
          </p>
          <div className={ACTIONS}>
            <button type="button" className={BUTTON} onClick={decide(() => resolve("once"))}>
              Allow once
            </button>
            <button type="button" className={BUTTON} onClick={decide(() => resolve("always"))}>
              Allow always
            </button>
            <button type="button" className={BUTTON} onClick={decide(() => cancel())}>
              Deny
            </button>
          </div>
        </div>
      )
    },
  })
}
