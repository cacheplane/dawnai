import type { SandboxPolicy } from "@dawn-ai/workspace"
import { expect, test } from "vitest"
import { kubernetesSandbox } from "../src/kubernetes/kube-sandbox.ts"
import { fakeKubeClient } from "./support/fake-kube-client.ts"

const signal = () => new AbortController().signal
const policy: SandboxPolicy = { network: { mode: "allow" } }

test("acquire creates PVC + Pod with hardened SecurityContext and fsGroup", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "node:22-slim", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t1", policy, signal: signal() })
  const pod = k.pods.get("dawn-sbx-t1")
  expect(pod).toBeTruthy()
  expect(k.pvcs.has("dawn-sbx-vol-t1")).toBe(true)
  expect(pod?.spec.podSecurityContext).toMatchObject({
    runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000,
    fsGroupChangePolicy: "OnRootMismatch", seccompProfile: { type: "RuntimeDefault" },
  })
  expect(pod?.spec.containerSecurityContext).toMatchObject({
    allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  })
  expect(pod?.spec.labels["dawn.sh/thread"]).toBe("t1")
  expect(pod?.spec.automountServiceAccountToken).toBe(false)
})

test("runAsNonRoot:false omits user/fsGroup (image default)", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({
    threadId: "t", policy: { ...policy, security: { runAsNonRoot: false } }, signal: signal(),
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

test("diskGb sets the PVC storage size", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t", policy: { ...policy, resources: { diskGb: 5 } }, signal: signal() })
  expect(k.pvcs.get("dawn-sbx-vol-t")?.spec.storageGi).toBe(5)
})
