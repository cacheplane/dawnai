import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  cleanupTrackedTempDirs,
  createPackagedInstaller,
  createTrackedTempDir,
  markTrackedTempDirForPreserve,
  type TrackedTempDir,
} from "../harness/packaged-app.ts"
import {
  allocatePort,
  appendDevServerTranscript,
  startDevServer,
  type DevServerHandle,
} from "./support/dev-server.ts"
import { createGeneratedApp } from "../../packages/devkit/src/testing/index.ts"

const RUNTIME_ROOT = resolve(import.meta.dirname)
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

describe("agent protocol state persistence", () => {
  it(
    "state survives server kill + restart on a new port",
    { timeout: 300_000 },
    async () => {
      // ------------------------------------------------------------------
      // 1. Build a packed app with the echo-agent overlay
      // ------------------------------------------------------------------
      const tempRoot = await createTrackedTempDir("dap-", tempDirs)
      const artifactBaseDir =
        process.env[HARNESS_RUNTIME_ARTIFACT_BASE_DIR_ENV] ?? tempRoot
      const transcriptPath = join(artifactBaseDir, "transcripts", "ap-persist.log")
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
            "@dawn-ai/permissions",
            "@dawn-ai/sdk",
            "@dawn-ai/sqlite-storage",
            "@dawn-ai/workspace",
          ],
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
        await rewriteDependenciesToTarballs({ appRoot, tarballs })

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
        const createdThread = (await createThreadResp.json()) as { thread_id?: string }
        // Use our deterministic thread_id by calling runs/wait directly (the
        // server will idempotently create the thread if it doesn't exist).

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
    },
  )
})

// ---------------------------------------------------------------------------
// Helpers (mirrors run-runtime-contract.test.ts)
// ---------------------------------------------------------------------------

async function rewriteDependenciesToTarballs(options: {
  readonly appRoot: string
  readonly tarballs: Readonly<Record<string, string>>
}): Promise<void> {
  const packageJsonPath = join(options.appRoot, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    pnpm?: {
      overrides?: Record<string, string>
    }
  }

  delete packageJson.dependencies?.langchain
  delete packageJson.dependencies?.["@langchain/openai"]
  packageJson.dependencies = {
    ...packageJson.dependencies,
    "@dawn-ai/cli": options.tarballs["@dawn-ai/cli"],
    "@dawn-ai/core": options.tarballs["@dawn-ai/core"],
    "@dawn-ai/langchain": options.tarballs["@dawn-ai/langchain"],
    "@dawn-ai/permissions": options.tarballs["@dawn-ai/permissions"],
    "@dawn-ai/sdk": options.tarballs["@dawn-ai/sdk"],
    "@dawn-ai/sqlite-storage": options.tarballs["@dawn-ai/sqlite-storage"],
    "@dawn-ai/workspace": options.tarballs["@dawn-ai/workspace"],
    // Required so the echo-agent route can import it directly (pnpm strict isolation)
    "@langchain/langgraph": "1.3.0",
  }
  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    "@dawn-ai/config-typescript": options.tarballs["@dawn-ai/config-typescript"],
  }
  packageJson.pnpm = {
    ...(packageJson.pnpm ?? {}),
    overrides: {
      ...(packageJson.pnpm?.overrides ?? {}),
      "@dawn-ai/cli": options.tarballs["@dawn-ai/cli"],
      "@dawn-ai/config-typescript": options.tarballs["@dawn-ai/config-typescript"],
      "@dawn-ai/core": options.tarballs["@dawn-ai/core"],
      "@dawn-ai/langchain": options.tarballs["@dawn-ai/langchain"],
      "@dawn-ai/langgraph": options.tarballs["@dawn-ai/langgraph"],
      "@dawn-ai/permissions": options.tarballs["@dawn-ai/permissions"],
      "@dawn-ai/sdk": options.tarballs["@dawn-ai/sdk"],
      "@dawn-ai/sqlite-storage": options.tarballs["@dawn-ai/sqlite-storage"],
      "@dawn-ai/workspace": options.tarballs["@dawn-ai/workspace"],
    },
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
}
