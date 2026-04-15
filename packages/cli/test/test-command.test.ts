import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  await Promise.all(servers.splice(0).map((server) => server.close()))
  delete (globalThis as Record<string, unknown>).__dawnAssertCalls
})

describe("dawn test", () => {
  test("executes route.ts-bound workflow scenarios through the new lane", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/tools/greet.ts": `export default {
  name: "greet",
  run: async (input: { tenant: string }) => ({ scope: "shared", tenant: input.tenant }),
};
`,
      "src/app/hello/[tenant]/route.ts":
        'export const route = { kind: "workflow", entry: "./workflow.ts" };\n',
      "src/app/hello/[tenant]/workflow.ts": `export const workflow = async (
  input: { tenant: string },
  context: { tools: Record<string, (input: unknown) => Promise<unknown>> },
) => ({
  shared: await context.tools.greet({ tenant: input.tenant }),
  tenantGreeting: await context.tools["tenant-greet"]({ tenant: input.tenant }),
});
`,
      "src/app/hello/[tenant]/tools/tenant-greet.ts": `export default {
  name: "tenant-greet",
  run: async (input: { tenant: string }) => ({ scope: "route-local", tenant: input.tenant }),
};
`,
      "src/app/hello/[tenant]/run.test.ts": scenarioModule([
        {
          expect: {
            meta: {
              executionSource: "in-process",
              mode: "workflow",
              routeId: "/hello/[tenant]",
              routePath: "src/app/hello/[tenant]/workflow.ts",
            },
            output: {
              shared: {
                scope: "shared",
                tenant: "scenario-tenant",
              },
              tenantGreeting: {
                scope: "route-local",
                tenant: "scenario-tenant",
              },
            },
            status: "passed",
          },
          input: {
            tenant: "scenario-tenant",
          },
          name: "authoring workflow scenario passes",
          target: "./workflow.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS authoring workflow scenario passes")
    expect(result.stdout).toContain("Summary: 1 passed, 0 failed")
  })

  test("discovers all run.test.ts files under the configured routes root", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/alpha/graph.ts": "export const graph = async () => ({ route: 'alpha' });\n",
      "src/app/alpha/run.test.ts": scenarioModule([
        {
          expect: {
            output: {
              route: "alpha",
            },
            status: "passed",
          },
          input: {},
          name: "alpha graph passes",
          target: "./graph.ts",
        },
      ]),
      "src/app/beta/workflow.ts": "export const workflow = async () => ({ route: 'beta' });\n",
      "src/app/beta/run.test.ts": scenarioModule([
        {
          expect: {
            output: {
              route: "beta",
            },
            status: "passed",
          },
          input: {},
          name: "beta workflow passes",
          target: "./workflow.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS alpha graph passes")
    expect(result.stdout).toContain("PASS beta workflow passes")
    expect(result.stdout).toContain("Summary: 2 passed, 0 failed")
  })

  test("narrows to one scenario file", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/alpha/graph.ts": "export const graph = async () => ({ route: 'alpha' });\n",
      "src/app/alpha/run.test.ts": scenarioModule([
        {
          expect: { output: { route: "alpha" }, status: "passed" },
          input: {},
          name: "alpha graph passes",
          target: "./graph.ts",
        },
      ]),
      "src/app/beta/workflow.ts": "export const workflow = async () => ({ route: 'beta' });\n",
      "src/app/beta/run.test.ts": scenarioModule([
        {
          expect: { output: { route: "beta" }, status: "passed" },
          input: {},
          name: "beta workflow passes",
          target: "./workflow.ts",
        },
      ]),
    })

    const result = await invoke(["test", "src/app/beta/run.test.ts", "--cwd", appRoot], {
      cwd: appRoot,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("alpha graph passes")
    expect(result.stdout).toContain("PASS beta workflow passes")
    expect(result.stdout).toContain("Summary: 1 passed, 0 failed")
  })

  test("narrows to one route directory including descendants", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/docs/graph.ts": "export const graph = async () => ({ section: 'docs' });\n",
      "src/app/docs/run.test.ts": scenarioModule([
        {
          expect: { output: { section: "docs" }, status: "passed" },
          input: {},
          name: "docs graph passes",
          target: "./graph.ts",
        },
      ]),
      "src/app/docs/guides/workflow.ts":
        "export const workflow = async () => ({ section: 'guides' });\n",
      "src/app/docs/guides/run.test.ts": scenarioModule([
        {
          expect: { output: { section: "guides" }, status: "passed" },
          input: {},
          name: "guides workflow passes",
          target: "./workflow.ts",
        },
      ]),
      "src/app/marketing/graph.ts":
        "export const graph = async () => ({ section: 'marketing' });\n",
      "src/app/marketing/run.test.ts": scenarioModule([
        {
          expect: { output: { section: "marketing" }, status: "passed" },
          input: {},
          name: "marketing graph passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "src/app/docs", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS docs graph passes")
    expect(result.stdout).toContain("PASS guides workflow passes")
    expect(result.stdout).not.toContain("marketing graph passes")
  })

  test("supports caller-cwd-relative narrowing", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/docs/graph.ts": "export const graph = async () => ({ section: 'docs' });\n",
      "src/app/docs/run.test.ts": scenarioModule([
        {
          expect: { output: { section: "docs" }, status: "passed" },
          input: {},
          name: "docs graph passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "./docs"], {
      cwd: join(appRoot, "src/app"),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS docs graph passes")
  })

  test("supports app-root-relative narrowing", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/docs/graph.ts": "export const graph = async () => ({ section: 'docs' });\n",
      "src/app/docs/run.test.ts": scenarioModule([
        {
          expect: { output: { section: "docs" }, status: "passed" },
          input: {},
          name: "docs graph passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "src/app/docs", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS docs graph passes")
  })

  test("honors explicit local targets when both graph.ts and workflow.ts exist in the same route directory", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ mode: 'graph' });\n",
      "src/app/support/workflow.ts":
        "export const workflow = async () => ({ mode: 'workflow' });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { output: { mode: "graph" }, status: "passed" },
          input: {},
          name: "graph companion target passes",
          target: "./graph.ts",
        },
        {
          expect: { output: { mode: "workflow" }, status: "passed" },
          input: {},
          name: "workflow companion target passes",
          target: "./workflow.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS graph companion target passes")
    expect(result.stdout).toContain("PASS workflow companion target passes")
  })

  test("rejects route-file narrowing input in v1", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ mode: 'graph' });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { output: { mode: "graph" }, status: "passed" },
          input: {},
          name: "graph companion target passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "src/app/support/graph.ts", "--cwd", appRoot], {
      cwd: appRoot,
    })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Scenario-load failure")
    expect(result.stderr).toContain("Route-file narrowing is not supported in v1")
  })

  test("rejects missing or invalid targets", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ mode: 'graph' });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { output: { mode: "graph" }, status: "passed" },
          input: {},
          name: "invalid target",
          target: "graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Scenario-load failure")
    expect(result.stderr).toContain(
      'Scenario "invalid target" target must be exactly "./graph.ts" or "./workflow.ts"',
    )
  })

  test("rejects cross-directory targets", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ mode: 'graph' });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { output: { mode: "graph" }, status: "passed" },
          input: {},
          name: "cross-directory target",
          target: "../graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Scenario-load failure")
    expect(result.stderr).toContain(
      'Scenario "cross-directory target" target must be exactly "./graph.ts" or "./workflow.ts"',
    )
  })

  test("passes a scenario that expects a modeled route failure", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": `export const graph = async () => { throw new Error("expected route failure"); };\n`,
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            error: {
              kind: "execution_error",
              message: "expected route failure",
            },
            status: "failed",
          },
          input: {},
          name: "expected failure passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS expected failure passes")
  })

  test("fails when expect.status does not match the actual route result", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { status: "failed" },
          input: {},
          name: "status mismatch fails",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("FAIL status mismatch fails [assertion]")
    expect(result.stdout).toContain("Expected status failed but received passed")
  })

  test("fails when minimal output assertions do not match", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ greeting: 'hello' });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            output: {
              greeting: "goodbye",
            },
            status: "passed",
          },
          input: {},
          name: "output mismatch fails",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL output mismatch fails [assertion]")
    expect(result.stdout).toContain("Expected output.greeting to equal")
  })

  test("passes deep-partial nested output assertions while allowing extra object fields", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts":
        "export const graph = async () => ({ profile: { tenant: 'acme', region: 'us-west' }, tags: ['alpha', 'beta'] });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            output: {
              profile: {
                tenant: "acme",
              },
            },
            status: "passed",
          },
          input: {},
          name: "nested output subset passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS nested output subset passes")
  })

  test("fails array output assertions unless the full array matches exactly", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts":
        "export const graph = async () => ({ tags: ['alpha', 'beta'] });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            output: {
              tags: ["alpha"],
            },
            status: "passed",
          },
          input: {},
          name: "array output mismatch fails",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL array output mismatch fails [assertion]")
    expect(result.stdout).toContain(
      'Expected output.tags to equal ["alpha"] but received ["alpha","beta"]',
    )
  })

  test("supports declarative meta assertions for route behavior results", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/workflow.ts":
        "export const workflow = async (input: { tenant: string }) => ({ tenant: input.tenant });\n",
      "src/app/support/[tenant]/run.test.ts": scenarioModule([
        {
          expect: {
            meta: {
              executionSource: "in-process",
              mode: "workflow",
              routeId: "/support/[tenant]",
              routePath: "src/app/support/[tenant]/workflow.ts",
            },
            output: {
              tenant: "meta-tenant",
            },
            status: "passed",
          },
          input: {
            tenant: "meta-tenant",
          },
          name: "meta assertions pass",
          target: "./workflow.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS meta assertions pass")
  })

  test("supports error.message includes matchers", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts":
        "export const graph = async () => { throw new Error('tenant acme exploded while rendering'); };\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            error: {
              message: {
                includes: "acme exploded",
              },
            },
            status: "failed",
          },
          input: {},
          name: "includes matcher passes",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS includes matcher passes")
  })

  test("forwards run.url scenarios through the server-backed execution path", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/[tenant]/graph.ts":
        "export const graph = async (input: { tenant: string }) => ({ tenant: input.tenant, source: 'local' });\n",
      "src/app/support/[tenant]/run.test.ts": scenarioModule([
        {
          expect: {
            meta: {
              executionSource: "server",
              mode: "graph",
              routeId: "/support/[tenant]",
              routePath: "src/app/support/[tenant]/graph.ts",
            },
            output: {
              source: "server",
              tenant: "server-tenant",
            },
            status: "passed",
          },
          input: {
            tenant: "server-tenant",
          },
          name: "server-backed scenario passes",
          run: {
            url: "__SERVER_URL__",
          },
          target: "./graph.ts",
        },
      ]).replace("__SERVER_URL__", "__SERVER_URL__"),
    })
    const server = await startFakeAgentServer(async () => ({
      body: {
        source: "server",
        tenant: "server-tenant",
      },
      statusCode: 200,
    }))

    await replaceInFile(
      join(appRoot, "src/app/support/[tenant]/run.test.ts"),
      '"__SERVER_URL__"',
      JSON.stringify(server.url),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS server-backed scenario passes")
  })

  test("runs declarative assertions before assert(result) and surfaces assert failures after declarative success", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        export default [
          {
            name: "assert runs after declarative expect",
            target: "./graph.ts",
            input: {},
            expect: {
              status: "passed",
              output: {
                ok: true,
              },
            },
            assert() {
              throw new Error("assert hook ran")
            },
          },
        ]
      `),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(
      "FAIL assert runs after declarative expect [assertion] assert hook ran",
    )
  })

  test("skips assert(result) when declarative expectations already failed", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ greeting: 'hello' });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        export default [
          {
            name: "assert is skipped after declarative failure",
            target: "./graph.ts",
            input: {},
            expect: {
              status: "passed",
              output: {
                greeting: "goodbye",
              },
            },
            assert() {
              globalThis.__dawnAssertCalls = (globalThis.__dawnAssertCalls ?? 0) + 1
              throw new Error("assert should not run")
            },
          },
        ]
      `),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL assert is skipped after declarative failure [assertion]")
    expect(result.stdout).not.toContain("assert should not run")
    expect((globalThis as Record<string, unknown>).__dawnAssertCalls ?? 0).toBe(0)
  })

  test("fails when optional error.kind does not match", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": `export const graph = async () => { throw new Error("kind mismatch"); };\n`,
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            error: {
              kind: "route_resolution_error",
            },
            status: "failed",
          },
          input: {},
          name: "error kind mismatch fails",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL error kind mismatch fails [assertion]")
    expect(result.stdout).toContain(
      "Expected error.kind route_resolution_error but received execution_error",
    )
  })

  test("fails when optional error.message does not match", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": `export const graph = async () => { throw new Error("actual message"); };\n`,
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            error: {
              message: "expected message",
            },
            status: "failed",
          },
          input: {},
          name: "error message mismatch fails",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL error message mismatch fails [assertion]")
    expect(result.stdout).toContain(
      'Expected error.message "expected message" but received "actual message"',
    )
  })

  test("fails when an unexpected route-execution failure occurs", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": `export const graph = async () => { throw new Error("unexpected execution failure"); };\n`,
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: { status: "passed" },
          input: {},
          name: "unexpected execution failure",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("FAIL unexpected execution failure [execution]")
    expect(result.stdout).toContain("unexpected execution failure")
  })

  test("returns exit 1 when no scenarios are found", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ ok: true });\n",
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("No run.test.ts scenarios found")
  })

  test("rejects scenarios that define neither expect nor assert", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          input: {},
          name: "missing expect and assert",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(
      'Scenario "missing expect and assert" must define at least one of expect or assert',
    )
  })

  test("rejects malformed expect values even when assert(result) is present", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        export default [
          {
            name: "malformed expect with assert",
            target: "./graph.ts",
            input: {},
            expect: "passed",
            assert() {
              return undefined
            },
          },
        ]
      `),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(
      'Scenario "malformed expect with assert" expect must be an object when provided',
    )
  })

  test("rejects scenarios that omit input", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/graph.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModule([
        {
          expect: {
            status: "passed",
          },
          name: "missing input",
          target: "./graph.ts",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Scenario "missing input" must define input')
  })
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-test-"))
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

async function replaceInFile(filePath: string, search: string, replacement: string): Promise<void> {
  const source = await readFile(filePath, "utf8")
  await writeFile(filePath, source.replace(search, replacement), "utf8")
}

async function invoke(
  argv: readonly string[],
  options: {
    readonly cwd: string
  },
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const previousCwd = process.cwd()
  process.chdir(options.cwd)

  try {
    const exitCode = await run([...argv], {
      stderr: (message: string) => {
        stderr.push(message)
      },
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

function scenarioModule(scenarios: readonly unknown[]): string {
  return `export default ${JSON.stringify(scenarios, null, 2)};\n`
}

function scenarioModuleSource(source: string): string {
  return `${source.trim()}\n`
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
): Promise<{ readonly close: () => Promise<void>; readonly url: string }> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/runs/wait") {
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

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }

  return Buffer.concat(chunks).toString("utf8")
}
