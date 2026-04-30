import { expectMeta, expectOutput } from "@dawn-ai/cli/testing"

export default [
  {
    name: "handwritten in-process scenario",

    input: {
      tenant: "handwritten-tenant",
    },
    expect: {
      status: "passed",
      output: {
        greeting: "Hello, handwritten-tenant!",
        tenant: "handwritten-tenant",
      },
      meta: {
        executionSource: "in-process",
        mode: "graph",
        routeId: "/hello/[tenant]",
        routePath: "src/app/(public)/hello/[tenant]/index.ts",
      },
    },
  },
  {
    name: "handwritten server scenario",

    input: {
      tenant: "handwritten-tenant",
    },
    run: {
      url: "__SERVER_URL__",
    },
    expect: {
      status: "passed",
      output: {
        greeting: "Hello, handwritten-tenant!",
        tenant: "handwritten-tenant",
      },
      meta: {
        executionSource: "server",
        mode: "graph",
        routeId: "/hello/[tenant]",
        routePath: "src/app/(public)/hello/[tenant]/index.ts",
      },
    },
    assert(result) {
      expectMeta(result, { executionSource: "server", mode: "graph" })
      expectOutput(result, { tenant: "handwritten-tenant" })
    },
  },
]
