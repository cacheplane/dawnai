import type { PermissionRequest, SubagentDetail } from "../src/index.js"

const detail = {
  parentRouteId: "/support",
  subagentName: "researcher",
  subagentRouteId: "/support/researcher",
  inputPreview: '{"topic":"refund policy"}',
  reason: "Research the support policy",
  suggestedPattern: '["/support","researcher"]',
} satisfies SubagentDetail

const request: PermissionRequest = {
  interruptId: "interrupt-1",
  threadId: "thread-1",
  callId: "call-1",
  kind: "subagent",
  detail,
}

function readSubagentRequest(candidate: PermissionRequest): string | undefined {
  if (candidate.kind !== "subagent") return undefined
  return candidate.detail.parentRouteId
}

const missingRouteId: PermissionRequest = {
  interruptId: "interrupt-2",
  threadId: "thread-1",
  kind: "subagent",
  // @ts-expect-error subagentRouteId is required for subagent requests.
  detail: {
    parentRouteId: "/support",
    subagentName: "researcher",
    inputPreview: "{}",
    suggestedPattern: '["/support","researcher"]',
  },
}

const commandDetail: PermissionRequest = {
  interruptId: "interrupt-3",
  threadId: "thread-1",
  kind: "subagent",
  detail: {
    // @ts-expect-error command details are not valid for subagent requests.
    command: "git status",
    suggestedPattern: "git status",
  },
}

void request
void readSubagentRequest
void missingRouteId
void commandDetail
