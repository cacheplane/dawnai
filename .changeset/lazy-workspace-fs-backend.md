---
"@dawn-ai/core": patch
"@dawn-ai/cli": patch
---

fix(edge): resolve the `ctx.fs` filesystem backend at first use, not at route preparation

`prepareRouteExecution` built the author-facing workspace handle (`ctx.fs`) for
every route execution, and constructing it resolved a filesystem backend
eagerly. On a runtime with no boot fallbacks and no `backends.filesystem` in
config — i.e. every deployed `hono`-target worker — that threw during
preparation, so every agent turn returned a 500 over a handle the turn never
touched. A worker could not opt out: the emitted entry inlines only the
serializable half of `dawn.config.ts`, and the edge capability gate rejects
`backends.filesystem` because a live object cannot cross a build boundary.

`createWorkspaceFs` now accepts a thunk for `backend` and resolves (and
memoizes) it on the first filesystem operation, and the CLI runtime hands it
one when — and only when — the runtime has no fallback to construct from. The
failure is deferred, not defused: a route that genuinely reads the workspace
still throws by name, at the operation that needed a filesystem, with the same
message it raised before. The node lane is unchanged, backend included: it
still resolves its process-shared `localFilesystem()` at preparation, since
there the call cannot fail.

The `workspaceRoot` guard in `createWorkspaceFs` stays eager — the root is
known at construction time, so a host that passes a relative one hears about it
immediately rather than on some later file operation.
