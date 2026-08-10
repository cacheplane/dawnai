import type { AgentHarnessOptions } from "../src/index.js"

const validOptions: AgentHarnessOptions = {
  appRoot: "/tmp/dawn-app",
  route: "/chat#agent",
}

const removedMode: AgentHarnessOptions = {
  appRoot: "/tmp/dawn-app",
  route: "/chat#agent",
  // @ts-expect-error createAgentHarness has no transport or process mode.
  mode: "http-inject",
}

void validOptions
void removedMode
