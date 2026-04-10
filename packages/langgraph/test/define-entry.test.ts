import { describe, expect, test } from "vitest";

import { defineEntry, normalizeRouteModule } from "@dawn/langgraph";
import type { RouteModule } from "@dawn/langgraph/route-module";

describe("@dawn/langgraph defineEntry", () => {
  test("graph.ts modules can export a native-first entry and route config", () => {
    const graph = () => "graph";
    const module = {
      graph,
      config: {
        runtime: "node",
        streaming: true,
        tags: ["support"],
      },
    } as const;

    expect(defineEntry(module)).toBe(module);
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
    const module = {
      workflow,
      config: {
        runtime: "node",
        streaming: false,
      },
    } as const;

    expect(defineEntry(module)).toBe(module);
    expect(normalizeRouteModule(module)).toEqual({
      kind: "workflow",
      entry: workflow,
      config: {
        runtime: "node",
        streaming: false,
      },
    });
  });

  test("rejects modules that provide both graph and workflow", () => {
    const graph = () => "graph";
    const workflow = () => "workflow";
    // @ts-expect-error - route modules must not expose both executable entries
    const invalidModule: RouteModule<typeof graph> = { graph, workflow };

    expect(() =>
      defineEntry({
        graph,
        workflow,
      } as never),
    ).toThrow("Route modules must define exactly one primary executable entry: graph or workflow");

    expect(() =>
      normalizeRouteModule(invalidModule as never),
    ).toThrow("Route modules must define exactly one primary executable entry: graph or workflow");
  });
});
