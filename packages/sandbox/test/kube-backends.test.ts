import { expect, test } from "vitest"
import { kubeExec } from "../src/kubernetes/kube-exec.ts"
import { fakeKubeClient } from "./support/fake-kube-client.ts"

const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })

async function withPod() {
  const k = fakeKubeClient()
  await k.createNamespacedPvcIfAbsent("ns", { name: "vol", labels: {}, storageGi: 1 })
  await k.createNamespacedPod("ns", {
    name: "p", image: "i", labels: {}, pvcName: "vol", env: [], limits: {},
    podSecurityContext: {}, containerSecurityContext: {}, readOnlyRootFilesystem: true,
  })
  return k
}

test("runCommand execs sh -c and returns the exit code", async () => {
  const k = await withPod()
  const exec = kubeExec(k, "ns", "p", {})
  const r = await exec.runCommand({ command: "true" }, ctx("/workspace"))
  expect(r.exitCode).toBe(0)
})

test("cwd defaults to workspaceRoot; invalid env key throws", async () => {
  const k = await withPod()
  const seen: string[] = []
  const spy = { ...k, exec: async (ns: string, pod: string, argv: readonly string[]) => {
    seen.push(argv.join(" ")); return k.exec(ns, pod, argv)
  } }
  const exec = kubeExec(spy, "ns", "p", {})
  await exec.runCommand({ command: "true" }, ctx("/workspace"))
  expect(seen[0]).toContain("cd '/workspace' &&")
  await expect(
    exec.runCommand({ command: "true", env: { "1bad": "x" } }, ctx("/workspace")),
  ).rejects.toThrow(/Invalid environment variable name/)
})

test("timeout wraps argv and annotates exit 124", async () => {
  const k = await withPod()
  const spy = { ...k, exec: async () => ({ stdout: "", stderr: "", exitCode: 124 }) }
  const exec = kubeExec(spy, "ns", "p", { timeoutMs: 500 })
  const r = await exec.runCommand({ command: "sleep 5" }, ctx("/workspace"))
  expect(r.exitCode).toBe(124)
  expect(r.stderr).toContain("after 1s")
  expect(r.stderr).toContain("resources.timeoutMs: 500ms")
})
