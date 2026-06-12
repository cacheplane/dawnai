# @dawn-ai/workspace

## 0.3.1

### Patch Changes

- 777f3eb: Refresh README files for GTM developer growth: SEO keyword pass and a
  Star/Docs/Discussions CTA band on the root and developer-facing package
  READMEs, doc links repointed to the live dawnai.org site, and READMEs added
  for previously-blank published packages (`workspace`, `permissions`,
  `sqlite-storage`, `testing`, `evals`). Patch bump republishes the packages so
  the updated READMEs render on npm.

## 0.3.0

### Minor Changes

- 917a99f: Add a binary read path to the workspace filesystem backend. `FilesystemBackend` gains an optional `readBinaryFile(path, ctx, opts?): Promise<Uint8Array>`, implemented by `localFilesystem` (same size-cap semantics as `readFile`), so binary I/O (e.g. reading an image) stays inside the sandboxed backend instead of dropping to `node:fs`. `withFilesystemLogging` now forwards `readBinaryFile` (logging the path only, never the bytes) and also preserves the optional `statFile`/`removeFile`/`touchFile`/`mkdir` methods it previously dropped when wrapping a backend.

### Patch Changes

- fa8bdd4: `localFilesystem` `writeFile` now creates missing parent directories before
  writing. Previously, an agent writing to a nested workspace path (e.g.
  `reports/result.md`) failed with `ENOENT` unless the directory already existed.

## 0.2.0

### Minor Changes

- 027b1cc: Add tool-output offloading. When a tool returns output larger than `toolOutput.offloadThresholdChars` (default 40,000), the full payload is written to `workspace/tool-outputs/` and the in-context ToolMessage is replaced with a preview+pointer stub; the agent retrieves the full content with the existing `readFile` tool (which bypasses the size cap for `tool-outputs/` paths). Active automatically when a workspace exists. The directory is bounded by a size + TTL cap (defaults 256MB / 3h) with throttled evict-on-write and LRU-by-access eviction (readFile bumps mtime for tool-outputs/ files). Large content never enters message state, so there is no tool-call/result pairing hazard. Configurable via `dawn.config.ts` `toolOutput`. The `FilesystemBackend` interface gains optional `statFile`/`removeFile`/`touchFile`/`mkdir` methods and an optional per-call `maxBytes` override on `readFile`.
