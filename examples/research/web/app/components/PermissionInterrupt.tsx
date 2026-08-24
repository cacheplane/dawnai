"use client"
import { type Interrupt, useInterrupt } from "@copilotkit/react-core/v2"
import {
  MultipleGatesNotice,
  type PermissionDecision,
  type PermissionMetadata,
  PermissionPrompt,
} from "./PermissionPrompt"

// The LIVE source of permission gates: the ones this browser watched a run
// park on. `HydratedInterrupts` is the other source — the ones the server was
// already holding when the page loaded — and both render `PermissionPrompt`.
//
// Dawn's permission gate surfaces as an AG-UI *standard* interrupt: the run ends
// with `RUN_FINISHED{ outcome:{ type:"interrupt", interrupts:[…] } }`, and the
// client resumes via the top-level `RunAgentInput.resume` array. `useInterrupt`
// handles that path natively — `render` receives the `Interrupt` objects, and
// `resolve(payload, id)` records `{ status:"resolved", payload }` for that id
// (resuming once every open interrupt is addressed), while `cancel(id)` records
// `{ status:"cancelled" }`.
//
// That hook is also why the reload case needs a SECOND source rather than a
// patch to this one: `useInterrupt`'s pending state is written only by
// `onRunFinishedEvent`/`onRunFinalized` inside its own `agent.subscribe(…)`
// effect. There is no public setter, and assigning `agent.pendingInterrupts`
// does not make it render — so an interrupt that parked before this page
// existed can never reach this component.
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
// this file would have to keep in sync with the server. `HydratedInterrupts`
// spells the same choice as `{ status: "cancelled" }` with no payload.
//
// `renderInChat: false` — NOT the default, and load-bearing. The default
// (`true`) publishes the element into `<CopilotChat>`/`<CopilotSidebar>` and
// returns `void`. This app renders its own transcript and mounts neither, so
// under the default the gate would render NOWHERE: the run parks on an
// interrupt with no approve/deny UI, no error, and green tests. With
// `renderInChat: false` the hook returns the element instead, and `Transcript`
// places it at the end of the message list — where the run stopped.

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

export function PermissionInterrupt({ onError, isResuming }: PermissionInterruptProps) {
  return useInterrupt({
    renderInChat: false,
    render: ({ interrupt, interrupts, resolve, cancel }) => {
      // A legacy (`on_interrupt`) interrupt has an empty `interrupts` array and
      // a null `interrupt`; it resumes without an id. Dawn emits standard
      // interrupts, but falling back to a single id-less card keeps that path
      // rendering something rather than nothing.
      const open: readonly (Interrupt | null)[] = interrupts.length > 0 ? interrupts : [interrupt]

      return (
        <>
          <MultipleGatesNotice count={open.length} />
          {open.map((entry, index) => {
            const id = entry?.id
            const decide = (decision: PermissionDecision) => {
              Promise.resolve()
                .then(() => (decision === "deny" ? cancel(id) : resolve(decision, id)))
                .catch((error: unknown) => onError(error))
            }
            return (
              <PermissionPrompt
                key={id ?? "legacy"}
                metadata={(entry?.metadata ?? {}) as PermissionMetadata}
                isResolving={isResuming}
                onDecide={decide}
                autoFocus={index === 0}
              />
            )
          })}
        </>
      )
    },
  })
}
