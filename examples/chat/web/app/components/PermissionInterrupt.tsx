"use client"
import { useInterrupt } from "@copilotkit/react-core/v2"

type InterruptValue = { interruptId?: string; kind?: string; detail?: unknown }

// Dawn emits CUSTOM{ name:"on_interrupt", value } (see @dawn-ai/ag-ui's
// translate.ts) — v2's useInterrupt treats this as a "legacy" interrupt (as
// opposed to the AG-UI-standard RUN_FINISHED{outcome:{type:"interrupt"}}
// flow). For legacy interrupts, `resolve(payload)` forwards `payload`
// *directly* as `forwardedProps.command.resume` (verified against the
// installed @copilotkit/react-core compiled source, src/v2/hooks/use-interrupt.tsx) —
// there is no `{status, payload}` envelope on the wire for this path, so
// `{ decision, interruptId? }` — the exact shape @dawn-ai/ag-ui's
// `mapRunInput` decodes — reaches Dawn unmodified.
//
// `agentId` must match the runtime's registered agent name ("chat");
// useInterrupt has no ambient default tied to the provider.
export function PermissionInterrupt() {
  useInterrupt({
    agentId: "chat",
    render: ({ event, resolve }: { event: { value?: InterruptValue }; resolve: (r: unknown) => void }) => {
      const value = event?.value ?? {}
      const interruptId = value.interruptId
      const decide = (decision: "once" | "always" | "deny") =>
        resolve(interruptId ? { decision, interruptId } : { decision })
      return (
        <div style={{ border: "1px solid #f0c000", background: "#fffbe6", borderRadius: 8, padding: 12, margin: "8px 0" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Permission required</p>
          <p style={{ margin: "4px 0", fontSize: 13, color: "#665" }}>
            {value.kind ? `${value.kind}: ` : ""}
            <code>{typeof value.detail === "string" ? value.detail : JSON.stringify(value.detail ?? {})}</code>
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => decide("once")}>Allow once</button>
            <button type="button" onClick={() => decide("always")}>Allow always</button>
            <button type="button" onClick={() => decide("deny")}>Deny</button>
          </div>
        </div>
      )
    },
  })
  return null
}
