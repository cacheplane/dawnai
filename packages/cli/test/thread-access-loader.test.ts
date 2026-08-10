import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { loadThreadAccess } from "../src/lib/dev/thread-access-node.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function fixtureApp(files: Readonly<Record<string, string>>): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-loader-"))
  tempDirs.push(appRoot)
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  return appRoot
}

const VALID_POLICY = `export default {
  fallback: () => ({ decision: "allow" }),
}
`

describe("loadThreadAccess", () => {
  it("returns undefined when no candidate exists (today's behavior, unchanged)", async () => {
    const appRoot = await fixtureApp({ "package.json": '{"type":"module"}\n' })
    await expect(loadThreadAccess(appRoot)).resolves.toBeUndefined()
  })

  it("binds a default export", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY })
    const policy = await loadThreadAccess(appRoot)
    expect(typeof policy?.fallback).toBe("function")
  })

  it("binds a named threadAccess export", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": `export const threadAccess = {
  fallback: () => ({ decision: "allow" }),
}
`,
    })
    const policy = await loadThreadAccess(appRoot)
    expect(typeof policy?.fallback).toBe("function")
  })

  it("prefers the default export over a named one", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": `export const threadAccess = { fallback: () => ({ decision: "deny" }), tag: "named" }
export default { fallback: () => ({ decision: "allow" }), tag: "default" }
`,
    })
    const policy = await loadThreadAccess(appRoot)
    expect((policy as unknown as { tag: string }).tag).toBe("default")
  })

  it("rejects with DAWN_E3003 when the file cannot be imported", async () => {
    // The case `loadMiddleware` gets wrong: its bare `catch {}` cannot tell
    // "no file" from "file that threw", so a broken policy would boot ungated.
    const appRoot = await fixtureApp({
      "src/thread-access.ts": "export default { fallback: () => ({ decision: 'allow' })\n",
    })
    await expect(loadThreadAccess(appRoot)).rejects.toMatchObject({ code: "DAWN_E3003" })
  })

  it("rejects with DAWN_E3003 when the module binds nothing", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": "export const helper = 1\n" })
    await expect(loadThreadAccess(appRoot)).rejects.toMatchObject({ code: "DAWN_E3003" })
    await expect(loadThreadAccess(appRoot)).rejects.toThrow(/default.*threadAccess/s)
  })

  it("rejects with DAWN_E3003 when the export is not an object", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": 'export default "nope"\n' })
    await expect(loadThreadAccess(appRoot)).rejects.toThrow(/not an object/)
  })

  it("rejects with DAWN_E3003, naming fallback, when fallback is missing", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": "export default { read: () => ({ decision: 'allow' }) }\n",
    })
    await expect(loadThreadAccess(appRoot)).rejects.toThrow(/`fallback`/)
  })

  it("rejects with DAWN_E3003 when a per-action key is not a function", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": `export default {
  fallback: () => ({ decision: "allow" }),
  read: "nope",
}
`,
    })
    await expect(loadThreadAccess(appRoot)).rejects.toThrow(
      /`read` is present but is not a function/,
    )
  })

  it("probes the root-level candidate when src/ has none", async () => {
    const appRoot = await fixtureApp({ "thread-access.ts": VALID_POLICY })
    const policy = await loadThreadAccess(appRoot)
    expect(typeof policy?.fallback).toBe("function")
  })
})

/**
 * The security property, asserted directly rather than inferred from five
 * separate regexes: a policy file that exists but cannot be bound NEVER
 * resolves, and each way it can fail says something different.
 */
async function loadFailure(appRoot: string): Promise<{ code: unknown; message: string }> {
  let policy: unknown
  try {
    policy = await loadThreadAccess(appRoot)
  } catch (error) {
    return {
      code: (error as { readonly code?: unknown }).code,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  throw new Error(
    `loadThreadAccess resolved to ${JSON.stringify(policy) ?? String(policy)} instead of rejecting — the app would boot ungated`,
  )
}

describe("loadThreadAccess fails closed", () => {
  it("rejects rather than resolving when the policy file throws at import", async () => {
    // A thrown env assertion in production is the realistic shape of this: with
    // `loadMiddleware`'s `catch {}` it resolves to undefined, i.e. no gate at
    // all and no log line. Here the error must ESCAPE.
    const appRoot = await fixtureApp({
      "src/thread-access.ts": 'throw new Error("THREAD_ACCESS_SECRET is not set")\n',
    })
    const failure = await loadFailure(appRoot)
    expect(failure.code).toBe("DAWN_E3003")
    expect(failure.message).toContain("src/thread-access.ts")
    expect(failure.message).toContain("THREAD_ACCESS_SECRET is not set")
    expect(failure.message).toContain("ungated")
  })

  it("names a distinct cause for the import failure and each of the four binding failures", async () => {
    const cases = [
      {
        name: "import failure",
        pattern: /failed to import/,
        source: 'throw new Error("boom at import")\n',
      },
      {
        name: "binds nothing",
        pattern: /has no `default` or `threadAccess` export/,
        source: "export const helper = 1\n",
      },
      {
        name: "not an object",
        pattern: /the bound value is not an object/,
        source: 'export default "nope"\n',
      },
      {
        name: "fallback missing",
        pattern: /`fallback` is missing or is not a function/,
        source: "export default { read: () => ({ decision: 'allow' }) }\n",
      },
      {
        name: "action key is not a function",
        pattern: /`read` is present but is not a function/,
        source: `export default {
  fallback: () => ({ decision: "allow" }),
  read: "nope",
}
`,
      },
    ] as const

    const failures = await Promise.all(
      cases.map(async (testCase) =>
        loadFailure(await fixtureApp({ "src/thread-access.ts": testCase.source })),
      ),
    )

    // Every one is DAWN_E3003 — the code is the class, not the cause.
    expect(failures.map((failure) => failure.code)).toEqual(cases.map(() => "DAWN_E3003"))

    // Each message matches its OWN pattern and no other case's, so a loader
    // that collapsed these into one message would fail here even though every
    // individual `rejects.toThrow` above would still pass.
    cases.forEach((testCase, index) => {
      const message = failures[index]?.message ?? ""
      const matched = cases
        .filter((other) => other.pattern.test(message))
        .map((other) => other.name)
      expect(matched).toEqual([testCase.name])
    })

    // …and belt-and-braces: no two messages are the same string.
    expect(new Set(failures.map((failure) => failure.message)).size).toBe(cases.length)
  })
})
