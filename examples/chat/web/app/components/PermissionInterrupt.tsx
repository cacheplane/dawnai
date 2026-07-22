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
type PermissionMetadata = {
  kind?: string
  detail?: { command?: string; suggestedPattern?: string }
}

export function PermissionInterrupt() {
  useInterrupt({
    render: ({ interrupt, resolve, cancel }) => {
      const meta = (interrupt?.metadata ?? {}) as PermissionMetadata
      const command = meta.detail?.command
      return (
        <div
          style={{
            border: "1px solid #f0c000",
            background: "#fffbe6",
            borderRadius: 8,
            padding: 12,
            margin: "8px 0",
            fontSize: 13,
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>Permission required</p>
          <p style={{ margin: "4px 0", color: "#665" }}>
            {interrupt?.reason ? `${interrupt.reason}: ` : ""}
            <code>{command ?? interrupt?.message ?? JSON.stringify(meta)}</code>
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => resolve("once")}>
              Allow once
            </button>
            <button type="button" onClick={() => resolve("always")}>
              Allow always
            </button>
            <button type="button" onClick={() => cancel()}>
              Deny
            </button>
          </div>
        </div>
      )
    },
  })
  return null
}
