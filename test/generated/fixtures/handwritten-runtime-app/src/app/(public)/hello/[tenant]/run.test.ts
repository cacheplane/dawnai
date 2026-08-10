import { expectMeta, expectOutput, scenarios } from "@dawn-ai/sdk/testing"

export default scenarios("/hello/[tenant]")
  .scenario("handwritten in-process scenario", (s) =>
    s
      .input({
        tenant: "handwritten-tenant",
      })
      .expectPassed()
      .expectOutput({
        greeting: "Hello, handwritten-tenant!",
        tenant: "handwritten-tenant",
      })
      .expectMeta({
        executionSource: "in-process",
        mode: "graph",
        routeId: "/hello/[tenant]",
        routePath: "src/app/(public)/hello/[tenant]/index.ts",
      }),
  )
  .scenario("handwritten server scenario", (s) =>
    s
      .input({
        tenant: "handwritten-tenant",
      })
      .server("__SERVER_URL__")
      .expectPassed()
      .expectOutput({
        greeting: "Hello, handwritten-tenant!",
        tenant: "handwritten-tenant",
      })
      .expectMeta({
        executionSource: "server",
        mode: "graph",
        routeId: "/hello/[tenant]",
        routePath: "src/app/(public)/hello/[tenant]/index.ts",
      })
      .assert((result) => {
        expectMeta(result, { executionSource: "server", mode: "graph" })
        expectOutput(result, { tenant: "handwritten-tenant" })
      }),
  )
