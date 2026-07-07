import type { SandboxPolicy } from "@dawn-ai/workspace"
import { expect, test } from "vitest"
import type { KubePodSpec } from "../src/kubernetes/kube-client.ts"
import { kubernetesSandbox } from "../src/kubernetes/kube-sandbox.ts"
import { fakeKubeClient } from "./support/fake-kube-client.ts"

const signal = () => new AbortController().signal
const policy: SandboxPolicy = { network: { mode: "allow" } }

const seedSpec = (name: string): KubePodSpec => ({
  name,
  image: "i",
  labels: {},
  pvcName: "dawn-sbx-vol-t",
  env: [],
  limits: {},
  podSecurityContext: {},
  containerSecurityContext: {},
  readOnlyRootFilesystem: true,
  automountServiceAccountToken: false,
})

test("acquire creates PVC + Pod with hardened SecurityContext and fsGroup", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "node:22-slim", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t1", policy, signal: signal() })
  const pod = k.pods.get("dawn-sbx-t1")
  expect(pod).toBeTruthy()
  expect(k.pvcs.has("dawn-sbx-vol-t1")).toBe(true)
  expect(pod?.spec.podSecurityContext).toMatchObject({
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  })
  expect(pod?.spec.containerSecurityContext).toMatchObject({
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  })
  expect(pod?.spec.labels["dawn.sh/thread"]).toBe("t1")
  expect(pod?.spec.automountServiceAccountToken).toBe(false)
})

test("runAsNonRoot:false omits user/fsGroup (image default)", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({
    threadId: "t",
    policy: { ...policy, security: { runAsNonRoot: false } },
    signal: signal(),
  })
  const sc = k.pods.get("dawn-sbx-t")?.spec.podSecurityContext
  expect(sc?.runAsUser).toBeUndefined()
  expect(sc?.fsGroup).toBeUndefined()
})

test("acquire reattaches a Running pod (no duplicate create)", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t", policy, signal: signal() })
  const first = k.pods.get("dawn-sbx-t")
  await p.acquire({ threadId: "t", policy, signal: signal() })
  expect(k.pods.get("dawn-sbx-t")).toBe(first)
})

test("release deletes the pod but keeps the PVC; destroy removes both", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t", policy, signal: signal() })
  await p.release("t")
  expect(k.pods.has("dawn-sbx-t")).toBe(false)
  expect(k.pvcs.has("dawn-sbx-vol-t")).toBe(true)
  await p.destroy("t")
  expect(k.pvcs.has("dawn-sbx-vol-t")).toBe(false)
})

test("destroy waits until the PVC is actually gone (async deletion)", async () => {
  const k = fakeKubeClient({ pvcLingerReads: 2 })
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t", policy, signal: signal() })
  await p.destroy("t")
  // after destroy returns, the PVC probe must report gone (the poll drained the linger)
  expect(await k.pvcExists("ns", "dawn-sbx-vol-t")).toBe(false)
})

test("long thread IDs sharing a 40-char prefix get distinct pod names (no collision)", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  const idA = `thread-${"a".repeat(40)}ALPHA`
  const idB = `thread-${"a".repeat(40)}BETA`
  await p.acquire({ threadId: idA, policy, signal: signal() })
  await p.acquire({ threadId: idB, policy, signal: signal() })
  const names = [...k.pods.keys()]
  expect(names).toHaveLength(2)
  expect(names[0]).not.toBe(names[1])
  // names stay DNS-1123-valid and within the 63-char pod-name budget
  for (const n of names) {
    expect(n.length).toBeLessThanOrEqual(63)
    expect(n).toMatch(/^[a-z0-9-]+$/)
  }
})

test("diskGb sets the PVC storage size", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({
    threadId: "t",
    policy: { ...policy, resources: { diskGb: 5 } },
    signal: signal(),
  })
  expect(k.pvcs.get("dawn-sbx-vol-t")?.spec.storageGi).toBe(5)
})

test("sanitize strips trailing dash from the thread label", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "abc/", policy, signal: signal() })
  const pod = k.pods.get("dawn-sbx-abc")
  expect(pod?.spec.labels["dawn.sh/thread"]).toBe("abc")
  expect(pod?.spec.labels["dawn.sh/thread"]?.endsWith("-")).toBe(false)
})

test("existing Pending pod is waited on, not recreated (no 409)", async () => {
  // pendingReads:1 → the pre-seeded pod reports Pending on its first phase-read
  // (which acquire's initial check sees), then Running on the next. The fake now
  // throws 409 on any duplicate create, so the old fall-through code would fail.
  const k = fakeKubeClient({ pendingReads: 1 })
  await k.createNamespacedPvcIfAbsent("ns", { name: "dawn-sbx-vol-t", labels: {}, storageGi: 1 })
  await k.createNamespacedPod("ns", seedSpec("dawn-sbx-t"))
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await expect(p.acquire({ threadId: "t", policy, signal: signal() })).resolves.toBeTruthy()
  expect(await k.readNamespacedPodPhase("ns", "dawn-sbx-t")).toBe("Running")
})

test("crashed (Failed) pod is deleted and replaced with a Running pod", async () => {
  const k = fakeKubeClient()
  await k.createNamespacedPvcIfAbsent("ns", { name: "dawn-sbx-vol-t", labels: {}, storageGi: 1 })
  await k.createNamespacedPod("ns", seedSpec("dawn-sbx-t"))
  const seeded = k.pods.get("dawn-sbx-t")
  if (seeded) seeded.phase = "Failed"
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await expect(p.acquire({ threadId: "t", policy, signal: signal() })).resolves.toBeTruthy()
  const pod = k.pods.get("dawn-sbx-t")
  expect(pod).toBeTruthy()
  expect(pod).not.toBe(seeded) // a freshly recreated pod, not the crashed one
  expect(await k.readNamespacedPodPhase("ns", "dawn-sbx-t")).toBe("Running")
})

test("network:deny emits a deny NetworkPolicy selecting the thread", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t", policy: { network: { mode: "deny" } }, signal: signal() })
  const np = k.netpols.get("dawn-sbx-net-t")
  expect(np?.mode).toBe("deny")
  expect(np?.threadLabelValue).toBe("t")
})

test("network:allow with no allowlist emits no NetworkPolicy", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t", policy: { network: { mode: "allow" } }, signal: signal() })
  expect(k.netpols.has("dawn-sbx-net-t")).toBe(false)
})

test("network:deny with an allowlist emits a deny NetworkPolicy carrying the allowlist", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({
    threadId: "t",
    policy: { network: { mode: "deny", allowlist: ["10.0.0.0/8"] } },
    signal: signal(),
  })
  const np = k.netpols.get("dawn-sbx-net-t")
  expect(np?.mode).toBe("deny")
  expect(np?.allowlist).toEqual(["10.0.0.0/8"])
})

test("preflight fails when create is denied", async () => {
  const k = fakeKubeClient({ canICreate: false })
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  const r = await p.preflight?.()
  expect(r?.ok).toBe(false)
})

test("preflight warns when the CNI won't enforce NetworkPolicy", async () => {
  const k = fakeKubeClient({ cniEnforced: false })
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  const r = await p.preflight?.()
  expect(r?.ok).toBe(true)
  expect(r?.warnings?.join(" ")).toMatch(/NetworkPolicy/i)
})

test("preflight passes clean when create allowed and CNI enforces", async () => {
  const k = fakeKubeClient({ canICreate: true, cniEnforced: true })
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  const r = await p.preflight?.()
  expect(r?.ok).toBe(true)
  expect(r?.warnings ?? []).toHaveLength(0)
})
