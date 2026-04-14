import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, test } from "vitest"

import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe("dawn dev runtime server", () => {
  test("returns healthz ready only after the server is fully ready", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/graph.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(new URL("/healthz", server.url))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ready" })
  })

  test("executes graph and workflow routes by mode-qualified assistant_id", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/graph.ts": `export const graph = async (input: { tenant: string }) => ({ mode: "graph", tenant: input.tenant });\n`,
      "src/app/support/[tenant]/workflow.ts": `export const workflow = async (input: { tenant: string }) => ({ mode: "workflow", tenant: input.tenant });\n`,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const graphResponse = await fetch(new URL("/runs/wait", server.url), {
      body: JSON.stringify({
        assistant_id: "/support/[tenant]#graph",
        input: { tenant: "graph" },
        metadata: {
          dawn: {
            mode: "graph",
            route_id: "/support/[tenant]",
            route_path: "src/app/support/[tenant]/graph.ts",
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    const workflowResponse = await fetch(new URL("/runs/wait", server.url), {
      body: JSON.stringify({
        assistant_id: "/support/[tenant]#workflow",
        input: { tenant: "workflow" },
        metadata: {
          dawn: {
            mode: "workflow",
            route_id: "/support/[tenant]",
            route_path: "src/app/support/[tenant]/workflow.ts",
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(graphResponse.status).toBe(200)
    expect(await graphResponse.json()).toMatchObject({ mode: "graph", tenant: "graph" })
    expect(workflowResponse.status).toBe(200)
    expect(await workflowResponse.json()).toMatchObject({
      mode: "workflow",
      tenant: "workflow",
    })
  })

  test("rejects metadata mismatches as non-execution request failures", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/graph.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(new URL("/runs/wait", server.url), {
      body: JSON.stringify({
        assistant_id: "/support/[tenant]#graph",
        input: { tenant: "graph" },
        metadata: {
          dawn: {
            mode: "workflow",
            route_id: "/support/[tenant]",
            route_path: "src/app/support/[tenant]/graph.ts",
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        kind: "request_error",
      },
    })
  })

  test("rejects malformed request bodies and unknown assistant ids", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/graph.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const malformedResponse = await fetch(new URL("/runs/wait", server.url), {
      body: "{not-json",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    const unknownAssistantResponse = await fetch(new URL("/runs/wait", server.url), {
      body: JSON.stringify({
        assistant_id: "/support/[tenant]#workflow",
        input: { tenant: "graph" },
        metadata: {
          dawn: {
            mode: "workflow",
            route_id: "/support/[tenant]",
            route_path: "src/app/support/[tenant]/graph.ts",
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(malformedResponse.status).toBe(400)
    expect(unknownAssistantResponse.status).toBe(404)
  })

  test("returns execution_error for actual route exceptions", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/graph.ts": `export const graph = async () => { throw new Error("boom"); };\n`,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(new URL("/runs/wait", server.url), {
      body: JSON.stringify({
        assistant_id: "/support/[tenant]#graph",
        input: { tenant: "graph" },
        metadata: {
          dawn: {
            mode: "graph",
            route_id: "/support/[tenant]",
            route_path: "src/app/support/[tenant]/graph.ts",
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: {
        kind: "execution_error",
      },
    })
  })
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-dev-"))
  tempDirs.push(appRoot)

  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(join(filePath, ".."), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )

  return appRoot
}
