import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import { runBuildCommand } from "../src/commands/build.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-build-"))
  tempDirs.push(appRoot)

  const appFiles = {
    "package.json": "{}\n",
    "dawn.config.ts": "export default {};\n",
    ...files,
  }

  await Promise.all(
    Object.entries(appFiles).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source)
    }),
  )

  return appRoot
}

describe("dawn build", () => {
  test("generates a materialized LangGraph entry for default agent descriptors with tools", async () => {
    const appRoot = await createFixtureApp({
      "src/app/(public)/hello/[tenant]/index.ts": `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Answer tenant support questions.",
})
`,
      "src/app/(public)/hello/[tenant]/tools/tenant-greet.ts": `export const description = "Greet a tenant"
export const schema = {
  type: "object",
  properties: {
    tenant: { type: "string" },
  },
  required: ["tenant"],
}

export default async function tenantGreet(input: { tenant: string }) {
  return { message: \`Hello, \${input.tenant}!\` }
}
`,
    })
    const stdout: string[] = []
    const stderr: string[] = []

    await runBuildCommand(
      { clean: true, cwd: appRoot },
      {
        stderr: (message) => stderr.push(message),
        stdout: (message) => stdout.push(message),
      },
    )

    expect(stderr.join("")).toBe("")

    const entry = await readFile(join(appRoot, ".dawn/build/hello-tenant.ts"), "utf8")
    expect(entry).toContain(
      'import agentDescriptor from "../../src/app/(public)/hello/[tenant]/index.js"',
    )
    expect(entry).toContain(
      'import tool0 from "../../src/app/(public)/hello/[tenant]/tools/tenant-greet.js"',
    )
    expect(entry).toContain('import { materializeAgentGraph } from "@dawn-ai/langchain"')
    expect(entry).toContain('name: "tenant-greet"')
    expect(entry).toContain("export const graph = await materializeAgentGraph({")
    expect(entry).not.toContain("bindTools")
    expect(entry).not.toContain("import { agent }")

    const langgraph = JSON.parse(
      await readFile(join(appRoot, ".dawn/build/langgraph.json"), "utf8"),
    ) as {
      readonly graphs: Record<string, string>
    }
    expect(langgraph.graphs["/hello/[tenant]#agent"]).toBe("./.dawn/build/hello-tenant.ts:graph")
  })
})
