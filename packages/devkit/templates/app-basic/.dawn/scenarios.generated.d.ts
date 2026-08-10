import "@dawn-ai/sdk/testing"

declare module "@dawn-ai/sdk/testing" {
  interface RouteScenarioMap {
    "/hello/[tenant]": {
      readonly tools: {
        readonly "greet": (input: Parameters<typeof import("../src/app/(public)/hello/[tenant]/tools/greet.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/app/(public)/hello/[tenant]/tools/greet.js").default>>>
      }
    }
  }
}
