import { expect, test } from "vitest"
import { fakeKubeClient } from "./support/fake-kube-client.ts"

const LABELS = { "dawn.sh/thread": "t" }

test("PVC filestore survives pod deletion and is adopted by a new pod", async () => {
  const k = fakeKubeClient()
  await k.createNamespacedPvcIfAbsent("ns", { name: "vol", labels: LABELS, storageGi: 1 })
  await k.createNamespacedPod("ns", podSpec("p1"))
  await k.exec("ns", "p1", ["sh", "-c", "cat > '/workspace/x'"], { stdin: "hi" })
  await k.deleteNamespacedPod("ns", "p1")
  await k.createNamespacedPod("ns", podSpec("p2"))
  const r = await k.exec("ns", "p2", ["sh", "-c", "cat '/workspace/x'"])
  expect(r.stdout).toBe("hi")
  expect(r.exitCode).toBe(0)
})

test("read of a missing pod-phase is null", async () => {
  const k = fakeKubeClient()
  expect(await k.readNamespacedPodPhase("ns", "nope")).toBeNull()
})

function podSpec(name: string) {
  return {
    name,
    image: "img",
    labels: LABELS,
    pvcName: "vol",
    env: [],
    limits: {},
    podSecurityContext: {},
    containerSecurityContext: {},
    readOnlyRootFilesystem: true,
    automountServiceAccountToken: false,
  }
}
