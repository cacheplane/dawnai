# Kubernetes Sandbox Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `kubernetesSandbox` provider to `@dawn-ai/sandbox` that runs each thread's workspace as a Kubernetes Pod + per-thread PVC, satisfying the existing `SandboxProvider` contract and carrying the Tier-1 `SandboxPolicy.security` hardening onto Pod SecurityContext.

**Architecture:** Mirror the Docker provider exactly — a narrow injectable `KubeClient` seam (default impl over `@kubernetes/client-node`, faked in unit tests), with `kubeExec`/`kubeFilesystem` layered on top, and a `kubernetesSandbox` provider implementing create-or-reattach lifecycle over Pods/PVCs/NetworkPolicies. Hardening maps to SecurityContext; `fsGroup` replaces the Docker chown-init; the sandbox pod mounts no ServiceAccount token.

**Tech Stack:** TypeScript (ESM, NodeNext), `@kubernetes/client-node` (1.x, object-param API), Vitest, Biome, kind + Calico for the gated real-cluster CI lane.

**Spec:** `docs/superpowers/specs/2026-07-07-kubernetes-sandbox-provider-design.md`

**Operating constraints (READ FIRST):**
- Work only in the worktree at `/Users/blove/repos/dawn/.claude/worktrees/relaxed-booth-90fa1d` on branch `feat/k8s-sandbox-provider`. **Before every commit run `git branch --show-current` and confirm it is `feat/k8s-sandbox-provider`** (multi-worktree detached-HEAD hazard). Do not push.
- Repo uses `exactOptionalPropertyTypes: true` — build optional fields with conditional spread (`...(x !== undefined ? { x } : {})`), never `{ x: undefined }`.
- Never run a bare `biome check --write` (mass-reformats). Use `pnpm lint` / `pnpm --filter @dawn-ai/sandbox lint`.
- The changeset MUST be `patch` (fixed-group 0.x turns any `minor` into a 1.0.0 bump).
- New source files use `.js` import specifiers for local modules (NodeNext), matching the existing `docker/*` files.

**Reference files (read before starting):**
- `packages/sandbox/src/docker/docker-cli.ts` — the `Docker` seam pattern to mirror.
- `packages/sandbox/src/docker/docker-exec.ts` — port to `kubeExec`.
- `packages/sandbox/src/docker/docker-filesystem.ts` — port to `kubeFilesystem`.
- `packages/sandbox/src/docker/docker-sandbox.ts` — the provider to mirror (security resolution at lines 55-77 is reused verbatim).
- `packages/sandbox/src/testing/conformance.ts` — the reusable conformance kit.
- `packages/sandbox/test/docker-sandbox.unit.test.ts`, `packages/sandbox/test/docker-backends.test.ts` — fake-based unit-test patterns.

---

### Task 1: Contract additions — `resources.diskGb` + `preflight.warnings`

**Files:**
- Modify: `packages/workspace/src/sandbox-types.ts`
- Test: `packages/workspace/test/sandbox-types.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/workspace/test/sandbox-types.test.ts`:

```ts
import { expectTypeOf, test } from "vitest"
import type { SandboxPolicy, SandboxProvider } from "../src/index.ts"

test("resources carries an optional diskGb (PVC size)", () => {
  const p: SandboxPolicy = { network: { mode: "deny" }, resources: { diskGb: 2 } }
  expectTypeOf(p.resources?.diskGb).toEqualTypeOf<number | undefined>()
})

test("preflight may return warnings", async () => {
  const provider = {
    name: "x",
    acquire: async () => ({}) as never,
    release: async () => {},
    destroy: async () => {},
    preflight: async () => ({ ok: true, warnings: ["cni not enforced"] as const }),
  } satisfies Partial<SandboxProvider> & Pick<SandboxProvider, "preflight">
  const r = await provider.preflight()
  expectTypeOf(r.warnings).toEqualTypeOf<readonly string[] | undefined>()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/workspace test sandbox-types`
Expected: FAIL (typecheck error — `diskGb`/`warnings` do not exist).

- [ ] **Step 3: Implement**

In `packages/workspace/src/sandbox-types.ts`, add `diskGb` to the `resources` object type (after `timeoutMs`):

```ts
  readonly resources?: {
    readonly memoryMb?: number
    readonly cpus?: number
    readonly timeoutMs?: number
    /** Per-thread workspace volume size in GiB (PVC providers, e.g. Kubernetes). Docker ignores it. */
    readonly diskGb?: number
  }
```

And extend the `preflight` return type in `SandboxProvider`:

```ts
  /** Optional availability probe surfaced by `dawn check`. `warnings` are non-fatal notes (e.g. best-effort enforcement). */
  preflight?(): Promise<{
    readonly ok: boolean
    readonly detail?: string
    readonly warnings?: readonly string[]
  }>
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @dawn-ai/workspace test sandbox-types && pnpm --filter @dawn-ai/workspace typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace/src/sandbox-types.ts packages/workspace/test/sandbox-types.test.ts
git commit -m "feat(workspace): resources.diskGb + preflight.warnings for PVC/k8s providers"
```

---

### Task 2: `KubeClient` seam + `fakeKubeClient` test double

The seam the provider talks to, plus an in-memory fake (the k8s analog of `fakeDocker`). The fake is the backbone of every subsequent unit test.

**Files:**
- Create: `packages/sandbox/src/kubernetes/kube-client.ts` (interface + shared types only in this task; the real impl lands in Task 6)
- Create: `packages/sandbox/test/support/fake-kube-client.ts`
- Test: `packages/sandbox/test/fake-kube-client.test.ts`

- [ ] **Step 1: Write the interface + shared types**

Create `packages/sandbox/src/kubernetes/kube-client.ts`:

```ts
/** Narrow Kubernetes API seam the provider needs. Default impl (Task 6) wraps
 * @kubernetes/client-node; unit tests inject a fake. Pod/PVC/NetworkPolicy specs
 * are the minimal shapes this provider sets — NOT the full k8s object types. */

export interface KubePodSpec {
  readonly name: string
  readonly image: string
  readonly labels: Readonly<Record<string, string>>
  readonly pvcName: string
  readonly env: readonly { readonly name: string; readonly value: string }[]
  readonly limits: Readonly<Record<string, string>> // e.g. { memory: "512Mi", cpu: "1" }
  readonly podSecurityContext: Readonly<Record<string, unknown>>
  readonly containerSecurityContext: Readonly<Record<string, unknown>>
  readonly readOnlyRootFilesystem: boolean // gates the /tmp,/run emptyDir mounts
}

export interface KubePvcSpec {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly storageGi: number
  readonly storageClass?: string
}

export interface KubeNetworkPolicySpec {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly threadLabelValue: string // podSelector matches dawn.sh/thread=<value>
  readonly mode: "deny" | "allow"
  readonly allowlist?: readonly string[] // CIDRs, allow mode only
}

export type PodPhase = "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown"

export interface KubeClient {
  readNamespacedPodPhase(ns: string, name: string): Promise<PodPhase | null> // null = 404
  createNamespacedPod(ns: string, spec: KubePodSpec): Promise<void>
  deleteNamespacedPod(ns: string, name: string): Promise<void>
  createNamespacedPvcIfAbsent(ns: string, spec: KubePvcSpec): Promise<void>
  deleteNamespacedPvc(ns: string, name: string): Promise<void>
  upsertNamespacedNetworkPolicy(ns: string, spec: KubeNetworkPolicySpec): Promise<void>
  deleteNamespacedNetworkPolicy(ns: string, name: string): Promise<void>
  exec(
    ns: string,
    pod: string,
    argv: readonly string[],
    opts?: { readonly stdin?: string; readonly signal?: AbortSignal },
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>
  /** SelfSubjectAccessReview probe for preflight. */
  canI(ns: string, verb: string, resource: string): Promise<boolean>
  /** Whether a NetworkPolicy-enforcing CNI is present; "unknown" if undetectable. */
  networkPolicyEnforced(ns: string): Promise<boolean | "unknown">
}
```

- [ ] **Step 2: Write the fake + its test**

Create `packages/sandbox/test/support/fake-kube-client.ts`:

```ts
import type {
  KubeClient,
  KubeNetworkPolicySpec,
  KubePodSpec,
  KubePvcSpec,
  PodPhase,
} from "../../src/kubernetes/kube-client.ts"

interface FakePod { spec: KubePodSpec; phase: PodPhase; files: Map<string, string> }

/** In-memory KubeClient. Models pods, PVCs (as a filestore that survives pod
 * deletion), and network policies. exec() is a tiny sh interpreter covering the
 * commands kubeFilesystem/kubeExec emit (cat/tee/ls/mkdir/rm/true/id/echo). */
export function fakeKubeClient(opts: {
  readonly canICreate?: boolean
  readonly cniEnforced?: boolean | "unknown"
  readonly startPhase?: PodPhase // phase newly-created pods report (default "Running")
} = {}): KubeClient & {
  readonly pods: Map<string, FakePod>
  readonly pvcs: Map<string, { spec: KubePvcSpec; files: Map<string, string> }>
  readonly netpols: Map<string, KubeNetworkPolicySpec>
} {
  const pods = new Map<string, FakePod>()
  const pvcs = new Map<string, { spec: KubePvcSpec; files: Map<string, string> }>()
  const netpols = new Map<string, KubeNetworkPolicySpec>()

  const runSh = (pod: FakePod, script: string, stdin?: string) => {
    // Cover only what the backends emit. Each is a single `sh -c "<script>"`.
    const files = pod.files
    const catMatch = script.match(/^cat '(.+)'$/)
    if (catMatch) {
      const f = files.get(catMatch[1]!)
      return f === undefined
        ? { stdout: "", stderr: "cat: no such file", exitCode: 1 }
        : { stdout: f, stderr: "", exitCode: 0 }
    }
    if (/cat > '/.test(script)) {
      const path = script.match(/cat > '(.+)'$/)![1]!
      files.set(path, stdin ?? "")
      return { stdout: "", stderr: "", exitCode: 0 }
    }
    const lsMatch = script.match(/^ls -1 '(.+)'$/)
    if (lsMatch) {
      const dir = lsMatch[1]!.replace(/\/$/, "")
      const names = [...files.keys()]
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1).split("/")[0])
      return { stdout: [...new Set(names)].join("\n"), stderr: "", exitCode: 0 }
    }
    if (script === "true" || script.startsWith("mkdir -p") || script.startsWith("touch"))
      return { stdout: "", stderr: "", exitCode: 0 }
    if (script.startsWith("rm -f")) return { stdout: "", stderr: "", exitCode: 0 }
    if (script === "id -u") return { stdout: "1000", stderr: "", exitCode: 0 }
    return { stdout: "", stderr: `unhandled: ${script}`, exitCode: 127 }
  }

  return {
    pods,
    pvcs,
    netpols,
    async readNamespacedPodPhase(_ns, name) {
      return pods.get(name)?.phase ?? null
    },
    async createNamespacedPod(_ns, spec) {
      // A fresh pod adopts the PVC's filestore (workspace persists across pods).
      const pvc = pvcs.get(spec.pvcName)
      pods.set(spec.name, {
        spec,
        phase: opts.startPhase ?? "Running",
        files: pvc?.files ?? new Map(),
      })
    },
    async deleteNamespacedPod(_ns, name) {
      pods.delete(name)
    },
    async createNamespacedPvcIfAbsent(_ns, spec) {
      if (!pvcs.has(spec.name)) pvcs.set(spec.name, { spec, files: new Map() })
    },
    async deleteNamespacedPvc(_ns, name) {
      pvcs.delete(name)
    },
    async upsertNamespacedNetworkPolicy(_ns, spec) {
      netpols.set(spec.name, spec)
    },
    async deleteNamespacedNetworkPolicy(_ns, name) {
      netpols.delete(name)
    },
    async exec(_ns, pod, argv, execOpts) {
      const p = pods.get(pod)
      if (!p) return { stdout: "", stderr: "pod not found", exitCode: 1 }
      // argv is ["sh","-c",script] or ["timeout","Ns","sh","-c",script]
      const sh = argv.indexOf("sh")
      const script = argv[sh + 2] ?? ""
      return runSh(p, script, execOpts?.stdin)
    },
    async canI() {
      return opts.canICreate ?? true
    },
    async networkPolicyEnforced() {
      return opts.cniEnforced ?? true
    },
  }
}
```

Create `packages/sandbox/test/fake-kube-client.test.ts`:

```ts
import { expect, test } from "vitest"
import { fakeKubeClient } from "./support/fake-kube-client.ts"

const LABELS = { "dawn.sh/thread": "t" }

test("PVC filestore survives pod deletion and is adopted by a new pod", async () => {
  const k = fakeKubeClient()
  await k.createNamespacedPvcIfAbsent("ns", { name: "vol", labels: LABELS, storageGi: 1 })
  await k.createNamespacedPod("ns", podSpec(k, "p1"))
  await k.exec("ns", "p1", ["sh", "-c", "cat > '/workspace/x'"], { stdin: "hi" })
  await k.deleteNamespacedPod("ns", "p1")
  await k.createNamespacedPod("ns", podSpec(k, "p2"))
  const r = await k.exec("ns", "p2", ["sh", "-c", "cat '/workspace/x'"])
  expect(r.stdout).toBe("hi")
  expect(r.exitCode).toBe(0)
})

test("read of a missing pod-phase is null", async () => {
  const k = fakeKubeClient()
  expect(await k.readNamespacedPodPhase("ns", "nope")).toBeNull()
})

function podSpec(_k: ReturnType<typeof fakeKubeClient>, name: string) {
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
  }
}
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm --filter @dawn-ai/sandbox test fake-kube-client && pnpm --filter @dawn-ai/sandbox typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/sandbox/src/kubernetes/kube-client.ts packages/sandbox/test/support/fake-kube-client.ts packages/sandbox/test/fake-kube-client.test.ts
git commit -m "feat(sandbox): KubeClient seam + in-memory fakeKubeClient"
```

---

### Task 3: `kubeExec` — ExecBackend over the KubeClient

Faithful port of `dockerExec` (env-key validation, `shellQuote`, cwd default, in-container `timeout` wrapping, exit-124 annotation), targeting `KubeClient.exec` instead of `docker.exec`.

**Files:**
- Create: `packages/sandbox/src/kubernetes/kube-exec.ts`
- Test: `packages/sandbox/test/kube-backends.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox/test/kube-backends.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/sandbox test kube-backends`
Expected: FAIL (`kubeExec` not found).

- [ ] **Step 3: Implement**

Create `packages/sandbox/src/kubernetes/kube-exec.ts`:

```ts
import type { BackendContext, ExecBackend } from "@dawn-ai/workspace"
import type { KubeClient } from "./kube-client.js"

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** ExecBackend that runs commands inside a pod via KubeClient.exec (sh -c). */
export function kubeExec(
  client: KubeClient,
  namespace: string,
  pod: string,
  opts: { readonly timeoutMs?: number } = {},
): ExecBackend {
  return {
    async runCommand(args, ctx: BackendContext) {
      const envPrefix = args.env
        ? Object.entries(args.env)
            .map(([k, v]) => {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
                throw new Error(
                  `Invalid environment variable name ${JSON.stringify(k)}: keys must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
                )
              }
              return `${k}=${shellQuote(v)} `
            })
            .join("")
        : ""
      const cwd = args.cwd ?? ctx.workspaceRoot
      const cdPrefix = cwd ? `cd ${shellQuote(cwd)} && ` : ""
      const full = `${envPrefix}${cdPrefix}${args.command}`
      const shArgs = ["sh", "-c", full]
      const timeoutSecs =
        opts.timeoutMs !== undefined ? Math.ceil(opts.timeoutMs / 1000) : undefined
      const argv = timeoutSecs !== undefined ? ["timeout", `${timeoutSecs}s`, ...shArgs] : shArgs
      const r = await client.exec(namespace, pod, argv, { signal: ctx.signal })
      if (timeoutSecs !== undefined && r.exitCode === 124) {
        return {
          stdout: r.stdout,
          stderr: `${r.stderr}${r.stderr ? "\n" : ""}Command timed out after ${timeoutSecs}s (resources.timeoutMs: ${opts.timeoutMs}ms).`,
          exitCode: 124,
        }
      }
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/sandbox test kube-backends`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/kubernetes/kube-exec.ts packages/sandbox/test/kube-backends.test.ts
git commit -m "feat(sandbox): kubeExec — ExecBackend over KubeClient with timeout"
```

---

### Task 4: `kubeFilesystem` — FilesystemBackend over the KubeClient

Faithful port of `dockerFilesystem` (read/write/list/realPath/stat/remove/touch/mkdir over `sh -c`), targeting `KubeClient.exec`.

**Files:**
- Create: `packages/sandbox/src/kubernetes/kube-filesystem.ts`
- Test: append to `packages/sandbox/test/kube-backends.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/sandbox/test/kube-backends.test.ts`:

```ts
import { kubeFilesystem } from "../src/kubernetes/kube-filesystem.ts"

test("kubeFilesystem round-trips write→read→list", async () => {
  const k = await withPod()
  const fs = kubeFilesystem(k, "ns", "p")
  await fs.writeFile("/workspace/a.txt", "hello", ctx("/workspace"))
  expect(await fs.readFile("/workspace/a.txt", ctx("/workspace"))).toBe("hello")
  expect(await fs.listDir("/workspace", ctx("/workspace"))).toContain("a.txt")
})

test("kubeFilesystem readFile honors maxBytes", async () => {
  const k = await withPod()
  const fs = kubeFilesystem(k, "ns", "p")
  await fs.writeFile("/workspace/big", "0123456789", ctx("/workspace"))
  await expect(
    fs.readFile("/workspace/big", ctx("/workspace"), { maxBytes: 4 }),
  ).rejects.toThrow(/exceeds maxBytes/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/sandbox test kube-backends`
Expected: FAIL (`kubeFilesystem` not found).

- [ ] **Step 3: Implement**

Create `packages/sandbox/src/kubernetes/kube-filesystem.ts`:

```ts
import type { BackendContext, FilesystemBackend } from "@dawn-ai/workspace"
import type { KubeClient } from "./kube-client.js"

function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** FilesystemBackend whose ops run inside a pod via KubeClient.exec. */
export function kubeFilesystem(
  client: KubeClient,
  namespace: string,
  pod: string,
): FilesystemBackend {
  const run = (cmd: string, ctx: BackendContext, stdin?: string) =>
    client.exec(namespace, pod, ["sh", "-c", cmd], {
      ...(stdin !== undefined ? { stdin } : {}),
      signal: ctx.signal,
    })
  return {
    async readFile(path, ctx, opts) {
      const r = await run(`cat ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`readFile failed: ${r.stderr.trim()}`)
      const max = opts?.maxBytes
      if (max !== undefined && Number.isFinite(max) && Buffer.byteLength(r.stdout) > max) {
        throw new Error(`readFile ${path}: content exceeds maxBytes (${max}).`)
      }
      return r.stdout
    },
    async writeFile(path, content, ctx) {
      const r = await run(`mkdir -p "$(dirname ${q(path)})" && cat > ${q(path)}`, ctx, content)
      if (r.exitCode !== 0) throw new Error(`writeFile failed: ${r.stderr.trim()}`)
      return { bytesWritten: Buffer.byteLength(content) }
    },
    async listDir(path, ctx) {
      const r = await run(`ls -1 ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`listDir failed: ${r.stderr.trim()}`)
      return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    },
    async realPath(path, ctx) {
      const r = await run(`realpath -m ${q(path)}`, ctx)
      return r.exitCode === 0 ? r.stdout.trim() : path
    },
    async statFile(path, ctx) {
      const r = await run(`stat -c '%s %Y' ${q(path)}`, ctx)
      if (r.exitCode !== 0) throw new Error(`statFile failed: ${r.stderr.trim()}`)
      const [size, mtime] = r.stdout.trim().split(" ")
      return { size: Number(size), mtimeMs: Number(mtime) * 1000 }
    },
    async removeFile(path, ctx) {
      await run(`rm -f ${q(path)}`, ctx)
    },
    async touchFile(path, ctx) {
      await run(`touch ${q(path)}`, ctx)
    },
    async mkdir(path, ctx) {
      await run(`mkdir -p ${q(path)}`, ctx)
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/sandbox test kube-backends`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/kubernetes/kube-filesystem.ts packages/sandbox/test/kube-backends.test.ts
git commit -m "feat(sandbox): kubeFilesystem — FilesystemBackend over KubeClient"
```

---

### Task 5: `kubernetesSandbox` provider — lifecycle + SecurityContext mapping

The provider core: create-or-reattach Pod + PVC, hardening → SecurityContext with `fsGroup` (no chown-init), `automountServiceAccountToken:false`, release keeps PVC, destroy removes it. NetworkPolicy + preflight land in Task 6.

**Files:**
- Create: `packages/sandbox/src/kubernetes/kube-sandbox.ts`
- Test: `packages/sandbox/test/kube-sandbox.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox/test/kube-sandbox.unit.test.ts`:

```ts
import { expect, test } from "vitest"
import type { SandboxPolicy } from "@dawn-ai/workspace"
import { kubernetesSandbox } from "../src/kubernetes/kube-sandbox.ts"
import { fakeKubeClient } from "./support/fake-kube-client.ts"

const signal = () => new AbortController().signal
const policy: SandboxPolicy = { network: { mode: "allow" } }

test("acquire creates PVC + Pod with hardened SecurityContext and fsGroup", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "node:22-slim", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t1", policy, signal: signal() })
  const pod = k.pods.get("dawn-sbx-t1")!
  expect(pod).toBeTruthy()
  expect(k.pvcs.has("dawn-sbx-vol-t1")).toBe(true)
  // pod-level security context
  expect(pod.spec.podSecurityContext).toMatchObject({
    runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000,
    fsGroupChangePolicy: "OnRootMismatch", seccompProfile: { type: "RuntimeDefault" },
  })
  // container-level
  expect(pod.spec.containerSecurityContext).toMatchObject({
    allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  })
  // thread label present
  expect(pod.spec.labels["dawn.sh/thread"]).toBe("t1")
})

test("runAsNonRoot:false omits user/fsGroup (image default)", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({
    threadId: "t", policy: { ...policy, security: { runAsNonRoot: false } }, signal: signal(),
  })
  const sc = k.pods.get("dawn-sbx-t")!.spec.podSecurityContext
  expect(sc.runAsUser).toBeUndefined()
  expect(sc.fsGroup).toBeUndefined()
})

test("acquire reattaches a Running pod (no duplicate create)", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t", policy, signal: signal() })
  const first = k.pods.get("dawn-sbx-t")
  await p.acquire({ threadId: "t", policy, signal: signal() })
  expect(k.pods.get("dawn-sbx-t")).toBe(first) // same object, not recreated
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

test("sandbox pod does not mount a service-account token", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t", policy, signal: signal() })
  // exposed on the spec for assertion (see implementation note)
  expect(k.pods.get("dawn-sbx-t")!.spec.labels["dawn.sh/thread"]).toBe("t")
})
```

Note: `KubePodSpec` has no `automountServiceAccountToken` field yet — add `readonly automountServiceAccountToken: boolean` to `KubePodSpec` in `kube-client.ts` in this task, set it `false` in the provider, and assert it in the real-cluster lane (Task 8). Update `fake-kube-client.ts`'s `podSpec` helper and the Task-2 test's inline spec objects to include `automountServiceAccountToken: false`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/sandbox test kube-sandbox.unit`
Expected: FAIL (`kubernetesSandbox` not found).

- [ ] **Step 3: Implement**

First extend `KubePodSpec` in `packages/sandbox/src/kubernetes/kube-client.ts` — add after `readOnlyRootFilesystem`:

```ts
  readonly automountServiceAccountToken: boolean
```

Then create `packages/sandbox/src/kubernetes/kube-sandbox.ts`:

```ts
import type { SandboxHandle, SandboxPolicy, SandboxProvider } from "@dawn-ai/workspace"
import type { KubeClient, KubePodSpec } from "./kube-client.js"
import { kubeExec } from "./kube-exec.js"
import { kubeFilesystem } from "./kube-filesystem.js"

const ROOT = "/workspace"
// DNS-1123 label: lowercase alphanumeric + '-', <=63 chars.
const sanitize = (s: string) =>
  s.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 40) || "x"
const podName = (t: string) => `dawn-sbx-${sanitize(t)}`
const pvcName = (t: string) => `dawn-sbx-vol-${sanitize(t)}`
const netpolName = (t: string) => `dawn-sbx-net-${sanitize(t)}`

export interface KubernetesSandboxOptions {
  readonly image: string
  readonly namespace?: string
  readonly storageClass?: string
  readonly startupTimeoutMs?: number
  /** Injected for tests; defaults to the real @kubernetes/client-node impl (Task 6). */
  readonly client?: KubeClient
}

export function resolveSecurity(policy: SandboxPolicy): {
  podSecurityContext: Record<string, unknown>
  containerSecurityContext: Record<string, unknown>
  readOnly: boolean
  user: { uid: number; gid: number } | undefined
} {
  // Same hardened-by-default resolution as the Docker provider (docker-sandbox.ts 55-77).
  const sec = policy.security ?? {}
  const dropCaps = sec.dropAllCapabilities ?? true
  const noNewPriv = sec.noNewPrivileges ?? true
  const readOnly = sec.readOnlyRootFilesystem ?? true
  const user: { uid: number; gid: number } | undefined =
    sec.runAsNonRoot === false
      ? undefined
      : typeof sec.runAsNonRoot === "object" && sec.runAsNonRoot !== null
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
  // client is guaranteed by the default impl wired in Task 6; unit tests inject one.
  const client = opts.client as KubeClient

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
    if (phase === "Running") return name
    if (phase === "Failed" || phase === "Succeeded" || phase === "Unknown") {
      await client.deleteNamespacedPod(ns, name)
    }

    if (phase === null || phase === "Failed" || phase === "Succeeded" || phase === "Unknown") {
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
      await client.deleteNamespacedPod(ns, podName(threadId)).catch(() => {})
    },
    async destroy(threadId) {
      await client.deleteNamespacedNetworkPolicy(ns, netpolName(threadId)).catch(() => {})
      await client.deleteNamespacedPod(ns, podName(threadId)).catch(() => {})
      await client.deleteNamespacedPvc(ns, pvcName(threadId)).catch(() => {})
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
  // Poll — tests' fake returns "Running" immediately, so the first read passes.
  for (;;) {
    if (signal.aborted) throw new Error(`Sandbox acquire aborted for pod "${name}".`)
    const phase = await client.readNamespacedPodPhase(ns, name)
    if (phase === "Running") return
    if (phase === "Failed") {
      throw new Error(`Sandbox unavailable: pod "${name}" entered Failed. Run \`dawn check\`.`)
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Sandbox unavailable: pod "${name}" not Running within ${timeoutMs}ms. Run \`dawn check\`.`,
      )
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}
```

Update `packages/sandbox/test/support/fake-kube-client.ts`'s `podSpec` helper and the Task-2 inline specs to include `automountServiceAccountToken: false` (matches the extended `KubePodSpec`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/sandbox test kube-sandbox.unit && pnpm --filter @dawn-ai/sandbox test fake-kube-client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/kubernetes/kube-sandbox.ts packages/sandbox/src/kubernetes/kube-client.ts packages/sandbox/test/kube-sandbox.unit.test.ts packages/sandbox/test/support/fake-kube-client.ts packages/sandbox/test/fake-kube-client.test.ts
git commit -m "feat(sandbox): kubernetesSandbox lifecycle + SecurityContext (fsGroup, no SA token)"
```

---

### Task 6: NetworkPolicy emission + preflight

Provider emits a per-thread NetworkPolicy for `deny`/`allow`, and a `preflight` that probes reachability, `create` permission, and CNI enforcement (warning when unconfirmed).

**Files:**
- Modify: `packages/sandbox/src/kubernetes/kube-sandbox.ts`
- Test: append to `packages/sandbox/test/kube-sandbox.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/sandbox/test/kube-sandbox.unit.test.ts`:

```ts
test("network:deny emits a deny NetworkPolicy selecting the thread", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t", policy: { network: { mode: "deny" } }, signal: signal() })
  const np = k.netpols.get("dawn-sbx-net-t")!
  expect(np.mode).toBe("deny")
  expect(np.threadLabelValue).toBe("t")
})

test("network:allow with no allowlist emits no NetworkPolicy", async () => {
  const k = fakeKubeClient()
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  await p.acquire({ threadId: "t", policy: { network: { mode: "allow" } }, signal: signal() })
  expect(k.netpols.has("dawn-sbx-net-t")).toBe(false)
})

test("preflight fails when create is denied", async () => {
  const k = fakeKubeClient({ canICreate: false })
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  const r = await p.preflight!()
  expect(r.ok).toBe(false)
})

test("preflight warns when the CNI won't enforce NetworkPolicy", async () => {
  const k = fakeKubeClient({ cniEnforced: false })
  const p = kubernetesSandbox({ image: "i", client: k, namespace: "ns" })
  const r = await p.preflight!()
  expect(r.ok).toBe(true)
  expect(r.warnings?.join(" ")).toMatch(/NetworkPolicy/i)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/sandbox test kube-sandbox.unit`
Expected: FAIL (no netpol emission; no preflight).

- [ ] **Step 3: Implement**

In `kube-sandbox.ts`, at the end of `ensurePod` (after `waitForRunning`, before `return name`), add NetworkPolicy emission:

```ts
    // Egress policy (best-effort — depends on a policy-capable CNI; preflight warns).
    const wantsPolicy =
      policy.network.mode === "deny" ||
      (policy.network.mode === "allow" && (policy.network.allowlist?.length ?? 0) > 0)
    if (wantsPolicy) {
      await client.upsertNamespacedNetworkPolicy(ns, {
        name: netpolName(threadId),
        labels,
        threadLabelValue: sanitize(threadId),
        mode: policy.network.mode,
        ...(policy.network.mode === "allow" && policy.network.allowlist
          ? { allowlist: policy.network.allowlist }
          : {}),
      })
    }
```

Note: `policy.network.allowlist` only exists on the `allow` variant; the `deny` variant has `allowlist` too per the contract (`{ mode: "deny"; allowlist? }`) — but egress on deny-mode means "deny all except DNS", so we do NOT pass the deny-mode allowlist here (deny-mode allowlist semantics are out of scope for this provider; document in Task 9). Keep the guard exactly as written (only reads `allowlist` under `mode === "allow"`).

Add the `preflight` method to the returned provider object (after `destroy`):

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/sandbox test kube-sandbox.unit && pnpm --filter @dawn-ai/sandbox typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/kubernetes/kube-sandbox.ts packages/sandbox/test/kube-sandbox.unit.test.ts
git commit -m "feat(sandbox): per-thread NetworkPolicy + preflight (RBAC + CNI warning)"
```

---

### Task 7: Default `KubeClient` over `@kubernetes/client-node` + package export

The one non-unit-tested adapter (verified by typecheck + the Task-8 real-cluster lane). Adds the dep, implements the seam, wires it as the provider default, and exports from the package index.

**Files:**
- Modify: `packages/sandbox/package.json` (add dep)
- Create: `packages/sandbox/src/kubernetes/default-kube-client.ts`
- Modify: `packages/sandbox/src/kubernetes/kube-sandbox.ts` (default the client)
- Modify: `packages/sandbox/src/index.ts` (export)

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @dawn-ai/sandbox add @kubernetes/client-node@^1.3.0`
(If `^1.3.0` does not resolve, use the latest `1.x`: `pnpm --filter @dawn-ai/sandbox add @kubernetes/client-node@1`.)
Expected: `@kubernetes/client-node` appears under `dependencies` in `packages/sandbox/package.json`.

- [ ] **Step 2: Implement the default client**

Create `packages/sandbox/src/kubernetes/default-kube-client.ts`. This targets the `@kubernetes/client-node` **1.x object-parameter API** (methods take a single options object and return the body directly). If the installed types differ, adjust call sites to match — the shape below is the contract:

```ts
import {
  type AuthorizationV1Api,
  type CoreV1Api,
  Exec,
  KubeConfig,
  type NetworkingV1Api,
} from "@kubernetes/client-node"
import { Writable } from "node:stream"
import type {
  KubeClient,
  KubeNetworkPolicySpec,
  KubePodSpec,
  KubePvcSpec,
  PodPhase,
} from "./kube-client.js"

const collect = () => {
  const chunks: Buffer[] = []
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  })
  return { stream: w, text: () => Buffer.concat(chunks).toString("utf8") }
}

/** Real KubeClient over @kubernetes/client-node. Auto-detects in-cluster SA vs kubeconfig. */
export function createDefaultKubeClient(): KubeClient {
  const kc = new KubeConfig()
  kc.loadFromDefault() // in-cluster SA token OR ~/.kube/config
  const core = kc.makeApiClient<CoreV1Api>(
    (await import("@kubernetes/client-node")).CoreV1Api,
  )
  // NOTE: makeApiClient is synchronous; do not await. The line above is illustrative —
  // implement as: const core = kc.makeApiClient(CoreV1Api) with a top-level import of CoreV1Api.
  const net = kc.makeApiClient(/* NetworkingV1Api */ 0 as never)
  const auth = kc.makeApiClient(/* AuthorizationV1Api */ 0 as never)
  const exec = new Exec(kc)
  return buildClient(core, net as NetworkingV1Api, auth as AuthorizationV1Api, exec)
}
```

Note to implementer: the illustrative dynamic-import lines above are pseudocode to flag the makeApiClient pattern — **replace them** with real top-level imports:
`import { CoreV1Api, NetworkingV1Api, AuthorizationV1Api, Exec, KubeConfig } from "@kubernetes/client-node"` and `const core = kc.makeApiClient(CoreV1Api)` etc. Then implement `buildClient` with the concrete method bodies:

```ts
function buildClient(
  core: CoreV1Api,
  net: NetworkingV1Api,
  auth: AuthorizationV1Api,
  exec: Exec,
): KubeClient {
  return {
    async readNamespacedPodPhase(namespace, name) {
      try {
        const pod = await core.readNamespacedPodStatus({ name, namespace })
        return (pod.status?.phase as PodPhase | undefined) ?? "Unknown"
      } catch (e) {
        if ((e as { code?: number }).code === 404) return null
        throw e
      }
    },
    async createNamespacedPod(namespace, s: KubePodSpec) {
      await core.createNamespacedPod({ namespace, body: toPodManifest(namespace, s) })
    },
    async deleteNamespacedPod(namespace, name) {
      await core.deleteNamespacedPod({ name, namespace }).catch((e) => {
        if ((e as { code?: number }).code !== 404) throw e
      })
    },
    async createNamespacedPvcIfAbsent(namespace, s: KubePvcSpec) {
      try {
        await core.createNamespacedPersistentVolumeClaim({ namespace, body: toPvcManifest(s) })
      } catch (e) {
        if ((e as { code?: number }).code !== 409) throw e // already exists
      }
    },
    async deleteNamespacedPvc(namespace, name) {
      await core.deleteNamespacedPersistentVolumeClaim({ name, namespace }).catch((e) => {
        if ((e as { code?: number }).code !== 404) throw e
      })
    },
    async upsertNamespacedNetworkPolicy(namespace, s: KubeNetworkPolicySpec) {
      const body = toNetworkPolicyManifest(s)
      try {
        await net.createNamespacedNetworkPolicy({ namespace, body })
      } catch (e) {
        if ((e as { code?: number }).code === 409) {
          await net.replaceNamespacedNetworkPolicy({ name: s.name, namespace, body })
        } else throw e
      }
    },
    async deleteNamespacedNetworkPolicy(namespace, name) {
      await net.deleteNamespacedNetworkPolicy({ name, namespace }).catch((e) => {
        if ((e as { code?: number }).code !== 404) throw e
      })
    },
    async exec(namespace, pod, argv, opts) {
      const out = collect()
      const err = collect()
      return await new Promise((resolve, reject) => {
        exec
          .exec(
            namespace,
            pod,
            "sandbox",
            [...argv],
            out.stream,
            err.stream,
            null,
            false,
            (status) => {
              // V1Status: Success → 0; else parse details.causes[reason=ExitCode].message.
              let exitCode = 0
              if (status?.status !== "Success") {
                const cause = (status?.details?.causes ?? []).find((c) => c.reason === "ExitCode")
                exitCode = cause?.message ? Number(cause.message) : 1
              }
              resolve({ stdout: out.text(), stderr: err.text(), exitCode })
            },
          )
          .catch(reject)
        if (opts?.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted")))
      })
    },
    async canI(namespace, verb, resource) {
      const r = await auth.createSelfSubjectAccessReview({
        body: { spec: { resourceAttributes: { namespace, verb, resource } } },
      })
      return r.status?.allowed === true
    },
    async networkPolicyEnforced(namespace) {
      // No portable API tells us if the CNI enforces policy. Heuristic: if we can
      // list NetworkPolicies, the API type exists — but enforcement still depends on
      // the CNI, which we cannot introspect. Report "unknown" (preflight warns).
      try {
        await net.listNamespacedNetworkPolicy({ namespace })
        return "unknown"
      } catch {
        return false
      }
    },
  }
}
```

Add the three manifest builders in the same file (concrete k8s object shapes):

```ts
function toPodManifest(namespace: string, s: KubePodSpec) {
  const mounts = [
    { name: "workspace", mountPath: "/workspace" },
    ...(s.readOnlyRootFilesystem
      ? [{ name: "tmp", mountPath: "/tmp" }, { name: "run", mountPath: "/run" }]
      : []),
  ]
  const volumes = [
    { name: "workspace", persistentVolumeClaim: { claimName: s.pvcName } },
    ...(s.readOnlyRootFilesystem
      ? [{ name: "tmp", emptyDir: {} }, { name: "run", emptyDir: {} }]
      : []),
  ]
  return {
    metadata: { name: s.name, namespace, labels: s.labels },
    spec: {
      restartPolicy: "Always",
      automountServiceAccountToken: s.automountServiceAccountToken,
      securityContext: s.podSecurityContext,
      containers: [
        {
          name: "sandbox",
          image: s.image,
          command: ["sleep", "infinity"],
          env: s.env,
          securityContext: s.containerSecurityContext,
          resources: Object.keys(s.limits).length > 0 ? { limits: s.limits } : undefined,
          volumeMounts: mounts,
        },
      ],
      volumes,
    },
  }
}

function toPvcManifest(s: KubePvcSpec) {
  return {
    metadata: { name: s.name, labels: s.labels },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: `${s.storageGi}Gi` } },
      ...(s.storageClass ? { storageClassName: s.storageClass } : {}),
    },
  }
}

function toNetworkPolicyManifest(s: KubeNetworkPolicySpec) {
  const dnsEgress = {
    ports: [
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ],
  }
  const egress =
    s.mode === "deny"
      ? [dnsEgress] // deny all except DNS
      : [dnsEgress, ...(s.allowlist ?? []).map((cidr) => ({ to: [{ ipBlock: { cidr } }] }))]
  return {
    metadata: { name: s.name, labels: s.labels },
    spec: {
      podSelector: { matchLabels: { "dawn.sh/thread": s.threadLabelValue } },
      policyTypes: ["Egress"],
      egress,
    },
  }
}
```

- [ ] **Step 3: Wire the default into the provider**

In `kube-sandbox.ts`, replace `const client = opts.client as KubeClient` with a lazy default:

```ts
import { createDefaultKubeClient } from "./default-kube-client.js"
// ...
  const client = opts.client ?? createDefaultKubeClient()
```

- [ ] **Step 4: Export from the package index**

In `packages/sandbox/src/index.ts`, add:

```ts
export { type KubernetesSandboxOptions, kubernetesSandbox } from "./kubernetes/kube-sandbox.js"
export type { KubeClient } from "./kubernetes/kube-client.js"
```

- [ ] **Step 5: Typecheck, build, lint, unit tests**

Run: `pnpm --filter @dawn-ai/sandbox typecheck && pnpm --filter @dawn-ai/sandbox build && pnpm --filter @dawn-ai/sandbox test && pnpm --filter @dawn-ai/sandbox lint`
Expected: PASS (unit tests still green; the default client compiles against the installed client-node types — fix any signature drift to match the installed 1.x API).

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/package.json packages/sandbox/src/kubernetes/default-kube-client.ts packages/sandbox/src/kubernetes/kube-sandbox.ts packages/sandbox/src/index.ts ../../pnpm-lock.yaml
git commit -m "feat(sandbox): default KubeClient over @kubernetes/client-node + export kubernetesSandbox"
```

(If the lockfile is at repo root, `git add` it from there; adjust the path so the staged lockfile is included.)

---

### Task 8: `dawn check` validation + warnings channel

`collectSandboxErrors` returns `{ errors, warnings }`, folding provider `preflight.warnings` and adding K8s-shape checks; `check.ts` prints warnings (non-fatal) and throws on errors.

**Files:**
- Modify: `packages/cli/src/lib/runtime/collect-sandbox-errors.ts`
- Modify: `packages/cli/src/commands/check.ts`
- Test: `packages/cli/test/collect-sandbox-errors.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/collect-sandbox-errors.test.ts` (mirror the existing test's config-building style; the function now returns `{ errors, warnings }`):

```ts
test("folds preflight warnings without erroring", async () => {
  const provider = {
    name: "kubernetes",
    acquire: async () => ({}) as never,
    release: async () => {},
    destroy: async () => {},
    preflight: async () => ({ ok: true, warnings: ["cni unconfirmed"] }),
  }
  const { errors, warnings } = await collectSandboxErrors({ sandbox: { provider } })
  expect(errors).toHaveLength(0)
  expect(warnings.join(" ")).toContain("cni unconfirmed")
})
```

Update every existing assertion in this file from `const errors = await collectSandboxErrors(...)` to destructure `{ errors }` (the error list moved into the returned object). Keep all existing error expectations intact.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/cli test collect-sandbox-errors`
Expected: FAIL (return type is `string[]`, no `warnings`).

- [ ] **Step 3: Implement**

Change `collectSandboxErrors` in `packages/cli/src/lib/runtime/collect-sandbox-errors.ts`:
- Return type → `Promise<{ readonly errors: readonly string[]; readonly warnings: readonly string[] }>`.
- Add a `const warnings: string[] = []`.
- In the `preflight` success branch, fold warnings: after the `result.ok` check, add `if (result.warnings) warnings.push(...result.warnings)`.
- Change both `return errors` sites to `return { errors, warnings }`.

Concretely, replace the preflight block and the returns:

```ts
  if (typeof p.preflight === "function") {
    try {
      const result = await p.preflight()
      if (!result.ok) {
        errors.push(
          `Sandbox provider "${p.name}" preflight failed: ${result.detail ?? "unavailable"}.`,
        )
      } else if (result.warnings) {
        warnings.push(...result.warnings)
      }
    } catch (error) {
      errors.push(
        `Sandbox provider "${p.name}" preflight threw: ${error instanceof Error ? error.message : String(error)}.`,
      )
    }
  }
```

And the early return for a malformed provider becomes `return { errors, warnings }`, as does the final return.

Update `packages/cli/src/commands/check.ts` (around line 64):

```ts
    const { errors: sandboxErrors, warnings: sandboxWarnings } =
      await collectSandboxErrors(loadedConfig)
    for (const w of sandboxWarnings) console.warn(`⚠ sandbox: ${w}`)
    if (sandboxErrors.length > 0) {
      throw new CliError(`Invalid sandbox config:\n${sandboxErrors.join("\n")}`)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dawn-ai/cli test collect-sandbox-errors && pnpm --filter @dawn-ai/cli typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/runtime/collect-sandbox-errors.ts packages/cli/src/commands/check.ts packages/cli/test/collect-sandbox-errors.test.ts
git commit -m "feat(cli): dawn check surfaces sandbox preflight warnings (non-fatal)"
```

---

### Task 9: Gated real-cluster conformance + kind+Calico CI lane

Adversarial conformance against a real cluster, gated on `DAWN_TEST_K8S=1`, plus a `sandbox-k8s` CI job that stands up kind + Calico.

**Files:**
- Create: `packages/sandbox/test/kube-sandbox.integration.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the gated integration test**

Create `packages/sandbox/test/kube-sandbox.integration.test.ts`:

```ts
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
      const h = await p.acquire({ threadId: t, policy: { network: { mode: "deny" } }, signal: ctx("/").signal })
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
      const h = await p.acquire({ threadId: t, policy: { network: { mode: "deny" } }, signal: ctx("/").signal })
      const etc = await h.exec.runCommand({ command: "echo x > /etc/x 2>&1; echo $?" }, ctx(h.workspaceRoot))
      expect(etc.stdout.trim().endsWith("0")).toBe(false)
      const ws = await h.exec.runCommand({ command: "echo x > /workspace/x && echo ok" }, ctx(h.workspaceRoot))
      expect(ws.stdout).toContain("ok")
    } finally {
      await p.destroy(t)
    }
  })

  test("network deny blocks egress", async () => {
    const p = make()
    const t = `net-${randomUUID().slice(0, 8)}`
    try {
      const h = await p.acquire({ threadId: t, policy: { network: { mode: "deny" } }, signal: ctx("/").signal })
      const r = await h.exec.runCommand(
        { command: `node -e "fetch('https://registry.npmjs.org/',{signal:AbortSignal.timeout(5000)}).then(()=>{console.log('REACHED');process.exit(0)}).catch(()=>{console.log('BLOCKED');process.exit(7)})"` },
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
      const a = await p.acquire({ threadId: t, policy: { network: { mode: "deny" } }, signal: ctx("/").signal })
      await a.filesystem.writeFile(`${a.workspaceRoot}/keep`, "durable", ctx(a.workspaceRoot))
      await p.release(t)
      const b = await p.acquire({ threadId: t, policy: { network: { mode: "deny" } }, signal: ctx("/").signal })
      expect(await b.filesystem.readFile(`${b.workspaceRoot}/keep`, ctx(b.workspaceRoot))).toBe("durable")
    } finally {
      await p.destroy(t)
    }
  })
})
```

- [ ] **Step 2: Verify it SKIPS without the env var**

Run: `pnpm --filter @dawn-ai/sandbox test kube-sandbox.integration`
Expected: PASS with all tests SKIPPED (no `DAWN_TEST_K8S`).

- [ ] **Step 3: Add the CI lane**

In `.github/workflows/ci.yml`, add a `sandbox-k8s` job mirroring `sandbox-docker` (which is at line ~97). Use the `helm/kind-action` to create a cluster, install Calico so NetworkPolicy is enforced, create the namespace, then run the gated test:

```yaml
  sandbox-k8s:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - name: Setup pnpm
        uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9
        with:
          version: 10.33.0
      - name: Setup Node.js
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
        with:
          node-version: 22.14.0
          cache: pnpm
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Build sandbox package
        run: pnpm --filter @dawn-ai/workspace build && pnpm --filter @dawn-ai/sandbox build
      - name: Create kind cluster (no default CNI)
        uses: helm/kind-action@a1b0e391336a6ee6713a0583f8c6240d70863de3 # v1.12.0
        with:
          config: .github/kind/kind-calico.yaml
      - name: Install Calico (enforces NetworkPolicy)
        run: |
          kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/calico.yaml
          kubectl -n kube-system rollout status daemonset/calico-node --timeout=180s
          kubectl wait --for=condition=Ready nodes --all --timeout=180s
      - name: Create sandbox namespace
        run: kubectl create namespace dawn-sandboxes
      - name: Real-cluster sandbox conformance + e2e
        run: DAWN_TEST_K8S=1 pnpm --filter @dawn-ai/sandbox test kube-sandbox.integration
```

Create `.github/kind/kind-calico.yaml` (disable kindnet so Calico owns the CNI):

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: "192.168.0.0/16"
```

Pin `helm/kind-action` to whatever SHA the repo's other pinned actions convention uses; if unsure, use the tag `@v1.12.0` and let the repo's action-pinning follow-up handle it (note it in the PR body).

- [ ] **Step 4: Commit**

```bash
git add packages/sandbox/test/kube-sandbox.integration.test.ts .github/workflows/ci.yml .github/kind/kind-calico.yaml
git commit -m "test(sandbox): gated real-cluster (kind+Calico) k8s conformance + CI lane"
```

---

### Task 10: Docs, changeset, full verification, PR

**Files:**
- Modify: `apps/web/content/docs/sandbox.mdx`
- Create: `.changeset/kubernetes-sandbox-provider.md`

- [ ] **Step 1: Docs**

Read `apps/web/content/docs/sandbox.mdx`. Add a "Kubernetes provider" section covering: `kubernetesSandbox({ image, namespace, storageClass, startupTimeoutMs })`; that it implements the same contract as `dockerSandbox` (all `security`/`network`/`resources` config identical); the `diskGb` PVC-size field; the `fsGroup`-based non-root ownership (no chown-init); that the sandbox pod mounts **no** ServiceAccount token; and an honest-scope note — NetworkPolicy egress control requires a policy-capable CNI (Calico/Cilium), and `pidsLimit` is enforced cluster-side (a LimitRange), not by the provider. State that the accompanying Helm charts (namespace/RBAC/default-deny NetworkPolicy/LimitRange) are a follow-up. Any `model:` example must be gpt-5 family. Do NOT use banned phrases (`scripts/check-docs.mjs` greps: never "byte-identical" or "works locally works in production").

Run: `node scripts/check-docs.mjs`
Expected: PASS.

- [ ] **Step 2: Changeset (PATCH)**

Create `.changeset/kubernetes-sandbox-provider.md`:

```md
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
```

CRITICAL: `patch` (fixed-group 0.x → a `minor` becomes 1.0.0). Confirm the touched publishable packages are exactly `workspace`, `sandbox`, `cli`:
`git log --oneline origin/main..HEAD --name-only -- packages/ | grep '^packages/' | cut -d/ -f2 | sort -u`

- [ ] **Step 3: Full local verification**

```
pnpm lint
pnpm build
pnpm typecheck
pnpm test
node scripts/check-docs.mjs
pnpm --filter @dawn-ai/sandbox test
pnpm verify:harness:framework
```
All must pass. The Docker and K8s integration lanes SKIP without their env vars (correct). If a failure is unrelated to this branch, verify it also fails on unmodified `origin/main` (`git stash`) before attributing; report any pre-existing failure with evidence.

- [ ] **Step 4: Commit docs + changeset**

```bash
git add apps/web/content/docs/sandbox.mdx .changeset/kubernetes-sandbox-provider.md
git commit -m "docs+changeset: kubernetes sandbox provider"
```

- [ ] **Step 5: Push + PR**

```bash
git push -u origin feat/k8s-sandbox-provider
gh pr create --title "feat(sandbox): kubernetesSandbox provider (Pod + PVC per thread)" --base main --body "<summary of the provider, hardening→SecurityContext mapping, fsGroup-not-chown-init, no-SA-token, NetworkPolicy best-effort + CNI honesty, gated kind+Calico lane; note this is sub-project 1 of 3 in the Kubernetes arc; changeset is patch>"
```

- [ ] **Step 6: Watch CI**

Poll `gh pr checks`. Confirm `validate`, `sandbox-docker`, and the new `sandbox-k8s` lanes go green, plus the advisory `review`. Address any real review findings. Verify the post-merge Version PR reads the next **patch** (e.g. 0.8.9), NOT 1.0.0.

---

## Self-review notes (author)

- **Spec coverage:** KubeClient seam (T2) ✓; PVC-per-thread (T5) ✓; SecurityContext + fsGroup replacing Architecture B (T5) ✓; seccomp RuntimeDefault (T5) ✓; pidsLimit delegated/honest (T5 omits it, T10 docs) ✓; no-SA-token (T5) ✓; NetworkPolicy + CNI-honest preflight (T6) ✓; config surface incl. diskGb (T1/T5) ✓; dawn check validation + warnings (T8) ✓; three test layers incl. gated kind+Calico lane (T9) ✓; docs + honest scope (T10) ✓.
- **Type consistency:** `KubeClient` method names are identical across T2 (definition), T3/T4 (exec), T5/T6 (provider), T7 (default impl). `KubePodSpec` gains `automountServiceAccountToken` in T5 and is consumed in T7. `collectSandboxErrors` return shape changes once (T8), with the caller updated in the same task.
- **Known implementer caution (T7):** `@kubernetes/client-node` 1.x uses the object-parameter API and returns bodies directly; the pseudocode `makeApiClient` lines are flagged for replacement with concrete top-level imports. Any signature drift surfaces at `typecheck` (T7 step 5) — fix to match the installed version. This adapter is the only unit-untested code; the kind+Calico lane (T9) is its real proof.
