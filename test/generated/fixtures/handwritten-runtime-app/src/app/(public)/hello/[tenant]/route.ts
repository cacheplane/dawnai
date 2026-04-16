import { defineRoute } from "@dawn/langgraph"

export const route = defineRoute({
  kind: "graph",
  entry: "./graph.ts",
  config: {
    runtime: "node",
    tags: ["handwritten"],
  },
})
