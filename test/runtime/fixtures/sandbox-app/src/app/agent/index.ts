import { agent } from "@dawn-ai/sdk"

// No host `workspace/` directory exists in this fixture. The workspace
// capability still activates because prepareRouteExecution injects the sandbox
// handle's `workspaceRoot` (the fakeSandbox `/workspace`) — the capability's
// `detect` honors an injected workspaceRoot. So readFile/writeFile/runBash are
// offered and route into the thread's sandbox volume.
export default agent({
  model: "gpt-5-mini",
  systemPrompt: "SANDBOX_WIRING_AGENT workspace agent.",
})
