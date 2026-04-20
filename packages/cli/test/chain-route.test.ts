import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { executeRoute } from "../src/lib/runtime/execute-route.js"

describe("chain route execution", () => {
  let appRoot: string

  afterEach(async () => {
    if (appRoot) {
      await rm(appRoot, { recursive: true, force: true })
    }
  })

  test("executes a chain route with invoke", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "dawn-chain-"))
    await mkdir(join(appRoot, "src", "app", "hello"), { recursive: true })
    await writeFile(join(appRoot, "package.json"), "{}\n")
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {}")
    await writeFile(
      join(appRoot, "src", "app", "hello", "index.ts"),
      `
export const chain = {
  invoke: async (input) => ({ result: "chain works", input }),
  stream: async function* (input) {
    yield { chunk: "hello" }
    yield { chunk: "world" }
  },
}
`,
    )

    const result = await executeRoute({
      appRoot,
      input: { message: "test" },
      routeFile: join(appRoot, "src", "app", "hello", "index.ts"),
    })

    expect(result.status).toBe("passed")
    if (result.status === "passed") {
      expect(result.mode).toBe("chain")
      expect(result.output).toEqual({ result: "chain works", input: { message: "test" } })
    }
  })

  test("fails with clear error when chain entry has no invoke", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "dawn-chain-"))
    await mkdir(join(appRoot, "src", "app", "broken"), { recursive: true })
    await writeFile(join(appRoot, "package.json"), "{}\n")
    await writeFile(join(appRoot, "dawn.config.ts"), "export default {}")
    await writeFile(
      join(appRoot, "src", "app", "broken", "index.ts"),
      `export const chain = "not a runnable"`,
    )

    const result = await executeRoute({
      appRoot,
      input: {},
      routeFile: join(appRoot, "src", "app", "broken", "index.ts"),
    })

    expect(result.status).toBe("failed")
    if (result.status === "failed") {
      expect(result.error.message).toContain("invoke")
    }
  })
})
