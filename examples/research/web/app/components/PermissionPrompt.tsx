"use client"
import { type ReactNode, useEffect, useRef } from "react"
import { neutralButton } from "./ui"

/**
 * The Dawn interrupt envelope, as the workbench reads it.
 *
 * One type for BOTH sources, and that is the point of this file. A live gate
 * arrives as `Interrupt.metadata`, where `@dawn-ai/ag-ui`'s `toAguiInterrupt`
 * parks the whole envelope verbatim; a reloaded gate arrives as `value` from
 * `GET /threads/:id/pending_interrupts`, which is that same envelope before
 * anything mapped it. So the card can be written once against the envelope and
 * never learn which source it came from — `PermissionInterrupt` and
 * `HydratedInterrupts` differ only in how a decision is sent back.
 *
 * `message` is on the envelope type rather than read off `Interrupt.message`
 * for exactly that reason: `toAguiInterrupt` copies it FROM the envelope, so
 * reading the envelope is equivalent for a live gate and possible for a
 * hydrated one.
 */
export type PermissionMetadata = {
  kind?: string
  message?: string
  detail?: {
    command?: string
    toolName?: string
    argsPreview?: string
    path?: string
    operation?: string
    suggestedPattern?: string
    parentRouteId?: string
    subagentName?: string
    subagentRouteId?: string
    inputPreview?: string
    reason?: string
  }
}

export type PermissionDecision = "once" | "always" | "deny"

export interface PermissionPromptProps {
  /** The Dawn interrupt envelope — `Interrupt.metadata` live, or `value` from the endpoint. */
  readonly metadata: PermissionMetadata
  /** True while this card's decision is in flight. */
  readonly isResolving: boolean
  /**
   * What the user chose. Deliberately NOT `resolve`/`cancel`: the two sources
   * resume differently — the live one through CopilotKit's interrupt handle,
   * the hydrated one through `copilotkit.runAgent({ resume })` — so mapping a
   * decision onto the wire is the caller's job and the card stays pure.
   */
  readonly onDecide: (decision: PermissionDecision) => void
  /**
   * Whether this card takes the keyboard when it mounts. Callers pass true for
   * the first card of a group only, so a turn parked on two gates does not
   * have its second card steal focus from its first.
   */
  readonly autoFocus?: boolean
}

const ROW = "mt-1 text-[13px] leading-5 text-wb-muted"
const CODE = "rounded bg-wb-bg px-1 py-0.5 font-mono text-[12px] text-wb-text"
const BUTTON = neutralButton("sm")

/**
 * The note above a group of cards. Rendered by whichever source owns the group
 * — shared here so the two sources cannot drift into two different wordings of
 * the same fact.
 */
export function MultipleGatesNotice({ count }: { count: number }) {
  if (count <= 1) return null
  return (
    <p className="text-[13px] text-wb-muted">
      This turn stopped on {count} requests. The run continues once every one of them is answered.
    </p>
  )
}

/**
 * The gate's own surface, deliberately NOT the workbench's neutral card: it is
 * the one thing in the transcript that stops the run and waits on a person, so
 * it carries an amber edge and a filled ground the rest of the app never uses.
 * (It borrows no gradient — that stays reserved for the brand mark and the send
 * button.)
 *
 * A real component rather than markup inlined in a `render` callback so it can
 * own an effect: the card arrives at the bottom of a scrolling region, the
 * composer goes inert at the same moment, and neither event moves focus or says
 * anything. `role="alert"` announces it, and the effect puts the keyboard on
 * the first decision — otherwise a keyboard-only user is left tabbing through
 * a dead composer with no indication of why it stopped responding.
 *
 * The effect focuses ONCE PER MOUNT, guarded by a ref so a re-render (a
 * resolving state change, a parent re-render mid-run) cannot re-steal focus
 * the user has since moved. "Once per mount" is only the same thing as "once
 * per interrupt" because every caller keys its cards by `interruptId` — a new
 * gate is therefore a new mount. That is a requirement on callers, not an
 * accident: drop the key and a second gate reuses the first card's element,
 * the ref stays set, and the new decision never takes focus.
 */
function InterruptCard({
  title,
  autoFocus,
  isResolving,
  children,
  actions,
}: {
  title: string
  autoFocus: boolean
  isResolving: boolean
  children: ReactNode
  actions: ReactNode
}) {
  const actionsRef = useRef<HTMLDivElement>(null)
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!autoFocus || focusedRef.current) return
    focusedRef.current = true
    actionsRef.current?.querySelector("button")?.focus()
  }, [autoFocus])

  return (
    <div
      role="alert"
      aria-busy={isResolving}
      className="rounded-wb border border-amber-500/40 bg-amber-500/5 px-3.5 py-3 text-[13px]"
    >
      <p className="text-[13px] font-medium tracking-tight">{title}</p>
      {children}
      <div
        ref={actionsRef}
        // Inert, not disabled: `disabled` would drop focus to <body> the
        // instant the user's own click starts the resume.
        className={`mt-3 flex flex-wrap gap-2 ${isResolving ? "pointer-events-none opacity-50" : ""}`}
      >
        {actions}
      </div>
    </div>
  )
}

/**
 * What the gate is actually asking about, in one line.
 *
 * Only `kind: "command"` envelopes carry `detail.command`, and the previous
 * version of this card fell all the way through to `JSON.stringify(metadata)`
 * for every other kind — so a tool gate, the most common one this app raises,
 * rendered the raw envelope (interruptId and all) inside the `<code>` element.
 * Each branch below reads the field the corresponding `emitPermissionInterrupt`
 * branch in `packages/core/src/capabilities/permission-gate.ts` actually
 * writes. The stringify stays as the last resort for a kind added server-side
 * that this client has not learned yet: unreadable, but never blank.
 */
function subjectOf(metadata: PermissionMetadata): string {
  const detail = metadata.detail
  const path =
    detail?.path === undefined
      ? undefined
      : detail.operation === undefined
        ? detail.path
        : `${detail.operation} ${detail.path}`
  return detail?.command ?? detail?.toolName ?? path ?? metadata.message ?? JSON.stringify(metadata)
}

/**
 * One permission gate, from either source.
 *
 * The two branches match the two shapes Dawn's gate emits that this app can
 * say something useful about: a subagent dispatch (which names a parent route
 * and a child) and everything else (a command, a tool, a path).
 */
export function PermissionPrompt({
  metadata,
  isResolving,
  onDecide,
  autoFocus = true,
}: PermissionPromptProps) {
  const deny = (
    <button
      type="button"
      className={BUTTON}
      aria-disabled={isResolving}
      onClick={() => onDecide("deny")}
    >
      Deny
    </button>
  )
  const allow = (decision: "once" | "always", label: string) => (
    <button
      type="button"
      className={BUTTON}
      aria-disabled={isResolving}
      onClick={() => onDecide(decision)}
    >
      {label}
    </button>
  )

  if (metadata.kind === "subagent") {
    const detail = metadata.detail
    return (
      <InterruptCard
        title="Subagent approval required"
        autoFocus={autoFocus}
        isResolving={isResolving}
        actions={
          <>
            {allow("once", "Once")}
            {allow("always", "Always")}
            {deny}
          </>
        }
      >
        <p className={ROW}>
          Parent <code className={CODE}>{detail?.parentRouteId ?? "unknown route"}</code> wants to
          dispatch <code className={CODE}>{detail?.subagentName ?? "an unknown subagent"}</code>
          {detail?.subagentRouteId ? ` (${detail.subagentRouteId})` : null}.
        </p>
        <p className={ROW}>Input: {detail?.inputPreview ?? "no input preview"}</p>
        {detail?.reason ? <p className={ROW}>Reason: {detail.reason}</p> : null}
      </InterruptCard>
    )
  }

  return (
    <InterruptCard
      title="Permission required"
      autoFocus={autoFocus}
      isResolving={isResolving}
      actions={
        <>
          {allow("once", "Allow once")}
          {allow("always", "Allow always")}
          {deny}
        </>
      }
    >
      <p className={ROW}>
        {metadata.kind ? `${metadata.kind}: ` : ""}
        <code className={CODE}>{subjectOf(metadata)}</code>
      </p>
    </InterruptCard>
  )
}
