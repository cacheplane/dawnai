import { describe, expect, test } from "vitest"

import { renderToolTypes } from "../src/typegen/render-tool-types"
import type { RouteToolTypes } from "../src/types"

describe("renderToolTypes", () => {
  test("empty routeTools renders empty interface", () => {
    const result = renderToolTypes([])
    expect(result).toMatchInlineSnapshot(`
      "  export interface DawnRouteTools {}

        export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
      "
    `)
  })

  test("single route with one tool renders correctly", () => {
    const routeTools: RouteToolTypes[] = [
      {
        pathname: "/hello/[tenant]",
        tools: [
          {
            name: "greet",
            inputType: "{ readonly tenant: string; }",
            outputType: "{ greeting: string; }",
          },
        ],
      },
    ]

    const result = renderToolTypes(routeTools)
    expect(result).toMatchInlineSnapshot(`
      "  export interface DawnRouteTools {
          "/hello/[tenant]": {
            readonly greet: (input: { readonly tenant: string; }) => Promise<{ greeting: string; }>;
          };
        }

        export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
      "
    `)
  })

  test("single route with multiple tools renders all tools", () => {
    const routeTools: RouteToolTypes[] = [
      {
        pathname: "/api/users",
        tools: [
          {
            name: "getUser",
            inputType: "{ id: string }",
            outputType: "{ name: string }",
          },
          {
            name: "listUsers",
            inputType: "void",
            outputType: "{ users: string[] }",
          },
        ],
      },
    ]

    const result = renderToolTypes(routeTools)
    expect(result).toMatchInlineSnapshot(`
      "  export interface DawnRouteTools {
          "/api/users": {
            readonly getUser: (input: { id: string }) => Promise<{ name: string }>;
            readonly listUsers: () => Promise<{ users: string[] }>;
          };
        }

        export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
      "
    `)
  })

  test("void input renders as no-arg function signature", () => {
    const routeTools: RouteToolTypes[] = [
      {
        pathname: "/ping",
        tools: [
          {
            name: "ping",
            inputType: "void",
            outputType: "{ pong: boolean }",
          },
        ],
      },
    ]

    const result = renderToolTypes(routeTools)
    expect(result).toMatchInlineSnapshot(`
      "  export interface DawnRouteTools {
          "/ping": {
            readonly ping: () => Promise<{ pong: boolean }>;
          };
        }

        export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
      "
    `)
  })

  test("routes with zero tools are skipped", () => {
    const routeTools: RouteToolTypes[] = [
      {
        pathname: "/no-tools",
        tools: [],
      },
      {
        pathname: "/has-tools",
        tools: [
          {
            name: "doThing",
            inputType: "{ x: number }",
            outputType: "{ result: number }",
          },
        ],
      },
    ]

    const result = renderToolTypes(routeTools)
    expect(result).toMatchInlineSnapshot(`
      "  export interface DawnRouteTools {
          "/has-tools": {
            readonly doThing: (input: { x: number }) => Promise<{ result: number }>;
          };
        }

        export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
      "
    `)
  })

  test("multiple routes each with tools render all routes", () => {
    const routeTools: RouteToolTypes[] = [
      {
        pathname: "/route-a",
        tools: [
          {
            name: "toolA",
            inputType: "string",
            outputType: "number",
          },
        ],
      },
      {
        pathname: "/route-b",
        tools: [
          {
            name: "toolB",
            inputType: "void",
            outputType: "boolean",
          },
        ],
      },
    ]

    const result = renderToolTypes(routeTools)
    expect(result).toMatchInlineSnapshot(`
      "  export interface DawnRouteTools {
          "/route-a": {
            readonly toolA: (input: string) => Promise<number>;
          };
          "/route-b": {
            readonly toolB: () => Promise<boolean>;
          };
        }

        export type RouteTools<P extends DawnRoutePath> = DawnRouteTools[P];
      "
    `)
  })
})
