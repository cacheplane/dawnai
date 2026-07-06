import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { dockerSandbox } from "../src/index.ts"
import { runProviderConformance } from "../src/testing/index.ts"

// Real-Docker lane. Runs ONLY when DAWN_TEST_DOCKER=1 (the dedicated CI job
// sets it; the default validate lane never does). Locally: DAWN_TEST_DOCKER=1
// with a running Docker daemon.
const enabled = process.env.DAWN_TEST_DOCKER === "1"
const IMAGE = "node:22-slim"
const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })
const policyDeny = { network: { mode: "deny" } } as const

describe.skipIf(!enabled)("dockerSandbox (real Docker)", { timeout: 120_000 }, () => {
  runProviderConformance({
    name: "dockerSandbox",
    makeProvider: () => dockerSandbox({ image: IMAGE }),
    describe,
  })

  test("network deny blocks egress (curl/wget fails inside)", { timeout: 120_000 }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `net-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      // node:22-slim has node; use node's fetch with a short timeout — no curl dependency.
      const r = await h.exec.runCommand(
        {
          command:
            `node -e "fetch('https://registry.npmjs.org/', {signal: AbortSignal.timeout(5000)}).then(()=>{console.log('REACHED');process.exit(0)}).catch(()=>{console.log('BLOCKED');process.exit(7)})"`,
        },
        ctx(h.workspaceRoot),
      )
      expect(r.exitCode).toBe(7)
      expect(r.stdout).toContain("BLOCKED")
    } finally {
      await p.destroy(threadId)
    }
  })

  test("host filesystem is untouched by sandbox writes", { timeout: 120_000 }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `host-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      await h.filesystem.writeFile(`${h.workspaceRoot}/host-check.txt`, "sandboxed", ctx(h.workspaceRoot))
      expect(await h.filesystem.readFile(`${h.workspaceRoot}/host-check.txt`, ctx(h.workspaceRoot))).toBe(
        "sandboxed",
      )
      expect(existsSync("/workspace/host-check.txt")).toBe(false)
      expect(existsSync(`${process.cwd()}/workspace/host-check.txt`)).toBe(false)
    } finally {
      await p.destroy(threadId)
    }
  })

  test("restart durability: release then reacquire reattaches the volume", { timeout: 180_000 }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `dur-${randomUUID()}`
    try {
      const h1 = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      await h1.filesystem.writeFile(`${h1.workspaceRoot}/persist.txt`, "v1", ctx(h1.workspaceRoot))
      await p.release(threadId) // container gone, volume kept
      const h2 = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      expect(await h2.filesystem.readFile(`${h2.workspaceRoot}/persist.txt`, ctx(h2.workspaceRoot))).toBe("v1")
    } finally {
      await p.destroy(threadId)
    }
  })
})
