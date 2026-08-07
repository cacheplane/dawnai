import { basename, dirname, join, posix } from "node:path"
import { describe, expect, it } from "vitest"

import {
  POSIX_SEP,
  pureBasename,
  pureDirname,
  pureJoin,
  pureRelative,
  pureResolve,
} from "../src/pure/path.js"

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

describe("pureResolve parity with path.posix.resolve", () => {
  // The security-critical case FIRST: an absolute later segment wins.
  const cases: readonly (readonly string[])[] = [
    ["/app/workspace", "/etc/passwd"],
    ["/app/workspace", "notes.txt"],
    ["/app/workspace", "../escape"],
    ["/app/workspace", "./a/./b"],
    ["/app/workspace", ""],
    ["/app/workspace", "a", "/abs", "b"],
    ["/app/workspace/", "sub/"],
    ["/", ".."],
    ["/a/b", "../../../.."],
    ["/app", "a//b"],
  ]

  it("matches node for every case (absolute-wins included)", () => {
    for (const parts of cases) {
      expect(pureResolve(...parts), `resolve(${JSON.stringify(parts)})`).toBe(
        posix.resolve(...parts),
      )
    }
  })

  it("an absolute second argument discards the base — the jail-escape case", () => {
    expect(pureResolve("/app/workspace", "/etc/passwd")).toBe("/etc/passwd")
  })

  it("throws when the base is not absolute (no cwd to fall back on)", () => {
    // Node resolves a relative base against process.cwd(); the pure version has
    // no cwd, so it refuses rather than inventing a root.
    expect(() => pureResolve("workspace", "notes.txt")).toThrow(
      /pureResolve requires an absolute base; got "workspace"/,
    )
    expect(() => pureResolve("./workspace")).toThrow(/requires an absolute base/)
    expect(() => pureResolve("")).toThrow(/requires an absolute base/)
    expect(() => pureResolve()).toThrow(/requires an absolute base/)
  })
})

describe("pureRelative parity with path.posix.relative", () => {
  const pairs: readonly (readonly [string, string])[] = [
    ["/app/workspace", "/app/workspace/tool-outputs/x.txt"],
    ["/app/workspace", "/app/workspace"],
    ["/app/workspace", "/app/workspace-evil/secret"],
    ["/app/workspace", "/etc/passwd"],
    ["/a/b/c", "/a/b"],
    ["/a", "/a/b/c"],
    ["/", "/a/b"],
    ["/a/b", "/"],
    ["/a/b/", "/a/b/c/"],
    ["/a/b/../c", "/a/c/d"],
  ]

  it("matches node for every pair", () => {
    for (const [from, to] of pairs) {
      expect(pureRelative(from, to), `relative(${from}, ${to})`).toBe(posix.relative(from, to))
    }
  })
})

describe("POSIX_SEP", () => {
  it("is the posix separator", () => {
    expect(POSIX_SEP).toBe("/")
    expect(POSIX_SEP).toBe(posix.sep)
  })
})
