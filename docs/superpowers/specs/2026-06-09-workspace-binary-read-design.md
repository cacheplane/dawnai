# Binary read in the workspace filesystem backend (Design)

**Status:** Approved for planning
**Date:** 2026-06-09
**Roadmap:** Dogfooding-friction backlog item #2 (binary read). Surfaced building Dawn's first external consumer (a marketing content-drafting agent that needed to read an image). Scoped to the backend layer only; the broader "sandboxed filesystem handle for route-tool authors" (backlog #3) is captured as a follow-up and explicitly **out of scope** here.

## Problem

`@dawn-ai/workspace`'s `FilesystemBackend.readFile` is UTF-8-only — it returns `Promise<string>` and `localFilesystem` reads with a hardcoded `"utf8"` encoding. A programmatic consumer that needs a file's raw bytes (a custom backend, a filesystem middleware, or — eventually — a route tool reading an image) has no path through the backend. It must drop to `node:fs` directly, bypassing the backend abstraction that the rest of the workspace I/O flows through.

Note on the path-jail: in the current architecture the path-jail and permission gate live in the **core workspace capability** (`gatePathOp` in `packages/core/src/capabilities/built-in/workspace.ts`), which resolves and authorizes the path *before* calling `fs.readFile`. The backend receives an already-jailed absolute path. So the precise gap this spec closes is: **the backend layer offers no binary read**, forcing binary consumers off the backend entirely. Re-jailing binary reads for *route-tool authors* is the concern of backlog #3, not this increment.

## Scope decisions (from brainstorming)

- **In scope:** a Buffer-yielding binary read on `FilesystemBackend`, implemented by `localFilesystem`, threaded through `compose`/`withFilesystemLogging`.
- **Out of scope — deferred to backlog #3:** giving route-local tools a sandboxed filesystem handle. Route tools today receive only `{ middleware?, signal }` (`packages/cli/src/lib/runtime/dawn-context.ts`) — no backend at all — so wiring one in (with path-jail + permission gate threaded into the tool context) is a separate, larger design. This spec is built so #3 can reuse `readBinaryFile` unchanged.
- **Dropped:** an agent-facing base64 read tool (originally floated as backlog #2's "agent tool"). Handing an LLM a large base64 blob as a tool result is token-expensive and rarely useful; the image use case belongs to a tool author building a multimodal message (#3), not to the model calling a tool.
- **Return type:** `Uint8Array` (not `Buffer`). Keeps the pluggable backend contract honest for future non-Node backends (remote, browser). `localFilesystem` still returns a `Buffer`, which satisfies `Uint8Array` (`Buffer extends Uint8Array`); consumers wanting base64 do `Buffer.from(bytes).toString("base64")`.

## Verified facts (against current code)

- `FilesystemBackend.readFile` returns `Promise<string>`; optional methods (`statFile`, `removeFile`, `touchFile`, `mkdir`) already establish the "optional capability" pattern. (`packages/workspace/src/types.ts`)
- `localFilesystem.readFile` stats the file, enforces `maxFileBytes` (default 256 KiB) with a per-call `opts.maxBytes` override, then `readFile(path, "utf8")`. (`packages/workspace/src/local-filesystem.ts`)
- `withFilesystemLogging` returns a **fresh object containing only `readFile`/`writeFile`/`listDir`** — it silently **drops** `statFile`/`removeFile`/`touchFile`/`mkdir`. Wrapping `localFilesystem` in logging therefore disables offload GC (the offload store needs `statFile`/`removeFile`/`touchFile`). This is a pre-existing latent bug that this spec also fixes, since we're modifying exactly this function. (`packages/workspace/src/with-logging.ts`)
- `compose` is type-generic (`compose<T>(...mws)`) and chains wrappers without touching their shape — **no change needed.** (`packages/workspace/src/compose.ts`)
- The core workspace capability builds `readFile`/`writeFile`/`listDir`/`runBash` agent tools; `readFile` stays UTF-8. **No change to core in this spec.** (`packages/core/src/capabilities/built-in/workspace.ts`)

## Design

### 1. Interface: optional `readBinaryFile` on `FilesystemBackend`

In `packages/workspace/src/types.ts`, add (mirroring `readFile`'s signature exactly):

```ts
/**
 * Read a file's raw bytes. Like `readFile`, `path` is an already-resolved
 * absolute path inside `ctx.workspaceRoot` — the capability has done the
 * path-jail. No decoding is applied. `opts.maxBytes` overrides the backend's
 * default size cap for this single call (same semantics as `readFile`).
 *
 * Optional — backends that omit it provide no binary read; callers must
 * handle absence with a clear error (mirror how offload GC handles a
 * missing `statFile`).
 */
readBinaryFile?(
  path: string,
  ctx: BackendContext,
  opts?: { readonly maxBytes?: number },
): Promise<Uint8Array>
```

### 2. `localFilesystem` implementation

In `packages/workspace/src/local-filesystem.ts`, add `readBinaryFile` to the returned backend. It reuses the **same** cap logic as `readFile` (shared default `maxBytes`, same per-call override, same `File too large` error), then reads with no encoding:

```ts
async readBinaryFile(
  path: string,
  _ctx: BackendContext,
  opts?: { readonly maxBytes?: number },
): Promise<Uint8Array> {
  const limit = opts?.maxBytes ?? maxBytes
  const s = await stat(path)
  if (s.size > limit) {
    throw new Error(`File too large: ${s.size} bytes (max ${limit}) at ${path}`)
  }
  return await readFile(path) // no encoding arg → Buffer (a Uint8Array)
}
```

The size-cap message intentionally matches `readFile`'s so the cap behavior is uniform. (If the duplicated cap check reads awkwardly during implementation, a small shared `assertWithinCap(size, limit, path)` helper is acceptable — implementer's call; behavior must be identical to `readFile`.)

### 3. `withFilesystemLogging`: forward `readBinaryFile` + fix the optional-method drop

In `packages/workspace/src/with-logging.ts`, the middleware must:

1. **Forward `readBinaryFile` when the wrapped backend defines it**, logging the **path only** — never the bytes (no `JSON.stringify` of a `Buffer`).
2. **Preserve all other optional methods** (`statFile`, `removeFile`, `touchFile`, `mkdir`) when present, instead of dropping them.

Shape (conditional spread so absent methods stay absent — preserving the optional contract downstream):

```ts
export function withFilesystemLogging(opts: LoggingOptions = {}): FilesystemMiddleware {
  return (next: FilesystemBackend) => ({
    readFile: async (path, ctx, readOpts) => {
      emit(opts, "readFile", [path])
      return next.readFile(path, ctx, readOpts)
    },
    writeFile: async (path, content, ctx) => {
      emit(opts, "writeFile", [path, content])
      return next.writeFile(path, content, ctx)
    },
    listDir: async (path, ctx) => {
      emit(opts, "listDir", [path])
      return next.listDir(path, ctx)
    },
    ...(next.readBinaryFile && {
      readBinaryFile: async (path, ctx, readOpts) => {
        emit(opts, "readBinaryFile", [path]) // path only — never the bytes
        return next.readBinaryFile!(path, ctx, readOpts)
      },
    }),
    ...(next.statFile && { statFile: (p, ctx) => next.statFile!(p, ctx) }),
    ...(next.removeFile && { removeFile: (p, ctx) => next.removeFile!(p, ctx) }),
    ...(next.touchFile && { touchFile: (p, ctx) => next.touchFile!(p, ctx) }),
    ...(next.mkdir && { mkdir: (p, ctx) => next.mkdir!(p, ctx) }),
  })
}
```

Note the `readFile` passthrough also now forwards its `opts` third argument, which the current implementation drops (it calls `next.readFile(path, ctx)`). That omission is part of the same "middleware loses backend capability" family of bugs; forward it here for correctness.

The preserved optional methods are passthrough-only (not logged) to keep the change minimal — logging GC bookkeeping would be noise. The point of the fix is *preservation*, not *observability*, of those methods.

### 4. `compose` — no change

`compose<T>` is shape-agnostic; it chains the wrappers above untouched.

### 5. Core / agent tools — no change

The `readFile` agent tool stays UTF-8. No new agent-facing tool. `readBinaryFile` is a backend-layer capability for programmatic consumers.

## Testing

All in `packages/workspace/test/`:

- **`local-filesystem.test.ts`** — `readBinaryFile`:
  - returns the exact bytes of a binary fixture (write known bytes, read back, assert byte-equality);
  - returns a value that is an instance of `Uint8Array`;
  - throws `File too large` when the file exceeds the default cap;
  - honors `opts.maxBytes` (both a tighter cap that rejects, and `Number.POSITIVE_INFINITY` that allows an otherwise-oversize read).
- **`with-logging.test.ts`**:
  - `readBinaryFile` is forwarded and logs **only the path** (assert the destination entry's `args` is `[path]`, contains no byte content);
  - **regression:** a wrapped backend's `statFile`/`removeFile`/`touchFile`/`mkdir`/`readBinaryFile` remain callable after wrapping (the preservation fix);
  - `readFile`'s `opts` argument is forwarded to `next.readFile`.
- **`compose.test.ts`** — no new behavior required; existing coverage stands.

## Documentation

Update the workspace filesystem docs to mention `readBinaryFile` as the binary-read path and that it returns `Uint8Array` (`Buffer.from(bytes).toString("base64")` for base64). Target: the workspace/filesystem section under `apps/web/content/docs/` (exact page confirmed during planning). Keep it brief — one short subsection.

## Changeset

`.changeset/<name>.md` with `"@dawn-ai/workspace": minor` (additive API; fixed versioning bumps all `@dawn-ai/*` together).

## Follow-ups (not this spec)

- **Backlog #3** — sandboxed filesystem handle for route-tool authors (text + binary), threading the backend + path-jail + permission gate into the route-tool execution context. This spec's `readBinaryFile` is the binary primitive it will reuse (see appendix).
- **`writeBinaryFile`** — not needed by any current consumer (YAGNI). Add when a writer appears.

## Appendix — #3 sketch (deferred, not built here)

Recorded only to confirm `readBinaryFile` is the right primitive. The eventual route-tool handle arrives on the tool's second `context` argument:

```ts
/** Describe an image in the workspace. */
export default async function describeImage(
  { path }: { path: string },
  { fs }: DawnToolContext,
) {
  const bytes = await fs.readBinaryFile(path) // sandboxed, no node:fs
  const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
  // ...hand dataUrl to a vision model
}

interface WorkspaceFs {
  readFile(path: string, opts?: { maxBytes?: number }): Promise<string>
  readBinaryFile(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>
  writeFile(path: string, content: string): Promise<{ bytesWritten: number }>
  listDir(path?: string): Promise<readonly string[]>
}
```

Differences from `FilesystemBackend`: paths are **workspace-relative** (handle resolves + jails), no explicit `ctx`, `readBinaryFile` is **non-optional** (throws a clear error if the backend lacks it), and every call runs the **permission gate**. `fs.readBinaryFile` delegates to `backend.readBinaryFile` — without this spec's primitive it would have no sandboxed binary read to call.

Work #3 requires (hence its own spec): (1) extract `gatePathOp` + path-jail from the core workspace capability into a shared unit; (2) a handle factory closing over `(workspaceRoot, backend, permissions, signal)`; (3) threading `fs` into `createDawnContext` + the tool-context type; (4) non-interactive/test semantics (+ a `@dawn-ai/testing` `WorkspaceFs` over a temp dir, ties into backlog #6).
```
