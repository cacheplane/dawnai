import type { InterruptInfo } from "../src/index.js"

declare const interrupt: InterruptInfo

if (interrupt.kind === "subagent") {
  const parentRouteId: string = interrupt.detail.parentRouteId
  const subagentName: string = interrupt.detail.subagentName
  const subagentRouteId: string = interrupt.detail.subagentRouteId
  const inputPreview: string = interrupt.detail.inputPreview
  const suggestedPattern: string = interrupt.detail.suggestedPattern
  const reason: string | undefined = interrupt.detail.reason
  const callId: string | undefined = interrupt.callId

  void parentRouteId
  void subagentName
  void subagentRouteId
  void inputPreview
  void suggestedPattern
  void reason
  void callId
}

if (interrupt.kind === "command") {
  const command: string = interrupt.detail.command
  // @ts-expect-error command details do not expose subagent identity fields.
  interrupt.detail.parentRouteId
  void command
}

const incompleteSubagent: InterruptInfo = {
  interruptId: "perm-1",
  kind: "subagent",
  // @ts-expect-error subagent interrupt detail requires the complete delegation identity.
  detail: {
    parentRouteId: "/support",
    subagentName: "writer",
  },
}

void incompleteSubagent
