---
"@dawn-ai/workspace": patch
"@dawn-ai/sandbox": patch
"@dawn-ai/cli": patch
---

Add a `kubernetesSandbox` provider: run each thread's sandbox as a Kubernetes Pod
with a per-thread PersistentVolumeClaim for the durable workspace, implementing the
same `SandboxProvider` contract as `dockerSandbox`. Tier-1 hardening maps onto Pod
SecurityContext (non-root via `fsGroup`, read-only rootfs, dropped capabilities,
no-new-privileges, RuntimeDefault seccomp); sandbox pods mount no ServiceAccount
token. Per-thread NetworkPolicy provides best-effort egress control (requires a
policy-capable CNI; `dawn check` warns when unconfirmed). New `resources.diskGb`
sets the PVC size.
