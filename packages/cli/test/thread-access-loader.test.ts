import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
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

/** A stat seam that fails the way the real syscall does, with an errno `code`. */
function denyWith(errno: string): (path: string) => void {
  return (path) => {
    throw Object.assign(new Error(`${errno}: not permitted, lstat '${path}'`), { code: errno })
  }
}

/**
 * chmod is a no-op on Windows, and root ignores the mode bits entirely — the
 * real-filesystem cases below are meaningless in both. They exist alongside the
 * injected-seam cases as the proof that the seam models the real syscall.
 */
const canRevokePermissions = process.platform !== "win32" && process.getuid?.() !== 0

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

  it("imports through a file URL, so a path is never parsed as a specifier", async () => {
    // A filesystem path is not a module specifier. On Windows the candidate is
    // `C:\app/src/thread-access.ts` and Node rejects it outright
    // (ERR_UNSUPPORTED_ESM_URL_SCHEME: "Received protocol 'c:'"), which lands
    // in the loader's catch and fails the boot on a policy that is perfectly
    // fine — the one direction a fail-closed loader must not get wrong.
    //
    // Asserted on the SPECIFIER rather than the outcome: on POSIX a raw path
    // happens to import fine, so nothing observable distinguishes the two.
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY })
    const specifiers: string[] = []
    const policy = await loadThreadAccess(appRoot, {
      importModule: async (href) => {
        specifiers.push(href)
        return { default: { fallback: () => ({ decision: "allow" }) } }
      },
    })

    expect(typeof policy?.fallback).toBe("function")
    expect(specifiers).toEqual([pathToFileURL(join(appRoot, "src", "thread-access.ts")).href])
    expect(specifiers[0]).toMatch(/^file:\/\//)
    // A Windows drive letter arriving as a bare protocol is the exact failure.
    expect(specifiers[0]).not.toMatch(/^[a-zA-Z]:/)
  })
})

/**
 * The security property, asserted directly rather than inferred from five
 * separate regexes: a policy file that exists but cannot be bound NEVER
 * resolves, and each way it can fail says something different.
 */
async function loadFailure(
  appRoot: string,
  options?: Parameters<typeof loadThreadAccess>[1],
): Promise<{ code: unknown; message: string }> {
  let policy: unknown
  try {
    policy = await loadThreadAccess(appRoot, options)
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

  it("rejects rather than resolving when the probe cannot tell whether the file is there", async () => {
    // `existsSync` answers `false` for EVERY error, not just ENOENT — an
    // unreadable parent directory, an EACCES, an EPERM or an EIO would all read
    // as "this app has no policy" and boot every thread endpoint wide open.
    // Injected at the syscall seam so the classification under test is real and
    // the case runs identically on every platform (Windows has no chmod).
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY })
    const failure = await loadFailure(appRoot, { statPath: denyWith("EACCES") })
    expect(failure.code).toBe("DAWN_E3003")
    expect(failure.message).toContain("src/thread-access.ts")
    expect(failure.message).toContain("EACCES")
    expect(failure.message).toContain("ungated")
  })

  it("still reports no policy for the errnos that genuinely mean absent", async () => {
    // The other half: this must NOT become "any probe error fails the boot", or
    // an app that never had a policy stops booting. ENOENT is the ordinary
    // no-file answer; ENOTDIR is `src` being a file rather than a directory.
    const appRoot = await fixtureApp({ "package.json": '{"type":"module"}\n' })
    for (const errno of ["ENOENT", "ENOTDIR"]) {
      await expect(
        loadThreadAccess(appRoot, { statPath: denyWith(errno) }),
      ).resolves.toBeUndefined()
    }
  })

  it("names a distinct cause for the probe, the import, and each of the four binding failures", async () => {
    const cases = [
      {
        name: "unreadable path",
        options: { statPath: denyWith("EACCES") },
        pattern: /could not be probed/,
        source: VALID_POLICY,
      },
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
        loadFailure(
          await fixtureApp({ "src/thread-access.ts": testCase.source }),
          "options" in testCase ? testCase.options : undefined,
        ),
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

describe.runIf(canRevokePermissions)("loadThreadAccess against a real unreadable path", () => {
  /** Restore the mode before `afterEach` tries to remove the tree. */
  async function withMode(path: string, mode: number, body: () => Promise<void>): Promise<void> {
    await chmod(path, mode)
    try {
      await body()
    } finally {
      await chmod(path, 0o700)
    }
  }

  it("fails the boot when the policy file itself cannot be read", async () => {
    // `lstat` succeeds on a mode-000 file (stat needs no read permission), so
    // this lands on the IMPORT failure — still a hard DAWN_E3003, never silence.
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY })
    await withMode(join(appRoot, "src", "thread-access.ts"), 0o000, async () => {
      const failure = await loadFailure(appRoot)
      expect(failure.code).toBe("DAWN_E3003")
      expect(failure.message).toContain("thread-access.ts")
    })
  })

  it("fails the boot when the policy's directory cannot be read", async () => {
    // Here `lstat` itself is denied — the case `existsSync` reported as "no
    // policy file", booting every thread endpoint open.
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY })
    await withMode(join(appRoot, "src"), 0o000, async () => {
      const failure = await loadFailure(appRoot)
      expect(failure.code).toBe("DAWN_E3003")
      expect(failure.message).toContain("EACCES")
    })
  })
})
