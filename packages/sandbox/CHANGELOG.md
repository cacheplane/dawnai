# @dawn-ai/sandbox

## 0.8.26

### Patch Changes

- @dawn-ai/sdk@0.8.26
- @dawn-ai/workspace@0.8.26

## 0.8.25

### Patch Changes

- @dawn-ai/sdk@0.8.25
- @dawn-ai/workspace@0.8.25

## 0.8.24

### Patch Changes

- @dawn-ai/sdk@0.8.24
- @dawn-ai/workspace@0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.
- 47bf96b: Validate the complete Kubernetes runtime permission contract during preflight,
  replace existing owned NetworkPolicies with their live resource version, and
  export the structured `KubePermission` type and
  `KubeAuthorizationReviewError`. Custom `KubeClient` implementations must
  replace positional `canI(namespace, verb, resource)` with
  `canI(namespace, permission)`; no compatibility overload is provided, and the
  exported error preserves API-versus-transport preflight diagnostics.

  Serialize filesystem changes observed during the initial `dawn dev` child boot
  so startup and restart children cannot race for the same listening port, and
  drain fixing edits queued while a watched restart is failing.

- Updated dependencies [7e62bb1]
  - @dawn-ai/sdk@0.8.23
  - @dawn-ai/workspace@0.8.23

## 0.8.22

### Patch Changes

- bedad77: Documentation only: every public export of this package now has an API reference
  page on dawnai.org, and the package README leads with a concise entrypoint. No
  runtime behavior changed.
- 5cc8d4d: Recover Docker-backed filesystem operations when PID exhaustion prevents the keeper container from forking, while preserving the thread workspace volume.
- Updated dependencies [bedad77]
- Updated dependencies [a530e70]
- Updated dependencies [3c68800]
- Updated dependencies [f317dd7]
- Updated dependencies [3c68800]
- Updated dependencies [d42774e]
- Updated dependencies [984c3ad]
- Updated dependencies [496b54c]
- Updated dependencies [67030fa]
- Updated dependencies [730b136]
  - @dawn-ai/workspace@0.8.22
  - @dawn-ai/sdk@0.8.22

## 0.8.21

### Patch Changes

- Updated dependencies [c2c19da]
- Updated dependencies [c2c19da]
  - @dawn-ai/sdk@0.8.21
  - @dawn-ai/workspace@0.8.21

## 0.8.20

### Patch Changes

- @dawn-ai/sdk@0.8.20
- @dawn-ai/workspace@0.8.20

## 0.8.19

### Patch Changes

- b8d0da7: Docker sandboxes now prove an OCI exec never started before recovering, drain admitted container operations before a per-thread keeper recycle, preserve the named workspace volume, and retry once. Fair shared/exclusive lifecycle coordination prevents replacement from killing peer commands, while persisted keeper identities prevent cleanup failures or provider restarts from adopting stale container policy.
  - @dawn-ai/sdk@0.8.19
  - @dawn-ai/workspace@0.8.19

## 0.8.18

### Patch Changes

- Updated dependencies [c6b08a9]
  - @dawn-ai/sdk@0.8.18
  - @dawn-ai/workspace@0.8.18

## 0.8.17

### Patch Changes

- Updated dependencies [713797f]
  - @dawn-ai/sdk@0.8.17
  - @dawn-ai/workspace@0.8.17

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).
- Updated dependencies [2da55fa]
  - @dawn-ai/sdk@0.8.16
  - @dawn-ai/workspace@0.8.16

## 0.8.15

### Patch Changes

- @dawn-ai/sdk@0.8.15
- @dawn-ai/workspace@0.8.15

## 0.8.14

### Patch Changes

- @dawn-ai/sdk@0.8.14
- @dawn-ai/workspace@0.8.14

## 0.8.13

### Patch Changes

- 18df470: Add a central `DAWN_Exxxx` error-code registry in `@dawn-ai/sdk` and surface
  codes on the failure channels. `CliError` now carries an optional `code` and the
  CLI prints `[CODE] See <docs>`; HTTP/SSE error bodies gain optional `code`/`docsUrl`;
  permission denials returned as tool results are prefixed with `[DAWN_E3001]`.
  The high-value families are wired (`dawn check` config errors, sandbox
  unavailable, permission denied, missing model provider / unknown model id, and
  tool-file shape errors), and a generated `/docs/errors` reference page is guarded
  against drift. Additive and backward-compatible.
- Updated dependencies [5bbd6e3]
- Updated dependencies [628d1c3]
- Updated dependencies [18df470]
  - @dawn-ai/sdk@0.8.13
  - @dawn-ai/workspace@0.8.13

## 0.8.12

### Patch Changes

- @dawn-ai/workspace@0.8.12

## 0.8.11

### Patch Changes

- @dawn-ai/workspace@0.8.11

## 0.8.10

### Patch Changes

- @dawn-ai/workspace@0.8.10

## 0.8.9

### Patch Changes

- 628f0c1: Add a `kubernetesSandbox` provider: run each thread's sandbox as a Kubernetes Pod
  with a per-thread PersistentVolumeClaim for the durable workspace, implementing the
  same `SandboxProvider` contract as `dockerSandbox`. Tier-1 hardening maps onto Pod
  SecurityContext (non-root via `fsGroup`, read-only rootfs, dropped capabilities,
  no-new-privileges, RuntimeDefault seccomp); sandbox pods mount no ServiceAccount
  token. Per-thread NetworkPolicy provides best-effort egress control (requires a
  policy-capable CNI; `dawn check` warns when unconfirmed). New `resources.diskGb`
  sets the PVC size.
- Updated dependencies [628f0c1]
  - @dawn-ai/workspace@0.8.9

## 0.8.8

### Patch Changes

- 57e8cd9: Harden the Docker sandbox by default: drop all Linux capabilities, no-new-privileges,
  a PID limit (512), a read-only root filesystem (workspace + /tmp stay writable), and
  run-as-non-root (uid/gid 1000:1000 via a create-time root chown-init) — expressed as a
  provider-agnostic `SandboxPolicy.security` intent. `resources.timeoutMs` is now enforced
  per command (in-container `timeout`, exit 124). All hardening is on by default with
  per-flag opt-outs (`readOnlyRootFilesystem`, `runAsNonRoot`, etc.). Behavior changes only
  for apps already using `sandbox`; runtime system-directory writes / global installs now
  fail under the defaults — bake system deps into your image or opt out.
- Updated dependencies [57e8cd9]
  - @dawn-ai/workspace@0.8.8

## 0.8.7

### Patch Changes

- @dawn-ai/workspace@0.8.7

## 0.8.6

### Patch Changes

- 4ede7b8: Add an opt-in execution sandbox: a provider-agnostic `SandboxProvider` contract
  with a Docker reference (`dockerSandbox`), giving each conversation thread a
  hard-isolated workspace (filesystem + shell + network). Enable via
  `dawn.config.ts` `sandbox: { provider: dockerSandbox({ image }) }`; without it,
  behavior is unchanged. Adds a typed `config()` helper. When sandboxed, the
  materialized agent cache is bypassed so tools bind per-thread. Honest scope:
  Docker's boundary (not a microVM); `allow`-mode network denylist is best-effort
  in the Docker reference. New package `@dawn-ai/sandbox` (+ `@dawn-ai/sandbox/testing`
  `fakeSandbox` and a provider conformance kit).
- Updated dependencies [4ede7b8]
  - @dawn-ai/workspace@0.8.6
