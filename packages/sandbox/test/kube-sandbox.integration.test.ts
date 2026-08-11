import { randomUUID } from "node:crypto"
import {
  ApiException,
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
  type V1NetworkPolicy,
} from "@kubernetes/client-node"
import { describe, expect, test } from "vitest"
import { kubernetesSandbox } from "../src/index.ts"
import { runProviderConformance } from "../src/testing/index.ts"

// Real-cluster lane. The compatibility harness supplies a short-lived token
// kubeconfig and all live inputs; ordinary package tests skip this entire suite.
const enabled = process.env.DAWN_TEST_K8S === "1"

function requiredLiveEnvironment(name: string): string {
  const value = process.env[name]
  if (enabled && (value === undefined || value.trim().length === 0)) {
    throw new Error(`${name} is required when DAWN_TEST_K8S=1`)
  }
  return value ?? ""
}

const IMAGE = requiredLiveEnvironment("DAWN_TEST_K8S_IMAGE")
const NS = requiredLiveEnvironment("DAWN_TEST_K8S_NS")
const EGRESS_CONTROL_URL = requiredLiveEnvironment("DAWN_TEST_K8S_EGRESS_CONTROL_URL")
const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })
const make = () => kubernetesSandbox({ image: IMAGE, namespace: NS, startupTimeoutMs: 120_000 })

function liveClients(): { readonly core: CoreV1Api; readonly networking: NetworkingV1Api } {
  const kubeconfig = new KubeConfig()
  kubeconfig.loadFromDefault()
  return {
    core: kubeconfig.makeApiClient(CoreV1Api),
    networking: kubeconfig.makeApiClient(NetworkingV1Api),
  }
}

function requireStatusField(output: string, field: string): string {
  const match = new RegExp(`^${field}:\\s*(\\S+)\\s*$`, "m").exec(output)
  expect(match, `/proc/self/status must contain ${field}`).not.toBeNull()
  return match?.[1] ?? ""
}

function expectWriteResult(
  output: string,
  target: string,
  expected: "writable" | "read-only",
): void {
  expect(output, `${target} must be ${expected}`).toContain(`DAWN_WRITE_${target}=${expected}`)
}

async function waitForPodDeletion(core: CoreV1Api, name: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await core.readNamespacedPod({ name, namespace: NS })
    } catch (error) {
      if (error instanceof ApiException && error.code === 404) return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Pod ${NS}/${name} to be deleted`)
}

describe.skipIf(!enabled)("kubernetesSandbox (real cluster)", { timeout: 240_000 }, () => {
  runProviderConformance({ name: "kubernetesSandbox", makeProvider: make, describe })

  test("runs with the restricted object and kernel security contract", async () => {
    const provider = make()
    const threadId = `restricted-${randomUUID().slice(0, 8)}`
    try {
      const sandbox = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const { core } = liveClients()
      const [pod, pvc] = await Promise.all([
        core.readNamespacedPod({ name: `dawn-sbx-${threadId}`, namespace: NS }),
        core.readNamespacedPersistentVolumeClaim({
          name: `dawn-sbx-vol-${threadId}`,
          namespace: NS,
        }),
      ])

      expect(pod.spec?.automountServiceAccountToken).toBe(false)
      expect(pod.spec?.securityContext).toMatchObject({
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      })
      expect(pod.spec?.containers[0]?.securityContext).toMatchObject({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      })
      expect(pvc.status?.phase).toBe("Bound")

      const probe = await sandbox.exec.runCommand(
        {
          command: [
            "cat /proc/self/status",
            "for target in etc workspace tmp run; do",
            '  case "$target" in',
            '    etc) path="/etc/dawn-compat-write" ;;',
            '    *) path="/$target/dawn-compat-write" ;;',
            "  esac",
            '  if touch "$path" >/dev/null 2>&1; then',
            '    echo "DAWN_WRITE_$target=writable"',
            "  else",
            '    echo "DAWN_WRITE_$target=read-only"',
            "  fi",
            "done",
            'token_path="/var/run/secrets/kubernetes.io/serviceaccount/token"',
            'if [ -e "$token_path" ]; then echo "DAWN_SERVICEACCOUNT_TOKEN=present"; else echo "DAWN_SERVICEACCOUNT_TOKEN=absent"; fi',
          ].join("\n"),
        },
        ctx(sandbox.workspaceRoot),
      )

      expect(probe.exitCode, probe.stderr).toBe(0)
      expect(requireStatusField(probe.stdout, "CapEff")).toMatch(/^0+$/)
      expect(requireStatusField(probe.stdout, "NoNewPrivs")).toBe("1")
      expect(requireStatusField(probe.stdout, "Seccomp")).toBe("2")
      expectWriteResult(probe.stdout, "etc", "read-only")
      expectWriteResult(probe.stdout, "workspace", "writable")
      expectWriteResult(probe.stdout, "tmp", "writable")
      expectWriteResult(probe.stdout, "run", "writable")
      expect(probe.stdout).toContain("DAWN_SERVICEACCOUNT_TOKEN=absent")
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("network deny blocks egress while DNS remains available", async () => {
    const controlHostname = new URL(EGRESS_CONTROL_URL).hostname
    const provider = make()
    const threadId = `network-${randomUUID().slice(0, 8)}`
    try {
      const sandbox = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const dns = await sandbox.exec.runCommand(
        {
          command: `node -e 'require("node:dns").promises.lookup(${JSON.stringify(controlHostname)}).then(({ address }) => console.log(address)).catch((error) => { console.error(error); process.exit(1) })'`,
        },
        ctx(sandbox.workspaceRoot),
      )
      expect(dns.exitCode, dns.stderr).toBe(0)
      expect(dns.stdout.trim()).not.toBe("")

      const fetchResult = await sandbox.exec.runCommand(
        {
          command: `node -e 'fetch(${JSON.stringify(EGRESS_CONTROL_URL)}, { signal: AbortSignal.timeout(5000) }).then((response) => { console.log("REACHED " + response.status); process.exit(0) }).catch(() => { console.log("BLOCKED"); process.exit(7) })'`,
        },
        ctx(sandbox.workspaceRoot),
      )
      expect(fetchResult.exitCode).toBe(7)
      expect(fetchResult.stdout).toContain("BLOCKED")
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("chart backstop blocks allow-mode sandbox egress without a per-thread policy", async () => {
    const controlHostname = new URL(EGRESS_CONTROL_URL).hostname
    const provider = make()
    const threadId = `egress-${randomUUID().slice(0, 8)}`
    try {
      const sandbox = await provider.acquire({
        threadId,
        policy: { network: { mode: "allow" } },
        signal: ctx("/").signal,
      })
      const { networking } = liveClients()
      const policies = await networking.listNamespacedNetworkPolicy({ namespace: NS })
      const perThreadPolicy = policies.items.find(
        (policy) =>
          policy.metadata?.name === `dawn-sbx-net-${threadId}` ||
          policy.metadata?.labels?.["dawn.sh/thread"] === threadId,
      )
      expect(perThreadPolicy).toBeUndefined()

      const dns = await sandbox.exec.runCommand(
        {
          command: `node -e 'require("node:dns").promises.lookup(${JSON.stringify(controlHostname)}).then(({ address }) => console.log(address)).catch((error) => { console.error(error); process.exit(1) })'`,
        },
        ctx(sandbox.workspaceRoot),
      )
      expect(dns.exitCode, dns.stderr).toBe(0)
      expect(dns.stdout.trim()).not.toBe("")

      const fetchResult = await sandbox.exec.runCommand(
        {
          command: `node -e 'fetch(${JSON.stringify(EGRESS_CONTROL_URL)}, { signal: AbortSignal.timeout(5000) }).then((response) => { console.log("REACHED " + response.status); process.exit(0) }).catch(() => { console.log("BLOCKED"); process.exit(7) })'`,
        },
        ctx(sandbox.workspaceRoot),
      )
      expect(fetchResult.exitCode).not.toBe(0)
      expect(fetchResult.stdout).toContain("BLOCKED")
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("workspace persists across release and reattach", async () => {
    const provider = make()
    const threadId = `persistence-${randomUUID().slice(0, 8)}`
    try {
      const first = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      await first.filesystem.writeFile(
        `${first.workspaceRoot}/keep`,
        "durable",
        ctx(first.workspaceRoot),
      )
      await provider.release(threadId)
      const second = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      expect(
        await second.filesystem.readFile(`${second.workspaceRoot}/keep`, ctx(second.workspaceRoot)),
      ).toBe("durable")
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("recreates an externally deleted keeper over the same PVC", async () => {
    const provider = make()
    const threadId = `recreate-${randomUUID().slice(0, 8)}`
    const podName = `dawn-sbx-${threadId}`
    const pvcName = `dawn-sbx-vol-${threadId}`
    try {
      const first = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      await first.filesystem.writeFile(
        `${first.workspaceRoot}/keeper-data`,
        "preserved",
        ctx(first.workspaceRoot),
      )
      const { core } = liveClients()
      const [initialPod, initialPvc] = await Promise.all([
        core.readNamespacedPod({ name: podName, namespace: NS }),
        core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: NS }),
      ])
      expect(initialPod.metadata?.uid).toBeTruthy()
      expect(initialPvc.metadata?.uid).toBeTruthy()

      await core.deleteNamespacedPod({ name: podName, namespace: NS, gracePeriodSeconds: 0 })
      await waitForPodDeletion(core, podName)

      const second = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const [replacementPod, retainedPvc] = await Promise.all([
        core.readNamespacedPod({ name: podName, namespace: NS }),
        core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: NS }),
      ])
      expect(replacementPod.metadata?.uid).toBeTruthy()
      expect(replacementPod.metadata?.uid).not.toBe(initialPod.metadata?.uid)
      expect(retainedPvc.metadata?.uid).toBe(initialPvc.metadata?.uid)
      expect(
        await second.filesystem.readFile(
          `${second.workspaceRoot}/keeper-data`,
          ctx(second.workspaceRoot),
        ),
      ).toBe("preserved")
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("updates an existing owned NetworkPolicy on reacquire", async () => {
    const provider = make()
    const threadId = `policy-${randomUUID().slice(0, 8)}`
    const policyName = `dawn-sbx-net-${threadId}`
    try {
      await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const { networking } = liveClients()
      const existing = await networking.readNamespacedNetworkPolicy({
        name: policyName,
        namespace: NS,
      })
      expect(existing.metadata?.labels).toMatchObject({
        "app.kubernetes.io/managed-by": "dawn",
        "dawn.sh/thread": threadId,
      })
      expect(existing.metadata?.resourceVersion).toBeTruthy()
      expect(existing.metadata?.uid).toBeTruthy()

      const modified: V1NetworkPolicy = {
        ...existing,
        spec: {
          podSelector: { matchLabels: { "dawn.sh/thread": threadId } },
          policyTypes: ["Egress"],
          egress: [],
        },
      }
      await networking.replaceNamespacedNetworkPolicy({
        name: policyName,
        namespace: NS,
        body: modified,
      })

      await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const updated = await networking.readNamespacedNetworkPolicy({
        name: policyName,
        namespace: NS,
      })
      expect(updated.metadata?.uid).toBe(existing.metadata?.uid)
      expect(updated.metadata?.labels).toMatchObject({
        "app.kubernetes.io/managed-by": "dawn",
        "dawn.sh/thread": threadId,
      })
      expect(updated.spec).toEqual({
        podSelector: { matchLabels: { "dawn.sh/thread": threadId } },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ],
      })
    } finally {
      await provider.destroy(threadId)
    }
  })
})
