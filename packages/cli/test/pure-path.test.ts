import { basename, dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

import { pureBasename, pureDirname, pureJoin } from "../src/lib/runtime/pure-path.js"

describe("pure-path parity with node:path (posix inputs)", () => {
  const paths = [
    "",
    "/",
    "//",
    "///",
    "a",
    "a/",
    "a//",
    "/a",
    "/a/",
    "./x",
    "../x",
    "..",
    ".",
    "a/b/../c",
    "a/../../b",
    "/a//b/",
    "x/./y",
    "memory.ts",
    "/a/b/c.ts",
    "/a/b/",
    "a/b/../c/",
    "/app/routes/(group)/chat/index.ts",
    "/very/deep/nested/path/to/some/file.test.ts",
    "name.with.dots.ts",
    "/a/.hidden",
    ".hidden",
    "a/b.d/c",
  ] as const

  it("pureDirname matches node:path dirname", () => {
    for (const p of paths) {
      expect(pureDirname(p), `dirname(${JSON.stringify(p)})`).toBe(dirname(p))
    }
  })

  it("pureBasename matches node:path basename", () => {
    for (const p of paths) {
      expect(pureBasename(p), `basename(${JSON.stringify(p)})`).toBe(basename(p))
    }
  })

  it("pureJoin matches node:path join", () => {
    const tuples: readonly (readonly string[])[] = [
      ["/app", ".dawn/threads.sqlite"],
      ["/a", "b", "..", "c"],
      ["a", "b"],
      ["a", ""],
      ["", ""],
      ["/", ".."],
      ["..", "a"],
      ["a", "/b"],
      [".", "x"],
      ["/appRoot", ".dawn", "memory.sqlite"],
      ["/appRoot", "workspace"],
      ["a/", "/b/"],
      ["..", ".."],
      ["/a/b", "../../.."],
      ["a", ".", "b", ".", "c"],
      ["/route/dir", "memory.ts"],
      ["", "x"],
    ]
    for (const parts of tuples) {
      expect(pureJoin(...parts), `join(${JSON.stringify(parts)})`).toBe(join(...parts))
    }
  })
})
