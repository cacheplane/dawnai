import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"
import { executeRouteServer } from "../src/lib/runtime/execute-route-server.js"

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe("dawn run", () => {
  test("executes the route directory's index.ts and exposes shared and route-local tools through ctx.tools", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/tools/greet.ts": `export default {
  name: "greet",
  run: async (input: { tenant: string }) => ({ scope: "shared", message: \`Hello, \${input.tenant}!\` }),
};
`,
      "src/app/hello/[tenant]/index.ts": `import type { RuntimeContext } from "@dawn/sdk"
export const workflow = async (
  state: { tenant: string },
  ctx: RuntimeContext,
) => ({
  hasSignal: ctx.signal instanceof AbortSignal,
  shared: await ctx.tools.greet({ tenant: state.tenant }),
  tenant: state.tenant,
  tenantGreeting: await ctx.tools["tenant-greet"]({ tenant: state.tenant }),
});
`,
      "src/app/hello/[tenant]/tools/tenant-greet.ts": `export default {
  name: "tenant-greet",
  run: async (input: { tenant: string }) => ({ scope: "route-local", message: \`Tenant hello, \${input.tenant}!\` }),
};
`,
    })

    const result = await invoke(["run", "src/app/hello/[tenant]", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "authoring-tenant" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      mode: "workflow",
      output: {
        hasSignal: true,
        shared: {
          message: "Hello, authoring-tenant!",
          scope: "shared",
        },
        tenant: "authoring-tenant",
        tenantGreeting: {
          message: "Tenant hello, authoring-tenant!",
          scope: "route-local",
        },
      },
      routeId: "/hello/[tenant]",
      routePath: "src/app/hello/[tenant]/index.ts",
      status: "passed",
    })
  })

  test("executes the route's index.ts when targeted directly", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const workflow = async (state: { tenant: string }) => ({ tenant: state.tenant, source: "direct-index" });\n`,
    })

    const result = await invoke(["run", "src/app/support/[tenant]/index.ts", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "direct-tenant" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      mode: "workflow",
      output: {
        source: "direct-index",
        tenant: "direct-tenant",
      },
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      status: "passed",
    })
  })

  test("prefers route-local tools over shared tools with the same name", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/tools/greet.ts": `export default {
  name: "greet",
  run: async () => ({ scope: "shared" }),
};
`,
      "src/app/hello/[tenant]/index.ts": `import type { RuntimeContext } from "@dawn/sdk"
export const workflow = async (
  _state: unknown,
  ctx: RuntimeContext,
) => {
  return await ctx.tools.greet({})
};
`,
      "src/app/hello/[tenant]/tools/greet.ts": `export default {
  name: "greet",
  run: async () => ({ scope: "route-local" }),
};
`,
    })

    const result = await invoke(["run", "src/app/hello/[tenant]", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "shadowed" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      mode: "workflow",
      output: {
        scope: "route-local",
      },
      routeId: "/hello/[tenant]",
      routePath: "src/app/hello/[tenant]/index.ts",
      status: "passed",
    })
  })

  test("executes a graph route when graph is exported as a function", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async (state: { tenant: string }) => ({ tenant: state.tenant, greeting: \`Hello, \${state.tenant}!\` });\n`,
    })

    const result = await invoke(["run", "src/app/support/[tenant]", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "graph-fn-tenant" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      mode: "graph",
      output: {
        greeting: "Hello, graph-fn-tenant!",
        tenant: "graph-fn-tenant",
      },
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      status: "passed",
    })
  })

  test("executes a graph route exposed as an object with .invoke", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const graph = {
  invoke: async (state: { tenant: string }) => ({ tenant: state.tenant, source: "graph-object" }),
}
`,
    })

    const result = await invoke(["run", "src/app/support/[tenant]", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "graph-object-tenant" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      mode: "graph",
      output: {
        source: "graph-object",
        tenant: "graph-object-tenant",
      },
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      status: "passed",
    })
  })

  test("fails when an index.ts exports both workflow and graph", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const workflow = async () => ({ ok: true })
export const graph = async () => ({ ok: true })
`,
    })

    const result = await invoke(["run", "src/app/support/[tenant]", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "ambiguous" }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      error: {
        kind: "unsupported_route_boundary",
        message: expect.stringContaining(`must export exactly one of "workflow", "graph", or "chain"`),
      },
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      status: "failed",
    })
  })

  test("rejects targeting a non-index.ts file inside a route directory", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": "export const workflow = async () => ({ ok: true });\n",
      "src/app/support/[tenant]/workflow.ts":
        "export const workflow = async () => ({ stale: true });\n",
    })
    const legacyTarget = join(appRoot, "src/app/support/[tenant]/workflow.ts")

    const result = await invoke(["run", "src/app/support/[tenant]/workflow.ts", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "stale" }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      error: {
        kind: "route_resolution_error",
        message: `Route target must be a route directory or its index.ts: ${legacyTarget}`,
      },
      status: "failed",
    })
  })

  test("rejects targeting a route directory that has no index.ts", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/page.tsx": "export default function Page() { return null; }\n",
      "src/app/empty/notes.md": "# placeholder\n",
    })
    const emptyDir = join(appRoot, "src/app/empty")

    const result = await invoke(["run", "src/app/empty", "--cwd", appRoot], {
      stdin: JSON.stringify({}),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      error: {
        kind: "route_resolution_error",
        message: `Route directory has no index.ts: ${emptyDir}`,
      },
      status: "failed",
    })
  })

  test("resolves dot-relative route paths from the caller working directory", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async (state: { tenant: string }) => ({ tenant: state.tenant, greeting: \`Hello, \${state.tenant}!\` });\n`,
    })
    const routeDir = join(appRoot, "src/app/support/[tenant]")

    const result = await invoke(["run", "./"], {
      cwd: routeDir,
      stdin: JSON.stringify({ tenant: "relative-tenant" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect({
      ...payload,
      appRoot: normalizePrivatePath(String(payload.appRoot)),
    }).toMatchObject({
      appRoot: normalizePrivatePath(appRoot),
      executionSource: "in-process",
      mode: "graph",
      output: {
        greeting: "Hello, relative-tenant!",
        tenant: "relative-tenant",
      },
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      status: "passed",
    })
  })

  test("normalizes route identity from a configured custom appDir", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": 'const appDir = "src/custom-app";\nexport default { appDir };\n',
      "src/custom-app/docs/index.ts": `export const workflow = async (state: { tenant: string }) => ({ tenant: state.tenant, greeting: \`Hello, \${state.tenant}!\` });\n`,
    })

    const result = await invoke(["run", "src/custom-app/docs", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "custom-app-dir" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      mode: "workflow",
      output: {
        greeting: "Hello, custom-app-dir!",
        tenant: "custom-app-dir",
      },
      routeId: "/docs",
      routePath: "src/custom-app/docs/index.ts",
      status: "passed",
    })
  })

  test("normalizes grouped route directories to canonical route ids", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/(public)/hello/[tenant]/index.ts": `export const graph = async (state: { tenant: string }) => ({ tenant: state.tenant, greeting: \`Hello, \${state.tenant}!\` });\n`,
    })

    const result = await invoke(["run", "src/app/(public)/hello/[tenant]", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "grouped-route" }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      mode: "graph",
      output: {
        greeting: "Hello, grouped-route!",
        tenant: "grouped-route",
      },
      routeId: "/hello/[tenant]",
      routePath: "src/app/(public)/hello/[tenant]/index.ts",
      status: "passed",
    })
  })

  test("returns a modeled app discovery failure as JSON with exit 1", async () => {
    const outsideAppRoot = await mkdtemp(join(tmpdir(), "dawn-cli-run-outside-"))
    tempDirs.push(outsideAppRoot)

    const result = await invoke(["run", "src/app/support/[tenant]"], {
      cwd: outsideAppRoot,
      stdin: JSON.stringify({ tenant: "missing-app" }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as {
      readonly appRoot: string | null
      readonly error: {
        readonly kind: string
        readonly message: string
      }
      readonly executionSource?: unknown
      readonly mode: string | null
      readonly routePath: string
      readonly status: string
    }

    expectTiming(payload as unknown as Record<string, unknown>)
    expect({
      ...payload,
      error: {
        ...payload.error,
        message: normalizePrivatePath(payload.error.message),
      },
    }).toMatchObject({
      appRoot: null,
      executionSource: "in-process",
      error: {
        kind: "app_discovery_error",
        message: `Could not find dawn.config.ts from ${normalizePrivatePath(outsideAppRoot)}`,
      },
      mode: null,
      routePath: "src/app/support/[tenant]",
      status: "failed",
    })
  })

  test("returns a route resolution failure as JSON when the target does not exist", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/page.tsx": "export default {};\n",
    })
    const missingTarget = join(appRoot, "src/app/support/[tenant]")

    const result = await invoke(["run", "src/app/support/[tenant]", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "missing-route" }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      error: {
        kind: "route_resolution_error",
        message: `Route target does not exist: ${missingTarget}`,
      },
      status: "failed",
    })
  })

  test("returns modeled execution failures as JSON with exit 1", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async (state: { tenant: string }) => { throw new Error(\`Graph exploded for \${state.tenant}\`); };\n`,
    })

    const result = await invoke(["run", "src/app/support/[tenant]", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "boom" }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "in-process",
      error: {
        kind: "execution_error",
        message: "Graph exploded for boom",
      },
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      status: "failed",
    })
  })

  test("uses stderr-only exit 2 failures for malformed JSON input", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts":
        "export const graph = async (state: { tenant: string }) => ({ tenant: state.tenant });\n",
    })

    const result = await invoke(["run", "src/app/support/[tenant]", "--cwd", appRoot], {
      stdin: "{not-json",
    })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Failed to read JSON from stdin")
  })

  test("executes a route over --url and returns the same normalized shape as in-process", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async (state: { tenant: string }) => ({ tenant: state.tenant, greeting: \`Hello, \${state.tenant}!\` });\n`,
    })
    const server = await startFakeAgentServer(async () => ({
      body: {
        greeting: "Hello, server-tenant!",
        tenant: "server-tenant",
      },
      statusCode: 200,
    }))

    const inProcessResult = await invoke(["run", "src/app/support/[tenant]", "--cwd", appRoot], {
      stdin: JSON.stringify({ tenant: "server-tenant" }),
    })
    const serverResult = await invoke(
      ["run", "src/app/support/[tenant]", "--cwd", appRoot, "--url", server.url],
      {
        stdin: JSON.stringify({ tenant: "server-tenant" }),
      },
    )

    expect(inProcessResult.exitCode).toBe(0)
    expect(serverResult.exitCode).toBe(0)
    const inProcessPayload = JSON.parse(inProcessResult.stdout) as Record<string, unknown>
    const serverPayload = JSON.parse(serverResult.stdout) as Record<string, unknown>

    expectTiming(serverPayload)
    expect(omitExecutionMetadata(serverPayload)).toEqual({
      ...omitExecutionMetadata(inProcessPayload),
      executionSource: "server",
    })
  })

  test("marks --url executions with executionSource server", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const workflow = async (state: { tenant: string }) => ({ tenant: state.tenant, greeting: \`Hello, \${state.tenant}!\` });\n`,
    })
    const server = await startFakeAgentServer(async () => ({
      body: {
        greeting: "Hello, workflow-server!",
        tenant: "workflow-server",
      },
      statusCode: 200,
    }))

    const result = await invoke(
      ["run", "src/app/support/[tenant]", "--cwd", appRoot, "--url", server.url],
      {
        stdin: JSON.stringify({ tenant: "workflow-server" }),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload.executionSource).toBe("server")
  })

  test("sends a mode-qualified assistant_id to /runs/wait", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const workflow = async (state: { tenant: string }) => ({ tenant: state.tenant });\n`,
    })
    let receivedRequest: Record<string, unknown> | null = null
    const server = await startFakeAgentServer(async ({ jsonBody }) => {
      receivedRequest = jsonBody
      return {
        body: { tenant: "assistant-id" },
        statusCode: 200,
      }
    })

    const result = await invoke(
      ["run", "src/app/support/[tenant]", "--cwd", appRoot, "--url", server.url],
      {
        stdin: JSON.stringify({ tenant: "assistant-id" }),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(receivedRequest).toMatchObject({
      assistant_id: "/support/[tenant]#workflow",
      input: {
        tenant: "assistant-id",
      },
      metadata: {
        dawn: {
          mode: "workflow",
          route_id: "/support/[tenant]",
          route_path: "src/app/support/[tenant]/index.ts",
        },
      },
      on_completion: "delete",
    })
  })

  test("preserves base path prefixes when targeting a running server", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async (state: { tenant: string }) => ({ tenant: state.tenant, greeting: \`Hello, \${state.tenant}!\` });\n`,
    })
    let receivedRequestPath: string | null = null
    const server = await startFakeAgentServer(async ({ request }) => {
      receivedRequestPath = request.url ?? null
      return {
        body: {
          greeting: "Hello, prefixed-server!",
          tenant: "prefixed-server",
        },
        statusCode: 200,
      }
    }, "/api/runs/wait")

    const result = await invoke(
      [
        "run",
        "src/app/support/[tenant]",
        "--cwd",
        appRoot,
        "--url",
        new URL("/api", server.url).toString(),
      ],
      {
        stdin: JSON.stringify({ tenant: "prefixed-server" }),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(receivedRequestPath).toBe("/api/runs/wait")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "server",
      mode: "graph",
      output: {
        greeting: "Hello, prefixed-server!",
        tenant: "prefixed-server",
      },
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      status: "passed",
    })
  })

  test("times out stalled server transport with a bounded failure", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
    })
    const server = await startHangingAgentServer("/runs/wait")

    const result = await executeRouteServer({
      appRoot,
      baseUrl: server.url,
      input: { tenant: "slow-server" },
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      timeoutMs: 25,
    })

    expect(result.status).toBe("failed")
    if (result.status !== "failed") {
      throw new Error("Expected the stalled server transport to fail")
    }

    expect(result.executionSource).toBe("server")
    expect(result.error).toMatchObject({
      kind: "server_transport_error",
      message: "Server transport timed out after 25ms waiting for /runs/wait",
    })
    expect(result.diagnostics).toMatchObject({
      timeoutMs: 25,
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("normalizes non-200 server responses to server_transport_error", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async (state: { tenant: string }) => ({ tenant: state.tenant });\n`,
    })
    const server = await startFakeAgentServer(async () => ({
      body: {
        error: "Missing /runs/wait assistant",
      },
      statusCode: 503,
    }))

    const result = await invoke(
      ["run", "src/app/support/[tenant]", "--cwd", appRoot, "--url", server.url],
      {
        stdin: JSON.stringify({ tenant: "transport-error" }),
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "server",
      error: {
        kind: "server_transport_error",
      },
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      status: "failed",
    })
    expect((payload.error as Record<string, unknown>).message).toContain("503")
    expect(payload.diagnostics).toBeUndefined()
  })

  test("normalizes malformed server payloads to transport errors", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async (state: { tenant: string }) => ({ tenant: state.tenant });\n`,
    })
    const server = await startFakeAgentServer(async () => ({
      body: undefined,
      rawBody: "{not-json",
      statusCode: 200,
    }))

    const result = await invoke(
      ["run", "src/app/support/[tenant]", "--cwd", appRoot, "--url", server.url],
      {
        stdin: JSON.stringify({ tenant: "bad-payload" }),
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "server",
      error: {
        kind: "server_transport_error",
      },
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      status: "failed",
    })
    expect(payload.diagnostics).toBeUndefined()
  })

  test("treats non-200 request failures as transport failures", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ tenant: "ok" });\n`,
    })
    const server = await startFakeAgentServer(async () => ({
      body: {
        error: {
          kind: "request_error",
          message: "Request metadata does not match the registered route",
        },
      },
      statusCode: 400,
    }))

    const result = await invoke(
      ["run", "src/app/support/[tenant]", "--cwd", appRoot, "--url", server.url],
      {
        stdin: JSON.stringify({ tenant: "request-failure" }),
      },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout) as Record<string, unknown>

    expectTiming(payload)
    expect(payload).toMatchObject({
      appRoot,
      executionSource: "server",
      error: {
        kind: "server_transport_error",
      },
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
      status: "failed",
    })
  })
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-run-"))
  tempDirs.push(appRoot)

  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )

  return appRoot
}

async function invoke(
  argv: readonly string[],
  options: {
    readonly cwd?: string
    readonly stdin: string
  },
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const previousCwd = process.cwd()

  if (options.cwd) {
    process.chdir(options.cwd)
  }

  try {
    const exitCode = await run([...argv], {
      stderr: (message: string) => {
        stderr.push(message)
      },
      stdin: async () => options.stdin,
      stdout: (message: string) => {
        stdout.push(message)
      },
    })

    return {
      exitCode,
      stderr: stderr.join(""),
      stdout: stdout.join(""),
    }
  } finally {
    process.chdir(previousCwd)
  }
}

function normalizePrivatePath(path: string): string {
  return path.replaceAll("/private/var/", "/var/")
}

function expectTiming(payload: Record<string, unknown>): void {
  expect(payload.startedAt).toEqual(expect.any(String))
  expect(payload.finishedAt).toEqual(expect.any(String))
  expect(payload.durationMs).toEqual(expect.any(Number))
}

function omitExecutionMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const {
    durationMs: _durationMs,
    finishedAt: _finishedAt,
    startedAt: _startedAt,
    ...rest
  } = payload

  return rest
}

async function startFakeAgentServer(
  handler: (request: {
    readonly jsonBody: Record<string, unknown>
    readonly request: IncomingMessage
  }) => Promise<{
    readonly body?: unknown
    readonly rawBody?: string
    readonly statusCode: number
  }>,
  requestPath = "/runs/wait",
): Promise<{ readonly close: () => Promise<void>; readonly url: string }> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== requestPath) {
      response.statusCode = 404
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: "not found" }))
      return
    }

    const rawBody = await readRequestBody(request)
    const jsonBody = JSON.parse(rawBody) as Record<string, unknown>
    const result = await handler({ jsonBody, request })

    response.statusCode = result.statusCode
    response.setHeader("content-type", "application/json")
    response.end(result.rawBody ?? JSON.stringify(result.body))
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()

  if (!address || typeof address === "string") {
    throw new Error("Fake server did not bind to a TCP address")
  }

  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  const fixture = {
    close,
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
  }
  servers.push(fixture)
  return fixture
}

async function startHangingAgentServer(
  requestPath = "/runs/wait",
): Promise<{ readonly close: () => Promise<void>; readonly url: string }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== requestPath) {
      response.statusCode = 404
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: "not found" }))
      return
    }

    request.resume()
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()

  if (!address || typeof address === "string") {
    throw new Error("Fake server did not bind to a TCP address")
  }

  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  const fixture = {
    close,
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
  }
  servers.push(fixture)
  return fixture
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }

  return Buffer.concat(chunks).toString("utf8")
}
