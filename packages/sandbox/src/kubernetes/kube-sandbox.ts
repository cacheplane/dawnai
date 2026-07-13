import { createHash } from "node:crypto"
import type { SandboxHandle, SandboxPolicy, SandboxProvider } from "@dawn-ai/workspace"
import { sandboxUnavailable } from "../errors.js"
import { createDefaultKubeClient } from "./default-kube-client.js"
import type { KubeClient, KubePodSpec } from "./kube-client.js"
import { kubeExec } from "./kube-exec.js"
import { kubeFilesystem } from "./kube-filesystem.js"

const ROOT = "/workspace"
// Linear leading/trailing '-' trim. Avoids anchored `-+`/`^-+` regexes, which are a
// polynomial-ReDoS pattern (O(n^2) backtracking on adversarial dash runs) when run on
// an uncontrolled thread id.
const trimDashes = (s: string): string => {
  let start = 0
  let end = s.length
  while (start < end && s[start] === "-") start++
  while (end > start && s[end - 1] === "-") end--
  return s.slice(start, end)
}
// DNS-1123 label: lowercase alphanumeric + '-', <=63 chars. Bare truncation to 40
// chars would collide two thread IDs sharing a 40-char prefix onto one sandbox, so
// append a stable content hash when (and only when) the cleaned id exceeds the limit
// — short ids are returned verbatim, keeping existing names churn-free.
const sanitize = (s: string) => {
  const clean = trimDashes(s.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")) || "x"
  if (clean.length <= 40) return clean
  const hash = createHash("sha256").update(s).digest("hex").slice(0, 8)
  return `${trimDashes(clean.slice(0, 31))}-${hash}`
}
const podName = (t: string) => `dawn-sbx-${sanitize(t)}`
const pvcName = (t: string) => `dawn-sbx-vol-${sanitize(t)}`
const netpolName = (t: string) => `dawn-sbx-net-${sanitize(t)}`

export interface KubernetesSandboxOptions {
  readonly image: string
  readonly namespace?: string
  readonly storageClass?: string
  readonly startupTimeoutMs?: number
  /** Injected for tests; defaults to the real @kubernetes/client-node impl (later task). */
  readonly client?: KubeClient
}

export function resolveSecurity(policy: SandboxPolicy): {
  podSecurityContext: Record<string, unknown>
  containerSecurityContext: Record<string, unknown>
  readOnly: boolean
  user: { uid: number; gid: number } | undefined
} {
  const sec = policy.security ?? {}
  const dropCaps = sec.dropAllCapabilities ?? true
  const noNewPriv = sec.noNewPrivileges ?? true
  const readOnly = sec.readOnlyRootFilesystem ?? true
  const user: { uid: number; gid: number } | undefined =
    sec.runAsNonRoot === false
      ? undefined
      : // `typeof null === "object"`, so guard against it explicitly — a raw-parsed
        // config could carry null (the TS type excludes it); fail SAFE to the
        // hardened non-root default rather than silently running as the image's root.
        typeof sec.runAsNonRoot === "object" && sec.runAsNonRoot !== null
        ? sec.runAsNonRoot
        : { uid: 1000, gid: 1000 }

  const podSecurityContext: Record<string, unknown> = {
    seccompProfile: { type: "RuntimeDefault" },
    ...(user
      ? {
          runAsNonRoot: true,
          runAsUser: user.uid,
          runAsGroup: user.gid,
          fsGroup: user.gid,
          fsGroupChangePolicy: "OnRootMismatch",
        }
      : {}),
  }
  const containerSecurityContext: Record<string, unknown> = {
    ...(noNewPriv ? { allowPrivilegeEscalation: false } : {}),
    ...(readOnly ? { readOnlyRootFilesystem: true } : {}),
    ...(dropCaps ? { capabilities: { drop: ["ALL"] } } : {}),
  }
  return { podSecurityContext, containerSecurityContext, readOnly, user }
}

/** Kubernetes SandboxProvider. Per thread: a keeper Pod `dawn-sbx-<t>` (sleep
 * infinity) + a PVC `dawn-sbx-vol-<t>` at /workspace. acquire = create-or-reattach;
 * release deletes the Pod (keeps the PVC); destroy deletes both. Hardening maps to
 * SecurityContext; fsGroup chowns the PVC (no chown-init); the pod mounts no SA token. */
export function kubernetesSandbox(opts: KubernetesSandboxOptions): SandboxProvider {
  const ns = opts.namespace ?? "dawn-sandboxes"
  const startupTimeoutMs = opts.startupTimeoutMs ?? 60_000
  const client = opts.client ?? createDefaultKubeClient()

  const ensurePod = async (
    threadId: string,
    policy: SandboxPolicy,
    signal: AbortSignal,
  ): Promise<string> => {
    const name = podName(threadId)
    const labels = { "app.kubernetes.io/managed-by": "dawn", "dawn.sh/thread": sanitize(threadId) }

    await client.createNamespacedPvcIfAbsent(ns, {
      name: pvcName(threadId),
      labels,
      storageGi: policy.resources?.diskGb ?? 1,
      ...(opts.storageClass ? { storageClass: opts.storageClass } : {}),
    })

    const phase = await client.readNamespacedPodPhase(ns, name)
    if (phase === "Running") {
      // Already running: fall through to the netpol block below, no recreate.
    } else if (phase === "Pending") {
      // The keeper pod already exists but hasn't scheduled yet (slow scheduling,
      // image pull, PVC binding, or a reattach mid-startup). Recreating it 409s on
      // a real cluster, so wait it out rather than issue a duplicate create.
      await waitForRunning(client, ns, name, startupTimeoutMs, signal)
    } else {
      if (phase === "Failed" || phase === "Succeeded" || phase === "Unknown") {
        // A crashed/completed keeper: delete and wait for the name to free up. Real
        // K8s deletion is async (the pod lingers Terminating holding its name), so
        // recreating the same name immediately would 409.
        await client.deleteNamespacedPod(ns, name)
        await waitForGone(client, ns, name, startupTimeoutMs, signal)
      }

      const { podSecurityContext, containerSecurityContext, readOnly, user } =
        resolveSecurity(policy)
      const res = policy.resources
      const limits: Record<string, string> = {
        ...(res?.memoryMb ? { memory: `${res.memoryMb}Mi` } : {}),
        ...(res?.cpus ? { cpu: String(res.cpus) } : {}),
      }
      const env = [
        ...Object.entries(policy.env ?? {}).map(([name, value]) => ({ name, value })),
        ...(user ? [{ name: "HOME", value: ROOT }] : []),
      ]
      const spec: KubePodSpec = {
        name,
        image: opts.image,
        labels,
        pvcName: pvcName(threadId),
        env,
        limits,
        podSecurityContext,
        containerSecurityContext,
        readOnlyRootFilesystem: readOnly,
        automountServiceAccountToken: false,
      }
      await client.createNamespacedPod(ns, spec)
      await waitForRunning(client, ns, name, startupTimeoutMs, signal)
    }

    // Egress policy (best-effort — depends on a policy-capable CNI; preflight warns).
    // SandboxPolicy["network"]: mode "deny" is default-closed (an optional `allowlist`
    // carves out exceptions); mode "allow" is default-open (a `denylist` would carve
    // out exceptions, but KubeNetworkPolicySpec doesn't model that yet — out of scope,
    // matching Docker's bare-allow-is-open baseline).
    const wantsPolicy = policy.network.mode === "deny"
    if (wantsPolicy) {
      await client.upsertNamespacedNetworkPolicy(ns, {
        name: netpolName(threadId),
        labels,
        threadLabelValue: sanitize(threadId),
        mode: policy.network.mode,
        ...(policy.network.allowlist ? { allowlist: policy.network.allowlist } : {}),
      })
    }
    return name
  }

  return {
    name: "kubernetes",
    async acquire({ threadId, policy, signal }): Promise<SandboxHandle> {
      const pod = await ensurePod(threadId, policy, signal)
      return {
        threadId,
        filesystem: kubeFilesystem(client, ns, pod),
        exec: kubeExec(
          client,
          ns,
          pod,
          policy.resources?.timeoutMs !== undefined
            ? { timeoutMs: policy.resources.timeoutMs }
            : {},
        ),
        workspaceRoot: ROOT,
      }
    },
    async release(threadId) {
      await client.deleteNamespacedNetworkPolicy(ns, netpolName(threadId)).catch(() => {})
      await client
        .deleteNamespacedPod(ns, podName(threadId), { gracePeriodSeconds: 0 })
        .catch(() => {})
    },
    async destroy(threadId) {
      await client.deleteNamespacedNetworkPolicy(ns, netpolName(threadId)).catch(() => {})
      await client
        .deleteNamespacedPod(ns, podName(threadId), { gracePeriodSeconds: 0 })
        .catch(() => {})
      await client.deleteNamespacedPvc(ns, pvcName(threadId)).catch(() => {})
      await waitForPvcGone(client, ns, pvcName(threadId), 30_000)
    },
    async preflight() {
      const warnings: string[] = []
      let canCreate: boolean
      try {
        canCreate = await client.canI(ns, "create", "pods")
      } catch (error) {
        return {
          ok: false,
          detail: `Kubernetes API not reachable: ${error instanceof Error ? error.message : String(error)}.`,
        }
      }
      if (!canCreate) {
        return { ok: false, detail: `No permission to create pods in namespace "${ns}".` }
      }
      const enforced = await client.networkPolicyEnforced(ns).catch(() => "unknown" as const)
      if (enforced !== true) {
        warnings.push(
          `NetworkPolicy enforcement could not be confirmed in namespace "${ns}" (no policy-capable CNI detected). network:deny/allow egress control is best-effort until a CNI like Calico/Cilium is installed.`,
        )
      }
      return {
        ok: true,
        detail: `Kubernetes reachable; can create pods in "${ns}".`,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    },
  }
}

async function waitForRunning(
  client: KubeClient,
  ns: string,
  name: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal.aborted) throw new Error(`Sandbox acquire aborted for pod "${name}".`)
    const phase = await client.readNamespacedPodPhase(ns, name)
    if (phase === "Running") return
    if (phase === null) {
      throw sandboxUnavailable(
        `Sandbox unavailable: pod "${name}" disappeared while starting. Run \`dawn check\`.`,
      )
    }
    if (phase === "Failed" || phase === "Succeeded") {
      // A SIGTERM'd `sleep infinity` exits 0 → Succeeded; treat it as a dead keeper
      // rather than polling out the full timeout waiting for a Running it'll never reach.
      throw sandboxUnavailable(
        `Sandbox unavailable: pod "${name}" entered ${phase}. Run \`dawn check\`.`,
      )
    }
    if (Date.now() > deadline) {
      throw sandboxUnavailable(
        `Sandbox unavailable: pod "${name}" not Running within ${timeoutMs}ms. Run \`dawn check\`.`,
      )
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function waitForGone(
  client: KubeClient,
  ns: string,
  name: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal.aborted) {
      throw new Error(`Sandbox acquire aborted while awaiting pod "${name}" deletion.`)
    }
    if ((await client.readNamespacedPodPhase(ns, name)) === null) return
    if (Date.now() > deadline) {
      throw sandboxUnavailable(
        `Sandbox unavailable: pod "${name}" still terminating after ${timeoutMs}ms. Run \`dawn check\`.`,
      )
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** PVC deletion on a real cluster is async (pvc-protection finalizer + storage
 * backend teardown), so destroy() polls until the PVC is actually gone before
 * returning — otherwise an immediate re-acquire's createNamespacedPvcIfAbsent
 * sees the still-existing (Terminating) PVC and rebinds the old data. Best-effort:
 * destroy has no AbortSignal, so this is bounded by a plain time budget rather than
 * a cancellation signal; giving up rather than throwing keeps cleanup non-fatal. */
async function waitForPvcGone(
  client: KubeClient,
  ns: string,
  name: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!(await client.pvcExists(ns, name).catch(() => false))) return
    if (Date.now() > deadline) return // best-effort cleanup: give up rather than throw
    await new Promise((r) => setTimeout(r, 250))
  }
}
