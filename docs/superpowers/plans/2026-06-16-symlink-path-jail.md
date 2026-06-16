# Symlink-Hardened Workspace Path Jail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the workspace path-jail symlink escape — a symlink inside `workspace/` pointing outside is currently classified as inside and accessed silently.

**Architecture:** One PR off `feat/symlink-path-jail` (spec: `docs/superpowers/specs/2026-06-16-symlink-path-jail-design.md`). Add a REQUIRED `realPath` to `FilesystemBackend`; `localFilesystem` resolves symlinks (deepest-existing-ancestor); `createWorkspaceFs.gate()` canonicalizes both the candidate path and the workspace root before the (unchanged) `gatePathOp`. Three tasks: S1 introduces `realPath` and keeps the whole monorepo compiling; S2 makes the gate use it + proves the escape is caught; S3 docs + changeset + PR.

**Tech Stack:** TypeScript (no semicolons, double quotes, 2-space, ESM `.js` specifiers), pnpm, Vitest, Biome, changesets.

**Conventions:** `pnpm -r build` once at start; rebuild a package after editing it when another package's tests consume its `dist` (workspace → core/langchain). Run `pnpm -r --if-present typecheck` before declaring done. `pyenv: cannot rehash` output is harmless noise. No `console.*` in CLI output paths (n/a here).

---

### Task S1: Required `realPath` on the backend + `localFilesystem` impl + keep everything green (TDD)

**Files:**
- Modify: `packages/workspace/src/types.ts` (add required `realPath`)
- Modify: `packages/workspace/src/local-filesystem.ts` (implement)
- Modify: `packages/workspace/src/with-logging.ts` (forward it)
- Test: `packages/workspace/test/local-filesystem.test.ts` (new `realPath` tests)
- Modify (conformance, mechanical): every inline `FilesystemBackend` literal in tests across the monorepo — add `realPath: async (p) => p`. Known sites: `packages/workspace/test/with-logging.test.ts`, `packages/workspace/test/compose.test.ts` (if it builds a literal), `packages/core/test/capabilities/workspace-fs.test.ts`, and any `FilesystemBackend` literal in `packages/langchain/test/offload-*.test.ts`. **Let TypeScript find them all** — after the interface change, `pnpm -r build && pnpm -r --if-present typecheck` will flag each missing one.

- [ ] **Step 1: Write the failing `realPath` tests** in `packages/workspace/test/local-filesystem.test.ts` (follow the file's existing temp-dir idiom — `mkdtempSync`/`writeFileSync`/`symlinkSync` from `node:fs`):

```ts
it("realPath resolves a symlink to its real target", async () => {
  const fs = localFilesystem()
  const real = join(root, "real.txt")
  writeFileSync(real, "x", "utf8")
  const link = join(root, "link.txt")
  symlinkSync(real, link)
  // realpath both to normalize any symlinked tmp ancestor (e.g. macOS /var)
  expect(await fs.realPath(link, ctx(root))).toBe(realpathSync(real))
})

it("realPath resolves an escaping symlink to the outside real path", async () => {
  const fs = localFilesystem()
  const outside = mkdtempSync(join(tmpdir(), "dawn-outside-"))
  const target = join(outside, "secret.txt")
  writeFileSync(target, "s", "utf8")
  const link = join(root, "escape")
  symlinkSync(target, link)
  expect(await fs.realPath(link, ctx(root))).toBe(realpathSync(target))
  rmSync(outside, { recursive: true, force: true })
})

it("realPath tolerates a non-existent target (write case): resolves deepest existing ancestor", async () => {
  const fs = localFilesystem()
  // root exists; the file does not
  const want = join(realpathSync(root), "new-dir", "new.md")
  expect(await fs.realPath(join(root, "new-dir", "new.md"), ctx(root))).toBe(want)
})

it("realPath returns the canonical path for an ordinary existing file", async () => {
  const fs = localFilesystem()
  const p = join(root, "plain.txt")
  writeFileSync(p, "x", "utf8")
  expect(await fs.realPath(p, ctx(root))).toBe(realpathSync(p))
})
```

Add `symlinkSync`, `realpathSync` to the `node:fs` import in the test; reuse the file's existing `ctx(root)` helper and `root` temp dir (read the top of the file to match exact helper names).

- [ ] **Step 2: Run to verify failure:** `pnpm --filter @dawn-ai/workspace test -- local-filesystem` → FAIL (`fs.realPath` is not a function / TS error).

- [ ] **Step 3: Add the required method to the interface** (`packages/workspace/src/types.ts`), after `listDir` (keep it grouped with the required methods, before the optional `statFile?`):

```ts
  /**
   * Canonicalize an already-resolved absolute path — resolving symlinks and
   * `..` to a real target location — so the permission gate compares true
   * locations, not lexical strings. Must tolerate a path that does not exist
   * yet (e.g. a writeFile target): resolve the deepest existing ancestor and
   * re-append the non-existent tail. Backends with no symlink concept
   * (in-memory, remote) may return the path unchanged.
   */
  realPath(path: string, ctx: BackendContext): Promise<string>
```

- [ ] **Step 4: Implement in `localFilesystem`** (`packages/workspace/src/local-filesystem.ts`). Extend the `node:fs/promises` import with `realpath`; extend the `node:path` import with `basename`, `join` (it already imports `dirname`). Add the method to the returned object:

```ts
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
      if (parent === current) return path
      tail.unshift(basename(current))
      current = parent
    }
  }
}
```

- [ ] **Step 5: Forward `realPath` in `withFilesystemLogging`** (`packages/workspace/src/with-logging.ts`). It's required, so add it to the always-built `wrapped` object alongside `readFile`/`writeFile`/`listDir` (NOT the conditional optional block). Passthrough without logging (it is internal canonicalization, not a user-facing read/write event):

```ts
realPath: (path, ctx) => next.realPath(path, ctx),
```

(Place it in the initial `wrapped` literal so a wrapped backend always satisfies the required interface.)

- [ ] **Step 6: Verify the workspace package green:** `pnpm --filter @dawn-ai/workspace build && pnpm --filter @dawn-ai/workspace test && pnpm --filter @dawn-ai/workspace lint`.

- [ ] **Step 7: Restore monorepo green — add identity `realPath` to every flagged test double.** Rebuild workspace so downstream sees the new type: `pnpm --filter @dawn-ai/workspace build`, then `pnpm -r build && pnpm -r --if-present typecheck`. For each `FilesystemBackend` literal the compiler flags as missing `realPath`, add `realPath: async (p) => p` (identity — these doubles don't exercise symlinks). Re-run until `pnpm -r build` and `pnpm -r --if-present typecheck` are both green. Then run the affected suites: `pnpm --filter @dawn-ai/core test && pnpm --filter @dawn-ai/langchain test`.

- [ ] **Step 8: Commit:**
```bash
git add packages/workspace packages/core/test packages/langchain/test
git commit -m "feat(workspace): required realPath on FilesystemBackend; localFilesystem resolves symlinks"
```
(Adjust the `git add` set to exactly the files you changed — include only the test files that actually needed a double update.)

### Task S2: Canonicalize in the gate + prove the escape is caught (TDD)

**Files:**
- Modify: `packages/core/src/capabilities/workspace-fs.ts` (`gate()`)
- Test: `packages/core/test/capabilities/workspace-fs.test.ts` (security + regression)

- [ ] **Step 1: Write the failing security test** in `packages/core/test/capabilities/workspace-fs.test.ts`. Use the file's existing helpers (real `createPermissionsStore`, temp `workspaceRoot`, `localFilesystem()`; read the top of the file for exact helper names). Add to the permission-gating describe block:

```ts
it("gates a symlink that escapes the workspace (caught, not silently allowed)", async () => {
  const outside = mkdtempSync(join(tmpdir(), "dawn-escape-"))
  writeFileSync(join(outside, "secret.txt"), "top secret", "utf8")
  symlinkSync(join(outside, "secret.txt"), join(workspaceRoot, "escape"))
  const permissions = await makeStore("non-interactive") // copy the file's store-construction pattern
  const fs = createWorkspaceFs({
    workspaceRoot, backend: localFilesystem(), permissions, signal, interruptCapable: false,
  })
  await expect(fs.readFile("escape")).rejects.toThrow(/fail-closed/)
  rmSync(outside, { recursive: true, force: true })
})

it("still allows a legitimate inside path when the workspace root is reached via a symlink", async () => {
  // Canonicalizing only the candidate (not the root) would misclassify this as outside.
  const realDir = mkdtempSync(join(tmpdir(), "dawn-realroot-"))
  const linkedRoot = join(mkdtempSync(join(tmpdir(), "dawn-linkroot-")), "ws")
  symlinkSync(realDir, linkedRoot)
  writeFileSync(join(realDir, "notes.md"), "hello", "utf8")
  const permissions = await makeStore("non-interactive")
  const fs = createWorkspaceFs({
    workspaceRoot: linkedRoot, backend: localFilesystem(), permissions, signal, interruptCapable: false,
  })
  expect(await fs.readFile("notes.md")).toBe("hello")
  rmSync(realDir, { recursive: true, force: true })
})
```

Add `symlinkSync` (+ `mkdtempSync`, `writeFileSync`, `rmSync` if not already imported) to the test's `node:fs` import. Match the actual store-helper name in the file (the plan calls it `makeStore` — use whatever the file defines).

- [ ] **Step 2: Run to verify failure:** `pnpm --filter @dawn-ai/core test -- workspace-fs` → the escape test FAILS (currently the symlink is lexically inside → silently allowed → `readFile` resolves instead of rejecting). The "linked root" test may already pass or fail depending on tmp symlinks — it must pass after Step 3 regardless.

- [ ] **Step 3: Canonicalize both sides in `gate()`** (`packages/core/src/capabilities/workspace-fs.ts`):

```ts
async function gate(operation: PathOperation, path: string): Promise<string> {
  const absPath = resolve(opts.workspaceRoot, path)
  const canonicalPath = await opts.backend.realPath(absPath, bctx)
  const canonicalRoot = await opts.backend.realPath(opts.workspaceRoot, bctx)
  const result = await gatePathOp(opts.permissions, operation, canonicalPath, canonicalRoot, {
    interruptCapable: opts.interruptCapable,
  })
  if (!result.allowed) throw new Error(result.reason)
  return absPath
}
```

Only `gate()` changes — the method bodies (`readFile`/`readBinaryFile`/`writeFile`/`listDir`) still call `await gate(...)` and pass the returned original `absPath` to the backend. `gatePathOp` and `permission-gate.ts` are NOT touched.

- [ ] **Step 4: Verify green:** `pnpm --filter @dawn-ai/core build && pnpm --filter @dawn-ai/core test` — new tests pass; ALL existing gating tests (inside silent-allow, outside fail-closed, allow-rule, interrupt-suppression, bypass, binary, maxBytes, the `..` traversal + sibling-prefix tests from PR #213) still pass. `pnpm --filter @dawn-ai/core lint`.

- [ ] **Step 5: Commit:**
```bash
git add packages/core/src/capabilities/workspace-fs.ts packages/core/test/capabilities/workspace-fs.test.ts
git commit -m "feat(core): canonicalize symlinks before the workspace permission gate"
```

### Task S3: Docs + changeset + full verification + PR

**Files:**
- Modify: `apps/web/content/docs/workspace.mdx`
- Create: `.changeset/symlink-path-jail.md`

- [ ] **Step 1: Docs.** In `apps/web/content/docs/workspace.mdx`:
  - Add `realPath` to the `FilesystemBackend` method table: `| `realPath(path, ctx)` | Yes | Canonicalize an absolute path (resolve symlinks); return it unchanged for backends without symlinks |`.
  - Find the **"Path jail is lexical"** caveat (added in PR #213, in the Permissions section) and rewrite it: `localFilesystem` now resolves symlinks before the gate decision, so a symlink inside `workspace/` pointing outside is correctly gated (prompted/denied), not silently followed. Custom backends get the same protection by implementing `realPath` — which the type system now requires.
  - Build: `pnpm --filter @dawn-ai/web build` (revert `apps/web/next-env.d.ts` churn with `git checkout --` if it appears).

- [ ] **Step 2: Changeset** `.changeset/symlink-path-jail.md`:
```md
---
"@dawn-ai/workspace": minor
"@dawn-ai/core": minor
---

Harden the workspace path jail against symlink escapes. `FilesystemBackend` gains a required `realPath(path, ctx)` method; `localFilesystem` implements it (resolving symlinks via the deepest existing ancestor so not-yet-created write targets work), and `createWorkspaceFs` canonicalizes both the candidate path and the workspace root before the permission gate. A symlink inside `workspace/` that points outside is now correctly gated instead of being silently classified as inside. **Breaking for custom `FilesystemBackend` implementations:** add a `realPath` method — return the path unchanged (`async (p) => p`) if your backend has no symlink semantics.
```

- [ ] **Step 3: Full verification (report each):**
```
pnpm -r build
pnpm -r --if-present typecheck
pnpm --filter @dawn-ai/workspace test
pnpm --filter @dawn-ai/core test
pnpm --filter @dawn-ai/langchain test
pnpm --filter @dawn-ai/workspace lint && pnpm --filter @dawn-ai/core lint
pnpm --filter @dawn-ai/web build
```
All green; lint exits 0 (pre-existing warnings only). Revert any `next-env.d.ts` churn.

- [ ] **Step 4: Commit, push, PR:**
```bash
git add apps/web/content/docs/workspace.mdx .changeset/symlink-path-jail.md
git commit -m "docs: symlink-hardened path jail; changeset"
git push -u origin feat/symlink-path-jail
gh pr create --base main --title "feat: harden workspace path jail against symlink escapes" \
  --body "Spec: docs/superpowers/specs/2026-06-16-symlink-path-jail-design.md. Required FilesystemBackend.realPath; localFilesystem resolves symlinks (deepest-existing-ancestor); createWorkspaceFs canonicalizes both candidate path and workspace root before gatePathOp. Closes the lexical-jail symlink escape documented in the workspace docs."
```
Then enable auto-merge: `gh pr merge <branch> --auto --squash` (report the outcome — it may say admin required or auto-merge enabled).
