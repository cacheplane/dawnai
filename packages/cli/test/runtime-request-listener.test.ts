import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"
import { createRuntimeRequestListener } from "../src/lib/dev/runtime-server.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

it("builds a request listener without binding a port", async () => {
  const appRoot = await createFixtureApp({
    "dawn.config.ts": "export default {};\n",
    "package.json": "{}\n",
    "src/app/noop/index.ts": "export const graph = async () => ({ ok: true });\n",
  })
  const { listener, close } = await createRuntimeRequestListener({ appRoot })
  expect(typeof listener).toBe("function")
  expect(listener.length).toBe(2) // (req, res)
  await close()
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-listener-"))
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
