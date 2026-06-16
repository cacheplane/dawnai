# Symlink-hardened workspace path jail (Design)

**Status:** Approved for planning
**Date:** 2026-06-16
**Roadmap:** Security hardening follow-up captured during the `ctx.fs` review (PR #213) and documented as a known limitation in `apps/web/content/docs/workspace.mdx`. The workspace permission gate's inside-vs-outside decision is purely lexical, so a symlink **inside** `workspace/` pointing **outside** is classified as inside and read/written silently — an escape from the path jail.

## Problem

`gatePathOp` (`packages/core/src/capabilities/permission-gate.ts:21`) decides whether a path is inside the workspace with a string compare:

```ts
const insideWorkspace = absPath === workspaceRoot || absPath.startsWith(workspaceRoot + sep)
```

`createWorkspaceFs.gate()` (the sole production caller) feeds it `resolve(workspaceRoot, relPath)`, which normalizes `..` but does **not** resolve symlinks. So `workspace/escape -> /etc/passwd` resolves to `<root>/escape`, lexically passes the inside check, and `localFilesystem` (which uses `node:fs`, following symlinks) reads `/etc/passwd` — no permission prompt, no deny. The agent can create such a link itself via `runBash` (`ln -s`).

## Decisions (from brainstorming)

- **Mechanism: a `realPath` method on `FilesystemBackend`** (Option B). The backend that follows symlinks owns the canonicalization; the gate stays a pure policy function; the pluggable-backend abstraction holds (a remote/in-memory backend canonicalizes its own way — identity if it has no symlinks). Rejected: hardcoding `node:fs` in the gate (couples policy to local FS, leaks for remote backends); per-method defense inside `localFilesystem` (duplicates the jail, bypasses the allow/deny/prompt decision).
- **`realPath` is REQUIRED, not optional.** The only audience that must implement it is custom-backend authors (advanced work); the default `localFilesystem` ships it, so `create-dawn-app`/getting-started is hardened secure-by-default with zero friction. Required eliminates any silent-gap path — every backend canonicalizes, so the gate always compares real targets. (No back-compat constraint; `FilesystemBackend` is pre-1.0 under fixed versioning.)
- **Canonicalize BOTH the candidate path and the workspace root** before the inside check. Realpath'ing only the candidate would misclassify legitimate inside paths as outside wherever the root itself sits under a symlink — notably macOS temp dirs (`/var → /private/var`, `/tmp → /private/tmp`), which the test suite uses heavily.
- **`gatePathOp` is unchanged** — its lexical compare is correct once inputs are canonical.

## Verified facts (against main @ `407303f`)

- `gatePathOp` (permission-gate.ts) is called for path ops by exactly one production site: `createWorkspaceFs.gate()` (`packages/core/src/capabilities/workspace-fs.ts:30`). All other references are in `permission-gate.test.ts`. The agent-facing workspace tools delegate to `createWorkspaceFs` (refactored in PR #213), so there is no second path.
- `createWorkspaceFs` holds the backend (`opts.backend`) and a `BackendContext` (`bctx`), so it is the natural place to canonicalize.
- `FilesystemBackend` (`packages/workspace/src/types.ts`): `readFile`/`writeFile`/`listDir` are required; `readBinaryFile?`/`statFile?`/`removeFile?`/`touchFile?`/`mkdir?` optional.
- `localFilesystem` (`packages/workspace/src/local-filesystem.ts`) uses `node:fs/promises` throughout; `writeFile` creates missing parent dirs (PR #208), so write targets often do not exist at gate time → a naive `fs.realpath(absPath)` would throw `ENOENT`.
- `withFilesystemLogging` (`packages/workspace/src/with-logging.ts`) forwards required methods and conditionally forwards the optional ones; it will need to forward the new required `realPath`.
- Inline `FilesystemBackend` test doubles exist in: `packages/core/test/capabilities/workspace-fs.test.ts`, `packages/workspace/test/with-logging.test.ts`, and any offload tests that construct a backend literal — each must gain a `realPath` once it's required (TypeScript flags them).

## Design

### 1. `FilesystemBackend.realPath` (required) — `@dawn-ai/workspace`

In `packages/workspace/src/types.ts`:

```ts
export interface FilesystemBackend {
  readFile(path: string, ctx: BackendContext, opts?: { readonly maxBytes?: number }): Promise<string>
  // ...existing methods...
  /**
   * Canonicalize an already-resolved absolute path — resolving symlinks and
   * `..` to a real target location — so the permission gate compares true
   * locations, not lexical strings. Must tolerate paths that do not exist yet
   * (e.g. a writeFile target): resolve the deepest existing ancestor and
   * re-append the non-existent tail. Backends with no symlink concept
   * (in-memory, remote) may return the path unchanged.
   */
  realPath(path: string, ctx: BackendContext): Promise<string>
}
```

`ctx` is included for signature consistency with the other methods and to give remote backends the `signal`/`workspaceRoot`; `localFilesystem` ignores it.

### 2. `localFilesystem.realPath` — deepest-existing-ancestor resolution

`node:fs.realpath` throws `ENOENT` on a non-existent path, so walk up to the deepest existing ancestor, realpath that, and re-append the remainder:

```ts
import { realpath } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

async realPath(path: string, _ctx: BackendContext): Promise<string> {
  const tail: string[] = []
  let current = path
  for (;;) {
    try {
      const resolved = await realpath(current)
      return tail.length === 0 ? resolved : join(resolved, ...tail)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = dirname(current)
      if (parent === current) return path // reached FS root, nothing resolved
      tail.unshift(basename(current))
      current = parent
    }
  }
}
```

Non-ENOENT errors propagate (a genuine I/O/permission failure should surface, not be masked).

### 3. `createWorkspaceFs.gate()` canonicalizes both sides — `@dawn-ai/core`

```ts
async function gate(operation: PathOperation, path: string): Promise<string> {
  const absPath = resolve(opts.workspaceRoot, path)
  const canonicalPath = await opts.backend.realPath(absPath, bctx)
  const canonicalRoot = await opts.backend.realPath(opts.workspaceRoot, bctx)
  const result = await gatePathOp(opts.permissions, operation, canonicalPath, canonicalRoot, {
    interruptCapable: opts.interruptCapable,
  })
  if (!result.allowed) throw new Error(result.reason)
  return absPath // the backend op uses the original path; the OS resolves the link
}
```

The backend op still receives the original `absPath` (the OS resolves the symlink at open time); canonicalization exists only to make the *security decision* on the real target. `gatePathOp` is untouched.

### 4. `withFilesystemLogging` forwards `realPath`

Add `realPath` to the always-forwarded set (it's required). It is path-only data; log it like `readFile` (path argument) or treat as passthrough without logging — match the existing required-method forwarding style; do not log it as noise if the existing reads/writes are the interesting events (implementer's call, but it MUST be forwarded so a wrapped backend stays valid).

### 5. Update `FilesystemBackend` test doubles

Every inline `FilesystemBackend` literal in tests gains a `realPath`. For doubles that don't exercise symlinks, identity is correct: `realPath: async (p) => p`. TypeScript will flag each missing one at build/typecheck.

## Testing

- **`packages/workspace/test/local-filesystem.test.ts`** — `realPath`:
  - resolves a symlink to its real target (create a file, a symlink to it, assert `realPath(link)` === realpath of the target);
  - resolves a symlink **escaping** a dir to the outside real path;
  - for a non-existent target under an existing dir (write case), returns `<realdir>/<tail>` without throwing;
  - returns an unchanged real path for an ordinary existing file;
  - propagates non-ENOENT errors (optional — only if cheaply simulable).
- **`packages/core/test/capabilities/workspace-fs.test.ts`** — the security assertion:
  - a symlink at `workspace/escape -> <outside dir>` makes `fs.readFile("escape")` go through the gate as an **outside** path → with a non-interactive store it rejects `/fail-closed/` (proves the escape is caught, not silently allowed);
  - **regression / macOS:** a normal inside path still resolves as inside and is allowed even when the workspace root is itself reached via a symlinked ancestor (simulate by creating the temp workspace under a symlinked dir, or rely on the macOS `/var` symlink) — proves canonicalizing both sides doesn't misclassify legit paths;
  - existing gating tests (inside silent-allow, outside fail-closed, allow-rule, bypass, binary) still pass.
- Full `@dawn-ai/core` + `@dawn-ai/workspace` suites green after the test-double updates.

## Docs

Update `apps/web/content/docs/workspace.mdx`:
- Add `realPath` to the `FilesystemBackend` method table (required; one-line description; "identity for backends without symlinks").
- Replace the **"Path jail is lexical"** caveat: `localFilesystem` now resolves symlinks before the gate decision, so a symlink inside `workspace/` pointing outside is correctly gated; custom backends must implement `realPath` to get the same protection (and the type system requires it).

## Changeset

`@dawn-ai/workspace` minor (new required `realPath` on `FilesystemBackend` + `localFilesystem` impl) and `@dawn-ai/core` minor (`createWorkspaceFs` canonicalization). Fixed versioning bumps all `@dawn-ai/*` together. The changeset note must call out that `FilesystemBackend` gains a **required** `realPath` method — custom backend implementations must add it (identity, `async (p) => p`, if the backend has no symlink semantics).

## Out of scope

- TOCTOU hardening (a symlink swapped between gate and open) — inherent to realpath-then-open; not addressed.
- `gateBashOp` / `runBash` — operates on commands, not paths; unaffected.
- Changing what the backend op receives (still the original path).
