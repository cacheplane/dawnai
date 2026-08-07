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

/**
 * Docker could not LAUNCH the command — its own init process failed to start.
 *
 * Matched on the launch failure itself rather than on any particular runc diagnostic:
 * pid exhaustion surfaces through several unrelated-looking messages
 * (`unable to spawn stage-1: Resource temporarily unavailable`, and
 * `read init-p: connection reset by peer` when runc's init dies mid-handshake), and
 * enumerating them is a losing game. What matters is the category: the command never
 * ran, so its output says nothing about whether the container survived. A command that
 * DID run and produced the wrong output does not match, and still fails immediately.
 */
const FAILED_TO_LAUNCH = /OCI runtime exec failed|unable to start container process/

/**
 * Runs a command, retrying only while the container has no free pids.
 *
 * The fork-bomb test leaves up to 2000 `sleep 30` processes ALIVE — they hold their
 * pids for the full 30s, so `pids-limit` keeps rejecting new processes long after
 * `runCommand` returns. A single follow-up exec therefore races the test's own
 * workload rather than any cleanup, and fails with `OCI runtime exec failed` roughly
 * a third of CI runs.
 *
 * Retrying preserves what the assertion is actually for: the container must still be
 * usable, which is only meaningful once it can spawn at all. Any OTHER failure is
 * returned immediately so a genuine regression still fails fast rather than burning
 * the whole window.
 */
type SandboxHandle = Awaited<ReturnType<ReturnType<typeof dockerSandbox>["acquire"]>>
type ExecResult = Awaited<ReturnType<SandboxHandle["exec"]["runCommand"]>>

async function execUntilSpawnable(
  handle: SandboxHandle,
  command: string,
  { intervalMs = 1_000, timeoutMs = 60_000 } = {},
): Promise<ExecResult> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await handle.exec.runCommand({ command }, ctx(handle.workspaceRoot))
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    if (!FAILED_TO_LAUNCH.test(output) || Date.now() >= deadline) return result
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

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
          command: `node -e "fetch('https://registry.npmjs.org/', {signal: AbortSignal.timeout(5000)}).then(()=>{console.log('REACHED');process.exit(0)}).catch(()=>{console.log('BLOCKED');process.exit(7)})"`,
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
      await h.filesystem.writeFile(
        `${h.workspaceRoot}/host-check.txt`,
        "sandboxed",
        ctx(h.workspaceRoot),
      )
      expect(
        await h.filesystem.readFile(`${h.workspaceRoot}/host-check.txt`, ctx(h.workspaceRoot)),
      ).toBe("sandboxed")
      expect(existsSync("/workspace/host-check.txt")).toBe(false)
      expect(existsSync(`${process.cwd()}/workspace/host-check.txt`)).toBe(false)
    } finally {
      await p.destroy(threadId)
    }
  })

  test("restart durability: release then reacquire reattaches the volume", {
    timeout: 180_000,
  }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `dur-${randomUUID()}`
    try {
      const h1 = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      await h1.filesystem.writeFile(`${h1.workspaceRoot}/persist.txt`, "v1", ctx(h1.workspaceRoot))
      await p.release(threadId) // container gone, volume kept
      const h2 = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      expect(
        await h2.filesystem.readFile(`${h2.workspaceRoot}/persist.txt`, ctx(h2.workspaceRoot)),
      ).toBe("v1")
    } finally {
      await p.destroy(threadId)
    }
  })

  // Adversarial hardening conformance: these tests actually attempt the abuse
  // (fork bomb, /etc write, non-root escalation, timeout overrun) and assert
  // containment. fakeSandbox can't enforce kernel controls (caps/pids/
  // read-only/non-root), so these properties are Docker-lane-only.

  test("hardened defaults contain a fork bomb (pids-limit)", { timeout: 180_000 }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `fork-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      const r = await h.exec.runCommand(
        { command: "for i in $(seq 1 2000); do sleep 30 & done; echo done" },
        ctx(h.workspaceRoot),
      )
      expect(typeof r.exitCode).toBe("number")
      // container still responsive → the host/container survived the spawn storm
      const alive = await execUntilSpawnable(h, "echo alive")
      expect(alive.stdout).toContain("alive")
    } finally {
      await p.destroy(threadId)
    }
  })

  test("read-only root blocks /etc writes; workspace + /tmp writable", {
    timeout: 120_000,
  }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `ro-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      const etc = await h.exec.runCommand(
        { command: "echo x > /etc/dawn-probe" },
        ctx(h.workspaceRoot),
      )
      expect(etc.exitCode).not.toBe(0)
      const ws = await h.exec.runCommand(
        { command: "echo x > /workspace/probe && echo ok" },
        ctx(h.workspaceRoot),
      )
      expect(ws.stdout).toContain("ok")
      const tmp = await h.exec.runCommand(
        { command: "echo x > /tmp/probe && echo ok" },
        ctx(h.workspaceRoot),
      )
      expect(tmp.stdout).toContain("ok")
    } finally {
      await p.destroy(threadId)
    }
  })

  test("runs as non-root by default", { timeout: 120_000 }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `nr-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      const r = await h.exec.runCommand({ command: "id -u" }, ctx(h.workspaceRoot))
      expect(r.stdout.trim()).toBe("1000")
    } finally {
      await p.destroy(threadId)
    }
  })

  test("per-command timeout kills the in-container process (exit 124)", {
    timeout: 120_000,
  }, async () => {
    const p = dockerSandbox({ image: IMAGE })
    const threadId = `to-${randomUUID()}`
    try {
      const h = await p.acquire({
        threadId,
        policy: { network: { mode: "deny" }, resources: { timeoutMs: 500 } },
        signal: ctx("/").signal,
      })
      const r = await h.exec.runCommand({ command: "sleep 999" }, ctx(h.workspaceRoot))
      expect(r.exitCode).toBe(124)
      const ps = await h.exec.runCommand(
        { command: "ps -e -o args= 2>/dev/null | grep -c 'sleep 999' || true" },
        ctx(h.workspaceRoot),
      )
      expect(ps.stdout.trim()).toBe("0")
    } finally {
      await p.destroy(threadId)
    }
  })
})
