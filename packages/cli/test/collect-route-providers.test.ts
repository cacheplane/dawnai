import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { discoverRoutes } from "@dawn-ai/core"
import { afterEach, describe, expect, test } from "vitest"

import { collectRouteProviders } from "../src/lib/runtime/collect-route-providers.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-providers-"))
  tempDirs.push(appRoot)

  const appFiles = {
    "package.json": '{"type":"module"}\n',
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

function agentRoute(model: string, provider?: string): string {
  const providerLine = provider ? `\n  provider: "${provider}",` : ""
  return `import { agent } from "@dawn-ai/sdk"

export default agent({
  model: "${model}",${providerLine}
  systemPrompt: "You do things.",
})
`
}

describe("collectRouteProviders", () => {
  test("infers openai from a gpt- model id", async () => {
    const appRoot = await createFixtureApp({
      "src/app/draft/index.ts": agentRoute("gpt-5-mini"),
    })
    const manifest = await discoverRoutes({ appRoot })

    expect(await collectRouteProviders(manifest)).toEqual(["openai"])
  })

  test("infers anthropic from a claude- model id", async () => {
    const appRoot = await createFixtureApp({
      "src/app/draft/index.ts": agentRoute("claude-sonnet-4-5"),
    })
    const manifest = await discoverRoutes({ appRoot })

    expect(await collectRouteProviders(manifest)).toEqual(["anthropic"])
  })

  test("unions providers across routes and dedupes", async () => {
    const appRoot = await createFixtureApp({
      "src/app/a/index.ts": agentRoute("gpt-5-mini"),
      "src/app/b/index.ts": agentRoute("claude-sonnet-4-5"),
      "src/app/c/index.ts": agentRoute("gpt-5.5"),
    })
    const manifest = await discoverRoutes({ appRoot })

    expect([...(await collectRouteProviders(manifest))].sort()).toEqual(["anthropic", "openai"])
  })

  test("honors an explicit provider over the inferred one", async () => {
    const appRoot = await createFixtureApp({
      "src/app/draft/index.ts": agentRoute("some-proxy-model", "ollama"),
    })
    const manifest = await discoverRoutes({ appRoot })

    expect(await collectRouteProviders(manifest)).toEqual(["ollama"])
  })

  test("skips non-agent routes", async () => {
    const appRoot = await createFixtureApp({
      "src/app/wf/index.ts": "export async function workflow() { return {} }\n",
    })
    const manifest = await discoverRoutes({ appRoot })

    expect(await collectRouteProviders(manifest)).toEqual([])
  })
})
