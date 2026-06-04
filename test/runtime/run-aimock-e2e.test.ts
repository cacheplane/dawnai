import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { afterAll, expect, it } from "vitest"
import { createGeneratedApp } from "../../packages/devkit/src/testing/index.ts"
import {
  cleanupTrackedTempDirs,
  createPackagedInstaller,
  createTrackedTempDir,
  markTrackedTempDirForPreserve,
  type TrackedTempDir,
} from "../harness/packaged-app.ts"
import { allocatePort, startDevServer } from "./support/dev-server.ts"
import { startAimock } from "./support/aimock-runner.ts"

// ---------------------------------------------------------------------------
// Temp dir registry
// ---------------------------------------------------------------------------

const tempDirs: TrackedTempDir[] = []

afterAll(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

// ---------------------------------------------------------------------------
// Agent route source — minimal SDK agent (mirrors permAgentRouteSource shape)
// ---------------------------------------------------------------------------

function chatAgentRouteSource(): string {
  return `
import { agent } from "@dawn-ai/sdk";

export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a test agent. Use the provided tools when asked.",
});
`.trimStart()
}

// ---------------------------------------------------------------------------
// Tool sources
// ---------------------------------------------------------------------------

function applyFilterSource(): string {
  return `
/** Apply a structured filter to records and return how many matched, echoing the input back. */
export default async function applyFilter(input: {
  filter: { status: "open" | "closed"; tags: string[] }
  pagination?: { limit: number; cursor?: string }
  labels?: Record<string, string>
  sort: { by: "date"; dir: "asc" | "desc" } | { by: "name" }
}): Promise<{ matched: number; echo: unknown }> {
  return { matched: input.filter.tags.length, echo: input }
}
`.trimStart()
}

function generateReportSource(): string {
  return `
/** Generate a large diagnostic report (used to exercise tool-output offloading). */
export default async function generateReport(input: { rows: number }): Promise<string> {
  const n = Math.max(input.rows, 2000)
  const lines: string[] = []
  for (let i = 0; i < n; i++) lines.push(\`row \${i}: \${"x".repeat(40)} value=\${i * 7}\`)
  lines.push("MARKER-DEEP-INSIDE-NEEDLE-42")
  return lines.join("\\n")
}
`.trimStart()
}

// ---------------------------------------------------------------------------
// Package.json rewriter (mirrors run-agent-protocol.test.ts)
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
    // Required so route files can import langgraph directly (pnpm strict isolation)
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

// ---------------------------------------------------------------------------
// buildProbeApp — packs all packages, generates app, writes tools + route
// ---------------------------------------------------------------------------

async function buildProbeApp(): Promise<{ appRoot: string }> {
  const tempRoot = await createTrackedTempDir("aimock-probe-", tempDirs)

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
    })

    const generatedApp = await createGeneratedApp({
      appName: "aimock-probe",
      artifactRoot: tempRoot,
      specifiers: {
        dawnCli: tarballs["@dawn-ai/cli"],
        dawnConfigTypescript: tarballs["@dawn-ai/config-typescript"],
        dawnCore: tarballs["@dawn-ai/core"],
        dawnLangchain: tarballs["@dawn-ai/langchain"],
      },
      template: "basic",
    })

    const { appRoot } = generatedApp

    await rewriteDependenciesToTarballs({ appRoot, tarballs })

    // Write agent route at src/app/chat/index.ts
    const routeFile = join(appRoot, "src/app/chat/index.ts")
    await mkdir(dirname(routeFile), { recursive: true })
    await writeFile(routeFile, chatAgentRouteSource(), "utf8")

    // Write tool: applyFilter
    const applyFilterFile = join(appRoot, "src/app/chat/tools/applyFilter.ts")
    await mkdir(dirname(applyFilterFile), { recursive: true })
    await writeFile(applyFilterFile, applyFilterSource(), "utf8")

    // Write tool: generateReport
    const generateReportFile = join(appRoot, "src/app/chat/tools/generateReport.ts")
    await writeFile(generateReportFile, generateReportSource(), "utf8")

    // Create workspace/ so the offload capability activates
    await mkdir(join(appRoot, "workspace"), { recursive: true })

    // Run pnpm install
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

    return { appRoot }
  } catch (error) {
    markTrackedTempDirForPreserve(tempDirs, tempRoot)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Smoke test: boot dawn dev against aimock and verify the AP is reachable
// ---------------------------------------------------------------------------

it("boots dawn dev against aimock and serves the AP", async () => {
  const { appRoot } = await buildProbeApp()
  const aimock = await startAimock({
    fixturePath: join(import.meta.dirname, "fixtures/aimock/hello.json"),
  })
  const port = await allocatePort()
  const server = await startDevServer({
    cwd: appRoot,
    port,
    env: { OPENAI_BASE_URL: aimock.baseUrl, OPENAI_API_KEY: "test-not-used" },
  })
  try {
    const url = await server.waitForReady(30_000)
    const res = await fetch(new URL("/threads", url), {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(200)
  } finally {
    await server.stop()
    await aimock.stop()
  }
}, 180_000)

// ---------------------------------------------------------------------------
// SP5 regression: discriminated-union tool argument is accepted by Dawn schema
// ---------------------------------------------------------------------------

it("SP5: a discriminated-union tool argument is accepted by the generated schema", async () => {
  const { appRoot } = await buildProbeApp()
  const aimock = await startAimock({
    fixturePath: join(import.meta.dirname, "fixtures/aimock/sp5-union.json"),
  })
  const port = await allocatePort()
  const server = await startDevServer({
    cwd: appRoot,
    port,
    env: { OPENAI_BASE_URL: aimock.baseUrl, OPENAI_API_KEY: "test-not-used" },
  })
  try {
    const url = await server.waitForReady(30_000)

    const tid = (
      (await (
        await fetch(new URL("/threads", url), {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        })
      ).json()) as { thread_id: string }
    ).thread_id

    const run = await fetch(new URL(`/threads/${tid}/runs/wait`, url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        route: "/chat#agent",
        input: {
          messages: [
            {
              role: "user",
              content: "Filter the open urgent/backend items, newest first.",
            },
          ],
        },
      }),
    })

    const rawBody = await run.text()
    expect(run.status, `runs/wait returned ${run.status}: ${rawBody}`).toBe(200)

    const state = JSON.parse(rawBody) as { messages?: Array<Record<string, unknown>> }
    const messages = state.messages ?? []

    // Find the applyFilter ToolMessage — LangChain JsonPlusSerializer shape:
    // { id: ["langchain_core", "messages", "ToolMessage"], kwargs: { name, content } }
    const toolMsg = messages.find((m) => {
      const id = (m as { id?: string[] }).id
      const kw = (m as { kwargs?: { name?: string } }).kwargs
      if (Array.isArray(id) && id[2] === "ToolMessage" && kw?.name === "applyFilter") return true
      // Also accept plain shape: { type: "tool", name: "applyFilter" }
      const typed = m as { type?: string; name?: string; role?: string }
      return (typed.type === "tool" || typed.role === "tool") && typed.name === "applyFilter"
    }) as { kwargs?: { content?: string }; content?: string } | undefined

    expect(toolMsg, `applyFilter ToolMessage not found in: ${JSON.stringify(messages).slice(0, 800)}`).toBeDefined()

    const content =
      toolMsg?.kwargs?.content ?? (typeof toolMsg?.content === "string" ? toolMsg.content : "") ?? ""

    expect(content, `Schema rejection found in tool content: ${content}`).not.toContain(
      "did not match expected schema",
    )
    expect(content, `Invalid input found in tool content: ${content}`).not.toContain("Invalid input")
    expect(content, `Expected "matched":2 in tool content but got: ${content}`).toContain('"matched":2')
  } finally {
    await server.stop()
    await aimock.stop()
  }
}, 120_000)
