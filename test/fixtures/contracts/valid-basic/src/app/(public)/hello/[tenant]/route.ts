export const route = {
  kind: "workflow",
  entry: "./workflow.ts",
  config: {
    runtime: "node",
    tags: ["hello"],
  },
} as const
