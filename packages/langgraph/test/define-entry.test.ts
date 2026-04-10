import { describe, expect, test } from "vitest";

import { defineEntry, normalizeRouteModule } from "../src/index.js";

describe("@dawn/langgraph defineEntry", () => {
  test("graph.ts modules can export a native-first entry and route config", () => {
    const graph = () => "graph";
    const module = defineEntry({
      graph,
      config: {
        runtime: "node",
        streaming: true,
        tags: ["support"],
      },
    });

    expect(normalizeRouteModule(module)).toEqual({
      kind: "graph",
      entry: graph,
      config: {
        runtime: "node",
        streaming: true,
        tags: ["support"],
      },
    });
  });

  test("workflow.ts modules are accepted as alternative executable route entries", () => {
    const workflow = () => "workflow";
    const module = defineEntry({
      workflow,
      config: {
        runtime: "node",
        streaming: false,
      },
    });

    expect(normalizeRouteModule(module)).toEqual({
      kind: "workflow",
      entry: workflow,
      config: {
        runtime: "node",
        streaming: false,
      },
    });
  });
});
