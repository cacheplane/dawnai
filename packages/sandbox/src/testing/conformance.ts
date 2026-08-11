import type { SandboxProvider } from "@dawn-ai/workspace"
import { expect, test } from "vitest"

const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })
const policy = { network: { mode: "allow" } } as const

export async function runProviderConformanceCase<T>(
  provider: Pick<SandboxProvider, "destroy">,
  threadIds: readonly string[],
  body: () => T | Promise<T>,
): Promise<T> {
  let bodyResult: T | undefined
  let bodyFailure: unknown
  let bodyPassed = false
  try {
    bodyResult = await body()
    bodyPassed = true
  } catch (error) {
    bodyFailure = error
  }

  const cleanupResults = await Promise.allSettled(
    threadIds.map((threadId) => Promise.resolve().then(() => provider.destroy(threadId))),
  )
  const cleanupFailures = cleanupResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  )

  if (!bodyPassed) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [bodyFailure, ...cleanupFailures],
        "SandboxProvider conformance body and cleanup failed",
      )
    }
    throw bodyFailure
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "SandboxProvider conformance cleanup failed")
  }
  return bodyResult as T
}

/**
 * The contract every SandboxProvider must satisfy. Reused by fakeSandbox (CI)
 * and dockerSandbox (gated Docker lane) so the fake cannot drift from reality.
 * Pass vitest's `describe` so the kit can group under any runner.
 */
export function runProviderConformance(opts: {
  readonly name: string
  readonly makeProvider: () => SandboxProvider
  readonly describe: (name: string, fn: () => void) => void
}): void {
  opts.describe(`SandboxProvider conformance: ${opts.name}`, () => {
    test("acquire is idempotent per thread and reattaches the workspace", async () => {
      const p = opts.makeProvider()
      await runProviderConformanceCase(p, ["t1"], async () => {
        const a = await p.acquire({ threadId: "t1", policy, signal: ctx("/").signal })
        await a.filesystem.writeFile(`${a.workspaceRoot}/x`, "1", ctx(a.workspaceRoot))
        const b = await p.acquire({ threadId: "t1", policy, signal: ctx("/").signal })
        expect(await b.filesystem.readFile(`${b.workspaceRoot}/x`, ctx(b.workspaceRoot))).toBe("1")
      })
    })

    test("threads are isolated", async () => {
      const p = opts.makeProvider()
      await runProviderConformanceCase(p, ["a", "b"], async () => {
        const a = await p.acquire({ threadId: "a", policy, signal: ctx("/").signal })
        await a.filesystem.writeFile(`${a.workspaceRoot}/secret`, "s", ctx(a.workspaceRoot))
        const b = await p.acquire({ threadId: "b", policy, signal: ctx("/").signal })
        expect(await b.filesystem.listDir(b.workspaceRoot, ctx(b.workspaceRoot))).not.toContain(
          "secret",
        )
      })
    })

    test("release keeps the volume, destroy clears it", async () => {
      const p = opts.makeProvider()
      await runProviderConformanceCase(p, ["t"], async () => {
        const a = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        await a.filesystem.writeFile(`${a.workspaceRoot}/keep`, "1", ctx(a.workspaceRoot))
        await p.release("t")
        const r = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        expect(await r.filesystem.readFile(`${r.workspaceRoot}/keep`, ctx(r.workspaceRoot))).toBe(
          "1",
        )
        await p.destroy("t")
        const d = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        expect(await d.filesystem.listDir(d.workspaceRoot, ctx(d.workspaceRoot))).not.toContain(
          "keep",
        )
      })
    })

    test("exec returns a numeric exit code", async () => {
      const p = opts.makeProvider()
      await runProviderConformanceCase(p, ["t"], async () => {
        const a = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        const r = await a.exec.runCommand({ command: "true" }, ctx(a.workspaceRoot))
        expect(typeof r.exitCode).toBe("number")
      })
    })
  })
}
