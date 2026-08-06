import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

beforeEach(() => {
  // No in-memory pending state to reset — resume is now state-based.
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe("POST /threads/:thread_id/resume", () => {
  const pendingOne = [
    [
      "33a12321-3ec2-56a7-b4d7-0337886c4386",
      "__interrupt__",
      {
        id: "3336d0e0a2d4f198ef9aecd09cd7ac27",
        value: { interruptId: "perm-1" },
      },
    ],
  ] as const
  const pendingTwo = [
    ...pendingOne,
    [
      "44b23432-4fd3-67b8-c5e8-1448997d5497",
      "__interrupt__",
      {
        id: "4447e1f1b3e5a209fa0bfde10de8bd38",
        value: { interruptId: "perm-2" },
      },
    ],
  ] as const
  const resolvedOnce = { interruptId: "perm-1", status: "resolved", payload: "once" } as const

  test("accepts the canonical multi-entry resume envelope", async () => {
    const appRoot = await createCheckpointFixtureApp(pendingTwo)
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)
    const threadId = "thread-multi"
    await seedRoute(server.url, threadId)

    const response = await postResume(server.url, threadId, {
      resume: [
        { interruptId: "perm-1", status: "resolved", payload: "once" },
        { interruptId: "perm-2", status: "cancelled" },
      ],
      route: "/noop#graph",
    })

    expect(response.status).toBe(200)
  })

  test.each([
    {
      name: "stale public ID",
      pendingWrites: pendingOne,
      resume: [{ interruptId: "perm-stale", status: "cancelled" }],
    },
    {
      name: "outer checkpoint alias instead of the public ID",
      pendingWrites: pendingOne,
      resume: [{ interruptId: "3336d0e0a2d4f198ef9aecd09cd7ac27", status: "cancelled" }],
    },
    {
      name: "duplicate public ID",
      pendingWrites: pendingOne,
      resume: [
        { interruptId: "perm-1", status: "cancelled" },
        { interruptId: "perm-1", status: "cancelled" },
      ],
    },
    {
      name: "partial pending set",
      pendingWrites: pendingTwo,
      resume: [{ interruptId: "perm-1", status: "cancelled" }],
    },
    {
      name: "extra public ID",
      pendingWrites: pendingOne,
      resume: [
        { interruptId: "perm-1", status: "cancelled" },
        { interruptId: "perm-extra", status: "cancelled" },
      ],
    },
    {
      name: "missing required set",
      pendingWrites: pendingOne,
      resume: [],
    },
  ])("returns 409 for an inexact resume set: $name", async ({ pendingWrites, resume }) => {
    const appRoot = await createCheckpointFixtureApp(pendingWrites)
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)
    const threadId = `thread-inexact-${tempDirs.length}`
    await seedRoute(server.url, threadId)

    const response = await postResume(server.url, threadId, {
      resume,
      route: "/noop#graph",
    })

    expect(response.status).toBe(409)
  })

  test.each([
    ["missing resume", { route: "/noop#graph" }],
    ["missing route", { resume: [resolvedOnce] }],
    ["empty route", { resume: [resolvedOnce], route: "" }],
    ["non-string route", { resume: [resolvedOnce], route: 42 }],
    ["non-array resume", { resume: null, route: "/noop#graph" }],
    ["non-object entry", { resume: ["perm-1"], route: "/noop#graph" }],
    ["missing interruptId", { resume: [{ status: "cancelled" }], route: "/noop#graph" }],
    [
      "unsupported status",
      { resume: [{ interruptId: "perm-1", status: "pending" }], route: "/noop#graph" },
    ],
    [
      "resolved entry without a decision payload",
      { resume: [{ interruptId: "perm-1", status: "resolved" }], route: "/noop#graph" },
    ],
    ["unknown top-level field", { resume: [resolvedOnce], route: "/noop#graph", unexpected: true }],
    [
      "legacy fields mixed into a canonical body",
      {
        resume: [resolvedOnce],
        route: "/noop#graph",
        interrupt_id: "perm-1",
        decision: "once",
      },
    ],
    [
      "unknown resolved-entry field",
      {
        resume: [{ ...resolvedOnce, decision: "once" }],
        route: "/noop#graph",
      },
    ],
    [
      "payload on a cancelled entry",
      {
        resume: [{ interruptId: "perm-1", status: "cancelled", payload: "deny" }],
        route: "/noop#graph",
      },
    ],
  ])("returns 400 for a malformed envelope: %s", async (_name, body) => {
    const appRoot = await createCheckpointFixtureApp(pendingOne)
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)
    const threadId = `thread-malformed-body-${tempDirs.length}`
    await seedRoute(server.url, threadId)

    const response = await postResume(server.url, threadId, body)

    expect(response.status).toBe(400)
  })

  test("rejects the removed scalar interrupt_id and decision body", async () => {
    const appRoot = await createCheckpointFixtureApp(pendingOne)
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)
    const threadId = "thread-legacy"
    await seedRoute(server.url, threadId)

    const response = await postResume(server.url, threadId, {
      interrupt_id: "perm-1",
      decision: "once",
    })

    expect(response.status).toBe(400)
  })

  test.each([
    {
      name: "a malformed interrupt write",
      pendingWrites: [
        [
          "33a12321-3ec2-56a7-b4d7-0337886c4386",
          "__interrupt__",
          {
            id: "3336d0e0a2d4f198ef9aecd09cd7ac27",
            value: { interruptId: "perm-1" },
          },
        ],
        ["44b23432-4fd3-67b8-c5e8-1448997d5497", "__interrupt__", null],
      ],
    },
    {
      name: "duplicate checkpoint resume keys",
      pendingWrites: [
        [
          "33a12321-3ec2-56a7-b4d7-0337886c4386",
          "__interrupt__",
          {
            id: "3336d0e0a2d4f198ef9aecd09cd7ac27",
            value: { interruptId: "perm-1" },
          },
        ],
        [
          "44b23432-4fd3-67b8-c5e8-1448997d5497",
          "__interrupt__",
          {
            id: "3336d0e0a2d4f198ef9aecd09cd7ac27",
            value: { interruptId: "perm-2" },
          },
        ],
      ],
    },
  ])("returns structured 409 for $name", async ({ pendingWrites }) => {
    const appRoot = await createCheckpointFixtureApp(pendingWrites)
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)
    const threadId = `thread-malformed-${tempDirs.length}`

    const seedResponse = await fetch(new URL(`/threads/${threadId}/runs/wait`, server.url), {
      body: JSON.stringify({ input: {}, route: "/noop#graph" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(seedResponse.status).toBe(200)

    const response = await postResume(server.url, threadId, {
      resume: [{ interruptId: "perm-1", status: "cancelled" }],
      route: "/noop#graph",
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: {
        details: { code: "malformed_checkpoint" },
        kind: "request_error",
      },
    })
  })

  test("returns 404 when no checkpoint exists for the thread", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/noop/index.ts": "export const graph = async () => ({ ok: true });\n",
    })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    // No prior run on this thread — no checkpoint.
    const response = await postResume(server.url, "no-such-thread", {
      resume: [{ interruptId: "perm-x", status: "cancelled" }],
      route: "/noop#graph",
    })

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error?: { message?: string } }
    expect(body.error?.message).toMatch(/thread not found/i)
  })
})

async function seedRoute(serverUrl: string, threadId: string): Promise<void> {
  const response = await fetch(new URL(`/threads/${threadId}/runs/wait`, serverUrl), {
    body: JSON.stringify({ input: {}, route: "/noop#graph" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  expect(response.status).toBe(200)
}

async function postResume(serverUrl: string, threadId: string, body: unknown): Promise<Response> {
  return fetch(new URL(`/threads/${threadId}/resume`, serverUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-resume-"))
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

async function createCheckpointFixtureApp(pendingWrites: readonly unknown[]) {
  return createFixtureApp({
    "dawn.config.ts": `
      let reads = 0;
      export default {
        checkpointer: {
          getTuple: async () => {
            reads += 1;
            if (reads > 1) throw new Error("resume endpoint read checkpoint more than once");
            return { pendingWrites: ${JSON.stringify(pendingWrites)} };
          },
        },
      };
    `,
    "package.json": "{}\n",
    "src/app/noop/index.ts": "export const graph = async () => ({ ok: true });\n",
  })
}
