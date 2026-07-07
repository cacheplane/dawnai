# Sandbox Hardening Tier 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `dockerSandbox` by default — drop all capabilities, no-new-privileges, PID limit, read-only root filesystem, run-as-non-root (via a create-time root chown-init), and per-command timeout enforcement — expressed as a provider-agnostic `SandboxPolicy.security` intent.

**Architecture:** Add a `SandboxSecurityPolicy` intent object to the `@dawn-ai/workspace` contract. The Docker provider treats each unset field as its secure default and translates intent → `docker run`/`docker exec` flags. Non-root uses Architecture B: an ephemeral, create-only, agent-input-free root `docker run --rm … chown` initializes volume ownership, then a non-root keeper runs; nothing in the live container graph is root.

**Tech Stack:** TypeScript (ESM, `node:` builtins), Vitest, Biome, pnpm fixed-group workspace, the `docker` CLI (coreutils `timeout`/`chown` in-container).

**Spec:** `docs/superpowers/specs/2026-07-06-sandbox-hardening-tier1-design.md` — read it first.

**Grounding (verify before editing — main evolves):**
- Contract: `packages/workspace/src/sandbox-types.ts` — `SandboxPolicy { network, env?, resources?{memoryMb?,cpus?,timeoutMs?} }`, `SandboxConfig { provider, network?, env?, resources?, idleTimeoutMs? }`.
- Provider: `packages/sandbox/src/docker/docker-sandbox.ts` — `ensureContainer` builds the `docker run -d` args (`--name`, `--label`, `-v vol:/workspace`, `-w /workspace`, `net`, `envArgs`, `limits`, image, `sleep infinity`); `acquire` constructs `dockerExec(docker, container)` + `dockerFilesystem(docker, container)`. `ROOT = "/workspace"`, `sanitize`, `containerName`, `volumeName`.
- Exec: `packages/sandbox/src/docker/docker-exec.ts` — `dockerExec(docker, container)`; `runCommand` builds `sh -c "<envPrefix><cdPrefix><command>"`, already **validates env keys** (`/^[A-Za-z_][A-Za-z0-9_]*$/`) and `shellQuote`s values. **Preserve that** — READ the file and add to it; don't paste-replace.
- CLI: `packages/cli/src/lib/runtime/resolve-sandbox.ts` (builds `SandboxPolicy` from `SandboxConfig`), `packages/cli/src/lib/runtime/collect-sandbox-errors.ts` (`dawn check` pass), both in `test/`.
- Sandbox tests live in `packages/sandbox/test/` with `../src/...ts` (`.ts`-extension) imports. `docker-sandbox.unit.test.ts` uses a recording fake `Docker`; `docker-sandbox.integration.test.ts` is gated `describe.skipIf(process.env.DAWN_TEST_DOCKER !== "1")` and runs the conformance kit + adversarial e2e.
- Conventions: per-package lint (`pnpm --filter <pkg> lint`) — never a repo-wide bare `biome check --write`. Build upstream deps before cross-package typecheck. Confirm `git branch --show-current` before every commit (multi-worktree repo).

---

### Task 1: `SandboxSecurityPolicy` contract intent (`@dawn-ai/workspace`)

**Files:**
- Modify: `packages/workspace/src/sandbox-types.ts`
- Test: `packages/workspace/test/sandbox-types.test.ts` (append to the existing file)

- [ ] **Step 1: Write the failing test** (append inside the existing `describe` or add a new one in `packages/workspace/test/sandbox-types.test.ts`)

```ts
import type { SandboxConfig, SandboxPolicy, SandboxSecurityPolicy } from "../src/sandbox-types.ts"

describe("sandbox security intent", () => {
  test("security is optional on the policy and config, with all-optional fields", () => {
    const sec: SandboxSecurityPolicy = {
      dropAllCapabilities: true,
      noNewPrivileges: true,
      readOnlyRootFilesystem: false,
      runAsNonRoot: { uid: 1000, gid: 1000 },
      pidsLimit: 256,
    }
    const policy: SandboxPolicy = { network: { mode: "deny" }, security: sec }
    expect(policy.security?.pidsLimit).toBe(256)
    const off: SandboxPolicy = { network: { mode: "deny" }, security: { runAsNonRoot: false } }
    expect(off.security?.runAsNonRoot).toBe(false)
    const cfg: SandboxConfig = { provider: {} as never, security: sec }
    expect(cfg.security).toBe(sec)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dawn-ai/workspace test sandbox-types`
Expected: FAIL — `SandboxSecurityPolicy` not exported, `security` not on `SandboxPolicy`/`SandboxConfig`.

- [ ] **Step 3: Add the intent type + fields** in `packages/workspace/src/sandbox-types.ts`

```ts
/**
 * Provider-agnostic hardening intent. Each provider translates these to its own
 * mechanism; a field left unset means the provider applies its SECURE default
 * (all of these default ON/hardened at the Docker provider). Authors relax
 * explicitly. See the sandbox-hardening spec.
 */
export interface SandboxSecurityPolicy {
  /** Drop all Linux capabilities. Secure default: true. */
  readonly dropAllCapabilities?: boolean
  /** Block setuid/setgid privilege escalation. Secure default: true. */
  readonly noNewPrivileges?: boolean
  /** Immutable root filesystem (workspace + scratch stay writable). Secure default: true. */
  readonly readOnlyRootFilesystem?: boolean
  /** Run as non-root. Secure default: true → uid/gid 1000:1000. `false` = image default (often root). */
  readonly runAsNonRoot?: boolean | { readonly uid: number; readonly gid: number }
  /** Max process count (fork-bomb defense). Secure default: 512. */
  readonly pidsLimit?: number
}
```

Add `readonly security?: SandboxSecurityPolicy` to the `SandboxPolicy` interface (after `resources`) and to `SandboxConfig` (after `resources`). Export `SandboxSecurityPolicy` alongside the other type exports in `packages/workspace/src/index.ts`.

- [ ] **Step 4: Run test + typecheck + lint + build**

Run: `pnpm --filter @dawn-ai/workspace test sandbox-types && pnpm --filter @dawn-ai/workspace typecheck && pnpm --filter @dawn-ai/workspace lint && pnpm --filter @dawn-ai/workspace build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workspace/src/sandbox-types.ts packages/workspace/src/index.ts packages/workspace/test/sandbox-types.test.ts
git commit -m "feat(workspace): SandboxSecurityPolicy hardening intent on the contract"
```

---

### Task 2: Per-command timeout in `dockerExec`

**Files:**
- Modify: `packages/sandbox/src/docker/docker-exec.ts`
- Modify: `packages/sandbox/src/docker/docker-sandbox.ts` (wire the timeout at `acquire`)
- Test: `packages/sandbox/test/docker-backends.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `packages/sandbox/test/docker-backends.test.ts`; reuse its existing `fakeDocker`/`ctx` helpers)

```ts
describe("dockerExec timeout", () => {
  test("wraps the command in `timeout Ns` when timeoutMs is set", async () => {
    let seen: readonly string[] = []
    const exec = dockerExec(
      fakeDocker({ exec: async (_c, cmd) => { seen = cmd; return { stdout: "", stderr: "", exitCode: 0 } } }),
      "c1",
      { timeoutMs: 1500 },
    )
    await exec.runCommand({ command: "echo hi" }, ctx)
    expect(seen[0]).toBe("timeout")
    expect(seen[1]).toBe("2s") // ceil(1500/1000)
    expect(seen[2]).toBe("sh")
    expect(seen.join(" ")).toContain("echo hi")
  })

  test("no timeout wrapping when timeoutMs is unset", async () => {
    let seen: readonly string[] = []
    const exec = dockerExec(
      fakeDocker({ exec: async (_c, cmd) => { seen = cmd; return { stdout: "", stderr: "", exitCode: 0 } } }),
      "c1",
    )
    await exec.runCommand({ command: "echo hi" }, ctx)
    expect(seen[0]).toBe("sh")
  })

  test("exit 124 → annotated stderr pointing at the config", async () => {
    const exec = dockerExec(
      fakeDocker({ exec: async () => ({ stdout: "", stderr: "", exitCode: 124 }) }),
      "c1",
      { timeoutMs: 500 },
    )
    const r = await exec.runCommand({ command: "sleep 999" }, ctx)
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toMatch(/timed out after 500ms/i)
    expect(r.stderr).toMatch(/resources\.timeoutMs/)
  })

  test("still validates env keys (regression: keep existing behavior)", async () => {
    const exec = dockerExec(fakeDocker({}), "c1", { timeoutMs: 500 })
    await expect(
      exec.runCommand({ command: "echo", env: { "BAD KEY;x": "1" } }, ctx),
    ).rejects.toThrow(/Invalid environment variable name/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/sandbox test docker-backends`
Expected: FAIL — `dockerExec` takes 2 args; timeout not implemented.

- [ ] **Step 3: Implement** — READ the current `packages/sandbox/src/docker/docker-exec.ts` and modify it (do NOT drop the existing env-key validation or `shellQuote`):
1. Change the signature to `export function dockerExec(docker: Docker, container: string, opts: { readonly timeoutMs?: number } = {}): ExecBackend`.
2. In `runCommand`, after building the full `sh -c` string as today (`const full = \`${envPrefix}${cdPrefix}${args.command}\``), build the exec argv:

```ts
const shArgs = ["sh", "-c", full]
const argv =
  opts.timeoutMs !== undefined
    ? ["timeout", `${Math.ceil(opts.timeoutMs / 1000)}s`, ...shArgs]
    : shArgs
const r = await docker.exec(container, argv, { signal: ctx.signal })
if (opts.timeoutMs !== undefined && r.exitCode === 124) {
  return {
    stdout: r.stdout,
    stderr: `${r.stderr}${r.stderr ? "\n" : ""}Command timed out after ${opts.timeoutMs}ms (resources.timeoutMs).`,
    exitCode: 124,
  }
}
return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
```

3. Keep the env-key validation loop exactly as-is (it must run before building `envPrefix`).

- [ ] **Step 4: Wire the provider** — in `packages/sandbox/src/docker/docker-sandbox.ts` `acquire`, change `exec: dockerExec(docker, container)` to:

```ts
exec: dockerExec(docker, container, { timeoutMs: policy.resources?.timeoutMs }),
```

(`policy` is in scope in `acquire`.)

- [ ] **Step 5: Run tests + typecheck + lint + build**

Run: `pnpm --filter @dawn-ai/sandbox test docker-backends && pnpm --filter @dawn-ai/sandbox typecheck && pnpm --filter @dawn-ai/sandbox lint && pnpm --filter @dawn-ai/sandbox build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox/src/docker/docker-exec.ts packages/sandbox/src/docker/docker-sandbox.ts packages/sandbox/test/docker-backends.test.ts
git commit -m "feat(sandbox): enforce per-command timeout via in-container coreutils timeout"
```

---

### Task 3: Hardening flags in `dockerSandbox` (secure-by-default translation)

**Files:**
- Modify: `packages/sandbox/src/docker/docker-sandbox.ts` (`ensureContainer`)
- Test: `packages/sandbox/test/docker-sandbox.unit.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append; reuse the file's `recordingDocker()` + `signal()` helpers)

```ts
describe("dockerSandbox hardening flags", () => {
  const acquireArgs = (runs: string[][]) => (runs.find((r) => r[0] === "run") ?? []).join(" ")

  test("hardened by default: cap-drop ALL, no-new-privileges, pids-limit 512, read-only + tmpfs, non-root user + HOME", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({ threadId: "abc", policy: { network: { mode: "deny" } }, signal: signal() })
    const j = acquireArgs(runs)
    expect(j).toContain("--cap-drop ALL")
    expect(j).toContain("--security-opt no-new-privileges")
    expect(j).toContain("--pids-limit 512")
    expect(j).toContain("--read-only")
    expect(j).toContain("--tmpfs /tmp")
    expect(j).toContain("--tmpfs /run")
    expect(j).toContain("--user 1000:1000")
    expect(j).toContain("HOME=/workspace")
  })

  test("per-flag opt-outs remove exactly their flags", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({
      threadId: "abc",
      policy: {
        network: { mode: "deny" },
        security: {
          dropAllCapabilities: false,
          noNewPrivileges: false,
          readOnlyRootFilesystem: false,
          runAsNonRoot: false,
          pidsLimit: 128,
        },
      },
      signal: signal(),
    })
    const j = acquireArgs(runs)
    expect(j).not.toContain("--cap-drop")
    expect(j).not.toContain("no-new-privileges")
    expect(j).not.toContain("--read-only")
    expect(j).not.toContain("--tmpfs")
    expect(j).not.toContain("--user")
    expect(j).not.toContain("HOME=/workspace")
    expect(j).toContain("--pids-limit 128")
  })

  test("custom runAsNonRoot uid/gid", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({
      threadId: "abc",
      policy: { network: { mode: "deny" }, security: { runAsNonRoot: { uid: 2000, gid: 3000 } } },
      signal: signal(),
    })
    expect(acquireArgs(runs)).toContain("--user 2000:3000")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/sandbox test docker-sandbox.unit`
Expected: FAIL — no hardening flags emitted.

- [ ] **Step 3: Implement** in `ensureContainer` (`packages/sandbox/src/docker/docker-sandbox.ts`). Before building the `docker run` argv, resolve the effective posture:

```ts
const sec = policy.security ?? {}
const dropCaps = sec.dropAllCapabilities ?? true
const noNewPriv = sec.noNewPrivileges ?? true
const readOnly = sec.readOnlyRootFilesystem ?? true
const pids = sec.pidsLimit ?? 512
const user: { uid: number; gid: number } | undefined =
  sec.runAsNonRoot === false
    ? undefined
    : typeof sec.runAsNonRoot === "object"
      ? sec.runAsNonRoot
      : { uid: 1000, gid: 1000 }

const hardening: string[] = [
  ...(dropCaps ? ["--cap-drop", "ALL"] : []),
  ...(noNewPriv ? ["--security-opt", "no-new-privileges"] : []),
  "--pids-limit",
  String(pids),
  ...(readOnly ? ["--read-only", "--tmpfs", "/tmp", "--tmpfs", "/run"] : []),
  ...(user ? ["--user", `${user.uid}:${user.gid}`, "-e", "HOME=/workspace"] : []),
]
```

Insert `...hardening` into the existing `docker run` argv array, right after `...limits` (before `opts.image`). Do NOT change the existing `net`/`envArgs`/`limits`/`-v`/`-w`/`--label` args.

- [ ] **Step 4: Run tests + typecheck + lint + build**

Run: `pnpm --filter @dawn-ai/sandbox test docker-sandbox.unit && pnpm --filter @dawn-ai/sandbox typecheck && pnpm --filter @dawn-ai/sandbox lint && pnpm --filter @dawn-ai/sandbox build`
Expected: PASS (existing unit tests + new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/docker/docker-sandbox.ts packages/sandbox/test/docker-sandbox.unit.test.ts
git commit -m "feat(sandbox): hardened-by-default docker flags (caps, no-new-priv, pids, read-only, non-root)"
```

---

### Task 4: Architecture B — non-root volume chown-init (create-only)

**Files:**
- Modify: `packages/sandbox/src/docker/docker-sandbox.ts` (`ensureContainer` create branch)
- Test: `packages/sandbox/test/docker-sandbox.unit.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append)

```ts
describe("dockerSandbox chown-init (Architecture B)", () => {
  // volume-absent recorder: `volume inspect` fails (exit 1); everything else ok.
  function chownRecorder(volumeExists: boolean) {
    const runs: string[][] = []
    const docker: Docker = {
      run: async (args) => {
        runs.push([...args])
        if (args[0] === "volume" && args[1] === "inspect") {
          return { stdout: "", stderr: "", exitCode: volumeExists ? 0 : 1 }
        }
        if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 } // container absent
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    }
    return { docker, runs }
  }
  const chownRun = (runs: string[][]) =>
    runs.find((r) => r[0] === "run" && r.includes("--rm") && r.join(" ").includes("chown"))

  test("volume absent + non-root → chown-init runs as root BEFORE the keeper", async () => {
    const { docker, runs } = chownRecorder(false)
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({ threadId: "abc", policy: { network: { mode: "deny" } }, signal: signal() })
    const init = chownRun(runs)
    expect(init).toBeDefined()
    const j = (init ?? []).join(" ")
    expect(j).toContain("--user 0:0")
    expect(j).toContain("dawn-sbx-vol-abc:/workspace")
    expect(j).toContain("chown 1000:1000 /workspace")
    // ordering: chown-init before the keeper (-d)
    const idxInit = runs.findIndex((r) => r === init)
    const idxKeeper = runs.findIndex((r) => r[0] === "run" && r.includes("-d"))
    expect(idxInit).toBeLessThan(idxKeeper)
  })

  test("volume present → NO chown-init (reattach)", async () => {
    const { docker, runs } = chownRecorder(true)
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({ threadId: "abc", policy: { network: { mode: "deny" } }, signal: signal() })
    expect(chownRun(runs)).toBeUndefined()
  })

  test("runAsNonRoot:false → NO chown-init", async () => {
    const { docker, runs } = chownRecorder(false)
    const p = dockerSandbox({ image: "node:22-slim", docker })
    await p.acquire({
      threadId: "abc",
      policy: { network: { mode: "deny" }, security: { runAsNonRoot: false } },
      signal: signal(),
    })
    expect(chownRun(runs)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/sandbox test docker-sandbox.unit`
Expected: FAIL — no `volume inspect` / chown-init issued.

- [ ] **Step 3: Implement** in `ensureContainer`, in the CREATE branch (after the `ps -aq` reattach check falls through to "container absent → create"), and only when `user` is defined (from Task 3's resolved posture):

```ts
if (user) {
  const volExists = await docker.run(["volume", "inspect", volumeName(threadId)], { signal })
  if (volExists.exitCode !== 0) {
    const init = await docker.run(
      [
        "run", "--rm", "--user", "0:0",
        "-v", `${volumeName(threadId)}:${ROOT}`,
        opts.image, "sh", "-c",
        `mkdir -p ${ROOT} && chown ${user.uid}:${user.gid} ${ROOT}`,
      ],
      { signal },
    )
    if (init.exitCode !== 0) {
      throw new Error(
        `Sandbox unavailable: could not initialize workspace ownership for thread "${threadId}": ${init.stderr.trim() || "unknown error"}. Run \`dawn check\`.`,
      )
    }
  }
}
```

This block goes immediately before the keeper `docker run -d …` call. (The keeper's `--user`/`--read-only`/etc. come from Task 3.)

- [ ] **Step 4: Run tests + typecheck + lint + build**

Run: `pnpm --filter @dawn-ai/sandbox test docker-sandbox.unit && pnpm --filter @dawn-ai/sandbox typecheck && pnpm --filter @dawn-ai/sandbox lint && pnpm --filter @dawn-ai/sandbox build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/src/docker/docker-sandbox.ts packages/sandbox/test/docker-sandbox.unit.test.ts
git commit -m "feat(sandbox): non-root volume chown-init (create-only, no steady-state root)"
```

---

### Task 5: CLI passthrough + `dawn check` validation

**Files:**
- Modify: `packages/cli/src/lib/runtime/resolve-sandbox.ts`
- Modify: `packages/cli/src/lib/runtime/collect-sandbox-errors.ts`
- Test: `packages/cli/test/collect-sandbox-errors.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `packages/cli/test/collect-sandbox-errors.test.ts`)

```ts
describe("collectSandboxErrors: security shape", () => {
  const ok = { name: "p", acquire: async () => ({}) as never, release: async () => {}, destroy: async () => {}, preflight: async () => ({ ok: true }) }

  test("pidsLimit must be a positive integer", async () => {
    const errors = await collectSandboxErrors({ sandbox: { provider: ok, security: { pidsLimit: 0 } } })
    expect(errors.join("\n")).toMatch(/pidsLimit/)
  })

  test("runAsNonRoot object needs numeric uid/gid", async () => {
    const errors = await collectSandboxErrors({ sandbox: { provider: ok, security: { runAsNonRoot: { uid: -1, gid: 0 } as never } } })
    expect(errors.join("\n")).toMatch(/uid|gid/)
  })

  test("valid security → no errors", async () => {
    expect(
      await collectSandboxErrors({ sandbox: { provider: ok, security: { pidsLimit: 256, runAsNonRoot: { uid: 1000, gid: 1000 } } } }),
    ).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dawn-ai/cli test collect-sandbox-errors`
Expected: FAIL — no `security` validation.

- [ ] **Step 3: `resolve-sandbox.ts` passthrough** — READ the file; where it builds the `SandboxPolicy` from `sandbox` config (currently spreads `network`/`env`/`resources`), add the security passthrough:

```ts
...(sandbox.security ? { security: sandbox.security } : {}),
```

(Mirror the existing `...(sandbox.env ? { env: sandbox.env } : {})` conditional-spread style.)

- [ ] **Step 4: `collect-sandbox-errors.ts` validation** — after the existing provider-shape + preflight checks, add security-shape validation:

```ts
const sec = sandbox.security
if (sec) {
  if (sec.pidsLimit !== undefined && (!Number.isInteger(sec.pidsLimit) || sec.pidsLimit <= 0)) {
    errors.push(`dawn.config sandbox.security.pidsLimit must be a positive integer (got: ${String(sec.pidsLimit)}).`)
  }
  if (typeof sec.runAsNonRoot === "object" && sec.runAsNonRoot !== null) {
    const { uid, gid } = sec.runAsNonRoot
    if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
      errors.push(`dawn.config sandbox.security.runAsNonRoot uid/gid must be non-negative integers.`)
    }
  }
}
```

(`sandbox` is the `config.sandbox` object already in scope; `errors` is the accumulator array. Preserve the early-return-on-bad-provider behavior — put this block after that, before the `return errors`.)

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `pnpm --filter @dawn-ai/workspace build && pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/cli test collect-sandbox-errors && pnpm --filter @dawn-ai/cli typecheck && pnpm --filter @dawn-ai/cli lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lib/runtime/resolve-sandbox.ts packages/cli/src/lib/runtime/collect-sandbox-errors.ts packages/cli/test/collect-sandbox-errors.test.ts
git commit -m "feat(cli): pass sandbox.security through + validate it in dawn check"
```

---

### Task 6: Adversarial real-Docker hardening conformance (gated lane)

**Files:**
- Modify: `packages/sandbox/test/docker-sandbox.integration.test.ts` (append; it's already `describe.skipIf(!enabled)` gated on `DAWN_TEST_DOCKER=1`)

- [ ] **Step 1: Add the adversarial suite** — append inside the gated `describe` (or a sibling gated `describe`). READ the file first for its `enabled`/`IMAGE`/`ctx`/policy helpers and reuse them; each test acquires a unique threadId and `destroy`s it in `finally`.

```ts
test("hardened defaults contain a fork bomb (pids-limit)", { timeout: 180_000 }, async () => {
  const p = dockerSandbox({ image: IMAGE })
  const threadId = `fork-${randomUUID()}`
  try {
    const h = await p.acquire({ threadId, policy: { network: { mode: "deny" } }, signal: ctx("/").signal })
    // bounded spawn attempt; pids-limit (512) makes fork fail rather than take the host down
    const r = await h.exec.runCommand(
      { command: "for i in $(seq 1 2000); do sleep 30 & done; echo done" },
      ctx(h.workspaceRoot),
    )
    // either the shell reports fork failures, or the command is non-zero — host stays up (test completes)
    expect(typeof r.exitCode).toBe("number")
    // sanity: the container still responds afterward
    const alive = await h.exec.runCommand({ command: "echo alive" }, ctx(h.workspaceRoot))
    expect(alive.stdout).toContain("alive")
  } finally {
    await p.destroy(threadId)
  }
})

test("read-only root blocks /etc writes; workspace + /tmp writable", { timeout: 120_000 }, async () => {
  const p = dockerSandbox({ image: IMAGE })
  const threadId = `ro-${randomUUID()}`
  try {
    const h = await p.acquire({ threadId, policy: { network: { mode: "deny" } }, signal: ctx("/").signal })
    const etc = await h.exec.runCommand({ command: "echo x > /etc/dawn-probe" }, ctx(h.workspaceRoot))
    expect(etc.exitCode).not.toBe(0)
    const ws = await h.exec.runCommand({ command: "echo x > /workspace/probe && echo ok" }, ctx(h.workspaceRoot))
    expect(ws.stdout).toContain("ok")
    const tmp = await h.exec.runCommand({ command: "echo x > /tmp/probe && echo ok" }, ctx(h.workspaceRoot))
    expect(tmp.stdout).toContain("ok")
  } finally {
    await p.destroy(threadId)
  }
})

test("runs as non-root by default", { timeout: 120_000 }, async () => {
  const p = dockerSandbox({ image: IMAGE })
  const threadId = `nr-${randomUUID()}`
  try {
    const h = await p.acquire({ threadId, policy: { network: { mode: "deny" } }, signal: ctx("/").signal })
    const r = await h.exec.runCommand({ command: "id -u" }, ctx(h.workspaceRoot))
    expect(r.stdout.trim()).not.toBe("0")
    expect(r.stdout.trim()).toBe("1000")
  } finally {
    await p.destroy(threadId)
  }
})

test("per-command timeout kills the in-container process (exit 124)", { timeout: 120_000 }, async () => {
  const p = dockerSandbox({ image: IMAGE })
  const threadId = `to-${randomUUID()}`
  try {
    const h = await p.acquire(
      { threadId, policy: { network: { mode: "deny" }, resources: { timeoutMs: 500 } }, signal: ctx("/").signal },
    )
    const r = await h.exec.runCommand({ command: "sleep 999" }, ctx(h.workspaceRoot))
    expect(r.exitCode).toBe(124)
    // process actually gone: no lingering sleep 999
    const ps = await h.exec.runCommand({ command: "ps -e -o args= 2>/dev/null | grep -c 'sleep 999' || true" }, ctx(h.workspaceRoot))
    expect(ps.stdout.trim()).toBe("0")
  } finally {
    await p.destroy(threadId)
  }
})
```

- [ ] **Step 2: Verify the gate is closed without Docker**

Run: `pnpm --filter @dawn-ai/sandbox test docker-sandbox.integration`
Expected: the suite SKIPS (env unset), exit 0. Confirm skipped count includes the new tests. (The existing conformance kit against real Docker still runs the hardened path in CI — no change needed there; it proves normal workloads survive the defaults.)

- [ ] **Step 3: If a Docker daemon is available locally**, run `DAWN_TEST_DOCKER=1 pnpm --filter @dawn-ai/sandbox test docker-sandbox.integration` and report results. If not (this machine's daemon can't pull), state that the CI `sandbox-docker` lane is the authoritative gate.

- [ ] **Step 4: Typecheck + lint + commit**

Run: `pnpm --filter @dawn-ai/sandbox typecheck && pnpm --filter @dawn-ai/sandbox lint`
```bash
git add packages/sandbox/test/docker-sandbox.integration.test.ts
git commit -m "test(sandbox): adversarial real-Docker hardening conformance (gated)"
```

---

### Task 7: Docs + changeset + full verification + PR

**Files:**
- Modify: `apps/web/content/docs/sandbox.mdx`
- Create: `.changeset/sandbox-hardening-tier1.md`

- [ ] **Step 1: Update the docs page** `apps/web/content/docs/sandbox.mdx` — add a "Security hardening" section: the hardened-by-default table (cap-drop ALL, no-new-privileges, pids-limit 512, read-only root + writable `/workspace` + tmpfs `/tmp`/`/run`, run-as-non-root 1000:1000 with `HOME=/workspace`), the `security` config shape + per-flag opt-outs, the per-command `resources.timeoutMs`, and the guidance callout: *bake system deps into your image; mutate only your workspace at runtime — runtime `apt`/`npm -g` will fail under the read-only + non-root defaults (opt out with `readOnlyRootFilesystem:false` / `runAsNonRoot:false` if you must).* Update the honest-scope section to note the hardened posture materially raises the bar while still being Docker's boundary (not a microVM), and that `security` is the provider-agnostic seam a stronger substrate satisfies. No banned marketing phrases (`check-docs.mjs`). Any example `model:` id stays gpt-5 family.

- [ ] **Step 2: Check docs**

Run: `node scripts/check-docs.mjs`
Expected: PASS.

- [ ] **Step 3: Write the changeset (patch)** `.changeset/sandbox-hardening-tier1.md`:

```md
---
"@dawn-ai/workspace": patch
"@dawn-ai/sandbox": patch
"@dawn-ai/cli": patch
---

Harden the Docker sandbox by default: drop all Linux capabilities, no-new-privileges,
a PID limit (512), a read-only root filesystem (workspace + /tmp stay writable), and
run-as-non-root (uid/gid 1000:1000 via a create-time root chown-init) — expressed as a
provider-agnostic `SandboxPolicy.security` intent. `resources.timeoutMs` is now enforced
per command (in-container `timeout`, exit 124). All hardening is on by default with
per-flag opt-outs (`readOnlyRootFilesystem`, `runAsNonRoot`, etc.). Behavior changes only
for apps already using `sandbox`; runtime system-directory writes / global installs now
fail under the defaults — bake system deps into your image or opt out.
```

- [ ] **Step 4: Full local verification**

Run: `pnpm lint && pnpm build && pnpm typecheck && pnpm test && node scripts/check-docs.mjs && pnpm --filter @dawn-ai/sandbox test && pnpm verify:harness:framework`
Expected: all PASS. (Gated Docker integration tests SKIP without `DAWN_TEST_DOCKER` — correct. If a pre-existing unrelated flake appears in `pnpm test`, confirm it also fails on unmodified `origin/main` before attributing.)

- [ ] **Step 5: Rebase, align version, push, open PR**

```bash
git fetch origin main
git rebase origin/main
# align the new package's version if main advanced (the fixed group is uniform): set packages/sandbox/package.json version to match packages/workspace/package.json, if they differ, then pnpm install and commit
git push -u origin feat/sandbox-hardening-tier1
gh pr create --title "feat: sandbox hardening tier 1 — hardened-by-default docker + per-command timeout" --body "Implements docs/superpowers/specs/2026-07-06-sandbox-hardening-tier1-design.md. Watch the sandbox-docker CI lane for the real-Docker adversarial proofs."
```

- [ ] **Step 6: After merge**, verify the post-merge Release run / Version PR reads the next patch (NOT 1.0.0) per GOTCHA 6. No new package this time, so no OIDC bootstrap needed.

---

## Self-review notes

- **Spec coverage:** contract intent (T1), timeout (T2), flags (T3), non-root chown-init/Architecture B (T4), cli passthrough + dawn check (T5), adversarial real-Docker conformance (T6), docs + changeset + honest-scope (T7). Secure-by-default at the provider (T3/T4 default-unset→hardened). Existing conformance-still-green-under-defaults noted in T6.
- **Type/name consistency:** `SandboxSecurityPolicy` fields (`dropAllCapabilities`/`noNewPrivileges`/`readOnlyRootFilesystem`/`runAsNonRoot`/`pidsLimit`) used identically in T1/T3/T4/T5; `dockerExec(docker, container, { timeoutMs })` consistent T2↔provider; `resources.timeoutMs` is the timeout home (not a new `security` field).
- **Watch-outs:** (1) T2 must PRESERVE the existing env-key validation + `shellQuote` in `docker-exec.ts` (read, don't paste-replace). (2) T3+T4 both edit `ensureContainer` — the chown-init (T4) uses the `user` variable resolved in T3, so T4 depends on T3's block existing. (3) T4 chown-init must be gated on volume-ABSENCE (`volume inspect` exit≠0) AND `user` defined — never on reattach. (4) `--tmpfs /run` included because some tools write `/run`; if an image breaks, it's covered by `readOnlyRootFilesystem:false`. (5) coreutils `timeout`/`chown` assumed present (all standard base images) — the honest-scope note already says images need a POSIX shell + coreutils.
