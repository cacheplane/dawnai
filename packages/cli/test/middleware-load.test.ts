import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { loadMiddleware } from "../src/lib/dev/middleware-node.js"

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
  )
})

async function makeAppRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dawn-middleware-"))
  roots.push(root)
  await mkdir(join(root, "src"), { recursive: true })
  return root
}

async function writeMiddleware(
  root: string,
  source: string,
  at = "src/middleware.ts",
): Promise<string> {
  const file = join(root, at)
  await mkdir(join(file, ".."), { recursive: true })
  await writeFile(file, source, "utf8")
  return file
}

const WORKING_MIDDLEWARE = 'export default async () => ({ action: "continue" })\n'

describe("loadMiddleware — an app with no middleware file", () => {
  it("resolves undefined, with no throw and no warning", async () => {
    const root = await makeAppRoot()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    await expect(loadMiddleware(root)).resolves.toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("loadMiddleware — a middleware file that loads", () => {
  it("binds the exported function", async () => {
    const root = await makeAppRoot()
    await writeMiddleware(root, WORKING_MIDDLEWARE)

    const middleware = await loadMiddleware(root)
    expect(middleware).toBeTypeOf("function")
  })

  it("prefers src/middleware.ts over a root middleware.ts", async () => {
    const root = await makeAppRoot()
    await writeMiddleware(root, 'export default async () => ({ action: "continue" })\n')
    await writeMiddleware(
      root,
      "throw new Error('root middleware must not be loaded')\n",
      "middleware.ts",
    )

    await expect(loadMiddleware(root)).resolves.toBeTypeOf("function")
  })
})

describe("loadMiddleware — a middleware file that cannot be imported", () => {
  it("throws, naming the file and the cause, instead of behaving as if absent", async () => {
    const root = await makeAppRoot()
    const file = await writeMiddleware(root, 'throw new Error("MIDDLEWARE_BOOM")\n')

    await expect(loadMiddleware(root)).rejects.toThrow(/MIDDLEWARE_BOOM/)
    await expect(loadMiddleware(root)).rejects.toThrow(
      new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    )
  })

  it("carries the DAWN_E3004 error code", async () => {
    const root = await makeAppRoot()
    await writeMiddleware(root, 'throw new Error("MIDDLEWARE_BOOM")\n')

    await expect(loadMiddleware(root)).rejects.toMatchObject({ code: "DAWN_E3004" })
  })

  it("does not fall through to a later candidate that would load", async () => {
    const root = await makeAppRoot()
    await writeMiddleware(root, 'throw new Error("MIDDLEWARE_BOOM")\n')
    await writeMiddleware(root, WORKING_MIDDLEWARE, "middleware.ts")

    await expect(loadMiddleware(root)).rejects.toThrow(/MIDDLEWARE_BOOM/)
  })
})

describe("loadMiddleware — the import specifier", () => {
  it("is a file:// URL, never a raw filesystem path", async () => {
    const root = await makeAppRoot()
    const file = await writeMiddleware(root, WORKING_MIDDLEWARE)
    const seen: string[] = []

    await loadMiddleware(root, {
      importModule: async (href) => {
        seen.push(href)
        return { default: async () => ({ action: "continue" }) }
      },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^file:\/\//)
    expect(seen[0]).not.toBe(file)
  })
})

describe("loadMiddleware — a candidate that cannot be probed", () => {
  it("throws rather than reading the failure as absence", async () => {
    const root = await makeAppRoot()
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })

    await expect(
      loadMiddleware(root, {
        statPath: () => {
          throw denied
        },
      }),
    ).rejects.toThrow(/EACCES/)
  })

  it("still treats ENOENT and ENOTDIR as genuine absence", async () => {
    const root = await makeAppRoot()

    for (const code of ["ENOENT", "ENOTDIR"]) {
      await expect(
        loadMiddleware(root, {
          statPath: () => {
            throw Object.assign(new Error(`${code}: nope`), { code })
          },
        }),
      ).resolves.toBeUndefined()
    }
  })

  it("treats a dangling symlink as present and fails loudly", async () => {
    const root = await makeAppRoot()
    await symlink(join(root, "src", "does-not-exist.ts"), join(root, "src", "middleware.ts"))

    await expect(loadMiddleware(root)).rejects.toThrow(/middleware\.ts/)
  })
})

describe("loadMiddleware — a middleware file that binds nothing", () => {
  it("warns, naming the file, instead of silently behaving as if absent", async () => {
    const root = await makeAppRoot()
    const file = await writeMiddleware(root, "export const notMiddleware = 1\n")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    await expect(loadMiddleware(root)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(file)
  })
})
