import "@dawn-ai/sdk/testing"

declare module "@dawn-ai/sdk/testing" {
  interface RouteScenarioMap {
    "/research": {
      readonly tools: {
        readonly "readDoc": (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>
        readonly "searchCorpus": (input: Parameters<typeof import("../src/tools/searchCorpus.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/searchCorpus.js").default>>>
      }
    }
    "/research/subagents/researcher": {
      readonly tools: {
        readonly "readDoc": (input: Parameters<typeof import("../src/tools/readDoc.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/readDoc.js").default>>>
        readonly "searchCorpus": (input: Parameters<typeof import("../src/tools/searchCorpus.js").default>[0]) => Promise<Awaited<ReturnType<typeof import("../src/tools/searchCorpus.js").default>>>
      }
    }
  }
}
