import { join } from "node:path"
import type { FilesystemBackend, FilesystemMiddleware } from "@dawn-ai/workspace"
import { afterEach, expect, it } from "vitest"
import { createMiddlewareHarness, type MiddlewareHarness } from "../src/middleware-harness.js"

const open: MiddlewareHarness[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()))
})

const withLog =
  (log: string[]): FilesystemMiddleware =>
  (next) => ({
    readFile: (p, c, o) => {
      log.push(`read ${p}`)
      return next.readFile(p, c, o)
    },
    writeFile: (p, content, c) => {
      log.push(`write ${p}`)
      return next.writeFile(p, content, c)
    },
    listDir: (p, c) => next.listDir(p, c),
    realPath: (p, c) => next.realPath(p, c),
    ...(next.readBinaryFile && { readBinaryFile: next.readBinaryFile.bind(next) }),
    ...(next.statFile && { statFile: next.statFile.bind(next) }),
    ...(next.removeFile && { removeFile: next.removeFile.bind(next) }),
    ...(next.touchFile && { touchFile: next.touchFile.bind(next) }),
    ...(next.mkdir && { mkdir: next.mkdir.bind(next) }),
  })

it("composes the middleware over a temp backend and records calls while serving I/O", async () => {
  const log: string[] = []
  const h = await createMiddlewareHarness(withLog(log))
  open.push(h)
  const file = join(h.dir, "a.md")
  await h.backend.writeFile(file, "hi", h.ctx)
  expect(await h.backend.readFile(file, h.ctx)).toBe("hi")
  expect(log).toEqual([`write ${file}`, `read ${file}`])
})

it("assertForwardsAll passes for a complete middleware", async () => {
  const h = await createMiddlewareHarness(withLog([]))
  open.push(h)
  expect(() => h.assertForwardsAll()).not.toThrow()
})

it("assertForwardsAll throws for a middleware that drops realPath", async () => {
  const incomplete: FilesystemMiddleware = (next) =>
    ({
      readFile: next.readFile,
      writeFile: next.writeFile,
      listDir: next.listDir,
      // realPath (and the optional methods) omitted
    }) as unknown as FilesystemBackend
  const h = await createMiddlewareHarness(incomplete)
  open.push(h)
  expect(() => h.assertForwardsAll()).toThrow(/realPath/)
})
