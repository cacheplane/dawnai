import { describe, expect, test } from "vitest";

import { defineEntry, normalizeRouteModule } from "../src/index.js";
import type { GraphRouteModule, RouteModule, WorkflowRouteModule } from "../src/index.js";

describe("@dawn/langgraph route-module", () => {
  test("exposes types and helpers that core and template apps can consume without a second runtime", () => {
    const graph = () => "graph";
    const workflow = () => "workflow";

    const graphModule = defineEntry({
      graph,
      config: {
        runtime: "node",
      },
    }) satisfies GraphRouteModule<typeof graph>;

    const workflowModule = defineEntry({
      workflow,
      config: {
        streaming: true,
      },
    }) satisfies WorkflowRouteModule<typeof workflow>;

    const normalizedGraph = normalizeRouteModule(graphModule satisfies RouteModule<typeof graph>);
    const normalizedWorkflow = normalizeRouteModule(workflowModule satisfies RouteModule<typeof workflow>);

    expect(normalizedGraph.kind).toBe("graph");
    expect(normalizedWorkflow.kind).toBe("workflow");
  });
});
