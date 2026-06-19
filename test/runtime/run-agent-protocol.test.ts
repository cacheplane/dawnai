import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { createGeneratedApp } from "../../packages/devkit/src/testing/index.ts"
import {
  cleanupTrackedTempDirs,
  createPackagedInstaller,
  createTrackedTempDir,
  markTrackedTempDirForPreserve,
  type TrackedTempDir,
} from "../harness/packaged-app.ts"
import {
  rewriteGeneratedAppDependencies,
  SCAFFOLD_PACKAGES,
} from "../harness/scaffold-packaging.js"
import { allocatePort, appendDevServerTranscript, startDevServer } from "./support/dev-server.ts"

// ---------------------------------------------------------------------------
// SSE parsing helpers
// ---------------------------------------------------------------------------

interface SseEvent {
  readonly event: string
  readonly data: unknown
}

/**
 * Read an SSE response body until the stream closes, collecting all events.
 * Returns early if `stopOn` event type is encountered (still includes it in
 * the result). The response body must already be open (fetch completed).
 */
async function collectSseEvents(response: Response, stopOn?: string): Promise<SseEvent[]> {
  if (!response.body) throw new Error("Response has no body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: SseEvent[] = []
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE messages (separated by blank lines)
      const messages = buffer.split("\n\n")
      // Keep the last (possibly incomplete) chunk in the buffer
      buffer = messages.pop() ?? ""

      for (const message of messages) {
        if (!message.trim()) continue
        const lines = message.split("\n")
        let eventType = "message"
        let dataLine = ""
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice("event: ".length).trim()
          } else if (line.startsWith("data: ")) {
            dataLine = line.slice("data: ".length).trim()
          }
        }
        let parsedData: unknown = dataLine
        try {
          parsedData = JSON.parse(dataLine)
        } catch {
          // keep as string
        }
        events.push({ event: eventType, data: parsedData })
        if (stopOn && eventType === stopOn) {
          return events
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return events
}

const HARNESS_RUNTIME_ARTIFACT_BASE_DIR_ENV = "DAWN_RUNTIME_ARTIFACT_BASE_DIR"
const tempDirs: TrackedTempDir[] = []

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

// ---------------------------------------------------------------------------
// Echo-agent overlay: a zero-LLM LangGraph StateGraph that checkpoints.
//
// The graph is compiled with the same sqliteCheckpointer path that Dawn uses
// (.dawn/checkpoints.sqlite), so every runs/wait call writes a real checkpoint
// that survives server restarts.
// ---------------------------------------------------------------------------

function echoAgentOverlaySource(): string {
  return `
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Annotation, StateGraph } from "@langchain/langgraph";
import { sqliteCheckpointer } from "@dawn-ai/sqlite-storage";

const __dir = dirname(fileURLToPath(import.meta.url));
// src/app/echo/index.ts → up 3 levels to <appRoot>
const appRoot = resolve(__dir, "../../..");

const EchoAnnotation = Annotation.Root({
  messages: Annotation({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
});

const checkpointer = sqliteCheckpointer({
  path: resolve(appRoot, ".dawn/checkpoints.sqlite"),
});

const echoGraph = new StateGraph(EchoAnnotation)
  .addNode("echo", (state) => ({
    messages: state.messages,
  }))
  .addEdge("__start__", "echo")
  .addEdge("echo", "__end__")
  .compile({ checkpointer });

export const agent = echoGraph;
`.trimStart()
}

/**
 * Builds the overlay source for a real agent route that uses the workspace +
 * permissions capabilities. It points to gpt-4o-mini (cheapest model that
 * still supports tool-calling) to keep cost low in CI.
 */
function permAgentRouteSource(): string {
  return `
import { agent } from "@dawn-ai/sdk";

export default agent({
  model: "gpt-4o-mini",
  systemPrompt:
    "You are a helpful assistant. When asked to check a package version, use runBash with exactly the command the user asks for. Do not guess or fabricate output.",
});
`.trimStart()
}

/**
 * dawn.config.ts overlay that enables the workspace + permissions capabilities
 * with an empty bash allow-list so every runBash call triggers a permission
 * interrupt.
 */
function permDawnConfigSource(): string {
  return `
export default {
  appDir: "src/app",
  permissions: {
    allow: { bash: [] },
    deny: {},
  },
};
`.trimStart()
}

// ---------------------------------------------------------------------------
// Permission interrupt → resume → completion (real LLM required)
// ---------------------------------------------------------------------------

describe("agent protocol permission interrupt + resume", () => {
  // Fast negative tests — no LLM needed, always run in CI.
  it("resume with unknown interrupt_id returns 409", { timeout: 120_000 }, async () => {
    const tempRoot = await createTrackedTempDir("dap-resume-neg-", tempDirs)
    const transcriptPath = join(tempRoot, "transcripts", "resume-neg.log")
    await mkdir(dirname(transcriptPath), { recursive: true })

    let appRoot: string

    try {
      const { tarballs } = await createPackagedInstaller({
        packageNames: [...SCAFFOLD_PACKAGES],
        tempRoot,
        transcriptPath,
      })

      const generatedApp = await createGeneratedApp({
        appName: "resume-neg",
        artifactRoot: tempRoot,
        specifiers: {
          dawnCli: tarballs["@dawn-ai/cli"],
          dawnConfigTypescript: tarballs["@dawn-ai/config-typescript"],
          dawnCore: tarballs["@dawn-ai/core"],
          dawnLangchain: tarballs["@dawn-ai/langchain"],
        },
        template: "basic",
      })

      appRoot = generatedApp.appRoot
      await rewriteGeneratedAppDependencies({
        appRoot,
        tarballs,
        extraDependencies: {
          "@dawn-ai/memory": tarballs["@dawn-ai/memory"]!,
          "@dawn-ai/permissions": tarballs["@dawn-ai/permissions"]!,
          "@dawn-ai/sqlite-storage": tarballs["@dawn-ai/sqlite-storage"]!,
          "@dawn-ai/workspace": tarballs["@dawn-ai/workspace"]!,
          "@langchain/langgraph": "1.3.0",
        },
        removeDependencies: ["langchain", "@langchain/openai"],
      })

      // Write echo agent route and a workspace directory
      const routeFile = join(appRoot, "src/app/echo/index.ts")
      await mkdir(dirname(routeFile), { recursive: true })
      await writeFile(routeFile, echoAgentOverlaySource(), "utf8")
      await mkdir(join(appRoot, "workspace"), { recursive: true })

      const { spawnProcess } = await import("../../packages/devkit/src/testing/index.ts")
      const installResult = await spawnProcess({
        args: ["install"],
        command: "pnpm",
        cwd: appRoot,
        env: { NODE_NO_WARNINGS: "1" },
      })
      if (!installResult.ok) {
        throw new Error(`pnpm install failed:\n${installResult.stdout}\n${installResult.stderr}`)
      }
    } catch (error) {
      markTrackedTempDirForPreserve(tempDirs, tempRoot)
      throw error
    }

    const port = await allocatePort()
    const server = await startDevServer({ cwd: appRoot, port })
    try {
      const url = await server.waitForReady(30_000)

      // Create a thread but do NOT run an agent (so no parked interrupt)
      const createResp = await fetch(new URL("/threads", url), {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      expect(createResp.status).toBe(200)
      const { thread_id: tid } = (await createResp.json()) as { thread_id: string }

      // Run the echo agent once so a checkpoint exists but with no interrupt pending
      const waitResp = await fetch(new URL(`/threads/${encodeURIComponent(tid)}/runs/wait`, url), {
        body: JSON.stringify({
          route: "/echo#agent",
          input: { messages: [{ role: "user", content: "hi" }] },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      // Accept any status — we just need a checkpoint, the echo agent may or may not succeed
      void waitResp

      // Try to resume with a nonexistent interrupt_id — must get 409 stale_interrupt
      const resumeResp = await fetch(new URL(`/threads/${encodeURIComponent(tid)}/resume`, url), {
        body: JSON.stringify({ interrupt_id: "perm-nonexistent", decision: "once" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      expect(resumeResp.status).toBe(409)
      const resumeBody = (await resumeResp.json()) as {
        error?: { details?: { code?: string } }
      }
      expect(resumeBody.error?.details?.code).toBe("stale_interrupt")
    } finally {
      await server.stop()
      await appendDevServerTranscript(transcriptPath, server)
    }
  })

  it("resume on unknown thread returns 404", { timeout: 120_000 }, async () => {
    const tempRoot = await createTrackedTempDir("dap-resume-404-", tempDirs)
    const transcriptPath = join(tempRoot, "transcripts", "resume-404.log")
    await mkdir(dirname(transcriptPath), { recursive: true })

    let appRoot: string

    try {
      const { tarballs } = await createPackagedInstaller({
        packageNames: [...SCAFFOLD_PACKAGES],
        tempRoot,
        transcriptPath,
      })

      const generatedApp = await createGeneratedApp({
        appName: "resume-404",
        artifactRoot: tempRoot,
        specifiers: {
          dawnCli: tarballs["@dawn-ai/cli"],
          dawnConfigTypescript: tarballs["@dawn-ai/config-typescript"],
          dawnCore: tarballs["@dawn-ai/core"],
          dawnLangchain: tarballs["@dawn-ai/langchain"],
        },
        template: "basic",
      })

      appRoot = generatedApp.appRoot
      await rewriteGeneratedAppDependencies({
        appRoot,
        tarballs,
        extraDependencies: {
          "@dawn-ai/memory": tarballs["@dawn-ai/memory"]!,
          "@dawn-ai/permissions": tarballs["@dawn-ai/permissions"]!,
          "@dawn-ai/sqlite-storage": tarballs["@dawn-ai/sqlite-storage"]!,
          "@dawn-ai/workspace": tarballs["@dawn-ai/workspace"]!,
          "@langchain/langgraph": "1.3.0",
        },
        removeDependencies: ["langchain", "@langchain/openai"],
      })

      const routeFile = join(appRoot, "src/app/echo/index.ts")
      await mkdir(dirname(routeFile), { recursive: true })
      await writeFile(routeFile, echoAgentOverlaySource(), "utf8")
      await mkdir(join(appRoot, "workspace"), { recursive: true })

      const { spawnProcess } = await import("../../packages/devkit/src/testing/index.ts")
      const installResult = await spawnProcess({
        args: ["install"],
        command: "pnpm",
        cwd: appRoot,
        env: { NODE_NO_WARNINGS: "1" },
      })
      if (!installResult.ok) {
        throw new Error(`pnpm install failed:\n${installResult.stdout}\n${installResult.stderr}`)
      }
    } catch (error) {
      markTrackedTempDirForPreserve(tempDirs, tempRoot)
      throw error
    }

    const port = await allocatePort()
    const server = await startDevServer({ cwd: appRoot, port })
    try {
      const url = await server.waitForReady(30_000)

      // Resume on a thread that has never existed — must get 404
      const resumeResp = await fetch(new URL("/threads/t-does-not-exist/resume", url), {
        body: JSON.stringify({ interrupt_id: "perm-xyz", decision: "once" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      expect(resumeResp.status).toBe(404)
    } finally {
      await server.stop()
      await appendDevServerTranscript(transcriptPath, server)
    }
  })

  it.skipIf(!process.env.OPENAI_API_KEY)(
    "permission interrupt survives server restart and resumes to completion",
    { timeout: 120_000 },
    async () => {
      if (!process.env.OPENAI_API_KEY) {
        // Guard: vitest's skipIf should handle this, but just in case
        return
      }

      const tempRoot = await createTrackedTempDir("dap-perm-", tempDirs)
      const artifactBaseDir = process.env[HARNESS_RUNTIME_ARTIFACT_BASE_DIR_ENV] ?? tempRoot
      const transcriptPath = join(artifactBaseDir, "transcripts", "ap-perm.log")
      await mkdir(dirname(transcriptPath), { recursive: true })

      let appRoot: string

      try {
        const { tarballs } = await createPackagedInstaller({
          packageNames: [
            "@dawn-ai/cli",
            "@dawn-ai/config-typescript",
            "@dawn-ai/core",
            "@dawn-ai/langchain",
            "@dawn-ai/langgraph",
            "@dawn-ai/memory",
            "@dawn-ai/permissions",
            "@dawn-ai/sdk",
            "@dawn-ai/sqlite-storage",
            "@dawn-ai/testing",
            "@dawn-ai/workspace",
          ],
          tempRoot,
          transcriptPath,
        })

        const generatedApp = await createGeneratedApp({
          appName: "ap-perm",
          artifactRoot: artifactBaseDir,
          specifiers: {
            dawnCli: tarballs["@dawn-ai/cli"],
            dawnConfigTypescript: tarballs["@dawn-ai/config-typescript"],
            dawnCore: tarballs["@dawn-ai/core"],
            dawnLangchain: tarballs["@dawn-ai/langchain"],
          },
          template: "basic",
        })

        appRoot = generatedApp.appRoot

        await rewriteGeneratedAppDependencies({
          appRoot,
          tarballs,
          extraDependencies: {
            "@dawn-ai/memory": tarballs["@dawn-ai/memory"]!,
            "@dawn-ai/permissions": tarballs["@dawn-ai/permissions"]!,
            "@dawn-ai/sqlite-storage": tarballs["@dawn-ai/sqlite-storage"]!,
            "@dawn-ai/workspace": tarballs["@dawn-ai/workspace"]!,
            "@langchain/langgraph": "1.3.0",
          },
          removeDependencies: ["langchain", "@langchain/openai"],
        })

        // Write the perm-agent route overlay at src/app/perm-agent/index.ts
        const routeFile = join(appRoot, "src/app/perm-agent/index.ts")
        await mkdir(dirname(routeFile), { recursive: true })
        await writeFile(routeFile, permAgentRouteSource(), "utf8")

        // Write dawn.config.ts with empty bash allow-list → every runBash triggers interrupt
        const dawnConfigFile = join(appRoot, "dawn.config.ts")
        await writeFile(dawnConfigFile, permDawnConfigSource(), "utf8")

        // Create a workspace directory so the workspace capability activates
        await mkdir(join(appRoot, "workspace"), { recursive: true })
        await writeFile(
          join(appRoot, "workspace", "AGENTS.md"),
          "# Workspace\nThis is the test workspace.\n",
          "utf8",
        )

        const { spawnProcess } = await import("../../packages/devkit/src/testing/index.ts")
        const installResult = await spawnProcess({
          args: ["install"],
          command: "pnpm",
          cwd: appRoot,
          env: { NODE_NO_WARNINGS: "1" },
        })
        if (!installResult.ok) {
          throw new Error(`pnpm install failed:\n${installResult.stdout}\n${installResult.stderr}`)
        }
      } catch (error) {
        markTrackedTempDirForPreserve(tempDirs, tempRoot)
        throw error
      }

      // -----------------------------------------------------------------------
      // Step 1: Start server A, POST /threads, POST /runs/stream, read SSE
      // until interrupt fires, then kill the server.
      // -----------------------------------------------------------------------
      const routeKey = "/perm-agent#agent"
      const threadId = `t-perm-${Date.now()}`
      const userMessage = "Run the bash command: npm view react version"

      const port1 = await allocatePort()
      const server1 = await startDevServer({
        cwd: appRoot,
        port: port1,
        env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
      })

      let capturedInterruptId: string

      try {
        const url1 = await server1.waitForReady(30_000)

        // Create thread
        const createResp = await fetch(new URL("/threads", url1), {
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
        expect(createResp.status).toBe(200)

        // Start the streaming run
        const streamResp = await fetch(
          new URL(`/threads/${encodeURIComponent(threadId)}/runs/stream`, url1),
          {
            body: JSON.stringify({
              route: routeKey,
              input: { messages: [{ role: "user", content: userMessage }] },
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        )
        expect(
          streamResp.status,
          `runs/stream failed: ${streamResp.status} ${await streamResp.clone().text()}`,
        ).toBe(200)
        expect(streamResp.headers.get("content-type")).toContain("text/event-stream")

        // Collect SSE events until we see an interrupt or done
        const events = await collectSseEvents(streamResp)

        // Find the interrupt event
        const interruptEvent = events.find((e) => e.event === "interrupt")
        expect(
          interruptEvent,
          `Expected an interrupt event but got: ${events.map((e) => e.event).join(", ")}`,
        ).toBeDefined()

        const interruptData = interruptEvent?.data as Record<string, unknown> | undefined
        expect(typeof interruptData?.interruptId).toBe("string")
        expect((interruptData?.interruptId as string).startsWith("perm-")).toBe(true)
        expect(interruptData?.kind).toBe("command")

        const detail = interruptData?.detail as Record<string, unknown> | undefined
        expect(typeof detail?.command).toBe("string")
        expect((detail?.command as string).toLowerCase()).toContain("npm")
        expect(typeof detail?.suggestedPattern).toBe("string")

        capturedInterruptId = interruptData?.interruptId as string

        // The stream must have ended (done event or stream close) —
        // server does not hold the connection open across the interrupt decision.
        // Some versions emit done after interrupt; either way stream is closed.
        // The key assertion: stream is closed (collectSseEvents returned).
        expect(events.length).toBeGreaterThan(0)
      } finally {
        await server1.stop()
        await appendDevServerTranscript(transcriptPath, server1)
      }

      // -----------------------------------------------------------------------
      // Step 2: Restart on a new port (same appRoot → same .dawn/ SQLite).
      // In-memory parking is gone; SQLite checkpoint is the source of truth.
      // -----------------------------------------------------------------------
      const port2 = await allocatePort()
      const server2 = await startDevServer({
        cwd: appRoot,
        port: port2,
        env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
      })

      try {
        const url2 = await server2.waitForReady(30_000)

        // POST resume WITHOUT a `route` field — the server's in-memory
        // threadRouteMap is empty after the restart, so this exercises the
        // durable fallback: the route persisted to thread metadata in SQLite
        // at run-start. If metadata persistence regresses, this 409s.
        const resumeResp = await fetch(
          new URL(`/threads/${encodeURIComponent(threadId)}/resume`, url2),
          {
            body: JSON.stringify({
              interrupt_id: capturedInterruptId,
              decision: "once",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        )
        expect(
          resumeResp.status,
          `resume failed: ${resumeResp.status} ${await resumeResp.clone().text()}`,
        ).toBe(200)
        expect(resumeResp.headers.get("content-type")).toContain("text/event-stream")

        // Collect all SSE events from the resume stream
        const resumeEvents = await collectSseEvents(resumeResp)

        // Summarise for the test report
        const toolResultCount = resumeEvents.filter((e) => e.event === "tool_result").length
        const doneCount = resumeEvents.filter((e) => e.event === "done").length
        const toolNodeErrors = resumeEvents.filter(
          (e) =>
            e.event === "done" &&
            typeof (e.data as Record<string, unknown> | undefined)?.error === "string" &&
            ((e.data as Record<string, unknown>).error as string).includes("ToolNode only accepts"),
        ).length

        // Report to console so CI logs are self-documenting
        console.log(
          `[perm-interrupt-test] resume SSE: tool_result=${toolResultCount}, done=${doneCount}, ToolNode-errors=${toolNodeErrors}`,
        )

        // Core assertions
        expect(
          toolNodeErrors,
          `"ToolNode only accepts" error found in resume stream — serde regression`,
        ).toBe(0)

        const finalDone = resumeEvents.find((e) => e.event === "done")
        expect(finalDone, "Expected a done event in the resume stream").toBeDefined()
        const donePayload = finalDone?.data as Record<string, unknown> | undefined
        expect(
          typeof donePayload?.error === "string" ? donePayload.error : undefined,
          `Resume stream done event carried an error: ${JSON.stringify(donePayload)}`,
        ).toBeUndefined()

        // At least one tool_result for runBash — proves the tool actually ran
        expect(
          toolResultCount,
          "Expected at least one tool_result (runBash) in the resume stream",
        ).toBeGreaterThan(0)

        // -----------------------------------------------------------------------
        // Step 3: GET /threads/{tid}/state — verify ToolMessage persisted
        // -----------------------------------------------------------------------
        const stateResp = await fetch(
          new URL(`/threads/${encodeURIComponent(threadId)}/state`, url2),
        )
        expect(
          stateResp.status,
          `GET /state failed: ${stateResp.status} ${await stateResp.clone().text()}`,
        ).toBe(200)
        const state = (await stateResp.json()) as Record<string, unknown>
        const messages = (state.values as Record<string, unknown> | undefined)
          ?.messages as unknown[]
        expect(Array.isArray(messages)).toBe(true)
        // The state must contain a ToolMessage. LangChain serializes messages using
        // the JsonPlusSerializer format: { lc: 1, type: "constructor",
        // id: ["langchain_core", "messages", "ToolMessage"], kwargs: {...} }.
        // We check both the serde format and plain role="tool" / type="tool" shapes.
        const hasToolMessage = (messages ?? []).some((m) => {
          const msg = m as Record<string, unknown>
          // LangChain JsonPlusSerializer shape
          const id = msg.id as string[] | undefined
          if (Array.isArray(id) && id[2] === "ToolMessage") return true
          // Plain shape (direct serialization)
          if (msg.type === "tool" || msg.role === "tool") return true
          return false
        })
        expect(
          hasToolMessage,
          `Expected a ToolMessage in persisted state. Messages: ${JSON.stringify(messages).slice(0, 500)}`,
        ).toBe(true)
      } finally {
        await server2.stop()
        await appendDevServerTranscript(transcriptPath, server2)
      }
    },
  )
})

describe("agent protocol state persistence", () => {
  it("state survives server kill + restart on a new port", { timeout: 300_000 }, async () => {
    // ------------------------------------------------------------------
    // 1. Build a packed app with the echo-agent overlay
    // ------------------------------------------------------------------
    const tempRoot = await createTrackedTempDir("dap-", tempDirs)
    const artifactBaseDir = process.env[HARNESS_RUNTIME_ARTIFACT_BASE_DIR_ENV] ?? tempRoot
    const transcriptPath = join(artifactBaseDir, "transcripts", "ap-persist.log")
    await mkdir(dirname(transcriptPath), { recursive: true })

    let appRoot: string

    try {
      const { tarballs } = await createPackagedInstaller({
        packageNames: [...SCAFFOLD_PACKAGES],
        tempRoot,
        transcriptPath,
      })

      const generatedApp = await createGeneratedApp({
        appName: "ap-persist",
        artifactRoot: artifactBaseDir,
        specifiers: {
          dawnCli: tarballs["@dawn-ai/cli"],
          dawnConfigTypescript: tarballs["@dawn-ai/config-typescript"],
          dawnCore: tarballs["@dawn-ai/core"],
          dawnLangchain: tarballs["@dawn-ai/langchain"],
        },
        template: "basic",
      })

      appRoot = generatedApp.appRoot

      // Rewrite dependencies to tarballs (mirrors run-runtime-contract.test.ts)
      await rewriteGeneratedAppDependencies({
        appRoot,
        tarballs,
        extraDependencies: {
          "@dawn-ai/memory": tarballs["@dawn-ai/memory"]!,
          "@dawn-ai/permissions": tarballs["@dawn-ai/permissions"]!,
          "@dawn-ai/sqlite-storage": tarballs["@dawn-ai/sqlite-storage"]!,
          "@dawn-ai/workspace": tarballs["@dawn-ai/workspace"]!,
          "@langchain/langgraph": "1.3.0",
        },
        removeDependencies: ["langchain", "@langchain/openai"],
      })

      // Write the echo-agent route overlay
      const routeFile = join(appRoot, "src/app/echo/index.ts")
      await mkdir(dirname(routeFile), { recursive: true })
      await writeFile(routeFile, echoAgentOverlaySource(), "utf8")

      // Install
      const { spawnProcess } = await import("../../packages/devkit/src/testing/index.ts")
      const installResult = await spawnProcess({
        args: ["install"],
        command: "pnpm",
        cwd: appRoot,
        env: { NODE_NO_WARNINGS: "1" },
      })
      if (!installResult.ok) {
        throw new Error(`pnpm install failed:\n${installResult.stdout}\n${installResult.stderr}`)
      }
    } catch (error) {
      markTrackedTempDirForPreserve(tempDirs, tempRoot)
      throw error
    }

    // ------------------------------------------------------------------
    // 2. First server start — create thread, run it, capture state
    // ------------------------------------------------------------------
    const threadId = `t-ap-persist-${Date.now()}`
    const routeKey = "/echo#agent"
    const input = { messages: [{ role: "user", content: "hello from persistence test" }] }

    const port1 = await allocatePort()
    const server1 = await startDevServer({ cwd: appRoot, port: port1 })

    let stateBefore: Record<string, unknown>
    try {
      const url1 = await server1.waitForReady(30_000)

      // Create the thread
      const createThreadResp = await fetch(new URL("/threads", url1), {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      expect(createThreadResp.status).toBe(200)
      // Discard the thread_id — we use our deterministic threadId by calling
      // runs/wait directly (the server will idempotently create the thread).
      await createThreadResp.json()

      // Run the agent — this writes a checkpoint to .dawn/checkpoints.sqlite
      const runsWaitResp = await fetch(
        new URL(`/threads/${encodeURIComponent(threadId)}/runs/wait`, url1),
        {
          body: JSON.stringify({ input, route: routeKey }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      )
      expect(
        runsWaitResp.status,
        `runs/wait failed with ${runsWaitResp.status}: ${await runsWaitResp.clone().text()}`,
      ).toBe(200)

      // Fetch the state from the first server
      const stateResp1 = await fetch(
        new URL(`/threads/${encodeURIComponent(threadId)}/state`, url1),
      )
      expect(
        stateResp1.status,
        `GET /state failed with ${stateResp1.status} on first server: ${await stateResp1.clone().text()}`,
      ).toBe(200)
      stateBefore = (await stateResp1.json()) as Record<string, unknown>

      // Sanity-check: the checkpoint has messages
      const values = stateBefore.values as Record<string, unknown> | undefined
      expect(values).toBeDefined()
      expect(Array.isArray(values?.messages)).toBe(true)
      expect((values?.messages as unknown[]).length).toBeGreaterThan(0)
    } finally {
      await server1.stop()
      await appendDevServerTranscript(transcriptPath, server1)
    }

    // ------------------------------------------------------------------
    // 3. Restart on a new port (same appRoot → same .dawn directory)
    // ------------------------------------------------------------------
    const port2 = await allocatePort()
    const server2 = await startDevServer({ cwd: appRoot, port: port2 })

    try {
      const url2 = await server2.waitForReady(30_000)

      // Re-fetch state from the second server
      const stateResp2 = await fetch(
        new URL(`/threads/${encodeURIComponent(threadId)}/state`, url2),
      )
      expect(
        stateResp2.status,
        `GET /state failed with ${stateResp2.status} on second server: ${await stateResp2.clone().text()}`,
      ).toBe(200)
      const stateAfter = (await stateResp2.json()) as Record<string, unknown>

      // ------------------------------------------------------------------
      // 4. Assert state matches across restart
      // ------------------------------------------------------------------
      const valuesBefore = stateBefore.values as Record<string, unknown>
      const valuesAfter = stateAfter.values as Record<string, unknown>

      const msgsBefore = valuesBefore.messages as unknown[]
      const msgsAfter = valuesAfter.messages as unknown[]

      expect(msgsAfter.length).toBe(msgsBefore.length)
      // Verify the config (thread_id) is preserved
      expect((stateAfter.config as Record<string, unknown> | undefined)?.configurable).toEqual(
        (stateBefore.config as Record<string, unknown> | undefined)?.configurable,
      )
    } finally {
      await server2.stop()
      await appendDevServerTranscript(transcriptPath, server2)
    }
  })
})
