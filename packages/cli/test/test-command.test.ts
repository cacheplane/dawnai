import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, test } from "vitest"

import { run } from "../src/index.js"
import { loadRunScenarios, RunScenarioLoadError } from "../src/lib/runtime/load-run-scenarios.js"

const SDK_TESTING_URL = pathToFileURL(
  resolve(import.meta.dirname, "../../sdk/dist/testing/index.js"),
).href

interface BuilderScenarioFixture {
  readonly expect: {
    readonly error?: unknown
    readonly meta?: unknown
    readonly output?: unknown
    readonly status: "failed" | "passed"
  }
  readonly input: unknown
  readonly name: string
  readonly run?: { readonly url: string }
}

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  await Promise.all(servers.splice(0).map((server) => server.close()))
  delete (globalThis as Record<string, unknown>).__dawnAssertCalls
})

describe("dawn test", () => {
  test("executes workflow scenarios inferred from index.ts with shared and route-local tools", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/tools/greet.ts": `export default async (input: { tenant: string }) => ({ scope: "shared", tenant: input.tenant });
`,
      "src/app/hello/[tenant]/index.ts": `import type { RuntimeContext } from "@dawn-ai/sdk"
export const workflow = async (
  input: { tenant: string },
  context: RuntimeContext,
) => ({
  shared: await context.tools.greet({ tenant: input.tenant }),
  tenantGreeting: await context.tools["tenant-greet"]({ tenant: input.tenant }),
});
`,
      "src/app/hello/[tenant]/tools/tenant-greet.ts": `export default async (input: { tenant: string }) => ({ scope: "route-local", tenant: input.tenant });
`,
      "src/app/hello/[tenant]/run.test.ts": scenarioModule("/hello/[tenant]", [
        {
          expect: {
            meta: {
              executionSource: "in-process",
              mode: "workflow",
              routeId: "/hello/[tenant]",
              routePath: "src/app/hello/[tenant]/index.ts",
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
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS authoring workflow scenario passes")
    expect(result.stdout).toContain("Summary: 1 passed, 0 failed")
  })

  test("executes a route-local tool mock while retaining a real shared tool", async () => {
    const appRoot = await createScenarioToolMockFixture(
      toolMockScenarioModule(
        "mocked lookup passes",
        `s
          .input({ tenant: "acme" })
          .mockTool("lookup", async ({ tenant }: { tenant: string }) => ({
            plan: "mock:" + tenant,
          }))
          .expectPassed()
          .expectOutput({
            greeting: { source: "real-shared" },
            plan: "mock:acme",
          })
          .expectTool("lookup", (call) =>
            call.calledOnce().withArgs({ tenant: "acme" }),
          )`,
      ),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS mocked lookup passes")
    expect(result.stdout).toContain("Summary: 1 passed, 0 failed")
  })

  test("passes an exact two-call tool expectation", async () => {
    const appRoot = await createScenarioToolMockFixture(
      toolMockScenarioModule(
        "lookup called twice",
        `s
          .input({
            tenant: "acme",
            lookupArgs: [{ tenant: "acme" }, { tenant: "beta" }],
          })
          .mockTool("lookup", async ({ tenant }: { tenant: string }) => ({
            plan: "mock:" + tenant,
          }))
          .expectPassed()
          .expectOutput({ plan: "mock:acme" })
          .expectTool("lookup", (call) => call.calledTimes(2))`,
      ),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS lookup called twice")
  })

  test("passes a not-called tool expectation", async () => {
    const appRoot = await createScenarioToolMockFixture(
      toolMockScenarioModule(
        "lookup is not called",
        `s
          .input({ tenant: "acme", lookupArgs: [] })
          .mockTool("lookup", async () => ({ plan: "mock:unused" }))
          .expectPassed()
          .expectOutput({ greeting: { source: "real-shared" } })
          .expectTool("lookup", (call) => call.notCalled())`,
      ),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS lookup is not called")
  })

  test("reports tool count mismatches before running the custom assertion", async () => {
    const appRoot = await createScenarioToolMockFixture(
      toolMockScenarioModule(
        "lookup count mismatch",
        `s
          .input({ tenant: "acme" })
          .mockTool("lookup", async ({ tenant }: { tenant: string }) => ({
            plan: "mock:" + tenant,
          }))
          .expectPassed()
          .expectTool("lookup", (call) => call.calledTimes(2))
          .assert(() => {
            globalThis.__dawnAssertCalls = (globalThis.__dawnAssertCalls ?? 0) + 1
            throw new Error("custom assertion should not run")
          })`,
      ),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(
      'FAIL lookup count mismatch [assertion] Expected tool "lookup" call count to equal 2 but received 1',
    )
    expect(result.stdout).not.toContain("custom assertion should not run")
    expect((globalThis as Record<string, unknown>).__dawnAssertCalls ?? 0).toBe(0)
  })

  test("matches primitive tool arguments exactly", async () => {
    const appRoot = await createScenarioToolMockFixture(
      toolMockScenarioModule(
        "primitive lookup args match",
        `s
          .input({ tenant: "acme", lookupArgs: ["acme"] })
          .mockTool("lookup", async (tenant: unknown) => ({
            plan: "mock:" + String(tenant),
          }))
          .expectPassed()
          .expectOutput({ plan: "mock:acme" })
          .expectTool("lookup", (call) => call.withArgs("acme"))`,
      ),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS primitive lookup args match")
  })

  test("matches nested object subsets while requiring exact arrays", async () => {
    const appRoot = await createScenarioToolMockFixture(
      toolMockScenarioModule(
        "nested lookup args match",
        `s
          .input({
            tenant: "acme",
            lookupArgs: [{
              request: {
                filters: [{ field: "status", values: ["active", "queued"] }],
                options: { locale: "en", timezone: "UTC" },
                trace: true,
              },
              tenant: "acme",
            }],
          })
          .mockTool("lookup", async () => ({ plan: "mock:acme" }))
          .expectPassed()
          .expectOutput({ plan: "mock:acme" })
          .expectTool("lookup", (call) =>
            call.withArgs({
              request: {
                filters: [{ field: "status", values: ["active", "queued"] }],
                options: { locale: "en" },
              },
            }),
          )`,
      ),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS nested lookup args match")
  })

  test("lets one call satisfy multiple compatible argument matchers", async () => {
    const appRoot = await createScenarioToolMockFixture(
      toolMockScenarioModule(
        "compatible lookup args match",
        `s
          .input({
            tenant: "acme",
            lookupArgs: [{ region: "us-west", tenant: "acme" }],
          })
          .mockTool("lookup", async () => ({ plan: "mock:acme" }))
          .expectPassed()
          .expectOutput({ plan: "mock:acme" })
          .expectTool("lookup", (call) =>
            call
              .withArgs({ tenant: "acme" })
              .withArgs({ region: "us-west" }),
          )`,
      ),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS compatible lookup args match")
  })

  test("reports expected and observed arguments for a tool mismatch", async () => {
    const appRoot = await createScenarioToolMockFixture(
      toolMockScenarioModule(
        "lookup args mismatch",
        `s
          .input({
            tenant: "acme",
            lookupArgs: [{
              tenant: "acme",
              filters: [{ field: "status", ignored: true, value: "active" }],
            }],
          })
          .mockTool("lookup", async () => ({ plan: "mock:acme" }))
          .expectPassed()
          .expectTool("lookup", (call) =>
            call.withArgs({
              tenant: "acme",
              filters: [{ field: "status", value: "active" }],
            }),
          )`,
      ),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(
      'FAIL lookup args mismatch [assertion] Expected tool "lookup" arguments to match {"filters":[{"field":"status","value":"active"}],"tenant":"acme"} but observed [{"filters":[{"field":"status","ignored":true,"value":"active"}],"tenant":"acme"}]',
    )
  })

  test("treats a throwing tool mock as an ordinary modeled route failure", async () => {
    const appRoot = await createScenarioToolMockFixture(
      toolMockScenarioModule(
        "mocked lookup failure passes",
        `s
          .input({ tenant: "acme" })
          .mockTool("lookup", async () => {
            throw new Error("mock lookup failed")
          })
          .expectFailed()
          .expectError({ kind: "execution_error", message: "mock lookup failed" })
          .expectTool("lookup", (call) => call.calledOnce())`,
      ),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS mocked lookup failure passes")
  })

  test("reports an unexpected mock failure before a secondary call-count mismatch", async () => {
    const appRoot = await createScenarioToolMockFixture(
      toolMockScenarioModule(
        "unexpected mocked lookup failure",
        `s
          .input({ tenant: "acme" })
          .mockTool("lookup", async () => {
            throw new Error("unexpected mock lookup failure")
          })
          .expectPassed()
          .expectTool("lookup", (call) => call.calledTimes(2))`,
      ),
    )

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(
      "FAIL unexpected mocked lookup failure [execution] unexpected mock lookup failure",
    )
    expect(result.stdout).not.toContain("call count")
  })

  test("discovers all run.test.ts files under the configured routes root", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/alpha/index.ts": "export const graph = async () => ({ route: 'alpha' });\n",
      "src/app/alpha/run.test.ts": scenarioModule("/alpha", [
        {
          expect: {
            output: {
              route: "alpha",
            },
            status: "passed",
          },
          input: {},
          name: "alpha graph passes",
        },
      ]),
      "src/app/beta/index.ts": "export const workflow = async () => ({ route: 'beta' });\n",
      "src/app/beta/run.test.ts": scenarioModule("/beta", [
        {
          expect: {
            output: {
              route: "beta",
            },
            status: "passed",
          },
          input: {},
          name: "beta workflow passes",
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
      "src/app/alpha/index.ts": "export const graph = async () => ({ route: 'alpha' });\n",
      "src/app/alpha/run.test.ts": scenarioModule("/alpha", [
        {
          expect: { output: { route: "alpha" }, status: "passed" },
          input: {},
          name: "alpha graph passes",
        },
      ]),
      "src/app/beta/index.ts": "export const workflow = async () => ({ route: 'beta' });\n",
      "src/app/beta/run.test.ts": scenarioModule("/beta", [
        {
          expect: { output: { route: "beta" }, status: "passed" },
          input: {},
          name: "beta workflow passes",
        },
      ]),
    })

    const result = await invoke(["test", "/beta", "--cwd", appRoot], {
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
      "src/app/docs/index.ts": "export const graph = async () => ({ section: 'docs' });\n",
      "src/app/docs/run.test.ts": scenarioModule("/docs", [
        {
          expect: { output: { section: "docs" }, status: "passed" },
          input: {},
          name: "docs graph passes",
        },
      ]),
      "src/app/docs/guides/index.ts":
        "export const workflow = async () => ({ section: 'guides' });\n",
      "src/app/docs/guides/run.test.ts": scenarioModule("/docs/guides", [
        {
          expect: { output: { section: "guides" }, status: "passed" },
          input: {},
          name: "guides workflow passes",
        },
      ]),
      "src/app/marketing/index.ts":
        "export const graph = async () => ({ section: 'marketing' });\n",
      "src/app/marketing/run.test.ts": scenarioModule("/marketing", [
        {
          expect: { output: { section: "marketing" }, status: "passed" },
          input: {},
          name: "marketing graph passes",
        },
      ]),
    })

    const result = await invoke(["test", "/docs", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS docs graph passes")
    expect(result.stdout).toContain("PASS guides workflow passes")
    expect(result.stdout).not.toContain("marketing graph passes")
  })

  test("narrows by route pathname", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/docs/index.ts": "export const graph = async () => ({ section: 'docs' });\n",
      "src/app/docs/run.test.ts": scenarioModule("/docs", [
        {
          expect: { output: { section: "docs" }, status: "passed" },
          input: {},
          name: "docs graph passes",
        },
      ]),
    })

    const result = await invoke(["test", "/docs", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("PASS docs graph passes")
  })

  test("loads a branded suite whose declared route matches its directory", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModule("/support", [
        {
          expect: { output: { ok: true }, status: "passed" },
          input: {},
          name: "matching branded suite passes",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("PASS matching branded suite passes")
  })

  test("rejects plain default-exported scenario arrays with the builder hint", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        export default [
          {
            name: "legacy array scenario",
            input: {},
            expect: { status: "passed" },
          },
        ]
      `),
    })
    const scenarioFile = join(appRoot, "src/app/support/run.test.ts")

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(
      `Scenario file ${scenarioFile} must default export scenarios("<route>").scenario(...) from "@dawn-ai/sdk/testing".\nPlain scenario arrays are not supported.`,
    )
  })

  test("rejects a suite whose declared route does not match its directory", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/billing/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModule("/billing", [
        {
          expect: { status: "passed" },
          input: {},
          name: "mismatched route suite",
        },
      ]),
    })
    const scenarioFile = join(appRoot, "src/app/support/run.test.ts")

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(
      `Scenario file ${scenarioFile} declares route "/billing" but is colocated with route "/support"`,
    )
  })

  test("wraps duplicate scenario names as a scenario-load failure", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

        export default scenarios("/support")
          .scenario("duplicate", (s) => s.input({}).expectPassed())
          .scenario("duplicate", (s) => s.input({}).expectPassed())
      `),
    })
    const scenarioFile = join(appRoot, "src/app/support/run.test.ts")

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(`Scenario file ${scenarioFile} failed to load`)
    expect(result.stderr).toMatch(/duplicate scenario name/i)
  })

  test("wraps server scenarios with tool mocks as a scenario-load failure", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

        export default scenarios("/support").scenario("server mock", (s) =>
          s
            .input({})
            .server("http://localhost:3000")
            .mockTool("search", async () => ({ results: [] }))
            .expectPassed(),
        )
      `),
    })
    const scenarioFile = join(appRoot, "src/app/support/run.test.ts")

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(`Scenario file ${scenarioFile} failed to load`)
    expect(result.stderr).toMatch(/server scenarios cannot use tool mocks/i)
  })

  test("rejects unknown application tool mocks with sorted available names", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/tools/zeta.ts": "export default async () => 'zeta';\n",
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/tools/alpha.ts": "export default async () => 'alpha';\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

        export default scenarios("/support").scenario("unknown application tool", (s) =>
          s
            .input({})
            .mockTool("missing", async () => "mocked")
            .expectPassed(),
        )
      `),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(
      'Scenario "unknown application tool" mocks unknown application tool "missing". Available tools: alpha, zeta',
    )
  })

  test("wraps malformed shared tool discovery with scenario file context", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/tools/broken.ts": "export default { invalid: true };\n",
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

        export default scenarios("/support").scenario("malformed shared tool", (s) =>
          s
            .input({})
            .mockTool("broken", async () => "mocked")
            .expectPassed(),
        )
      `),
    })
    const scenarioFile = join(appRoot, "src/app/support/run.test.ts")
    const toolFile = join(appRoot, "src/tools/broken.ts")

    const error: unknown = await loadRunScenarios({ cwd: appRoot }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(RunScenarioLoadError)
    if (!(error instanceof Error)) {
      throw new Error("Expected scenario loading to throw an Error")
    }
    expect(error.message).toContain(
      `Scenario file ${scenarioFile} failed to discover application tools`,
    )
    expect(error.message).toContain(
      `Tool file ${toolFile} must default export a function (got an object with keys [invalid])`,
    )
  })

  test("rejects scenarios when sibling index.ts is missing", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/run.test.ts": scenarioModule("/support", [
        {
          expect: { status: "passed" },
          input: {},
          name: "orphan scenario",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("Scenario-load failure")
    expect(result.stderr).toContain(
      "has no sibling index.ts — run.test.ts must be colocated with a route entry point",
    )
  })

  test("rejects scenarios when index.ts exports neither workflow nor graph", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/index.ts": "export const handler = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModule("/support", [
        {
          expect: { status: "passed" },
          input: {},
          name: "bad export scenario",
        },
      ]),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("Scenario-load failure")
    expect(result.stderr).toContain(
      'sibling index.ts exports neither "workflow", "graph", nor "chain"',
    )
  })

  test("passes a scenario that expects a modeled route failure", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/index.ts": `export const graph = async () => { throw new Error("expected route failure"); };\n`,
      "src/app/support/run.test.ts": scenarioModule("/support", [
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
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModule("/support", [
        {
          expect: { status: "failed" },
          input: {},
          name: "status mismatch fails",
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
      "src/app/support/index.ts": "export const graph = async () => ({ greeting: 'hello' });\n",
      "src/app/support/run.test.ts": scenarioModule("/support", [
        {
          expect: {
            output: {
              greeting: "goodbye",
            },
            status: "passed",
          },
          input: {},
          name: "output mismatch fails",
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
      "src/app/support/index.ts":
        "export const graph = async () => ({ profile: { tenant: 'acme', region: 'us-west' }, tags: ['alpha', 'beta'] });\n",
      "src/app/support/run.test.ts": scenarioModule("/support", [
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
      "src/app/support/index.ts":
        "export const graph = async () => ({ tags: ['alpha', 'beta'] });\n",
      "src/app/support/run.test.ts": scenarioModule("/support", [
        {
          expect: {
            output: {
              tags: ["alpha"],
            },
            status: "passed",
          },
          input: {},
          name: "array output mismatch fails",
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
      "src/app/support/[tenant]/index.ts":
        "export const workflow = async (input: { tenant: string }) => ({ tenant: input.tenant });\n",
      "src/app/support/[tenant]/run.test.ts": scenarioModule("/support/[tenant]", [
        {
          expect: {
            meta: {
              executionSource: "in-process",
              mode: "workflow",
              routeId: "/support/[tenant]",
              routePath: "src/app/support/[tenant]/index.ts",
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
      "src/app/support/index.ts":
        "export const graph = async () => { throw new Error('tenant acme exploded while rendering'); };\n",
      "src/app/support/run.test.ts": scenarioModule("/support", [
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
      "src/app/support/[tenant]/index.ts":
        "export const graph = async (input: { tenant: string }) => ({ tenant: input.tenant, source: 'local' });\n",
      "src/app/support/[tenant]/run.test.ts": scenarioModule("/support/[tenant]", [
        {
          expect: {
            meta: {
              executionSource: "server",
              mode: "graph",
              routeId: "/support/[tenant]",
              routePath: "src/app/support/[tenant]/index.ts",
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
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

        export default scenarios("/support").scenario(
          "assert runs after declarative expect",
          (s) =>
            s
              .input({})
              .expectPassed()
              .expectOutput({ ok: true })
              .assert(() => {
                throw new Error("assert hook ran")
              }),
        )
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
      "src/app/support/index.ts": "export const graph = async () => ({ greeting: 'hello' });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

        export default scenarios("/support").scenario(
          "assert is skipped after declarative failure",
          (s) =>
            s
              .input({})
              .expectPassed()
              .expectOutput({ greeting: "goodbye" })
              .assert(() => {
                globalThis.__dawnAssertCalls = (globalThis.__dawnAssertCalls ?? 0) + 1
                throw new Error("assert should not run")
              }),
        )
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
      "src/app/support/index.ts": `export const graph = async () => { throw new Error("kind mismatch"); };\n`,
      "src/app/support/run.test.ts": scenarioModule("/support", [
        {
          expect: {
            error: {
              kind: "route_resolution_error",
            },
            status: "failed",
          },
          input: {},
          name: "error kind mismatch fails",
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
      "src/app/support/index.ts": `export const graph = async () => { throw new Error("actual message"); };\n`,
      "src/app/support/run.test.ts": scenarioModule("/support", [
        {
          expect: {
            error: {
              message: "expected message",
            },
            status: "failed",
          },
          input: {},
          name: "error message mismatch fails",
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
      "src/app/support/index.ts": `export const graph = async () => { throw new Error("unexpected execution failure"); };\n`,
      "src/app/support/run.test.ts": scenarioModule("/support", [
        {
          expect: { status: "passed" },
          input: {},
          name: "unexpected execution failure",
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
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("No run.test.ts scenarios found")
  })

  test("rejects scenarios that omit an expected status", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

        interface MissingStatusBuilder {
          input(value: unknown): unknown
        }
        const suite = scenarios("/support") as unknown as {
          scenario(
            name: string,
            configure: (builder: MissingStatusBuilder) => unknown,
          ): unknown
        }

        export default suite.scenario("missing expected status", (s) => s.input({}))
      `),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("Scenario missing expected status requires an expected status")
  })

  test("rejects malformed builder expectations even when assert(result) is present", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

        interface MalformedExpectationBuilder {
          assert(callback: () => unknown): MalformedExpectationBuilder
          expectMeta(expectation: unknown): MalformedExpectationBuilder
          expectPassed(): MalformedExpectationBuilder
          input(value: unknown): MalformedExpectationBuilder
        }
        const suite = scenarios("/support") as unknown as {
          scenario(
            name: string,
            configure: (builder: MalformedExpectationBuilder) => unknown,
          ): unknown
        }

        export default suite.scenario("malformed expect with assert", (s) =>
          s
            .input({})
            .expectPassed()
            .assert(() => undefined)
            .expectMeta("passed"),
        )
      `),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("Metadata expectation must be an object")
  })

  test("rejects scenarios that omit input", async () => {
    const appRoot = await createFixtureApp({
      "package.json": "{}\n",
      "dawn.config.ts": "export default {};\n",
      "src/app/support/index.ts": "export const graph = async () => ({ ok: true });\n",
      "src/app/support/run.test.ts": scenarioModuleSource(`
        import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

        interface MissingInputBuilder {
          expectPassed(): unknown
        }
        const suite = scenarios("/support") as unknown as {
          scenario(
            name: string,
            configure: (builder: MissingInputBuilder) => unknown,
          ): unknown
        }

        export default suite.scenario("missing input", (s) => s.expectPassed())
      `),
    })

    const result = await invoke(["test", "--cwd", appRoot], { cwd: appRoot })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("Scenario missing input requires input to be set exactly once")
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

async function createScenarioToolMockFixture(runTestSource: string): Promise<string> {
  return await createFixtureApp({
    "package.json": "{}\n",
    "dawn.config.ts": "export default {};\n",
    "src/tools/greet.ts": `export default async (input: { tenant: string }) => ({
  source: "real-shared",
  tenant: input.tenant,
});
`,
    "src/app/plans/index.ts": `import type { RuntimeContext } from "@dawn-ai/sdk"

export const workflow = async (
  input: { tenant: string; lookupArgs?: readonly unknown[] },
  context: RuntimeContext,
) => {
  const greeting = await context.tools.greet({ tenant: input.tenant })
  const lookupArgs = input.lookupArgs ?? [{ tenant: input.tenant }]
  const results: Array<{ plan: string }> = []

  for (const args of lookupArgs) {
    results.push(await context.tools.lookup(args) as { plan: string })
  }

  return {
    greeting,
    ...(results[0] ? { plan: results[0].plan } : {}),
    plans: results.map((result) => result.plan),
  }
}
`,
    "src/app/plans/tools/lookup.ts": `export default async (input: unknown) => {
  const tenant = typeof input === "string"
    ? input
    : (input as { tenant?: string }).tenant ?? "unknown"
  return { plan: "real:" + tenant }
}
`,
    "src/app/plans/run.test.ts": runTestSource,
  })
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

function scenarioModule(route: string, scenarios: readonly BuilderScenarioFixture[]): string {
  let source = `import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}\n\n`
  source += `export default scenarios(${JSON.stringify(route)})`

  for (const scenario of scenarios) {
    let chain = `s.input(${JSON.stringify(scenario.input)})`

    if (scenario.run?.url) {
      chain += `.server(${JSON.stringify(scenario.run.url)})`
    }

    chain += scenario.expect.status === "passed" ? ".expectPassed()" : ".expectFailed()"

    if (Object.hasOwn(scenario.expect, "output")) {
      chain += `.expectOutput(${JSON.stringify(scenario.expect.output)})`
    }

    if (scenario.expect.meta) {
      chain += `.expectMeta(${JSON.stringify(scenario.expect.meta)})`
    }

    if (scenario.expect.error) {
      chain += `.expectError(${JSON.stringify(scenario.expect.error)})`
    }

    source += `.scenario(${JSON.stringify(scenario.name)}, (s) => ${chain})`
  }

  return `${source}\n`
}

function scenarioModuleSource(source: string): string {
  return `${source.trim()}\n`
}

function toolMockScenarioModule(name: string, fluentScenario: string): string {
  return scenarioModuleSource(`
    import { scenarios } from ${JSON.stringify(SDK_TESTING_URL)}

    export default scenarios("/plans").scenario(
      ${JSON.stringify(name)},
      (s) => ${fluentScenario},
    )
  `)
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
    if (request.method !== "POST" || !/^\/threads\/[^/]+\/runs\/wait$/.test(request.url ?? "")) {
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
