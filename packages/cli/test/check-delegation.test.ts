import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { discoverRoutes } from "@dawn-ai/core/node"
import { afterEach, describe, expect, it } from "vitest"

import { checkToolNameUniqueness } from "../src/lib/runtime/check-tool-name-uniqueness.js"
import { collectDelegationErrors } from "../src/lib/runtime/collect-delegation-errors.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

const child = `import { agent } from "@dawn-ai/sdk"
export default agent({ model: "gpt-5-mini", systemPrompt: "Child." })
`

async function collect(files: Readonly<Record<string, string>>): Promise<readonly string[]> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-check-delegation-"))
  tempDirs.push(appRoot)
  const allFiles = {
    "package.json": '{"type":"module"}\n',
    "dawn.config.ts": "export default {}\n",
    ...files,
  }
  await Promise.all(
    Object.entries(allFiles).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )
  return collectDelegationErrors(await discoverRoutes({ appRoot }))
}

function parent(body: string, imports = ""): string {
  return `${imports}import { agent } from "@dawn-ai/sdk"
export default agent({ model: "gpt-5-mini", systemPrompt: "Parent.", ${body} } as any)
`
}

describe("collectDelegationErrors", () => {
  it("validates convention children for a legacy Runnable agent parent", async () => {
    const errors = await collect({
      "src/app/parent/index.ts": `export const agent = {
  invoke: async () => ({ messages: [] }),
}
`,
      "src/app/parent/subagents/bad.name/index.ts": child,
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/\[DAWN_E1004\].*Invalid convention subagent name "bad\.name"/)
  })

  it("rejects when registry resolution throws an unexpected error", async () => {
    await expect(
      collect({
        "src/app/parent/index.ts": `const descriptor = {
  [Symbol.for("dawn.agent")]: true,
  model: "gpt-5-mini",
  systemPrompt: "Parent.",
  get delegation() {
    throw new Error("unexpected delegation accessor")
  },
}
export default descriptor
`,
      }),
    ).rejects.toThrow("unexpected delegation accessor")
  })

  it.each([
    {
      name: "unknown explicit rule",
      parent: parent(
        'subagents: { child }, delegation: { rules: { missing: { action: "allow" } } }',
        'import child from "./subagents/child/index.js"\n',
      ),
      extra: { "src/app/parent/subagents/child/index.ts": child },
      message: /Unknown rule name "missing".*Available explicit names: child/,
    },
    {
      name: "invalid registration name",
      parent: parent(
        'subagents: { ["bad name"]: child }',
        'import child from "./subagents/child/index.js"\n',
      ),
      extra: { "src/app/parent/subagents/child/index.ts": child },
      message: /Invalid explicit subagent name "bad name"/,
    },
    {
      name: "invalid convention name",
      parent: parent(""),
      extra: { "src/app/parent/subagents/bad.name/index.ts": child },
      message: /Invalid convention subagent name "bad\.name"/,
    },
    {
      name: "non-agent registration",
      parent: parent("subagents: { child: {} }"),
      extra: {},
      message: /Explicit subagent "child" must reference a Dawn agent descriptor/,
    },
    {
      name: "unresolved descriptor",
      parent: parent("subagents: { orphan }", 'import orphan from "../../orphan.js"\n'),
      extra: { "src/orphan.ts": child },
      message: /resolves to no route/,
    },
    {
      name: "ambiguous descriptor",
      parent: parent("subagents: { shared }", 'import shared from "../../shared.js"\n'),
      extra: {
        "src/shared.ts": child,
        "src/app/alpha/index.ts": 'export { default } from "../../shared.js"\n',
        "src/app/beta/index.ts": 'export { default } from "../../shared.js"\n',
      },
      message: /ambiguous; candidate routes: \/alpha, \/beta/,
    },
    {
      name: "duplicate route registration",
      parent: parent(
        "subagents: { first: child, second: child }",
        'import child from "./subagents/child/index.js"\n',
      ),
      extra: { "src/app/parent/subagents/child/index.ts": child },
      message: /registered more than once under explicit names/,
    },
    {
      name: "explicit convention identity collision",
      parent: parent(
        "subagents: { researcher: writer }",
        'import writer from "../writer/index.js"\n',
      ),
      extra: {
        "src/app/parent/subagents/researcher/index.ts": child,
        "src/app/writer/index.ts": child,
      },
      message: /Model-facing name collision for "researcher"/,
    },
    {
      name: "array registry",
      parent: parent("subagents: [child]", 'import child from "./subagents/child/index.js"\n'),
      extra: { "src/app/parent/subagents/child/index.ts": child },
      message: /subagents must be a keyed object/,
    },
    {
      name: "malformed delegation object",
      parent: parent('delegation: "allow"'),
      extra: {},
      message: /delegation must be an object/,
    },
    {
      name: "malformed rules object",
      parent: parent("delegation: { rules: [] }"),
      extra: {},
      message: /delegation\.rules must be an object/,
    },
    {
      name: "malformed default",
      parent: parent('delegation: { default: "sometimes" }'),
      extra: {},
      message: /delegation\.default must be/,
    },
    {
      name: "malformed action",
      parent: parent(
        'subagents: { child }, delegation: { rules: { child: { action: "ask" } } }',
        'import child from "./subagents/child/index.js"\n',
      ),
      extra: { "src/app/parent/subagents/child/index.ts": child },
      message: /invalid action/,
    },
    {
      name: "malformed predicate",
      parent: parent(
        'subagents: { child }, delegation: { rules: { child: { action: "constrain", predicate: true } } }',
        'import child from "./subagents/child/index.js"\n',
      ),
      extra: { "src/app/parent/subagents/child/index.ts": child },
      message: /predicate function/,
    },
    {
      name: "malformed reason",
      parent: parent(
        'subagents: { child }, delegation: { rules: { child: { action: "deny", reason: 42 } } }',
        'import child from "./subagents/child/index.js"\n',
      ),
      extra: { "src/app/parent/subagents/child/index.ts": child },
      message: /non-string reason/,
    },
    {
      name: "multi-action rule",
      parent: parent(
        'subagents: { child }, delegation: { rules: { child: { action: "deny", predicate: async () => true } } }',
        'import child from "./subagents/child/index.js"\n',
      ),
      extra: { "src/app/parent/subagents/child/index.ts": child },
      message: /unknown field\(s\): predicate/,
    },
  ])("reports E1004 for $name", async ({ parent: parentSource, extra, message }) => {
    const errors = await collect({
      "src/app/parent/index.ts": parentSource,
      ...extra,
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/\[DAWN_E1004\]/)
    expect(errors[0]).toMatch(message)
  })

  it.each([
    ["allow", 'tools: { allow: ["task"] }'],
    ["deny", 'tools: { deny: ["task"] }'],
    ["approve", 'tools: { approve: ["task"] }'],
    ["constrain", "tools: { constrain: { task: async () => true } }"],
  ])("reports tools.%s task references as E1004 errors", async (field, body) => {
    const errors = await collect({ "src/app/parent/index.ts": parent(body) })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/\[DAWN_E1004\]/)
    expect(errors[0]).toContain(`tools.${field}`)
    expect(errors[0]).toMatch(/use delegation/i)
  })

  it("reports each reserved task scope field exactly once", async () => {
    const errors = await collect({
      "src/app/parent/index.ts": parent(
        'tools: { allow: ["task", "task"], deny: ["task"], approve: ["task"], constrain: { task: async () => true } }',
      ),
    })

    expect(errors).toHaveLength(4)
    for (const field of ["allow", "deny", "approve", "constrain"]) {
      expect(errors.filter((error) => error.includes(`tools.${field}`))).toHaveLength(1)
    }
  })

  it("keeps authored task tools reserved", () => {
    const result = checkToolNameUniqueness({
      userTools: [{ name: "task" }],
      capabilityTools: [],
      reservedNames: new Set(["task"]),
    })

    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/Reserved tool name.*task/),
    })
  })
})
