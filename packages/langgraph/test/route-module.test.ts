import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { normalizeRouteModule } from "@dawn/langgraph";
import type { GraphRouteModule, RouteModule, WorkflowRouteModule } from "@dawn/langgraph/route-module";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(packageRoot, "..", "package.json");

describe("@dawn/langgraph route-module", () => {
  test("exposes publishable exports and types on the package surface", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      readonly exports: Record<string, { readonly types: string; readonly default: string }>;
      readonly types: string;
    };

    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports["."]?.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports["."]?.default).toBe("./dist/index.js");
    expect(packageJson.exports["./route-module"]?.types).toBe("./dist/route-module.d.ts");
  });

  test("exposes types and helpers that core and template apps can consume without a second runtime", () => {
    const graph = () => "graph";
    const workflow = () => "workflow";

    const graphModule = {
      graph,
      config: {
        runtime: "node",
      },
    } satisfies GraphRouteModule<typeof graph>;

    const workflowModule = {
      workflow,
      config: {
        streaming: true,
      },
    } satisfies WorkflowRouteModule<typeof workflow>;

    const normalizedGraph = normalizeRouteModule(graphModule satisfies RouteModule<typeof graph>);
    const normalizedWorkflow = normalizeRouteModule(workflowModule satisfies RouteModule<typeof workflow>);

    expect(normalizedGraph.kind).toBe("graph");
    expect(normalizedWorkflow.kind).toBe("workflow");
  });
});
