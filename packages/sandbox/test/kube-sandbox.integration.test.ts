import { randomUUID } from "node:crypto"
import { describe, expect, test } from "vitest"
import { kubernetesSandbox } from "../src/index.ts"
import { runProviderConformance } from "../src/testing/index.ts"

// Real-cluster lane. Runs ONLY when DAWN_TEST_K8S=1 (the sandbox-k8s CI job sets
// it against kind+Calico). Uses the ambient kubeconfig ($KUBECONFIG). Namespace
// `dawn-sandboxes` must exist with a policy-capable CNI.
const enabled = process.env.DAWN_TEST_K8S === "1"
const IMAGE = "node:22-slim"
const NS = process.env.DAWN_TEST_K8S_NS ?? "dawn-sandboxes"
const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })
const make = () => kubernetesSandbox({ image: IMAGE, namespace: NS, startupTimeoutMs: 120_000 })

describe.skipIf(!enabled)("kubernetesSandbox (real cluster)", { timeout: 240_000 }, () => {
  runProviderConformance({ name: "kubernetesSandbox", makeProvider: make, describe })

  test("runs as non-root uid 1000", async () => {
    const p = make()
    const t = `id-${randomUUID().slice(0, 8)}`
    try {
      const h = await p.acquire({
        threadId: t,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const r = await h.exec.runCommand({ command: "id -u" }, ctx(h.workspaceRoot))
      expect(r.stdout.trim()).toBe("1000")
    } finally {
      await p.destroy(t)
    }
  })

  test("read-only root blocks /etc writes; workspace + /tmp writable", async () => {
    const p = make()
    const t = `ro-${randomUUID().slice(0, 8)}`
    try {
      const h = await p.acquire({
        threadId: t,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const etc = await h.exec.runCommand(
        { command: "echo x > /etc/x 2>&1; echo $?" },
        ctx(h.workspaceRoot),
      )
      expect(etc.stdout.trim().endsWith("0")).toBe(false)
      const ws = await h.exec.runCommand(
        { command: "echo x > /workspace/x && echo ok" },
        ctx(h.workspaceRoot),
      )
      expect(ws.stdout).toContain("ok")
    } finally {
      await p.destroy(t)
    }
  })

  test("network deny blocks egress", async () => {
    const p = make()
    const t = `net-${randomUUID().slice(0, 8)}`
    try {
      const h = await p.acquire({
        threadId: t,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const r = await h.exec.runCommand(
        {
          command: `node -e "fetch('https://registry.npmjs.org/',{signal:AbortSignal.timeout(5000)}).then(()=>{console.log('REACHED');process.exit(0)}).catch(()=>{console.log('BLOCKED');process.exit(7)})"`,
        },
        ctx(h.workspaceRoot),
      )
      expect(r.exitCode).toBe(7)
      expect(r.stdout).toContain("BLOCKED")
    } finally {
      await p.destroy(t)
    }
  })

  test("workspace persists across release→reattach (PVC durability)", async () => {
    const p = make()
    const t = `pvc-${randomUUID().slice(0, 8)}`
    try {
      const a = await p.acquire({
        threadId: t,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      await a.filesystem.writeFile(`${a.workspaceRoot}/keep`, "durable", ctx(a.workspaceRoot))
      await p.release(t)
      const b = await p.acquire({
        threadId: t,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      expect(await b.filesystem.readFile(`${b.workspaceRoot}/keep`, ctx(b.workspaceRoot))).toBe(
        "durable",
      )
    } finally {
      await p.destroy(t)
    }
  })
})
