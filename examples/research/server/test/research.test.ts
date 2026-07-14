import { rmSync } from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { run as runDawnCli } from "@dawn-ai/cli"
import { afterAll, beforeAll, expect, it } from "vitest"
import type { FixtureSet } from "@dawn-ai/testing"
import {
  createAgentHarness,
  expectFinalMessage,
  expectInterrupt,
  expectOffloaded,
  expectSubagent,
  expectToolCalled,
  seedMemory,
  script,
} from "@dawn-ai/testing"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
const memoryDb = join(appRoot, ".dawn", "memory.sqlite")
const memoryNamespace = `workspace=${basename(appRoot)}|route=/research`
function cleanMemoryDb() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${memoryDb}${suffix}`, { force: true })
}

async function runCli(args: readonly string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runDawnCli(args, {
    stderr: (message) => stderr.push(message),
    stdout: (message) => stdout.push(message),
  })
  expect(stderr.join("")).toBe("")
  expect(code).toBe(0)
  return stdout.join("")
}

beforeAll(cleanMemoryDb)
const h = await createAgentHarness({ appRoot, route: "/research#agent" })
afterAll(async () => {
  await h.close()
  cleanMemoryDb()
})

it("searches the corpus and writes a cited answer", async () => {
  h.reset()
  const run = await h.run({
    input: "What are common agent architectures?",
    fixtures: script()
      .user("What are common agent architectures?")
      .callsTool("searchCorpus", { query: "agent architectures" })
      .callsTool("readDoc", { path: "corpus/agent-architectures.md" })
      .replies("ReAct and plan-and-execute are common. [corpus/agent-architectures.md]"),
  })
  expectToolCalled(run, "searchCorpus")
  expectToolCalled(run, "readDoc")
  expectFinalMessage(run).toContain("[corpus/")
}, 60_000)

it("recalls seeded durable research preferences", async () => {
  h.reset()
  await seedMemory({ path: memoryDb }, [
    {
      id: "memory_report_style",
      namespace: memoryNamespace,
      content: "The user prefers concise executive summaries before detailed research findings.",
      data: { subject: "user", predicate: "prefers-report-style", value: "concise-summary-first" },
      tags: ["preference"],
    },
  ])
  const run = await h.run({
    input: "Research agent architectures with my preferences in mind.",
    fixtures: script()
      .user("Research agent architectures with my preferences in mind.")
      .callsTool("recall", { query: "concise executive summaries" })
      .replies("I will lead with a concise executive summary."),
  })
  expectToolCalled(run, "recall")
  expect(String(run.toolResults.find((t) => t.name === "recall")?.content ?? "")).toContain(
    "concise executive summaries",
  )
  expectFinalMessage(run).toContain("concise")
}, 60_000)

it("stores durable findings as reviewable memory candidates", async () => {
  h.reset()
  const run = await h.run({
    input: "Remember that I want every research report to include primary sources.",
    fixtures: script()
      .user("Remember that I want every research report to include primary sources.")
      .callsTool("remember", {
        data: {
          subject: "user",
          predicate: "prefers-source-quality",
          value: "primary-sources",
        },
        content: "The user wants every research report to include primary sources.",
      })
      .replies("Saved as a memory candidate for review."),
  })
  expectToolCalled(run, "remember")
  expectFinalMessage(run).toContain("candidate")
}, 60_000)

it("approves a memory candidate through the CLI and recalls it in a fresh thread", async () => {
  h.reset()
  const stored = await h.run({
    input: "Remember that I prefer source appendices in research reports.",
    fixtures: script()
      .user("Remember that I prefer source appendices in research reports.")
      .callsTool("remember", {
        data: {
          subject: "user",
          predicate: "prefers-report-appendix",
          value: "source-appendix",
        },
        content: "The user prefers source appendices in research reports.",
      })
      .replies("Saved as a memory candidate for review."),
  })
  expectToolCalled(stored, "remember")

  const list = await runCli(["memory", "--cwd", appRoot, "list"])
  expect(list).toContain("source appendices")
  const id = list.match(/^(memory_[a-f0-9]+) \[candidate\].*source appendices/m)?.[1]
  expect(id).toBeDefined()

  const approved = await runCli(["memory", "--cwd", appRoot, "approve", id ?? ""])
  expect(approved).toContain(`Approved: ${id}`)

  h.reset()
  const recalled = await h.run({
    input: "What report appendix preference should you remember?",
    fixtures: script()
      .user("What report appendix preference should you remember?")
      .callsTool("recall", { query: "source appendices" })
      .replies("You prefer source appendices in research reports."),
  })
  expectToolCalled(recalled, "recall")
  expect(String(recalled.toolResults.find((t) => t.name === "recall")?.content ?? "")).toContain(
    "source appendices",
  )
}, 60_000)

it("dispatches the researcher subagent with access to shared corpus tools", async () => {
  h.reset()
  const subQuestion = "What are common agent architectures?"
  const run = await h.run({
    input: "Research agent architectures",
    fixtures: script()
      .user("Research agent architectures")
      .callsTool("task", { subagent: "researcher", input: subQuestion })
      .replies("Done — see the cited summary.")
      .user(subQuestion)
      .callsTool("searchCorpus", { query: "agent architectures" })
      .callsTool("readDoc", { path: "corpus/agent-architectures.md" })
      .replies("ReAct and plan-and-execute are common. [corpus/agent-architectures.md]"),
  })
  expectSubagent(run, "researcher").called().calledTool("searchCorpus").calledTool("readDoc")
}, 60_000)

it("offloads a large readDoc result", async () => {
  h.reset()
  const fixtures: FixtureSet = [
    {
      match: { turnIndex: 0, hasToolResult: false },
      response: {
        toolCalls: [
          {
            id: "call_read_big_1",
            name: "readDoc",
            arguments: { path: "corpus/context-windows-and-offloading.md" },
          },
        ],
      },
    },
    { match: { hasToolResult: true }, response: { content: "Summarized the offloaded document." } },
  ]
  const run = await h.run({
    input: "Summarize the context-windows document.",
    fixtures,
  })
  expectOffloaded(run, "readDoc")
  expectFinalMessage(run).toContain("Summarized")
}, 60_000)

it("gates the external fetch behind a permission prompt, then resumes", async () => {
  h.reset()
  const run = await h.run({
    input: "Fetch external context on context windows",
    fixtures: script()
      .user("Fetch external context on context windows")
      .callsTool("runBash", { command: "node scripts/fetch-source.mjs context windows" })
      .replies("Fetched external context."),
  })
  expectInterrupt(run).ofKind("command").withDetail({
    command: "node scripts/fetch-source.mjs context windows",
  })
  const resumed = await h.resume({ decision: "once" })
  expectToolCalled(resumed, "runBash")
}, 60_000)
