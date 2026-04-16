import { defineRoute } from "@dawn/langgraph";

export const route = defineRoute({
  kind: "workflow",
  entry: "./workflow.ts",
  config: {
    runtime: "node",
    tags: ["hello"],
  },
});
