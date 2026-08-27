import { constants } from "node:fs"
import { access, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import {
  createAgentHarness,
  expectFinalMessage,
  expectToolCalled,
  script,
} from "@dawn-ai/testing"
import { dockerSandbox } from "@dawn-ai/sandbox"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
const enabled = process.env.DAWN_DEMO_DOCKER_SANDBOX === "1"
const sandboxOnlyPath = "reports/sandbox-only.md"
const hostSandboxOnlyPath = join(appRoot, "workspace", sandboxOnlyPath)

it.skipIf(!enabled)(
  "runs shared corpus tools against an isolated Docker sandbox workspace without touching host files",
  async () => {
    // This import is intentionally used by the test file so `npm run
    // test:sandbox:docker` proves the generated app can resolve the sandbox
    // package before dawn.config.ts creates the provider.
    void dockerSandbox
    await rm(hostSandboxOnlyPath, { force: true })

    const h = await createAgentHarness({ appRoot, route: "/research#agent" })
    try {
      const run = await h.run({
        input: "Seed and search the sandbox corpus for agent architectures.",
        fixtures: script()
          .user("Seed and search the sandbox corpus for agent architectures.")
          .callsTool("writeFile", {
            path: "corpus/agent-architectures.md",
            content:
              "# Agent Architectures\n\nPlan-and-execute agents split planning from execution and use specialist workers for focused research.",
          })
          .callsTool("writeFile", {
            path: sandboxOnlyPath,
            content: "This file should exist only in the thread sandbox.",
          })
          .callsTool("searchCorpus", { query: "plan execute specialist workers" })
          .callsTool("readDoc", { path: "corpus/agent-architectures.md" })
          .replies(
            "Plan-and-execute agents split planning from execution. [corpus/agent-architectures.md]",
          ),
      })
      expectToolCalled(run, "writeFile")
      expectToolCalled(run, "searchCorpus")
      expectToolCalled(run, "readDoc")
      expectFinalMessage(run).toContain("[corpus/agent-architectures.md]")
      await expect(access(hostSandboxOnlyPath, constants.F_OK)).rejects.toThrow()

      h.reset()
      const isolated = await h.run({
        input: "Read the sandbox-only report from a fresh thread.",
        fixtures: script()
          .user("Read the sandbox-only report from a fresh thread.")
          .callsTool("readFile", { path: sandboxOnlyPath })
          .replies("The fresh thread could not read the sandbox-only report."),
      })
      expectToolCalled(isolated, "readFile")
      expect(isolated.toolResults.find((t) => t.name === "readFile")?.isError).toBe(true)
    } finally {
      await h.close()
    }
  },
  120_000,
)
