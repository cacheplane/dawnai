import { describe, expect, test } from "vitest";

import { renderRouteTypes } from "../src/typegen/render-route-types";
import type { RouteManifest } from "../src/types";

describe("renderRouteTypes", () => {
  test("renders valid TypeScript for an empty manifest", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [],
    };

    expect(renderRouteTypes(manifest)).toMatchInlineSnapshot(`
      "declare module "dawn:routes" {
        export type DawnRoutePath = never;
      
        export interface DawnRouteParams {}
      }
      "
    `);
  });

  test("renders a dawn.generated.d.ts style declaration with path unions and route params", () => {
    const manifest: RouteManifest = {
      appRoot: "/tmp/example-app",
      routes: [
        {
          id: "/",
          pathname: "/",
          entryKind: "page",
          entryFile: "/tmp/example-app/src/app/page.tsx",
          routeDir: "/tmp/example-app/src/app",
          segments: [],
        },
        {
          id: "/[tenant]",
          pathname: "/[tenant]",
          entryKind: "graph",
          entryFile: "/tmp/example-app/src/app/[tenant]/graph.ts",
          routeDir: "/tmp/example-app/src/app/[tenant]",
          segments: [{ raw: "[tenant]", name: "tenant", kind: "dynamic" }],
        },
        {
          id: "/docs/[...path]",
          pathname: "/docs/[...path]",
          entryKind: "workflow",
          entryFile: "/tmp/example-app/src/app/docs/[...path]/workflow.ts",
          routeDir: "/tmp/example-app/src/app/docs/[...path]",
          segments: [
            { raw: "docs", kind: "static" },
            { raw: "[...path]", name: "path", kind: "catchall" },
          ],
        },
        {
          id: "/docs/[[...path]]",
          pathname: "/docs/[[...path]]",
          entryKind: "graph",
          entryFile: "/tmp/example-app/src/app/docs/[[...path]]/graph.ts",
          routeDir: "/tmp/example-app/src/app/docs/[[...path]]",
          segments: [
            { raw: "docs", kind: "static" },
            { raw: "[[...path]]", name: "path", kind: "optional-catchall" },
          ],
        },
      ],
    };

    expect(renderRouteTypes(manifest)).toMatchInlineSnapshot(`
      "declare module "dawn:routes" {
        export type DawnRoutePath = "/" | "/[tenant]" | "/docs/[...path]" | "/docs/[[...path]]";
      
        export interface DawnRouteParams {
        "/": {};
        "/[tenant]": { tenant: string };
        "/docs/[...path]": { path: string[] };
        "/docs/[[...path]]": { path?: string[] };
        }
      }
      "
    `);
  });
});
